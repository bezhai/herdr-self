import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {ClientApi,HerdrArg} from './link.ts';
import type {Machine,State,Log} from './state.ts';
import type {HerdrRequest} from './request-cards.ts';
import type {Reply} from './message-cards.ts';
import type {ToolCall} from './cot.ts';
export function text(v:unknown,max=200){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('字段为空或过长');return v.trim();}
export const uuid=()=>crypto.randomUUID();
// Whether v is one of list, for a value that came from outside.
export const oneOf=<const T>(list:readonly T[],v:unknown):v is T=>list.includes(v);
// Whether v is an object other than an array, such as the JSON of a request.
export const isRecord=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
// Keyed queues: tasks with the same key run one after another; a failed task does not block the next one.
export function enqueue<T>(queues:Map<string,Promise<unknown>>,key:string,task:()=>T|Promise<T>){
 const run=(queues.get(key)||Promise.resolve()).then(task),tail=run.catch(()=>{});
 queues.set(key,tail);tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});return run;
}
// A machine of Bridge: where its Herdr session runs, which Bridge reaches through the client of the machine (see clients.ts), and whether
// Bridge uses it: enabled, which the console turns off to stop polling the machine and opening or prompting topics there while its client
// stays connected. The client's token is kept apart (see Clients.issue).
export function normalizeMachine(b:{id?:string,name?:unknown,session?:unknown,enabled?:unknown,[field:string]:unknown}):Machine{
 const session=text(b.session||'default',80);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(session))throw Error('Herdr session 名称无效');
 return {id:b.id||uuid(),name:text(b.name,60),session,enabled:Boolean(b.enabled)};
}
// Machines of state files from before the clients have a type (local or ssh), an SSH host and port and the path of Herdr there, which the
// client of each machine stands for now. They are dropped at the start of Bridge, in one save with a log line that names a path of Herdr
// other than the default of the client's config, which that config then has to name.
export function migrateMachines(store:Store){
 const machines:(Machine&{type?:string,host?:string,port?:number,binary?:string})[]=store.data.machines,old=machines.filter(m=>['type','host','port','binary'].some(k=>k in m));if(!old.length)return;
 const paths=old.filter(m=>m.binary&&m.binary!=='~/.local/bin/herdr').map(m=>`${m.name} 的 Herdr 在 ${m.binary}`);
 for(const m of old){delete m.type;delete m.host;delete m.port;delete m.binary;}
 store.log('机器连接',`机器改为经客户端连接，去掉了 ${old.map(m=>m.name).join('、')} 的连接方式、地址、端口和 Herdr 路径${paths.length?`；${paths.join('，')}，请写进对应机器客户端配置的 herdr`:''}`);
}
// Herdr reports a failed request as one {"id","error":{"code","message"}} line on stderr and exits non-zero; keep its code.
function failure(text:string){
 try{const {error}=JSON.parse(text.trim().split('\n').at(-1)!);if(error?.code)return Object.assign(Error(error.message),{code:error.code});}catch{}
 return Error((text||'远程命令失败').slice(-1000));
}
// What Herdr prints for the commands whose result Bridge reads: an agent of `herdr agent list`, which `herdr api snapshot` lists too, with
// the panes, tabs and workspaces that name them. Herdr versions without replies, requests or tool call records leave out their seq and ids.
export type Agent={pane_id:string,workspace_id:string,tab_id:string,agent?:string,display_agent?:string,name?:string,agent_session?:{value:string},agent_status:string,
 state_change_seq:number,reply_seq?:number,request_ids?:number[],tool_call_seq?:number,remote_answers?:boolean,cwd?:string,foreground_cwd?:string};
export type Snapshot={agents:Agent[],panes:{pane_id:string,label?:string}[],tabs:{tab_id:string,label?:string}[],workspaces:{workspace_id:string,label?:string}[]};
type Opened={workspace:{workspace_id:string},tab:{tab_id:string},root_pane:{pane_id:string}};
// The result of `herdr <args>` by its command; unknown for the commands whose result Bridge does not read.
export type HerdrResult<A>=
 A extends readonly ['agent','list',...unknown[]]?{agents:Agent[]}:
 A extends readonly ['agent','prompt',...unknown[]]?{agent:Agent}:
 A extends readonly ['agent','requests',...unknown[]]?{requests:HerdrRequest[]}:
 A extends readonly ['agent','replies',...unknown[]]?{replies:Reply[]}:
 A extends readonly ['agent','tool-calls',...unknown[]]?{tool_calls:ToolCall[]}:
 A extends readonly ['api','snapshot',...unknown[]]?{snapshot:Snapshot}:
 A extends readonly ['pane','list',...unknown[]]?{panes:object[]}:
 A extends readonly ['workspace','list',...unknown[]]?{workspaces:{workspace_id:string,label:string}[]}:
 A extends readonly ['workspace','create',...unknown[]]?Opened:
 A extends readonly ['tab','create',...unknown[]]?Omit<Opened,'workspace'>:
 A extends readonly ['worktree','create',...unknown[]]?Partial<{[K in keyof Opened]:Partial<Opened[K]>}>:
 A extends readonly ['worktree','list',...unknown[]]?{worktrees?:{path:string,open_workspace_id?:string}[]}:
 unknown;
