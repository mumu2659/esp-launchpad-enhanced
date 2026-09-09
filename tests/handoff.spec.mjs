import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=resolve('.');
const mockBundle=`
export class Transport {
 constructor(device){this.device=device;} async connect(){} async disconnect(){} async setDTR(){} async setRTS(){}
 async read(){return this.packets.shift();} async write(){}
}
export class ESPLoader {
 constructor(o){this.transport=o.transport;this.DETECTED_FLASH_SIZES={23:'8MB'};this.chip={CHIP_NAME:'ESP32-C6',readMac:async()=>'11:22:33:44:55:66'};}
 async connect(){if(window.failHandshake)throw Error('handshake failed');}
 async detectChip(m){await this.connect(m);} async main(m){await this.detectChip(m);await this.runStub();return 'ESP32-C6 mock';}
 async runStub(){return this.chip;} async flashSpiAttach(){} async readFlashId(){return 0x174020;} flashSizeBytes(){return 8388608;}
 async checkCommand(name,op,request){const data=new Uint8Array(new DataView(request.buffer).getUint32(4,true)).fill(255);
  const digest=Uint8Array.from(window.md5(data).match(/../g),x=>parseInt(x,16));this.transport.packets=[data,digest];}
}`;
async function startHelper() {
  const folder=await mkdtemp(join(tmpdir(),'launchpad-handoff-'));
  const files=['helper-sw.js','enhanced/app.js','enhanced/core.mjs','enhanced/handoff.mjs','enhanced/launcher.mjs','enhanced/monitor.mjs','enhanced/style.css',
    'node_modules/js-md5/build/md5.min.js'];
  for(const name of files){await mkdir(dirname(join(folder,name)),{recursive:true});await copyFile(join(root,name),join(folder,name));}
  await mkdir(join(folder,'node_modules/esptool-js'),{recursive:true});
  await writeFile(join(folder,'node_modules/esptool-js/bundle.js'),mockBundle);
  await writeFile(join(folder,'index.html'),await readFile(join(root,'enhanced.html'),'utf8'));
  const child=spawn(process.env.HELPER_PYTHON,['-I', '-X', 'utf8',join(root,'usb-helper/helper.py'),'--serve-only','--no-browser',
    '--http-port','0','--site-dir',folder],{env:{...process.env,LAUNCHPAD_HELPER_INSTANCE_DIR:join(folder,'instances')}});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
  try {
    await expect.poll(()=>output.match(/http:\/\/localhost:\d+/)?.[0],{timeout:10000,message:()=>output}).toBeTruthy();
    const base=output.match(/http:\/\/localhost:\d+/)[0];
    return {child,base,folder,output:()=>output,async close(){if(child.exitCode===null){child.kill();await once(child,'exit');}await rm(folder,{recursive:true,force:true});}};
  } catch(error){child.kill();await rm(folder,{recursive:true,force:true});throw error;}
}
async function mockSerial(page, fail=false) {
  await page.addInitScript(fail=>{
    window.failHandshake=fail;
    const p={getInfo:()=>({usbVendorId:0x303a,usbProductId:0x1001})};
    const serial=new EventTarget();serial.getPorts=async()=>[p];serial.requestPort=async()=>{throw Error('Unexpected chooser');};
    Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
  },fail);
}
test('successful browser handoff exits real Python helper; offline read and reload still work',async({page})=>{
  const helper=await startHelper();
  const failures=[];
  page.context().on('console',message=>{if(message.type()==='error')failures.push(message.text());});
  page.context().on('requestfailed',r=>failures.push(r.url()+': '+r.failure()?.errorText));
  page.context().on('response',r=>{if(r.status()>=400)failures.push(r.status()+': '+r.url());});
  try {
    await mockSerial(page);
    await page.goto(helper.base+'/?mode=no_reset&helper=1');
    await expect(page.locator('#state')).toHaveText('已连接');
    try {await expect(page.locator('#log')).toContainText('helper.handoff-accepted',{timeout:20000});}
    catch(error){throw new Error(error.message+'\nNetwork: '+JSON.stringify(failures)+'\nWorkers: '+JSON.stringify(await page.evaluate(async()=>({registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state})),caches:await caches.keys()})))+'\nHelper: '+helper.output());}
    await expect.poll(()=>helper.child.exitCode).toBe(0);
    expect(helper.output()).toContain('网页已确认接管');
    expect(await fetch(helper.base).then(()=>true,()=>false)).toBe(false);
    await page.locator('#read').click();
    await expect(page.locator('#message')).toContainText('前 4 KB 全为 FF');
    await page.reload();
    await expect(page.locator('#log')).toContainText('app.ready');
    await expect(page.locator('#state')).toHaveText('未连接');
    await expect(page.locator('#read')).toBeDisabled();
    await page.locator('#connect').click();
    await expect(page.locator('#state')).toHaveText('已连接');
    await expect(page.locator('#helperStatus')).toContainText('网页独立运行');
    await page.locator('#read').click();
    await expect(page.locator('#message')).toContainText('前 4 KB 全为 FF');
  } finally {await helper.close();}
});
test('failed chip handshake leaves real helper running',async({page})=>{
  const helper=await startHelper();
  try {
    await mockSerial(page,true);
    await page.goto(helper.base+'/?mode=no_reset&helper=1');
    await expect(page.locator('#log')).toContainText('ui.error');
    expect(helper.child.exitCode).toBeNull();
    expect((await fetch(helper.base)).ok).toBe(true);
    expect(await page.locator('#log').innerText()).not.toContain('helper.handoff-accepted');
  } finally {await helper.close();}
});
