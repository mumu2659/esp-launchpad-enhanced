import {test,expect} from '@playwright/test';
const base=process.env.BASE_URL||'http://localhost:4173/';
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{
    window.actions=[];
    const port={getInfo:()=>({usbVendorId:0x303a,usbProductId:0x1001}),
      async open(options){if(this.readable)throw Error('port already open');window.actions.push('open');this.readable=new ReadableStream({start:c=>{window.serialOutput=c;}});},
      async close(){if(this.readable?.locked)throw Error('reader not released');window.actions.push('close');this.readable=null;},
      async setSignals(signals){window.actions.push(signals);}
    };
    window.testPort=port;
    const serial=new EventTarget();serial.getPorts=async()=>[port];serial.requestPort=async()=>port;
    Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
  });
  await page.route('**/node_modules/esptool-js/bundle.js',r=>r.fulfill({contentType:'text/javascript',body:`
    export class Transport {
      constructor(device){this.device=device;} async connect(baud,opts){await this.device.open(opts);}
      async disconnect(){await this.device.close();} async setDTR(){} async setRTS(){}
    }
    export class ESPLoader {
      constructor(o){this.terminal=o.terminal;this.transport=o.transport;this.DETECTED_FLASH_SIZES={23:'8MB'};this.chip={CHIP_NAME:'ESP32-C6',readMac:async()=>'11:22:33:44:55:66'};}
      async connect(){await this.transport.connect(115200);} async detectChip(){await this.connect();}
      async main(){this.terminal.writeLine('esptool.js');this.terminal.write('Detecting chip type... ');this.terminal.writeLine('ESP32-C6');await this.detectChip();if(window.holdConnect)await new Promise(resolve=>{window.releaseConnect=resolve;});return 'ESP32-C6 mock';} async flashSpiAttach(){}
      async readFlashId(){return 0x174020;} flashSizeBytes(){return 8388608;}
      async eraseFlash(){window.actions.push('erase');if(window.failErase)throw Error('erase failed');await new Promise(resolve=>{window.finishErase=resolve;});}
    }`}));
  await page.goto(base);
  await page.locator('#connect').click();
  await expect(page.locator('#state')).toHaveText('已连接');
});
test('erase requires explicit text confirmation, excludes concurrent operations, and stays connected',async({page})=>{
  await page.locator('#erase').click();
  await expect(page.locator('#eraseTarget')).toContainText('8MB');
  await expect(page.locator('#eraseProceed')).toBeDisabled();
  await page.locator('#eraseDialog button[value=cancel]').click();
  expect(await page.evaluate(()=>window.actions.includes('erase'))).toBe(false);
  await page.locator('#erase').click();await page.locator('#eraseWord').fill('ERASE');await page.locator('#eraseProceed').click();
  await expect(page.locator('#restart')).toBeDisabled();await expect(page.locator('#consoleStart')).toBeDisabled();await expect(page.locator('#erase')).toBeDisabled();
  await page.evaluate(()=>window.finishErase());
  await expect(page.locator('#message')).toContainText('全片擦除完成');await expect(page.locator('#state')).toHaveText('已连接');
  expect(await page.evaluate(()=>window.actions.filter(x=>x==='erase').length)).toBe(1);
});
test('erase error is reported without automatic retry or restart',async({page})=>{
  await page.evaluate(()=>{window.failErase=true;});
  await page.locator('#erase').click();await page.locator('#eraseWord').fill('ERASE');await page.locator('#eraseProceed').click();
  await expect(page.locator('#message')).toContainText('erase failed');await expect(page.locator('#state')).toHaveText('未连接');
  expect(await page.evaluate(()=>window.actions.filter(x=>x==='erase').length)).toBe(1);
});
test('console closes loader first, displays raw text safely, and releases reader on stop',async({page})=>{
  await expect(page.locator('#consoleOutput')).toContainText('esptool.js\nDetecting chip type... ESP32-C6');
  await expect(page.locator('#consoleOutput')).toContainText('连接成功');
  await expect(page.locator('#log')).toBeHidden();
  await page.locator('#consoleStart').click();
  await expect(page.locator('#consoleState')).toHaveText('正在监听');
  expect(await page.evaluate(()=>window.actions)).toEqual(['open','close','open']);
  await expect(page.locator('#connect')).toBeEnabled();await expect(page.locator('#erase')).toBeDisabled();
  await page.evaluate(()=>window.serialOutput.enqueue(new TextEncoder().encode('启动成功 <script>alert(1)</script>\n')));
  await expect(page.locator('#consoleOutput')).toContainText('启动成功 <script>');
  expect(await page.locator('#consoleOutput script').count()).toBe(0);
  await expect(page.locator('#consoleStart')).toHaveText('暂停监听');
  expect(await page.locator('#consoleStop').count()).toBe(0);
  await page.locator('#consoleStart').click();await expect(page.locator('#consoleState')).toHaveText('已暂停 · 保持连接');
  expect(await page.evaluate(()=>window.testPort.readable!==null)).toBe(true);
  await page.evaluate(()=>window.serialOutput.enqueue(new TextEncoder().encode('PAUSED_DATA')));
  await page.waitForTimeout(50);
  await expect(page.locator('#consoleOutput')).not.toContainText('PAUSED_DATA');
  await page.locator('#consoleStart').click();
  await page.evaluate(()=>window.serialOutput.enqueue(new TextEncoder().encode('RESUMED_DATA')));
  await expect(page.locator('#consoleOutput')).toContainText('RESUMED_DATA');
  await page.locator('#closeUSB').click();await expect(page.locator('#consoleState')).toHaveText('未监听');
  await expect(page.locator('#consoleStart')).toHaveText('开始监听');
  expect(await page.evaluate(()=>window.testPort.readable)).toBeNull();await expect(page.locator('#connect')).toBeEnabled();
  await page.locator('#consoleClear').click();await expect(page.locator('#consoleOutput')).toBeEmpty();
});
test('restart is confirmed, uses normal reset signals and continues console listening',async({page})=>{
  await page.locator('#restart').click();await page.locator('#restartDialog button[value=cancel]').click();
  expect(await page.evaluate(()=>window.actions.some(x=>typeof x==='object'))).toBe(false);
  await page.locator('#restart').click();await page.locator('#restartProceed').click();
  await expect(page.locator('#message')).toContainText('已发送重启信号');
  expect(await page.evaluate(()=>window.actions)).toEqual(['open','close','open',{dataTerminalReady:false,requestToSend:true},{dataTerminalReady:false,requestToSend:false}]);
  await expect(page.locator('#consoleState')).toHaveText('正在监听');
  await page.evaluate(()=>window.serialOutput.enqueue(new TextEncoder().encode('boot: normal\n')));
  await expect(page.locator('#consoleOutput')).toContainText('boot: normal');
});