// What the control plane does on a machine m, each through the client of m with one of its methods (see machine.ts): call(m,method,params,
// {timeoutMs}) sends the request and resolves to the client's answer (see Clients.call), and rejects with the code client_offline while
// the client of m is offline. A leading ~/ of a path is the home there.
// herdr(m,args,{timeoutMs}) runs the Herdr CLI in the session of m and resolves to the result it prints; one that fails rejects with Herdr's
// error code where it has one. args are strings, or {path} for a path of m (Herdr itself does not expand ~ in --cwd).
// storeFile(m,root,dir,name,body) writes body as <root>/<dir>/<name> and resolves to the absolute path of the file. root is a directory that
// Bridge owns, a .herdr-bridge directory: it gets a .gitignore of * unless it has one, and its directories other than dir that have not
// changed for 7 days are removed along the way. Directories are created 0700 and the file 0600. The caller removes dir later with
// removeDirectory(m,dir), which removes only such a directory, with what it holds; one that is gone already is fine.
// askCheapModel(m,cwd,prompt,{timeoutMs}) asks the cheap model in cwd and resolves to {code, stdout, stderr} whatever the exit status.
// inspectDirectory(m,path) resolves to {origin}, the
// URL of the origin remote when path is the root of a Git repository (or of a linked worktree) that has one, else null. prepareWorkspace,
// removeWorkspace, prepareLaunch and describeRepos take the params of their ClientApi entry (see link.ts, where their semantics are).
type Options={timeoutMs?:number};
export type Call=<K extends keyof ClientApi>(m:Machine,method:K,params:ClientApi[K]['params'],options?:Options)=>Promise<ClientApi[K]['result']>;
export type Herdr=<const A extends readonly HerdrArg[]>(m:Machine,args:A,options?:Options)=>Promise<HerdrResult<A>>;
export type Operations=ReturnType<typeof operations>;
export function operations(call:Call){
 return {
  async herdr<const A extends readonly HerdrArg[]>(m:Machine,args:A,options?:Options):Promise<HerdrResult<A>>{
   const r=await call(m,'herdr',{session:m.session,args},options);if(r.code!==0)throw failure(r.stderr||r.stdout);
   try{return JSON.parse(r.stdout).result;}catch{throw Error('远程服务未返回有效 JSON');}
  },
  storeFile:(m:Machine,root:string,dir:string,name:string,body:Uint8Array)=>call(m,'storeFile',{root,dir,name,body:Buffer.from(body).toString('base64')},{timeoutMs:60000}),
  removeDirectory:async(m:Machine,dir:string)=>{await call(m,'removeDirectory',{path:dir});},
  askCheapModel:(m:Machine,cwd:string,prompt:string,options?:Options)=>call(m,'askCheapModel',{cwd,prompt},options),
  inspectDirectory:(m:Machine,p:string,options?:Options)=>call(m,'inspectDirectory',{path:p},options),
  prepareWorkspace:(m:Machine,params:ClientApi['prepareWorkspace']['params'],options?:Options)=>call(m,'prepareWorkspace',params,options),
  removeWorkspace:(m:Machine,params:ClientApi['removeWorkspace']['params'],options?:Options)=>call(m,'removeWorkspace',params,options),
  prepareLaunch:(m:Machine,params:ClientApi['prepareLaunch']['params'],options?:Options)=>call(m,'prepareLaunch',params,options),
  describeRepos:(m:Machine,params:ClientApi['describeRepos']['params'],options?:Options)=>call(m,'describeRepos',params,options),
 };
}
// The text without what must not reach a log or the console: the value of a setting that names a secret, and the password in the address of a
// repository (https://user:password@host/...).
export function publicText(s:unknown){
 return String(s||'').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]').replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/gi,'$1[已隐藏]@');
}
// Bridge's state directory: BRIDGE_STATE of env, else state in the Bridge directory.
export const stateDir=(env=process.env)=>env.BRIDGE_STATE||path.join(path.dirname(fileURLToPath(import.meta.url)),'state');
// Persisted collections. Keys of older state files outside this list are dropped on load; a collection they lack loads empty. The file
// is Bridge's own: what it holds is taken for the collections as Bridge wrote them.
const collections=['machines','apps','projects','agentConfigs','bindings','topics','schedules','skills','logs'] as const satisfies (keyof State)[];
export class Store{
 declare dir:string;declare file:string;declare data:State;
 constructor(dir:string){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');const saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{};this.data=Object.fromEntries(collections.map(k=>[k,saved[k]||[]])) as unknown as State;if(typeof saved.lastAgentConfigId==='string')this.data.lastAgentConfigId=saved.lastAgentConfigId;}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 log(kind:string,message:string,level:Log['level']='info'){this.data.logs.push({at:Date.now(),kind,message:publicText(message),level});this.data.logs=this.data.logs.slice(-200);this.save();}
}
