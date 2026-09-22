import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
export const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
export function text(v,max=200){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('字段为空或过长');return v.trim();}
export const uuid=()=>crypto.randomUUID();
export function normalizeMachine(b){
 const type=b.type==='local'?'local':'ssh',host=type==='ssh'?text(b.host):'';
 if(host&&!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/.test(host))throw Error('SSH 地址格式无效，可填写 SSH 别名或 user@host');
 const session=text(b.session||'default',80);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(session))throw Error('Herdr session 名称无效');
 const port=Number(b.port||22);if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
 const binary=text(b.binary||'~/.local/bin/herdr',300);if(!/^(~\/|\/)[a-zA-Z0-9_./-]+$/.test(binary))throw Error('Herdr 路径必须为绝对路径或 ~/ 开头');
 return {id:b.id||uuid(),name:text(b.name,60),type,host,session,port,binary,enabled:Boolean(b.enabled)};
}
export function remoteInvocation(m,program,args){
 const expand=p=>p.startsWith('~/')?'"$HOME"/'+quote(p.slice(2)):quote(p);
 const command=(program==='herdr'?expand(m.binary):quote(program))+' '+args.map(quote).join(' ');
 if(m.type==='ssh')return ['ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=7','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-p',String(m.port),'--',m.host,'env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c '+quote(command)]];
 return [program==='herdr'?m.binary.replace(/^~\//,os.homedir()+'/'):program,args];
}
export function execute(m,program,args,input=''){
 const [bin,argv]=remoteInvocation(m,program,args),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('HERDR_'))delete env[k];
 return new Promise((resolve,reject)=>{const p=spawn(bin,argv,{env,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('连接超时，请检查 SSH 与 Herdr 状态'));},12000);p.stdout.on('data',d=>{out+=d;if(out.length>4e6){p.kill('SIGKILL');reject(Error('响应过大'));}});p.stderr.on('data',d=>{err=(err+d).slice(-2000);});p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error((err||out||'远程命令失败').slice(-1000)));try{resolve(JSON.parse(out));}catch{reject(Error('远程服务未返回有效 JSON'));}});p.stdin.on('error',()=>{});p.stdin.end(input);});
}
export async function herdr(m,...args){const d=await execute(m,'herdr',['--session',m.session,...args]);if(d.error)throw Error(d.error.message);return d.result;}
export async function helper(m,mode,id,body){const script='import os,sys; os.execvp("python3",["python3",os.path.expanduser("~/.local/share/herdr-bridge/remote.py"),*sys.argv[1:]])';const d=await execute(m,'python3',['-c',script,mode,...(id?[id]:[])],body?JSON.stringify(body):'');if(d.error)throw Error(d.error);return d;}
export async function installHelper(m,source){return execute(m,'python3',['-c',`import pathlib,sys,json,os
p=pathlib.Path.home()/'.local/share/herdr-bridge';p.mkdir(parents=True,exist_ok=True,mode=0o700)
f=p/'remote.py';f.write_text(sys.stdin.read());f.chmod(0o700)
b=pathlib.Path.home()/'.local/bin';b.mkdir(parents=True,exist_ok=True)
w=b/'herdr-bridge-claude'
if w.exists() and 'herdr-bridge/remote.py' not in w.read_text(): raise RuntimeError('已有同名文件，未覆盖')
w.write_text('#!/bin/sh\\nexec python3 "$HOME/.local/share/herdr-bridge/remote.py" claude "$@"\\n');w.chmod(0o700)
print(json.dumps({'installed':True,'command':'~/.local/bin/herdr-bridge-claude'}))`],source);}
export function targetAgent(machine,agents,adapter){return agents.find(a=>a.pane_id===adapter.paneId&&a.agent==='claude'&&Boolean(adapter.nativeId)&&a.agent_session?.value===adapter.nativeId);}
export function publicText(s){return String(s||'').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]');}
export class Store{
 constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{machines:[],apps:[],bindings:[],inbox:[],outbox:[],logs:[]};}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 log(kind,message,level='info'){this.data.logs.push({at:Date.now(),kind,message:publicText(message),level});this.data.logs=this.data.logs.slice(-200);this.save();}
}
