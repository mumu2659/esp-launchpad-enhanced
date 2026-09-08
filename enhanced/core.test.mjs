import test from 'node:test';
import assert from 'node:assert/strict';
import {Connection,makeUsbReset,validateImages,patchC6,findAuthorizedPort} from './core.mjs';

test('failed port is closed before reopen; ready only after successful handshake',async()=>{
  const order=[];let n=0;
  const c=new Connection({visible:()=>true,log(){},changed:s=>order.push(s),delay:async()=>{},
    create:p=>({port:p,n:++n,async start(){order.push('start'+this.n);if(this.n===1)throw new Error('disconnect');return 'chip';}}),
    close:async s=>order.push('close'+s.n)});
  assert.equal(await c.connect('same-port'),'chip');
  assert.deepEqual(order,['connecting','start1','close1','start2','ready']);
});
test('all attempts fail: state and session restored so user can retry',async()=>{
  let fail=true;
  const c=new Connection({visible:()=>true,log(){},changed(){},delay:async()=>{},attempts:2,
    create:()=>({async start(){if(fail)throw Error('offline');return 'ok';}}),close:async()=>{}});
  await assert.rejects(c.connect({}),/offline/);assert.equal(c.state,'idle');assert.equal(c.session,null);
  fail=false;assert.equal(await c.connect({}),'ok');
});
test('background page cannot open a port',async()=>{
  let calls=0;const c=new Connection({visible:()=>false,log(){},changed(){},create:()=>calls++,close:async()=>{}});
  await assert.rejects(c.connect({}),/前台/);assert.equal(calls,0);
});
test('cancel during handshake cleans up and never marks ready',async()=>{
  let c;let closed=false;
  c=new Connection({visible:()=>true,log(){},changed(){},create:()=>({async start(){c.cancel();return 'ok';}}),close:async()=>{closed=true;}});
  await assert.rejects(c.connect({}),/取消/);assert.equal(c.state,'idle');assert.ok(closed);
});
test('cleanup failure prevents unsafe concurrent reopen',async()=>{
  let count=0;
  const c=new Connection({visible:()=>true,log(){},changed(){},create:()=>{count++;return {async start(){throw Error('lost');}}},close:async()=>{throw Error('locked');}});
  await assert.rejects(c.connect({}),/清理失败/);assert.equal(count,1);assert.equal(c.state,'error');
});
test('100 ms timer delayed to 1 second aborts before next reset signal',async()=>{
  const signals=[];let now=0;
  const reset=makeUsbReset({setRTS:async v=>signals.push(['R',v]),setDTR:async v=>signals.push(['D',v])},
    {visible:()=>true,log(){},now:()=>now,delay:async()=>{now+=1000;}});
  await assert.rejects(reset.reset(),/延迟/);assert.deepEqual(signals,[['R',false],['D',false]]);
});
test('sector overlap and capacity overflow are rejected before flashing',()=>{
  const data=new Uint8Array(4097);
  assert.throws(()=>validateImages([{address:0,data},{address:4096,data}],16384),/重叠/);
  assert.throws(()=>validateImages([{address:4096,data}],8192),/超出/);
  assert.throws(()=>validateImages([{address:1,data}],8192),/对齐/);
  assert.equal(validateImages([{address:0,data}],8192).length,1);
});
test('C6 compatibility fix does not change other chip families',()=>{
  const chip={CHIP_NAME:'ESP32-C6',SPI_REG_BASE:0x60002000};assert.ok(patchC6(chip));assert.equal(chip.SPI_REG_BASE,0x60003000);
  const other={CHIP_NAME:'ESP32-S3',SPI_REG_BASE:123};assert.equal(patchC6(other),false);assert.equal(other.SPI_REG_BASE,123);
});


test('authorized USB reconnect waits through disappearance without a chooser',async()=>{
  const p={};let count=0;
  assert.equal(await findAuthorizedPort({getPorts:async()=>++count<3?[]:[p],matches:()=>true,delay:async()=>{}}),p);
  assert.equal(count,3);
});
test('multiple authorized devices require explicit selection',async()=>{
  await assert.rejects(findAuthorizedPort({getPorts:async()=>[{},{}],matches:()=>true}),/多个/);
});
test('authorized reconnect never switches from preferred port to another board',async()=>{
  await assert.rejects(findAuthorizedPort({getPorts:async()=>[{}],preferred:{},matches:()=>true,rounds:2,delay:async()=>{}}),/未找到/);
});
test('authorized discovery can be cancelled before opening any port',async()=>{
  let called=false;
  await assert.rejects(findAuthorizedPort({getPorts:async()=>{called=true;return [];},matches:()=>true,cancelled:()=>true}),/取消/);
  assert.equal(called,false);
});


test('fresh authorized port object replaces stale object only when enabled',async()=>{
  const fresh={};assert.equal(await findAuthorizedPort({getPorts:async()=>[fresh],preferred:{},matches:()=>true,allowReplacement:true}),fresh);
});
test('recovery resolves fresh object and escalates from no-reset to USB reset',async()=>{
  const ports=[{},{}],seen=[];let n=0;
  const c=new Connection({visible:()=>true,log(){},changed(){},delay:async()=>{},close:async()=>{},resolvePort:async()=>ports[n++],
    create:p=>({async start(mode){seen.push([p,mode]);if(seen.length===1)throw Error('lost');return 'ok';}})});
  await c.connect(ports[0],['no_reset','usb_reset']);assert.deepEqual(seen,[[ports[0],'no_reset'],[ports[1],'usb_reset']]);
});
test('identity mismatch stops retries',async()=>{
  let calls=0;const c=new Connection({visible:()=>true,log(){},changed(){},close:async()=>{},
    create:()=>({async start(){calls++;const e=Error('wrong board');e.name='DeviceMismatchError';throw e;}})});
  await assert.rejects(c.connect({}),/wrong board/);assert.equal(calls,1);
});
