import '../node_modules/js-md5/build/md5.min.js';
import {ESPLoader, Transport} from '../node_modules/esptool-js/bundle.js';
import {Connection, makeUsbReset, patchC6, validateImages, findAuthorizedPort} from './core.mjs';

import {createHandoff} from './handoff.mjs';
import {createLauncher} from './launcher.mjs';
import {SerialMonitor,restartDevice} from './monitor.mjs';

const $ = id => document.getElementById(id);
const events = [];
let monitor;
let busy = false, flashBytes = 0, selectedPort, finding = false, cancelFinding = false, selectedMac = null;
const visible = () => document.visibilityState === 'visible';
const say = text => { $('message').textContent = text; };
function appendConsole(text) {
  $('consoleOutput').textContent=($('consoleOutput').textContent+text).slice(-200000);
  if($('consoleFollow').checked)$('consoleOutput').scrollTop=$('consoleOutput').scrollHeight;
}
function log(event, data = {}) {
  const entry = {time: new Date().toISOString(), ms: Math.round(performance.now()), event, ...data};
  events.push(entry); if (events.length > 10000) events.shift();
  if(event==='loader')appendConsole(String(data.text ?? '')+(data.newline?'\n':''));
  else {
    const messages={
      'connect.attempt':'正在连接设备…',
      'connect.ready':`连接成功 · ${data.chip} · Flash ${data.size} · MAC ${data.mac}`,
      'flash.start':'开始烧录…','flash.complete':'烧录与 MD5 校验完成。',
      'flash.erase-start':'正在全片擦除…','flash.erase-complete':'全片擦除完成，保持下载模式。',
      'flash.read':`读取完成：${data.length} 字节。`,
      'device.restart-start':'正在重启模组…','device.restart-sent':'已发送重启信号。'
    };
    const message=messages[event] || (event.endsWith('.error')?data.message:null);
    if(message)appendConsole('\n[工具] '+message+'\n');
  }
  $('log').textContent += `${entry.time.slice(11,23)}  ${event}  ${JSON.stringify(data)}\n`;
  if ($('log').textContent.length > 100000) $('log').textContent = $('log').textContent.slice(-80000);
  $('log').scrollTop = $('log').scrollHeight;
}
function render() {
  const listening=!!monitor?.active;
  const ready = connection.state === 'ready' && !listening;
  $('state').textContent = listening?{opening:'正在打开串口',listening:'串口监听中',stopping:'正在停止监听',error:'串口待释放'}[monitor.state]:{idle:'未连接',connecting:'正在连接',ready:'已连接',error:'需要恢复',disconnecting:'正在断开'}[connection.state];
  $('connectionNote').textContent = ready ? '保持下载模式' : $('state').textContent;
  const cancelling=finding || connection.state==='connecting';
  $('connect').classList.toggle('disconnect-action',connection.state==='ready' || connection.state==='disconnecting');
  $('connect').textContent=cancelling?'取消连接':connection.state==='disconnecting'?'正在断开…':connection.state==='ready'?'断开':connection.state==='error'?'释放连接':'连接设备';
  $('connect').disabled=listening || (busy && !finding) || connection.state==='disconnecting' || (connection.state==='idle' && (!visible() || !navigator.serial || !window.isSecureContext));
  const cannotOpen=listening || busy || connection.state!=='idle' || !visible() || !navigator.serial || !window.isSecureContext;
  $('launchHelper').disabled=cannotOpen;
  $('directChoose').disabled=cannotOpen;
  $('mode').disabled = listening || busy || connection.state !== 'idle';
  $('read').disabled = busy || !ready || !visible();
  $('flash').disabled = busy || !ready || !visible() || !$('confirm').checked || !flashBytes;
  $('add').disabled = busy;
  $('confirm').disabled = busy;
  $('images').querySelectorAll('input,button').forEach(el => el.disabled = busy);
  $('erase').disabled=busy || !ready || !visible();
  $('restart').disabled=busy || (!ready && monitor?.state!=='listening') || !visible();
  const cannotStartConsole=busy || listening || !['idle','ready'].includes(connection.state) || !visible() || !navigator.serial;
  $('consoleChoose').disabled=cannotStartConsole;
  $('consoleStart').textContent={opening:'正在打开…',listening:'停止监听',stopping:'正在停止…',error:'重试停止'}[monitor?.state] || '开始监听';
  $('consoleStart').disabled=listening?(busy || monitor.state==='opening' || monitor.state==='stopping'):cannotStartConsole;
  $('consoleStart').classList.toggle('stop-listening',listening);
  $('consoleBaud').disabled=busy || listening;
  $('visibility').hidden = visible();
}

