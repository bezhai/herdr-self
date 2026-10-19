import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
export const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
export function text(v,max=200){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('字段为空或过长');return v.trim();}
export const uuid=()=>crypto.randomUUID();
// A path on the Herdr host: absolute or under ~/, without shell metacharacters.
export function hostPath(v,label){const p=text(v,300);if(!/^(~\/|\/)[a-zA-Z0-9_./-]+$/.test(p))throw Error(label+'必须为绝对路径或 ~/ 开头');return p;}
export function normalizeMachine(b){
 const type=b.type==='local'?'local':'ssh',host=type==='ssh'?text(b.host):'';
 if(host&&!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/.test(host))throw Error('SSH 地址格式无效，可填写 SSH 别名或 user@host');
 const session=text(b.session||'default',80);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(session))throw Error('Herdr session 名称无效');
 const port=Number(b.port||22);if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
 const binary=hostPath(b.binary||'~/.local/bin/herdr','Herdr 路径');
 return {id:b.id||uuid(),name:text(b.name,60),type,host,session,port,binary,enabled:Boolean(b.enabled)};
}
// A path on this machine: a leading ~/ is its home.
const localPath=p=>p.replace(/^~\//,os.homedir()+'/');
// argv[0] is the program, argv[1..] its arguments. Each is a string passed verbatim, or {path} for a path on machine m whose
// leading ~/ expands to that machine's home. Herdr itself does not expand ~ in --cwd.
export function remoteInvocation(m,argv){
 const shellPath=p=>p.startsWith('~/')?'"$HOME"/'+quote(p.slice(2)):quote(p);
 const command=argv.map(a=>typeof a==='string'?quote(a):shellPath(a.path)).join(' ');
 if(m.type==='ssh')return ['ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=7','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-p',String(m.port),'--',m.host,'env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c '+quote(command)]];
 const [program,...args]=argv.map(a=>typeof a==='string'?a:localPath(a.path));return [program,args];
}
// Herdr reports a failed request as one {"id","error":{"code","message"}} line on stderr and exits non-zero; keep its code.
function failure(text){
 try{const {error}=JSON.parse(text.trim().split('\n').at(-1));if(error?.code)return Object.assign(Error(error.message),{code:error.code});}catch{}
 return Error((text||'远程命令失败').slice(-1000));
}
// Runs argv (see remoteInvocation) on machine m and resolves to its stdout. input, when given, is its stdin, which is closed otherwise.
function run(m,argv,{timeoutMs=12000,input}={}){
 const [bin,args]=remoteInvocation(m,argv),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('HERDR_'))delete env[k];
 return new Promise((resolve,reject)=>{const p=spawn(bin,args,{env,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('连接超时，请检查 SSH 与 Herdr 状态'));},timeoutMs);p.stdout.on('data',d=>{out+=d;if(out.length>4e6){p.kill('SIGKILL');reject(Error('响应过大'));}});p.stderr.on('data',d=>{err=(err+d).slice(-2000);});p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(failure(err||out));resolve(out);});p.stdin.on('error',()=>{});p.stdin.end(input);});
}
export async function herdr(m,args,options){
 const out=await run(m,[{path:m.binary},'--session',m.session,...args],options);
 try{return JSON.parse(out).result;}catch{throw Error('远程服务未返回有效 JSON');}
}
// Creates dir and its missing parents on machine m; a leading ~/ is that machine's home. An existing directory is fine.
export async function makeDirectory(m,dir){await run(m,['mkdir','-p','--',{path:dir}]);}
// Directories of a root of storeFile are removed once they have not changed for this long.
const staleMinutes=7*24*60;
// What storeFile runs on an SSH machine, with the root, the directory and the name as $1, $2 and $3, and the content on stdin: under
// umask 077 the directories it creates are 0700 and the files 0600. A clean-up that fails does not fail the write; a write that fails
// leaves no file. Prints the path of the file, where the remote shell has already expanded the root's ~/.
const storeScript=`umask 077 && mkdir -p -- "$1/$2" && { [ -e "$1/.gitignore" ] || printf '*\\n' > "$1/.gitignore"; } && { find "$1" -mindepth 1 -maxdepth 1 -type d ! -name "$2" -mmin +${staleMinutes} -exec rm -rf -- {} + 2>/dev/null; cat > "$1/$2/$3" || { rm -f -- "$1/$2/$3"; exit 1; }; } && printf '%s' "$1/$2/$3"`;
// Writes body as <root>/<dir>/<name> on machine m and resolves to the absolute path of the file; a leading ~/ of root is that machine's
// home. root is a directory that Bridge owns: it gets a .gitignore of * unless it has one, and its directories other than dir that have not
// changed for 7 days are removed along the way. Directories are created 0700 and the file 0600. A local machine writes directly; an SSH
// machine runs one remote command that takes the content on stdin, never on its command line. What it prints must be such a path: the
// caller removes its directory later (see removeDirectory).
export async function storeFile(m,root,dir,name,body){
 if(m.type==='ssh'){
  const file=await run(m,['sh','-c',storeScript,'sh',{path:root},dir,name],{input:body,timeoutMs:60000});
  if(!file.startsWith('/')||!file.endsWith(`/${dir}/${name}`)||file.includes('\n'))throw Error('远程命令未返回文件路径');return file;
 }
 const base=path.resolve(localPath(root)),folder=path.join(base,dir),file=path.join(folder,name);
 await fs.promises.mkdir(folder,{recursive:true,mode:0o700});
 await fs.promises.writeFile(path.join(base,'.gitignore'),'*\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 await sweep(base,dir).catch(()=>{});
 await fs.promises.writeFile(file,body,{mode:0o600});return file;
}
// Removes the directories of root other than keep that have not changed for staleMinutes, with what they hold.
async function sweep(root,keep){
 const before=Date.now()-staleMinutes*60000;
 for(const e of await fs.promises.readdir(root,{withFileTypes:true}))if(e.isDirectory()&&e.name!==keep){
  const p=path.join(root,e.name);if((await fs.promises.stat(p)).mtimeMs<before)await fs.promises.rm(p,{recursive:true,force:true});
 }
}
// Removes dir with what it holds on machine m; a leading ~/ is that machine's home. A directory that is gone already is fine.
export async function removeDirectory(m,dir){
 if(m.type==='ssh')await run(m,['rm','-rf','--',{path:dir}]);
 else await fs.promises.rm(path.resolve(localPath(dir)),{recursive:true,force:true});
}
export function publicText(s){return String(s||'').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]');}
// Persisted collections. Keys of older state files outside this list are dropped on load.
const collections=['machines','apps','bindings','topics','logs'];
export class Store{
 constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');const saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};this.data=Object.fromEntries(collections.map(k=>[k,saved[k]||[]]));}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 log(kind,message,level='info'){this.data.logs.push({at:Date.now(),kind,message:publicText(message),level});this.data.logs=this.data.logs.slice(-200);this.save();}
}