test('stale erase confirmation cannot erase after the connection is released',async({page})=>{
  await page.locator('#erase').click();await page.locator('#eraseWord').fill('ERASE');
  await page.evaluate(()=>window.enhancedDiagnostics.connection.disconnect());
  await page.locator('#eraseProceed').click();
  expect(await page.evaluate(()=>window.actions.includes('erase'))).toBe(false);
});
test('restart without console releases the raw port and requires reconnect before flashing',async({page})=>{
  await page.locator('#restart').click();await page.locator('#restartListen').uncheck();await page.locator('#restartProceed').click();
  await expect(page.locator('#message')).toContainText('已发送重启信号');
  await expect(page.locator('#state')).toHaveText('未连接');
  expect(await page.evaluate(()=>window.testPort.readable)).toBeNull();
  await expect(page.locator('#erase')).toBeDisabled();await expect(page.locator('#connect')).toBeEnabled();
});

test('single connection button disconnects, reconnects and cancels an in-flight handshake',async({page})=>{
  await expect(page.locator('#connect')).toHaveText('断开');
  expect(await page.locator('#disconnect').count()).toBe(0);
  await page.locator('#connect').click();await expect(page.locator('#connect')).toHaveText('连接设备');
  expect(await page.evaluate(()=>window.testPort.readable)).toBeNull();
  await page.evaluate(()=>{window.holdConnect=true;});
  await page.locator('#connect').click();await expect(page.locator('#connect')).toHaveText('取消连接');
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseConnect)).toBe('function');
  await page.locator('#connect').click();await page.evaluate(()=>window.releaseConnect());
  await expect(page.locator('#connect')).toHaveText('连接设备');
  await expect(page.locator('#state')).toHaveText('未连接');
  expect(await page.evaluate(()=>window.testPort.readable)).toBeNull();
});

test('port chooser opens directly with combined filters and preserves connection on cancel',async({page})=>{
  await page.evaluate(()=>{navigator.serial.requestPort=async options=>{window.choiceOptions=options;return window.testPort;};});
  await page.locator('#consoleStart').click();
  await page.locator('#chooseUSB').click();
  await expect(page.locator('#consoleState')).toHaveText('正在监听');
  expect(await page.locator('#portDialog').count()).toBe(0);
  const options=await page.evaluate(()=>window.choiceOptions);
  expect(options.filters).toContainEqual({usbVendorId:0x34bf,usbProductId:0xff0a});
  expect(options.filters).toContainEqual({usbVendorId:0x303a,usbProductId:0x1001});
  await page.getByText('高级选项',{exact:true}).click();
  await page.locator('#consoleAll').check();
  await page.locator('#chooseUSB').click();
  expect(await page.evaluate(()=>window.choiceOptions)).toEqual({});
  await page.evaluate(()=>{navigator.serial.requestPort=async()=>{throw new DOMException('cancelled','NotFoundError');};});
  await page.locator('#chooseUSB').click();
  await expect(page.locator('#message')).toContainText('未选择串口');
  await expect(page.locator('#consoleState')).toHaveText('正在监听');
  await page.locator('#connect').click();
});

