import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const base=process.env.BASE_URL||'http://localhost:4173/';
test('real local dependencies load without console errors or CDN requests',async({page})=>{
  const errors=[];const external=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(base))external.push(r.url());});
  await page.goto(base);
  await expect(page.locator('#log')).toContainText('app.ready');
  expect(await page.evaluate(()=>window.md5(new Uint8Array([97,98,99])))).toBe('900150983cd24fb0d6963f7d28e17f72');
  await expect(page.locator('#connect')).toHaveText('连接设备');
  await expect(page.locator('#launchHelper')).toBeHidden();
  await expect(page.locator('#directChoose')).toBeHidden();
  await expect(page.locator('#flash')).toBeDisabled();
  await page.locator('#add').click();await expect(page.locator('.image-row')).toHaveCount(2);
  expect(errors).toEqual([]);expect(external).toEqual([]);
});

test('mock transport: connect, valid C6 Flash ID, explicit flash and MD5 path',async({page})=>{
  await page.addInitScript(()=>{
    window.failFirstNoReset=true;
    const port={getInfo:()=>({usbVendorId:0x303a,usbProductId:0x1001})};
    const serial=new EventTarget();serial.requestPort=async(options)=>{window.chooserFilters=options.filters;window.chooserCalls=(window.chooserCalls||0)+1;return port;};serial.getPorts=async()=>[port];
    Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
  });
  await page.route('**/node_modules/esptool-js/bundle.js',r=>r.fulfill({contentType:'text/javascript',body:`
    export class Transport {constructor(device){this.device=device;}async connect(baud,options){window.serialBufferSize=options.bufferSize;} async disconnect(){} async setDTR(){} async setRTS(){} async read(){return this.packets.shift();} async write(data){window.readAck=new DataView(data.buffer).getUint32(0,true);} }
    export class ESPLoader {
      constructor(o){this.transport=o.transport;this.DETECTED_FLASH_SIZES={23:'8MB'};this.chip={CHIP_NAME:'ESP32-C6',readMac:async()=>'11:22:33:44:55:66',SPI_REG_BASE:0x60002000};}
      async connect(mode){window.attemptModes=(window.attemptModes||[]).concat(mode);await this.transport.connect(115200);if(mode==='no_reset' && window.failFirstNoReset){window.failFirstNoReset=false;throw Error('chip left download mode');}} async detectChip(m){await this.connect(m);}
      async main(m){await this.detectChip(m);return 'ESP32-C6 mock';}
      async runStub(){} async flashSpiAttach(){}
      async checkCommand(name, op, request){
        const view=new DataView(request.buffer);
        if(view.getUint32(12,true)!==64)throw Error('Invalid read window');
        const data=new Uint8Array(view.getUint32(4,true)).fill(255);
        const hash=window.md5(data);
        const digest=Uint8Array.from(hash.match(/../g),x=>parseInt(x,16));
        if(window.corruptRead)digest[0]^=1;
        this.transport.packets=[data,digest];
      }
      async readFlashId(){if(this.chip.SPI_REG_BASE!==0x60003000)throw Error('Wrong SPI base');return 0x174020;}
      async detectFlashSize(){return '8MB';} flashSizeBytes(){return 8388608;}
      async writeFlash(o){if(!o.calculateMD5Hash||o.eraseAll)throw Error('Invalid options');
        for(const x of o.fileArray){if(o.calculateMD5Hash(x.data).length!==32)throw Error('MD5 missing');}
        o.reportProgress(0,100,100);window.mockFlashed=true;}
    }` }));
  await page.route('**/__helper__/session',r=>r.fulfill({json:{ready:true,token:'test'}}));
  await page.goto(base+'?mode=no_reset&helper=1');
  await expect(page.locator('#state')).toHaveText('已连接');
  await expect(page.locator('#flashId')).toHaveText('0x174020');
  expect(await page.evaluate(()=>window.mockFlashed)).toBeUndefined();
  expect(await page.evaluate(()=>window.chooserCalls||0)).toBe(0);
  expect(await page.evaluate(()=>window.serialBufferSize)).toBe(65536);
  expect(await page.evaluate(()=>window.attemptModes)).toEqual(['no_reset','usb_reset']);
  await page.locator('input[type=file]').setInputFiles({name:'mock.bin',mimeType:'application/octet-stream',buffer:Buffer.from([0xe9,1,2,3])});
  await expect(page.locator('#flash')).toBeDisabled();
  await page.locator('#confirm').check();await page.locator('#flash').click();
  await expect(page.locator('#message')).toContainText('MD5 校验完成');
  expect(await page.evaluate(()=>window.mockFlashed)).toBe(true);
  await page.locator('#read').click();
  await expect(page.locator('#message')).toContainText('前 4 KB 全为 FF');
  expect(await page.evaluate(()=>window.readAck)).toBe(4096);
  await page.evaluate(()=>window.corruptRead=true);
  await page.locator('#read').click();
  await expect(page.locator('#message')).toContainText('MD5 校验失败');
  await expect(page.locator('#state')).toHaveText('未连接');
  await expect(page.locator('#connect')).toBeEnabled();
  await page.locator('#connect').click();
  await expect(page.locator('#state')).toHaveText('已连接');
  expect(await page.evaluate(()=>window.chooserCalls||0)).toBe(0);
});


