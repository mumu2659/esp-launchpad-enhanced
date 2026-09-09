function deadline(work, ms, message) {
  let timer;
  return Promise.race([work, new Promise((_, reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})])
    .finally(()=>clearTimeout(timer));
}
export async function prepareOffline() {
  if (!navigator.serviceWorker) throw new Error('浏览器不支持离线页面，助手将保持运行。');
  const registration = await navigator.serviceWorker.register('./helper-sw.js', {scope:'./',updateViaCache:'none'});
  const worker = registration.installing || registration.waiting;
  if (worker && worker.state !== 'activated') {
    await deadline(new Promise((resolve,reject)=>{
      const changed=()=>{
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange',changed);
          if(worker.state === 'activated')resolve();
          else reject(new Error('离线页面安装失败，助手将保持运行。'));
        }
      };
      worker.addEventListener('statechange',changed);changed();
    }),15000,'离线页面安装超时，助手将保持运行。');
  }
  await deadline(navigator.serviceWorker.ready,15000,'离线页面准备超时，助手将保持运行。');
  if (!navigator.serviceWorker.controller) {
    await deadline(new Promise(resolve=>{
      const changed=()=>{if(navigator.serviceWorker.controller){navigator.serviceWorker.removeEventListener('controllerchange',changed);resolve();}};
      navigator.serviceWorker.addEventListener('controllerchange',changed);changed();
    }),5000,'离线页面尚未接管，助手将保持运行。');
  }
  // Fetch on the visible page, not during worker installation. The worker
  // only verifies and serves the cache; local-network fetch permissions vary.
  const files=['./','./enhanced/app.js?v=20260909-lifecycle1','./enhanced/core.mjs','./enhanced/handoff.mjs','./enhanced/launcher.mjs','./enhanced/monitor.mjs',
    './enhanced/style.css','./node_modules/esptool-js/bundle.js','./node_modules/js-md5/build/md5.min.js'];
  const urls=files.map(path=>new URL(path,location.href).href);
  const responses=await Promise.all(urls.map(async url=>{
    const response=await fetch(url,{cache:'reload',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('离线资源保存失败，助手将保持运行。');
    return response;
  }));
  const cache=await caches.open('esp-launchpad-helper-shell-v1');
  await Promise.all(urls.map((url,i)=>cache.put(url,responses[i])));
  const channel = new MessageChannel();
  try {
    const result = await deadline(new Promise(resolve=>{
      channel.port1.onmessage=event=>resolve(event.data);
      navigator.serviceWorker.controller.postMessage({type:'CHECK_OFFLINE'},[channel.port2]);
    }),15000,'离线资源保存超时，助手将保持运行。');
    if (!result?.ready) throw new Error(result?.message || '离线资源保存失败');
  } finally { channel.port1.close(); channel.port2.close(); }
}

export function createHandoff({log,status,fetcher=fetch,prepare=prepareOffline,onAccepted=()=>{}}) {
  let completed = false, running = false;
  return {async complete(info, stillConnected) {
    if (completed || running) return;
    running = true;
    try {
      let response;
      try {
        response = await fetcher('./__helper__/session', {
          headers:{'X-Launchpad-Client':'1'},cache:'no-store',signal:AbortSignal.timeout(3000)
        });
      } catch {
        status('网页独立运行；未检测到运行中的助手。'); return;
      }
      if (!response.ok) { status('当前助手不支持自动退出，可继续使用网页。'); return; }
      const session = await response.json();
      if (!session.ready || typeof session.token !== 'string') {
        status('助手尚未完成 USB 释放，本次不请求退出。'); return;
      }
      status('已连接，正在准备网页独立运行…');
      await prepare();
      if (!stillConnected()) {status('连接状态已变化，助手继续运行。');return;}
      response = await fetcher('./__helper__/handoff', {
        method:'POST',headers:{'Content-Type':'application/json','X-Launchpad-Handoff':session.token},
        body:JSON.stringify({chip:info.chip,mac:info.mac,flashId:info.id,offlineReady:true}),
        cache:'no-store',signal:AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error('助手未接受接管确认，将继续运行。');
      const result = await response.json();
      if (!result.accepted) throw new Error('助手未确认接管。');
      completed = true;
      onAccepted();
      log('helper.handoff-accepted');
      status('网页已接管，助手正在自动退出。可继续读取或烧录。');
    } catch (error) {
      log('helper.handoff-error',{message:error.message});
      status(error.message);
    } finally {running=false;}
  }};
}
