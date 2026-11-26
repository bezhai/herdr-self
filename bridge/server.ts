import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {Store,normalizeMachine,migrateMachines,operations,publicText,stateDir,enqueue,isRecord} from './core.ts';
import {Platforms,normalizeApp,changeBinding,bindingTarget} from './platform.ts';
import {modelFrom} from './model.ts';
import {saveProject,removeProject,fillDescription} from './projects.ts';
import {saveAgentConfig,removeAgentConfig} from './agent-configs.ts';
import {ChatBindings} from './chat-bindings.ts';
import {Registrations} from './registration.ts';
import {migrateBindings,convertAdopted} from './migration.ts';
import {Topics} from './topics.ts';
import {Skills,requestLimit} from './skills.ts';
import {Schedules} from './schedules.ts';
import {ApiTopics} from './api-topics.ts';
import {ApiDigests} from './api-digests.ts';
import {Messages,ownerSink,sinkName} from './messages.ts';import {Outbox} from './outbox.ts';
import {Tasks} from './task-core.ts';
import {threadSink,threadSinkName} from './thread-sink.ts';
import {AgentSchedules} from './agent-schedules.ts';
import {AgentTasks} from './agent-tasks.ts';
import {ServiceCalls} from './service-calls.ts';
import {staticFile,sendStatic} from './web-assets.ts';
import {Clients} from './clients.ts';
import {configText,consoleUrl} from './client.ts';
import type {Call} from './core.ts';
import type {Machine,Topic} from './state.ts';
import type {Policy} from './task-types.ts';
import type {HerdrStatus,ConsoleState} from './console-state.ts';
const bridgeUrl=consoleUrl(process.env.BRIDGE_URL),dir=stateDir(),store=new Store(dir),live=new Map<string,HerdrStatus>(),refreshes=new Map<string,Promise<void>>();
// auth and attempts are looked up also for a request without a session cookie, or without a remote address once its socket closed.
const keyfile=path.join(dir,'access-key');if(!fs.existsSync(keyfile))fs.writeFileSync(keyfile,crypto.randomBytes(24).toString('base64url'),{mode:0o600});const key=fs.readFileSync(keyfile,'utf8').trim(),auth=new Map<string|undefined,number>(),attempts=new Map<string|undefined,{at:number,n:number}>();
migrateMachines(store);migrateBindings(store);
// What Bridge does on a machine goes through the client of the machine (see operations and Clients.call).
const askModel=modelFrom(process.env),call:Call=(...args)=>clients.call(...args),ops=operations(call),skills=new Skills(store,call);
function machine(id:unknown){const m=store.data.machines.find(x=>x.id===id);if(!m)throw Error('机器连接不存在');return m;}
function binding(id:unknown){const b=store.data.bindings.find(x=>x.id===id);if(!b)throw Error('会话绑定不存在');return b;}
// The Herdr status of machine m for the console: disabled, offline while its client is not in, else what the latest poll through the client
// found (see refresh), connecting until the first one.
function herdrStatus(m:Machine):HerdrStatus{
 if(!m.enabled)return {state:'disabled',agents:[],panes:[]};if(!clients.online(m.id))return {state:'offline',agents:[],panes:[]};
 return live.get(m.id)||{state:'connecting',agents:[],panes:[]};
}
async function refresh(m:Machine){if(refreshes.has(m.id))return refreshes.get(m.id);const p=(async()=>{const previous=live.get(m.id);live.set(m.id,{agents:[],panes:[],...previous,state:previous?.state==='connected'?'connected':'connecting'});try{
 const [agentResult,paneResult]=await Promise.all([ops.herdr(m,['agent','list']),ops.herdr(m,['pane','list'])]);
 const agents=agentResult.agents||[];live.set(m.id,{state:'connected',checkedAt:Date.now(),agents,panes:paneResult.panes||[]});if(previous?.state!=='connected')store.log('机器连接',m.name+' 已连接');
 // Topic agents' new replies and requests go back to Feishu; this does not wait for them and never throws.
 topics.sync(m,agents);
 }catch(e){live.set(m.id,{state:'error',checkedAt:Date.now(),error:publicText(e.message),agents:[],panes:[]});if(previous?.error!==e.message)store.log('机器连接',m.name+'：'+e.message,'error');}finally{refreshes.delete(m.id);}})();refreshes.set(m.id,p);return p;}
