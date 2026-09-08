import http from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(fileURLToPath(new URL('.',import.meta.url)), process.env.SITE_ROOT || '.');
const prefix = process.env.BASE_PATH || '/';
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.toml':'text/plain'};
http.createServer(async(req,res)=>{
  try {
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
    let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(!name.startsWith(prefix))throw Error('Unknown prefix');
    name='/'+name.slice(prefix.length);
    if(name==='/')name=process.env.SITE_ROOT?'/index.html':'/enhanced.html';
    if(name.split('/').some(x=>x.startsWith('.')))throw Error('Private path');
    const path=await realpath(resolve(root,'.'+name));
    if(!path.startsWith(root.endsWith(sep)?root:root+sep))throw Error('Outside root');
    const body=await readFile(path);
    res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log(`ESP Launchpad Enhanced: http://localhost:${process.env.PORT||4173}`));