const launcher = createLauncher({log,status:say});
const handoff = createHandoff({log,onAccepted:()=>launcher.invalidate(),status:text=>{ $('helperStatus').hidden=false; $('helperStatus').textContent=text; }});

class EnhancedLoader extends ESPLoader {
  // Only one protocol attempt per fresh transport. The outer controller owns
  // disconnection/reopen recovery, so failed readers cannot leak into retries.
  async connect(mode) { return super.connect(mode, 1); }
  async readFlash(address, size) {
    // Match Python esptool's stub protocol, including the final digest frame.
    const request = new Uint8Array(16);
    const view = new DataView(request.buffer);
    [address, size, 4096, 64].forEach((value, i) => view.setUint32(i * 4, value, true));
    await this.checkCommand('read flash', this.ESP_READ_FLASH, request);
    const data = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const packet = await this.transport.read(3000);
      if (!packet.length || offset + packet.length > size) throw new Error('Flash 读取长度异常。');
      data.set(packet, offset); offset += packet.length;
      const ack = new Uint8Array(4);
      new DataView(ack.buffer).setUint32(0, offset, true);
      await this.transport.write(ack);
    }
    const digest = await this.transport.read(3000);
    const hex = Array.from(digest, x => x.toString(16).padStart(2, '0')).join('');
    if (digest.length !== 16 || hex !== window.md5(data)) throw new Error('Flash 读取 MD5 校验失败。');
    return data;
  }
  async runStub() {
    const chip = await super.runStub();
    // Upstream returns early for an existing stub without setting this flag.
    this.IS_STUB = true;
    return chip;
  }
  async detectChip(mode) {
    await super.detectChip(mode);
    if (patchC6(this.chip)) log('compat.c6-spi1', {base:'0x60003000'});
    const mac = await this.chip.readMac(this);
    if (selectedMac && selectedMac !== mac) {
      const error = new Error('设备 MAC 与此前选择不一致，已停止连接。请明确更换设备。');
      error.name = 'DeviceMismatchError'; throw error;
    }
    this.verifiedMac = mac;
  }
}
function create(port, cancelled) {
  const transport = new Transport(port);
  const open = transport.connect.bind(transport);
  transport.connect = (baud, options = {}) => open(baud, {...options, bufferSize:65536});
  for (const method of ['setDTR','setRTS']) {
    const original = transport[method].bind(transport);
    transport[method] = async value => {
      try { return await original(value); }
      catch (error) { log('serial.control-error', {method, value, name:error.name, message:error.message}); throw error; }
    };
  }
  const loader = new EnhancedLoader({transport, baudrate:115200,
    terminal:{clean(){},write: text => log('loader', {text}),writeLine: text => log('loader', {text,newline:true})},
    resetConstructors:{usbJTAGSerialReset:t => makeUsbReset(t,{visible,log,cancelled})}});
  return {transport, loader, async start(mode) {
    const chip = await loader.main(mode);
    await loader.flashSpiAttach(0);
    const id = await loader.readFlashId();
    if (!id || id === 0xffffff) throw new Error('Flash ID 无效，不能安全读取或烧录。');
    const size = loader.DETECTED_FLASH_SIZES[(id >>> 16) & 0xff];
    if (!size) throw new Error('Flash 容量码未知，禁止采用默认容量烧录。');
    const capacity = loader.flashSizeBytes(size);
    if (!(capacity > 0)) throw new Error('无法识别 Flash 容量。');
    return {chip, id, size, capacity, mac:loader.verifiedMac};
  }};
}
async function close(session) {
  const t = session.transport;
  if (!t.device.readable && !t.device.writable) return;
  // Upstream owns its reader. Cancel it and wait for unlock before a reopen.
  // A cleanup timeout stops recovery rather than racing a late close with a new open.
  let timer;
  try {
    await Promise.race([t.disconnect(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('串口未释放，请刷新网页')), 3000);
    })]);
  } catch (error) {
    if (t.device.readable || t.device.writable) throw error;
  } finally { clearTimeout(timer); }
}
const connection = new Connection({create,close,visible,log,changed:render,
  resolvePort:async (port,attempt,cancelled)=>{
    const info=port.getInfo();
    const next=await findAuthorizedPort({getPorts:()=>navigator.serial.getPorts(),preferred:port,allowReplacement:true,
      matches:p=>p.getInfo().usbVendorId===info.usbVendorId && p.getInfo().usbProductId===info.usbProductId,
      cancelled:()=>cancelled() || !visible()});
    if(next!==port)log('port.reenumerated',{attempt,identityCheck:selectedMac?'MAC pinned':'first identification'});
    selectedPort=next;return next;
  }});