// The owner's channel is open-lark on the machine that BRIDGE_OPEN_LARK_MACHINE names, whose client has it in its config (see open-lark.ts).
const ownerMachine=process.env.BRIDGE_OPEN_LARK_MACHINE,owner=()=>store.data.machines.find(m=>m.name===ownerMachine)||null;
// The images and files of drafts, in outbox of the state directory, until the owner sent them or did not (see outbox.ts).
const outbox=new Outbox(path.join(dir,'outbox'));
// The task core, in tasks.db of the state directory. Its only sink sends as the owner, and what goes there needs the owner's approval; every
// other delivery and every end goes ahead.
const taskPolicy:Policy={deliver:(_task,_output,target)=>'sink' in target&&target.sink===sinkName?'approve':'allow',end:()=>'allow'};
const tasks=new Tasks(path.join(dir,'tasks.db'),{sinks:{[sinkName]:ownerSink({owner,call,outbox}),[threadSinkName]:threadSink({store,app:id=>platforms.app(id),reply:(...args)=>platforms.reply(...args)})},policy:taskPolicy,now:Date.now});
const topics=new Topics(store,{...ops,tasks,askModel,placeSkills:(...args)=>skills.place(...args),download:(...args)=>platforms.download(...args),machine,app:id=>platforms.app(id),reply:(...args)=>platforms.reply(...args),updateCard:(...args)=>platforms.updateCard(...args),react:(...args)=>platforms.react(...args),unreact:(...args)=>platforms.unreact(...args),request:(...args)=>platforms.request(...args)}),chatBindings=new ChatBindings(store,{reply:(...args)=>platforms.reply(...args),updateCard:(...args)=>platforms.updateCard(...args),chatName:(...args)=>platforms.chatName(...args),askModel,handle:(...args)=>topics.handle(...args)});
const platforms=new Platforms(store,{onMessage:(...args)=>topics.handle(...args),onUnbound:(...args)=>chatBindings.open(...args),onCardAction:(a,evt)=>(evt.action?.value?.bind?chatBindings:evt.action?.value?.schedule?agentSchedules:evt.action?.value?.draft?messages:topics).click(a,evt)}),registrations=new Registrations(store,{connect:async a=>{
 if(!a.allowedUsers.length)return false;
 if(!a.enabled||platforms.status(a).connection!=='connected'){await platforms.start(a);a.enabled=true;store.save();}
 for(let i=0;i<20;i++){if(platforms.status(a).connection==='connected')return true;await new Promise(r=>setTimeout(r,750));}
 throw Error('connection_timeout');
}});
// Its first check comes one interval after the start, once the apps have had time to connect.
const schedules=new Schedules(store,{topics,app:id=>platforms.app(id),send:(...args)=>platforms.send(...args),reply:(...args)=>platforms.reply(...args)});
const apiTopics=new ApiTopics(store,{topics,send:(...args)=>platforms.send(...args),chatName:(...args)=>platforms.chatName(...args)}),apiDigests=new ApiDigests(store,{topics,tasks});
const messages=new Messages(store,{tasks,topics,app:id=>platforms.app(id),owner,call,reply:(...args)=>platforms.reply(...args),updateCard:(...args)=>platforms.updateCard(...args),outbox});
const agentTasks=new AgentTasks(store,{topics,tasks,app:id=>platforms.app(id)});
const agentSchedules=new AgentSchedules(store,{topics,schedules,app:id=>platforms.app(id),reply:(...args)=>platforms.reply(...args),updateCard:(...args)=>platforms.updateCard(...args)});
function state():ConsoleState{return {host:os.hostname(),version:'0.1.0',registration:registrations.status(),machines:store.data.machines.map(({tokenHash,...m})=>({...m,hasToken:Boolean(tokenHash),client:clients.status(m.id),...herdrStatus(m)})),apps:store.data.apps.map(a=>platforms.status(a)),projects:store.data.projects.map(({adopted,...p})=>({...p,adopted:Boolean(adopted)})),agentConfigs:store.data.agentConfigs,bindings:store.data.bindings.map(({workspaces,...b})=>b),skills:skills.list(),topics:store.data.topics.map(({messageIds,task,reactions,cards,cot,proposal,taskId,deliveryCards,sources,drafts,digests,...t}:Topic&{sources?:unknown,drafts?:unknown})=>t),logs:store.data.logs.slice(-60)};}
// Whether the Host of a request is one the console answers to; the clients' WebSocket checks it too (see Clients). A client passes on the
// requests of bridge-schedule and bridge-skill on its machine (see client.ts), which are answered for the machine of its connection: the
// schedules of its agents, and reads of the skills of the platform alone (see Skills.answer). What the agent reads of a refusal goes through
// publicText, like the console's errors.
const allowedHost=(req:http.IncomingMessage)=>['localhost','127.0.0.1',os.hostname(),...(process.env.BRIDGE_HOSTS||'').split(',')].includes(req.headers.host?.split(':')[0]);
const refusal=(e:Error)=>{throw Error(publicText(e.message).slice(0,1200));};
// Once the client of a machine is in, the projects that adopted a directory there are asked about it (see convertAdopted), one machine after the other.
const conversions=new Map<string,Promise<unknown>>();
const serviceCalls=new ServiceCalls({offers:()=>clients.offers(),call,log:(...args)=>store.log(...args)});
const clients=new Clients(store,{allowedHost,joined:m=>{if(m.enabled)refresh(m);void skills.align(m);enqueue(conversions,'adopted',()=>convertAdopted(store,m,ops.inspectDirectory));},methods:{schedules:(m,{op,body})=>agentSchedules.call(m,op,body).catch(refusal),skills:(m,{op,body})=>skills.answer(m,op,body).catch(refusal),messages:(m,{op,body})=>messages.call(m,op,body).catch(refusal),tasks:(m,{op,body})=>agentTasks.call(m,op,body).catch(refusal),services:(m,{op,body})=>serviceCalls.call(m,op,body).catch(refusal)}});
function equal(a:string|undefined,b:string){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
// Whether a request carries the access key, which a program sends; authorized also takes the session of the console.
const bearer=(req:http.IncomingMessage)=>equal(req.headers.authorization?.replace(/^Bearer /,''),key);
function authorized(req:http.IncomingMessage){if(bearer(req))return true;return (auth.get(req.headers.cookie?.match(/(?:^|; )bridge_session=([^;]+)/)?.[1])||0)>Date.now();}
function json(res:http.ServerResponse,code:number,data:unknown){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
// The JSON object that is the body of a request of at most limit characters, read as UTF-8 also when a piece ends inside a character. It is the
// console's, as it arrives: what reads it checks what it needs.
async function body(req:http.IncomingMessage,limit=100000):Promise<any>{
 let s='';req.setEncoding('utf8');for await(const b of req){s+=b;if(s.length>limit)throw Error('请求内容过大');}
 const v=JSON.parse(s||'{}');if(!isRecord(v))throw Error('请求内容无效');return v;
}
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
 // A request that a server received has its url.
 const url=new URL(req.url!,'http://localhost'),p=url.pathname;if(!allowedHost(req))return json(res,403,{error:'不允许的 Host'});
 const asset=req.method==='GET'&&staticFile(p);if(asset)return sendStatic(res,asset);
 if(p==='/health')return json(res,200,{ok:true,service:'herdr-bridge'});
 if(req.method==='POST'&&!req.headers.authorization&&req.headers.origin!=='http://'+req.headers.host&&req.headers.origin!=='https://'+req.headers.host)return json(res,403,{error:'跨站请求已拒绝'});
 if(p==='/api/login'&&req.method==='POST'){const ip=req.socket.remoteAddress,now=Date.now();let a=attempts.get(ip);if(!a||now-a.at>60000)a={at:now,n:0};attempts.set(ip,a);if(++a.n>20)return json(res,429,{error:'请稍后重试'});const b=await body(req);if(!equal(b.key,key))return json(res,401,{error:'访问密钥不正确'});const id=crypto.randomBytes(32).toString('hex');auth.set(id,now+12*3600000);res.setHeader('Set-Cookie',`bridge_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return json(res,200,{ok:true});}
 if(!authorized(req))return json(res,401,{error:'请先登录'});
 // What butler reads of the ready topics and hands to their agents (see ApiDigests), with the access key only: the console never needs it,
 // and the context names the owner's chats and holds what others wrote in them.
 if(p==='/api/topics/context'||p==='/api/topics/digest'){
  if(!bearer(req))return json(res,401,{error:'这个接口只接受访问密钥'});
  if(p==='/api/topics/context'&&req.method==='GET')return json(res,200,apiDigests.context());
  if(p==='/api/topics/digest'&&req.method==='POST'){const {status,body:answer}=apiDigests.answer(await body(req));return json(res,status,answer);}
  return json(res,404,{error:'接口不存在'});
 }
 if(p==='/api/state'&&req.method==='GET')return json(res,200,state());
 if(p==='/api/apps/avatar'&&req.method==='GET'){const avatar=await platforms.avatar(url.searchParams.get('id'));if(!avatar)return json(res,404,{error:'没有头像'});res.writeHead(200,{'Content-Type':avatar.type,'Cache-Control':'private, max-age=300'});return res.end(avatar.body);}
 // A skill with its files, which the console edits and bridge-skill exports; the state has only the index of the skills.
 if(p==='/api/skills/read'&&req.method==='GET')return json(res,200,skills.read(url.searchParams.get('name')));
 if(req.method!=='POST')return json(res,404,{error:'接口不存在'});const b=await body(req,p.startsWith('/api/skills/')?requestLimit:undefined);let result:unknown={ok:true};
 if(p==='/api/logout'){auth.delete(req.headers.cookie?.match(/(?:^|; )bridge_session=([^;]+)/)?.[1]);res.setHeader('Set-Cookie','bridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');}
 else if(p==='/api/machines/save'){const m=normalizeMachine(b);if(b.id){const old=machine(b.id);if(old.enabled)throw Error('请先断开机器再编辑');Object.assign(old,m);}else store.data.machines.push(m);store.save();if(m.enabled&&clients.online(m.id))await refresh(m);result={id:m.id};}
 else if(p==='/api/machines/connect'){const m=machine(b.id);m.enabled=true;store.save();void skills.align(m);if(clients.online(m.id))await refresh(m);result=herdrStatus(m);}
 else if(p==='/api/machines/disconnect'){const m=machine(b.id);m.enabled=false;store.save();store.log('机器连接',m.name+' 已断开连接，机器上的 Agent 会话继续运行');}
 else if(p==='/api/machines/remove'){if(store.data.agentConfigs.some(x=>x.machineId===b.id))throw Error('请先移除该机器上的 Agent 配置');if(store.data.projects.some(x=>x.adopted?.machineId===b.id))throw Error('请先移除该机器上的项目');machine(b.id);store.data.machines=store.data.machines.filter(x=>x.id!==b.id);live.delete(b.id);clients.remove(b.id);store.save();}
 // The config of the machine's client with a new token, shown once: for the control plane at BRIDGE_URL, else where the browser reached it.
 else if(p==='/api/machines/token'){result={config:configText(bridgeUrl||'http://'+req.headers.host,clients.issue(machine(b.id)))};}
 else if(p==='/api/apps/registration/start'){result=registrations.start(b);}
 else if(p==='/api/apps/registration/cancel'){result=registrations.cancel(b.id);}
 else if(p==='/api/apps/save'){const old=b.id?platforms.app(b.id):undefined;if(old?.enabled)throw Error('请先停用应用再编辑');if(old&&old.appId!==b.appId&&store.data.bindings.some(x=>x.appId===old.id))throw Error('该应用下还有会话绑定，不能更换 App ID，请新建应用');const a=normalizeApp(b,old);if(store.data.apps.some(x=>x.id!==a.id&&x.appId===a.appId))throw Error('该应用已添加');if(old)Object.assign(old,a);else store.data.apps.push(a);await platforms.stop(a.id);store.save();result={id:a.id};}
 else if(p==='/api/apps/test'){result=await platforms.verify(platforms.app(b.id));store.log('凭证验证',platforms.app(b.id).name+' 验证通过');}
 else if(p==='/api/apps/toggle'){const a=platforms.app(b.id);if(b.enabled){await platforms.start(a);a.enabled=true;}else{a.enabled=false;await platforms.stop(a.id);}store.save();}
 else if(p==='/api/apps/remove'){if(store.data.bindings.some(x=>x.appId===b.id))throw Error('请先移除该应用的会话绑定');await platforms.remove(b.id);}
 else if(p==='/api/projects/save'){
  const x=saveProject(store,b);result={id:x.id};
  // The description is made in the background, from an online machine, and the save does not wait for it.
  fillDescription(store,x,()=>store.data.machines.filter(m=>m.enabled&&clients.online(m.id)),async(m,repos)=>(await ops.describeRepos(m,{repos},{timeoutMs:180000})).readmes,askModel);
 }
 else if(p==='/api/projects/remove'){removeProject(store,b.id);}
 else if(p==='/api/agent-configs/save'){result={id:saveAgentConfig(store,b).id};}
 else if(p==='/api/agent-configs/remove'){removeAgentConfig(store,b.id);}
 else if(p==='/api/bindings/save'){const x=binding(b.id);changeBinding(x,b,store.data);store.save();store.log('会话绑定',`${x.name}：${bindingTarget(x,store.data)}，之后新开的话题生效`);}
 else if(p==='/api/bindings/remove'){store.data.bindings=store.data.bindings.filter(x=>x.id!==b.id);store.save();topics.unbind(b.id);}
 // A topic that a trusted caller opens in a chat (see ApiTopics), whose refusals answer with their own status and code for the caller to react to.
 else if(p==='/api/topics/open'){const {status,body:answer}=await apiTopics.answer(b);return json(res,status,answer);}
 // Writes to skills come only from the console and the access key, never from an agent: a skill goes into every later topic, and an
 // agent can be talked into anything by what it reads.
 else if(p==='/api/skills/save'){skills.save(b.name,b.text,{create:Boolean(b.create)});}
 else if(p==='/api/skills/import'){skills.put(b.name,b.files);}
 else if(p==='/api/skills/preload'){skills.flag(b.name,b.preload);}
 else if(p==='/api/skills/remove'){skills.remove(b.name);}
 else return json(res,404,{error:'接口不存在'});
 return json(res,200,result);
 }catch(e){json(res,400,{error:publicText(e.message).slice(0,1200)});}});
// Machines are polled once their clients are in (see joined), then every 5 s while they stay in.
const poll=setInterval(()=>{for(const m of store.data.machines)if(m.enabled&&clients.online(m.id))refresh(m);},5000);
// The workspaces of topics that ended long ago are removed once a day (see Topics.sweep); the first sweep waits for the clients to connect.
const sweeping=setInterval(()=>topics.sweep(),24*3600000),firstSweep=setTimeout(()=>topics.sweep(),5*60000);
for(const a of store.data.apps)if(a.enabled)platforms.start(a).catch(e=>store.log('平台连接',a.name+'：'+e.message,'error'));schedules.start();agentSchedules.start();
server.on('upgrade',(req,socket,head)=>clients.upgrade(req,socket,head));
server.listen(Number(process.env.PORT||8080),process.env.BIND||'0.0.0.0',()=>console.log('herdr-bridge listening on '+(process.env.PORT||8080)));
process.on('SIGTERM',()=>{clearInterval(poll);clearInterval(sweeping);clearTimeout(firstSweep);schedules.stop();agentSchedules.stop();registrations.stop();for(const a of store.data.apps)platforms.stop(a.id);clients.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();});