test('helper handoff selects automatic recovery and hides the redundant download', async({page})=>{
  await page.goto(base+'?mode=no_reset&helper=1');
  await expect(page.locator('#log')).toContainText('app.ready');
  await expect(page.locator('#mode')).toHaveValue('helper_reset');
  await expect(page.locator('#helperDownload')).toBeHidden();
  await expect(page.locator('#state')).toHaveText('未连接');
});

test('explicit no-reset remains strict outside helper handoff', async({page})=>{
  await page.goto(base+'?mode=no_reset');
  await expect(page.locator('#log')).toContainText('app.ready');
  await expect(page.locator('#mode')).toHaveValue('no_reset');
});


for (const count of [0,2]) {
  test(`helper authorization: ${count} devices never triggers a chooser or automatic open`, async({page})=>{
    await page.addInitScript(count=>{
      const serial = new EventTarget();
      serial.getPorts = async()=>Array.from({length:count},()=>({
        getInfo:()=>({usbVendorId:0x303a,usbProductId:0x1001}),
        open:async()=>{window.unexpectedOpen=true;throw Error('Unexpected open');}
      }));
      serial.requestPort = async()=>{window.unexpectedChooser=true;throw Error('Unexpected chooser');};
      Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
    }, count);
    await page.goto(base+'?mode=no_reset&helper=1');
    await expect(page.locator('#log')).toContainText('authorization.checked');
    await expect(page.locator('#message')).toContainText(count ? '多个已授权' : '未发现可用');
    await expect(page.locator('#state')).toHaveText('未连接');
    expect(await page.evaluate(()=>!!window.unexpectedOpen||!!window.unexpectedChooser)).toBe(false);
  });
}


test('offline helper prompts native recovery; direct authorization remains available',async({page})=>{
  // Mock the OS boundary: tests must never launch the installed real USB helper.
  const launcher=await readFile(new URL('../enhanced/launcher.mjs',import.meta.url),'utf8');
  expect(launcher).toContain('navigate=url=>{location.href=url;}');
  await page.route('**/enhanced/launcher.mjs',r=>r.fulfill({contentType:'text/javascript',body:launcher.replace(
    'navigate=url=>{location.href=url;}', 'navigate=url=>{window.protocolLaunches=(window.protocolLaunches||[]).concat(url);}') }));
  await page.addInitScript(()=>{
    const serial=new EventTarget();serial.getPorts=async()=>[];
    serial.requestPort=async()=>{window.chooserCalls=(window.chooserCalls||0)+1;throw new DOMException('cancelled','NotFoundError');};
    Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
  });
  await page.route('**/__helper__/session',r=>r.fulfill({status:404,body:'No helper'}));
  await page.goto(base+'?mode=no_reset&helper=1');
  await expect(page.locator('#helperStatus')).toContainText('助手未运行');
  expect(await page.locator('#log').innerText()).not.toContain('helper.launch-requested');
  await page.locator('#connect').click();
  await expect(page.locator('#log')).toContainText('helper.launch-requested');
  expect(await page.evaluate(()=>window.protocolLaunches)).toEqual(['esp-launchpad-enhanced://recover']);
  expect(await page.evaluate(()=>window.chooserCalls||0)).toBe(0);
  await page.locator('#connectionHelp summary').click();
  await page.locator('#directChoose').click();
  expect(await page.evaluate(()=>window.chooserCalls)).toBe(1);
});

test('ready helper opens chooser; busy helper waits without launching or selecting',async({page})=>{
  await page.addInitScript(()=>{
    const serial=new EventTarget();serial.getPorts=async()=>[];
    serial.requestPort=async()=>{window.chooserCalls=(window.chooserCalls||0)+1;throw new DOMException('cancelled','NotFoundError');};
    Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
  });
  let ready=false;
  await page.route('**/__helper__/session',r=>r.fulfill({json:{ready,token:'test'}}));
  await page.goto(base+'?mode=no_reset&helper=1');
  await expect(page.locator('#helperStatus')).toContainText('正在恢复');
  await page.locator('#connect').click();
  expect(await page.evaluate(()=>window.chooserCalls||0)).toBe(0);
  expect(await page.locator('#log').innerText()).not.toContain('helper.launch-requested');
  ready=true;
  await expect(page.locator('#helperStatus')).toContainText('助手已就绪');
  await page.locator('#connect').click();
  expect(await page.evaluate(()=>window.chooserCalls)).toBe(1);
});
