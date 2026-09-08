// Cache only the application shell; never cache helper credentials or device data.
const CACHE = 'esp-launchpad-helper-shell-v1';
const BASE = new URL('./', self.location.href);
const FILES = ['./', './enhanced/app.js', './enhanced/core.mjs', './enhanced/handoff.mjs','./enhanced/launcher.mjs','./enhanced/monitor.mjs',
  './enhanced/style.css', './node_modules/esptool-js/bundle.js', './node_modules/js-md5/build/md5.min.js'];
const URLS = FILES.map(path => new URL(path, BASE).href);
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_OFFLINE' || !event.ports[0]) return;
  event.waitUntil((async()=>{
    const cache = await caches.open(CACHE);
    const entries = await Promise.all(URLS.map(url=>cache.match(url)));
    event.ports[0].postMessage({ready:entries.every(Boolean)});
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || request.cache === 'reload') return;
  // Control requests deliberately go directly to the live native helper.
  if (url.pathname.includes('/__helper__/')) return;
  const navigation = request.mode === 'navigate' && [BASE.pathname, BASE.pathname+'index.html'].includes(url.pathname);
  const key = navigation ? BASE.href : url.href;
  if (!URLS.includes(key)) return;
  event.respondWith((async()=>{
    try {
      const response = await fetch(request, {signal:AbortSignal.timeout(1500)});
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(key, response.clone());
        return response;
      }
      return (await caches.match(key, {cacheName:CACHE})) || response;
    } catch (error) {
      const response = await caches.match(key, {cacheName:CACHE});
      if (response) return response;
      throw error;
    }
  })());
});
