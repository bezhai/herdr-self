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
// Arguments are strings passed verbatim, or {path} for a path on the Herdr host whose leading ~/ expands to that host's home.
// Herdr itself does not expand ~ in --cwd.
export function remoteInvocation(m,args){
 const shellPath=p=>p.startsWith('~/')?'"$HOME"/'+quote(p.slice(2)):quote(p),localPath=p=>p.replace(/^~\//,os.homedir()+'/');
 const command=[shellPath(m.binary),...args.map(a=>typeof a==='string'?quote(a):shellPath(a.path))].join(' ');
 if(m.type==='ssh')return ['ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=7','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-p',String(m.port),'--',m.host,'env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c '+quote(command)]];
 return [localPath(m.binary),args.map(a=>typeof a==='string'?a:localPath(a.path))];
}
// Herdr reports a failed request as one {"id","error":{"code","message"}} line on stderr and exits non-zero; keep its code.
function failure(text){
 try{const {error}=JSON.parse(text.trim().split('\n').at(-1));if(error?.code)return Object.assign(Error(error.message),{code:error.code});}catch{}
 return Error((text||'远程命令失败').slice(-1000));
}
export function execute(m,args,{timeoutMs=12000}={}){
 const [bin,argv]=remoteInvocation(m,args),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('HERDR_'))delete env[k];
 return new Promise((resolve,reject)=>{const p=spawn(bin,argv,{env,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('连接超时，请检查 SSH 与 Herdr 状态'));},timeoutMs);p.stdout.on('data',d=>{out+=d;if(out.length>4e6){p.kill('SIGKILL');reject(Error('响应过大'));}});p.stderr.on('data',d=>{err=(err+d).slice(-2000);});p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(failure(err||out));try{resolve(JSON.parse(out));}catch{reject(Error('远程服务未返回有效 JSON'));}});p.stdin.on('error',()=>{});p.stdin.end();});
}
export async function herdr(m,args,options){return (await execute(m,['--session',m.session,...args],options)).result;}
export function publicText(s){return String(s||'').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]');}
// Persisted collections. Keys of older state files outside this list are dropped on load.
const collections=['machines','apps','bindings','topics','logs'];
export class Store{
 constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');const saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};this.data=Object.fromEntries(collections.map(k=>[k,saved[k]||[]]));}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 log(kind,message,level='info'){this.data.logs.push({at:Date.now(),kind,message:publicText(message),level});this.data.logs=this.data.logs.slice(-200);this.save();}
}