async function chooseAndConnect(useChooser = false) {
  if (!visible() || busy || monitor?.active || connection.state !== 'idle') return;
  busy = true; finding = true; cancelFinding = false; render();
  try {
    const nativeUsb = ['usb_reset','helper_reset'].includes($('mode').value) || (launchParams.get('helper') === '1' && $('mode').value === 'no_reset');
    const filters = nativeUsb ? [{usbVendorId:0x303a,usbProductId:0x1001}] : [];
    if (useChooser) {
      const chosen = await navigator.serial.requestPort({filters});
      selectedMac = null; selectedPort = chosen;
    } else {
      say('正在等待已授权设备上线，最长约 8 秒…');
      log('port.wait-authorized');
      selectedPort = await findAuthorizedPort({getPorts:()=>navigator.serial.getPorts(),preferred:selectedPort,allowReplacement:true,
        matches:port=>!filters.length || (port.getInfo().usbVendorId===0x303a && port.getInfo().usbProductId===0x1001),
        cancelled:()=>cancelFinding || !visible()});
    }
    if (cancelFinding) throw new Error('连接已取消。');
    finding = false;
    log('port.selected', selectedPort.getInfo());
    flashBytes = 0; $('chip').textContent = $('flashId').textContent = $('capacity').textContent = '—';
    busy = false;
    const mode = $('mode').value;
    const attempts = mode === 'helper_reset' || (selectedMac && mode === 'usb_reset') ? ['no_reset','usb_reset'] : mode;
    const info = await connection.connect(selectedPort, attempts);
    selectedMac = info.mac;
    flashBytes = info.capacity;
    $('chip').textContent = info.chip; $('flashId').textContent = '0x'+info.id.toString(16).padStart(6,'0');
    $('capacity').textContent = info.size;
    log('connect.ready',info); say('连接成功，已保持下载模式。可以读取启动区或选择固件烧录。');
    if (launchParams.get('helper') === '1') {
      const session = connection.session;
      void handoff.complete(info,()=>connection.state === 'ready' && connection.session === session);
    }
  } catch (error) { say(error.name === 'NotFoundError' ? '未获得端口：可能取消了选择或设备在选择期间掉线。已授权时请直接连接。' : error.message); log('ui.error',{name:error.name,message:error.message}); }
  finally { busy = false; finding = false; render(); }
}
let userAction = 0;
let authorizedCount = 0;
async function refreshAuthorization(){
  try {
    const ports=await navigator.serial?.getPorts() || [];
    authorizedCount=ports.filter(port=>{
      const info=port.getInfo();
      return $('mode').value==='default_reset' || (info.usbVendorId===0x303a && info.usbProductId===0x1001);
    }).length;
  } catch {authorizedCount=0;}
}
$('connect').onclick = () => {
  if(finding || ['ready','connecting','error'].includes(connection.state))return disconnectCurrent();
  userAction++;
  if(launchParams.get('helper')==='1' && launcher.state==='busy'){say('助手正在恢复 USB，请等待恢复完成后再连接。');return;}
  if(authorizedCount===1)return chooseAndConnect(false);
  if (launchParams.get('helper') === '1' && launcher.state !== 'ready') {
    launcher.launch();
    return;
  }
  return chooseAndConnect(true);
};
$('directChoose').onclick = () => {userAction++;return chooseAndConnect(true);};
$('launchHelper').onclick = () => {userAction++;launcher.launch();};
$('mode').onchange = () => { userAction++; selectedPort = undefined; selectedMac = null; void refreshAuthorization(); };
async function disconnectCurrent() {
  userAction++;
  if (finding) { cancelFinding = true; say('正在取消等待…'); return; }
  try { await connection.disconnect(); say('连接已取消或释放。'); }
  catch (error) { say(error.message); log('disconnect.error',{message:error.message}); }
  render();
}
document.addEventListener('visibilitychange', () => {
  log('page.visibility',{state:document.visibilityState});
  if (!visible() && finding) cancelFinding = true;
  if (!visible() && connection.state === 'connecting') connection.cancel();
  if (!visible() && busy) say('操作期间请保持网页在前台。若烧录失败，不会自动重试写入。');
  render();
});
navigator.serial?.addEventListener('disconnect', event => {
  log('serial.disconnect');
  if (event.target !== selectedPort) return;
  if (connection.state === 'ready' && !busy) {
    connection.disconnect().catch(error => log('cleanup.error',{message:error.message}));
    say('设备已掉线。请重新连接。');
  }
});
navigator.serial?.addEventListener('connect', () => log('serial.connect'));

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data],{type}));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
$('export').onclick = () => download(JSON.stringify({app:'ESP Launchpad Enhanced',version:'0.1.0',userAgent:navigator.userAgent,events},null,2),'esp-launchpad-diagnostics.json','application/json');
$('clear').onclick = () => { events.length = 0; $('log').textContent = ''; };
function addRow() {
  const row = document.createElement('div'); row.className = 'image-row';
  row.innerHTML = '<label>Flash 地址<input type="text" value="0x0" aria-label="Flash 地址"></label><label>固件文件<input type="file" accept=".bin" aria-label="固件文件"></label><button aria-label="移除文件">移除</button>';
  row.querySelector('button').onclick = () => {row.remove();$('confirm').checked=false;render();};
  row.onchange = () => {$('confirm').checked=false;render();};
  $('images').append(row); $('confirm').checked = false; render();
}
$('add').onclick = addRow;
$('confirm').onchange = render;
async function operation(work) {
  if (busy || connection.state !== 'ready' || !visible()) return;
  busy = true; render();
  try { await work(connection.session.loader); }
  catch (error) {
    log('operation.error',{name:error.name,message:error.message}); say(error.message);
    try { await connection.disconnect(); } catch (cleanupError) { log('cleanup.error',{message:cleanupError.message}); }
  } finally { busy = false; render(); }
}
$('read').onclick = () => operation(async loader => {
  const bytes = await loader.readFlash(0,4096);
  log('flash.read',{address:0,length:bytes.length,allFF:bytes.every(x=>x===255)});
  download(bytes,'esp-boot-0x0-4k.bin','application/octet-stream');
  say(bytes.every(x=>x===255) ? '启动区前 4 KB 全为 FF，没有有效启动头。读取文件已保存。' : '启动区读取完成，文件已保存。');
});
$('flash').onclick = () => operation(async loader => {
  if (!$('confirm').checked) throw new Error('请先确认文件和地址。');
  const images = [];
  for (const row of $('images').children) {
    const file = row.querySelector('input[type=file]').files[0];
    if (!file) throw new Error('每行都需要选择固件文件。');
    const value = row.querySelector('input[type=text]').value.trim();
    if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error('Flash 地址格式无效。');
    images.push({address:Number(value),data:new Uint8Array(await file.arrayBuffer()),name:file.name});
  }
  const checked = validateImages(images,flashBytes);
  if (typeof window.md5 !== 'function') throw new Error('本地校验组件加载失败，请刷新网页。');
  log('flash.start',{files:checked.map(x=>({name:x.name,address:x.address,size:x.data.length})),eraseAll:false});
  await loader.writeFlash({fileArray:checked,flashSize:'keep',flashMode:'keep',flashFreq:'keep',eraseAll:false,compress:true,
    calculateMD5Hash:data=>window.md5(data),
    reportProgress:(i,w,total)=>{$('progress').value=(i+w/total)/checked.length*100;}});
  $('progress').value=100; $('confirm').checked=false;
  say('烧录与 MD5 校验完成。仍保持下载模式；释放 BOOT 后复位可运行固件。'); log('flash.complete');
});
let eraseSession;
$('erase').onclick=()=>{
  if(busy || connection.state!=='ready' || !visible())return;
  eraseSession=connection.session;
  $('eraseTarget').textContent=`${$('chip').textContent} · ${$('capacity').textContent} · MAC ${selectedMac}`;
  $('eraseWord').value='';$('eraseProceed').disabled=true;$('eraseDialog').showModal();
};
$('eraseWord').oninput=()=>{$('eraseProceed').disabled=$('eraseWord').value!=='ERASE';};
$('eraseProceed').onclick=()=>{
  if($('eraseWord').value!=='ERASE' || connection.session!==eraseSession || connection.state!=='ready' || busy)return;
  $('eraseDialog').close();$('eraseWord').value='';$('eraseProceed').disabled=true;
  return operation(async loader=>{
    $('confirm').checked=false;$('progress').removeAttribute('value');
    say('正在全片擦除，请保持连接并等待完成…');log('flash.erase-start',{capacity:flashBytes,mac:selectedMac});
    try {await loader.eraseFlash();$('progress').value=100;log('flash.erase-complete');say('全片擦除完成，仍保持下载模式。请烧录有效固件后再重启。');}
    finally {if(!$('progress').hasAttribute('value'))$('progress').value=0;}
  });
};
monitor=new SerialMonitor({
  data:appendConsole,
  error:error=>{log('console.error',{message:error.message});say('串口监听中断：'+error.message);},
  changed:state=>{
    $('consoleState').textContent={idle:'未监听',opening:'正在打开',listening:'正在监听',stopping:'正在停止',error:'端口待释放'}[state];
    if(state==='idle' && !busy && !monitor.lastError)say('串口监听已结束，串口已释放。需要时可重新开始监听。');
    log('console.state',{state});render();
  }
});
async function startConsole(choose=false){
  if(busy || monitor.active || !visible())return;
  userAction++;
  // requestPort must happen in this click, before awaiting disconnect/other work.
  const choice=selectedPort && !choose?Promise.resolve(selectedPort):navigator.serial.requestPort();
  busy=true;render();
  try {
    const port=await choice;
    await connection.disconnect();
    if(selectedPort!==port){selectedMac=null;selectedPort=port;}
    await monitor.start(port,Number($('consoleBaud').value));
    say('正在监听串口输出；需要启动固件时可点击“模组重启”。');
  } catch(error){log('console.error',{message:error.message});say(error.message+'；可断开设备后重新选择串口。');}
  finally{busy=false;render();}
}
$('consoleStart').onclick=()=>monitor.active?stopConsole():startConsole();
$('consoleChoose').onclick=()=>startConsole(true);
async function stopConsole(){
  if(busy)return;busy=true;render();
  const started=performance.now();log('console.stop-requested');
  try{await monitor.stop();log('console.stop-complete',{elapsed:Math.round(performance.now()-started)});say('监听已停止，串口已释放。');}
  catch(error){say(error.message);log('console.error',{message:error.message});}
  finally{busy=false;render();}
}
$('consoleClear').onclick=()=>{$('consoleOutput').textContent='';};
$('consoleExport').onclick=()=>download($('consoleOutput').textContent,'esp-serial-console.txt','text/plain;charset=utf-8');
let resetTarget;
$('restart').onclick=()=>{
  if(busy || !visible())return;
  resetTarget=monitor.port || connection.session?.transport.device;
  if(resetTarget)$('restartDialog').showModal();
};
$('restartProceed').onclick=async()=>{
  if(busy || !visible() || resetTarget!==(monitor.port || connection.session?.transport.device))return;
  $('restartDialog').close();busy=true;userAction++;render();
  const listen=$('restartListen').checked;
  let opened=false;
  try {
    await monitor.stop();await connection.disconnect();
    if(listen)await monitor.start(resetTarget,Number($('consoleBaud').value));
    else {await resetTarget.open({baudRate:Number($('consoleBaud').value),bufferSize:65536});opened=true;}
    log('device.restart-start');await restartDevice(resetTarget);
    log('device.restart-sent');say(listen?(monitor.state==='listening'?'已发送重启信号，正在监听启动输出。':'已发送重启信号，USB 连接已变化，请再次开始监听。'):'已发送重启信号，串口将释放。需要烧录时重新连接。');
  } catch(error){log('device.restart-error',{message:error.message});say('重启期间连接发生变化：'+error.message+'。请检查输出或重新连接。');}
  finally {
    if(opened){try{await resetTarget.close();}catch(error){say('串口释放失败：'+error.message);}}
    busy=false;render();
  }
};