async function installUarts(page){
  await page.evaluate(()=>{
    window.uarts=[0,1].map(i=>({
      closes:0,getInfo:()=>({usbVendorId:0x34bf,usbProductId:0xff0a}),
      async open(options){this.options=options;if(this.readable)throw Error('already open');this.readable=new ReadableStream({start:c=>{this.output=c;}});},
      async close(){if(this.readable.locked)throw Error('locked');this.closes++;this.readable=null;}
    }));
    let index=0;navigator.serial.requestPort=async()=>window.uarts[index++];
  });
}
test('three sources filter cached output independently, pause together, and release only the download port',async({page})=>{
  await page.locator('#consoleStart').click();
  await installUarts(page);
  await page.locator('#chooseUART0').click();
  await page.locator('#chooseUART1').click();
  await page.evaluate(()=>{
    window.serialOutput.enqueue(new TextEncoder().encode('usb message\n'));
    window.uarts[0].output.enqueue(new TextEncoder().encode('uart zero\n'));
    window.uarts[1].output.enqueue(new TextEncoder().encode('uart one\n'));
  });
  await expect(page.locator('#consoleOutput')).toContainText('[USB] usb message');
  await expect(page.locator('#consoleOutput')).toContainText('[UART0] uart zero');
  await expect(page.locator('#consoleOutput')).toContainText('[UART1] uart one');
  await page.locator('#showUART0').uncheck();
  await expect(page.locator('#consoleOutput')).not.toContainText('uart zero');
  await page.evaluate(()=>window.uarts[0].output.enqueue(new TextEncoder().encode('hidden cached\n')));
  await page.waitForTimeout(50);
  await expect(page.locator('#consoleOutput')).not.toContainText('hidden cached');
  await page.locator('#showUART0').check();
  await expect(page.locator('#consoleOutput')).toContainText('hidden cached');
  await page.locator('#consoleStart').click();
  await expect(page.locator('#statusUART1')).toHaveText('已暂停');
  await page.evaluate(()=>window.uarts[1].output.enqueue(new TextEncoder().encode('discard while paused\n')));
  await page.waitForTimeout(50);
  await page.locator('#consoleStart').click();
  await expect(page.locator('#consoleOutput')).not.toContainText('discard while paused');
  await page.locator('#connect').click();
  await expect(page.locator('#state')).toHaveText('已连接');
  await expect(page.locator('#statusUSB')).toHaveText('已选择');
  await expect(page.locator('#statusUART0')).toHaveText('监听中');
  expect(await page.evaluate(()=>window.uarts.map(p=>p.closes))).toEqual([0,0]);
  await page.locator('#closeUART0').click();
  await expect(page.locator('#statusUART1')).toHaveText('监听中');
  await page.evaluate(()=>window.uarts[1].output.enqueue(new TextEncoder().encode('still alive\n')));
  await expect(page.locator('#consoleOutput')).toContainText('still alive');
  await page.locator('#closeUART1').click();await page.locator('#connect').click();
});
test('duplicate port is rejected without disrupting its owner; unplug leaves other channel running',async({page})=>{
  await installUarts(page);
  await page.locator('#chooseUART0').click();
  await page.evaluate(()=>{navigator.serial.requestPort=async()=>window.uarts[0];});
  await page.locator('#chooseUART1').click();
  await expect(page.locator('#message')).toContainText('正在 UART0 使用');
  expect(await page.evaluate(()=>window.uarts[0].closes)).toBe(0);
  await page.evaluate(()=>{navigator.serial.requestPort=async()=>window.uarts[1];});
  await page.locator('#chooseUART1').click();
  await page.evaluate(()=>window.uarts[0].output.error(Error('unplugged')));
  await expect(page.locator('#statusUART0')).toHaveText('已选择');
  await expect(page.locator('#statusUART1')).toHaveText('监听中');
  await expect(page.locator('#state')).toHaveText('已连接');
  await page.locator('#closeUART1').click();await page.locator('#connect').click();
});

test('baud rates are per UART and absent from USB controls',async({page})=>{
  expect(await page.locator('#consoleBaud,#consoleChannel,#consoleChoose').count()).toBe(0);
  expect(await page.locator('#showUSB').locator('..').locator('..').locator('select').count()).toBe(0);
  await installUarts(page);
  await page.locator('#baudUART0').selectOption('9600');
  await page.locator('#chooseUART0').click();
  await expect(page.locator('#baudUART0')).toBeDisabled();
  await expect(page.locator('#baudUART1')).toBeEnabled();
  await page.locator('#baudUART1').selectOption('230400');
  await page.locator('#chooseUART1').click();
  expect(await page.evaluate(()=>window.uarts.map(p=>p.options.baudRate))).toEqual([9600,230400]);
  await page.locator('#closeUART0').click();await page.locator('#closeUART1').click();
});

test('page exit releases all owned ports and upstream opens in a new tab',async({page})=>{
  await installUarts(page);await page.locator('#chooseUART0').click();await page.locator('#chooseUART1').click();
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await expect.poll(()=>page.evaluate(()=>window.testPort.readable===null && window.uarts.every(p=>p.readable===null))).toBe(true);
  const link=page.getByRole('link',{name:'原版界面 ↗'});
  await expect(link).toHaveAttribute('target','_blank');
  await expect(link).toHaveAttribute('rel','noopener noreferrer');
});
