import test from 'node:test';
import assert from 'node:assert/strict';
import {createLauncher,RECOVERY_URL} from './launcher.mjs';
test('checking helper never launches an app; explicit launch uses a fixed URL',async()=>{
  const urls=[];let message='';
  const launcher=createLauncher({fetcher:async()=>{throw Error('offline');},navigate:url=>urls.push(url),status:text=>{message=text;}});
  assert.equal(await launcher.refresh(),'offline');assert.deepEqual(urls,[]);
  launcher.launch();assert.deepEqual(urls,[RECOVERY_URL]);assert.match(message,/启动脚本一次/);
});
test('helper liveness distinguishes recovery from released USB and rejects unknown services',async()=>{
  let payload={ready:false,token:'private'};
  const launcher=createLauncher({fetcher:async()=>({ok:true,json:async()=>payload}),status:()=>{}});
  assert.equal(await launcher.refresh(),'busy');
  payload.ready=true;assert.equal(await launcher.refresh(),'ready');
  payload={ready:true};assert.equal(await launcher.refresh(),'offline');
});

test('handoff invalidation cannot be undone by an older status response',async()=>{
  let respond;
  const launcher=createLauncher({fetcher:()=>new Promise(resolve=>{respond=resolve;}),status:()=>{}});
  const pending=launcher.refresh();launcher.invalidate();
  respond({ok:true,json:async()=>({ready:true,token:'old'})});
  await pending;assert.equal(launcher.state,'offline');
});
