import {mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const dist=resolve(root,'dist');
// Fixed allowlist: device dumps, logs, .git, tests and upstream CI never ship.
await rm(dist,{recursive:true,force:true});
const files=['helper-sw.js','enhanced/handoff.mjs','enhanced/launcher.mjs','enhanced/monitor.mjs','enhanced/app.js','enhanced/core.mjs','enhanced/style.css',
  'node_modules/esptool-js/bundle.js','node_modules/esptool-js/LICENSE',
  'node_modules/js-md5/build/md5.min.js','node_modules/js-md5/LICENSE.txt','LICENSE'];
for(const name of files){const to=resolve(dist,name);await mkdir(dirname(to),{recursive:true});await copyFile(resolve(root,name),to);}
let html=await readFile(resolve(root,'enhanced.html'),'utf8');
html=html.replace('href="index.html"','href="https://espressif.github.io/esp-launchpad/"');
html=html.replace('href="dist/downloads/', 'href="downloads/');
await writeFile(resolve(dist,'index.html'),html);
await writeFile(resolve(dist,'.nojekyll'),'');
console.log(`Built ${files.length+2} files in dist/`);
