import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandoff} from './handoff.mjs';
const info={chip:'ESP32-C6',mac:'11:22:33:44:55:66',id:0x174020};
const response=value=>({ok:true,json:async()=>value});
test('handoff waits for offline readiness and sends verified chip info once',async()=>{
  const order=[];let body;
  const handoff=createHandoff({log:()=>{},status:()=>{},onAccepted:()=>order.push('accepted'),prepare:async()=>order.push('offline'),
    fetcher:async(url,options)=>{if(url.endsWith('/session')){order.push('session');return response({ready:true,token:'session-token'});}
      order.push('ack');body=JSON.parse(options.body);return response({accepted:true});}});
  await handoff.complete(info,()=>true);await handoff.complete(info,()=>true);
  assert.deepEqual(order,['session','offline','ack','accepted']);
  assert.deepEqual(body,{chip:info.chip,mac:info.mac,flashId:info.id,offlineReady:true});
});
for(const condition of ['offline-failure','connection-lost']){
  test(`handoff does not stop helper after ${condition}`,async()=>{
    let requests=0;
    const handoff=createHandoff({log:()=>{},status:()=>{},
      prepare:async()=>{if(condition==='offline-failure')throw Error('cache denied');},
      fetcher:async()=>{requests++;return response({ready:true,token:'token'});}});
    await handoff.complete(info,()=>condition!=='connection-lost');
    assert.equal(requests,1);
  });
}
test('missing helper is tolerated when reopening the offline page',async()=>{
  let prepared=false;
  const handoff=createHandoff({log:()=>{},status:()=>{},prepare:async()=>{prepared=true;},fetcher:async()=>{throw Error('offline');}});
  await handoff.complete(info,()=>true);assert.equal(prepared,false);
});
