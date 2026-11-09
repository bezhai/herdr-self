import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function text(v,max=200){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('字段为空或过长');return v.trim();}
export const uuid=()=>crypto.randomUUID();
// Keyed queues: tasks with the same key run one after another; a failed task does not block the next one.
export function enqueue(queues,key,task){
 const run=(queues.get(key)||Promise.resolve()).then(task),tail=run.catch(()=>{});
 queues.set(key,tail);tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});return run;
}
// A path on the Herdr host: absolute or under ~/, without shell metacharacters.
export function hostPath(v,label){const p=text(v,300);if(!/^(~\/|\/)[a-zA-Z0-9_./-]+$/.test(p))throw Error(label+'必须为绝对路径或 ~/ 开头');return p;}
// A machine of Bridge: where its Herdr session runs, which Bridge reaches through the client of the machine (see clients.mjs), and whether
// Bridge uses it: enabled, which the console turns off to stop polling the machine and opening or prompting topics there while its client
// stays connected. The client's token is kept apart (see Clients.issue).
export function normalizeMachine(b){
 const session=text(b.session||'default',80);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(session))throw Error('Herdr session 名称无效');
 return {id:b.id||uuid(),name:text(b.name,60),session,enabled:Boolean(b.enabled)};
}
// Machines of state files from before the clients have a type (local or ssh), an SSH host and port and the path of Herdr there, which the
// client of each machine stands for now. They are dropped at the start of Bridge, in one save with a log line that names a path of Herdr
// other than the default of the client's config, which that config then has to name.
export function migrateMachines(store){
 const old=store.data.machines.filter(m=>['type','host','port','binary'].some(k=>k in m));if(!old.length)return;
 const paths=old.filter(m=>m.binary&&m.binary!=='~/.local/bin/herdr').map(m=>`${m.name} 的 Herdr 在 ${m.binary}`);
 for(const m of old){delete m.type;delete m.host;delete m.port;delete m.binary;}
 store.log('机器连接',`机器改为经客户端连接，去掉了 ${old.map(m=>m.name).join('、')} 的连接方式、地址、端口和 Herdr 路径${paths.length?`；${paths.join('，')}，请写进对应机器客户端配置的 herdr`:''}`);
}
// Herdr reports a failed request as one {"id","error":{"code","message"}} line on stderr and exits non-zero; keep its code.
function failure(text){
 try{const {error}=JSON.parse(text.trim().split('\n').at(-1));if(error?.code)return Object.assign(Error(error.message),{code:error.code});}catch{}
 return Error((text||'远程命令失败').slice(-1000));
}
// What the control plane does on a machine m, each through the client of m with one of its methods (see machine.mjs): call(m,method,params,
// {timeoutMs}) sends the request and resolves to the client's answer (see Clients.call), and rejects with the code client_offline while
// the client of m is offline. A leading ~/ of a path is the home there.
// herdr(m,args,{timeoutMs}) runs the Herdr CLI in the session of m and resolves to the result it prints; one that fails rejects with Herdr's
// error code where it has one. args are strings, or {path} for a path of m (Herdr itself does not expand ~ in --cwd).
// makeDirectory(m,dir) creates dir and its missing parents; an existing directory is fine.
// storeFile(m,root,dir,name,body) writes body as <root>/<dir>/<name> and resolves to the absolute path of the file. root is a directory that
// Bridge owns, a .herdr-bridge directory: it gets a .gitignore of * unless it has one, and its directories other than dir that have not
// changed for 7 days are removed along the way. Directories are created 0700 and the file 0600. The caller removes dir later with
// removeDirectory(m,dir), which removes only such a directory, with what it holds; one that is gone already is fine.
// git(m,cwd,args,{timeoutMs}) runs git in cwd, and nameBranch(m,cwd,prompt,{timeoutMs}) asks claude there for a branch name: each resolves to
// {code, stdout, stderr} whatever the exit status. exists(m,path) resolves to whether path exists.
export function operations(call){
 return {
  async herdr(m,args,options){
   const r=await call(m,'herdr',{session:m.session,args},options);if(r.code!==0)throw failure(r.stderr||r.stdout);
   try{return JSON.parse(r.stdout).result;}catch{throw Error('远程服务未返回有效 JSON');}
  },
  makeDirectory:async(m,dir)=>{await call(m,'mkdir',{path:dir});},
  storeFile:(m,root,dir,name,body)=>call(m,'storeFile',{root,dir,name,body:Buffer.from(body).toString('base64')},{timeoutMs:60000}),
  removeDirectory:async(m,dir)=>{await call(m,'removeDirectory',{path:dir});},
  git:(m,cwd,args,options)=>call(m,'git',{cwd,args},options),
  exists:(m,p)=>call(m,'exists',{path:p}),
  nameBranch:(m,cwd,prompt,options)=>call(m,'nameBranch',{cwd,prompt},options),
 };
}
export function publicText(s){return String(s||'').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]');}
// Bridge's state directory: BRIDGE_STATE of env, else state in the Bridge directory.
export const stateDir=(env=process.env)=>env.BRIDGE_STATE||path.join(path.dirname(fileURLToPath(import.meta.url)),'state');
// Persisted collections. Keys of older state files outside this list are dropped on load; a collection they lack loads empty.
const collections=['machines','apps','bindings','topics','schedules','skills','logs'];
export class Store{
 constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');const saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};this.data=Object.fromEntries(collections.map(k=>[k,saved[k]||[]]));}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 log(kind,message,level='info'){this.data.logs.push({at:Date.now(),kind,message:publicText(message),level});this.data.logs=this.data.logs.slice(-200);this.save();}
}
