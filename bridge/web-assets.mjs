import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
// Built admin UI (web/dist). No side effects on import: server.mjs and the tests share this module.
const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),html='text/html; charset=utf-8';
const types={js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png',woff2:'font/woff2'};
// Unhashed files at fixed paths: the two pages and the theme script they run before first paint (copied from web/public).
const fixed={'/':['index.html',html],'/connect':['connect.html',html],'/theme.js':['theme.js',types.js]};
// Only the fixed files and flat, hashed files under /assets/ with a known extension; anything else (including traversal) is null.
export function staticFile(pathname,root=dist){
 if(Object.hasOwn(fixed,pathname)){const [file,type]=fixed[pathname];return {file:path.join(root,file),type,immutable:false};}
 const m=/^\/assets\/(\w[\w.-]*\.(js|css|svg|png|woff2))$/.exec(pathname);return m?{file:path.join(root,'assets',m[1]),type:types[m[2]],immutable:true}:null;
}
export async function sendStatic(res,{file,type,immutable}){
 let body;try{body=await fs.promises.readFile(file);}catch{
  const code=!immutable&&!fs.existsSync(path.dirname(file))?503:404;res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end(code===503?'前端尚未构建，运行 npm run build':'文件不存在');
 }
 res.writeHead(200,{'Content-Type':type,'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache'});res.end(body);
}
