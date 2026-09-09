import test from 'node:test';
import assert from 'node:assert/strict';
import {SerialMonitor,restartDevice} from './monitor.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function port(){return {
  closes:0,signals:[],getInfo:()=>({usbVendorId:0x303a,usbProductId:0x1001}),
  async open(options){this.options=options;this.readable=new ReadableStream({start:c=>{this.controller=c;}});},
  async close(){assert.equal(this.readable.locked,false);this.closes++;this.readable=null;},
  async setSignals(signals){this.signals.push(signals);}
};}
test('monitor decodes split UTF-8 and releases a pending reader before close',async()=>{
  const p=port(),text=[],errors=[];
  const monitor=new SerialMonitor({data:x=>text.push(x),error:x=>errors.push(x),changed:()=>{}});
  await monitor.start(p,115200);
  const bytes=new TextEncoder().encode('启动\n');
  p.controller.enqueue(bytes.slice(0,2));p.controller.enqueue(bytes.slice(2));await tick();
  assert.equal(text.join(''),'启动\n');assert.deepEqual(p.signals,[]);
  await monitor.stop();assert.equal(p.closes,1);assert.equal(monitor.active,false);assert.deepEqual(errors,[]);
  await monitor.start(p,9600);await monitor.stop();assert.equal(p.closes,2);
});
test('stream failure closes the port and is visible to the user',async()=>{
  const p=port(),errors=[];
  const monitor=new SerialMonitor({data:()=>{},error:e=>errors.push(e.message),changed:()=>{}});
  await monitor.start(p);p.controller.error(Error('device unplugged'));await monitor.finished;
  assert.deepEqual(errors,['device unplugged']);assert.equal(p.closes,1);assert.equal(monitor.state,'idle');
});
test('normal USB restart releases EN and does not assert download strap',async()=>{
  const p=port(),waits=[];await restartDevice(p,{delay:async ms=>waits.push(ms)});
  assert.deepEqual(p.signals,[{dataTerminalReady:false,requestToSend:true},{dataTerminalReady:false,requestToSend:false}]);
  assert.deepEqual(waits,[200,200]);
});
test('restart still releases reset if a wait fails and reports the failure',async()=>{
  const p=port();await assert.rejects(restartDevice(p,{delay:async()=>{throw Error('interrupted');}}),/interrupted/);
  assert.equal(p.signals.at(-1).requestToSend,false);
});

test('failed port close blocks a new session until explicit cleanup succeeds',async()=>{
  const p=port(),close=p.close.bind(p);let fail=true;
  p.close=async()=>{if(fail)throw Error('close failed');await close();};
  const monitor=new SerialMonitor({data:()=>{},error:()=>{},changed:()=>{}});
  await monitor.start(p);p.controller.close();await monitor.finished;
  assert.equal(monitor.state,'error');
  await assert.rejects(monitor.start(port()),/先停止/);
  fail=false;await monitor.stop();assert.equal(monitor.state,'idle');assert.equal(p.closes,1);
});

test('a stuck cancellation times out without claiming release or racing a second stop',async()=>{
  const p=port();let finishCancel;
  p.open=async()=>{p.readable=new ReadableStream({cancel:()=>new Promise(resolve=>{finishCancel=resolve;})});};
  const monitor=new SerialMonitor({data:()=>{},error:()=>{},changed:()=>{},stopTimeoutMs:20});
  await monitor.start(p);
  await assert.rejects(monitor.stop(),/尚未释放/);
  assert.equal(monitor.state,'error');
  await assert.rejects(monitor.start(port()),/先停止/);
  const pending=monitor.stopTask;
  const retry=monitor.stop();assert.equal(monitor.stopTask,pending);
  finishCancel();await retry;
  await monitor.start(port());await monitor.stop();
});

test('pause drains data without closing and resume keeps the same port',async()=>{
  const p=port(),text=[];
  const monitor=new SerialMonitor({data:x=>text.push(x),error:()=>{},changed:()=>{}});
  await monitor.start(p);monitor.pause();
  p.controller.enqueue(new TextEncoder().encode('discard'));await tick();
  assert.equal(p.closes,0);assert.equal(monitor.active,true);assert.deepEqual(text,[]);
  monitor.resume();p.controller.enqueue(new TextEncoder().encode('visible'));await tick();
  assert.equal(text.join(''),'visible');await monitor.stop();assert.equal(p.closes,1);
});