addRow();
const launchParams = new URLSearchParams(location.search);
if (['usb_reset','no_reset','default_reset'].includes(launchParams.get('mode'))) $('mode').value = launchParams.get('mode');
if (launchParams.get('helper') === '1') {
  $('helperDownload').hidden = true;
  $('helperRecovery').hidden = false;
  if (launchParams.get('mode') === 'no_reset') $('mode').value = 'helper_reset';
}
if (!navigator.serial || !window.isSecureContext) say('需要支持 Web Serial 的 Chrome/Edge，并通过 localhost 或 HTTPS 打开。');
else say('准备就绪，连接设备即可开始。');
log('app.ready',{version:'0.1.0',esptool:'0.6.1',visibility:document.visibilityState});
render();
// Explicit automation surface: same connection path, authorized ports only.
window.enhancedDiagnostics = {events,connection};


// Only the helper landing page makes one automatic connection attempt.
// First authorization still requires a user gesture; getPorts never prompts.
let helperAutoPending = launchParams.get('helper') === '1';
async function connectAuthorizedOnArrival() {
  if (!helperAutoPending || !visible() || !navigator.serial || !window.isSecureContext) return;
  helperAutoPending = false;
  if (!['helper_reset','usb_reset'].includes($('mode').value)) return;
  const action = userAction;
  try {
    const ports = (await navigator.serial.getPorts()).filter(port => {
      const info = port.getInfo();
      return info.usbVendorId === 0x303a && info.usbProductId === 0x1001;
    });
    if (action !== userAction || busy || monitor?.active || connection.state !== 'idle') return;
    log('authorization.checked', {availableNativePorts:ports.length});
    if (!ports.length) {
      say('未发现可用的已授权 ESP USB 设备。请确认设备已接上，再点击“连接设备”。');
    } else if (ports.length > 1) {
      say('检测到多个已授权 ESP USB 设备，请点击“连接设备”选择目标。');
    } else if (!visible()) {
      helperAutoPending = true;
    } else {
      say('发现已授权 ESP USB 设备，正在自动连接…');
      await chooseAndConnect(false);
    }
  } catch (error) {
    if (action !== userAction) return;
    log('authorization.error', {name:error.name,message:error.message});
    say('无法检查 USB 授权，请点击“连接设备”手动连接。');
  }
}
document.addEventListener('visibilitychange', connectAuthorizedOnArrival);
connectAuthorizedOnArrival();

// Refresh liveness separately from USB permissions. Never auto-launch a native app.
async function refreshHelperStatus(){
  if(launchParams.get('helper')!=='1' || !visible() || monitor?.active || connection.state!=='idle')return;
  const state=await launcher.refresh();
  if(connection.state==='idle'){
    $('helperStatus').hidden=false;
    $('helperStatus').textContent=state==='ready'?'助手已就绪，可以选择 USB 设备。':state==='busy'?'助手正在恢复 USB，请稍候。':'助手未运行。“连接设备”将按需唤起助手；设备已稳定时也可直接授权。';
  }
}
document.addEventListener('visibilitychange',refreshHelperStatus);
setInterval(refreshHelperStatus,2000);
refreshHelperStatus();

document.addEventListener("visibilitychange",refreshAuthorization);
navigator.serial?.addEventListener("connect",refreshAuthorization);
navigator.serial?.addEventListener("disconnect",refreshAuthorization);
refreshAuthorization();
