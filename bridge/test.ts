import test from 'node:test';import strictAssert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';import net from 'node:net';import http from 'node:http';
import {Readable} from 'node:stream';
import {normalizeMachine,migrateMachines,operations,Store} from './core.ts';
import {Skills,frontmatter,skillLimit} from './skills.ts';
import {namingPrompt,parseBranch,validBranch,branchOf,randomBranch,continueBranch,worktreePath} from './worktree-branch.mjs';import {normalizeApp,normalizeBinding,addBinding,changeBinding,bindingTarget,routable,supported,forwardable,Platforms,channelCache} from './platform.ts';import {Topics} from './topics.ts';
import {attachmentsOf,promptOf,fileName,titleOf,limits} from './attachments.ts';
import {migrateBindings,convertAdopted} from './migration.ts';import type {BindingFields} from './platform.ts';import {normalizeAgentConfig,configName,saveAgentConfig,removeAgentConfig} from './agent-configs.ts';import {normalizeProject,repoKey,repoName,uniqueName,saveProject,removeProject,fillDescription} from './projects.ts';
import {PendingChats,consoleUrl} from './pending-chats.ts';
import {parseCron,zone,next,previous,upcoming,when,phrase} from './cron.ts';import {Schedules,isMode} from './schedules.ts';import {AgentSchedules} from './agent-schedules.ts';import {main as runCommand,parse as parseCommand,usage} from './schedule-command.ts';import {main as runSkill,parse as parseSkill,usage as skillUsage} from './skill-command.ts';
import {check,card,plain} from './request-cards.ts';import {fits} from './message-cards.ts';import {nameOf} from './adoption.ts';
import {Registrations} from './registration.ts';import {staticFile,sendStatic} from './web-assets.ts';import {fileURLToPath} from 'node:url';
import {normalize} from '@larksuite/channel';
import crypto from 'node:crypto';import {WebSocketServer} from 'ws';import type {WebSocket as WsSocket} from 'ws';import type {AddressInfo} from 'node:net';
import {link,protocol,closeCodes} from './link.ts';import type {Api,ControlApi,Peer} from './link.ts';import {Clients} from './clients.ts';import {configText,serve} from './client.ts';
import type {App,Binding,Machine,Topic,Kind,State,Schedule,Skill,Log,AgentConfig,Project} from './state.ts';import type {ConsoleMachine,ConsoleTopic} from './console-state.ts';import type {ClientStatus} from './clients.ts';import type {Agent,Herdr,Snapshot,Operations,Call} from './core.ts';import type {Message} from './topics.ts';import type {ScheduleOps} from './agent-schedules.ts';
import type {Ran,HerdrArg,ClientApi} from './link.ts';import type {Reply} from './message-cards.ts';import type {HerdrRequest,Click} from './request-cards.ts';import type {RequestCard} from './state.ts';import type {ToolCall} from './cot.ts';
import type {NormalizedMessage,ResourceDescriptor,LarkChannel,LarkChannelOptions,CardActionEvent} from '@larksuite/channel';
// The assertions of node:assert/strict without narrowing what they check: a test checks the same value again after it changed.
type Narrowing='equal'|'deepEqual'|'ok';
type Assert=Omit<typeof strictAssert,Narrowing>&{[K in Narrowing]:(...args:Parameters<typeof strictAssert[K]>)=>void};
const assert:Assert=strictAssert;
// The dependencies that a class of Bridge takes, which the fixtures fake.
type DepsOf<C extends abstract new(...args:never[])=>unknown>=NonNullable<ConstructorParameters<C>[1]>;
// An error as an assertion reads it: with the fields that Bridge puts on errors (see coded).
type Thrown=Error&{code?:unknown,timedOut?:boolean,usage?:boolean};
// The runtime of an app whose channel has only what a test gives it (see Runtime in platform.ts).
type Runtime=Platforms['runtime'] extends Map<string,infer R>?R:never;
const fakeChannel=(channel:object)=>channel as LarkChannel,runtimeOf=(channel:object)=>({channel:fakeChannel(channel)}) as Runtime;
// What Bridge sends a fake of a machine's client, read field by field (see ClientApi in link.ts).
type Sent=Record<string,any>;
// JSON that a test reads as it arrives, from a response of Bridge or a frame of a link.
type Json=any;
// What Bridge answers to a request of the console: the status and the JSON.
type Answer={status:number,body:Json};
// A fake of Clients.call (see Call in core.ts), which answers each method with what a test makes up.
const fakeCall=(call:(m:Machine,method:keyof ClientApi,params:Sent,options?:{timeoutMs?:number})=>Promise<unknown>)=>call as unknown as Call;
// A fake for a dependency of type F that resolves to what a test chooses, such as nothing where Bridge expects a message id.
const loose=<F extends (...args:never[])=>unknown>(fake:(...args:Parameters<F>)=>unknown)=>fake as unknown as F;
// A click as the SDK reports it (see Platforms.cardAction) and Bridge reads it.
type Clicked=Click&CardActionEvent;
// The handlers that a fake channel was given, which a test calls with events it makes up.
type Handlers=Record<string,(...args:any[])=>any>;

// A fixture without onCardAction has no card clicks.
function platformFixture(options?:Partial<DepsOf<typeof Platforms>>){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-platform-')),store=new Store(dir),
 messages:Parameters<DepsOf<typeof Platforms>['onMessage']>[]=[],unbound:Parameters<DepsOf<typeof Platforms>['onUnbound']>[]=[];return {dir,store,messages,unbound,platforms:new Platforms(store,{onMessage:(...args)=>messages.push(args),onUnbound:(...args)=>unbound.push(args),...options} as DepsOf<typeof Platforms>),close(){fs.rmSync(dir,{recursive:true});}};}
// The project and the agent configuration of the binding below: a project that adopted ~/work on machine m, and Claude there.
const routeProject:Project={id:'p',name:'work',description:'',repos:[],skills:[],workMode:'shared',adopted:{machineId:'m',dir:'~/work'}};
const routeConfig:AgentConfig={id:'c',name:'cpu2 · Claude',machineId:'m',kind:'claude',permissionMode:'default'};
const route:Binding={id:'b',name:'个人助手',enabled:true,appId:'a',chatId:'oc_1',chatType:'group',requireMention:false,defaultProjectId:'p',defaultAgentConfigId:'c'};
// A person's message as the SDK makes it, with the fields that Bridge reads.
const inbound={senderType:'user',senderId:'ou_user',chatId:'oc_1',messageId:'om_1',rawContentType:'text',content:'private prompt'} as NormalizedMessage;
// An app as far as the tests need one.
const allowed={id:'a',name:'bot',enabled:true,allowedUsers:['ou_user']} as App;
const plainText=(content:string)=>({tag:'div',text:{tag:'plain_text',content}});
// What Bridge posts into a thread besides request and adoption cards: cards without a header whose summary, which the chat list and
// notifications show, is the beginning of the text, the whole text unless given. A notice shows plain text, a reply its markdown in the
// full width.
const untitledOf=(summary:string,elements:object[],config?:object)=>({schema:'2.0',config:{...config,summary:{content:summary}},body:{elements}});
const notice=(text:string,summary=text)=>({card:untitledOf(summary,[plainText(text)])});
const replyOf=(text:string,summary=text,...after:object[])=>({card:untitledOf(summary,[{tag:'markdown',content:text},...after],{width_mode:'fill'})});
const markdownIn=(card:object):string=>(card as Card).body.elements[0].content;
// What a reply that Herdr cut ends with.
const truncatedNote=plainText('（回复过长，已截断，完整内容请在 Herdr 中查看）');
type RegisterApp=NonNullable<DepsOf<typeof Registrations>['register']>;type Connect=NonNullable<DepsOf<typeof Registrations>['connect']>;
// register stands for the SDK's registerApp, and resolves to the fields of its result that Bridge reads.
function registrationFixture(register:(o:Parameters<RegisterApp>[0])=>Promise<unknown>,options:Omit<DepsOf<typeof Registrations>,'register'>={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-registration-')),store=new Store(dir);
 const registrations=new Registrations(store,{register:register as RegisterApp,qr:async()=>'data:image/png;base64,test',...options});
 return {store,registrations,close(){registrations.stop();fs.rmSync(dir,{recursive:true});}};
}
const ready=(o:Parameters<RegisterApp>[0])=>o.onQRCodeReady({url:'https://open.feishu.cn/page/launcher?user_code=test',expireIn:600});
test('registration stores credentials server-side, uses minimal bot scopes and allows only the creator',async()=>{
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);assert.equal(o.addons!.preset,false);assert.equal(o.addons!.scopes!.user,undefined);assert.deepEqual(o.addons!.events!.items!.tenant,['im.message.receive_v1']);
  assert.deepEqual(o.addons!.scopes!.tenant,['im:message:send_as_bot','im:message.p2p_msg:readonly','im:message.group_at_msg:readonly','application:bot.basic_info:read','im:message.reactions:write_only','application:app_slash_command:read','application:app_slash_command:write','im:message:readonly']);ready(o);return {client_id:'cli_test',client_secret:'private-test-secret',user_info:{open_id:'ou_owner',tenant_brand:'feishu'}};});
 try{f.registrations.start({name:'test'})!;await f.registrations.current!.done;assert.equal(f.registrations.status()!.status,'completed');const a=new Store(f.store.dir).data.apps[0];assert.equal(a.appSecret,'private-test-secret');assert.deepEqual(a.allowedUsers,['ou_owner']);assert.equal(a.enabled,false);assert.equal(a.domain,'feishu');assert.ok(!JSON.stringify(f.registrations.status()).includes('private-test-secret'));assert.equal(f.registrations.status()!.url,undefined);assert.equal(fs.statSync(path.join(f.store.dir,'state.json')).mode&0o777,0o600);}finally{f.close();}
});
test('duplicate starts reuse pending flow; cancellation fences a late SDK result and stale cancel',async()=>{
 let resolve!:(result:unknown)=>void;let calls=0;const f=registrationFixture(o=>{calls++;ready(o);return new Promise(r=>resolve=r);});
 try{const one=f.registrations.start({name:'one'})!,two=f.registrations.start({name:'two'})!;assert.equal(one.id,two.id);assert.equal(calls,1);const done=f.registrations.current!.done;f.registrations.cancel(one.id);resolve({client_id:'cli_late',client_secret:'late'});await done;assert.equal(f.store.data.apps.length,0);assert.equal(f.registrations.status()!.status,'cancelled');const next=f.registrations.start({name:'next'})!;assert.notEqual(next.id,one.id);assert.throws(()=>f.registrations.cancel(one.id));f.registrations.cancel(next.id);resolve({});await f.registrations.current!.done;}finally{f.close();}
});
test('denial, expiry and errors do not expose SDK details or credentials',async()=>{
 for(const [error,status] of [[{code:'access_denied'},'denied'],[{code:'expired_token'},'expired'],[{message:'secret must not leak',response:{device_code:'private'}},'error']]){
  const f=registrationFixture(async o=>{ready(o);throw error;});try{f.registrations.start({name:'test'})!;await f.registrations.current!.done;assert.equal(f.registrations.status()!.status,status);assert.equal(f.registrations.status()!.url,undefined);assert.ok(!JSON.stringify(f.registrations.status()).includes('private'));assert.equal(f.store.data.apps.length,0);}finally{f.close();}
 }
});
test('registration rejects unsafe URLs, handles missing owner and honors Lark tenant brand',async()=>{
 const bad=registrationFixture(async o=>{o.onQRCodeReady({url:'https://attacker.example/qr',expireIn:600});return {};});
 try{bad.registrations.start({name:'test'})!;await bad.registrations.current!.done;assert.equal(bad.registrations.status()!.status,'error');assert.equal(bad.registrations.status()!.url,undefined);}finally{bad.close();}
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_lark',client_secret:'secret',user_info:{tenant_brand:'lark'}};});
 try{f.registrations.start({name:'test'})!;await f.registrations.current!.done;assert.equal(f.store.data.apps[0].domain,'lark');assert.deepEqual(f.store.data.apps[0].allowedUsers,[]);assert.equal(f.store.data.apps[0].enabled,false);assert.equal(f.registrations.status()!.status,'needs_owner');}finally{f.close();}
});
test('begin timeout ignores late callback and does not publish an expired authorization link',async()=>{
 let options!:Parameters<RegisterApp>[0],resolve!:(result:unknown)=>void;const f=registrationFixture(o=>{options=o;return new Promise(r=>resolve=r);},{timeoutMs:10});
 try{f.registrations.start({name:'test'})!;await new Promise(r=>setTimeout(r,25));ready(options);resolve({client_id:'cli_late',client_secret:'late'});await f.registrations.current!.done;assert.equal(f.registrations.status()!.status,'error');assert.equal(f.registrations.status()!.url,undefined);assert.equal(f.store.data.apps.length,0);}finally{f.close();}
});
test('a machine has a name, a Herdr session, default when none is given, and whether Bridge uses it; whatever else a request sends is dropped',()=>{
 const m=normalizeMachine({name:' cpu2 ',session:'work',enabled:1,type:'ssh',host:'cpu2',port:22,binary:'~/.local/bin/herdr',tokenHash:'x'});
 assert.deepEqual(Object.keys(m).sort(),['enabled','id','name','session']);assert.deepEqual([m.name,m.session,m.enabled],['cpu2','work',true]);assert.match(m.id,/^[0-9a-f-]{36}$/);
 assert.deepEqual(normalizeMachine({id:'m',name:'x'}),{id:'m',name:'x',session:'default',enabled:false});
 for(const session of ['../default','-x','a b'])assert.throws(()=>normalizeMachine({name:'x',session}),/Herdr session 名称无效/,session);
 assert.throws(()=>normalizeMachine({name:' '}),/字段为空或过长/);
});
test('machines of a state file from before the clients lose their type, address, port and Herdr path in one save with one log line, which names a Herdr path that the client of its machine has to be told; ids, names, sessions, tokens and what refers to them stay',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-migrate-'));try{
  const old=new Store(dir);
  old.data.machines=[{id:'m1',name:'cpu1',type:'local',host:'',port:22,session:'default',binary:'~/.local/bin/herdr',enabled:true,tokenHash:'aa'},{id:'m2',name:'cpu2',type:'ssh',host:'cpu2',port:2222,session:'work',binary:'/opt/herdr/bin/herdr',enabled:false},{id:'m3',name:'gpu1',session:'default',enabled:true}] as Machine[];
  old.data.bindings=[{id:'b'}] as Binding[];old.data.topics=[{id:'t',machineId:'m1'}] as Topic[];old.save();
  const store=new Store(dir),save=store.save.bind(store);let saves=0;store.save=()=>{saves++;save();};
  migrateMachines(store);assert.equal(saves,1);
  const saved:State=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
  assert.deepEqual(saved.machines,[{id:'m1',name:'cpu1',session:'default',enabled:true,tokenHash:'aa'},{id:'m2',name:'cpu2',session:'work',enabled:false},{id:'m3',name:'gpu1',session:'default',enabled:true}]);
  assert.deepEqual([saved.bindings,saved.topics],[[{id:'b'}],[{id:'t',machineId:'m1'}]]);
  assert.deepEqual(saved.logs.map(l=>[l.kind,l.level,l.message]),[['机器连接','info','机器改为经客户端连接，去掉了 cpu1、cpu2 的连接方式、地址、端口和 Herdr 路径；cpu2 的 Herdr 在 /opt/herdr/bin/herdr，请写进对应机器客户端配置的 herdr']]);
  // Machines without the old fields are left alone, without a save.
  migrateMachines(store);migrateMachines(new Store(dir));assert.equal(saves,1);assert.equal(new Store(dir).data.logs.length,1);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('the store keeps projects and agent configurations beside the other collections, and the configuration of the latest binding; a state file from before has none of them',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-'));
 try{
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({machines:[{id:'m'}],bindings:[]}));
  const old=new Store(dir);assert.deepEqual([old.data.projects,old.data.agentConfigs,old.data.lastAgentConfigId],[[],[],undefined]);
  old.data.projects.push({id:'p',name:'genvi',description:'',repos:[],skills:[],workMode:'isolated'});old.data.agentConfigs.push({id:'c',name:'cpu1 · Claude',machineId:'m',kind:'claude',permissionMode:'default'});
  old.data.lastAgentConfigId='c';old.save();
  const saved=new Store(dir);assert.deepEqual([saved.data.projects.map(p=>p.id),saved.data.agentConfigs.map(c=>c.id),saved.data.lastAgentConfigId],[['p'],['c'],'c']);
 }finally{fs.rmSync(dir,{recursive:true});}
});
// The bindings of a state file from before projects and agent configurations: the machine, directory, kind and permission mode were their own.
const oldBinding=(id:string,fields:Record<string,unknown>)=>({id,name:'飞书群聊',appId:'a',chatId:'oc_'+id,requireMention:true,enabled:true,...fields});
const oldBindings=()=>[
 oldBinding('b1',{name:'飞书私聊',machineId:'m1',cwd:'~/code/test',kind:'claude',requireMention:false,workspaceId:'wD'}),
 oldBinding('b2',{machineId:'m1',cwd:'~/code/test',kind:'claude',permissionMode:'auto',workspaceId:'wA'}),
 oldBinding('b3',{machineId:'m1',cwd:'~/code/codex-test',kind:'codex'}),
 oldBinding('b4',{machineId:'m2',cwd:'~/code/learning/herdr',kind:'codex'}),
 oldBinding('b5',{machineId:'m2',cwd:'/data/work/genvi',kind:'claude',permissionMode:'auto'}),
 oldBinding('b6',{machineId:'m2',cwd:'~/code/genvi',kind:'claude',permissionMode:'auto'}),
 oldBinding('b7',{machineId:'m2',cwd:'~/code/genvi/',kind:'codex'}),
 oldBinding('b8',{machineId:'m1',cwd:'~/butler-desk',kind:'claude',permissionMode:'default',requireMention:false}),
];
// A store in a temporary directory whose state file is an old one: the machines cpu1 (m1) and cpu2 (m2), oldBindings and some topics.
function oldStore(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-migrate-')),topic={appId:'a',chatId:'oc',rootId:'om',machineId:'m1',workspaceId:'',tabId:'',paneId:'',agentName:'x',title:'t',error:'',messageIds:[],replySeq:0,reactions:[],cards:[],createdAt:1};
 fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({machines:[{id:'m1',name:'cpu1',session:'default',enabled:true},{id:'m2',name:'cpu2',session:'default',enabled:true}],apps:[],bindings:oldBindings(),
  topics:[{...topic,id:'t1',bindingId:'b1',state:'closed'},{...topic,id:'t2',bindingId:'b2',state:'ready',worktree:{branch:'x',path:'/w/x',root:'/w'}},{...topic,id:'t3',bindingId:'b2',state:'choosing',machineId:'',adopted:{picker:'om_card'}},
   {...topic,id:'t4',bindingId:'b3',state:'ready',adopted:{kind:'claude'}},{...topic,id:'t5',bindingId:'gone',state:'closed'},{...topic,id:'t6',bindingId:'b7',state:'failed',machineId:'m2'}],
  schedules:[{id:'s1',bindingId:'b2',mode:'new',cron:'0 9 * * *',timeZone:'UTC',task:'x',paused:false,createdBy:{},createdAt:1,handledUntil:1,count:0,runs:[]}]}));
 return {dir,store:new Store(dir),close(){fs.rmSync(dir,{recursive:true});}};
}
test('every old binding becomes a binding of the same id with a default agent configuration and, for a group, a default project that adopts its old directory as a shared project; bindings of one machine and directory share a project, bindings of one machine, kind and permission mode a configuration',()=>{
 const f=oldStore();try{
  migrateBindings(f.store);
  const {projects,agentConfigs,bindings}=f.store.data,by=(name:string)=>projects.find(p=>p.name===name)!,config=(name:string)=>agentConfigs.find(c=>c.name===name)!;
  const adopt=(machineId:string,dir:string)=>({workMode:'shared',description:'',repos:[],skills:[],adopted:{machineId,dir}});
  assert.deepEqual(projects.map(({id,...p})=>p),[{name:'test',...adopt('m1','~/code/test')},{name:'codex-test',...adopt('m1','~/code/codex-test')},{name:'herdr',...adopt('m2','~/code/learning/herdr')},
   {name:'genvi',...adopt('m2','/data/work/genvi')},{name:'genvi 2',...adopt('m2','~/code/genvi')},{name:'butler-desk',...adopt('m1','~/butler-desk')}]);
  assert.deepEqual(agentConfigs.map(({id,...c})=>c),[{name:'cpu1 · Claude · default',machineId:'m1',kind:'claude',permissionMode:'default'},{name:'cpu1 · Claude · auto',machineId:'m1',kind:'claude',permissionMode:'auto'},
   {name:'cpu1 · Codex',machineId:'m1',kind:'codex'},{name:'cpu2 · Codex',machineId:'m2',kind:'codex'},{name:'cpu2 · Claude',machineId:'m2',kind:'claude',permissionMode:'auto'}]);
  const group=(id:string,project:string,cfg:string,fields:object={})=>({id,name:'飞书群聊',appId:'a',chatId:'oc_'+id,chatType:'group',requireMention:true,enabled:true,defaultProjectId:by(project).id,defaultAgentConfigId:config(cfg).id,...fields});
  assert.deepEqual(bindings,[
   {id:'b1',name:'飞书私聊',appId:'a',chatId:'oc_b1',chatType:'p2p',requireMention:false,enabled:true,defaultAgentConfigId:config('cpu1 · Claude · default').id,workspaces:{m1:'wD'}},
   group('b2','test','cpu1 · Claude · auto',{workspaces:{m1:'wA'}}),group('b3','codex-test','cpu1 · Codex'),group('b4','herdr','cpu2 · Codex'),group('b5','genvi','cpu2 · Claude'),group('b6','genvi 2','cpu2 · Claude'),
   group('b7','genvi 2','cpu2 · Codex'),group('b8','butler-desk','cpu1 · Claude · default',{requireMention:false})]);
  // Topics keep the directory they started in, and what they started with; those that adopted an agent, and the ones of no binding, are left alone.
  const topic=(id:string)=>f.store.data.topics.find(t=>t.id===id)!;
  assert.deepEqual([topic('t1').projectId,topic('t1').agentConfigId,topic('t1').cwd],[by('test').id,config('cpu1 · Claude · default').id,'~/code/test']);
  assert.deepEqual([topic('t2').projectId,topic('t2').agentConfigId,topic('t2').cwd],[by('test').id,config('cpu1 · Claude · auto').id,'~/code/test']);
  assert.deepEqual([topic('t6').projectId,topic('t6').agentConfigId,topic('t6').cwd],[by('genvi 2').id,config('cpu2 · Codex').id,'~/code/genvi/']);
  for(const id of ['t3','t4','t5'])for(const k of ['projectId','agentConfigId','cwd'])assert.equal(k in topic(id),false,id+' '+k);
  assert.deepEqual(f.store.data.schedules.map(s=>[s.id,s.bindingId]),[['s1','b2']]);
  // It is saved, and logged once for the whole state with a line per project that tells where its directory is.
  assert.deepEqual(new Store(f.dir).data.bindings,bindings);
  assert.deepEqual(f.store.data.logs.map(l=>[l.kind,l.level]),Array(7).fill(['数据迁移','info']));
  assert.equal(f.store.data.logs[0].message,'8 个会话绑定已迁移为 6 个项目和 5 个 Agent 配置');assert.equal(f.store.data.logs[1].message,'项目「test」沿用 cpu1 上的 ~/code/test，被 2 个会话绑定使用');
 }finally{f.close();}
});
test('a state that is migrated already is left alone, without a save or a log line',()=>{
 const f=oldStore();try{
  migrateBindings(f.store);const saved=fs.readFileSync(path.join(f.dir,'state.json'),'utf8'),save=f.store.save.bind(f.store);let saves=0;f.store.save=()=>{saves++;save();};
  migrateBindings(f.store);migrateBindings(new Store(f.dir));assert.equal(saves,0);assert.equal(fs.readFileSync(path.join(f.dir,'state.json'),'utf8'),saved);
  const empty=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-migrate-'));try{const store=new Store(empty);migrateBindings(store);assert.equal(fs.existsSync(path.join(empty,'state.json')),false);}finally{fs.rmSync(empty,{recursive:true});}
 }finally{f.close();}
});
test('a project of a migrated binding is named after its directory, never after the chat: a number tells equal names apart, and a binding that no longer names a machine still migrates',()=>{
 const f=oldStore();try{
  f.store.data.bindings=[oldBinding('x1',{machineId:'m1',cwd:'/srv/app/',kind:'claude'}),oldBinding('x2',{machineId:'m2',cwd:'~/work/app',kind:'claude'}),oldBinding('x3',{machineId:'m2',cwd:'/other/app',kind:'claude'}),
   oldBinding('x4',{machineId:'m1',cwd:'/',kind:'claude'}),oldBinding('x5',{machineId:'gone',cwd:'~/a-b_c.d',kind:'agy'})] as unknown as Binding[];
  f.store.data.projects=[{id:'taken',name:'app 3',description:'',repos:[],skills:[],workMode:'isolated'}];
  migrateBindings(f.store);
  assert.deepEqual(f.store.data.projects.map(p=>p.name),['app 3','app','app 2','app 4','cpu1','a-b_c.d']);
  assert.deepEqual(f.store.data.agentConfigs.map(c=>c.name),['cpu1 · Claude','cpu2 · Claude','已删除的机器 · Antigravity']);
  assert.deepEqual(f.store.data.bindings.map(b=>b.defaultProjectId&&f.store.data.projects.find(p=>p.id===b.defaultProjectId)!.name),['app','app 2','app 4','cpu1','a-b_c.d']);
 }finally{f.close();}
});
// The inspectDirectory of a machine that has the origins in origins by '<machine id> <directory>', null for any other directory, or the
// error there; calls records the directories asked as the same keys.
function fakeInspect(origins:Record<string,string|Error|null>){
 const calls:string[]=[];
 return {calls,inspect:async(m:Machine,dir:string)=>{const key=m.id+' '+dir;calls.push(key);await null;const o=origins[key]??null;if(o instanceof Error)throw o;return {origin:o};}};
}
test('once the client of a machine is connected, a migrated project whose directory is the root of a repository with an origin becomes an isolated project of that repository, which loses the directory and is named after it; projects of one origin merge and take over bindings and topics; the others are asked only once',async()=>{
 const f=oldStore();try{
  migrateBindings(f.store);
  const p=(name:string)=>f.store.data.projects.find(x=>x.name===name)!,ids=Object.fromEntries(f.store.data.projects.map(x=>[x.name,x.id])),[m1,m2]=f.store.data.machines;
  const fake=fakeInspect({'m2 ~/code/learning/herdr':'git@github.com:bezhai/herdr-self.git','m2 /data/work/genvi':'git@code.byted.org:growth/genvi.git','m2 ~/code/genvi':'https://code.byted.org/growth/genvi.git'});
  await convertAdopted(f.store,m2,fake.inspect);
  assert.deepEqual(fake.calls,['m2 ~/code/learning/herdr','m2 /data/work/genvi','m2 ~/code/genvi']);
  const repo=(name:string,url:string)=>({name,description:'',repos:[url],skills:[],workMode:'isolated'});
  assert.deepEqual(f.store.data.projects.map(({id,...x})=>x).slice(2),[repo('herdr-self','git@github.com:bezhai/herdr-self.git'),repo('genvi','git@code.byted.org:growth/genvi.git'),
   {name:'butler-desk',description:'',repos:[],skills:[],workMode:'shared',adopted:{machineId:'m1',dir:'~/butler-desk'}}]);
  // The project that merged is gone: its bindings and topics are the other one's now, and the topic keeps the directory it started in.
  assert.deepEqual(f.store.data.bindings.filter(b=>['b4','b5','b6','b7'].includes(b.id)).map(b=>b.defaultProjectId),[ids.herdr,ids.genvi,ids.genvi,ids.genvi]);
  assert.deepEqual(f.store.data.topics.filter(t=>t.id==='t6').map(t=>[t.projectId,t.cwd]),[[ids.genvi,'~/code/genvi/']]);
  assert.equal(f.store.data.projects.some(x=>x.id===ids['genvi 2']),false);
  assert.deepEqual(new Store(f.dir).data.projects,f.store.data.projects);
  assert.deepEqual(f.store.data.logs.slice(7).map(l=>l.message),['项目「herdr」改为仓库 git@github.com:bezhai/herdr-self.git 的项目，改名为「herdr-self」','项目「genvi」改为仓库 git@code.byted.org:growth/genvi.git 的项目',
   '项目「genvi 2」的仓库与项目「genvi」相同，已合并到它']);
  // The projects of the other machine are not asked, and the machine of a project that is not a repository is asked once.
  const other=fakeInspect({});await convertAdopted(f.store,m1,other.inspect);assert.deepEqual(other.calls,['m1 ~/code/test','m1 ~/code/codex-test','m1 ~/butler-desk']);
  assert.deepEqual(p('test').adopted,{machineId:'m1',dir:'~/code/test',inspected:true});
  await convertAdopted(f.store,m1,other.inspect);await convertAdopted(f.store,m2,fake.inspect);assert.equal(other.calls.length,3);assert.equal(fake.calls.length,3);
 }finally{f.close();}
});
test('a project whose name was changed since the migration keeps it when it becomes a repository project, and one that joins a repository project that exists goes into it; a directory that cannot be asked about is asked again next time',async()=>{
 const f=oldStore();try{
  migrateBindings(f.store);const [,m2]=f.store.data.machines,herdr=f.store.data.projects.find(x=>x.name==='herdr')!,existing=f.store.data.projects.find(x=>x.name==='genvi')!;
  herdr.name='我的 herdr';
  const known:Project={id:'known',name:'增长',description:'投放',repos:['git@code.byted.org:growth/genvi'],skills:['butler'],workMode:'isolated'};f.store.data.projects.push(known);
  const fake=fakeInspect({'m2 ~/code/learning/herdr':'git@github.com:bezhai/herdr-self.git','m2 /data/work/genvi':'ssh://git@code.byted.org/growth/genvi.git','m2 ~/code/genvi':Error('机器 cpu2 离线：它的 Bridge 客户端没有连上')});
  await convertAdopted(f.store,m2,fake.inspect);
  assert.deepEqual([herdr.name,herdr.repos,herdr.adopted],['我的 herdr',['git@github.com:bezhai/herdr-self.git'],undefined]);
  // The existing project of that repository takes over, with its own name, description and skills.
  assert.equal(f.store.data.projects.includes(existing),false);assert.deepEqual([known.name,known.description,known.skills],['增长','投放',['butler']]);
  assert.deepEqual(f.store.data.bindings.find(b=>b.id==='b5')!.defaultProjectId,'known');
  const failed=f.store.data.projects.find(x=>x.name==='genvi 2')!;assert.deepEqual(failed.adopted,{machineId:'m2',dir:'~/code/genvi'});
  assert.deepEqual(f.store.data.logs.filter(l=>l.level==='error').map(l=>l.message),['项目「genvi 2」的目录没能检查：机器 cpu2 离线：它的 Bridge 客户端没有连上']);
  const retry=fakeInspect({});await convertAdopted(f.store,m2,retry.inspect);assert.deepEqual(retry.calls,['m2 ~/code/genvi']);assert.equal(failed.adopted!.inspected,true);
 }finally{f.close();}
});
test('a project that was removed or changed while its directory was being asked about is left as it is',async()=>{
 const f=oldStore();try{
  migrateBindings(f.store);const [,m2]=f.store.data.machines,[gone,changed]=f.store.data.projects.filter(x=>x.adopted?.machineId==='m2');
  const fake=fakeInspect({'m2 ~/code/learning/herdr':'git@github.com:bezhai/herdr-self.git','m2 /data/work/genvi':'git@code.byted.org:growth/genvi.git'});
  const inspect=async(m:Machine,dir:string)=>{const r=await fake.inspect(m,dir);if(dir.endsWith('herdr'))f.store.data.projects=f.store.data.projects.filter(x=>x!==gone);else delete changed.adopted;return r;};
  await convertAdopted(f.store,m2,inspect);
  assert.equal(f.store.data.projects.includes(gone),false);assert.deepEqual([changed.repos,changed.adopted],[[],undefined]);
 }finally{f.close();}
});
// A store in a temporary directory with the machines cpu1 (m1) and cpu2 (m2), the skill butler and what the tests add.
function managedStore(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-manage-')),store=new Store(dir);
 store.data.machines=[{id:'m1',name:'cpu1',session:'default',enabled:true},{id:'m2',name:'cpu2',session:'default',enabled:true}];store.data.skills=[{name:'butler',description:'',preload:false,digest:'d'}];store.save();
 return {dir,store,close(){fs.rmSync(dir,{recursive:true});}};
}
test('saving a project creates it or changes the one named by id, checks it and keeps it on disk; a project that does not exist cannot be changed',()=>{
 const f=managedStore();try{
  const made=saveProject(f.store,{name:'genvi',description:'增长',repos:['git@code.byted.org:growth/genvi.git'],skills:['butler'],workMode:'isolated'});
  assert.deepEqual(f.store.data.projects,[made]);assert.deepEqual(new Store(f.dir).data.projects,[made]);
  const changed=saveProject(f.store,{id:made.id,name:'genvi',description:'',repos:[],skills:[]});assert.deepEqual([changed.id,changed.repos,changed.skills,changed.workMode],[made.id,[],[],'isolated']);assert.equal(f.store.data.projects.length,1);
  assert.deepEqual(new Store(f.dir).data.projects,[changed]);
  for(const id of ['gone','',5,null,['x']])assert.throws(()=>saveProject(f.store,{id,name:'x'}),/^Error: 项目不存在$/,String(id));
  assert.throws(()=>saveProject(f.store,{name:'genvi'}),/^Error: 已有同名的项目$/);assert.throws(()=>saveProject(f.store,{name:'x',skills:['missing']}),/skill 不存在/);
  const before=structuredClone(f.store.data.projects);assert.throws(()=>saveProject(f.store,{id:made.id,name:'',repos:[]}),/字段为空或过长/);assert.deepEqual(f.store.data.projects,before);
 }finally{f.close();}
});
test('a project is removed only when no binding has it as its default and no topic of it is starting or running',()=>{
 const f=managedStore();try{
  const keep=saveProject(f.store,{name:'keep'}),gone=saveProject(f.store,{name:'gone'});
  f.store.data.bindings=[{...route,defaultProjectId:keep.id}];f.store.data.topics=[{id:'t1',projectId:keep.id,state:'closed'},{id:'t2',projectId:gone.id,state:'closed'},{id:'t3',projectId:keep.id,state:'ready'}] as Topic[];
  assert.throws(()=>removeProject(f.store,keep.id),/^Error: 请先修改使用该项目的会话绑定$/);
  f.store.data.bindings=[];assert.throws(()=>removeProject(f.store,keep.id),/^Error: 该项目还有进行中的话题$/);
  f.store.data.topics[2].state='starting';assert.throws(()=>removeProject(f.store,keep.id),/^Error: 该项目还有进行中的话题$/);
  removeProject(f.store,gone.id);assert.deepEqual(f.store.data.projects.map(p=>p.name),['keep']);assert.deepEqual(new Store(f.dir).data.projects.map(p=>p.name),['keep']);
  f.store.data.topics[2].state='closed';removeProject(f.store,keep.id);assert.deepEqual(f.store.data.projects,[]);assert.throws(()=>removeProject(f.store,keep.id),/^Error: 项目不存在$/);
 }finally{f.close();}
});
test('saving an agent configuration creates it or changes the one named by id; removing one needs no binding with it as its default and no topic of it starting or running, and forgets it as the configuration of the latest binding',()=>{
 const f=managedStore();try{
  const made=saveAgentConfig(f.store,{machineId:'m1',kind:'claude',model:'sonnet',allowedCommands:['butler']});
  assert.deepEqual([made.name,f.store.data.agentConfigs.length,new Store(f.dir).data.agentConfigs[0].id],['cpu1 · Claude · sonnet',1,made.id]);
  const changed=saveAgentConfig(f.store,{id:made.id,name:'管家',machineId:'m2',kind:'codex'});assert.deepEqual(f.store.data.agentConfigs,[{id:made.id,name:'管家',machineId:'m2',kind:'codex'}]);
  for(const id of ['gone','',5,null])assert.throws(()=>saveAgentConfig(f.store,{id,machineId:'m1',kind:'claude'}),/^Error: Agent 配置不存在$/,String(id));
  assert.throws(()=>saveAgentConfig(f.store,{name:'管家',machineId:'m1',kind:'claude'}),/^Error: 已有同名的 Agent 配置$/);
  f.store.data.bindings=[{...route,defaultAgentConfigId:changed.id}];f.store.data.topics=[{id:'t1',agentConfigId:changed.id,state:'ready'}] as Topic[];f.store.data.lastAgentConfigId=changed.id;
  assert.throws(()=>removeAgentConfig(f.store,changed.id),/^Error: 请先修改使用该 Agent 配置的会话绑定$/);
  f.store.data.bindings=[];assert.throws(()=>removeAgentConfig(f.store,changed.id),/^Error: 该 Agent 配置还有进行中的话题$/);
  f.store.data.topics[0].state='closed';removeAgentConfig(f.store,changed.id);assert.deepEqual([f.store.data.agentConfigs,f.store.data.lastAgentConfigId],[[],undefined]);
  assert.deepEqual([new Store(f.dir).data.agentConfigs,new Store(f.dir).data.lastAgentConfigId],[[],undefined]);assert.throws(()=>removeAgentConfig(f.store,changed.id),/^Error: Agent 配置不存在$/);
  // The configuration of the latest binding stays when another one is removed.
  const a=saveAgentConfig(f.store,{machineId:'m1',kind:'claude'}),b=saveAgentConfig(f.store,{machineId:'m1',kind:'codex'});f.store.data.lastAgentConfigId=a.id;removeAgentConfig(f.store,b.id);assert.equal(f.store.data.lastAgentConfigId,a.id);
 }finally{f.close();}
});
test('a project saved with repositories and no description gets one from the cheap model on an online machine in the background, unless the description or the repositories changed meanwhile; a machine that cannot answer is only logged',async()=>{
 const f=managedStore();try{
  const [m1,m2]=f.store.data.machines,asked:[string,string[]][]=[];let answer:Promise<{description:string}>|Error=Promise.resolve({description:' 增长业务的投放与创作服务。 '});
  const describe=async(m:Machine,repos:string[])=>{asked.push([m.id,repos]);await null;if(answer instanceof Error)throw answer;return answer;};
  const project=saveProject(f.store,{name:'genvi',repos:['git@code.byted.org:growth/genvi.git']});
  // The first online machine is asked; the description is stored and saved.
  await fillDescription(f.store,project,()=>[m2,m1],describe);assert.deepEqual(asked,[['m2',['git@code.byted.org:growth/genvi.git']]]);
  assert.equal(project.description,'增长业务的投放与创作服务。');assert.equal(new Store(f.dir).data.projects[0].description,'增长业务的投放与创作服务。');
  // A description is not asked for, nor a project without repositories or a machine to ask.
  await fillDescription(f.store,project,()=>[m1],describe);const bare=saveProject(f.store,{name:'bare'});await fillDescription(f.store,bare,()=>[m1],describe);
  const empty=saveProject(f.store,{name:'empty',repos:['https://host.example/a/b']});await fillDescription(f.store,empty,()=>[],describe);assert.equal(asked.length,1);assert.equal(empty.description,'');
  // What changed while the machine answered is not overwritten, and an empty answer stores nothing.
  let release!:(r:{description:string})=>void;answer=new Promise(r=>{release=r;});const pending=fillDescription(f.store,empty,()=>[m1],describe);
  await later(10);empty.description='我写的';release({description:'生成的'});await pending;assert.equal(empty.description,'我写的');
  empty.description='';answer=Promise.resolve({description:'  '});await fillDescription(f.store,empty,()=>[m1],describe);assert.equal(empty.description,'');
  answer=new Promise(r=>{release=r;});const moved=fillDescription(f.store,empty,()=>[m1],describe);await later(10);empty.repos=['https://host.example/other'];release({description:'旧仓库的'});await moved;assert.equal(empty.description,'');
  // A machine that cannot answer is logged and nothing else happens, also for the error of a client that has not got the operation yet.
  answer=Object.assign(Error('这个操作还没有实现：describeRepos'),{code:'not_implemented'});await fillDescription(f.store,empty,()=>[m1],describe);assert.equal(empty.description,'');
  assert.deepEqual(f.store.data.logs.map(l=>[l.kind,l.level,l.message]),[['项目','error','empty：未能从仓库生成描述，这个操作还没有实现：describeRepos']]);
 }finally{f.close();}
});
const configData=(configs:AgentConfig[]=[])=>({machines:[{id:'m',name:'cpu1'},{id:'n',name:'cpu2'}] as Machine[],agentConfigs:configs});
test('an agent configuration is a kind of agent with a model on a machine, and for Claude a permission mode and the commands it may run; its name is machine, kind and model unless given',()=>{
 const {id,...c}=normalizeAgentConfig({machineId:'m',kind:'claude',model:' Seed ',permissionMode:'auto',allowedCommands:['butler','git-lfs']},configData());
 assert.match(id,/^[0-9a-f-]{36}$/);assert.deepEqual(c,{name:'cpu1 · Claude · Seed',machineId:'m',kind:'claude',model:'Seed',permissionMode:'auto',allowedCommands:['butler','git-lfs']});
 // A Claude configuration has a mode, default without one; no model and no commands are no fields.
 const {id:plainId,...plain}=normalizeAgentConfig({machineId:'n',kind:'claude',model:'',allowedCommands:[]},configData());assert.deepEqual(plain,{name:'cpu2 · Claude',machineId:'n',kind:'claude',permissionMode:'default'});
 for(const permissionMode of ['acceptEdits','plan','bypassPermissions','AUTO',1])assert.throws(()=>normalizeAgentConfig({machineId:'m',kind:'claude',permissionMode},configData()),/^Error: 权限模式无效$/,String(permissionMode));
 // Codex and Antigravity have neither: a mode that comes with them is dropped, commands are refused.
 for(const [kind,label] of [['codex','Codex'],['agy','Antigravity']] as const){
  const {id:otherId,...other}=normalizeAgentConfig({machineId:'m',kind,model:'gpt-5',permissionMode:'auto'},configData());assert.deepEqual(other,{name:`cpu1 · ${label} · gpt-5`,machineId:'m',kind,model:'gpt-5'});
  assert.throws(()=>normalizeAgentConfig({machineId:'m',kind,allowedCommands:['butler']},configData()),/^Error: 只有 Claude 可以限制可执行的命令$/);
 }
 for(const kind of ['bash','antigravity','Agy','',undefined])assert.throws(()=>normalizeAgentConfig({machineId:'m',kind},configData()),/^Error: Agent 类型无效$/,String(kind));
 for(const machineId of ['gone','',undefined])assert.throws(()=>normalizeAgentConfig({machineId,kind:'claude'},configData()),/^Error: 机器连接不存在$/);
 for(const model of ['a b','x;y','$(id)','-m','a'.repeat(101),5])assert.throws(()=>normalizeAgentConfig({machineId:'m',kind:'claude',model},configData()),/^Error: 模型名称无效$/,String(model));
 for(const allowedCommands of ['butler',['butler bash'],[''],['../x'],['a;b'],[1],Array(21).fill('a')])assert.throws(()=>normalizeAgentConfig({machineId:'m',kind:'claude',allowedCommands},configData()),/^Error: 可执行的命令无效$/,String(allowedCommands));
 assert.equal(normalizeAgentConfig({machineId:'m',kind:'claude',allowedCommands:['butler','butler']},configData()).allowedCommands?.length,1);
 assert.equal(configName({name:'cpu1'},'claude','Seed'),'cpu1 · Claude · Seed');assert.equal(configName({name:'cpu1'},'agy'),'cpu1 · Antigravity');
});
test('the name of an agent configuration is unique; a configuration keeps its id and may keep its own name when it changes',()=>{
 const first=normalizeAgentConfig({name:'日常',machineId:'m',kind:'claude'},configData());
 assert.throws(()=>normalizeAgentConfig({name:'日常',machineId:'n',kind:'codex'},configData([first])),/^Error: 已有同名的 Agent 配置$/);
 assert.throws(()=>normalizeAgentConfig({machineId:'m',kind:'claude'},configData([{...first,name:'cpu1 · Claude'}])),/^Error: 已有同名的 Agent 配置$/);
 const changed=normalizeAgentConfig({name:'日常',machineId:'n',kind:'codex'},configData([first]),first);assert.deepEqual([changed.id,changed.name,changed.machineId],[first.id,'日常','n']);
 assert.equal('permissionMode' in changed,false);
});
const projectData=(projects:Project[]=[])=>({projects,skills:[{name:'butler'},{name:'deploy'}] as Skill[]});
test('a project has a name, a description, repositories, skills of the platform and a work mode, isolated unless given; its repositories are remote URLs of one form of git, without duplicates',()=>{
 const repos=['git@code.byted.org:growth/genvi.git','https://github.com/bezhai/herdr-self','ssh://git@host.example:2222/team/app.git','git://host.example/team/lib.git'];
 const {id,...p}=normalizeProject({name:' genvi ',description:' GenVI 的代码 ',repos:[...repos,'https://code.byted.org/growth/genvi'],skills:['butler','butler','deploy'],workMode:'shared'},projectData());
 assert.match(id,/^[0-9a-f-]{36}$/);assert.deepEqual(p,{name:'genvi',description:'GenVI 的代码',repos,skills:['butler','deploy'],workMode:'shared'});
 const {id:bareId,...bare}=normalizeProject({name:'管家'},projectData());assert.deepEqual(bare,{name:'管家',description:'',repos:[],skills:[],workMode:'isolated'});
 for(const name of ['',' ',undefined,'a'.repeat(61)])assert.throws(()=>normalizeProject({name},projectData()),/字段为空或过长/);
 assert.throws(()=>normalizeProject({name:'a',description:'x'.repeat(501)},projectData()),/^Error: 描述过长$/);assert.throws(()=>normalizeProject({name:'a',description:5},projectData()),/^Error: 描述过长$/);
 for(const workMode of ['both','ISOLATED','',null,['shared'],5])assert.throws(()=>normalizeProject({name:'a',workMode},projectData()),/^Error: 话题目录无效$/,String(workMode));
 for(const repo of ['','-oProxyCommand=x','ext::sh -c id','/srv/repo','~/repo','file:///srv/repo','http://','git@host','a b','https://host/a b','https://host/a\nb',5,null])
  assert.throws(()=>normalizeProject({name:'a',repos:[repo]},projectData()),/^Error: 仓库地址无效$/,String(repo));
 for(const repos of ['https://host/a',{}])assert.throws(()=>normalizeProject({name:'a',repos},projectData()),/^Error: 仓库地址无效$/);
 assert.throws(()=>normalizeProject({name:'a',repos:Array.from({length:21},(_,i)=>`https://host/r${i}`)},projectData()),/^Error: 仓库地址无效$/);
 assert.throws(()=>normalizeProject({name:'a',skills:['butler','missing']},projectData()),/^Error: skill 不存在：missing$/);assert.throws(()=>normalizeProject({name:'a',skills:'butler'},projectData()),/^Error: skill 不存在：/);
});
test('the name of a project is unique; a project keeps its id, its work mode and its adopted directory unless the change contradicts it: repositories or isolated topics release the adopted directory',()=>{
 const adopted={machineId:'m',dir:'~/code/projects'},first:Project={id:'p1',name:'projects',description:'',repos:[],skills:[],workMode:'shared',adopted};
 assert.throws(()=>normalizeProject({name:'projects'},projectData([first])),/^Error: 已有同名的项目$/);
 assert.deepEqual(normalizeProject({name:'projects',description:'一组仓库'},projectData([first]),first),{...first,description:'一组仓库'});
 assert.deepEqual(normalizeProject({name:'projects',workMode:'shared'},projectData([first]),first),first);
 const repo=normalizeProject({name:'projects',repos:['git@host.example:team/a.git']},projectData([first]),first);assert.deepEqual([repo.id,repo.workMode,repo.repos,'adopted' in repo],['p1','shared',['git@host.example:team/a.git'],false]);
 assert.equal('adopted' in normalizeProject({name:'projects',workMode:'isolated'},projectData([first]),first),false);
 assert.equal(normalizeProject({name:'projects',description:'x'},projectData([first]),first).adopted,adopted);
});
test('repositories are the same when their URLs name the same host and path whatever the form, and are named after the last part of the path',()=>{
 const same=['git@github.com:bezhai/herdr-self.git','https://github.com/bezhai/herdr-self','ssh://git@GitHub.com/bezhai/herdr-self.git/','http://user@github.com:8080/bezhai/herdr-self.git'];
 for(const url of same)assert.equal(repoKey(url),repoKey(same[0]),url);
 for(const url of ['git@github.com:bezhai/herdr.git','git@github.com:other/herdr-self.git','git@gitlab.com:bezhai/herdr-self.git'])assert.notEqual(repoKey(url),repoKey(same[0]),url);
 for(const url of same)assert.equal(repoName(url),'herdr-self',url);assert.equal(repoName('git@code.byted.org:growth/genvi.git'),'genvi');
 assert.equal(uniqueName('genvi',[]),'genvi');assert.equal(uniqueName('genvi',['genvi']),'genvi 2');assert.equal(uniqueName('genvi',['genvi','genvi 2','other']),'genvi 3');
});
const bindingData=(bindings:Binding[]=[])=>({bindings,projects:[routeProject],agentConfigs:[routeConfig,{...routeConfig,id:'c2',name:'cpu2 · Codex',kind:'codex'} as AgentConfig]});
test('a binding gives a chat a default agent configuration and, for a group, a default project; app, chat and its type come from Feishu, never from the client',()=>{
 const chat={appId:'a',chatId:'oc_1',chatType:'group' as const},input={name:'产品群',appId:'forged',chatId:'oc_forged',chatType:'p2p',defaultProjectId:'p',defaultAgentConfigId:'c2',requireMention:false};
 const {id,...b}=normalizeBinding({...input,rootId:'om_1',paneId:'w1:p1'},chat,bindingData());assert.match(id,/^[0-9a-f-]{36}$/);
 assert.deepEqual(b,{name:'产品群',appId:'a',chatId:'oc_1',chatType:'group',requireMention:false,enabled:true,defaultProjectId:'p',defaultAgentConfigId:'c2'});
 assert.equal(normalizeBinding({...input,requireMention:undefined},chat,bindingData()).requireMention,true);
 // A direct chat needs no mention and has no project; the configuration still decides what runs its topics.
 const dm={...chat,chatType:'p2p' as const},{id:dmId,...direct}=normalizeBinding({name:'私聊',defaultAgentConfigId:'c',requireMention:true},dm,bindingData());
 assert.deepEqual(direct,{name:'私聊',appId:'a',chatId:'oc_1',chatType:'p2p',requireMention:false,enabled:true,defaultAgentConfigId:'c'});
 for(const empty of [undefined,null,''])assert.equal('defaultProjectId' in normalizeBinding({name:'私聊',defaultProjectId:empty,defaultAgentConfigId:'c'},dm,bindingData()),false);
 assert.throws(()=>normalizeBinding({name:'私聊',defaultProjectId:'p',defaultAgentConfigId:'c'},dm,bindingData()),/^Error: 私聊不固定项目$/);
 for(const defaultProjectId of ['gone','',undefined,null,['p']])assert.throws(()=>normalizeBinding({...input,defaultProjectId},chat,bindingData()),/^Error: 项目不存在$/,String(defaultProjectId));
 for(const defaultAgentConfigId of ['gone','',undefined,['c']])for(const c of [chat,dm])assert.throws(()=>normalizeBinding({...input,defaultProjectId:c===chat?'p':undefined,defaultAgentConfigId},c,bindingData()),/^Error: Agent 配置不存在$/,String(defaultAgentConfigId));
 for(const name of ['',' ',undefined,'a'.repeat(61)])assert.throws(()=>normalizeBinding({...input,name},chat,bindingData()),/字段为空或过长/);
 assert.throws(()=>normalizeBinding(input,chat,bindingData([{appId:'a',chatId:'oc_1'} as Binding])),/该聊天已有绑定/);
 assert.equal(normalizeBinding(input,chat,bindingData([{appId:'other',chatId:'oc_1'},{appId:'a',chatId:'oc_2'}] as Binding[])).chatId,'oc_1');
});
test('adding a binding stores it, logs where it sends its topics and remembers its agent configuration for the next binding',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-binding-'));try{
  const store=new Store(dir);Object.assign(store.data,bindingData());
  const group=addBinding(store,{name:'产品群',defaultProjectId:'p',defaultAgentConfigId:'c2'},{appId:'a',chatId:'oc_1',chatType:'group'});
  assert.deepEqual(store.data.bindings,[group]);assert.equal(store.data.lastAgentConfigId,'c2');assert.deepEqual(new Store(dir).data.bindings,[group]);assert.equal(new Store(dir).data.lastAgentConfigId,'c2');
  const direct=addBinding(store,{name:'私聊',defaultAgentConfigId:'c'},{appId:'a',chatId:'oc_2',chatType:'p2p'});assert.equal(store.data.lastAgentConfigId,'c');
  assert.deepEqual(store.data.logs.map(l=>[l.kind,l.message]),[['会话绑定','产品群 → work · cpu2 · Codex'],['会话绑定','私聊 → 按任务自动选择 · cpu2 · Claude']]);
  // A binding that is refused changes nothing.
  assert.throws(()=>addBinding(store,{name:'重复',defaultProjectId:'p',defaultAgentConfigId:'c'},{appId:'a',chatId:'oc_1',chatType:'group'}),/该聊天已有绑定/);
  assert.deepEqual([store.data.bindings.length,store.data.lastAgentConfigId,direct.chatType],[2,'c','p2p']);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('changing a binding changes the fields that are given and nothing else: the project of a group, the configuration, the mention and whether it is on; the name follows Feishu',()=>{
 const data=bindingData(),group:Binding={...route,requireMention:true},other=normalizeProject({name:'另一个'},{projects:[],skills:[]});data.projects.push(other);
 changeBinding(group,{name:'改名',chatId:'oc_other',chatType:'p2p',defaultAgentConfigId:'c2'},data);assert.deepEqual(group,{...route,requireMention:true,defaultAgentConfigId:'c2'});
 changeBinding(group,{defaultProjectId:other.id,requireMention:false,enabled:false},data);assert.deepEqual(group,{...route,defaultProjectId:other.id,defaultAgentConfigId:'c2',requireMention:false,enabled:false});
 const before={...group};
 for(const [fields,error] of [[{defaultProjectId:'gone'},/项目不存在/],[{defaultProjectId:null},/项目不存在/],[{defaultAgentConfigId:'gone'},/Agent 配置不存在/],[{defaultAgentConfigId:['c']},/Agent 配置不存在/],
  [{requireMention:'yes'},/字段无效：requireMention/],[{enabled:1},/字段无效：enabled/],[{defaultAgentConfigId:'c',enabled:null},/字段无效：enabled/]] as [BindingFields,RegExp][]){
  assert.throws(()=>changeBinding(group,fields,data),error,JSON.stringify(fields));assert.deepEqual(group,before);
 }
 // A direct chat has no project and never needs the mention.
 const {defaultProjectId:_,...direct}=route,dm:Binding={...direct,chatType:'p2p',requireMention:false};
 changeBinding(dm,{defaultAgentConfigId:'c2',requireMention:true,defaultProjectId:''},data);assert.deepEqual(dm,{...direct,chatType:'p2p',requireMention:false,defaultAgentConfigId:'c2'});assert.throws(()=>changeBinding(dm,{defaultProjectId:'p'},data),/^Error: 私聊不固定项目$/);
 assert.equal(bindingTarget(group,data),'另一个 · cpu2 · Codex');assert.equal(bindingTarget(dm,data),'按任务自动选择 · cpu2 · Codex');assert.equal(bindingTarget({...group,defaultProjectId:'gone',defaultAgentConfigId:'gone'},data),'? · ?');
});
test('Bridge takes every message of a person; it can forward text, rich text, images and files with content of at most 16000 characters, and no other kind; mentions are left to topic handling',async()=>{
 const raw:Parameters<typeof normalize>[0]={sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{message_id:'om_message',chat_id:'oc_1',chat_type:'group',root_id:'om_root',message_type:'text',content:'{"text":"@_user_1 hi"}',mentions:[{key:'@_user_1',id:{open_id:'ou_bot'},name:'bot'}]}};
 const e=await normalize(raw,{botIdentity:{openId:'ou_bot',name:'bot'}}),of=(message_type:string,content:object)=>normalize({...raw,message:{...raw.message,message_type,content:JSON.stringify(content)}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(e.content.trim(),'hi');assert.equal(e.chatType,'group');assert.equal(e.mentionedBot,true);assert.equal(routable(e),true);assert.equal(routable({...e,senderType:'bot'}),false);assert.equal(routable({...e,senderId:''}),false);
 const other=await normalize({...raw,message:{...raw.message,mentions:[{key:'@_user_1',id:{open_id:'ou_other'},name:'other'}]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(other.mentionedBot,false);assert.equal(routable(other),true);
 const dm=await normalize({...raw,message:{...raw.message,chat_type:'p2p',root_id:undefined,mentions:[]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(dm.chatType,'p2p');assert.equal(routable(dm),true);
 const kinds=(x:NormalizedMessage)=>[routable(x),supported(x),forwardable(x)];
 const image=await of('image',{image_key:'img_1'}),file=await of('file',{file_key:'file_1',file_name:'a.pdf'}),post=await of('post',{content:[[{tag:'text',text:'看图'},{tag:'img',image_key:'img_2'}]]});
 assert.deepEqual([image.resources,file.resources,post.resources],[[{type:'image',fileKey:'img_1'}],[{type:'file',fileKey:'file_1',fileName:'a.pdf'}],[{type:'image',fileKey:'img_2'}]]);
 for(const x of [e,dm,image,file,post])assert.deepEqual(kinds(x),[true,true,true],x.rawContentType);
 // Stickers, merged forwards, cards and every other kind carry nothing Bridge can hand to an agent, whatever their content.
 for(const [type,content] of [['sticker',{file_key:'stk_1'}],['merge_forward',{}],['interactive',{elements:[]}],['audio',{file_key:'file_a'}],['media',{file_key:'file_v'}],['share_chat',{chat_id:'oc_x'}]] satisfies [string,object][]){const x=await of(type,content);assert.ok(x.content,type);assert.deepEqual(kinds(x),[true,false,false],type);}
 // Only the mention, blank, or more than 16000 characters: nothing to forward.
 const mention=await of('text',{text:'@_user_1'});assert.equal(mention.content,'');assert.deepEqual(kinds(mention),[true,true,false]);
 assert.equal(forwardable({...e,content:'  '}),false);assert.equal(forwardable({...e,content:'x'.repeat(16000)}),true);assert.equal(forwardable({...e,content:'x'.repeat(16001)}),false);assert.equal(forwardable({...e,senderType:'bot'} as NormalizedMessage),true);
});
// What the SDK makes of an image message with image key key, and of a sticker.
// A message as the SDK makes it, with the fields that a test gives.
type Received=Partial<NormalizedMessage>&Pick<NormalizedMessage,'rawContentType'|'content'>;
const imageOf=(key:string):Received=>({rawContentType:'image',content:`![image](${key})`,resources:[{type:'image',fileKey:key}]}),sticker:Received={rawContentType:'sticker',content:'<sticker key="stk_1"/>',resources:[{type:'sticker',fileKey:'stk_1'}]};
const imageMessage={...inbound,messageId:'om_image',...imageOf('img_1')},stickerMessage={...inbound,messageId:'om_sticker',...sticker};
const unsupportedText='暂不支持这类消息，目前只能转发文字、图片和文件';
test('the images and files of a message are numbered per kind and named in its prompt where they were: by absolute path, a file also by its name, or as failed; a path never ends a fragment that Claude Code would take as a pasted image',()=>{
 const post:Received={messageId:'om_1',rawContentType:'post',content:'看看这个报错 \n![image](img_b)\n还有![image](img_c)\n<file key="file_m"/>\n<file key="file_g" name="日志 &quot;1&quot;.txt"/>',
  resources:[{type:'image',fileKey:'img_b'},{type:'image',fileKey:'img_c'},{type:'file',fileKey:'file_m'},{type:'file',fileKey:'file_g',fileName:'日志 "1"\n.txt'}]};
 const list=attachmentsOf(post);assert.deepEqual(list.map(x=>[x.type,x.fileKey,x.index,x.n]),[['image','img_b',1,1],['image','img_c',2,2],['file','file_m',3,1],['file','file_g',4,2]]);
 const dir='/srv/my app/.herdr-bridge/t';Object.assign(list[0],{path:dir+'/om_1-1.png'});Object.assign(list[1],{reason:'下载失败'});Object.assign(list[2],{path:dir+'/om_1-3.mp4'});Object.assign(list[3],{path:dir+'/om_1-4.txt'});
 const prompt=promptOf(post,list);
 assert.equal(prompt,`看看这个报错 \n[图片 1：${dir}/om_1-1.png]\n还有[图片 2：下载失败]\n[文件 1：未命名文件，${dir}/om_1-3.mp4]\n[文件 2：日志 "1" .txt，${dir}/om_1-4.txt]`);
 // Claude Code splits pasted text on newlines and before a / that follows a space, and attaches a fragment that ends in an image extension.
 for(const fragment of prompt.split('\n').flatMap(l=>l.split(/ (?=\/)/)))assert.doesNotMatch(fragment,/\.(png|jpe?g|gif|webp)$/i,fragment);
 const file:Received={messageId:'om_2',rawContentType:'file',content:'<file key="file_f" name="报告 v2.pdf"/>',resources:[{type:'file',fileKey:'file_f',fileName:'报告 v2.pdf'}]};
 const [x]=attachmentsOf(file);assert.equal(promptOf(file,[{...x,path:'/srv/a/om_2-1.pdf'}]),'[文件 1：报告 v2.pdf，/srv/a/om_2-1.pdf]');assert.equal(promptOf(file,[{...x,reason:'超过 30 MB'}]),'[文件 1：下载失败]');
 assert.equal(promptOf(imageMessage,[{...attachmentsOf(imageMessage)[0],path:'/srv/a/om_image-1.jpg'}]),'[图片 1：/srv/a/om_image-1.jpg]');
 // Text that only looks like the markup of a resource stays as it is; a resource whose markup is missing is named at the end.
 const text={rawContentType:'text',content:' ![image](img_x) <file key="k"/> ',resources:[]};assert.deepEqual(attachmentsOf(text),[]);assert.equal(promptOf(text,[]),'![image](img_x) <file key="k"/>');
 const lost:Received={rawContentType:'post',content:'看图',resources:[{type:'image',fileKey:'img_z'}]};assert.equal(promptOf(lost,[{...attachmentsOf(lost)[0],path:'/a/om-1.png'}]),'看图\n[图片 1：/a/om-1.png]');
 // Only images and files count.
 assert.deepEqual(attachmentsOf(stickerMessage),[]);
});
test('an attachment is written as <message id>-<position>.<extension>: an image takes the extension of its content type, a file that of its name, else of its content type; a topic title leaves attachments out',()=>{
 const image={type:'image' as const,index:1},file={type:'file' as const,index:2};
 for(const [type,name] of [['image/png','om_1-1.png'],['image/jpeg','om_1-1.jpg'],['image/gif','om_1-1.gif'],['image/webp','om_1-1.webp'],['',  'om_1-1.jpg'],['application/octet-stream','om_1-1.jpg']])assert.equal(fileName('om_1',image,type),name,type);
 for(const [x,type,name] of ([[{fileName:'main.PY'},'application/octet-stream','om_1-2.py'],[{fileName:'a.tar.gz'},'','om_1-2.gz'],[{fileName:'说明'},'application/pdf','om_1-2.pdf'],[{fileName:'x.p y'},'text/plain','om_1-2.txt'],[{},'video/mp4','om_1-2.mp4'],[{fileName:'.env'},'',  'om_1-2.env'],[{},'','om_1-2.bin'],[{fileName:'a.'+'x'.repeat(17)},'','om_1-2.bin']] satisfies [{fileName?:string},string,string][]))assert.equal(fileName('om_1',{...file,...x},type),name,JSON.stringify(x));
 assert.equal(fileName('om_../x y',image,'image/png'),'om____x_y-1.png');
 assert.equal(titleOf({rawContentType:'post',content:'看看这个报错 \n![image](img_b)\n还有<file key="f" name="a.txt"/>',resources:[{type:'image',fileKey:'img_b'},{type:'file',fileKey:'f',fileName:'a.txt'}]} as Received),'看看这个报错 还有');
 assert.equal(titleOf(imageMessage),'图片');assert.equal(titleOf({rawContentType:'file',content:'<file key="f" name="a.txt"/>',resources:[{type:'file',fileKey:'f',fileName:'a.txt'}]} as Received),'文件');
 assert.equal(titleOf({rawContentType:'text',content:' ![image](x)  文字\n很长'+'长'.repeat(30),resources:[]} as Received),'![image](x) 文字 很长'+'长'.repeat(7));
 assert.deepEqual(limits,{image:10*1024*1024,file:30*1024*1024});
});
test('secrets are preserved only for the same application and are not part of the app status',()=>{const old={id:'a',appId:'cli_old',appSecret:'saved'} as App;assert.equal(normalizeApp({name:'bot',appId:'cli_old',allowedUsers:[]},old).appSecret,'saved');assert.throws(()=>normalizeApp({name:'bot',appId:'cli_new',allowedUsers:[]},old));
 const f=platformFixture();try{assert.ok(!('appSecret' in JSON.parse(JSON.stringify(f.platforms.status({...old,allowedUsers:[]})))));}finally{f.close();}
});
test('a routed message goes to the topic handler with its app and binding, whether or not it mentions the bot',()=>{
 const f=platformFixture();try{f.store.data.bindings=[{...route,requireMention:true}];f.platforms.receive(allowed,inbound);
 assert.deepEqual(f.messages,[[allowed,f.store.data.bindings[0],inbound]]);assert.deepEqual(f.store.data.logs,[]);}finally{f.close();}
});
test('messages from outside the allowlist, to a disabled app or from a bot are not passed on; a bound chat gets what can be forwarded and the kinds that cannot, but no empty or overlong message',()=>{
 const f=platformFixture();try{f.store.data.bindings=[route];const dm:NormalizedMessage={...inbound,chatId:'oc_2',chatType:'p2p'};
 for(const [app,msg] of [[allowed,{...inbound,senderId:'ou_other'}],[allowed,{...dm,senderId:'ou_other'}],[{...allowed,enabled:false},inbound],[{...allowed,enabled:false},dm],[allowed,{...dm,senderType:'bot'}],[allowed,{...imageMessage,senderType:'bot'}],[allowed,{...inbound,content:'  '}],[allowed,{...inbound,content:'x'.repeat(16001)}]] satisfies [App,NormalizedMessage][])f.platforms.receive(app,msg);
 assert.deepEqual([f.messages,f.unbound],[[],[]]);
 // A sticker goes on whatever its content, so that the topic handler can say that it is not supported.
 for(const msg of [imageMessage,stickerMessage,{...stickerMessage,messageId:'om_empty_sticker',content:''}])f.platforms.receive(allowed,msg);
 assert.deepEqual(f.messages.map(([a,b,msg])=>[a.id,b.id,msg.messageId]),[['a','b','om_image'],['a','b','om_sticker'],['a','b','om_empty_sticker']]);assert.deepEqual(f.unbound,[]);}finally{f.close();}
});
test('a chat without a binding asks for one on any direct message and on any group message that mentions the bot, whether empty, with an image or of a kind Bridge cannot forward; a disabled binding blocks both',()=>{
 const f=platformFixture();try{f.store.data.bindings=[route,{...route,id:'off',chatId:'oc_off',enabled:false}];
  const dm:NormalizedMessage={...inbound,chatId:'oc_dm',chatType:'p2p'},group:NormalizedMessage={...inbound,chatId:'oc_group',chatType:'group',mentionedBot:false},mentioned={...group,messageId:'om_2',mentionedBot:true};
  for(const [app,msg] of [[allowed,dm],[allowed,group],[allowed,mentioned],[allowed,{...mentioned,chatId:'oc_off'}],[allowed,{...dm,chatId:'oc_off'}],[{...allowed,id:'other'},{...inbound,chatType:'p2p'}]] satisfies [App,NormalizedMessage][])f.platforms.receive(app,msg);
  assert.deepEqual(f.unbound,[[allowed,dm],[allowed,mentioned],[{...allowed,id:'other'},{...inbound,chatType:'p2p'}]]);assert.deepEqual(f.messages,[]);
  // Only the mention, an image, a sticker: in a direct chat, or in a group with the mention.
  const variants=(msg:NormalizedMessage)=>[{...msg,messageId:msg.messageId+'-empty',content:''},{...imageMessage,chatId:msg.chatId,chatType:msg.chatType,mentionedBot:msg.mentionedBot,messageId:msg.messageId+'-image'},{...stickerMessage,chatId:msg.chatId,chatType:msg.chatType,mentionedBot:msg.mentionedBot,messageId:msg.messageId+'-sticker'}];
  f.unbound.length=0;for(const msg of [dm,group,mentioned].flatMap(variants))f.platforms.receive(allowed,msg);
  assert.deepEqual(f.unbound.map(([,msg])=>msg.messageId),['om_1-empty','om_1-image','om_1-sticker','om_2-empty','om_2-image','om_2-sticker']);assert.deepEqual(f.messages,[]);
 }finally{f.close();}
});
test('a state file with legacy message queues loads only the collections of the state; one from before schedules, skills, projects and agent configurations loads none',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-'));try{
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({machines:[{id:'m'}],apps:[{id:'a'}],bindings:[{id:'b'}],inbox:[{text:'old prompt'}],outbox:[{key:'k'}],logs:[{kind:'x'}]}));
  const store=new Store(dir);assert.deepEqual(store.data,{machines:[{id:'m'}],apps:[{id:'a'}],projects:[],agentConfigs:[],bindings:[{id:'b'}],topics:[],schedules:[],skills:[],logs:[{kind:'x'}]});
  store.data.schedules.push({id:'s'} as Schedule);store.data.skills.push({name:'k'} as Skill);store.save();assert.deepEqual(new Store(dir).data.schedules,[{id:'s'}]);assert.deepEqual(new Store(dir).data.skills,[{name:'k'}]);
  store.save();assert.ok(!fs.readFileSync(path.join(dir,'state.json'),'utf8').includes('old prompt'));
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('platform channels listen for messages, card clicks and connection events only, take clicks in their own queue and never retry a send',()=>{
 let options!:LarkChannelOptions;const handlers:Handlers={},f=platformFixture({channelFactory:o=>{options=o;return fakeChannel({on:(name:string,fn:Handlers[string])=>{handlers[name]=fn;}});}});
 try{f.platforms.channel({id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu'} as App);
 assert.deepEqual(Object.keys(handlers).sort(),['cardAction','error','message','reconnected','reconnecting']);assert.deepEqual(options.outbound,{retry:{maxAttempts:1}});
 // A click must not wait behind the chat's messages.
 assert.deepEqual(options.safety!.chatQueue,{enabled:true,mergeWhileBusy:false,cardActions:'separate'});}finally{f.close();}
});
test('replies go into the topic thread as cards, resolve to their message id and fail without a connected channel; cards are updated the same way',async()=>{
 const f=platformFixture(),sent:unknown[][]=[],updates:unknown[][]=[];try{
  await assert.rejects(f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0'}}),/飞书未连接/);await assert.rejects(f.platforms.updateCard(allowed,'om_card',{schema:'2.0'}),/飞书未连接/);
  f.platforms.runtime.set('a',runtimeOf({getConnectionStatus:()=>({state:'connected'}),send:async(...args:unknown[])=>{sent.push(args);return {messageId:'om_r'+sent.length};},updateCard:async(...args:unknown[])=>{updates.push(args);}}));
  assert.equal(await f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0'}}),'om_r1');assert.equal(await f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0',body:{}}}),'om_r2');
  assert.deepEqual(sent,[['oc_1',{card:{schema:'2.0'}},{replyTo:'om_1',replyInThread:true}],['oc_1',{card:{schema:'2.0',body:{}}},{replyTo:'om_1',replyInThread:true}]]);
  assert.equal(await f.platforms.updateCard(allowed,'om_r2',{schema:'2.0',body:{}}),undefined);assert.deepEqual(updates,[['om_r2',{schema:'2.0',body:{}}]]);
 }finally{f.close();}
});
test('a message of the bot outside any thread goes into the chat as a card without replyTo and resolves to its message id, which can root a topic; it fails without a connected channel',async()=>{
 const f=platformFixture(),sent:unknown[][]=[];try{
  await assert.rejects(f.platforms.send(allowed,'oc_1',{card:{schema:'2.0'}}),/飞书未连接/);
  f.platforms.runtime.set('a',runtimeOf({getConnectionStatus:()=>({state:'connected'}),send:async(...args:unknown[])=>{sent.push(args);return {messageId:'om_root'};}}));
  assert.equal(await f.platforms.send(allowed,'oc_1',{card:{schema:'2.0'}}),'om_root');assert.deepEqual(sent,[['oc_1',{card:{schema:'2.0'}}]]);
 }finally{f.close();}
});
test('a card click reaches the card handler with its app, whose answer goes back to Feishu; people outside the allowlist and clicks on a disabled app get a toast',()=>{
 const handlers:Handlers={},clicks:unknown[][]=[],f=platformFixture({channelFactory:()=>fakeChannel({on:(name:string,fn:Handlers[string])=>{handlers[name]=fn;}}),onCardAction:(...args)=>{clicks.push(args);return {toast:{type:'info',content:'正在提交'}};}});
 try{
  const a:App={...allowed,appId:'cli_test',appSecret:'private',domain:'feishu'};f.platforms.channel(a);
  const click=(openId:string)=>({messageId:'om_card',chatId:'oc_1',operator:{openId},action:{tag:'button',value:{request:1}}});
  assert.deepEqual(handlers.cardAction(click('ou_user')),{toast:{type:'info',content:'正在提交'}});assert.deepEqual(clicks,[[a,click('ou_user')]]);
  const refused={toast:{type:'error',content:'你不在这个应用的允许名单中，不能处理这个请求'}};
  assert.deepEqual(handlers.cardAction(click('ou_other')),refused);assert.deepEqual(handlers.cardAction({...click('ou_user'),operator:undefined}),refused);
  a.enabled=false;assert.deepEqual(handlers.cardAction(click('ou_user')),refused);assert.equal(clicks.length,1);
 }finally{f.close();}
});
test('message reactions are added and removed through the connected channel and fail without one',async()=>{
 const f=platformFixture(),calls:unknown[][]=[];try{
  await assert.rejects(f.platforms.react(allowed,'om_1','OneSecond'),/飞书未连接/);await assert.rejects(f.platforms.unreact(allowed,'om_1','r_1'),/飞书未连接/);
  const channel={getConnectionStatus:()=>({state:'reconnecting'}),addReaction:async(...args:unknown[])=>{calls.push(['add',...args]);return 'r_1';},removeReaction:async(...args:unknown[])=>{calls.push(['remove',...args]);}};
  f.platforms.runtime.set('a',runtimeOf(channel));
  await assert.rejects(f.platforms.react(allowed,'om_1','OneSecond'),/飞书未连接/);await assert.rejects(f.platforms.unreact(allowed,'om_1','r_1'),/飞书未连接/);assert.deepEqual(calls,[]);
  channel.getConnectionStatus=()=>({state:'connected'});
  assert.equal(await f.platforms.react(allowed,'om_1','OneSecond'),'r_1');assert.equal(await f.platforms.unreact(allowed,'om_1','r_1'),undefined);
  assert.deepEqual(calls,[['add','om_1','OneSecond'],['remove','om_1','r_1']]);
 }finally{f.close();}
});
// A response body that counts its reads; chunks are strings or buffers.
function body(chunks:string[]){const s:Readable&{reads:number}=Object.assign(new Readable({read(){s.reads++;this.push(chunks.length?Buffer.from(chunks.shift()!):null);}}),{reads:0});return s;}
test('a resource of a received message is downloaded through the connected channel with its content type; one whose length exceeds the limit is refused before its body is read, and a Feishu error keeps its code',async()=>{
 const f=platformFixture(),calls:unknown[]=[],answers:(()=>unknown)[]=[];try{
  await assert.rejects(f.platforms.download(allowed,'om_1',{type:'image',fileKey:'img_1'},10),/飞书未连接/);
  f.platforms.runtime.set('a',runtimeOf({getConnectionStatus:()=>({state:'connected'}),rawClient:{im:{v1:{messageResource:{get:async(o:unknown)=>{calls.push(o);return answers.shift()!();}}}}}}));
  const ok=body(['ab','cd']);answers.push(()=>({headers:{'content-type':'image/PNG; charset=binary','content-length':'4'},getReadableStream:()=>ok}));
  assert.deepEqual(await f.platforms.download(allowed,'om_1',{type:'image',fileKey:'img_1'},10),{body:Buffer.from('abcd'),type:'image/png'});
  assert.deepEqual(calls,[{path:{message_id:'om_1',file_key:'img_1'},params:{type:'image'}}]);
  // The length says too much: nothing of the body is read.
  const big=body(['x'.repeat(11)]);answers.push(()=>({headers:{'content-type':'application/pdf','content-length':'11'},getReadableStream:()=>big}));
  await assert.rejects(f.platforms.download(allowed,'om_2',{type:'file',fileKey:'file_1',fileName:'a.pdf'},10),(e:Thrown)=>e.code==='too_large');
  assert.deepEqual([big.reads,big.destroyed,calls[1]],[0,true,{path:{message_id:'om_2',file_key:'file_1'},params:{type:'file'}}]);
  // Without a length, or with a wrong one, the body counts as it comes.
  for(const headers of [{},{'content-length':'3'}]){const s=body(['123456','78901']);answers.push(()=>({headers,getReadableStream:()=>s}));await assert.rejects(f.platforms.download(allowed,'om_3',{type:'image',fileKey:'img_3'},10),(e:Thrown)=>e.code==='too_large',JSON.stringify(headers));assert.equal(s.destroyed,true);}
  const exact=body(['1234567890']);answers.push(()=>({headers:{},getReadableStream:()=>exact}));assert.deepEqual(await f.platforms.download(allowed,'om_4',{type:'image',fileKey:'img_4'},10),{body:Buffer.from('1234567890'),type:''});
  // Feishu answers an error with a JSON body, which the stream response carries as a stream.
  answers.push(()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:Readable.from([JSON.stringify({code:234003,msg:'File not in msg.'})])}});});
  await assert.rejects(f.platforms.download(allowed,'om_5',{type:'image',fileKey:'img_x'},10),(e:Thrown)=>e.code===234003&&e.message==='飞书接口错误 234003：File not in msg.');
  answers.push(()=>{throw Error('timeout of 10000ms exceeded');});await assert.rejects(f.platforms.download(allowed,'om_6',{type:'image',fileKey:'img_6'},10),/^Error: timeout of 10000ms exceeded$/);
 }finally{f.close();}
});
test('a topic starts on the machine of the binding\'s agent configuration, in the directory its project adopted there, and records the project, the configuration and the directory it started with; the workspace is the binding\'s on that machine',async()=>{
 const f=topicFixture({machines:[{id:'n',name:'cpu1',session:'default',enabled:true}],config:{machineId:'n',kind:'codex'},project:{adopted:{machineId:'n',dir:'~/other'}}});try{
  await f.send({messageId:'om_1',content:'one'});
  const [t]=f.store.data.topics;assert.deepEqual([t.state,t.machineId,t.projectId,t.agentConfigId,t.cwd,t.workspaceId],['ready','n','p','c','~/other','w1']);
  assert.deepEqual([...new Set(f.h.machines)],['n']);assert.deepEqual(f.h.calls[1],['workspace','create','--cwd',{path:'~/other'},'--label','飞书 · 个人助手','--no-focus']);
  assert.deepEqual(f.b.workspaces,{n:'w1'});assert.deepEqual(f.placed.map(p=>p.slice(0,3)),[['n','~/other','codex']]);
  // A reply starts nothing again and a topic that failed and is retried starts in the directory it chose first.
  f.project.adopted!.dir='~/moved';t.state='failed';await f.send({messageId:'om_2',rootId:'om_1',content:'again'});
  assert.deepEqual([t.state,t.cwd],['ready','~/other']);
 }finally{f.close();}
});
test('a topic whose project adopted its directory on another machine, that has no project (a direct chat) or whose agent configuration is gone fails to start with the reason, and its thread gets the notice',async()=>{
 const direct:Partial<Binding>={chatType:'p2p',defaultProjectId:undefined};
 for(const [options,reason] of [[{project:{adopted:{machineId:'n',dir:'~/other'}}},'这个项目的话题目录还没有实现'],[{project:{adopted:undefined}},'这个项目的话题目录还没有实现'],[{binding:direct},'项目不存在'],[{binding:{defaultAgentConfigId:'gone'}},'机器连接不存在']] satisfies [TopicOptions,string][]){
  const f=topicFixture(options);try{
   await f.send({messageId:'om_1',content:'one'});
   assert.deepEqual([f.store.data.topics[0].state,f.store.data.topics[0].error],['failed',reason]);assert.deepEqual(f.h.calls,[]);
   assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')],reason);
  }finally{f.close();}
 }
});
test('a start failure with a local path and an English Herdr error keeps them out of the Feishu notice',async()=>{
 const f=topicFixture(),raw='no herdr server is running at /home/someone/.config/herdr/herdr.sock; run `herdr server`';try{
  f.h.on['workspace list']=()=>{throw Error(raw);};await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);assert.ok(f.replies.every(r=>!JSON.stringify(r[3]).includes('/home/')&&!JSON.stringify(r[3]).includes('herdr server')));
  assert.equal(f.store.data.topics[0].error,raw);
 }finally{f.close();}
});
const mode=(p:string)=>fs.statSync(p).mode&0o777;
// Sets the modification time of directory p to n days ago.
const age=(p:string,n:number)=>{const t=(Date.now()-n*86400000)/1000;fs.utimesSync(p,t,t);};
// What storeFile and removeDirectory of the operations ops do on machine m, given the home directory that ~/ stands for there: files 0600 in
// directories 0700, a .gitignore of * that a person may change, and the clean-up of the other directories of the root.
async function storeFileBehaves({storeFile,removeDirectory}:Pick<Operations,'storeFile'|'removeDirectory'>,m:Machine,home:string){
 const body=Buffer.concat([Buffer.from("secret-marker ' \" $(id) `id`\n"),Buffer.from([0,255,10])]),root=path.join(home,'work','.herdr-bridge');
 const file=await storeFile(m,'~/work/.herdr-bridge','t1','om_1-1.png',body);
 assert.equal(file,path.join(root,'t1','om_1-1.png'));assert.deepEqual(fs.readFileSync(file),body);
 assert.deepEqual([mode(root),mode(path.join(root,'t1')),mode(file),mode(path.join(root,'.gitignore'))],[0o700,0o700,0o600,0o600]);assert.equal(fs.readFileSync(path.join(root,'.gitignore'),'utf8'),'*\n');
 fs.writeFileSync(path.join(root,'.gitignore'),'*\n!keep\n');
 // Directories of other topics unchanged for more than 7 days go, with what they hold; the topic written to stays however old.
 for(const [dir,days] of [['stale',8],['recent',6],['t1',30]] satisfies [string,number][]){fs.mkdirSync(path.join(root,dir),{recursive:true});fs.writeFileSync(path.join(root,dir,'x'),'');age(path.join(root,dir),days);}
 const absolute=path.join(home,'abs dir','.herdr-bridge');
 assert.equal(await storeFile(m,'~/work/.herdr-bridge','t1','om_2-1.pdf',Buffer.from('pdf')),path.join(root,'t1','om_2-1.pdf'));
 assert.deepEqual(fs.readdirSync(root).sort(),['.gitignore','recent','t1']);assert.deepEqual(fs.readdirSync(path.join(root,'t1')).sort(),['om_1-1.png','om_2-1.pdf','x']);assert.equal(fs.readFileSync(path.join(root,'.gitignore'),'utf8'),'*\n!keep\n');
 // An absolute root, here with a space, works the same.
 assert.equal(await storeFile(m,absolute,'t2','om_3-1.jpg',Buffer.from('jpg')),path.join(absolute,'t2','om_3-1.jpg'));assert.equal(fs.readFileSync(path.join(absolute,'t2','om_3-1.jpg'),'utf8'),'jpg');
 // A root that cannot be created fails.
 fs.writeFileSync(path.join(home,'file'),'');await assert.rejects(storeFile(m,path.join(home,'file','.herdr-bridge'),'t3','om_4-1.png',Buffer.from('x')));
 // removeDirectory removes a directory with what it holds; one that is gone already is fine.
 await removeDirectory(m,path.join(root,'t1'));assert.deepEqual(fs.readdirSync(root).sort(),['.gitignore','recent']);await removeDirectory(m,path.join(root,'t1'));
 await removeDirectory(m,'~/work/.herdr-bridge/recent');assert.deepEqual(fs.readdirSync(root),['.gitignore']);
 return body;
}

// Skills on the control plane (skills.ts). The files of a skill as the console and bridge-skill send them, {relative path: base64}; a
// SKILL.md with a frontmatter of name and description.
const encoded=(files:Record<string,string>)=>Object.fromEntries(Object.entries(files).map(([p,text])=>[p,Buffer.from(text).toString('base64')]));
const skillText=(name:string,description:string,body='')=>`---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
// The skills of a platform with its state in a directory of its own; call, when given, is how they reach the clients of machines (see Clients.call).
// Without call, a test reaches no machine.
function skillsFixture(call?:Call){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skill-store-')),store=new Store(dir);return {dir,store,skills:new Skills(store,call as Call),close(){fs.rmSync(dir,{recursive:true});}};}
test('the platform keeps a skill as a directory of files under the state directory and only its index in the state file: the name, the description of its frontmatter, whether it is loaded by default and the digest of its files',()=>{
 const f=skillsFixture();try{
  const files=encoded({'SKILL.md':skillText('alpha','用来测试','secret-body\n'),'ref/notes.md':'notes\n'}),entry=f.skills.put('alpha',files);
  assert.deepEqual(entry,{name:'alpha',description:'用来测试',preload:false,digest:entry.digest});assert.match(entry.digest,/^[0-9a-f]{64}$/);
  assert.deepEqual(f.store.data.skills,[entry]);assert.deepEqual(new Store(f.dir).data.skills,[entry]);
  assert.ok(!fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes('secret-body'));
  assert.deepEqual(tree(path.join(f.dir,'skills','alpha')),{'SKILL.md':skillText('alpha','用来测试','secret-body\n'),'ref/notes.md':'notes\n'});
  assert.deepEqual(f.skills.read('alpha'),{...entry,files});
  // The flag stays when the files are replaced; files that the new ones lack are gone, and the digest follows the content.
  f.skills.flag('alpha',true);const changed=f.skills.put('alpha',encoded({'SKILL.md':skillText('alpha','改过')}));
  assert.deepEqual(changed,{name:'alpha',description:'改过',preload:true,digest:changed.digest});assert.notEqual(changed.digest,entry.digest);
  assert.deepEqual(tree(path.join(f.dir,'skills','alpha')),{'SKILL.md':skillText('alpha','改过')});assert.deepEqual(fs.readdirSync(path.join(f.dir,'skills')),['alpha']);
  // The index is in the order of the names; a skill goes with its files.
  f.skills.put('beta',encoded({'SKILL.md':skillText('beta','b')}));f.skills.put('a1',encoded({'SKILL.md':skillText('a1','a')}));
  assert.deepEqual(f.skills.list().map(s=>s.name),['a1','alpha','beta']);
  f.skills.flag('alpha',false);assert.equal(f.skills.list()[1].preload,false);
  f.skills.remove('alpha');assert.deepEqual(f.store.data.skills.map(s=>s.name),['a1','beta']);assert.deepEqual(fs.readdirSync(path.join(f.dir,'skills')).sort(),['a1','beta']);
  for(const run of [()=>f.skills.read('alpha'),()=>f.skills.remove('alpha'),()=>f.skills.flag('alpha',true)])assert.throws(run,/^Error: skill 不存在：alpha$/);
 }finally{f.close();}
});
test('the console writes the SKILL.md of a skill as text: a new skill has that file alone and refuses a name in use; an edit keeps the other files and refuses a skill that does not exist',()=>{
 const f=skillsFixture();try{
  const entry=f.skills.save('gamma',skillText('gamma','g','正文\n'),{create:true});
  assert.deepEqual(entry,{name:'gamma',description:'g',preload:false,digest:entry.digest});assert.deepEqual(tree(path.join(f.dir,'skills','gamma')),{'SKILL.md':skillText('gamma','g','正文\n')});
  assert.throws(()=>f.skills.save('gamma',skillText('gamma','g'),{create:true}),/^Error: skill 已存在：gamma$/);
  f.skills.put('delta',encoded({'SKILL.md':skillText('delta','d'),'scripts/run.sh':'echo\n'}));f.skills.save('delta',skillText('delta','改过'));
  assert.deepEqual(tree(path.join(f.dir,'skills','delta')),{'SKILL.md':skillText('delta','改过'),'scripts/run.sh':'echo\n'});
  assert.throws(()=>f.skills.save('none',skillText('none','n')),/^Error: skill 不存在：none$/);assert.deepEqual(f.skills.list().map(s=>s.name),['delta','gamma']);
 }finally{f.close();}
});
test('a skill is refused, and nothing changes, without a SKILL.md whose frontmatter names it as its directory and describes it, with a name or a path that is not allowed, with content that is not base64, or when its files hold more than the limit together',()=>{
 const f=skillsFixture(),ok=skillText('alpha','a');try{
  for(const name of ['Alpha','../x','a b','-a','a-','a--b','a.b','','a'.repeat(65)])assert.throws(()=>f.skills.put(name,encoded({'SKILL.md':skillText(name,'a')})),/^Error: skill 名称无效/,name);
  for(const [files,error] of [[{},/^Error: skill 缺少 SKILL\.md$/],[{'SKILL.md':'# alpha\n'},/^Error: SKILL\.md 开头没有 frontmatter/],[{'SKILL.md':'---\nname: alpha\ndescription: a\n'},/^Error: SKILL\.md 开头没有 frontmatter/],
   [{'SKILL.md':skillText('beta','a')},/^Error: SKILL\.md 的 frontmatter 里 name 是 beta，必须和 skill 名称 alpha 一致$/],[{'SKILL.md':skillText('','a')},/^Error: SKILL\.md 的 frontmatter 里 name 是空的，必须和 skill 名称 alpha 一致$/],[{'SKILL.md':'---\nname: alpha\n---\n'},/^Error: SKILL\.md 的 frontmatter 缺少 description/],
   [{'SKILL.md':skillText('alpha','x'.repeat(1025))},/^Error: SKILL\.md 的 frontmatter 缺少 description，或者超过 1024 个字符$/],
   ...['../x','/abs','a//b','./a','a/../b','.herdr-bridge-skill'].map((p):[Record<string,string>,RegExp]=>[{'SKILL.md':ok,[p]:''},new RegExp('^Error: 文件路径无效：'+p.replace(/[./]/g,'\\$&')+'$')])] satisfies [Record<string,string>,RegExp][])
   assert.throws(()=>f.skills.put('alpha',encoded(files)),error,JSON.stringify(files).slice(0,80));
  assert.throws(()=>f.skills.put('alpha',{...encoded({'SKILL.md':ok}),'x.bin':'not base64!'}),/^Error: 文件内容不是 base64：x\.bin$/);
  for(const files of [null,[],'x',{'SKILL.md':1}])assert.throws(()=>f.skills.put('alpha',files),/^Error: skill 的文件无效$/,JSON.stringify(files));
  const over=skillLimit-Buffer.byteLength(ok)+1;
  assert.throws(()=>f.skills.put('alpha',encoded({'SKILL.md':ok,big:'x'.repeat(over)})),new RegExp(`^Error: skill 的文件合计 ${skillLimit+1} 字节，超过上限 ${skillLimit} 字节$`));
  assert.deepEqual(f.store.data.skills,[]);assert.deepEqual(fs.existsSync(path.join(f.dir,'skills'))?fs.readdirSync(path.join(f.dir,'skills')):[],[]);
  // Right at the limit is fine.
  assert.equal(f.skills.put('alpha',encoded({'SKILL.md':ok,big:'x'.repeat(over-1)})).name,'alpha');
 }finally{f.close();}
});
test('the frontmatter of SKILL.md is read as far as skills write YAML there: plain, quoted and block values, values that go on in indented lines, and nested maps skipped',()=>{
 const fields=(text:string)=>{const r=frontmatter(text);return r&&{name:r.name,description:r.description};};
 assert.deepEqual(fields('---\nname: a\ndescription: 一段 描述：带冒号\n---\nbody'),{name:'a',description:'一段 描述：带冒号'});
 assert.deepEqual(fields('---\nname: "a"\ndescription: "say \\"hi\\": now"\n---\n'),{name:'a',description:'say "hi": now'});
 assert.deepEqual(fields("---\nname: 'a'\ndescription: 'it''s'\n---\n"),{name:'a',description:"it's"});
 assert.deepEqual(fields('---\nname: a\ndescription: >\n  line one\n  line two\nmetadata:\n  requires:\n    bins: ["x"]\n  description: inner\n---\n'),{name:'a',description:'line one line two'});
 assert.deepEqual(fields('---\nname: a\ndescription: |-\n  first\n  second\n---\n'),{name:'a',description:'first\nsecond'});
 assert.deepEqual(fields('---\nname: a\ndescription: starts here\n  and goes on\n---\n'),{name:'a',description:'starts here and goes on'});
 assert.deepEqual(fields('---\r\nname: a\r\ndescription: b\r\n---\r\nbody'),{name:'a',description:'b'});
 for(const text of ['no frontmatter','---\nname: a\n','\n---\nname: a\n---\n'])assert.equal(frontmatter(text),null,text);
});
test('a search finds the skills whose name, description or SKILL.md hold every word in any case, those with the words in the name or the description first',()=>{
 const f=skillsFixture();try{
  f.skills.put('alpha',encoded({'SKILL.md':skillText('alpha','Deploy the service','uses kubectl\n')}));f.skills.put('beta',encoded({'SKILL.md':skillText('beta','部署文档','Deploy notes\n')}));
  f.skills.put('gamma',encoded({'SKILL.md':skillText('gamma','other')}));f.skills.put('deploy-check',encoded({'SKILL.md':skillText('deploy-check','检查')}));
  const names=(query:string)=>f.skills.search(query).map(s=>s.name);
  assert.deepEqual(names('deploy'),['alpha','deploy-check','beta']);assert.deepEqual(names(' DEPLOY   kubectl '),['alpha']);assert.deepEqual(names('部署'),['beta']);assert.deepEqual(names('none'),[]);
  assert.deepEqual(f.skills.search('deploy')[0],f.skills.list()[0]);
  for(const query of ['',' ',undefined,1])assert.throws(()=>f.skills.search(query),/^Error: 缺少要搜索的词$/,String(query));
 }finally{f.close();}
});

// Two skills of the platform for the placement tests, both loaded by default: alpha, with a file in a subdirectory and text that a shell would
// change, and beta.
function skillSource(skills:Skills){
 skills.put('alpha',encoded({'SKILL.md':skillText('alpha','a',"secret-marker ' \" $(id) `id`\n"),'ref/notes.md':'notes\n'}));skills.put('beta',encoded({'SKILL.md':skillText('beta','b')}));
 skills.flag('alpha',true);skills.flag('beta',true);
}
// What directory dir holds, through a link: {relative path: text} of its files.
const tree=(dir:string)=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const p=path.join(e.parentPath,e.name);return [path.relative(dir,p),fs.readFileSync(p,'utf8')];}));
// What placing the skills of a platform with its state in dir/state through call (see Skills.place) does on machine m, whose home directory
// is dir/home.
async function placeSkillsBehaves(call:Call,m:Machine,dir:string){
 const home=path.join(dir,'home'),kept=path.join(home,'.local/share/herdr-bridge/skills'),plain=path.join(home,'plain'),skills=new Skills(new Store(path.join(dir,'state')),call);
 const place=(...args:[string,Kind])=>skills.place(m,...args),files=(name:string)=>Object.fromEntries(Object.entries(skills.read(name).files).map(([p,b])=>[p,Buffer.from(b,'base64').toString()]));
 // The store and a copy hold a skill with Bridge's marker, which holds the digest of that skill.
 const marked=(p:string,name:string)=>{const {'.herdr-bridge-skill':mark,...rest}=tree(p);assert.equal(mark,skills.entry(name).digest+'\n',p);return rest;};
 skillSource(skills);fs.mkdirSync(plain);
 // Claude reads .claude/skills and Codex .agents/skills, here through links to the store of the machine, which holds each skill as the platform has it.
 assert.deepEqual(await place('~/plain','claude'),[]);assert.deepEqual(await place(plain,'codex'),[]);
 for(const at of ['.claude/skills','.agents/skills'])for(const name of ['alpha','beta'])assert.equal(fs.readlinkSync(path.join(plain,at,name)),path.join(kept,name));
 for(const name of ['alpha','beta'])assert.deepEqual(marked(path.join(kept,name),name),files(name));
 // Antigravity follows no link: Bridge's links become real directories with the same content, which Codex then keeps, as both read them.
 assert.deepEqual(await place(plain,'agy'),[]);assert.deepEqual(await place(plain,'codex'),[]);
 for(const name of ['alpha','beta']){const p=path.join(plain,'.agents/skills',name);assert.ok(fs.lstatSync(p).isDirectory(),p);assert.deepEqual(marked(p,name),files(name));}
 // Unchanged content is not written again: what the store and a copy hold stays, each a file of its own, since a copy comes from the store.
 const copy=path.join(plain,'.agents/skills/alpha'),extra=[path.join(kept,'alpha','store-extra'),path.join(copy,'copy-extra')];for(const p of extra)fs.writeFileSync(p,'');
 await place(plain,'claude');await place(plain,'agy');
 for(const p of extra)assert.ok(fs.existsSync(p),p);
 // Changed content replaces the skill in the store, which every link sees at once, and a copy at its next placement; nothing else is left behind.
 skills.put('alpha',encoded({'SKILL.md':skillText('alpha','changed')}));
 await place(plain,'claude');assert.deepEqual(marked(path.join(plain,'.claude/skills/alpha'),'alpha'),{'SKILL.md':skillText('alpha','changed')});assert.deepEqual(fs.readdirSync(kept).sort(),['alpha','beta']);
 await place(plain,'agy');assert.deepEqual(marked(copy,'alpha'),{'SKILL.md':skillText('alpha','changed')});
 // Same-name skills that are not Bridge's stay as they are and are reported: a link elsewhere, a directory without Bridge's marker.
 const other=path.join(home,'other'),theirs=path.join(dir,'theirs');fs.mkdirSync(theirs);fs.mkdirSync(path.join(other,'.claude/skills'),{recursive:true});fs.symlinkSync(theirs,path.join(other,'.claude/skills/alpha'));
 fs.mkdirSync(path.join(other,'.agents/skills/beta'),{recursive:true});fs.writeFileSync(path.join(other,'.agents/skills/beta/SKILL.md'),'theirs\n');
 assert.deepEqual(await place(other,'claude'),[path.join(other,'.claude/skills/alpha')]);assert.deepEqual(await place(other,'agy'),[path.join(other,'.agents/skills/beta')]);
 assert.equal(fs.readlinkSync(path.join(other,'.claude/skills/alpha')),theirs);assert.deepEqual(fs.readdirSync(theirs),[]);assert.deepEqual(tree(path.join(other,'.agents/skills/beta')),{'SKILL.md':'theirs\n'});
 assert.ok(fs.lstatSync(path.join(other,'.agents/skills/alpha')).isDirectory());
 // In a Git repository each placed path goes into info/exclude once, as git sees it, and git status stays clean. Here .claude/skills is a
 // link to ../.agents/skills, which holds a skill of the repository's own, beta: Claude's alpha is .agents/skills/alpha to git.
 const repo=path.join(home,'repo'),worktree=path.join(home,'repo-wt'),exclude=path.join(repo,'.git','info','exclude');
 fs.mkdirSync(path.join(repo,'.agents/skills/beta'),{recursive:true});fs.writeFileSync(path.join(repo,'.agents/skills/beta/SKILL.md'),'theirs\n');
 fs.mkdirSync(path.join(repo,'.claude'));fs.symlinkSync('../.agents/skills',path.join(repo,'.claude/skills'));fs.mkdirSync(path.join(repo,'sub'));fs.writeFileSync(path.join(repo,'sub','x'),'');
 git(repo,'init','-q','-b','main');git(repo,'add','.');git(repo,'commit','-q','-m','init');fs.writeFileSync(exclude,'# mine');
 assert.deepEqual(await place(repo,'claude'),[path.join(repo,'.claude/skills/beta')]);assert.equal(fs.readlinkSync(path.join(repo,'.agents/skills/alpha')),path.join(kept,'alpha'));
 assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n');assert.equal(git(repo,'status','--porcelain'),'');
 // Again, for Codex, and in a linked worktree, which shares info/exclude, nothing is added; a subdirectory adds its own paths.
 git(repo,'worktree','add','-q',worktree,'-b','wt');
 await place(repo,'claude');await place(repo,'codex');await place(worktree,'agy');
 assert.ok(fs.lstatSync(path.join(worktree,'.agents/skills/alpha')).isDirectory());assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n');assert.equal(git(worktree,'status','--porcelain'),'');
 await place(path.join(repo,'sub'),'claude');
 assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n/sub/.claude/skills/alpha\n/sub/.claude/skills/beta\n');assert.equal(git(repo,'status','--porcelain'),'');
 // A directory where the skills directory cannot be created fails the placement with what failed.
 fs.writeFileSync(path.join(home,'file'),'');await assert.rejects(place(path.join(home,'file'),'claude'),/file/);
 // A skill that is no longer loaded by default, or that is gone, goes from where Bridge placed it, as a link or a copy, at the next placement
 // there; same-name skills of others stay, and the lines of info/exclude too, which the linked worktrees of the repository share.
 skills.flag('beta',false);
 assert.deepEqual(await place(plain,'claude'),[]);await place(plain,'agy');await place(other,'agy');await place(path.join(repo,'sub'),'claude');
 assert.deepEqual(fs.readdirSync(path.join(repo,'sub','.claude/skills')),['alpha']);assert.deepEqual(fs.readdirSync(path.join(plain,'.claude/skills')),['alpha']);assert.deepEqual(fs.readdirSync(path.join(plain,'.agents/skills')),['alpha']);
 assert.deepEqual(fs.readdirSync(path.join(other,'.agents/skills')).sort(),['alpha','beta']);assert.deepEqual(tree(path.join(other,'.agents/skills/beta')),{'SKILL.md':'theirs\n'});
 await place(repo,'claude');assert.deepEqual(fs.readdirSync(path.join(repo,'.agents/skills')).sort(),['alpha','beta']);assert.deepEqual(tree(path.join(repo,'.agents/skills/beta')),{'SKILL.md':'theirs\n'});
 assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n/sub/.claude/skills/alpha\n/sub/.claude/skills/beta\n');assert.equal(git(repo,'status','--porcelain'),'');
 skills.remove('alpha');
 assert.deepEqual(await place(plain,'claude'),[]);await place(plain,'agy');assert.deepEqual(fs.readdirSync(path.join(plain,'.claude/skills')),[]);assert.deepEqual(fs.readdirSync(path.join(plain,'.agents/skills')),[]);
 assert.equal(fs.readlinkSync(path.join(other,'.claude/skills/alpha')),theirs);await place(other,'claude');assert.equal(fs.readlinkSync(path.join(other,'.claude/skills/alpha')),theirs);
 // Without skills to place, a directory without a skills directory does not get one.
 const fresh=path.join(home,'fresh');fs.mkdirSync(fresh);assert.deepEqual(await place(fresh,'claude'),[]);assert.deepEqual(fs.readdirSync(fresh),[]);
 // What the skill that came with earlier versions of Bridge left behind is Bridge's too: a store with the digest of the whole bundle at its
 // top and the skill without a marker, a link to it for Claude, and for Antigravity a copy marked with that digest. The skill of that name
 // on the platform takes their place, and they go once it is no longer loaded by default.
 const old=path.join(home,'old'),link=path.join(old,'.claude/skills/bridge-schedule'),copied=path.join(old,'.agents/skills/bridge-schedule');
 fs.writeFileSync(path.join(kept,'.digest'),'f'.repeat(64)+'\n');fs.mkdirSync(path.join(kept,'bridge-schedule'));fs.writeFileSync(path.join(kept,'bridge-schedule','SKILL.md'),'old\n');
 fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(path.join(kept,'bridge-schedule'),link);
 fs.mkdirSync(copied,{recursive:true});fs.writeFileSync(path.join(copied,'SKILL.md'),'old\n');fs.writeFileSync(path.join(copied,'.herdr-bridge-skill'),'f'.repeat(64)+'\n');
 skills.put('bridge-schedule',encoded({'SKILL.md':skillText('bridge-schedule','新的')}));skills.flag('bridge-schedule',true);
 assert.deepEqual(await place(old,'claude'),[]);assert.deepEqual(await place(old,'agy'),[]);
 assert.equal(fs.readlinkSync(link),path.join(kept,'bridge-schedule'));assert.deepEqual(marked(link,'bridge-schedule'),{'SKILL.md':skillText('bridge-schedule','新的')});
 assert.deepEqual(marked(copied,'bridge-schedule'),{'SKILL.md':skillText('bridge-schedule','新的')});
 skills.flag('bridge-schedule',false);await place(old,'claude');await place(old,'agy');
 assert.deepEqual(fs.readdirSync(path.dirname(link)),[]);assert.deepEqual(fs.readdirSync(path.dirname(copied)),[]);
}
test('skill placements run one after another on a machine and at once on different machines; each asks the client of its machine to place the skills loaded by default as they are when it runs, sent with their files and digests, and resolves or rejects with what the client answers',async()=>{
 const calls:[string,string,Sent][]=[],running:Record<string,number>={};let most=0,both=false;
 const fake=fakeCall(async(m,method,params)=>{
  calls.push([m.id,method,params]);running[m.id]=(running[m.id]||0)+1;most=Math.max(most,running[m.id]);both||=Object.values(running).filter(Boolean).length>1;
  await later(20);running[m.id]--;if(params.cwd==='/broken')throw Error("ENOTDIR: not a directory, mkdir '/broken/.agents/skills'");return ['/w/.claude/skills/beta'];
 });
 const f=skillsFixture(fake);
 try{
  skillSource(f.skills);f.skills.put('gamma',encoded({'SKILL.md':skillText('gamma','g')}));
  const place=(...args:Parameters<Skills['place']>)=>f.skills.place(...args),one={id:'m1'} as Machine,two={id:'m2'} as Machine;
  const results=await Promise.allSettled([place(one,'~/w','claude'),place(one,'/broken','codex'),place(one,'~/w','agy'),place(two,'/w','claude')]);
  assert.deepEqual([most,both],[1,true]);
  assert.deepEqual(results.map(r=>r.status==='fulfilled'?r.value:r.reason.message),[['/w/.claude/skills/beta'],"ENOTDIR: not a directory, mkdir '/broken/.agents/skills'",['/w/.claude/skills/beta'],['/w/.claude/skills/beta']]);
  const on=(id:string)=>calls.filter(c=>c[0]===id).map(c=>c[2]),[first,second,third]=on('m1');assert.ok(calls.every(c=>c[1]==='placeSkills'));
  const sent=(...names:string[])=>names.map(name=>{const {digest,files}=f.skills.read(name);return {name,digest,files};});
  assert.deepEqual(Object.keys(sent('alpha')[0].files),['SKILL.md','ref/notes.md']);
  assert.deepEqual(first,{store:'~/.local/share/herdr-bridge/skills',skills:sent('alpha','beta'),dir:'.claude/skills',as:'link',cwd:'~/w'});
  assert.deepEqual([second.dir,second.as,second.cwd],['.agents/skills','link','/broken']);assert.deepEqual([third.dir,third.as],['.agents/skills','copy']);
  // Which skills are loaded by default, and their content, are those of when the placement runs.
  f.skills.flag('beta',false);f.skills.put('alpha',encoded({'SKILL.md':skillText('alpha','changed')}));await place(two,'/w','claude');
  assert.deepEqual(on('m2')[1].skills,sent('alpha'));assert.notEqual(on('m2')[1].skills[0].digest,first.skills[0].digest);
  f.skills.flag('alpha',false);await place(two,'/w','claude');assert.deepEqual(on('m2')[2].skills,[]);
 }finally{f.close();}
});

test('an agent reads skills through the client of its machine: the index, a search, and a skill with the text of its SKILL.md, whose other files the client of the machine puts into its store first, after the placements queued there; nothing else, and nothing on a machine that Bridge does not use',async()=>{
 const calls:[string,string,Sent][]=[],fake=fakeCall(async(m,method,params)=>{calls.push([m.id,method,params]);await later(10);return '/home/u/.local/share/herdr-bridge/skills/'+(params.skill?.name??'');});
 const f=skillsFixture(fake),m={id:'m',name:'cpu2',enabled:true} as Machine;
 try{
  skillSource(f.skills);f.skills.put('gamma',encoded({'SKILL.md':skillText('gamma','g','读我\n')}));
  assert.deepEqual(await f.skills.answer(m,'list',{}),{skills:f.skills.list()});assert.deepEqual(await f.skills.answer(m,'search',{query:'GAMMA'}),{skills:[f.skills.entry('gamma')]});
  assert.deepEqual(await f.skills.answer(m,'read',{name:'gamma'}),{name:'gamma',description:'g',preload:false,text:skillText('gamma','g','读我\n'),files:[]});assert.deepEqual(calls,[]);
  // A skill with other files waits for the placement queued before on the machine, which shares the store.
  const placed=f.skills.place(m,'~/w','claude'),read=await f.skills.answer(m,'read',{name:'alpha'});await placed;
  assert.deepEqual(read,{name:'alpha',description:'a',preload:true,text:skillText('alpha','a',"secret-marker ' \" $(id) `id`\n"),files:['ref/notes.md'],path:'/home/u/.local/share/herdr-bridge/skills/alpha'});
  const {digest,files}=f.skills.read('alpha');assert.deepEqual(calls.map(c=>c[1]),['placeSkills','stockSkill']);
  assert.deepEqual(calls[1][2],{store:'~/.local/share/herdr-bridge/skills',skill:{name:'alpha',digest,files}});
  // Writes and anything else are refused, as are a body that is no object, a skill that does not exist and a machine that Bridge does not use.
  for(const op of ['import','save','put','preload','flag','remove','write','export','constructor'])await assert.rejects(f.skills.answer(m,op,{name:'alpha',files:{}}),new RegExp('^Error: 未知的操作：'+op+'$'),op);
  for(const body of [null,[],'x'])await assert.rejects(f.skills.answer(m,'list',body),/^Error: 请求内容无效$/,JSON.stringify(body));
  await assert.rejects(f.skills.answer(m,'read',{name:'none'}),/^Error: skill 不存在：none$/);await assert.rejects(f.skills.answer(m,'search',{}),/^Error: 缺少要搜索的词$/);
  await assert.rejects(f.skills.answer({...m,enabled:false},'list',{}),/^Error: Bridge 已断开机器 cpu2 的桥接$/);
  assert.equal(calls.length,2);assert.deepEqual(f.store.data.skills.map(x=>x.name),['alpha','beta','gamma']);
 }finally{f.close();}
});

const coded=(code:unknown,message:string)=>Object.assign(Error(message),{code});
// Git for the throwaway repositories of the tests: without the user's or the system's configuration and the HERDR_* variables, in English.
const gitEnv={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_'))),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.com',LC_ALL:'C'};
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,env:gitEnv,encoding:'utf8'}).trim();
const gitIn=(cwd:string,...args:string[])=>spawnSync('git',['-C',cwd,...args],{env:gitEnv,encoding:'utf8'});
// The --name value options of a Herdr command line.
const flags=(args:string[]):Record<string,string>=>Object.fromEntries(args.flatMap((a,i)=>a.startsWith('--')&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--')?[[a,args[i+1]]]:[]));
// In-memory Herdr: records every CLI call; h.on['<group> <verb>'] replaces the next such call and may call run(args) for the default result.
// Agents start idle with state_change_seq 1; a prompt returns the agent as it is.
// h.retained[paneId] holds the replies Herdr keeps for the agent of that pane. h.made records every makeDirectory as [machine id, path].
// h.requests[paneId] holds the requests the agent of that pane waits on; an answer removes its request.
// `pane remote-answers <pane> on|off` sets or clears remote_answers on the agent of that pane; turning it on for a pane without an agent fails.
// `pane close <pane>` removes the agent of that pane.
// `api snapshot` returns the agents with h.workspaces, h.tabs and h.panes, the entries that only carry what Bridge reads (ids and labels).
// h.hosts[machine id], when present, is another machine with its own agents, retained replies and requests; every call to a host with
// down fails with that message, or with down itself when it is an Error, such as the one of a machine whose client is offline; so does
// makeDirectory on h with down. h.toolCalls[paneId] holds the tool call records Herdr keeps for the agent of that pane; `agent send-keys`
// only succeeds. `worktree create`, `list` and `remove` run the real git on the throwaway repositories of the tests, as Herdr does: create
// adds the worktree and opens a workspace for it, which h.workspaces lists with its checkout and repository; list reports the workspace
// open for each worktree; remove removes the worktree of an open workspace and closes it.
const down=(host:{down?:string|Error})=>host.down instanceof Error?host.down:Error(host.down);
// What the fake Herdr keeps of a machine (see h.hosts); a workspace of a worktree also has its checkout and repository.
type FakeHost={agents:Agent[],retained:Record<string,Reply[]>,requests:Record<string,HerdrRequest[]>,toolCalls?:Record<string,ToolCall[]>,
 workspaces?:(Snapshot['workspaces'][number]&{checkout?:string,repo?:string})[],tabs?:(Snapshot['tabs'][number]&{workspace_id?:string})[],
 panes?:(Snapshot['panes'][number]&{workspace_id?:string,tab_id?:string})[],down?:string|Error};
// A hook of h.on: the arguments of the call, and run for the default result.
type Hook=(args:string[],run:(args:string[])=>unknown)=>unknown;
type FakeHerdr=FakeHost&Required<Pick<FakeHost,'workspaces'|'tabs'|'panes'|'toolCalls'>>&{calls:(readonly HerdrArg[])[],timeouts:(number|undefined)[],machines:string[],
 hosts:Record<string,FakeHost>,made:[string,string][],created:number,opened:number,on:Record<string,Hook>,claude?:Partial<Ran>|Error,placing?:string[]|Error,
 herdr:(m:Machine,args:readonly HerdrArg[],options?:{timeoutMs?:number})=>Promise<unknown>,makeDirectory:(m:Machine,dir:string)=>Promise<void>};
function fakeHerdr(){
 // herdr and makeDirectory follow.
 const h={calls:[],timeouts:[],machines:[],workspaces:[],tabs:[],panes:[],agents:[],retained:{},requests:{},toolCalls:{},hosts:{},made:[],created:0,opened:0,on:{}} as unknown as FakeHerdr;
 const run=(args:string[],host:FakeHost=h)=>{
  const [group,verb]=args;
  if(group==='workspace'&&verb==='list')return {type:'workspace_list',workspaces:h.workspaces};
  if(group==='workspace'&&verb==='create'){const id='w'+ ++h.created,n=++h.opened;h.workspaces.push({workspace_id:id,label:args[5]});return {type:'workspace_created',workspace:{workspace_id:id},tab:{tab_id:`${id}:t${n}`},root_pane:{pane_id:`${id}:p${n}`}};}
  if(group==='tab'&&verb==='rename')return {type:'tab_info',tab:{tab_id:args[2],label:args[3]}};
  if(group==='tab'&&verb==='create'){const n=++h.opened;return {type:'tab_created',tab:{tab_id:`${args[3]}:t${n}`},root_pane:{pane_id:`${args[3]}:p${n}`}};}
  // An agent that the fake starts has no ids of its workspace and tab, which Bridge reads only of agents that a topic adopts.
  if(group==='agent'&&verb==='start'){const agent={name:args[2],agent:args[4],pane_id:args[6],agent_status:'idle',state_change_seq:1} as Agent;h.agents.push(agent);return {type:'agent_started',agent,argv:[args[4]]};}
  if(group==='agent'&&verb==='list')return {type:'agent_list',agents:host.agents};
  if(group==='api'&&verb==='snapshot')return {type:'session_snapshot',snapshot:{workspaces:host.workspaces||[],tabs:host.tabs||[],panes:host.panes||[],agents:host.agents}};
  if(group==='agent'&&verb==='prompt')return {type:'agent_prompted',agent:host.agents.find(a=>a.pane_id===args[2])};
  if(group==='agent'&&verb==='replies'){const after=args[3]==='--after'?Number(args[4]):0;return {type:'agent_replies',agent:host.agents.find(a=>a.pane_id===args[2]),replies:(host.retained[args[2]]||[]).filter(r=>r.seq>after)};}
  if(group==='agent'&&verb==='requests')return {type:'agent_requests',agent:host.agents.find(a=>a.pane_id===args[2]),requests:host.requests[args[2]]||[]};
  if(group==='agent'&&verb==='tool-calls'){const after=args[3]==='--after'?Number(args[4]):0;return {type:'agent_tool_calls',agent:host.agents.find(a=>a.pane_id===args[2]),tool_calls:(host.toolCalls?.[args[2]]||[]).filter(c=>c.seq>after)};}
  if(group==='agent'&&verb==='send-keys')return {type:'ok'};
  if(group==='agent'&&verb==='answer'){
   const waiting=host.requests[args[2]]||[],r=waiting.find(x=>String(x.id)===args[3]);if(!r)throw coded('request_not_found','request not found');
   host.requests[args[2]]=waiting.filter(x=>x!==r);return {type:'agent_answered',agent:host.agents.find(a=>a.pane_id===args[2])};
  }
  if(group==='pane'&&verb==='close'){host.agents=host.agents.filter(a=>a.pane_id!==args[2]);return {type:'ok'};}
  if(group==='pane'&&verb==='remote-answers'){
   const agent=host.agents.find(a=>a.pane_id===args[2]);if(args[3]==='on'&&!agent)throw coded('agent_not_found',`pane ${args[2]} has no agent`);
   if(agent){if(args[3]==='on')agent.remote_answers=true;else delete agent.remote_answers;}return {type:'ok'};
  }
  if(group==='worktree'&&verb==='create'){
   const o=flags(args),local=gitIn(o['--cwd'],'show-ref','--verify','--quiet','refs/heads/'+o['--branch']).status===0;fs.mkdirSync(path.dirname(o['--path']),{recursive:true});
   const r=gitIn(o['--cwd'],'worktree','add',...local?[o['--path'],o['--branch']]:['-b',o['--branch'],o['--path'],o['--base']||'HEAD']);if(r.status!==0)throw coded('worktree_create_failed',r.stderr.trim());
   const id='w'+ ++h.created,n=++h.opened;h.workspaces.push({workspace_id:id,label:o['--branch'],checkout:o['--path'],repo:o['--cwd']});
   return {type:'worktree_created',workspace:{workspace_id:id},tab:{tab_id:`${id}:t${n}`},root_pane:{pane_id:`${id}:p${n}`},worktree:{path:o['--path'],branch:o['--branch'],is_linked_worktree:true,open_workspace_id:id}};
  }
  if(group==='worktree'&&verb==='list'){
   const r=gitIn(flags(args)['--cwd'],'worktree','list','--porcelain');if(r.status!==0)throw coded('not_git_worktree',r.stderr.trim());
   return {type:'worktree_list',worktrees:r.stdout.trim().split('\n\n').map(block=>{
    const field=(k:string)=>block.split('\n').find(l=>l.startsWith(k+' '))?.slice(k.length+1),checkout=field('worktree'),open=h.workspaces.find(w=>w.checkout===checkout);
    return {path:checkout,branch:field('branch')?.replace('refs/heads/',''),...open&&{open_workspace_id:open.workspace_id}};
   })};
  }
  if(group==='worktree'&&verb==='remove'){
   const w=h.workspaces.find(x=>x.workspace_id===args[3]&&x.checkout);if(!w)throw coded('workspace_not_found',`workspace ${args[3]} not found`);
   const r=gitIn(w.repo!,'worktree','remove',w.checkout!);if(r.status!==0)throw coded(/contains modified or untracked files/.test(r.stderr)?'dirty_worktree_requires_force':'worktree_remove_failed',r.stderr.trim());
   h.workspaces=h.workspaces.filter(x=>x!==w);return {type:'worktree_removed',workspace_id:w.workspace_id,path:w.checkout,forced:false};
  }
  throw Error('unexpected herdr '+args.join(' '));
 };
 // The fake reads only the arguments that are strings; a {path} argument is recorded as it is.
 h.herdr=async(m,args,options={})=>{
  h.calls.push(args);h.timeouts.push(options.timeoutMs);h.machines.push(m.id);await null;const host=h.hosts[m.id]||h;if(host.down)throw down(host);
  const key=args[0]+' '+args[1],hook=h.on[key];if(hook){delete h.on[key];return hook(args as string[],a=>run(a,host));}return run(args as string[],host);
 };
 h.makeDirectory=async(m,dir)=>{h.made.push([m.id,dir]);await null;if(h.down)throw down(h);};
 return h;
}
// Calls as [machine id, ...args].
const callsOn=(f:{h:FakeHerdr})=>f.h.calls.map((c,i)=>[f.h.machines[i],...c]);
const cotPath='/open-apis/im/v1/message_cot';
// The binding's machine m is cpu2; machines are further machines of the store. f.api records the Feishu OpenAPI requests of the topics,
// the COT calls: a COT is created as c<n> in message om_cot_<n>. With cot false Feishu refuses every request, like for an app without the
// scope. restart() reads the state file into a new Topics with the same fakes, as after a Bridge restart. now, when given, is the clock of the
// topics.
// f.downloads records every attachment download as [app id, message id, type, file key, limit]; f.resources[file key], when present,
// answers it, an error by throwing it, else the body is 'data:<file key>' of type image/png. f.stored records every file written as
// [machine id, root, dir, name, body as text], which resolves to its path with ~/ as /home/u/; f.removed every directory removed as
// [machine id, dir]. f.execs records the other operations on a machine (see operations in core.ts) as [machine id, 'git', cwd, ...args],
// [machine id, 'exists', path] and [machine id, 'askCheapModel', cwd]: git and exists run here for real (see gitEnv), and the naming answers
// from f.h.claude, by default with BRANCH=feat/add-login, as {code, stdout, stderr} or an Error to reject with; f.naming records each naming
// as {cwd, prompt, timeoutMs}. f.placed records every placement
// of Bridge's skills as [machine id, directory, agent kind, number of Herdr calls made before it]; it resolves to f.h.placing, by default
// no skills of others, or rejects with it when it is an Error.
type TopicOptions={binding?:Partial<Binding>,config?:Partial<AgentConfig>,project?:Partial<Project>,machine?:Partial<Machine>,machines?:Machine[],cot?:boolean,now?:()=>number};
// A card as a test reads it: the JSON that Bridge built.
type Card={schema?:string,config?:Record<string,any>,header?:{title:{tag?:string,content:string},template:string},body:{elements:Record<string,any>[]},[field:string]:unknown};
// An OpenAPI request of Bridge as a test reads it.
type ApiRequest={method:string,url:string,data:Record<string,any>,params?:Record<string,any>};
function topicFixture({binding,config,project,machine,machines=[],cot=true,now}:TopicOptions={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-')),store=new Store(dir),h=fakeHerdr(),replies:[string,string,string,{card:Card}][]=[],reacted:string[][]=[],unreacted:string[][]=[],
  updated:[string,string,Card][]=[],api:ApiRequest[]=[],m={id:'m',name:'cpu2',enabled:true,...machine} as Machine;
 const downloads:unknown[][]=[],resources:Record<string,{body:Buffer<ArrayBuffer>,type:string}|Error>={},stored:unknown[][]=[],removed:unknown[][]=[],execs:unknown[][]=[],
  naming:{cwd:string,prompt:string,timeoutMs?:number}[]=[],placed:unknown[][]=[];
 store.data.machines=[m,...machines];store.data.projects=[{...routeProject,...project}];store.data.agentConfigs=[{...routeConfig,...config}];store.data.bindings=[{...route,...binding}];store.save();
 const b=store.data.bindings[0];let sent=0,cots=0;
 // Every reply resolves to the next message id om_bot_<n>.
 // The fake answers each command with what Herdr prints for it, which its type cannot tie to the command.
 const deps:DepsOf<typeof Topics>={herdr:h.herdr as Herdr,makeDirectory:h.makeDirectory,machine:id=>{const x=store.data.machines.find(y=>y.id===id);if(!x)throw Error('机器连接不存在');return x;},app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},
  download:async(a,messageId,r,limit)=>{downloads.push([a.id,messageId,r.type,r.fileKey,limit]);await null;const x=resources[r.fileKey];if(x instanceof Error)throw x;return x||{body:Buffer.from('data:'+r.fileKey),type:'image/png'};},
  storeFile:async(m,root,dir,name,body)=>{stored.push([m.id,root,dir,name,String(body)]);await null;return root.replace(/^~\//,'/home/u/')+'/'+dir+'/'+name;},
  removeDirectory:async(m,dir)=>{removed.push([m.id,dir]);await null;},
  placeSkills:async(m,cwd,kind)=>{placed.push([m.id,cwd,kind,h.calls.length]);await null;if(h.placing instanceof Error)throw h.placing;return h.placing||[];},
  git:async(m,cwd,args)=>{execs.push([m.id,'git',cwd,...args]);await null;const r=gitIn(cwd,...args);return {code:r.status,stdout:r.stdout,stderr:r.stderr};},
  exists:async(m,p)=>{execs.push([m.id,'exists',p]);await null;return fs.existsSync(p);},
  askCheapModel:async(m,cwd,prompt,{timeoutMs}={})=>{
   execs.push([m.id,'askCheapModel',cwd]);naming.push({cwd,prompt,timeoutMs});await null;
   if(h.claude instanceof Error)throw h.claude;return {code:0,stdout:'BRANCH=feat/add-login\n',stderr:'',...h.claude};
  },
  reply:async(a,chatId,rootId,content)=>{replies.push([a.id,chatId,rootId,content as {card:Card}]);return 'om_bot_'+ ++sent;},
  react:async(a,messageId,emojiType)=>{reacted.push([a.id,messageId,emojiType]);return 'r_'+messageId;},unreact:async(a,messageId,reactionId)=>{unreacted.push([a.id,messageId,reactionId]);},
  updateCard:async(a,messageId,card)=>{updated.push([a.id,messageId,card as Card]);},
  request:async(a,o)=>{api.push(o as ApiRequest);await null;if(!cot)throw Object.assign(Error('飞书接口错误 99991672：Access denied'),{code:99991672});return o.method==='POST'&&o.url===cotPath?{cot_id:'c'+ ++cots,message_id:'om_cot_'+cots}:{};},...now&&{now}};
 const topics=new Topics(store,deps);
 const send=(msg:Partial<NormalizedMessage>)=>topics.handle(allowed,b,{senderType:'user',senderId:'ou_user',chatId:'oc_1',rawContentType:'text',...msg} as NormalizedMessage);
 const restart=()=>{const s=new Store(dir);return {store:s,topics:new Topics(s,deps)};};
 return {dir,store,h,m,topics,config:store.data.agentConfigs[0],project:store.data.projects[0],replies,reacted,unreacted,updated,api,downloads,resources,stored,removed,execs,naming,placed,b,send,restart,close(){fs.rmSync(dir,{recursive:true});}};
}
// The COT calls of fixture f in order: ['create', message the COT answers], ['update', cot id, ...[event type, event]] and ['complete', cot
// id, reason].
const cotLog=(f:{api:ApiRequest[]})=>f.api.map(o=>o.method==='PUT'?['update',o.data.cot_id,...o.data.events.map((e:{event_type:string,content:string})=>[e.event_type,JSON.parse(e.content)])]
 :o.url.startsWith(cotPath+'/complete/')?['complete',o.url.slice(cotPath.length+'/complete/'.length),o.params!.reason]:['create',o.data.origin_message_id]);
const cotLogs=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='执行过程').map(l=>[l.level,l.message]);
// An agent list with the agents of fixture f as they are, changed by fields.
const list=(f:{h:FakeHerdr},fields:Partial<Agent>)=>f.h.agents.map(a=>({...a,...fields}));
const later=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('a new topic creates the binding workspace, names its root tab after the topic, starts the agent there with a longer timeout, turns on remote answers for its pane and prompts it',async()=>{
 const f=topicFixture(),text='请帮我修复登录页在移动端点击提交按钮后没有任何反应的问题',title=text.slice(0,24);try{
  await f.send({messageId:'om_1',content:' '+text+'\n'});
  const [t]=f.store.data.topics,{id,agentName,createdAt,...rest}=t;
  assert.equal(agentName,'feishu-'+id.slice(0,8));assert.match(agentName,/^feishu-[0-9a-f]{8}$/);assert.ok(createdAt>0);
  assert.deepEqual(f.h.calls,[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w1:t1',title],['agent','start',agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1',text]]);
  assert.deepEqual(f.h.timeouts,[undefined,undefined,undefined,70000,undefined,undefined]);assert.deepEqual([...new Set(f.h.machines)],['m']);assert.equal(f.h.agents[0].remote_answers,true);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_1',machineId:'m',projectId:'p',agentConfigId:'c',cwd:'~/work',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',title,state:'ready',error:'',messageIds:['om_1'],replySeq:0,reactions:[],cards:[],
   cot:{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false}});
  assert.deepEqual(new Store(f.dir).data.bindings[0].workspaces,{m:'w1'});assert.equal(new Store(f.dir).data.topics[0].state,'ready');
  assert.deepEqual(f.replies,[]);assert.deepEqual(f.store.data.logs.map(l=>[l.kind,l.level,l.message]),[['话题会话','info',`个人助手：已在 cpu2 启动 ${agentName}`],['消息投递','info',`bot → 个人助手：已发送到 ${agentName}`]]);
 }finally{f.close();}
});
test('another topic opens a tab in the same workspace and turns on remote answers for its pane; replies in a topic prompt its pane without a new tab',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'第一个话题'});await f.send({messageId:'om_2',content:'第二个\n  话题'});
  const second=f.store.data.topics[1];
  assert.deepEqual(f.h.calls.slice(6),[['workspace','list'],['tab','create','--workspace','w1','--cwd',{path:'~/work'},'--label','第二个 话题','--no-focus'],['agent','start',second.agentName,'--kind','claude','--pane','w1:p2','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p2','on'],['agent','prompt','w1:p2','第二个\n  话题']]);
  assert.deepEqual([second.rootId,second.tabId,second.title],['om_2','w1:t2','第二个 话题']);
  f.h.calls.length=0;await f.send({messageId:'om_3',rootId:'om_1',content:'继续第一个'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','继续第一个']]);
  assert.equal(f.store.data.topics.length,2);assert.deepEqual(f.store.data.topics[0].messageIds,['om_1','om_3']);assert.deepEqual(f.replies,[]);
  // The first prompted message of each topic has its COT instead of a reaction.
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1','om_2','om_3']);assert.deepEqual(f.store.data.topics.map(t=>[t.cot!.origin,t.reactions.map(r=>r.messageId)]),[['om_1',['om_3']],['om_2',[]]]);
 }finally{f.close();}
});
test('a Claude configuration starts each topic agent with -- --permission-mode and its mode, default when it has none; a Codex configuration starts its agent with -- --no-daemon, the network of its sandbox on, so that bridge-schedule reaches the client of its machine, and past the review of new or changed hooks; an Antigravity configuration passes nothing on',async()=>{
 for(const [config,args] of [[{permissionMode:undefined},['--','--permission-mode','default']],[{permissionMode:'default'},['--','--permission-mode','default']],[{permissionMode:'auto'},['--','--permission-mode','auto']],
  [{kind:'codex'},['--','--no-daemon','-c','sandbox_workspace_write.network_access=true','--dangerously-bypass-hook-trust']],[{kind:'agy'},[]]] satisfies [Partial<AgentConfig>,string[]][]){
  const f=topicFixture({config});try{
   await f.send({messageId:'om_1',content:'one'});
   assert.deepEqual(f.h.calls.filter(c=>c[1]==='start'),[['agent','start',f.store.data.topics[0].agentName,'--kind',f.config.kind,'--pane','w1:p1','--timeout','60000',...args]],JSON.stringify(config));
  }finally{f.close();}
 }
});
test('a changed permission mode applies to the topics opened afterwards; a running topic keeps its agent',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});f.config.permissionMode='auto';
  await f.send({messageId:'om_2',rootId:'om_1',content:'more'});await f.send({messageId:'om_3',content:'two'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='start').map(c=>c.slice(-3)),[['--','--permission-mode','default'],['--','--permission-mode','auto']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[2]),['w1:p1','w1:p1','w1:p2']);
 }finally{f.close();}
});
test('a message id is persisted before any Herdr call and handled at most once; each topic keeps its latest 50 ids',async()=>{
 const f=topicFixture();try{
  let saved:Topic[]|undefined;f.h.on['workspace list']=(args,run)=>{saved=JSON.parse(fs.readFileSync(path.join(f.dir,'state.json'),'utf8')).topics;return run(args);};
  const msg={messageId:'om_1',content:'hi'};await Promise.all([f.send(msg),f.send(msg)]);await f.send(msg);
  assert.deepEqual(saved!.map(t=>[t.state,t.messageIds]),[['starting',['om_1']]]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);
  for(let i=2;i<=51;i++)await f.send({messageId:'om_'+i,rootId:'om_1',content:'m'+i});
  const ids=f.store.data.topics[0].messageIds;assert.equal(ids.length,50);assert.deepEqual([ids[0],ids.at(-1)],['om_2','om_51']);
 }finally{f.close();}
});
test('messages that arrive while a topic is starting share its tab and are prompted in order',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=async(args,run)=>{await later(20);return run(args);};
  await Promise.all([f.send({messageId:'om_1',content:'first'}),f.send({messageId:'om_2',rootId:'om_1',content:'second'}),f.send({messageId:'om_3',rootId:'om_1',content:'third'})]);
  assert.equal(f.store.data.topics.length,1);assert.equal(f.h.calls.filter(c=>c[1]==='create'||c[1]==='start').length,2);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['first','second','third']);
 }finally{f.close();}
});
test('topics opened at the same time create the binding workspace once',async()=>{
 const f=topicFixture();try{
  f.h.on['workspace create']=async(args,run)=>{await later(20);return run(args);};
  await Promise.all([f.send({messageId:'om_1',content:'one'}),f.send({messageId:'om_2',content:'two'})]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='create').map(c=>c[0]),['workspace','tab']);assert.deepEqual(f.store.data.topics.map(t=>t.paneId),['w1:p1','w1:p2']);
 }finally{f.close();}
});
test('a closed workspace is created again for the next new topic',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});f.h.workspaces.length=0;f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(f.h.calls.slice(0,4).map(c=>c.slice(0,2)),[['workspace','list'],['workspace','create'],['tab','rename'],['agent','start']]);
  assert.equal(f.b.workspaces!.m,'w2');assert.equal(f.store.data.topics[1].paneId,'w2:p2');
 }finally{f.close();}
});
test('a workspace id that Herdr reassigned to another workspace is not reused; a new workspace is created',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});f.h.workspaces[0].label='用户自己的工作区';f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(f.h.calls.slice(0,3),[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w2:t2','two']]);
  assert.equal(f.h.calls.some(c=>c[0]==='tab'&&c[1]==='create'),false);assert.deepEqual([f.b.workspaces!.m,f.store.data.topics[1].paneId],['w2','w2:p2']);
 }finally{f.close();}
});
test('each new topic creates its working directory on the machine before any workspace call, whether it creates the workspace or a tab in it',async()=>{
 const f=topicFixture();try{
  const seen:[string,string][][]=[],before:Hook=(args,run)=>{seen.push([...f.h.made]);return run(args);};
  f.h.on['workspace list']=before;await f.send({messageId:'om_1',content:'one'});
  f.h.on['workspace list']=before;await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(seen,[[['m','~/work']],[['m','~/work'],['m','~/work']]]);assert.deepEqual(f.h.calls.filter(c=>c[1]==='create').map(c=>c[0]),['workspace','tab']);
  // A message in a ready topic opens no tab and creates nothing.
  await f.send({messageId:'om_3',rootId:'om_1',content:'three'});assert.equal(f.h.made.length,2);
 }finally{f.close();}
});
test('a working directory that cannot be created fails the start like any start failure, before any workspace or tab is created',async()=>{
 const f=topicFixture(),raw="mkdir: cannot create directory '/srv/app': Permission denied";try{
  f.topics.makeDirectory=async()=>{throw Error(raw);};
  await f.send({messageId:'om_1',content:'one'});
  const t=f.store.data.topics[0];assert.deepEqual([t.state,t.error],['failed',raw]);assert.equal(new Store(f.dir).data.topics[0].state,'failed');
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.match(f.store.data.logs.at(-1)!.message,/启动失败.*Permission denied/);
 }finally{f.close();}
});
const skillLogs=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='skill').map(l=>[l.level,l.message]);
test('right before a new topic starts its agent, Bridge\'s skills are placed for the binding\'s agent kind in its working directory on its machine: in a new workspace, in a tab of the existing one and in a topic that begin opens; a message in a ready topic places nothing',async()=>{
 for(const kind of ['claude','codex','agy'] satisfies Kind[]){
  const f=topicFixture({config:{kind}});try{
   await f.send({messageId:'om_1',content:'one'});await f.send({messageId:'om_2',content:'two'});
   await f.topics.begin(allowed,f.b,'om_root',{title:'报告',msg:{messageId:'om_root',content:'写报告'}}).delivered;
   await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
   const starts=f.h.calls.flatMap((c,i)=>c[1]==='start'?[i]:[]);assert.equal(starts.length,3);
   assert.deepEqual(f.placed,starts.map(i=>['m','~/work',kind,i]),kind);assert.deepEqual(skillLogs(f),[]);
  }finally{f.close();}
 }
});
test('a placement of skills that fails is only logged, and the topic starts and prompts its agent as usual; same-name skills that are not Bridge\'s are logged as left alone',async()=>{
 const f=topicFixture(),raw="mkdir: cannot create directory '/home/u/work/.claude': Permission denied";try{
  f.h.placing=Error(raw);await f.send({messageId:'om_1',content:'one'});
  assert.equal(f.store.data.topics[0].state,'ready');assert.deepEqual(f.h.calls.at(-1),['agent','prompt','w1:p1','one']);assert.deepEqual(f.replies,[]);
  f.h.placing=['/home/u/work/.claude/skills/bridge-schedule'];await f.send({messageId:'om_2',content:'two'});
  assert.equal(f.store.data.topics[1].state,'ready');
  assert.deepEqual(skillLogs(f),[['error',`个人助手：未能在 ~/work 放置 skill，${raw}`],['info','个人助手：/home/u/work/.claude/skills/bridge-schedule 已有同名 skill，不是 Bridge 放的，没有改动']]);
 }finally{f.close();}
});
test('a topic whose named agent is gone is closed with one notice and gets no further prompts',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});
  f.h.agents.splice(0,1,{name:'someone-else',pane_id:'w1:p1',agent_status:'idle'} as Agent);f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(f.store.data.topics[0].state,'closed');
  assert.deepEqual(f.replies,[['a','oc_1','om_1',notice('该话题的会话已结束，请发起新话题')]]);
 }finally{f.close();}
});
test('a failed start marks the topic failed with a notice that carries no error details; the next message retries in a new tab',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','agent target pane w1:p1 is not an available shell');};
  await f.send({messageId:'om_1',content:'one'});
  const t=f.store.data.topics[0];assert.deepEqual([t.state,t.error],['failed','agent target pane w1:p1 is not an available shell']);assert.equal(new Store(f.dir).data.topics[0].state,'failed');
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);assert.match(f.store.data.logs.at(-1)!.message,/agent target pane w1:p1 is not an available shell/);assert.equal(f.h.calls.some(c=>c[1]==='prompt'),false);
  f.h.calls.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.h.calls,[['workspace','list'],['tab','create','--workspace','w1','--cwd',{path:'~/work'},'--label','one','--no-focus'],['agent','start',t.agentName,'--kind','claude','--pane','w1:p2','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p2','on'],['agent','prompt','w1:p2','two']]);
  assert.deepEqual([t.state,t.error,t.paneId,f.store.data.topics.length],['ready','','w1:p2',1]);
 }finally{f.close();}
});
test('a topic on a disconnected machine fails without calling Herdr',async()=>{
 const f=topicFixture({machine:{enabled:false}});try{
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual([f.h.calls,f.store.data.topics[0].state,f.store.data.topics[0].error,f.replies.map(r=>r[3])],[[],'failed','机器连接已停用',[notice('启动失败，请在 Bridge 管理台查看原因')]]);
 }finally{f.close();}
});
test('while the client of its machine is offline, a new topic does not start and says so in its thread, and the next message retries it; a message to a ready topic is not prompted and gets the same notice',async()=>{
 const f=topicFixture(),offline=coded('client_offline','机器 cpu2 离线：它的 Bridge 客户端没有连上');try{
  f.h.down=offline;await f.send({messageId:'om_1',content:'one'});
  const t=f.store.data.topics[0];assert.deepEqual([t.state,t.error],['failed',offline.message]);
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('机器 cpu2 离线：它的 Bridge 客户端没有连上。话题没有启动，请稍后重发消息')]);
  delete f.h.down;await f.send({messageId:'om_2',rootId:'om_1',content:'two'});assert.equal(t.state,'ready');
  f.h.down=offline;f.replies.length=0;await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('机器 cpu2 离线：它的 Bridge 客户端没有连上。这条消息没有发给 Agent，请稍后重发')]);
  assert.equal(t.state,'ready');assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['two']);
 }finally{f.close();}
});
test('agent_not_ready at start still opens the topic after turning on remote answers; agent_blocked sends a notice; other prompt errors are only logged',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=(args,run)=>{run(args);throw coded('agent_not_ready','agent is blocked during startup and is not ready for prompts');};
  f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked and requires interactive input');};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.h.calls.slice(3,5).map(c=>c.slice(0,2)),[['agent','start'],['pane','remote-answers']]);assert.equal(f.h.agents[0].remote_answers,true);
  assert.equal(f.store.data.topics[0].state,'ready');assert.deepEqual(f.replies.map(r=>r[3]),[notice('Agent 正在等待确认，请到 Herdr 中处理后重发这条消息')]);
  f.h.on['agent prompt']=()=>{throw coded('agent_prompt_failed','pty closed');};f.replies.length=0;const logs=f.store.data.logs.length;
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.replies,[]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,2);assert.equal(f.store.data.topics[0].state,'ready');
  const errors=f.store.data.logs.slice(logs);assert.equal(errors.length,1);assert.equal(errors[0].level,'error');assert.match(errors[0].message,/pty closed/);
 }finally{f.close();}
});
test('remote answers are turned on while the topic is still starting, after its agent started; a topic whose pane cannot get them fails to start',async()=>{
 const f=topicFixture();try{
  let during;f.h.on['pane remote-answers']=(args,run)=>{during=[f.store.data.topics[0].state,f.h.agents.map(a=>a.pane_id)];return run(args);};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(during,['starting',['w1:p1']]);assert.equal(f.store.data.topics[0].state,'ready');
  f.h.on['pane remote-answers']=()=>{throw coded('agent_not_found','pane w1:p2 has no agent');};
  await f.send({messageId:'om_2',content:'two'});
  const t=f.store.data.topics[1];assert.deepEqual([t.state,t.error],['failed','pane w1:p2 has no agent']);
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);
 }finally{f.close();}
});
test('a binding that requires the mention ignores every message without it, a follow-up in a topic thread too: it is not recorded and gets no reaction, prompt, notice or COT',async()=>{
 const f=topicFixture({binding:{requireMention:true}});try{
  await f.send({messageId:'om_1',content:'no mention'});assert.deepEqual([f.store.data.topics.length,f.h.calls.length],[0,0]);
  await f.send({messageId:'om_2',content:'with mention',mentionedBot:true});const t=f.store.data.topics[0];
  f.h.calls.length=0;f.reacted.length=0;f.api.length=0;delete t.cot;
  await f.send({messageId:'om_3',rootId:'om_2',content:'follow-up'});
  assert.deepEqual([f.h.calls,f.reacted,f.replies,f.api,t.messageIds,new Store(f.dir).data.topics[0].messageIds],[[],[],[],[],['om_2'],['om_2']]);
  await f.send({messageId:'om_4',rootId:'om_2',content:'mentioned follow-up',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','mentioned follow-up']]);assert.deepEqual(t.messageIds,['om_2','om_4']);
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_4']);assert.deepEqual(cotLog(f)[0],['create','om_4']);
 }finally{f.close();}
});
test('a binding without the mention requirement, which every direct chat has, handles messages without the mention: a root message, a follow-up in its thread and /stop',async()=>{
 const f=topicFixture({binding:{requireMention:false}});try{
  await f.send({messageId:'om_1',content:'one'});await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  f.h.agents[0].agent_status='working';await f.send({messageId:'om_3',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.h.calls.filter(c=>['prompt','send-keys'].includes(c[1])),[['agent','prompt','w1:p1','one'],['agent','prompt','w1:p1','two'],['agent','send-keys','w1:p1','esc']]);
  assert.deepEqual(f.store.data.topics[0].messageIds,['om_1','om_2','om_3']);
 }finally{f.close();}
});
test('begin opens a topic of the binding under any root message, also one the bot posted, and gives its agent a text: the record is on disk before anything is awaited, nothing gets a reaction, the COT answers the root and the given fields go into the record',async()=>{
 const f=topicFixture();try{
  const {topic,delivered}=f.topics.begin(allowed,f.b,'om_root',{title:'每天的报告',msg:{messageId:'om_root',content:' 写一份报告\n'},fields:{scheduled:{id:'s1',n:1}}});
  assert.deepEqual(f.store.data.topics,[topic]);assert.deepEqual(new Store(f.dir).data.topics.map(t=>[t.rootId,t.state,t.messageIds,t.scheduled]),[['om_root','starting',['om_root'],{id:'s1',n:1}]]);
  const agent=await delivered;
  assert.equal(agent!.pane_id,'w1:p1');assert.deepEqual([topic.state,topic.title,topic.chatId,topic.machineId],['ready','每天的报告','oc_1','m']);
  assert.deepEqual(f.h.calls.slice(2),[['tab','rename','w1:t1','每天的报告'],['agent','start',topic.agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1','写一份报告']]);
  assert.deepEqual([f.reacted,f.replies],[[],[]]);assert.deepEqual(cotLog(f)[0],['create','om_root']);assert.equal(topic.cot!.origin,'om_root');
  // A topic that fails to start resolves to nothing.
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','busy');};
  assert.equal(await f.topics.begin(allowed,f.b,'om_root2',{title:'x',msg:{messageId:'om_root2',content:'x'}}).delivered,undefined);assert.equal(f.store.data.topics[1].state,'failed');
 }finally{f.close();}
});
test('a message of a person in a topic that a schedule opened records when it came; other topics record nothing new',async()=>{
 let clock=1000;const f=topicFixture({now:()=>clock});try{
  const {topic}=f.topics.begin(allowed,f.b,'om_root',{title:'t',msg:{messageId:'om_root',content:'task'},fields:{scheduled:{id:'s1',n:1}}});await f.topics.queue(topic,()=>{});
  assert.equal(topic.createdAt,1000);assert.equal(topic.scheduled!.messageAt,undefined);
  clock=5000;await f.send({messageId:'om_2',rootId:'om_root',content:'追问'});
  assert.deepEqual(topic.scheduled,{id:'s1',n:1,messageAt:5000});assert.equal(new Store(f.dir).data.topics[0].scheduled!.messageAt,5000);
  await f.send({messageId:'om_3',content:'own topic'});await f.send({messageId:'om_4',rootId:'om_3',content:'more'});
  assert.equal('scheduled' in f.store.data.topics[1],false);assert.equal(f.store.data.topics[1].createdAt,5000);
 }finally{f.close();}
});
test('retiring a ready topic closes the pane of its agent, which takes its tab along, and then ends the topic with the notice given; a topic whose agent is gone ends without closing anything, and a pane that cannot be closed leaves the topic as it was',async()=>{
 const f=topicFixture();try{
  for(const [i,content] of ['one','two','three'].entries())await f.send({messageId:'om_'+(i+1),content});
  const [one,two,three]=f.store.data.topics;f.h.calls.length=0;f.replies.length=0;f.api.length=0;
  await f.topics.retire(one,'已关闭');
  assert.deepEqual(f.h.calls,[['agent','list'],['pane','close','w1:p1']]);assert.equal(one.state,'closed');assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',notice('已关闭')]]);
  assert.deepEqual(cotLog(f).map(c=>c[0]),['update','complete']);assert.equal(one.cot,undefined);assert.deepEqual(f.store.data.logs.at(-1)!.message,`${one.agentName}：已关闭 pane w1:p1`);
  // The pane id of an agent that is gone may name another pane by now.
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w1:p2');f.h.calls.length=0;f.replies.length=0;
  await f.topics.retire(two,'已关闭');
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(two.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('该话题的会话已结束，请发起新话题')]);
  f.h.on['pane close']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};f.replies.length=0;
  await f.topics.retire(three,'已关闭');
  assert.equal(three.state,'ready');assert.deepEqual(f.replies,[]);assert.deepEqual(f.store.data.logs.at(-1)!.message,`${three.agentName}：未能关闭 pane，连接超时，请检查 SSH 与 Herdr 状态`);
  // A topic that is not ready is left alone.
  f.h.calls.length=0;await f.topics.retire(one,'已关闭');assert.deepEqual(f.h.calls,[]);
 }finally{f.close();}
});
test('topics still starting when Bridge restarts are marked failed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-'));try{
  const store=new Store(dir);store.data.topics=[{id:'t1',state:'starting',error:''},{id:'t2',state:'ready',error:''},{id:'t3',state:'choosing',error:'',adopted:{picker:'om_card'}}] as Topic[];store.save();
  // Starting reads only the state file.
  new Topics(new Store(dir),{herdr:async()=>{},machine:()=>{},reply:async()=>{}} as unknown as DepsOf<typeof Topics>);
  assert.deepEqual(new Store(dir).data.topics.map(t=>[t.state,t.error]),[['failed','Bridge 重启时 Agent 启动未完成'],['ready',''],['choosing','']]);
 }finally{fs.rmSync(dir,{recursive:true});}
});
const attachmentLogs=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='附件').map(l=>[l.level,l.message]);
test('the images and files of a message are downloaded and written into the topic directory under the binding working directory before the prompt, which names them by absolute path where they were; the title leaves them out',async()=>{
 const f=topicFixture();try{
  let before!:typeof f.stored;const capture=()=>{f.h.on['agent prompt']=(args,run)=>{before=[...f.stored];return run(args);};};capture();
  f.resources.file_g={body:Buffer.from('log'),type:'text/plain'};
  await f.send({messageId:'om_1',rawContentType:'post',content:'看看这个报错 \n![image](img_b)\n<file key="file_g" name="日志 1.log"/>',resources:[{type:'image',fileKey:'img_b'},{type:'file',fileKey:'file_g',fileName:'日志 1.log'}]});
  const t=f.store.data.topics[0],dir=`/home/u/work/.herdr-bridge/${t.id}`;
  assert.deepEqual(f.downloads,[['a','om_1','image','img_b',limits.image],['a','om_1','file','file_g',limits.file]]);
  assert.deepEqual(f.stored,[['m','~/work/.herdr-bridge',t.id,'om_1-1.png','data:img_b'],['m','~/work/.herdr-bridge',t.id,'om_1-2.log','log']]);assert.deepEqual(before,f.stored);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt'),[['agent','prompt','w1:p1',`看看这个报错 \n[图片 1：${dir}/om_1-1.png]\n[文件 1：日志 1.log，${dir}/om_1-2.log]`]]);
  assert.deepEqual([t.title,f.h.calls[2]],['看看这个报错',['tab','rename','w1:t1','看看这个报错']]);
  assert.equal(t.attachmentDir,dir);assert.equal(new Store(f.dir).data.topics[0].attachmentDir,dir);assert.deepEqual(f.replies,[]);assert.deepEqual(attachmentLogs(f),[]);
  // In the ready topic, an image alone; then text, which downloads nothing.
  f.h.calls.length=0;capture();await f.send({messageId:'om_2',rootId:'om_1',...imageOf('img_c')});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1',`[图片 1：${dir}/om_2-1.png]`]]);assert.equal(before.length,3);
  await f.send({messageId:'om_3',rootId:'om_1',content:'谢谢'});assert.deepEqual([f.downloads.length,f.stored.length],[3,3]);
  // A topic that an image alone opens is called 图片.
  await f.send({messageId:'om_4',...imageOf('img_d')});assert.equal(f.store.data.topics[1].title,'图片');assert.deepEqual(f.stored.at(-1)!.slice(2,4),[f.store.data.topics[1].id,'om_4-1.png']);
 }finally{f.close();}
});
test('an attachment that cannot be downloaded, exceeds its limit or cannot be written is named as failed in the prompt, which still goes out after one notice in the topic; the details are only logged',async()=>{
 const f=topicFixture();try{
  Object.assign(f.resources,{img_big:coded('too_large','超过上限'),img_gone:coded(234003,'飞书接口错误 234003：File not in msg.'),file_big:coded('too_large','超过上限')});
  const store=f.topics.storeFile;f.topics.storeFile=async(m,root,dir,name,body)=>{if(name==='om_1-5.txt')throw Error('sh: 1: cannot create w: Permission denied');return store(m,root,dir,name,body);};
  let noticed;f.h.on['agent prompt']=(args,run)=>{noticed=f.replies.length;return run(args);};
  await f.send({messageId:'om_1',rawContentType:'post',content:'四个附件\n![image](img_ok)![image](img_big)![image](img_gone)\n<file key="file_big" name="big.zip"/>\n<file key="file_w" name="w.txt"/>',
   resources:[{type:'image',fileKey:'img_ok'},{type:'image',fileKey:'img_big'},{type:'image',fileKey:'img_gone'},{type:'file',fileKey:'file_big',fileName:'big.zip'},{type:'file',fileKey:'file_w',fileName:'w.txt'}]});
  const t=f.store.data.topics[0],dir=`/home/u/work/.herdr-bridge/${t.id}`;
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),[`四个附件\n[图片 1：${dir}/om_1-1.png][图片 2：下载失败][图片 3：下载失败]\n[文件 1：下载失败]\n[文件 2：下载失败]`]);
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',notice('未能把附件交给 Agent：图片 2 超过 10 MB，图片 3 下载失败，文件 1 超过 30 MB，文件 2 写入失败')]]);assert.equal(noticed,1);
  assert.deepEqual(attachmentLogs(f),[['error',`${t.agentName}：图片 2 超过 10 MB，超过上限`],['error',`${t.agentName}：图片 3 下载失败，飞书接口错误 234003：File not in msg.`],['error',`${t.agentName}：文件 1 超过 30 MB，超过上限`],['error',`${t.agentName}：文件 2 写入失败，sh: 1: cannot create w: Permission denied`]]);
  assert.equal(t.attachmentDir,dir);assert.equal(t.state,'ready');assert.deepEqual(cotLog(f)[0],['create','om_1']);
  // Nothing written: the topic has no attachment directory.
  await f.send({messageId:'om_2',...imageOf('img_gone')});const other=f.store.data.topics[1];
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').at(-1)![3],'[图片 1：下载失败]');assert.equal(other.attachmentDir,undefined);assert.deepEqual(f.replies.at(-1)!.slice(2),['om_2',notice('未能把附件交给 Agent：图片 1 下载失败')]);
 }finally{f.close();}
});
test('a kind of message that Bridge cannot forward gets a notice in its thread and opens no topic; in a binding that requires the mention only when it mentions the bot',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',...sticker});
  assert.deepEqual([f.store.data.topics,f.h.calls,f.reacted,f.downloads],[[],[],[],[]]);assert.deepEqual(f.replies,[['a','oc_1','om_1',notice(unsupportedText)]]);
  await f.send({messageId:'om_2',content:'hi'});f.replies.length=0;f.h.calls.length=0;f.reacted.length=0;
  await f.send({messageId:'om_3',rootId:'om_2',rawContentType:'merge_forward',content:'<forwarded_messages/>',resources:[]});
  assert.deepEqual([f.replies,f.h.calls,f.reacted,f.store.data.topics[0].messageIds],[[['a','oc_1','om_2',notice(unsupportedText)]],[],[],['om_2']]);
  f.topics.reply=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_4',...sticker});assert.match(f.store.data.logs.at(-1)!.message,/飞书未连接/);
 }finally{f.close();}
 const g=topicFixture({binding:{requireMention:true}});try{
  await g.send({messageId:'om_1',...sticker});assert.deepEqual(g.replies,[]);
  await g.send({messageId:'om_2',...sticker,mentionedBot:true});assert.deepEqual([g.replies,g.store.data.topics],[[['a','oc_1','om_2',notice(unsupportedText)]],[]]);
 }finally{g.close();}
});
test('the attachment directory of a topic is removed when the topic ends and when its binding is removed, then also for a topic whose removal failed before; a failure is only logged and a topic without attachments removes nothing',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',...imageOf('img_1')});await f.send({messageId:'om_2',content:'没有附件'});await f.send({messageId:'om_3',...imageOf('img_3')});await f.send({messageId:'om_4',...imageOf('img_4')});
  const [one,two,three,four]=f.store.data.topics,dirOf=(t:Topic)=>`/home/u/work/.herdr-bridge/${t.id}`;
  // The agents of the first two topics exit.
  f.h.agents=f.h.agents.filter(a=>!['w1:p1','w1:p2'].includes(a.pane_id));await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual([one.state,two.state],['closed','closed']);assert.deepEqual(f.removed,[['m',dirOf(one)]]);assert.equal(one.attachmentDir,undefined);assert.equal(new Store(f.dir).data.topics[0].attachmentDir,undefined);
  // A removal that fails keeps the record for the next try.
  f.topics.removeDirectory=async()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w1:p3');await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual([three.state,three.attachmentDir],['closed',dirOf(three)]);assert.deepEqual(attachmentLogs(f),[['error',`${three.agentName}：未能删除附件目录，连接超时，请检查 SSH 与 Herdr 状态`]]);
  f.topics.removeDirectory=async(m,dir)=>{f.removed.push([m.id,dir]);};f.h.calls.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.removed.slice(1).sort(),[['m',dirOf(three)],['m',dirOf(four)]].sort());assert.deepEqual(f.h.calls,[['pane','remote-answers','w1:p4','off']]);assert.deepEqual(f.store.data.topics,[]);
 }finally{f.close();}
});

// A ready topic whose agent runs in w1:p1, with the COT c1 of its first message om_1 open unless the fixture options refuse it;
// snapshot(seq) is an agent list in which that agent reports reply_seq seq. om_1 mentions the bot, as a binding that requires it needs.
async function readyTopic(options?:TopicOptions){
 const f=topicFixture(options);await f.send({messageId:'om_1',content:'one',mentionedBot:true});f.h.calls.length=0;f.replies.length=0;f.api.length=0;
 return {...f,t:f.store.data.topics[0],snapshot:(reply_seq:number)=>f.h.agents.map(a=>({...a,reply_seq}))};
}
const forwarded=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='回复转发').map(l=>[l.level,l.message]);
test('new replies of a topic agent are fetched after the stored seq and sent in order into its thread as cards without a header, whose summary is the beginning of the reply with its whitespace collapsed; a topic without a seq counts from 0',async()=>{
 const f=await readyTopic();try{
  delete (f.t as Partial<Topic>).replySeq;f.h.retained['w1:p1']=[{seq:1,text:'**第一条**'},{seq:2,text:'第二条\n\n- 列表'}];
  await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','0']]);
  assert.deepEqual(f.replies,[['a','oc_1','om_1',replyOf('**第一条**')],['a','oc_1','om_1',replyOf('第二条\n\n- 列表','第二条 - 列表')]]);assert.equal(new Store(f.dir).data.topics[0].replySeq,2);
  f.h.retained['w1:p1'].push({seq:5,text:'第三条'});f.h.calls.length=0;f.replies.length=0;
  await f.topics.sync(f.m,f.snapshot(5));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','2']]);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('第三条')]);assert.equal(f.t.replySeq,5);
  assert.deepEqual(forwarded(f),Array(3).fill(['info',`个人助手：已转发 ${f.t.agentName} 的回复`]));assert.ok(!JSON.stringify(f.store.data.logs).includes('第一条'));
 }finally{f.close();}
});
test('an unchanged reply_seq, or an agent without one from an older Herdr, calls nothing and sends nothing',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:3,text:'x'}];f.t.replySeq=3;
  await f.topics.sync(f.m,f.snapshot(3));await f.topics.sync(f.m,f.h.agents);delete (f.t as Partial<Topic>).replySeq;await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual([f.h.calls,f.replies],[[],[]]);
 }finally{f.close();}
});
test('syncs with the same snapshot fetch the replies once',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'a'},{seq:2,text:'b'}];const snapshot=f.snapshot(2);
  await Promise.all([f.topics.sync(f.m,snapshot),f.topics.sync(f.m,snapshot)]);await f.topics.sync(f.m,snapshot);
  assert.equal(f.h.calls.length,1);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('a'),replyOf('b')]);
 }finally{f.close();}
});
test('each reply seq is on disk before its send; a failed send is logged once, not retried, and the seq still advances',async()=>{
 const f=await readyTopic();try{
  const seen:[string,number][]=[];f.topics.reply=loose<typeof f.topics.reply>(async(a,chatId,rootId,{card})=>{seen.push([markdownIn(card),new Store(f.dir).data.topics[0].replySeq]);if(markdownIn(card)==='一')throw Error('飞书未连接');});
  f.h.retained['w1:p1']=[{seq:1,text:'一'},{seq:2,text:'二'}];
  await f.topics.sync(f.m,f.snapshot(2));await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(seen,[['一',1],['二',2]]);assert.equal(f.h.calls.length,1);assert.equal(f.t.replySeq,2);
  assert.deepEqual(forwarded(f),[['error',`个人助手：${f.t.agentName} 的回复未发出，飞书未连接`],['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]);
 }finally{f.close();}
});
test('a reply_seq below the stored one, after Herdr restarted and counts from 1 again, fetches all replies and sends those up to the snapshot',async()=>{
 const f=await readyTopic();try{
  f.t.replySeq=7;f.h.retained['w1:p1']=[{seq:1,text:'一'},{seq:2,text:'二'},{seq:3,text:'快照之后'}];
  await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1']]);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('一'),replyOf('二')]);assert.equal(f.t.replySeq,2);
  f.h.calls.length=0;await f.topics.sync(f.m,f.snapshot(3));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','2']]);assert.deepEqual(f.replies.at(-1)![3],replyOf('快照之后'));
 }finally{f.close();}
});
test('a truncated reply ends with a note pointing to Herdr, in plain text after its markdown',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'很长的回复',truncated:true},{seq:2,text:'完整的回复',truncated:false}];
  await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('很长的回复','很长的回复',truncatedNote),replyOf('完整的回复')]);
 }finally{f.close();}
});
// The bytes of the request that sends card into a thread: the card serialized, as the content string of a serialized body.
const requestBytes=(card:object)=>Buffer.byteLength(JSON.stringify({content:JSON.stringify(card),msg_type:'interactive',reply_in_thread:true}));
test('a card fits a message when its request stays within 30 KB, counting what serializing it twice adds',()=>{
 // A quote takes 4 bytes serialized twice: 6900 of them fit, 7100 do not.
 const of=(n:number)=>card('标题','blue',[plain('"'.repeat(n))]);
 assert.equal(fits(of(6900)),true);assert.ok(requestBytes(of(6900))<30*1000);assert.equal(fits(of(7100)),false);
});
test('a reply too large for one card goes out as several cards in order, each request within 30 KB however much its text grows when serialized twice; a code block split between cards is closed and opened again with its info string, a line too long for a card is cut, and only the last card has the truncation note',async()=>{
 const f=await readyTopic();try{
  // Serialized twice, a quote or backslash takes 4 bytes and a CJK character 3.
  const code=Array.from({length:700},(_,i)=>`const path${i} = "C:\\\\路径\\\\${i}";`),long='"'.repeat(12000);
  const text=['开头的说明','```ts',...code,'```','代码之后',long,'结尾'].join('\n');assert.ok(Buffer.byteLength(text)<=64*1024);
  f.h.retained['w1:p1']=[{seq:1,text,truncated:true}];await f.topics.sync(f.m,f.snapshot(1));
  const cards=f.replies.map(r=>r[3].card),parts=cards.map(markdownIn),lines=parts.flatMap(p=>p!.split('\n'));
  assert.ok(cards.length>2);assert.deepEqual([f.t.replySeq,forwarded(f)],[1,[['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]]);
  for(const [i,card] of cards.entries()){
   assert.ok(requestBytes(card)<=30000,`card ${i}: ${requestBytes(card)} bytes`);assert.equal(card.header,undefined);assert.equal(card.config!.width_mode,'fill');
   const summary=card.config!.summary.content;assert.ok([...summary].length<=100&&parts[i].replace(/\s+/g,' ').trim().startsWith(summary.replace(/…$/,'')),`card ${i}: ${summary}`);
   // Every card opens and closes its code blocks.
   assert.equal(parts[i].split('\n').filter(l=>l.startsWith('```')).length%2,0,`card ${i}`);
   assert.deepEqual(card.body.elements.slice(1),i===cards.length-1?[truncatedNote]:[],`card ${i}`);
  }
  // Splitting does not waste the room of a card.
  assert.ok(requestBytes(cards[0])>20000);
  assert.ok(parts[0].startsWith('开头的说明\n```ts\nconst path0 ')&&parts[0].endsWith('\n```'));assert.ok(parts[1].startsWith('```ts\nconst '));assert.ok(parts.at(-1)!.endsWith('\n结尾'));
  // No code line is lost or cut; the long line is cut into pieces that start cards and add up to it.
  assert.deepEqual(lines.filter(l=>l.startsWith('const ')),code);
  const pieces=lines.filter(l=>/^"+$/.test(l));assert.ok(pieces.length>1);assert.equal(pieces.join(''),long);for(const piece of pieces)assert.ok(parts.some(p=>p!.startsWith(piece)));
  assert.deepEqual(lines.filter(l=>!l.startsWith('const ')&&!/^"+$/.test(l)&&!l.startsWith('```')),['开头的说明','代码之后','结尾']);
 }finally{f.close();}
});
test('a card that fails ends its reply: the cards after it are dropped, nothing is sent again and the next reply still goes out',async()=>{
 const f=await readyTopic();try{
  const reply=f.topics.reply;let calls=0;f.topics.reply=async(...args)=>{if(++calls===2)throw Error('飞书未连接');return reply(...args);};
  f.h.retained['w1:p1']=[{seq:1,text:Array(300).fill('"'.repeat(100)).join('\n')},{seq:2,text:'下一条'}];
  await f.topics.sync(f.m,f.snapshot(2));await f.topics.sync(f.m,f.snapshot(2));
  assert.equal(calls,3);assert.equal(f.replies.length,2);assert.ok(markdownIn(f.replies[0][3].card).startsWith('"'.repeat(100)+'\n'));assert.deepEqual(f.replies[1][3],replyOf('下一条'));
  assert.equal(f.t.replySeq,2);assert.deepEqual(forwarded(f),[['error',`个人助手：${f.t.agentName} 的回复只发出了前 1 张卡片，飞书未连接`],['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]);
 }finally{f.close();}
});
test('sync forwards replies only for ready topics of its machine, bridge-opened or adopted, whose pane has an agent with remote answers on, whatever its name',async()=>{
 const f=topicFixture();try{
  const topic={bindingId:'b',appId:'a',chatId:'oc_1',machineId:'m',paneId:'w1:p1',agentName:'feishu-1',state:'ready',replySeq:0};
  f.store.data.topics=[{...topic,id:'ready',rootId:'om_ready'} as Topic,...(['closed','failed','starting','choosing'] as const).map(state=>({...topic,id:state,rootId:'om_'+state,state}) as Topic),{...topic,id:'elsewhere',rootId:'om_elsewhere',machineId:'m2'} as Topic,
   {...topic,id:'adopted',rootId:'om_adopted',paneId:'w1:p4',agentName:'review',adopted:{picker:'om_card',kind:'claude'}} as Topic];
  f.h.retained={'w1:p1':[{seq:1,text:'hi'}],'w1:p4':[{seq:1,text:'adopted hi'}]};
  await f.topics.sync(f.m,[{name:'someone-else',pane_id:'w1:p1',reply_seq:1,remote_answers:true} as Agent,{pane_id:'w1:p4',reply_seq:1,remote_answers:true} as Agent]);
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','0'],['agent','replies','w1:p4','--after','0']]);
  assert.deepEqual(f.replies,[['a','oc_1','om_ready',replyOf('hi')],['a','oc_1','om_adopted',replyOf('adopted hi')]]);
 }finally{f.close();}
});
const endedNotice=notice('该话题的会话已结束，请发起新话题'),adoptedGone=notice('被接管的 Agent 已退出、已更换或所在 pane 已关闭，话题已结束接管');
test('a ready topic ends in sync with one notice once a fresh agent list confirms that its pane closed or its agent no longer has remote answers on; a stale list ends nothing',async()=>{
 const f=await readyTopic();try{
  const t=f.t,agent=f.h.agents[0];assert.equal(agent.remote_answers,true);
  // A list taken before remote answers were turned on: the fresh list still has them.
  await f.topics.sync(f.m,[{...agent,remote_answers:undefined}]);await f.topics.sync(f.m,[]);
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list']]);assert.equal(t.state,'ready');assert.deepEqual(f.replies,[]);
  // Herdr clears the setting when the agent exits or changes: a list without it ends the topic.
  f.h.calls.length=0;delete agent.remote_answers;
  await Promise.all([f.topics.sync(f.m,f.h.agents),f.topics.sync(f.m,f.h.agents)]);await f.topics.sync(f.m,f.h.agents);
  assert.equal(t.state,'closed');assert.equal(new Store(f.dir).data.topics[0].state,'closed');assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',endedNotice]]);
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);
 }finally{f.close();}
});
test('sync runs in the topic queue after a message being prompted, and skips a topic that such a message closed',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'done'}];f.h.on['agent prompt']=async(args,run)=>{await later(20);return run(args);};
  await Promise.all([f.send({messageId:'om_2',rootId:'om_1',content:'two'}),f.topics.sync(f.m,f.snapshot(1))]);
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['agent','list'],['agent','prompt'],['agent','replies']]);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('done')]);
  const snapshot=f.snapshot(2);f.h.agents.length=0;f.h.calls.length=0;
  await Promise.all([f.send({messageId:'om_3',rootId:'om_1',content:'three'}),f.topics.sync(f.m,snapshot)]);
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(f.t.state,'closed');assert.equal(f.t.replySeq,1);
 }finally{f.close();}
});
test('a queued reply fetch whose binding was removed meanwhile sends nothing',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'done'}];f.h.on['agent prompt']=async(args,run)=>{await later(20);return run(args);};
  const done=Promise.all([f.send({messageId:'om_2',rootId:'om_1',content:'two'}),f.topics.sync(f.m,f.snapshot(1))]);
  f.store.data.bindings=[];f.store.data.topics=[];await done;
  assert.deepEqual(f.h.calls.map(c=>c[1]),['list','prompt']);assert.deepEqual(f.replies,[]);
 }finally{f.close();}
});

const onDisk=(f:{dir:string})=>new Store(f.dir).data.topics[0].reactions;
test('every message a topic accepts gets a OneSecond reaction at once, even while an earlier message is still starting the agent; the first one prompted trades it for its COT; no start notice is sent',async()=>{
 const f=topicFixture();try{
  let during;f.h.on['agent start']=async(args,run)=>{await later(20);during=f.reacted.map(r=>r[1]);return run(args);};
  await Promise.all([f.send({messageId:'om_1',content:'one'}),f.send({messageId:'om_2',rootId:'om_1',content:'two'})]);
  assert.deepEqual(during,['om_1','om_2']);assert.deepEqual(f.reacted,[['a','om_1','OneSecond'],['a','om_2','OneSecond']]);
  assert.deepEqual(f.replies,[]);assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.deepEqual(onDisk(f).map(r=>r.messageId),['om_2']);
  assert.deepEqual(cotLog(f).filter(c=>c[0]==='create'),[['create','om_1']]);
  await f.send({messageId:'om_1',content:'one'});assert.equal(f.reacted.length,2);
 }finally{f.close();}
});
test('a reaction is recorded on disk without a state seq, which becomes the state_change_seq that the prompt returned',async()=>{
 const f=topicFixture({cot:false});try{
  let before;f.h.on['agent prompt']=(args,run)=>{before=onDisk(f);const r=run(args) as {agent:Agent};return {...r,agent:{...r.agent,state_change_seq:7}};};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(before,[{messageId:'om_1',reactionId:'r_om_1',stateSeq:null}]);assert.deepEqual(onDisk(f),[{messageId:'om_1',reactionId:'r_om_1',stateSeq:7}]);assert.deepEqual(f.unreacted,[]);
 }finally{f.close();}
});
test('sync removes the reaction of a turn that has ended: the agent is idle or done and has changed state since the prompt',async()=>{
 const f=await readyTopic({cot:false});try{
  const agent=(agent_status:string,state_change_seq:number)=>[{...f.h.agents[0],agent_status,state_change_seq}];
  // A message still waiting for its prompt keeps its reaction whatever the agent does.
  f.t.reactions.push({messageId:'om_waiting',reactionId:'r_waiting',stateSeq:null});
  for(const snapshot of [agent('working',5),agent('blocked',5),agent('unknown',5),agent('idle',1),agent('done',1),[{...agent('done',5)[0],name:'someone-else',remote_answers:undefined}],[]])await f.topics.sync(f.m,snapshot);
  assert.deepEqual(f.unreacted,[]);assert.deepEqual(onDisk(f).map(r=>r.messageId),['om_1']);assert.equal(f.t.reactions.length,2);
  await f.topics.sync(f.m,agent('done',2));
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.deepEqual(onDisk(f),[{messageId:'om_waiting',reactionId:'r_waiting',stateSeq:null}]);
  f.t.reactions=[];await f.send({messageId:'om_2',rootId:'om_1',content:'two'});f.unreacted.length=0;
  await f.topics.sync(f.m,agent('idle',3));await f.topics.sync(f.m,agent('idle',3));
  assert.deepEqual(f.unreacted,[['a','om_2','r_om_2']]);assert.deepEqual(onDisk(f),[]);assert.deepEqual(f.h.calls.filter(c=>c[1]==='replies'),[]);
 }finally{f.close();}
});
test('when a snapshot has new replies and ends a turn, the replies are sent before the reaction is removed',async()=>{
 const f=await readyTopic({cot:false});try{
  const events:string[]=[];f.topics.reply=loose<typeof f.topics.reply>(async(a,chatId,rootId,{card})=>{events.push('reply '+markdownIn(card));});f.topics.unreact=async(a,messageId)=>{events.push('unreact '+messageId);};
  f.h.retained['w1:p1']=[{seq:1,text:'a'},{seq:2,text:'b'}];
  await f.topics.sync(f.m,f.h.agents.map(a=>({...a,agent_status:'done',state_change_seq:3,reply_seq:2})));
  assert.deepEqual(events,['reply a','reply b','unreact om_1']);
 }finally{f.close();}
});
test('a message that is not prompted loses its reaction: failed start, blocked agent, prompt error or closed topic',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','busy');};await f.send({messageId:'om_1',content:'one'});
  f.h.on['agent prompt']=()=>{throw coded('agent_blocked','blocked');};await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  f.h.on['agent prompt']=()=>{throw coded('agent_prompt_failed','pty closed');};await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因'),notice('Agent 正在等待确认，请到 Herdr 中处理后重发这条消息')]);
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1'],['a','om_2','r_om_2'],['a','om_3','r_om_3']]);assert.deepEqual(onDisk(f),[]);
  const t=f.store.data.topics[0];t.state='closed';f.h.calls.length=0;await f.send({messageId:'om_4',rootId:'om_1',content:'four'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.unreacted.at(-1),['a','om_4','r_om_4']);assert.deepEqual(onDisk(f),[]);
 }finally{f.close();}
});
test('a topic closed because its agent is gone loses every reaction',async()=>{
 const f=await readyTopic({cot:false});try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});f.t.reactions.push({messageId:'om_waiting',reactionId:'r_waiting',stateSeq:null});
  f.h.agents.length=0;await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.equal(f.t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('该话题的会话已结束，请发起新话题')]);
  assert.deepEqual(f.unreacted.map(r=>r[1]).sort(),['om_1','om_2','om_3','om_waiting']);assert.equal(f.unreacted.length,4);assert.deepEqual(onDisk(f),[]);
 }finally{f.close();}
});
test('a reaction Feishu refuses is logged and the message is still prompted without a record',async()=>{
 const f=topicFixture();try{
  f.topics.react=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['one']);assert.deepEqual(onDisk(f),[]);assert.deepEqual(f.unreacted,[]);
  const t=f.store.data.topics[0];assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='消息表情').map(l=>[l.level,l.message]),[['error',`${t.agentName}：未能贴上表情，飞书未连接`]]);
 }finally{f.close();}
});
test('a message still settles without rejecting when its turn seq cannot be saved',async()=>{
 const f=topicFixture();try{
  const save=f.store.save.bind(f.store);let failed=0;
  f.store.save=()=>{if(!failed&&f.store.data.topics[0]?.reactions?.[0]?.stateSeq!=null){failed++;throw Error('disk full');}save();};
  await f.send({messageId:'om_1',content:'one'});
  assert.equal(failed,1);assert.deepEqual([f.store.data.logs.at(-1)!.level,f.store.data.logs.at(-1)!.kind],['error','消息投递']);assert.match(f.store.data.logs.at(-1)!.message,/disk full/);
 }finally{f.close();}
});
test('a removal Feishu refuses is logged once and its record is dropped anyway',async()=>{
 const f=await readyTopic({cot:false});try{
  let calls=0;f.topics.unreact=async()=>{calls++;throw Error('飞书未连接');};const done=f.h.agents.map(a=>({...a,agent_status:'done',state_change_seq:2}));
  await f.topics.sync(f.m,done);await f.topics.sync(f.m,done);
  assert.equal(calls,1);assert.deepEqual(onDisk(f),[]);assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='消息表情').map(l=>[l.level,l.message]),[['error',`${f.t.agentName}：未能取消表情，飞书未连接`]]);
 }finally{f.close();}
});

// Requests as `agent requests` reports them.
const bash:HerdrRequest={id:1,kind:'permission',tool_name:'Bash',description:'列出文件',input_preview:'ls -la',decisions:['allow','allow_always','deny']};
const edit:HerdrRequest={id:2,kind:'permission',tool_name:'Edit',input_preview:'{"file_path":"a.txt"}',decisions:['allow','deny']};
const ask:HerdrRequest={id:3,kind:'question',tool_name:'AskUserQuestion',input_preview:'{}',questions:[
 {question:'用哪种数据库？',header:'数据库',options:[{label:'PostgreSQL',description:'关系型'},{label:'SQLite'}],multi_select:false},
 {question:'需要哪些功能？',options:[{label:'登录'},{label:'搜索'},{label:'导出'}],multi_select:true}]};
const cardOf=(title:string,template:string,elements:object[])=>({schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:title},template},body:{elements}});
const expiredCard=(title:string)=>cardOf(title,'grey',[plainText('已失效（超时、已在终端处理或本轮已结束）')]);
// Every element with the tag, at any depth.
const find=(x:any,tag:string):Record<string,any>[]=>x&&typeof x==='object'?[...x.tag===tag?[x]:[],...Object.values(x).flatMap(v=>find(v,tag))]:[];
// A ready topic whose agent in w1:p1 waits on requests. pending(ids) is an agent list that reports those request ids; cards() the cards
// sent into the thread; value(card,decision) the callback value of a button; click(...) a click by an allowed person; settled() waits for
// the answers that clicks started.
async function requestTopic(...requests:HerdrRequest[]){
 const f=await readyTopic();f.h.requests['w1:p1']=requests;
 return {...f,
  pending:(ids=f.h.requests['w1:p1'].map(r=>r.id),fields:Partial<Agent>={})=>f.h.agents.map(a=>({...a,request_ids:ids,...fields})),
  cards:()=>f.replies.filter(r=>r[3].card.header).map(r=>r[3].card),records:()=>new Store(f.dir).data.topics[0].cards,
  value:(card:Card,decision?:string)=>find(card,'button').find(b=>!decision||b.behaviors[0].value.decision===decision)!.behaviors[0].value,
  click:(messageId:string,value:object,formValue?:object,openId='ou_user')=>f.topics.click(allowed,{messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',value,formValue}} as Click),
  settled:()=>Promise.all(f.topics.answering.values()),
 };
}
const cardLogs=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='请求卡片').map(l=>[l.level,l.message]);
test('each new request gets a card in the topic thread, recorded with its request id, card message and title only after Feishu took it',async()=>{
 const f=await requestTopic(bash,edit);try{
  const reply=f.topics.reply,onDiskAtSend:unknown[]=[];f.topics.reply=async(...args)=>{onDiskAtSend.push(f.records()||[]);return reply(...args);};
  await f.topics.sync(f.m,f.pending());
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1']]);assert.deepEqual(f.replies.map(r=>r.slice(0,3)),[['a','oc_1','om_1'],['a','oc_1','om_1']]);
  const buttons=(value:object,...decisions:string[][])=>({tag:'column_set',horizontal_spacing:'8px',columns:decisions.map(([content,type,decision])=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value:{...value,decision}}]}]}))});
  const allow=['允许','primary','allow'],always=['总是允许','default','allow_always'],deny=['拒绝','danger','deny'];
  assert.deepEqual(f.cards(),[
   cardOf('权限确认 · Bash','orange',[plainText('列出文件'),plainText('ls -la'),buttons({request:1,check:check(bash),render:1},allow,always,deny)]),
   // "总是允许" only when the request offers it.
   cardOf('权限确认 · Edit','orange',[plainText('{"file_path":"a.txt"}'),buttons({request:2,check:check(edit),render:2},allow,deny)])]);
  assert.deepEqual(onDiskAtSend,[[],[{requestId:1,messageId:'om_bot_1',title:'权限确认 · Bash'}]]);
  assert.deepEqual(f.records(),[{requestId:1,messageId:'om_bot_1',title:'权限确认 · Bash'},{requestId:2,messageId:'om_bot_2',title:'权限确认 · Edit'}]);
  assert.deepEqual(cardLogs(f),[['info',`${f.t.agentName}：已发送请求 #1 的卡片`],['info',`${f.t.agentName}：已发送请求 #2 的卡片`]]);assert.ok(!JSON.stringify(f.store.data.logs).includes('ls -la'));
  // Lists with the recorded ids, or from an older Herdr without request ids, call nothing.
  f.h.calls.length=0;await f.topics.sync(f.m,f.pending());f.t.cards=[];await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual(f.h.calls,[]);assert.equal(f.cards().length,2);assert.deepEqual(f.updated,[]);
 }finally{f.close();}
});
test('a question card lists each question in a form with a single or multi select and an 其他 input, and submits them with one button',async()=>{
 const f=await requestTopic(ask);try{
  await f.topics.sync(f.m,f.pending());
  const options=(labels:string[])=>labels.map((content,i)=>({text:{tag:'plain_text',content},value:String(i)})),other=(i:number)=>({tag:'input',name:'other'+i,width:'fill',placeholder:{tag:'plain_text',content:'其他（填写后以此为准）'}});
  assert.deepEqual(f.cards(),[cardOf('Agent 提问','blue',[{tag:'form',name:'answers',elements:[
   plainText('数据库：用哪种数据库？\n· PostgreSQL：关系型'),{tag:'select_static',name:'q0',width:'fill',placeholder:{tag:'plain_text',content:'选择一项'},options:options(['PostgreSQL','SQLite'])},other(0),
   plainText('需要哪些功能？'),{tag:'multi_select_static',name:'q1',width:'fill',placeholder:{tag:'plain_text',content:'选择一项或多项'},options:options(['登录','搜索','导出'])},other(1),
   {tag:'button',text:{tag:'plain_text',content:'提交'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{request:3,check:check(ask),render:1,questions:2}}]}]}])]);
  assert.deepEqual(f.records(),[{requestId:3,messageId:'om_bot_1',title:'Agent 提问'}]);
 }finally{f.close();}
});
test('Herdr leaves out empty lists and false flags: a question without options has only the 其他 input and is answered by it; a permission without decisions has no buttons',async()=>{
 const open:HerdrRequest={id:6,kind:'question',tool_name:'AskUserQuestion',input_preview:'{}',questions:[{question:'项目叫什么？'}]},bare:HerdrRequest={id:7,kind:'permission',tool_name:'Bash',input_preview:'ls'};
 const f=await requestTopic(open,bare);try{
  await f.topics.sync(f.m,f.pending());const [card,plainCard]=f.cards();
  assert.deepEqual(find(card,'form')[0].elements.map((e:Card)=>e.tag),['div','input','button']);
  assert.deepEqual(plainCard,cardOf('权限确认 · Bash','orange',[plainText('ls')]));
  assert.deepEqual(f.click('om_bot_1',f.value(card),{}),{toast:{type:'warning',content:'请回答所有问题'}});await f.settled();
  f.click('om_bot_1',f.value(f.updated[0][2]),{other0:'herdr'});await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer'),[['agent','answer','w1:p1','6','--answers',JSON.stringify({'项目叫什么？':['herdr']})]]);
 }finally{f.close();}
});
test('a card Feishu refuses is logged and left unrecorded, so the next list sends it again; lists with the same ids send each card once',async()=>{
 const f=await requestTopic(bash);try{
  const reply=f.topics.reply;let refuse=true;f.topics.reply=async(...args)=>{if(refuse)throw Error('飞书未连接');return reply(...args);};
  await f.topics.sync(f.m,f.pending());
  assert.deepEqual(f.records(),[]);assert.deepEqual(cardLogs(f),[['error',`${f.t.agentName}：请求 #1 的卡片未发出，飞书未连接`]]);
  refuse=false;const list=f.pending();await Promise.all([f.topics.sync(f.m,list),f.topics.sync(f.m,list)]);await f.topics.sync(f.m,list);
  assert.equal(f.cards().length,1);assert.deepEqual(f.records(),[{requestId:1,messageId:'om_bot_1',title:'权限确认 · Bash'}]);
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1'],['agent','requests','w1:p1']]);
 }finally{f.close();}
});
test('a request that agent requests shows but the agent list did not report yet waits for a list that does',async()=>{
 const f=await requestTopic(bash,edit);try{
  await f.topics.sync(f.m,f.pending([1]));assert.deepEqual(f.records().map(c=>c.requestId),[1]);
  await f.topics.sync(f.m,f.pending([1,2]));assert.deepEqual(f.records().map(c=>c.requestId),[1,2]);assert.equal(f.cards().length,2);
 }finally{f.close();}
});
test('the card of a request that ended outside Feishu shows 已失效 with its title; the record is dropped before the update, which is not repeated',async()=>{
 const f=await requestTopic(bash,edit,ask);try{
  await f.topics.sync(f.m,f.pending());f.h.calls.length=0;
  let onDiskAtUpdate:RequestCard[]|undefined;const update=f.topics.updateCard;f.topics.updateCard=async(...args)=>{onDiskAtUpdate=f.records();return update(...args);};
  await f.topics.sync(f.m,f.pending([2,3]));
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(onDiskAtUpdate!.map(c=>c.requestId),[2,3]);assert.deepEqual(f.h.calls,[]);
  f.topics.updateCard=async()=>{throw Error('飞书未连接');};
  await f.topics.sync(f.m,f.pending([3]));await f.topics.sync(f.m,f.pending([3]));
  assert.deepEqual(f.records().map(c=>c.requestId),[3]);assert.deepEqual(cardLogs(f).filter(l=>l[0]==='error'),[['error',`${f.t.agentName}：请求 #2 的卡片未能更新，飞书未连接`]]);
  // An agent missing from the list waits on nothing.
  f.topics.updateCard=update;await f.topics.sync(f.m,[]);
  assert.deepEqual(f.updated.at(-1),['a','om_bot_3',expiredCard('Agent 提问')]);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a topic closed because its agent is gone marks its cards 已失效',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());f.h.agents.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.equal(f.t.state,'closed');assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a click gets its toast at once; the decision then goes to Herdr outside the topic queue and the card shows it with the person, without buttons',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  // A message whose prompt hangs holds the topic queue.
  let release!:()=>void;f.h.on['agent prompt']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  const message=f.send({messageId:'om_2',rootId:'om_1',content:'two'});await later(5);f.h.calls.length=0;
  assert.deepEqual(f.click('om_bot_1',f.value(card,'allow')),{toast:{type:'info',content:'正在提交'}});assert.equal(f.h.calls.some(c=>c[1]==='answer'),false);
  await f.settled();
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1'],['agent','answer','w1:p1','1','--decision','allow']]);
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('权限确认 · Bash','green',[plainText('列出文件'),plainText('ls -la'),{tag:'markdown',content:'已允许 · <at id=ou_user></at>'}])]]);
  assert.deepEqual(f.records(),[]);assert.deepEqual(cardLogs(f).at(-1),['info',`${f.t.agentName}：请求 #1 已在飞书中回答`]);
  release();await message;assert.equal(f.topics.answering.size,0);
 }finally{f.close();}
});
test('拒绝 tells the agent that the person refused in Feishu; 总是允许 is passed on as allow_always',async()=>{
 const f=await requestTopic(bash,{...bash,id:4});try{
  await f.topics.sync(f.m,f.pending());const [first,second]=f.cards();
  f.click('om_bot_1',f.value(first,'deny'));f.click('om_bot_2',f.value(second,'allow_always'));await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer'),[['agent','answer','w1:p1','1','--decision','deny','--message','用户在飞书中拒绝了这次操作'],['agent','answer','w1:p1','4','--decision','allow_always']]);
  assert.deepEqual(f.updated.map(u=>[u[1],u[2].header!.template,find(u[2],'markdown')[0].content]),[['om_bot_1','red','已拒绝 · <at id=ou_user></at>'],['om_bot_2','green','已总是允许 · <at id=ou_user></at>']]);
  assert.equal(find(f.updated,'button').length,0);
 }finally{f.close();}
});
test('a click on a request that has ended, that Herdr reports as not found, or whose id Herdr now gives another request shows 已失效',async()=>{
 const f=await requestTopic(bash,edit,ask);try{
  await f.topics.sync(f.m,f.pending());const [one,two,three]=f.cards();
  // Ended before the click: nothing is answered.
  f.h.requests['w1:p1']=[edit,ask];f.click('om_bot_1',f.value(one,'allow'));await f.settled();
  // Herdr restarted and counts ids from 1 again: id 2 is now another request.
  f.h.requests['w1:p1']=[{...bash,id:2},ask];f.click('om_bot_2',f.value(two,'allow'));await f.settled();
  assert.equal(f.h.calls.some(c=>c[1]==='answer'),false);
  f.h.on['agent answer']=()=>{throw coded('request_not_found','request 3 not found');};f.click('om_bot_3',f.value(three),{q0:'0',q1:['1']});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')],['a','om_bot_2',expiredCard('权限确认 · Edit')],['a','om_bot_3',expiredCard('Agent 提问')]]);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a click whose answer fails for another reason marks the card failed and drops its record, so the next list sends a new card',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  f.h.on['agent answer']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};f.click('om_bot_1',f.value(card,'allow'));await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('权限确认 · Bash','grey',[plainText('提交失败。Agent 仍在等待时会重新发送卡片')])]]);assert.deepEqual(f.records(),[]);
  assert.deepEqual(cardLogs(f).at(-1),['error',`${f.t.agentName}：请求 #1 未能回答，连接超时，请检查 SSH 与 Herdr 状态`]);
  await f.topics.sync(f.m,f.pending());assert.equal(f.cards().length,2);assert.deepEqual(f.records(),[{requestId:1,messageId:'om_bot_2',title:'权限确认 · Bash'}]);
  assert.notEqual(f.value(f.cards()[1],'allow').render,f.value(card,'allow').render);
 }finally{f.close();}
});
test('while a card is being answered from Feishu, a list without its request does not mark it 已失效 and a second click is not answered',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  let release!:()=>void;f.h.on['agent answer']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  f.click('om_bot_1',f.value(card,'allow'));await later(5);
  await f.topics.sync(f.m,f.pending([]));assert.deepEqual(f.updated,[]);assert.deepEqual(f.records().map(c=>c.requestId),[1]);
  assert.deepEqual(f.click('om_bot_1',f.value(card,'deny'),undefined,'ou_owner'),{toast:{type:'info',content:'正在提交，请稍候'}});
  release();await f.settled();
  assert.equal(f.h.calls.filter(c=>c[1]==='answer').length,1);assert.deepEqual(f.updated.map(u=>find(u[2],'markdown')[0]?.content),['已允许 · <at id=ou_user></at>']);
  await f.topics.sync(f.m,f.pending([]));assert.equal(f.updated.length,1);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a question card answers each question by its text: the chosen option, the chosen options, or the 其他 text instead of any choice',async()=>{
 const f=await requestTopic(ask,{...ask,id:5});try{
  await f.topics.sync(f.m,f.pending());const [first,second]=f.cards();
  assert.deepEqual(f.click('om_bot_1',f.value(first),{q0:'1',other0:'  ',q1:['0','2'],other1:''}),{toast:{type:'info',content:'正在提交'}});
  f.click('om_bot_2',f.value(second),{q0:'0',other0:' MySQL ',q1:['1'],other1:'全部'});await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer'),[
   ['agent','answer','w1:p1','3','--answers',JSON.stringify({'用哪种数据库？':['SQLite'],'需要哪些功能？':['登录','导出']})],
   ['agent','answer','w1:p1','5','--answers',JSON.stringify({'用哪种数据库？':['MySQL'],'需要哪些功能？':['全部']})]]);
  assert.deepEqual(f.updated[0],['a','om_bot_1',cardOf('Agent 提问','green',[plainText('用哪种数据库？\n回答：SQLite'),plainText('需要哪些功能？\n回答：登录、导出'),{tag:'markdown',content:'已回答 · <at id=ou_user></at>'}])]);
 }finally{f.close();}
});
test('a question card with a question left unanswered gets a toast, is not submitted, and is drawn again with the choices kept so it can be submitted again',async()=>{
 const f=await requestTopic(ask);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  for(const form of [{q0:'1',other1:'  '},{q1:[],other0:'x'},undefined]){
   assert.deepEqual(f.click('om_bot_1',f.value(card),form),{toast:{type:'warning',content:'请回答所有问题'}});await f.settled();
  }
  assert.equal(f.h.calls.some(c=>c[1]==='answer'),false);assert.deepEqual(f.records().map(c=>c.messageId),['om_bot_1']);
  const [again]=f.updated.map(u=>u[2]);
  // The channel drops a repeated click with the same button value, so every drawing carries a new render number.
  assert.deepEqual(f.updated.map(u=>[u[1],f.value(u[2]).render]),[['om_bot_1',2],['om_bot_1',3],['om_bot_1',4]]);
  assert.equal(find(again,'select_static')[0].initial_option,'1');assert.equal(find(again,'multi_select_static')[0].selected_values,undefined);
  assert.deepEqual(find(f.updated[1][2],'input').map(i=>i.default_value),['x',undefined]);
  f.click('om_bot_1',f.value(f.updated[2][2]),{q0:'0',q1:['2']});await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer').map(c=>c.at(-1)),[JSON.stringify({'用哪种数据库？':['PostgreSQL'],'需要哪些功能？':['导出']})]);
 }finally{f.close();}
});
test('a click on a card without a record gets a toast that the request has ended; a card in a topic that is no longer ready shows 已失效',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  const ended={toast:{type:'info',content:'这个请求已结束'}};
  assert.deepEqual(f.click('om_other',f.value(card,'allow')),ended);assert.deepEqual(f.click('om_bot_1',{...f.value(card,'allow'),request:9}),ended);
  f.t.state='closed';assert.deepEqual(f.click('om_bot_1',f.value(card,'allow')),ended);await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(f.records(),[]);assert.deepEqual(f.h.calls,[['agent','requests','w1:p1']]);
 }finally{f.close();}
});
const blockedNotice=notice('Agent 正在等待终端里的操作，请到 Herdr 中处理');
test('an agent blocked without requests in two lists in a row with the same state_change_seq gets one notice for that blocked episode',async()=>{
 const f=await requestTopic(bash);try{
  f.h.requests['w1:p1']=[];const list=(agent_status:string,state_change_seq:number,request_ids?:number[])=>f.h.agents.map(a=>({...a,agent_status,state_change_seq,request_ids}));
  await f.topics.sync(f.m,list('blocked',4));assert.deepEqual(f.replies,[]);
  await f.topics.sync(f.m,list('blocked',4));assert.deepEqual(f.replies.map(r=>r.slice(1)),[['oc_1','om_1',blockedNotice]]);assert.equal(new Store(f.dir).data.topics[0].blockedSeq,4);
  await f.topics.sync(f.m,list('blocked',4));assert.equal(f.replies.length,1);
  // A new blocked episode gets its own notice; a list without the agent, or with the agent working, breaks the run of lists.
  await f.topics.sync(f.m,list('blocked',6));await f.topics.sync(f.m,[]);await f.topics.sync(f.m,list('blocked',6));assert.equal(f.replies.length,1);
  await f.topics.sync(f.m,list('blocked',6));assert.equal(f.replies.length,2);
  // A blocked agent that waits on a request has a card instead.
  f.h.requests['w1:p1']=[bash];await f.topics.sync(f.m,list('blocked',8,[1]));await f.topics.sync(f.m,list('blocked',8,[1]));
  assert.deepEqual(f.replies.slice(2).map(r=>r[3].card.header?.title.content),['权限确认 · Bash']);
  // Other states never get the notice.
  for(const status of ['working','idle','unknown'])for(let i=0;i<2;i++)await f.topics.sync(f.m,list(status,10));
  assert.equal(f.replies.length,3);
 }finally{f.close();}
});
test('a prompt that meets a blocked agent posts its own notice for that episode, and the lists that follow post none',async()=>{
 const f=await readyTopic();try{
  Object.assign(f.h.agents[0],{agent_status:'blocked',state_change_seq:3});f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked');};
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('Agent 正在等待确认，请到 Herdr 中处理后重发这条消息')]);assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['agent','list'],['agent','prompt'],['agent','list']]);
  for(let i=0;i<3;i++)await f.topics.sync(f.m,f.h.agents);
  assert.equal(f.replies.length,1);assert.equal(f.t.blockedSeq,3);
 }finally{f.close();}
});

// COT. The events of the run of the ready topic om_1 that its first message started, as cotLog shows them: a step per tool call that
// opens with its title or tool name and an icon and closes as done or failed, and a line of text for the status.
const run={threadId:'om_1',runId:'om_1'};
const opened=(id:string,name:string,title?:string,icon?:string)=>[['TOOL_CALL_START',{toolCallId:id,toolCallName:name,title,icon}],['TOOL_CALL_END',{toolCallId:id}]];
const closed=(id:string,failed=false)=>['TOOL_CALL_RESULT',{messageId:'result-'+id,toolCallId:id,role:'tool',content:failed?'失败':'完成',isError:failed}];
const said=(id:string,text:string)=>[['TEXT_MESSAGE_START',{messageId:id,role:'assistant'}],['TEXT_MESSAGE_CONTENT',{messageId:id,delta:text}],['TEXT_MESSAGE_END',{messageId:id}]];
const stopped=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='话题停止').map(l=>[l.level,l.message]);
test('a prompted message gets a COT in the topic thread, created after the prompt, which takes the place of its reaction and is kept in the topic record; the COT shows its run started',async()=>{
 const f=topicFixture();try{
  let prompted;const request=f.topics.request;f.topics.request=async(a,o)=>{prompted??=f.h.calls.some(c=>c[1]==='prompt');return request(a,o);};
  await f.send({messageId:'om_1',content:'one'});
  assert.equal(prompted,true);
  assert.deepEqual(f.api[0],{method:'POST',url:cotPath,params:{receive_id_type:'chat_id'},data:{receive_id:'oc_1',origin_message_id:'om_1',reply_in_thread:true}});
  const update=f.api[1];assert.deepEqual([update.method,update.url,update.data.message_id,update.data.cot_id],['PUT',cotPath,'om_cot_1','c1']);
  // Every event carries its AG-UI event as JSON and a timestamp in ms.
  assert.ok(update.data.events.every((e:Record<string,any>)=>Object.keys(e).join()==='event_type,content,timestamp'&&typeof e.content==='string'&&Math.abs(e.timestamp-Date.now())<60000));
  assert.deepEqual(cotLog(f),[['create','om_1'],['update','c1',['RUN_STARTED',run]]]);
  assert.deepEqual(new Store(f.dir).data.topics[0].cot,{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false});
  // The reaction marked the message at once; the COT takes its place.
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1']);assert.deepEqual(f.unreacted.map(r=>r[1]),['om_1']);assert.deepEqual(onDisk(f),[]);assert.deepEqual(cotLogs(f),[]);
 }finally{f.close();}
});
test('the COT starts after the tool calls that the agent made before the prompt',async()=>{
 const f=topicFixture();try{
  f.h.on['agent prompt']=(args,run)=>{const r=run(args) as {agent:Agent};return {...r,agent:{...r.agent,tool_call_seq:12}};};
  await f.send({messageId:'om_1',content:'one'});assert.equal(f.store.data.topics[0].cot!.toolSeq,12);
 }finally{f.close();}
});
test('a message prompted while the COT of an earlier one is open keeps its reaction until its turn ends; a message that is not prompted gets no COT',async()=>{
 const f=await readyTopic();try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.api,[]);assert.deepEqual(onDisk(f),[{messageId:'om_2',reactionId:'r_om_2',stateSeq:1}]);assert.equal(f.t.cot!.origin,'om_1');
  delete f.t.cot;f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked');};
  await f.send({messageId:'om_3',rootId:'om_1',content:'three'});assert.deepEqual(f.api,[]);assert.equal(f.t.cot,undefined);
 }finally{f.close();}
});
test('a COT that Feishu refuses is logged and leaves the message its reaction until its turn ends, while delivery and replies go on; the next prompted message tries again',async()=>{
 const f=topicFixture({cot:false});try{
  await f.send({messageId:'om_1',content:'one'});const t=f.store.data.topics[0];
  assert.deepEqual(cotLog(f),[['create','om_1']]);assert.equal(t.cot,undefined);assert.deepEqual(onDisk(f),[{messageId:'om_1',reactionId:'r_om_1',stateSeq:1}]);
  assert.deepEqual(cotLogs(f),[['error',`${t.agentName}：未能创建 COT，飞书接口错误 99991672：Access denied`]]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);
  f.h.retained['w1:p1']=[{seq:1,text:'done'}];await f.topics.sync(f.m,list(f,{agent_status:'done',state_change_seq:2,reply_seq:1}));
  assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('done')]);assert.deepEqual(f.unreacted.map(r=>r[1]),['om_1']);assert.equal(f.api.length,1);
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});assert.deepEqual(cotLog(f),[['create','om_1'],['create','om_2']]);
 }finally{f.close();}
});
test('the tool calls of the agent become steps of the COT in seq order across lists: a start opens a step with its title or else its tool name and an icon, an end closes it as done or failed; the seq is on disk',async()=>{
 const f=await readyTopic();try{
  const calls:ToolCall[]=f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'npm test'},{seq:4,tool_call_id:'t2',phase:'start',tool_name:'Read',title:'src/a.rs'},{seq:6,tool_call_id:'t1',phase:'end',tool_name:'Bash'}];
  const working=(seq:number)=>list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:seq});
  await f.topics.sync(f.m,working(6));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','0']]);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','npm test','bash'),...opened('t2','Read','src/a.rs','read'),closed('t1')]]);assert.equal(new Store(f.dir).data.topics[0].cot!.toolSeq,6);
  // The same list again shows nothing new.
  await f.topics.sync(f.m,working(6));assert.equal(f.h.calls.length,1);assert.equal(f.api.length,1);
  calls.push({seq:9,tool_call_id:'t2',phase:'end',tool_name:'Read',failed:true},{seq:10,tool_call_id:'t3',phase:'start',tool_name:'Grep'},{seq:11,tool_call_id:'t4',phase:'start',tool_name:'apply_patch',title:'a.rs'},
   {seq:12,tool_call_id:'t5',phase:'start',tool_name:'shell',title:'ls'},{seq:13,tool_call_id:'t6',phase:'start',tool_name:'Task',title:'审查改动'},{seq:14,tool_call_id:'t7',phase:'start',tool_name:'Edit',title:'很'.repeat(300)});
  f.h.calls.length=0;f.api.length=0;await f.topics.sync(f.m,working(14));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','6']]);
  assert.deepEqual(cotLog(f),[['update','c1',closed('t2',true),...opened('t3','Grep','Grep','search'),...opened('t4','apply_patch','a.rs','write'),...opened('t5','shell','ls','bash'),...opened('t6','Task','审查改动','default'),...opened('t7','Edit','很'.repeat(199)+'…','write')]]);
  assert.equal(f.t.cot!.toolSeq,14);assert.deepEqual(cotLogs(f),[]);
 }finally{f.close();}
});
test('a tool call seq below the stored one, after Herdr restarted or handed off and counts from 1 again, fetches all tool calls and shows those up to the list; more than 50 events go out in updates of at most 50, in order',async()=>{
 const f=await readyTopic();try{
  f.t.cot!.toolSeq=40;f.h.toolCalls['w1:p1']=Array.from({length:31},(_,i)=>({seq:i+1,tool_call_id:'t'+(i+1),phase:'start',tool_name:'Bash',title:'step '+(i+1)}));
  await f.topics.sync(f.m,list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:30}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1']]);
  const batches=f.api.map(o=>o.data.events);assert.deepEqual(batches.map(b=>b.length),[50,10]);
  assert.deepEqual(cotLog(f).flatMap(u=>u.slice(2)),Array.from({length:30},(_,i)=>opened('t'+(i+1),'Bash','step '+(i+1),'bash')).flat());
  const stamps=batches.flat().map(e=>e.timestamp);assert.ok(stamps.every((s,i)=>!i||s>stamps[i-1]));assert.equal(f.t.cot!.toolSeq,30);
  f.h.calls.length=0;f.api.length=0;await f.topics.sync(f.m,list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:31}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','30']]);assert.deepEqual(cotLog(f),[['update','c1',...opened('t31','Bash','step 31','bash')]]);
 }finally{f.close();}
});
test('tool calls that cannot be fetched are fetched again with the next list; an update Feishu refuses is logged once and not repeated',async()=>{
 const f=await readyTopic();try{
  f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls'}];const working=list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:3});
  f.h.on['agent tool-calls']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};await f.topics.sync(f.m,working);
  assert.deepEqual(f.api,[]);assert.equal(f.t.cot!.toolSeq,0);assert.deepEqual(cotLogs(f),[['error',`${f.t.agentName}：未能读取工具调用，连接超时，请检查 SSH 与 Herdr 状态`]]);
  const request=f.topics.request;f.topics.request=async(a,o)=>{f.api.push(o as ApiRequest);throw Error('飞书未连接');};
  await f.topics.sync(f.m,working);await f.topics.sync(f.m,working);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls','bash')]]);assert.equal(f.t.cot!.toolSeq,3);assert.deepEqual(cotLogs(f).at(-1),['error',`${f.t.agentName}：COT 未能更新，飞书未连接`]);
  f.topics.request=request;
 }finally{f.close();}
});
test('while the agent waits for a confirmation, on a request card or blocked without one, the COT status says so after the steps that led there; once it runs again the COT says that before the steps that follow, each change once',async()=>{
 const f=await requestTopic(bash);try{
  f.h.toolCalls['w1:p1']=[{seq:2,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls -la'}];
  const waiting=f.pending([1],{agent_status:'blocked',state_change_seq:3,tool_call_seq:2});
  await f.topics.sync(f.m,waiting);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls -la','bash'),...said('status-3','等待确认')]]);assert.equal(new Store(f.dir).data.topics[0].cot!.waiting,true);
  assert.equal(f.cards().length,1);await f.topics.sync(f.m,waiting);assert.equal(f.api.length,1);
  f.h.toolCalls['w1:p1'].push({seq:5,tool_call_id:'t1',phase:'end',tool_name:'Bash'});f.api.length=0;
  await f.topics.sync(f.m,f.pending([],{agent_status:'working',state_change_seq:4,tool_call_seq:5}));
  assert.deepEqual(cotLog(f),[['update','c1',...said('status-4','继续运行'),closed('t1')]]);assert.equal(f.t.cot!.waiting,false);
  // Blocked without a request, such as on a question that Feishu cannot answer.
  f.api.length=0;await f.topics.sync(f.m,f.pending([],{agent_status:'blocked',state_change_seq:6,tool_call_seq:5}));
  assert.deepEqual(cotLog(f),[['update','c1',...said('status-6','等待确认')]]);
 }finally{f.close();}
});
test('once its turn ends the COT shows its last steps, finishes as done and is completed, after the replies went out as cards; the next prompted message gets a new COT',async()=>{
 const f=await readyTopic();try{
  const order:unknown[]=[],reply=f.topics.reply,request=f.topics.request;f.topics.reply=async(...args)=>{order.push('reply');return reply(...args);};f.topics.request=async(a,o)=>{order.push(o.method);return request(a,o);};
  f.h.retained['w1:p1']=[{seq:1,text:'改好了'}];f.h.toolCalls['w1:p1']=[{seq:4,tool_call_id:'t1',phase:'end',tool_name:'Edit'}];
  // A turn has not ended while the agent works, or is idle without a state change since the prompt.
  for(const fields of [{agent_status:'working',state_change_seq:2},{agent_status:'idle',state_change_seq:1}])await f.topics.sync(f.m,list(f,fields));
  assert.deepEqual(f.api,[]);
  const done=list(f,{agent_status:'done',state_change_seq:2,reply_seq:1,tool_call_seq:4});await f.topics.sync(f.m,done);
  assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('改好了')]);
  assert.deepEqual(cotLog(f),[['update','c1',closed('t1'),['RUN_FINISHED',{...run,status:'done'}]],['complete','c1','done']]);
  assert.deepEqual(f.api.at(-1),{method:'POST',url:cotPath+'/complete/c1',params:{message_id:'om_cot_1',reason:'done'}});
  assert.deepEqual(order,['reply','PUT','POST']);assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
  await f.topics.sync(f.m,done);assert.equal(f.api.length,2);
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(cotLog(f).slice(2),[['create','om_2'],['update','c2',['RUN_STARTED',{threadId:'om_1',runId:'om_2'}]]]);
 }finally{f.close();}
});
test('a topic that ends while its COT is open shows the COT failed and completes it, also when the update fails',async()=>{
 const f=await readyTopic();try{
  f.h.agents.length=0;await f.topics.sync(f.m,[]);
  assert.equal(f.t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[endedNotice]);
  assert.deepEqual(cotLog(f),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
 }finally{f.close();}
 const g=await readyTopic();try{
  const request=g.topics.request;g.topics.request=async(a,o)=>{if(o.method!=='PUT')return request(a,o);g.api.push(o as ApiRequest);throw Error('飞书未连接');};
  g.h.agents.length=0;await g.topics.sync(g.m,[]);
  assert.deepEqual(cotLog(g),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);assert.deepEqual(cotLogs(g),[['error',`${g.t.agentName}：COT 未能更新，飞书未连接`]]);
 }finally{g.close();}
});
test('an open COT is kept on disk with its topic and completed by the first sync after a restart when its turn ended meanwhile',async()=>{
 const f=await readyTopic();try{
  f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls'},{seq:4,tool_call_id:'t1',phase:'end',tool_name:'Bash'}];
  const {store,topics}=f.restart();assert.deepEqual(store.data.topics[0].cot,{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false});
  await topics.sync(f.m,list(f,{agent_status:'idle',state_change_seq:2,tool_call_seq:4}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','0']]);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls','bash'),closed('t1'),['RUN_FINISHED',{...run,status:'done'}]],['complete','c1','done']]);
  assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
 }finally{f.close();}
});
test('/stop in a ready topic sends Esc to its working or blocked agent and shows the open COT interrupted; without a COT a notice says so; the command is not prompted and gets no reaction',async()=>{
 const f=await readyTopic();try{
  f.h.agents[0].agent_status='working';f.reacted.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:' /stop '});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p1','esc']]);assert.deepEqual(f.replies,[]);assert.deepEqual(f.reacted,[]);
  assert.deepEqual(cotLog(f),[['update','c1',['RUN_FINISHED',{...run,status:'interrupted'}]],['complete','c1','error']]);assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
  assert.deepEqual(stopped(f),[['info',`${f.t.agentName}：已发送停止`]]);assert.deepEqual(f.t.messageIds,['om_1','om_2']);
  f.h.agents[0].agent_status='blocked';f.h.calls.length=0;f.api.length=0;
  await f.send({messageId:'om_3',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p1','esc']]);assert.deepEqual(f.api,[]);assert.deepEqual(f.replies.map(r=>r[3]),[notice('已停止 Agent 当前这一轮')]);
 }finally{f.close();}
});
test('/stop without a running turn sends no key and replies a notice; a /stop that cannot reach the agent is logged with a notice',async()=>{
 const f=await readyTopic();try{
  for(const status of ['idle','done','unknown']){f.h.agents[0].agent_status=status;await f.send({messageId:'om_'+status,rootId:'om_1',content:'/stop'});}
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list'],['agent','list']]);assert.deepEqual(f.api,[]);assert.equal(f.t.cot!.cotId,'c1');
  assert.deepEqual(f.replies.map(r=>r[3]),Array(3).fill(notice('Agent 当前没有在运行的一轮')));
  f.h.agents[0].agent_status='working';f.replies.length=0;f.h.on['agent send-keys']=()=>{throw coded('agent_not_ready','agent w1:p1 is not ready');};
  await f.send({messageId:'om_4',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能停止 Agent，请稍后重试')]);assert.deepEqual(stopped(f),[['error',`${f.t.agentName}：未能停止，agent w1:p1 is not ready`]]);assert.equal(f.t.cot!.cotId,'c1');
 }finally{f.close();}
});
test('in a binding that requires the mention, /stop in a topic thread needs it too: without it no key is sent and nothing is recorded or replied',async()=>{
 const f=await readyTopic({binding:{requireMention:true}});try{
  f.h.agents[0].agent_status='working';f.reacted.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:'/stop'});
  assert.deepEqual([f.h.calls,f.replies,f.reacted,f.api,f.t.messageIds],[[],[],[],[],['om_1']]);assert.equal(f.t.cot!.cotId,'c1');
  await f.send({messageId:'om_3',rootId:'om_1',content:'/stop',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p1','esc']]);assert.deepEqual(cotLog(f),[['update','c1',['RUN_FINISHED',{...run,status:'interrupted'}]],['complete','c1','error']]);
  assert.deepEqual([f.t.messageIds,f.reacted],[['om_1','om_3'],[]]);
 }finally{f.close();}
});
test('a root /stop, such as the stop button of a COT sends in a direct chat, stops the one topic of the chat whose COT is open; with none or several it asks for /stop in the topic; it never opens a topic',async()=>{
 const f=await readyTopic();try{
  await f.send({messageId:'om_2',content:'two'});const [one,two]=f.store.data.topics;
  // A topic of another binding with an open COT does not count.
  f.store.data.topics.push({...structuredClone(two),id:'other',bindingId:'other',rootId:'om_other'});
  for(const a of f.h.agents)a.agent_status='working';f.h.calls.length=0;f.api.length=0;f.replies.length=0;
  await f.send({messageId:'om_stop1',content:' /stop '});
  const ask=['a','oc_1','om_stop1',notice('请在要停止的话题里发送 /stop')];assert.deepEqual(f.replies,[ask]);assert.deepEqual([f.h.calls,f.api],[[],[]]);
  delete one.cot;await f.send({messageId:'om_stop2',content:'/stop',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p2','esc']]);assert.deepEqual(cotLog(f),[['update','c2',['RUN_FINISHED',{threadId:'om_2',runId:'om_2',status:'interrupted'}]],['complete','c2','error']]);
  assert.equal(f.replies.length,1);f.h.calls.length=0;
  await f.send({messageId:'om_stop3',content:'/stop'});assert.deepEqual(f.replies.at(-1),['a','oc_1','om_stop3',notice('请在要停止的话题里发送 /stop')]);assert.deepEqual(f.h.calls,[]);
  assert.deepEqual(f.store.data.topics.map(t=>t.rootId),['om_1','om_2','om_other']);assert.deepEqual(f.reacted.map(r=>r[1]).filter(id=>id.startsWith('om_stop')),[]);
 }finally{f.close();}
});

// Adoption. On cpu2 (machine m), besides the ready bridge topic om_1 in w1:p1 with its open COT c1, workspace w2 (herdr) holds: in tab 1, a
// Claude with the Herdr name review, a session and two retained replies in the pane labelled 赤尾重构; in tab 出题, a Codex attached to its
// background app-server without a session or replies in a pane without a label; and a pane without an agent. cpu1 cannot be reached, gpu1
// runs no agent and the disconnected gpu2 is left out.
const claudePane={agent:'claude',name:'review',pane_id:'w2:p1',workspace_id:'w2',tab_id:'w2:t1',cwd:'/home/someone/code/herdr',agent_status:'idle',state_change_seq:4,reply_seq:2,agent_session:{source:'herdr:claude',agent:'claude',kind:'id',value:'s-claude'}};
const codexPane={agent:'codex',pane_id:'w2:p2',workspace_id:'w2',tab_id:'w2:t2',cwd:'/srv/app',agent_status:'working',state_change_seq:7};
const claudeChoice={machine:'m',pane:'w2:p1',kind:'claude',name:'review',session:'s-claude'},codexChoice={machine:'m',pane:'w2:p2',kind:'codex'};
// The picker: a form whose dropdown offers an option per agent and whose 接管 button submits the chosen one; machines that cannot be reached
// follow it. Each option carries what the agent is checked against when it is chosen.
const option=(content:string,choice:object)=>({text:{tag:'plain_text',content},value:JSON.stringify(choice)});
const pickerForm=(render:number,...options:object[])=>({tag:'form',name:'picker',elements:[{tag:'select_static',name:'agent',width:'fill',placeholder:{tag:'plain_text',content:'选择要接管的 Agent'},options},
 {tag:'button',text:{tag:'plain_text',content:'接管'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{adopt:true,render}}]}]});
const claudeOption=option('cpu2 · 赤尾重构 · Claude · 空闲',claudeChoice),codexOption=option('cpu2 · 出题 · Codex · 运行中',codexChoice),cpu1Down=plainText('cpu1 · 连接失败');
// The picker of the agents above with its render number; a notice comes first.
const pickerCard=(render:number,notice?:string)=>cardOf('接管 Agent','blue',[...notice?[plainText(notice)]:[],pickerForm(render,claudeOption,codexOption),cpu1Down]);
const introLines=['话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在终端的 pane 里运行。'];
const adoptLogs=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='话题接管').map(l=>[l.level,l.message]);
// What a submission of the picker form holds: the value of the chosen option, a raw string as is, or nothing when no option was chosen.
const formValue=(adopt:unknown)=>adopt===undefined?{}:{agent:typeof adopt==='string'?adopt:JSON.stringify(adopt)};
async function adoptFixture(binding?:Partial<Binding>){
 const f=topicFixture({binding,machines:[{id:'m2',name:'cpu1',enabled:true},{id:'m3',name:'gpu1',enabled:true},{id:'m4',name:'gpu2',enabled:false}] as Machine[]});
 await f.send({messageId:'om_1',content:'bridge topic',mentionedBot:true});
 f.h.agents.push(structuredClone(claudePane),structuredClone(codexPane),{name:'shell',pane_id:'w2:p3',workspace_id:'w2',tab_id:'w2:t1',agent_status:'unknown',state_change_seq:0});
 // Herdr labels a tab without a name by its position.
 f.h.workspaces.push({workspace_id:'w2',label:'herdr'});f.h.tabs.push({tab_id:'w2:t1',workspace_id:'w2',label:'1'},{tab_id:'w2:t2',workspace_id:'w2',label:'出题'});
 f.h.panes.push({pane_id:'w2:p1',workspace_id:'w2',tab_id:'w2:t1',label:'赤尾重构'},{pane_id:'w2:p2',workspace_id:'w2',tab_id:'w2:t2'},{pane_id:'w2:p3',workspace_id:'w2',tab_id:'w2:t1'});
 f.h.retained['w2:p1']=[{seq:1,text:'旧回复'},{seq:2,text:'\n改好了。\n\n- 修复了登录'}];
 f.h.hosts.m2={down:'ssh: connect to host cpu1 port 22: Connection timed out'} as FakeHost;f.h.hosts.m3={agents:[],retained:{},requests:{}};
 f.h.calls.length=0;f.h.machines.length=0;f.reacted.length=0;f.unreacted.length=0;f.api.length=0;
 return {...f,
  // The topic whose thread starts at message id.
  topic:(id:string)=>f.store.data.topics.find(t=>t.rootId===id),
  pickers:()=>f.replies.filter(r=>r[3].card.header).map(r=>r[3].card),
  // A submission of picker messageId by an allowed person with agent adopt chosen (see formValue).
  pick:(messageId:string,adopt?:unknown,render=1,openId='ou_user')=>f.topics.click(allowed,{messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',name:'submit',value:{adopt:true,render},formValue:formValue(adopt)}} as Click),
  settled:()=>Promise.all(f.topics.answering.values()),
  // Sends /adopt, which mentions the bot, and submits agent adopt on its picker, which is reply om_bot_<n>.
  async adopt(rootId:string,adopt:unknown,n=1){await f.send({messageId:rootId,content:'/adopt',mentionedBot:true});f.topics.click(allowed,{messageId:'om_bot_'+n,chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',name:'submit',value:{adopt:true,render:n},formValue:formValue(adopt)}} as Click);await Promise.all(f.topics.answering.values());return f.store.data.topics.find(t=>t.rootId===rootId);},
 };
}
test('an agent is named by the label of its pane, else the label given to its tab, else the label of its workspace, else its pane; agents that would share a name are told apart by their panes',()=>{
 const snapshot=(agents:Agent[],{panes=[],tabs=[],workspaces=[]}:Partial<Omit<Snapshot,'agents'>>={}):Snapshot=>({agents,panes,tabs,workspaces}),workspaces=[{workspace_id:'w1',label:'herdr'}];
 const x={agent:'claude',pane_id:'w1:p1',tab_id:'w1:t1',workspace_id:'w1'} as Agent;
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1',label:'赤尾重构'}],tabs:[{tab_id:'w1:t1',label:'重构'}],workspaces}),x),'赤尾重构');
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1'}],tabs:[{tab_id:'w1:t1',label:'重构'}],workspaces}),x),'重构');
 // Herdr labels a tab without a name by its position, which names nothing.
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1'}],tabs:[{tab_id:'w1:t1',label:'3'}],workspaces}),x),'herdr');
 assert.equal(nameOf(snapshot([x]),x),'w1:p1');
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1',label:'很'.repeat(50)}]}),x),'很'.repeat(39)+'…');
 // Two agents split in one tab without pane labels; an agent with a name of its own keeps it.
 const y={...x,agent:'codex',pane_id:'w1:p2'},z={...x,pane_id:'w1:p3',tab_id:'w1:t2'};
 const s=snapshot([x,y,z],{panes:[{pane_id:'w1:p1'},{pane_id:'w1:p2'},{pane_id:'w1:p3',label:'出题'}],tabs:[{tab_id:'w1:t1',label:'重构'},{tab_id:'w1:t2',label:'2'}],workspaces});
 assert.deepEqual([x,y,z].map(a=>nameOf(s,a)),['重构 (w1:p1)','重构 (w1:p2)','出题']);
});
test('/adopt as a root message replies in its thread with a picker whose dropdown names each agent on every connected machine by machine, the pane name the person gave in Herdr, kind and status, leaving out panes that topics of any binding hold; an unreachable machine shows 连接失败 outside it; each machine is read with one Herdr call',async()=>{
 const f=await adoptFixture();try{
  // A ready topic of another binding holds w2:p4, which shares the 出题 tab with the Codex: only the agents offered are told apart by their
  // panes. A closed topic no longer holds the Codex pane.
  f.h.agents.push({agent:'claude',name:'other',pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:1,remote_answers:true});
  f.store.data.topics.push({...f.topic('om_1')!,id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p4'},{...f.topic('om_1')!,id:'old',rootId:'om_old',paneId:'w2:p2',state:'closed'});
  await f.send({messageId:'om_cmd',content:' /adopt '});
  assert.deepEqual(f.replies,[['a','oc_1','om_cmd',{card:pickerCard(1)}]]);
  assert.deepEqual(callsOn(f).map(c=>JSON.stringify(c)).sort(),[['m','api','snapshot'],['m2','api','snapshot'],['m3','api','snapshot']].map(c=>JSON.stringify(c)).sort());
  const {id,createdAt,...rest}=f.topic('om_cmd')!;assert.ok(createdAt>0);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_cmd',machineId:'',workspaceId:'',tabId:'',paneId:'',agentName:'',title:'接管 Agent',state:'choosing',error:'',messageIds:['om_cmd'],replySeq:0,reactions:[],cards:[],adopted:{picker:'om_bot_1'}});
  assert.deepEqual(new Store(f.dir).data.topics.find(t=>t.id===id)!.adopted,{picker:'om_bot_1'});
  assert.deepEqual(f.reacted,[]);assert.equal(f.h.calls.some(c=>['workspace','tab'].includes(c[0])||c[1]==='start'||c[1]==='prompt'),false);
  assert.deepEqual(adoptLogs(f),[['error','cpu1：ssh: connect to host cpu1 port 22: Connection timed out'],['info','个人助手：已发送可接管的 Agent 列表']]);
 }finally{f.close();}
});
test('/adopt is a command only on a root message: in a thread it is a message to the agent, a mention-only group needs the @, and a repeated delivery sends one picker',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'/adopt',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','/adopt']]);assert.deepEqual(f.replies,[]);
  f.h.calls.length=0;await f.send({messageId:'om_cmd',content:'/adopt'});
  assert.deepEqual([f.h.calls,f.replies,f.topic('om_cmd')],[[],[],undefined]);
  await f.send({messageId:'om_cmd2',content:'/adopt',mentionedBot:true});await f.send({messageId:'om_cmd2',content:'/adopt',mentionedBot:true});
  assert.deepEqual(f.replies.map(r=>r[2]),['om_cmd2']);assert.equal(f.pickers().length,1);
 }finally{f.close();}
});
test('the Chinese commands of earlier versions are messages like any other: /接管 opens a topic and /结束接管 is prompted to the adopted agent',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_old',content:'/接管'});
  assert.equal(f.topic('om_old')!.adopted,undefined);assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['/接管']);assert.equal(f.pickers().length,0);
  const t=await f.adopt('om_cmd',claudeChoice,1);f.h.calls.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'/结束接管'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w2:p1','/结束接管']]);assert.equal(t!.state,'ready');
 }finally{f.close();}
});
test('a message in the thread of a picker before any selection gets a notice, is not prompted and opens no tab',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'先说一句'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies,[['a','oc_1','om_cmd',notice('请先在上面的卡片中选择要接管的 Agent')]]);
  assert.deepEqual(f.unreacted,[['a','om_2','r_om_2']]);assert.deepEqual([f.topic('om_cmd')!.state,f.topic('om_cmd')!.messageIds],['choosing',['om_cmd','om_2']]);
 }finally{f.close();}
});
test('a picker that Feishu refuses is logged and its topic closed',async()=>{
 const f=await adoptFixture();try{
  f.topics.reply=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_cmd',content:'/adopt'});
  assert.equal(f.topic('om_cmd')!.state,'closed');assert.deepEqual(adoptLogs(f).at(-1),['error','个人助手：可接管的 Agent 列表未发出，飞书未连接']);
 }finally{f.close();}
});
test('submitting an agent turns on its remote answers, links the topic to its machine and pane under its pane name, posts the intro with its full latest reply and marks the picker adopted',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.h.machines.length=0;f.replies.length=0;
  assert.deepEqual(f.pick('om_bot_1',claudeChoice),{toast:{type:'info',content:'正在接管'}});
  await f.settled();
  assert.deepEqual(callsOn(f),[['m','api','snapshot'],['m','pane','remote-answers','w2:p1','on'],['m','agent','replies','w2:p1','--after','1']]);
  const t=f.topic('om_cmd')!,{id,createdAt,messageIds,...rest}=t;
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_cmd',machineId:'m',workspaceId:'w2',tabId:'w2:t1',paneId:'w2:p1',agentName:'赤尾重构',title:'接管 · 赤尾重构',state:'ready',error:'',replySeq:2,reactions:[],cards:[],adopted:{picker:'om_bot_1',kind:'claude',session:'s-claude'}});
  assert.equal(new Store(f.dir).data.topics.find(x=>x.id===id)!.state,'ready');assert.equal(f.h.agents.find(a=>a.pane_id==='w2:p1')!.remote_answers,true);
  assert.deepEqual(f.replies,[['a','oc_1','om_cmd',notice(['已接管 cpu2 上的 Claude · 赤尾重构','工作目录：~/code/herdr',...introLines,'最近一条回复：'].join('\n'),
   '已接管 cpu2 上的 Claude · 赤尾重构 工作目录：~/code/herdr 话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在…')],['a','oc_1','om_cmd',replyOf('\n改好了。\n\n- 修复了登录','改好了。 - 修复了登录')]]);
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('接管 Agent','green',[plainText('cpu2 · 赤尾重构 · Claude · 空闲'),{tag:'markdown',content:'已接管 · <at id=ou_user></at>'}])]]);
  assert.deepEqual(adoptLogs(f).at(-1),['info','个人助手：已接管 cpu2 上的 赤尾重构']);
  // The picker takes no further selection.
  assert.deepEqual(f.pick('om_bot_1',codexChoice),{toast:{type:'info',content:'这个话题已接管 Agent，不能再选择'}});await f.settled();assert.equal(f.h.calls.length,3);
 }finally{f.close();}
});
test('an agent without a reported session gets a warning in the intro; an agent without replies gets no reply; a pane without a label is named after its tab',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.replies.length=0;
  f.pick('om_bot_1',codexChoice);await f.settled();
  assert.deepEqual(f.h.calls,[['api','snapshot'],['pane','remote-answers','w2:p2','on']]);
  assert.deepEqual(f.replies.map(r=>r[3]),[notice(['已接管 cpu2 上的 Codex · 出题','工作目录：/srv/app',...introLines,'这个 Agent 没有向 Herdr 上报会话（例如连着后台 app-server 的 Codex），它的回复可能无法转回飞书。'].join('\n'),
   '已接管 cpu2 上的 Codex · 出题 工作目录：/srv/app 话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在终端的 pan…')]);
  const t=f.topic('om_cmd')!;assert.deepEqual([t!.paneId,t!.agentName,t!.title,t!.replySeq,t!.adopted],['w2:p2','出题','接管 · 出题',0,{picker:'om_bot_1',kind:'codex'}]);
 }finally{f.close();}
});
test('a selection whose agent exited or changed meanwhile, whose remote answers cannot be turned on or whose machine was disconnected links nothing and redraws the picker with the reason and the agents left',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});const t=f.topic('om_cmd')!;
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w2:p1');f.h.calls.length=0;
  assert.deepEqual(f.pick('om_bot_1',claudeChoice),{toast:{type:'info',content:'正在接管'}});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('接管 Agent','blue',[plainText('所选的 Agent 已退出或已变化，请重新选择'),pickerForm(2,codexOption),cpu1Down])]]);
  assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.deepEqual([t!.state,t!.paneId],['choosing','']);
  // The same pane with another session holds another agent.
  f.h.agents.push({...structuredClone(claudePane),agent_session:{...claudePane.agent_session,value:'s-other'}});f.h.calls.length=0;
  f.pick('om_bot_1',claudeChoice,2);await f.settled();
  assert.deepEqual(f.updated.at(-1)![2].body.elements[0],plainText('所选的 Agent 已退出或已变化，请重新选择'));assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.equal(t!.state,'choosing');
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  f.pick('om_bot_1',codexChoice,3);await f.settled();
  assert.deepEqual(f.updated.at(-1)![2].body.elements[0],plainText('接管失败，请稍后重试'));assert.deepEqual([t!.state,t!.paneId],['choosing','']);
  assert.deepEqual(adoptLogs(f).filter(l=>l[1].startsWith('个人助手：接管失败')),[['error','个人助手：接管失败，连接超时，请检查 SSH 与 Herdr 状态']]);
  // A machine disconnected meanwhile is left out of the redrawn picker.
  f.m.enabled=false;f.pick('om_bot_1',codexChoice,4);await f.settled();
  assert.deepEqual(f.updated.at(-1)![2],cardOf('接管 Agent','blue',[plainText('所选的机器已断开，请重新选择'),plainText('没有可以接管的 Agent'),cpu1Down]));
  assert.deepEqual([t!.state,t!.paneId],['choosing','']);f.m.enabled=true;
  // A selection from the redrawn picker still works.
  f.pick('om_bot_1',codexChoice,5);await f.settled();assert.deepEqual([t!.state,t!.paneId],['ready','w2:p2']);
 }finally{f.close();}
});
test('two pickers selecting the same agent at once link it to one topic only; the other picker says it was adopted meanwhile and no longer lists it',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_a',content:'/adopt'});await f.send({messageId:'om_b',content:'/adopt'});
  f.h.calls.length=0;f.pick('om_bot_1',codexChoice);f.pick('om_bot_2',codexChoice,2);await f.settled();
  assert.deepEqual([f.topic('om_a')!.state,f.topic('om_b')!.state],['ready','choosing']);assert.equal(f.h.calls.filter(c=>c[0]==='pane').length,1);
  const [,,card]=f.updated.find(u=>u[1]==='om_bot_2')!;
  assert.deepEqual(card,cardOf('接管 Agent','blue',[plainText('所选的 Agent 已被其他话题接管，请重新选择'),pickerForm(3,claudeOption),cpu1Down]));
 }finally{f.close();}
});
test('agents offered under the same name on one machine are told apart by their panes, in the picker and in the topic that adopts one; agents that topics hold do not count',async()=>{
 const f=await adoptFixture();try{
  // A second Codex split into the 出题 tab, and a Claude there that a ready topic of another binding holds.
  f.h.agents.push({agent:'codex',pane_id:'w2:p5',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:2},{agent:'claude',pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:1,remote_answers:true});
  f.h.panes.push({pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2'},{pane_id:'w2:p5',workspace_id:'w2',tab_id:'w2:t2'});
  f.store.data.topics.push({...f.topic('om_1')!,id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p4'});
  const offered=(card:Card)=>find(card,'select_static')[0].options.map((o:Record<string,any>)=>o.text.content);
  await f.send({messageId:'om_a',content:'/adopt'});
  assert.deepEqual(offered(f.pickers()[0]),['cpu2 · 赤尾重构 · Claude · 空闲','cpu2 · 出题 (w2:p2) · Codex · 运行中','cpu2 · 出题 (w2:p5) · Codex · 空闲']);
  f.pick('om_bot_1',{machine:'m',pane:'w2:p5',kind:'codex'});await f.settled();
  assert.deepEqual([f.topic('om_a')!.agentName,f.topic('om_a')!.title],['出题 (w2:p5)','接管 · 出题 (w2:p5)']);
  // Once a topic holds w2:p5, the Codex left goes by the tab's name alone.
  await f.send({messageId:'om_b',content:'/adopt'});
  assert.deepEqual(offered(f.pickers()[1]),['cpu2 · 赤尾重构 · Claude · 空闲','cpu2 · 出题 · Codex · 运行中']);
  f.pick('om_bot_3',codexChoice,2);await f.settled();
  assert.deepEqual([f.topic('om_b')!.agentName,f.topic('om_b')!.title],['出题','接管 · 出题']);
 }finally{f.close();}
});
test('a submission without a chosen agent, or with a value that is no choice of the picker, gets a warning, adopts nothing and draws the picker again so that it can be submitted again',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});const t=f.topic('om_cmd')!;f.h.calls.length=0;
  assert.deepEqual(f.pick('om_bot_1',undefined),{toast:{type:'warning',content:'请选择要接管的 Agent'}});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',pickerCard(2,'请选择要接管的 Agent')]]);
  for(const [i,value] of ['not json','null','{"machine":"m"}'].entries()){
   assert.deepEqual(f.pick('om_bot_1',value,2+i),{toast:{type:'warning',content:'请选择要接管的 Agent'}},value);await f.settled();
   assert.deepEqual(f.updated.at(-1)![2],pickerCard(3+i,'请选择要接管的 Agent'),value);
  }
  assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.deepEqual([t!.state,t!.paneId],['choosing','']);
  // The picker drawn again takes a choice.
  f.pick('om_bot_1',claudeChoice,5);await f.settled();assert.deepEqual([t!.state,t!.paneId,t!.agentName],['ready','w2:p1','赤尾重构']);
 }finally{f.close();}
});
test('a click on a picker without a topic gets a toast that the card has expired; a second click while one is being adopted waits for it',async()=>{
 const f=await adoptFixture();try{
  assert.deepEqual(f.pick('om_unknown',claudeChoice),{toast:{type:'info',content:'这张卡片已失效，请重新发送 /adopt'}});
  await f.send({messageId:'om_cmd',content:'/adopt'});
  let release!:()=>void;f.h.on['pane remote-answers']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  f.pick('om_bot_1',claudeChoice);await later(5);
  assert.deepEqual(f.pick('om_bot_1',codexChoice,1,'ou_owner'),{toast:{type:'info',content:'正在接管，请稍候'}});
  release();await f.settled();assert.equal(f.topic('om_cmd')!.paneId,'w2:p1');assert.equal(f.h.calls.filter(c=>c[0]==='pane').length,1);
 }finally{f.close();}
});
test('an adopted topic prompts its pane, forwards only the replies after the one in the intro, sends request cards, opens a COT for a prompted message and completes it when the turn ends, and never opens a tab',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);f.h.calls.length=0;f.h.machines.length=0;f.replies.length=0;f.api.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});
  assert.deepEqual(callsOn(f),[['m','agent','list'],['m','agent','prompt','w2:p1','继续']]);assert.deepEqual([t!.reactions,t!.cot!.origin,t!.cot!.stateSeq],[[],'om_2',4]);
  assert.deepEqual(cotLog(f),[['create','om_2'],['update','c2',['RUN_STARTED',{threadId:'om_cmd',runId:'om_2'}]]]);
  const agent=f.h.agents.find(a=>a.pane_id==='w2:p1');f.h.retained['w2:p1'].push({seq:3,text:'新回复'});f.h.requests['w2:p1']=[bash];f.h.calls.length=0;
  await f.topics.sync(f.m,f.h.agents.map(a=>a===agent?{...a,reply_seq:3,request_ids:[1],agent_status:'done',state_change_seq:9}:a));
  assert.deepEqual(f.replies.map(r=>r[2]),['om_cmd','om_cmd']);assert.deepEqual(f.replies[0][3],replyOf('新回复'));assert.equal(f.replies[1][3].card.header!.title.content,'权限确认 · Bash');
  assert.deepEqual(f.h.calls,[['agent','replies','w2:p1','--after','2'],['agent','requests','w2:p1']]);
  assert.deepEqual(cotLog(f).slice(2),[['update','c2',['RUN_FINISHED',{threadId:'om_cmd',runId:'om_2',status:'done'}]],['complete','c2','done']]);assert.equal(t!.cot,undefined);
  assert.deepEqual(t!.cards,[{requestId:1,messageId:'om_bot_5',title:'权限确认 · Bash'}]);
 }finally{f.close();}
});
test('/release in an adopted topic turns off its remote answers and ends the topic without touching the pane, which keeps running; later messages are not prompted',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});
  f.h.calls.length=0;f.replies.length=0;f.reacted.length=0;f.unreacted.length=0;f.api.length=0;
  await f.send({messageId:'om_3',rootId:'om_cmd',content:' /release '});
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w2:p1','off']]);assert.equal(t!.state,'closed');assert.equal(new Store(f.dir).data.topics.find(x=>x.id===t!.id)!.state,'closed');
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_cmd',notice('已结束接管。Agent 仍在终端的 pane 里运行，话题里的消息不再发给它')]]);
  assert.equal(f.h.agents.find(a=>a.pane_id==='w2:p1')!.remote_answers,undefined);assert.deepEqual(adoptLogs(f).at(-1),['info','个人助手：已结束接管 cpu2 上的 赤尾重构']);
  // The command gets no reaction; the COT of the turn still running ends as failed with the topic.
  assert.deepEqual(f.reacted,[]);assert.deepEqual(f.unreacted,[]);assert.deepEqual(cotLog(f),[['update','c2',['RUN_ERROR',{message:'话题已结束'}]],['complete','c2','error']]);
  f.h.calls.length=0;await f.send({messageId:'om_4',rootId:'om_cmd',content:'还在吗'});await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release'});
  assert.deepEqual(f.h.calls,[]);assert.equal(f.replies.length,1);
 }finally{f.close();}
});
test('/release anywhere but an adopted topic is an ordinary message: a bridge topic prompts it to its agent',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'/release'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','/release']]);assert.equal(f.topic('om_1')!.state,'ready');
 }finally{f.close();}
});
test('when /release cannot turn off remote answers the topic stays linked with a notice, unless its agent turns out to be gone, which ends the topic',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);f.replies.length=0;
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'/release'});
  assert.equal(t!.state,'ready');assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能结束接管，请稍后重试')]);assert.match(adoptLogs(f).at(-1)![1],/^个人助手：未能结束接管，连接超时/);
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w2:p1');f.h.on['pane remote-answers']=()=>{throw coded('pane_not_found','pane w2:p1 not found');};f.replies.length=0;
  await f.send({messageId:'om_3',rootId:'om_cmd',content:'/release'});
  assert.equal(t!.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[adoptedGone]);
 }finally{f.close();}
});
test('in a binding that requires the mention, a topic that waits for a choice ignores messages without it; with it they get the notice to choose',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  await f.send({messageId:'om_cmd',content:'/adopt',mentionedBot:true});const t=f.topic('om_cmd')!;f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'选好了吗'});
  assert.deepEqual([f.h.calls,f.replies,f.reacted,t!.messageIds],[[],[],[],['om_cmd']]);
  await f.send({messageId:'om_3',rootId:'om_cmd',content:'选好了吗',mentionedBot:true});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('请先在上面的卡片中选择要接管的 Agent')]);assert.deepEqual(t!.messageIds,['om_cmd','om_3']);
 }finally{f.close();}
});
test('in a binding that requires the mention, messages in an adopted topic need it too, /release included: without it the topic stays linked and nothing is prompted',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  const t=await f.adopt('om_cmd',claudeChoice);assert.equal(t!.state,'ready');f.h.calls.length=0;f.replies.length=0;f.reacted.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});await f.send({messageId:'om_3',rootId:'om_cmd',content:'/release'});
  assert.deepEqual([f.h.calls,f.replies,f.reacted,t!.state,t!.messageIds],[[],[],[],'ready',['om_cmd']]);
  await f.send({messageId:'om_4',rootId:'om_cmd',content:'继续',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w2:p1','继续']]);f.h.calls.length=0;
  await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w2:p1','off']]);assert.equal(t!.state,'closed');
 }finally{f.close();}
});
test('an adopted topic ends with its own notice when its pane closes, its agent exits or another agent takes the pane; no pane is closed',async()=>{
 const changes={gone:(agents:Agent[])=>agents.filter(a=>a.pane_id!=='w2:p1'),replaced:(agents:Agent[])=>agents.map(a=>a.pane_id==='w2:p1'?{...a,agent:'codex',agent_session:undefined,remote_answers:undefined}:a)};
 for(const [name,change] of Object.entries(changes)){
  const f=await adoptFixture();try{
   const t=await f.adopt('om_cmd',claudeChoice);f.h.calls.length=0;f.replies.length=0;f.h.agents=change(f.h.agents);
   await f.topics.sync(f.m,f.h.agents);
   assert.equal(t!.state,'closed',name);assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_cmd',adoptedGone]],name);assert.deepEqual(f.h.calls,[['agent','list']],name);
   assert.equal(f.topic('om_1')!.state,'ready',name);
  }finally{f.close();}
 }
});
test('removing a binding drops its topics, turns off remote answers for those linked to an agent, bridge-opened or adopted, and shows their open COT failed; a failure is only logged',async()=>{
 const f=await adoptFixture();try{
  await f.adopt('om_cmd',claudeChoice);await f.send({messageId:'om_cmd2',content:'/adopt'});
  const {cot,...linked}=f.topic('om_1')!,other={...linked,id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p2'};f.store.data.topics.push(other);
  f.h.calls.length=0;f.h.machines.length=0;f.api.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.store.data.topics,[other]);assert.deepEqual(new Store(f.dir).data.topics.map(t=>t.id),['other']);
  assert.deepEqual(callsOn(f),[['m','pane','remote-answers','w1:p1','off'],['m','pane','remote-answers','w2:p1','off']]);
  assert.equal(cot!.cotId,'c1');assert.deepEqual(cotLog(f),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};await f.topics.unbind('other');
  assert.deepEqual(f.store.data.topics,[]);assert.match(f.store.data.logs.at(-1)!.message,/未能关闭.*连接超时/);
 }finally{f.close();}
});
test('an adopted topic writes attachments under the working directory that Herdr reports for its agent, where the agent runs before where its shell is; without one they fail; /release removes the directory',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice),prompts=()=>f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),root='/home/someone/code/herdr/.herdr-bridge';f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',...imageOf('img_a')});
  assert.deepEqual(f.stored,[['m',root,t!.id,'om_2-1.png','data:img_a']]);assert.deepEqual(prompts().at(-1),`[图片 1：${root}/${t!.id}/om_2-1.png]`);
  const agent=f.h.agents.find(a=>a.pane_id==='w2:p1');agent!.foreground_cwd='/home/someone/code/herdr/sub';
  await f.send({messageId:'om_3',rootId:'om_cmd',...imageOf('img_b')});
  assert.equal(f.stored.at(-1)![1],'/home/someone/code/herdr/sub/.herdr-bridge');assert.equal(t!.attachmentDir,`/home/someone/code/herdr/sub/.herdr-bridge/${t!.id}`);
  delete agent!.foreground_cwd;delete agent!.cwd;assert.deepEqual(f.replies,[]);
  await f.send({messageId:'om_4',rootId:'om_cmd',...imageOf('img_c')});
  assert.deepEqual([f.stored.length,f.downloads.length,prompts().at(-1)],[2,2,'[图片 1：下载失败]']);assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能把附件交给 Agent：图片 1 写入失败')]);
  assert.match(attachmentLogs(f).at(-1)![1],/图片 1 写入失败，Agent 的工作目录未知/);
  await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release'});
  assert.equal(t!.state,'closed');assert.deepEqual(f.removed,[['m',`/home/someone/code/herdr/sub/.herdr-bridge/${t!.id}`]]);assert.equal(t!.attachmentDir,undefined);
 }finally{f.close();}
});

// A throwaway repository main with one commit, in a directory of its own; target(branch) is where the worktree of branch goes, and
// origin(branch) gives main an origin that has branch, which main has not fetched.
function gitRepo(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-wt-'))),main=path.join(root,'main');fs.mkdirSync(main);
 git(main,'init','-q','-b','main');git(main,'commit','-q','--allow-empty','-m','init');
 return {root,main,target:(branch:string)=>path.join(root,'main-worktrees',branch.replaceAll('/','-')),
  origin(branch:string){const origin=path.join(root,'origin.git');git(root,'clone','-q','--bare',main,origin);git(main,'remote','add','origin',origin);git(origin,'branch',branch,'main');},
  close(){fs.rmSync(root,{recursive:true,force:true});}};
}
// A topic fixture whose binding works in a repository of its own (see gitRepo), by default in its main checkout.
function wtFixture({project,...options}:TopicOptions={}){const repo=gitRepo(),f=topicFixture({...options,project:{adopted:{machineId:'m',dir:repo.main},...project}});return {...f,repo,close(){f.close();repo.close();}};}
const gitArgs=(cwd:string,...args:string[])=>['git',cwd,...args];
// A notice of several lines, whose summary has its whitespace collapsed and holds at most 100 code points.
const noticeOf=(text:string)=>{const s=[...text.replace(/\s+/g,' ').trim()];return notice(text,s.length>100?s.slice(0,99).join('')+'…':s.join(''));};
const intro=(branch:string,p:string,...notes:string[])=>noticeOf(['已在 cpu2 新建 worktree',`分支：${branch}`,`路径：${p}`,...notes].join('\n'));
const wtUsage=notice('用法：/wt <任务描述>，或 /wt -b <已有分支> [任务描述]'),notRetried=notice('这个 worktree 话题没有启动成功，请重新发送 /wt 开新话题');
const randomName=/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/;
const removeButton=(render?:number)=>({tag:'button',text:{tag:'plain_text',content:'删除 worktree'},type:'danger',behaviors:[{type:'callback',value:{worktree:'remove',render}}]});
const keptHint=plainText('worktree 已保留。删除时如有未提交的改动会拒绝，分支始终保留');
// The card of a worktree topic without an agent: heading and text, the branch and path of its worktree, then the hint and the button drawn
// with render, what a click that removed nothing found and the button, or who removed it.
const removalCardOf=(heading:string,text:string,branch:string,p:string,{render,refused,removed}:{render?:number,refused?:string,removed?:string}={})=>cardOf(heading,removed?'green':refused?'orange':'grey',[plainText(text),plainText(`分支：${branch}\n路径：${p}`),
 ...removed?[{tag:'markdown',content:`${removed} · <at id=ou_user></at>`}]:[refused?plainText(refused):keptHint,removeButton(render)]]);
const endedText='该话题的会话已结束，请发起新话题';
// A click on the 删除 worktree button of card messageId as drawn with render, by an allowed person unless openId says otherwise.
const removeClick=(messageId:string,render:number,openId='ou_user'):Clicked=>({messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',value:{worktree:'remove',render}}});
test('worktree branches: haiku\'s answer names a branch only with a clean exit and a valid BRANCH= line, the fallback looks like Herdr\'s names, and the worktree of a branch is beside its repository with / as -',()=>{
 assert.equal(parseBranch('x\nBRANCH=feat/a-b c\nBRANCH=fix/z'),'feat/a-b');assert.equal(parseBranch('nothing'),undefined);
 for(const b of ['feat/add-login','fix/a1','style/x'])assert.ok(validBranch(b),b);
 for(const b of ['feature/x','feat/','feat/Add','feat/a_b','feat/a--b','feat/-a','feat/a/b','feat/'+'a'.repeat(60),'Feat/x'])assert.ok(!validBranch(b),b);
 assert.deepEqual(branchOf({code:0,stdout:'Sure.\nBRANCH=feat/add-login\n',stderr:''}),{branch:'feat/add-login'});
 assert.deepEqual(branchOf({code:1,stdout:'',stderr:' Not logged in \n'}),{reason:'claude 退出码 1：Not logged in'});
 assert.deepEqual(branchOf({code:0,stdout:'BRANCH=Feature/X\n',stderr:''}),{reason:'输出里没有可用的 BRANCH= 行：BRANCH=Feature/X'});
 for(let i=0;i<20;i++)assert.match(randomBranch(),randomName);
 assert.equal(worktreePath('/src/genvi','feat/a/b'),'/src/genvi-worktrees/feat-a-b');assert.equal(continueBranch('fix/x'),'Continue work on branch fix/x');
 assert.match(namingPrompt('加验证码'),/^You are a git branch naming tool[\s\S]*BRANCH=type\/short-kebab-name[\s\S]*Requirement:\n加验证码$/);
});
test('/wt with a description names the branch with Claude haiku on the binding machine, creates the worktree beside the repository through Herdr without changing focus, starts the agent in its root pane like any topic, names the branch and path in its first reply and prompts the description',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt 给登录页加验证码\n第二行'});
  const t=f.store.data.topics[0],target=f.repo.target('feat/add-login');
  assert.deepEqual(f.naming,[{cwd:f.repo.main,prompt:namingPrompt('给登录页加验证码\n第二行'),timeoutMs:30000}]);
  assert.deepEqual(f.execs,[['m',...gitArgs(f.repo.main,'rev-parse','--path-format=absolute','--git-dir','--git-common-dir')],['m','askCheapModel',f.repo.main],['m','exists',target],
   ['m',...gitArgs(f.repo.main,'show-ref','--verify','--quiet','refs/heads/feat/add-login')],['m',...gitArgs(f.repo.main,'fetch','--quiet','origin','+refs/heads/feat/add-login:refs/remotes/origin/feat/add-login')],
   ['m',...gitArgs(f.repo.main,'show-ref','--verify','--quiet','refs/remotes/origin/feat/add-login')]]);
  assert.deepEqual(f.h.calls,[['worktree','create','--cwd',f.repo.main,'--branch','feat/add-login','--path',target,'--no-focus'],['agent','start',t.agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],
   ['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1','给登录页加验证码\n第二行']]);
  assert.deepEqual(f.h.timeouts.slice(0,2),[120000,70000]);assert.deepEqual([...new Set(f.h.machines)],['m']);
  assert.equal(git(target,'rev-parse','--abbrev-ref','HEAD'),'feat/add-login');assert.equal(git(target,'rev-parse','HEAD'),git(f.repo.main,'rev-parse','HEAD'));
  const worktree={branch:'feat/add-login',path:target,root:f.repo.main};
  assert.deepEqual([t.state,t.workspaceId,t.tabId,t.paneId,t.title,t.worktree],['ready','w1','w1:t1','w1:p1','给登录页加验证码 第二行',worktree]);assert.match(t.agentName,/^feishu-[0-9a-f]{8}$/);
  assert.deepEqual(new Store(f.dir).data.topics[0].worktree,worktree);assert.equal(f.b.workspaces,undefined);
  assert.deepEqual(f.replies,[['a','oc_1','om_1',intro('feat/add-login',target)]]);
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1']);assert.deepEqual(cotLog(f)[0],['create','om_1']);
 }finally{f.close();}
});
test('a /wt topic places Bridge\'s skills in its new worktree, once Herdr created it and right before its agent starts',async()=>{
 const f=wtFixture({config:{kind:'codex'}});try{
  await f.send({messageId:'om_1',content:'/wt 给登录页加验证码'});
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)).slice(0,2),[['worktree','create'],['agent','start']]);assert.deepEqual(f.placed,[['m',f.repo.target('feat/add-login'),'codex',1]]);
 }finally{f.close();}
});
test('/wt -b with a local branch uses it as it is, without naming or fetching; without a description the agent is asked to continue on the branch and the topic is named after it',async()=>{
 const f=wtFixture();try{
  git(f.repo.main,'branch','feat/local');git(f.repo.main,'branch','fix/crash');
  await f.send({messageId:'om_1',content:'/wt -b feat/local'});await f.send({messageId:'om_2',content:'/wt -b fix/crash  接着做\n完'});
  const [one,two]=f.store.data.topics;
  assert.deepEqual(f.naming,[]);assert.ok(!f.execs.some(c=>c.includes('fetch')));
  assert.deepEqual(f.h.calls.filter(c=>c[0]==='worktree'),[['worktree','create','--cwd',f.repo.main,'--branch','feat/local','--path',f.repo.target('feat/local'),'--no-focus'],['worktree','create','--cwd',f.repo.main,'--branch','fix/crash','--path',f.repo.target('fix/crash'),'--no-focus']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c.slice(2)),[[one.paneId,'Continue work on branch feat/local'],[two.paneId,'接着做\n完']]);
  assert.deepEqual([one.title,two.title,one.worktree!.branch!,two.worktree!.branch!],['feat/local','接着做 完','feat/local','fix/crash']);
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',intro('feat/local',f.repo.target('feat/local'))],['om_2',intro('fix/crash',f.repo.target('fix/crash'))]]);
 }finally{f.close();}
});
test('/wt -b with a branch that only origin has fetches it and creates a local branch that tracks it, which the first reply says; a branch that neither has, or an invalid name, fails before anything is created',async()=>{
 const f=wtFixture();try{
  f.repo.origin('feat/remote');await f.send({messageId:'om_1',content:'/wt -b feat/remote 接着做'});
  const target=f.repo.target('feat/remote');
  assert.equal(git(f.repo.main,'rev-parse','--abbrev-ref','feat/remote@{upstream}'),'origin/feat/remote');assert.equal(git(target,'rev-parse','--abbrev-ref','HEAD'),'feat/remote');
  assert.deepEqual(f.replies.map(r=>r[3]),[intro('feat/remote',target,'已从 origin/feat/remote 建立跟踪它的本地分支')]);assert.equal(f.store.data.topics[0].state,'ready');
  f.replies.length=0;f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'/wt -b feat/missing x'});await f.send({messageId:'om_3',content:'/wt -b bad..name x'});
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_2',noticeOf('启动失败：本地和 origin 都没有分支 feat/missing\n没有创建任何东西')],['om_3',noticeOf('启动失败：分支名无效：bad..name\n没有创建任何东西')]]);
  assert.deepEqual(f.store.data.topics.slice(1).map(t=>[t.state,t.worktree]),[['failed',{}],['failed',{}]]);assert.deepEqual(f.h.calls,[]);
  assert.equal(fs.existsSync(f.repo.target('feat/missing')),false);assert.notEqual(gitIn(f.repo.main,'show-ref','--verify','--quiet','refs/heads/feat/missing').status,0);
 }finally{f.close();}
});
test('a naming that fails falls back to a random worktree/ branch and the first reply says why: claude exits with an error, prints no usable BRANCH= line, cannot run or does not answer in time',async()=>{
 const cases:[Partial<Ran>|Error,string][]=[[{code:1,stderr:'Not logged in\n'},'claude 退出码 1：Not logged in'],[{stdout:'BRANCH=Feature/Add Login\n'},'输出里没有可用的 BRANCH= 行：BRANCH=Feature/Add Login'],
  [Error('spawn claude ENOENT'),'无法运行 claude：spawn claude ENOENT'],[Object.assign(Error('claude 在 30 秒内没有结束，已终止'),{timedOut:true}),'30 秒内没有返回']];
 for(const [claude,reason] of cases){
  const f=wtFixture();try{
   f.h.claude=claude;await f.send({messageId:'om_1',content:'/wt 任务描述'});
   const t=f.store.data.topics[0],branch=t.worktree!.branch!;
   assert.match(branch,randomName,reason);assert.equal(t.state,'ready',reason);assert.deepEqual(f.h.calls[0].slice(4,8),['--branch',branch,'--path',f.repo.target(branch)],reason);
   assert.deepEqual(f.replies.map(r=>r[3]),[intro(branch,f.repo.target(branch),`起名失败（${reason}），改用随机分支名`)],reason);
  }finally{f.close();}
 }
});
test('/wt in a binding whose directory is outside Git fails the topic with the reason in its thread before anything is created; later messages in its thread get a notice and start nothing',async()=>{
 const f=wtFixture();try{
  const plain=path.join(f.repo.root,'plain');fs.mkdirSync(plain);f.project.adopted!.dir=plain;
  await f.send({messageId:'om_1',content:'/wt x'});
  const t=f.store.data.topics[0];
  assert.deepEqual([t.state,t.error,t.worktree],['failed',`${plain} 不在 Git 仓库中`,{}]);assert.deepEqual([f.h.calls,f.naming,f.execs.length],[[],[],1]);
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',noticeOf(`启动失败：${plain} 不在 Git 仓库中\n没有创建任何东西`)]]);
  await f.send({messageId:'om_2',rootId:'om_1',content:'再试一次'});
  assert.deepEqual(f.replies.at(-1)!.slice(2),['om_1',notRetried]);assert.deepEqual([f.h.calls,f.execs.length],[[],1]);assert.deepEqual(t.messageIds,['om_1','om_2']);
 }finally{f.close();}
});
test('/wt in a binding whose directory is in a linked worktree creates the new worktree from the main checkout and beside it, with the HEAD of the linked worktree as base',async()=>{
 const f=wtFixture();try{
  const linked=path.join(f.repo.root,'linked');git(f.repo.main,'worktree','add','-q','-b','side',linked);
  fs.writeFileSync(path.join(linked,'a.txt'),'x');git(linked,'add','a.txt');git(linked,'commit','-q','-m','side');fs.mkdirSync(path.join(linked,'sub'));
  f.project.adopted!.dir=path.join(linked,'sub');const head=git(linked,'rev-parse','HEAD'),target=f.repo.target('feat/add-login');
  await f.send({messageId:'om_1',content:'/wt from the side'});
  assert.deepEqual(f.h.calls[0],['worktree','create','--cwd',f.repo.main,'--branch','feat/add-login','--path',target,'--base',head,'--no-focus']);
  assert.equal(git(target,'rev-parse','HEAD'),head);assert.deepEqual(f.store.data.topics[0].worktree,{branch:'feat/add-login',path:target,root:f.repo.main});
  assert.deepEqual(f.replies.map(r=>r[3]),[intro('feat/add-login',target,`绑定目录在 linked worktree 里，新分支基于它的 HEAD ${head.slice(0,12)}`)]);assert.deepEqual(f.naming[0].cwd,f.repo.main);
 }finally{f.close();}
});
test('/wt whose worktree directory exists already fails before anything is created and names the directory',async()=>{
 const f=wtFixture();try{
  const target=f.repo.target('feat/add-login');fs.mkdirSync(target,{recursive:true});
  await f.send({messageId:'om_1',content:'/wt x'});
  assert.deepEqual(f.replies.map(r=>r[3]),[noticeOf(`启动失败：目录已存在：${target}，不会覆盖它；换一个分支，或者先处理这个目录\n没有创建任何东西`)]);
  assert.deepEqual([f.store.data.topics[0].state,f.h.calls],['failed',[]]);assert.notEqual(gitIn(f.repo.main,'show-ref','--verify','--quiet','refs/heads/feat/add-login').status,0);
 }finally{f.close();}
});
test('in a binding that requires the mention, /wt without it is ignored like any message; with it it opens a worktree topic',async()=>{
 const f=wtFixture({binding:{requireMention:true}});try{
  await f.send({messageId:'om_1',content:'/wt x'});
  assert.deepEqual([f.store.data.topics,f.execs,f.h.calls,f.replies,f.reacted],[[],[],[],[],[]]);
  await f.send({messageId:'om_2',content:'/wt x',mentionedBot:true});
  assert.deepEqual([f.store.data.topics[0].state,f.store.data.topics[0].worktree!.branch!],['ready','feat/add-login']);
 }finally{f.close();}
});
test('/wt without a description or a branch, or -b without a branch, gets the usage in its thread and opens no topic; /wt in a thread and other text that starts with /wt are messages like any other',async()=>{
 const f=wtFixture();try{
  for(const [id,content] of [['om_1','/wt'],['om_2',' /wt  '],['om_3','/wt -b']])await f.send({messageId:id,content});
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',wtUsage],['om_2',wtUsage],['om_3',wtUsage]]);assert.deepEqual([f.store.data.topics,f.execs,f.h.calls,f.reacted],[[],[],[],[]]);
  await f.send({messageId:'om_4',content:'/wtx 普通消息'});await f.send({messageId:'om_5',rootId:'om_4',content:'/wt 话题里的消息'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['/wtx 普通消息','/wt 话题里的消息']);assert.equal(f.store.data.topics[0].worktree,undefined);assert.deepEqual(f.execs,[]);
 }finally{f.close();}
});
test('the images and files of a /wt topic go under its worktree, those of the /wt message too, which the naming leaves out; a /wt with attachments but no text is not named',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',rawContentType:'post',content:'/wt 看看这个报错 ![image](img_b)',resources:[{type:'image',fileKey:'img_b'}]});
  const t=f.store.data.topics[0],target=f.repo.target('feat/add-login'),root=`${target}/.herdr-bridge`,dir=`${root}/${t.id}`;
  assert.equal(f.naming[0].prompt,namingPrompt('看看这个报错'));
  assert.deepEqual(f.stored,[['m',root,t.id,'om_1-1.png','data:img_b']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),[`看看这个报错 [图片 1：${dir}/om_1-1.png]`]);assert.deepEqual([t.title,t.attachmentDir],['看看这个报错',dir]);
  await f.send({messageId:'om_2',rootId:'om_1',...imageOf('img_c')});
  assert.deepEqual(f.stored.at(-1)!.slice(0,4),['m',root,t.id,'om_2-1.png']);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').at(-1)![3],`[图片 1：${dir}/om_2-1.png]`);
  await f.send({messageId:'om_3',rawContentType:'post',content:'/wt ![image](img_d)',resources:[{type:'image',fileKey:'img_d'}]});
  const other=f.store.data.topics[1],branch=other.worktree!.branch!;
  assert.equal(f.naming.length,1);assert.match(branch,randomName);assert.equal(other.title,'图片');
  assert.deepEqual(f.replies.at(-1)![3],intro(branch,f.repo.target(branch),'起名失败（任务描述里没有文字），改用随机分支名'));
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').at(-1)![3],`[图片 1：${f.repo.target(branch)}/.herdr-bridge/${other.id}/om_3-1.png]`);
 }finally{f.close();}
});
test('a /wt topic whose agent cannot start fails with the reason and what exists in a card that offers removing the worktree; nothing is rolled back and later messages start nothing; a worktree that Herdr could not create leaves a plain notice',async()=>{
 const f=wtFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_start_failed','agent process exited before becoming interactive');};
  await f.send({messageId:'om_1',content:'/wt x'});
  const t=f.store.data.topics[0],target=f.repo.target('feat/add-login');
  const text=`启动失败：agent process exited before becoming interactive（agent_start_failed）\n已经创建、保持原样（没有回滚）的有：\n- worktree ${target}（分支 feat/add-login）\n- workspace w1，pane w1:p1`;
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',intro('feat/add-login',target)],['om_1',{card:removalCardOf('启动失败',text,'feat/add-login',target,{render:1})}]]);
  assert.deepEqual([t.state,t.worktree!.card],['failed',{messageId:'om_bot_2',heading:'启动失败',text}]);assert.ok(fs.existsSync(target));assert.ok(f.h.workspaces.some(w=>w.checkout===target));
  f.h.calls.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'再试'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies.at(-1)![3],notRetried);
  // The button works on this card too.
  f.topics.click(allowed,removeClick('om_bot_2',1));await Promise.all(f.topics.answering.values());assert.equal(fs.existsSync(target),false);
  f.h.claude={stdout:'BRANCH=fix/other'};f.h.on['worktree create']=()=>{throw coded('worktree_create_failed','fatal: invalid reference: HEAD');};
  await f.send({messageId:'om_3',content:'/wt y'});
  assert.deepEqual(f.replies.at(-1)!.slice(2),['om_3',noticeOf('启动失败：创建 worktree 失败（worktree_create_failed：fatal: invalid reference: HEAD）\n没有创建任何东西')]);
  assert.deepEqual(f.store.data.topics[1].worktree,{branch:'fix/other',path:f.repo.target('fix/other'),root:f.repo.main});
  // A worktree that Herdr created but opened no workspace for is offered for removal, which git does.
  f.h.claude={stdout:'BRANCH=fix/open'};f.h.on['worktree create']=(args,run)=>{run(args);f.h.workspaces.pop();throw coded('worktree_open_failed','created worktree but failed to open workspace: no space');};
  await f.send({messageId:'om_4',content:'/wt z'});const open=f.repo.target('fix/open');
  const failedOpen=`启动失败：创建 worktree 失败（worktree_open_failed：created worktree but failed to open workspace: no space）\n已经创建、保持原样（没有回滚）的有：\n- worktree ${open}（分支 fix/open），Herdr 没有为它打开 workspace`;
  assert.deepEqual(f.replies.at(-1)!.slice(2),['om_4',{card:removalCardOf('启动失败',failedOpen,'fix/open',open,{render:3})}]);assert.ok(fs.existsSync(open));
  f.topics.click(allowed,removeClick(f.store.data.topics[2].worktree!.card!.messageId,3));await Promise.all(f.topics.answering.values());
  assert.equal(fs.existsSync(open),false);assert.deepEqual(f.execs.at(-1),['m',...gitArgs(f.repo.main,'worktree','remove',open)]);
 }finally{f.close();}
});
test('a /wt topic whose agent is gone ends with a card that keeps the worktree and offers removing it; a click by an allowed person removes a clean worktree through Herdr, which closes its workspace, keeps the branch and marks the card removed, also after a Bridge restart',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login');
  f.h.agents=[];await f.topics.sync(f.m,[]);
  const t=f.store.data.topics[0];
  assert.equal(t.state,'closed');assert.deepEqual(f.replies.at(-1)!.slice(2),['om_1',{card:removalCardOf('话题已结束',endedText,'feat/add-login',target,{render:1})}]);
  assert.deepEqual(t.worktree,{branch:'feat/add-login',path:target,root:f.repo.main,card:{messageId:'om_bot_2',heading:'话题已结束',text:endedText}});assert.ok(fs.existsSync(target));
  // What the agent left under .herdr-bridge, which ignores itself, is no change.
  fs.mkdirSync(path.join(target,'.herdr-bridge','x'),{recursive:true});fs.writeFileSync(path.join(target,'.herdr-bridge','.gitignore'),'*\n');fs.writeFileSync(path.join(target,'.herdr-bridge','x','a.png'),'png');
  const {topics}=f.restart();f.h.calls.length=0;f.execs.length=0;
  assert.deepEqual(topics.click(allowed,removeClick('om_bot_2',1)),{toast:{type:'info',content:'正在删除 worktree'}});
  await Promise.all(topics.answering.values());
  assert.deepEqual(f.h.calls,[['worktree','list','--cwd',f.repo.main],['worktree','remove','--workspace','w1']]);
  assert.deepEqual(f.execs,[['m','exists',target],['m',...gitArgs(target,'-c','core.quotePath=false','status','--porcelain','--untracked-files=all')]]);
  assert.equal(fs.existsSync(target),false);assert.equal(git(f.repo.main,'rev-parse','--verify','feat/add-login'),git(f.repo.main,'rev-parse','main'));assert.equal(f.h.workspaces.some(w=>w.checkout),false);
  assert.deepEqual(f.updated.at(-1),['a','om_bot_2',removalCardOf('话题已结束',endedText,'feat/add-login',target,{removed:'已删除 worktree，分支 feat/add-login 保留'})]);
  assert.equal(new Store(f.dir).data.topics[0].worktree!.removed,true);
  assert.deepEqual(topics.click(allowed,removeClick('om_bot_2',1)),{toast:{type:'info',content:'worktree 已删除'}});assert.deepEqual(topics.click(allowed,removeClick('om_other',1)),{toast:{type:'info',content:'这张卡片已失效'}});
 }finally{f.close();}
});
test('the 删除 worktree button refuses a worktree with changes that are not committed and lists them, removes it with git once Herdr no longer has it open, and counts a worktree that is gone as removed',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login'),settle=()=>Promise.all(f.topics.answering.values());
  f.h.agents=[];await f.topics.sync(f.m,[]);
  fs.writeFileSync(path.join(target,'new.txt'),'x');fs.writeFileSync(path.join(target,'说明.md'),'x');f.h.calls.length=0;
  f.topics.click(allowed,removeClick('om_bot_2',1));await settle();
  assert.ok(fs.existsSync(target));assert.deepEqual(f.h.calls,[]);assert.equal(f.store.data.topics[0].worktree!.removed,undefined);
  assert.deepEqual(f.updated.at(-1)![2],removalCardOf('话题已结束',endedText,'feat/add-login',target,{render:2,refused:'worktree 里有未提交的改动，没有删除：\n?? new.txt\n?? 说明.md'}));
  // Committed work stays on the branch.
  git(target,'add','.');git(target,'commit','-q','-m','work');f.h.workspaces=f.h.workspaces.filter(w=>!w.checkout);f.execs.length=0;
  f.topics.click(allowed,removeClick('om_bot_2',2));await settle();
  assert.deepEqual(f.h.calls,[['worktree','list','--cwd',f.repo.main]]);assert.deepEqual(f.execs.at(-1),['m',...gitArgs(f.repo.main,'worktree','remove',target)]);
  assert.equal(fs.existsSync(target),false);assert.equal(git(f.repo.main,'log','-1','--format=%s','feat/add-login'),'work');
  assert.deepEqual(f.updated.at(-1)![2],removalCardOf('话题已结束',endedText,'feat/add-login',target,{removed:'已删除 worktree，分支 feat/add-login 保留'}));
 }finally{f.close();}
 const g=wtFixture();try{
  await g.send({messageId:'om_1',content:'/wt x'});const target=g.repo.target('feat/add-login');
  g.h.agents=[];await g.topics.sync(g.m,[]);fs.rmSync(target,{recursive:true});g.h.calls.length=0;
  g.topics.click(allowed,removeClick('om_bot_2',1));await Promise.all(g.topics.answering.values());
  assert.deepEqual(g.h.calls,[]);assert.deepEqual(g.updated.at(-1)![2],removalCardOf('话题已结束',endedText,'feat/add-login',target,{removed:'worktree 已不在，按已删除处理'}));
  assert.equal(g.store.data.topics[0].worktree!.removed,true);
 }finally{g.close();}
});
test('the 删除 worktree button does nothing for a person outside the allowlist of the app',async()=>{
 const f=wtFixture(),p=platformFixture({channelFactory:()=>fakeChannel({on(){}}),onCardAction:(...args)=>f.topics.click(...args)});try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login');
  f.h.agents=[];await f.topics.sync(f.m,[]);f.h.calls.length=0;f.execs.length=0;const updates=f.updated.length;
  assert.deepEqual(p.platforms.cardAction(allowed,removeClick('om_bot_2',1,'ou_other')),{toast:{type:'error',content:'你不在这个应用的允许名单中，不能处理这个请求'}});
  assert.equal(f.topics.answering.size,0);assert.deepEqual([f.h.calls,f.execs,f.updated.length],[[],[],updates]);assert.ok(fs.existsSync(target));
  assert.deepEqual(p.platforms.cardAction(allowed,removeClick('om_bot_2',1)),{toast:{type:'info',content:'正在删除 worktree'}});
  await Promise.all(f.topics.answering.values());assert.equal(fs.existsSync(target),false);
 }finally{p.close();f.close();}
});
test('removing the binding of a /wt topic keeps its worktree and its workspace, as any topic keeps its tab',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login');f.h.calls.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w1:p1','off']]);assert.ok(fs.existsSync(target));assert.ok(f.h.workspaces.some(w=>w.checkout===target));assert.deepEqual(f.store.data.topics,[]);
 }finally{f.close();}
});
const at=(iso:string)=>Date.parse(iso);
// Upcoming run times of a cron expression in time zone tz after the ISO time from, as wall times there.
const runsOf=(expression:string,tz:string,from:string,n:number)=>upcoming(parseCron(expression),tz,at(from),n).map(t=>when(t,tz));
test('a cron expression has five fields of numbers, ranges, steps, lists and English names; anything else is refused, naming the field',()=>{
 for(const [expression,error] of [['',/5 个字段/],['* * * *',/5 个字段/],['* * * * * *',/5 个字段/],['@daily',/5 个字段/],['60 * * * *',/分钟/],['* 24 * * *',/小时/],['* * 0 * *',/日期/],['* * 32 * *',/日期/],['* * * 13 *',/月份/],
  ['* * * * 8',/星期/],['*/0 * * * *',/分钟/],['5-1 * * * *',/分钟/],['1,,2 * * * *',/分钟/],['-1 * * * *',/分钟/],['1.5 * * * *',/分钟/],['* * * * fri-mon',/星期/],['* * * foo *',/月份/],['* * * * monday',/星期/],['? * * * *',/分钟/],['* * L * *',/日期/],['* * * * 1#2',/星期/]] satisfies [string,RegExp][])
  assert.throws(()=>parseCron(expression),error,expression);
 // Lists, ranges with steps, a start with a step, and names in any case; 7 is Sunday like 0.
 assert.deepEqual(runsOf(' 0,30  9-17/4 * JAN,nov * ','Asia/Shanghai','2026-11-06T10:00:00+08:00',4),['2026-11-06 13:00','2026-11-06 13:30','2026-11-06 17:00','2026-11-06 17:30']);
 assert.deepEqual(runsOf('5/20 10 * * *','Asia/Shanghai','2026-11-06T10:00:00+08:00',4),['2026-11-06 10:05','2026-11-06 10:25','2026-11-06 10:45','2026-11-07 10:05']);
 assert.deepEqual(runsOf('0 12 * * 7','Asia/Shanghai','2026-11-06T10:00:00+08:00',1),runsOf('0 12 * * sun','Asia/Shanghai','2026-11-06T10:00:00+08:00',1));
 assert.deepEqual(runsOf('0 12 * * 0','Asia/Shanghai','2026-11-06T10:00:00+08:00',1),['2026-11-08 12:00']);
});
test('the runs of an expression are whole minutes of the wall clock of its time zone, strictly after the given time; day of month and day of week count either one when both are restricted, as in cron',()=>{
 const sh='Asia/Shanghai',friday='2026-11-06T10:00:00+08:00';
 assert.deepEqual(runsOf('30 9 * * 1-5',sh,friday,3),['2026-11-09 09:30','2026-11-10 09:30','2026-11-11 09:30']);
 assert.deepEqual(runsOf('0 18 * * MON-FRI',sh,friday,2),['2026-11-06 18:00','2026-11-09 18:00']);
 // A run at the given minute is not after it; one later in the minute is.
 assert.deepEqual(runsOf('*/5 * * * *',sh,friday,2),['2026-11-06 10:05','2026-11-06 10:10']);
 assert.deepEqual(runsOf('*/5 * * * *',sh,'2026-11-06T10:02:30+08:00',1),['2026-11-06 10:05']);
 assert.equal(next(parseCron('0 9 * * *'),'UTC',at(friday)),at('2026-11-06T09:00:00Z'));assert.equal(next(parseCron('0 9 * * *'),sh,at(friday)),at('2026-11-07T09:00:00+08:00'));
 // The 1st or a Monday; with a * in day of month, only Mondays on the 1st, 11th, 21st or 31st.
 assert.deepEqual(runsOf('0 0 1 * 1',sh,'2026-11-24T12:00:00+08:00',3),['2026-11-30 00:00','2026-12-01 00:00','2026-12-07 00:00']);
 assert.deepEqual(runsOf('0 0 */10 * 1',sh,friday,2),['2026-12-21 00:00','2027-01-11 00:00']);
 // February 29 comes years later; February 31 never does.
 assert.deepEqual(runsOf('0 0 29 2 *',sh,friday,2),['2028-02-29 00:00','2032-02-29 00:00']);
 assert.deepEqual(runsOf('0 0 31 2 *',sh,friday,3),[]);assert.equal(next(parseCron('0 0 31 2 *'),sh,at(friday)),null);
 // The latest run strictly before a time.
 assert.equal(previous(parseCron('*/5 * * * *'),sh,at('2026-11-06T10:05:00+08:00')),at('2026-11-06T10:00:00+08:00'));
 assert.equal(previous(parseCron('*/5 * * * *'),sh,at('2026-11-06T10:05:00.001+08:00')),at('2026-11-06T10:05:00+08:00'));
 assert.equal(previous(parseCron('30 9 * * 1-5'),sh,at('2026-11-09T09:00:00+08:00')),at('2026-11-06T09:30:00+08:00'));
 assert.equal(previous(parseCron('0 0 31 2 *'),sh,at(friday)),null);
});
test('a wall time that a daylight saving change skips has no run that day, and one that it repeats runs once, at its first occurrence',()=>{
 const ny='America/New_York',daily=parseCron('30 2 * * *'),night=parseCron('30 1 * * *');
 // 2026-03-08 02:30 does not exist in New York.
 assert.deepEqual(runsOf('30 2 * * *',ny,'2026-03-07T03:00:00-05:00',2),['2026-03-09 02:30','2026-03-10 02:30']);assert.equal(next(daily,ny,at('2026-03-07T03:00:00-05:00')),at('2026-03-09T02:30:00-04:00'));
 // 2026-11-01 01:30 happens at 05:30Z and again at 06:30Z.
 assert.equal(next(night,ny,at('2026-11-01T00:00:00-04:00')),at('2026-11-01T05:30:00Z'));
 assert.equal(next(night,ny,at('2026-11-01T05:30:00Z')),at('2026-11-02T06:30:00Z'));assert.equal(next(night,ny,at('2026-11-01T06:15:00Z')),at('2026-11-02T06:30:00Z'));
 assert.equal(previous(night,ny,at('2026-11-01T07:00:00Z')),at('2026-11-01T05:30:00Z'));
 // 2026-10-25 01:30 happens in London at 00:30Z and again at 01:30Z.
 assert.equal(next(night,'Europe/London',at('2026-10-24T12:00:00Z')),at('2026-10-25T00:30:00Z'));assert.equal(next(night,'Europe/London',at('2026-10-25T00:30:00Z')),at('2026-10-26T01:30:00Z'));
});
test('a time zone is an IANA name that Intl knows, kept in its canonical form; times are shown as wall times there',()=>{
 assert.equal(zone('asia/shanghai'),'Asia/Shanghai');assert.equal(zone('UTC'),'UTC');
 for(const tz of ['','Mars/Base',undefined,8])assert.throws(()=>zone(tz),/时区/,String(tz));
 assert.equal(when(at('2026-11-06T02:00:00Z'),'Asia/Shanghai'),'2026-11-06 10:00');assert.equal(when(at('2026-11-06T02:00:00Z'),'UTC'),'2026-11-06 02:00');
 // With the day of the week of that wall date: 2026-11-08 is a Sunday in Shanghai and still a Saturday in UTC.
 assert.equal(when(at('2026-11-07T16:30:00Z'),'Asia/Shanghai',{weekday:true}),'2026-11-08 周日 00:30');assert.equal(when(at('2026-11-07T16:30:00Z'),'UTC',{weekday:true}),'2026-11-07 周六 16:30');
});
test('an expression reads in plain words: the days, then the times of day or how often; what has no short form is listed field by field',()=>{
 for(const [expression,words] of [
  ['30 9 * * 1-5','每周一至周五 09:30'],['0 9 * * *','每天 09:00'],['0 9,18 * * *','每天 09:00、18:00'],['0 18 * * MON-FRI','每周一至周五 18:00'],
  ['0 9 * * 1,3,5','每周一、周三、周五 09:00'],['0 10 * * 6,0','每周六、周日 10:00'],['0 10 * * 7','每周日 10:00'],
  ['0 0 1 * *','每月 1 日 00:00'],['0 9 1,15 * *','每月 1、15 日 09:00'],['0 9 1-10 * *','每月 1 至 10 日 09:00'],['0 0 1 1 *','每年 1 月的 1 日 00:00'],['0 0 29 2 *','每年 2 月的 29 日 00:00'],
  ['0,30 9-17/4 * JAN,nov *','每年 1、11 月的每天 09:00、09:30、13:00、13:30、17:00、17:30'],['5/20 10 * * *','每天 10:05、10:25、10:45'],
  // Day of month and day of week both restricted: either one, unless one of them starts with *, which makes it both.
  ['0 9 1 * 1','每月 1 日和每周一 09:00'],['0 0 */10 * 1','每月 1、11、21、31 日中的周一 00:00'],['0 0 1-31 * 1','每天 00:00'],
  ['*/5 * * * *','每 5 分钟'],['2/5 * * * *','每 5 分钟（每小时第 2 分钟起）'],['*/15 9-17 * * 1-5','每周一至周五 09:00 至 17:45 每 15 分钟'],
  ['0 * * * *','每小时整点'],['30 * * * *','每小时第 30 分钟'],['0 */2 * * *','每 2 小时，从 00:00 起'],['30 1/6 * * *','每天 01:30、07:30、13:30、19:30'],
  ['0 9-17 * * *','每天 09:00 至 17:00 每小时一次'],['0 */5 * * *','每天 00:00、05:00、10:00、15:00、20:00'],['0 1,2,3,5,8,13,21 * * *','每天 1 至 3、5、8、13、21 点的第 0 分钟'],['0,20,40 8,12,16,20 * * *','每天 8、12、16、20 点的第 0、20、40 分钟'],
 ])assert.equal(phrase(parseCron(expression)),words,expression);
});
// Schedules over the topics of a topic fixture (see topicFixture), with the clock of both at f.clock.now, which f.at(iso) sets. f.posted
// records every message the bot posts into a chat outside a thread as [app id, chat id, content], which resolves to the next om_post_<n>;
// with f.postFails set it rejects with that error instead.
function scheduleFixture(options:TopicOptions={}){
 // postFails, when a test sets it, is what a post of the bot into the chat fails with.
 const clock={now:at('2026-11-06T08:00:00+08:00')},f:ReturnType<typeof topicFixture>&{postFails?:Error|null}=topicFixture({...options,now:()=>clock.now}),posted:unknown[][]=[];let n=0;
 const schedules=new Schedules(f.store,{topics:f.topics,app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},
  send:async(a,chatId,content)=>{posted.push([a.id,chatId,content]);await null;if(f.postFails)throw f.postFails;return 'om_post_'+ ++n;},reply:(...args)=>f.topics.reply(...args),now:()=>clock.now});
 return Object.assign(f,{schedules,posted,clock,at:(iso:string)=>{clock.now=at(iso);}});
}
// The card of run n of schedule s, due at wall time time.
const runNotice=(s:Schedule,n:number,time:string)=>{const text=`定时任务 ${s.id.slice(0,8)} · 第 ${n} 次运行 · ${time}\n${s.task}`;return notice(text,text.replace(/\s+/g,' '));};
const daily={bindingId:'b',mode:'new',cron:'0 9 * * *',timeZone:'Asia/Shanghai',task:'总结昨天的提交'};
const scheduleLogs=(f:{store:Store})=>f.store.data.logs.filter(l=>l.kind==='定时任务').map(l=>[l.level,l.message]);
test('only the two names of the modes of a schedule, as strings, are modes: not a list that prints as one, nor a name that every object has',()=>{
 for(const mode of ['new','into'])assert.equal(isMode(mode),true,mode);
 for(const mode of [['new'],['into'],[['new']],{toString:()=>'new'},'constructor','toString','__proto__','NEW','',' new',null,undefined,1])assert.equal(isMode(mode),false,String(mode));
});
test('a schedule is added on a binding with a cron expression, a time zone and a task, to open a new topic at each run or to prompt one topic of the binding; what is invalid is refused, and list, runs, update, pause, resume and remove work on the stored schedules',async()=>{
 const f=scheduleFixture();try{
  await f.send({messageId:'om_1',content:'one'});const t=f.store.data.topics[0];f.at('2026-11-06T10:00:00+08:00');const now=at('2026-11-06T10:00:00+08:00');
  const s=f.schedules.add({bindingId:'b',mode:'new',cron:' 30  9 * * 1-5 ',timeZone:'asia/shanghai',task:' 总结昨天的提交\n',createdBy:{topicId:t.id,openId:'ou_user',name:'x'}});
  assert.deepEqual(s,{id:s.id,bindingId:'b',mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交',paused:false,createdBy:{topicId:t.id,openId:'ou_user'},createdAt:now,handledUntil:now,count:0,runs:[]});
  assert.deepEqual(new Store(f.dir).data.schedules,[s]);s.task='changed';assert.equal(f.store.data.schedules[0].task,'总结昨天的提交');
  const into=f.schedules.add({bindingId:'b',mode:'into',topicId:t.id,cron:'0 18 * * *',timeZone:'UTC',task:'看一下',createdBy:{}});
  assert.deepEqual([into.mode,into.topicId,into.createdBy],['into',t.id,{}]);
  for(const [fields,error] of [[{bindingId:'x'},/会话绑定不存在/],[{mode:'loop'},/模式无效/],[{mode:'into'},/话题不存在/],[{mode:'into',topicId:'missing'},/话题不存在/],[{cron:'* * *'},/5 个字段/],[{cron:'0 0 31 2 *'},/不会再运行/],
   [{timeZone:'Mars/Base'},/时区无效/],[{timeZone:undefined},/时区无效/],[{task:'  '},/任务文字/],[{task:'x'.repeat(16001)},/任务文字/],[{task:3},/任务文字/]])
   assert.throws(()=>f.schedules.add({...daily,...fields}),error,JSON.stringify(fields).slice(0,60));
  assert.equal(f.store.data.schedules.length,2);
  // A topic of another binding cannot be prompted.
  f.store.data.bindings.push({...route,id:'b2',chatId:'oc_2'});assert.throws(()=>f.schedules.add({...daily,bindingId:'b2',mode:'into',topicId:t.id}),/话题不存在/);
  const {runs,...listed}=s;assert.deepEqual(f.schedules.list(),[{...listed,task:'总结昨天的提交',next:at('2026-11-09T09:30:00+08:00')},{...(({runs,...x})=>x)(into),next:at('2026-11-06T18:00:00Z')}]);
  assert.deepEqual(f.schedules.list('b2'),[]);assert.deepEqual(f.schedules.runs(s.id),[]);
  // An update checks what changes like add; the times after it count from now.
  f.at('2026-11-06T11:00:00+08:00');
  assert.throws(()=>f.schedules.update(s.id,{cron:'61 * * * *'}),/分钟/);assert.throws(()=>f.schedules.update(s.id,{task:''}),/任务文字/);assert.equal(f.store.data.schedules[0].cron,'30 9 * * 1-5');
  const updated=f.schedules.update(s.id,{cron:'0 18 * * *',mode:'into',bindingId:'b2'});
  assert.deepEqual([updated.cron,updated.timeZone,updated.task,updated.mode,updated.bindingId,updated.handledUntil],['0 18 * * *','Asia/Shanghai','总结昨天的提交','new','b',at('2026-11-06T11:00:00+08:00')]);
  assert.equal(f.schedules.update(s.id,{task:'新的任务',timeZone:'UTC'}).task,'新的任务');assert.equal(new Store(f.dir).data.schedules[0].timeZone,'UTC');
  assert.deepEqual([f.schedules.pause(s.id).paused,f.schedules.list()[0].next],[true,null]);
  f.at('2026-11-06T12:00:00+08:00');const resumed=f.schedules.resume(s.id);assert.deepEqual([resumed.paused,resumed.handledUntil],[false,at('2026-11-06T12:00:00+08:00')]);
  f.schedules.remove(into.id);assert.deepEqual(f.store.data.schedules.map(x=>x.id),[s.id]);assert.deepEqual(new Store(f.dir).data.schedules.map(x=>x.id),[s.id]);
  for(const call of [()=>f.schedules.runs('x'),()=>f.schedules.update('x',{}),()=>f.schedules.pause('x'),()=>f.schedules.resume('x'),()=>f.schedules.remove('x')])assert.throws(call,/定时任务不存在/);
  assert.deepEqual(scheduleLogs(f).map(l=>l[1].replace(/[0-9a-f]{8}/g,'<id>')),['个人助手：已添加定时任务 <id>（30 9 * * 1-5，Asia/Shanghai，每次开新话题）','个人助手：已添加定时任务 <id>（0 18 * * *，UTC，发进话题）',
   '个人助手：定时任务 <id> 已修改（0 18 * * *，Asia/Shanghai）','个人助手：定时任务 <id> 已修改（0 18 * * *，UTC）','个人助手：定时任务 <id> 已暂停','个人助手：定时任务 <id> 已恢复','个人助手：定时任务 <id> 已删除']);
 }finally{f.close();}
});
test('at its time a schedule in mode new posts the card of the run into the chat of its binding, opens a topic under it with the task as the first prompt and records the run; it does nothing before its time and runs a time once',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T08:58:00+08:00');const s=f.schedules.add(daily);
  await f.schedules.tick();assert.deepEqual([f.posted,f.h.calls,f.store.data.topics],[[],[],[]]);
  f.at('2026-11-06T09:00:05+08:00');await Promise.all([f.schedules.tick(),f.schedules.tick()]);await f.schedules.tick();
  const [t]=f.store.data.topics;
  assert.deepEqual(f.posted,[['a','oc_1',runNotice(s,1,'2026-11-06 09:00')]]);
  assert.deepEqual([t.rootId,t.title,t.state,t.scheduled,t.messageIds,t.createdAt],['om_post_1','总结昨天的提交','ready',{id:s.id,n:1},['om_post_1'],at('2026-11-06T09:00:05+08:00')]);
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['workspace','list'],['workspace','create'],['tab','rename'],['agent','start'],['pane','remote-answers'],['agent','prompt']]);
  assert.deepEqual(f.h.calls.at(-1),['agent','prompt','w1:p1','总结昨天的提交']);assert.deepEqual([f.reacted,f.replies],[[],[]]);assert.deepEqual(cotLog(f)[0],['create','om_post_1']);
  const stored=new Store(f.dir).data.schedules[0];
  assert.deepEqual(stored.runs,[{due:at('2026-11-06T09:00:00+08:00'),at:at('2026-11-06T09:00:05+08:00'),outcome:'started',n:1,topicId:t.id}]);assert.deepEqual([stored.count,stored.handledUntil],[1,at('2026-11-06T09:00:00+08:00')]);
  // The next day: the idle agent of the first run lets the second open its own topic.
  f.at('2026-11-07T09:00:01+08:00');f.h.calls.length=0;await f.schedules.tick();
  assert.deepEqual(f.store.data.topics.map(x=>[x.rootId,x.scheduled!.n,x.state]),[['om_post_1',1,'ready'],['om_post_2',2,'ready']]);assert.deepEqual(f.posted[1],['a','oc_1',runNotice(s,2,'2026-11-07 09:00')]);
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['agent','list'],['workspace','list'],['tab','create'],['agent','start'],['pane','remote-answers'],['agent','prompt']]);
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.n]),[['started',1],['started',2]]);assert.deepEqual(scheduleLogs(f).length,1);
 }finally{f.close();}
});
test('a schedule in mode new skips a time while the agent of its previous run works or waits for a confirmation, records why and counts only the runs that started',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});
  f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  for(const [status,time] of [['working','10:10'],['blocked','10:15']]){
   f.h.agents[0].agent_status=status;f.at(`2026-11-06T${time}:00+08:00`);await f.schedules.tick();
  }
  assert.equal(f.posted.length,1);assert.equal(f.store.data.topics.length,1);
  f.h.agents[0].agent_status='idle';f.at('2026-11-06T10:20:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.posted.map(p=>p[2]),[runNotice(s,1,'2026-11-06 10:05'),runNotice(s,2,'2026-11-06 10:20')]);
  assert.deepEqual(f.schedules.runs(s.id).map(({due,outcome,n,reason})=>[when(due,'Asia/Shanghai'),outcome,n,reason]),
   [['2026-11-06 10:05','started',1,undefined],['2026-11-06 10:10','skipped',undefined,'上次还没结束，跳过'],['2026-11-06 10:15','skipped',undefined,'上次还没结束，跳过'],['2026-11-06 10:20','started',2,undefined]]);
 }finally{f.close();}
});
test('at its time a schedule in mode into posts the card of the run into the thread of its topic and gives the task to the agent there as a message of a person would, in the topic queue, with the COT under the card and no reaction; it skips a time while the agent works or waits for a confirmation',async()=>{
 const f=scheduleFixture();try{
  await f.send({messageId:'om_1',content:'one'});const t=f.store.data.topics[0];delete t.cot;f.h.calls.length=0;f.api.length=0;f.reacted.length=0;
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,mode:'into',topicId:t.id,cron:'*/5 * * * *',task:'回复当前时间'});
  f.at('2026-11-06T10:05:00+08:00');
  // A message of a person that is still in the queue goes first.
  f.h.on['agent prompt']=async(args,run)=>{await later(20);return run(args);};const sent=f.send({messageId:'om_2',rootId:'om_1',content:'先做这个'});
  await f.schedules.tick();await sent;
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['先做这个','回复当前时间']);
  assert.deepEqual(f.replies,[['a','oc_1','om_1',runNotice(s,1,'2026-11-06 10:05')]]);assert.deepEqual(f.reacted.map(r=>r[1]),['om_2']);
  assert.deepEqual(cotLog(f).filter(c=>c[0]==='create'),[['create','om_2']]);
  assert.deepEqual(f.schedules.runs(s.id),[{due:at('2026-11-06T10:05:00+08:00'),at:at('2026-11-06T10:05:00+08:00'),outcome:'started',n:1,topicId:t.id}]);assert.equal(f.store.data.topics.length,1);
  // Without an open COT, the COT of the run's turn answers its card.
  delete t.cot;f.at('2026-11-06T10:10:00+08:00');f.h.calls.length=0;f.replies.length=0;f.api.length=0;await f.schedules.tick();
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list'],['agent','prompt','w1:p1','回复当前时间']]);assert.deepEqual(cotLog(f)[0],['create','om_bot_2']);assert.equal(t.cot!.origin,'om_bot_2');
  for(const [status,time] of [['working','10:15'],['blocked','10:20']]){f.h.agents[0].agent_status=status;f.at(`2026-11-06T${time}:00+08:00`);await f.schedules.tick();}
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);assert.equal(f.replies.length,1);
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.n,r.reason]),[['started',1,undefined],['started',2,undefined],['skipped',undefined,'上次还没结束，跳过'],['skipped',undefined,'上次还没结束，跳过']]);
 }finally{f.close();}
});
test('a schedule in mode into whose topic has ended skips the time and pauses, with a notice in the thread: its agent is gone, the topic was closed before, or the topic went with its binding, which leaves no thread to tell',async()=>{
 const f=scheduleFixture();try{
  for(const id of ['om_1','om_2','om_3'])await f.send({messageId:id,content:id});
  const [gone,closed,unbound]=f.store.data.topics;f.at('2026-11-06T10:00:00+08:00');
  const [a,b]=[gone,closed].map(t=>f.schedules.add({...daily,mode:'into',topicId:t.id,cron:'*/5 * * * *'}));
  f.h.agents=f.h.agents.filter(x=>x.pane_id!=='w1:p1');closed.state='closed';f.replies.length=0;f.h.calls.length=0;
  f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  const paused=(s:{id:string})=>notice(`定时任务 ${s.id.slice(0,8)} 已暂停：这个话题的会话已结束，定时任务不会在这里另起一个 Agent`),thread=(root:string)=>f.replies.filter(r=>r[2]===root).map(r=>r[3]);
  assert.deepEqual([thread('om_1'),thread('om_2'),f.replies.length],[[notice('该话题的会话已结束，请发起新话题'),paused(a)],[paused(b)],3]);
  assert.deepEqual([gone.state,closed.state],['closed','closed']);assert.deepEqual(f.h.calls,[['agent','list']]);
  assert.deepEqual([a,b].map(s=>f.schedules.runs(s.id).map(r=>[r.outcome,r.reason])),[[['skipped','话题已结束，定时任务已暂停']],[['skipped','话题已结束，定时任务已暂停']]]);
  assert.deepEqual(new Store(f.dir).data.schedules.map(s=>s.paused),[true,true]);
  // Removing the binding drops its topics; the schedule keeps its binding id and pauses at its next time, without a thread to tell.
  const c=f.schedules.add({...daily,mode:'into',topicId:unbound.id,cron:'*/5 * * * *'});await f.topics.unbind('b');f.replies.length=0;
  f.at('2026-11-06T10:10:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.replies,[]);assert.deepEqual(f.schedules.runs(c.id).map(r=>[r.outcome,r.reason]),[['skipped','话题已结束，定时任务已暂停']]);assert.equal(f.store.data.schedules[2].paused,true);
  // Paused schedules do not run.
  f.at('2026-11-06T10:15:00+08:00');await f.schedules.tick();assert.deepEqual(f.store.data.schedules.map(s=>f.schedules.runs(s.id).length),[1,1,1]);
  assert.deepEqual(scheduleLogs(f).filter(l=>/暂停/.test(l[1])).map(l=>l[1].replace(/[0-9a-f]{8}/g,'<id>')),['个人助手：定时任务 <id> 的话题已结束，已暂停','个人助手：定时任务 <id> 的话题已结束，已暂停','个人助手：定时任务 <id> 的话题已结束，已暂停']);
 }finally{f.close();}
});
test('a schedule in mode new whose binding was removed skips the time and pauses',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T08:00:00+08:00');const s=f.schedules.add(daily);f.store.data.bindings=[];
  f.at('2026-11-06T09:00:00+08:00');await f.schedules.tick();
  assert.deepEqual([f.posted,f.h.calls],[[],[]]);assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.reason]),[['skipped','绑定已移除，定时任务已暂停']]);assert.equal(f.store.data.schedules[0].paused,true);
 }finally{f.close();}
});
test('after Bridge was down, a schedule runs only its latest missed time, and only when that is at most 2 hours late; the earlier times are recorded as missed, once',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T08:30:00+08:00');const hourly=f.schedules.add({...daily,cron:'0 * * * *'}),s=f.schedules.add(daily);
  // Down from 08:30 to 11:00: 09:00 and 10:00 were missed, 11:00 is on time.
  f.at('2026-11-06T11:00:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.schedules.runs(hourly.id).map(({due,last,outcome,reason})=>[when(due,'Asia/Shanghai'),last&&when(last,'Asia/Shanghai'),outcome,reason]),[['2026-11-06 09:00','2026-11-06 10:00','missed','Bridge 停机，错过'],['2026-11-06 11:00',undefined,'started',undefined]]);
  // The daily one is exactly 2 hours late, and runs.
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[when(r.due,'Asia/Shanghai'),r.outcome]),[['2026-11-06 09:00','started']]);
  // Down from 11:00 to 11:30 two days later: the latest 09:00 is 2.5 hours late, and every time since is missed; ticking again records nothing.
  f.at('2026-11-08T11:30:00+08:00');await f.schedules.tick();await f.schedules.tick();
  assert.deepEqual(f.schedules.runs(s.id).slice(1).map(({due,last,outcome})=>[when(due,'Asia/Shanghai'),when(last!,'Asia/Shanghai'),outcome]),[['2026-11-07 09:00','2026-11-08 09:00','missed']]);
  assert.deepEqual(f.schedules.runs(hourly.id).slice(2).map(({due,last,outcome})=>[when(due,'Asia/Shanghai'),last&&when(last,'Asia/Shanghai'),outcome]),[['2026-11-06 12:00','2026-11-08 10:00','missed'],['2026-11-08 11:00',undefined,'started']]);
  assert.equal(f.posted.length,3);
  // One missed time alone has no last.
  f.at('2026-11-09T11:01:00+08:00');await f.schedules.tick();assert.deepEqual(f.schedules.runs(s.id).at(-1),{due:at('2026-11-09T09:00:00+08:00'),at:at('2026-11-09T11:01:00+08:00'),outcome:'missed',reason:'Bridge 停机，错过'});
 }finally{f.close();}
});
test('a paused schedule does not run, and resuming it counts its times from then on without making up for the pause',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});f.schedules.pause(s.id);
  f.at('2026-11-06T10:20:00+08:00');await f.schedules.tick();f.at('2026-11-06T10:21:00+08:00');f.schedules.resume(s.id);await f.schedules.tick();
  assert.deepEqual([f.posted,f.schedules.runs(s.id)],[[],[]]);
  f.at('2026-11-06T10:25:00+08:00');await f.schedules.tick();assert.deepEqual(f.schedules.runs(s.id).map(r=>[when(r.due,'Asia/Shanghai'),r.outcome]),[['2026-11-06 10:25','started']]);
 }finally{f.close();}
});
test('a schedule in mode new keeps the topics of its latest 3 runs: older ones end and the panes of their agents close, except one in which a person wrote within a day and one that has ended, whose pane Bridge no longer knows',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});
  const runAt=async(time:string)=>{f.at(time);await f.schedules.tick();};
  for(const time of ['10:05','10:10','10:15'])await runAt(`2026-11-06T${time}:00+08:00`);
  // A person writes in the first run's topic.
  f.at('2026-11-06T10:16:00+08:00');await f.send({messageId:'om_u1',rootId:'om_post_1',content:'追问'});
  await runAt('2026-11-06T10:20:00+08:00');const topic=(n:number)=>f.store.data.topics.find(t=>t.scheduled!.n===n)!;
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='close'),[]);assert.deepEqual(f.store.data.topics.map(t=>t.state),Array(4).fill('ready'));
  // Run 5: the second run's topic goes; the first stays for the person.
  f.replies.length=0;await runAt('2026-11-06T10:25:00+08:00');
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='close'),[['pane','close',topic(2).paneId]]);assert.deepEqual(f.store.data.topics.map(t=>[t.scheduled!.n,t.state]),[[1,'ready'],[2,'closed'],[3,'ready'],[4,'ready'],[5,'ready']]);
  const retired=`这个话题来自定时任务 ${s.id.slice(0,8)}，定时任务只保留最近 3 次运行的话题，Agent 已关闭`;
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[[topic(2).rootId,notice(retired)]]);
  // The agent of the third run exits; a day after the person wrote, run 6 retires the first and leaves the third, which has ended.
  f.h.agents=f.h.agents.filter(a=>a.pane_id!==topic(3).paneId);await f.topics.sync(f.m,f.h.agents);assert.equal(topic(3).state,'closed');
  f.h.calls.length=0;await runAt('2026-11-07T10:16:00+08:00');
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='close'),[['pane','close',topic(1).paneId]]);
  assert.deepEqual(f.store.data.topics.map(t=>[t.scheduled!.n,t.state]),[[1,'closed'],[2,'closed'],[3,'closed'],[4,'ready'],[5,'ready'],[6,'ready']]);
 }finally{f.close();}
});
test('a run that cannot post its card or start its agent is recorded as failed and logged; the next time runs again',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});
  f.postFails=Error('飞书未连接');f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  assert.deepEqual([f.store.data.topics,f.h.calls],[[],[]]);
  f.postFails=null;f.h.on['agent start']=()=>{throw coded('agent_pane_busy','agent target pane w1:p1 is not an available shell');};f.at('2026-11-06T10:10:00+08:00');await f.schedules.tick();
  assert.equal(f.store.data.topics[0].state,'failed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);
  f.at('2026-11-06T10:15:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.n,r.reason]),[['failed',undefined,'未能在群里发出这次运行的消息'],['failed',1,'Agent 启动失败'],['started',2,undefined]]);
  assert.deepEqual(scheduleLogs(f).slice(1).map(l=>[l[0],l[1].replace(/[0-9a-f]{8}/g,'<id>')]),[['error','个人助手：定时任务 <id> 未能发出运行的消息，飞书未连接']]);
 }finally{f.close();}
});
test('a stored schedule whose time cannot be read is paused with a log line, and the others still run',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const broken=f.schedules.add(daily),s=f.schedules.add({...daily,cron:'*/5 * * * *'});f.store.data.schedules[0].timeZone='Mars/Base';
  f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.store.data.schedules.map(x=>x.paused),[true,false]);assert.deepEqual(f.schedules.runs(s.id).map(r=>r.outcome),['started']);
  assert.match(scheduleLogs(f).at(-1)![1],new RegExp(`^个人助手：定时任务 ${broken.id.slice(0,8)} 的时间无法计算，已暂停：`));assert.equal(scheduleLogs(f).at(-1)![0],'error');
 }finally{f.close();}
});
test('a time that waits behind a slow run of its schedule does not run once the schedule is paused or removed meanwhile',async()=>{
 for(const change of ['pause','remove'] as const){
  const f=scheduleFixture();try{
   f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'* * * * *'});
   let release!:()=>void;f.h.on['agent start']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
   f.at('2026-11-06T10:01:00+08:00');const first=f.schedules.tick();await later(10);
   f.at('2026-11-06T10:02:00+08:00');const second=f.schedules.tick();await later(10);
   const runs=f.schedules.runs(s.id);f.schedules[change](s.id);release();await Promise.all([first,second]);
   assert.deepEqual([runs.map(r=>[when(r.due,'Asia/Shanghai'),r.outcome]),f.posted.length,f.store.data.topics.length],[[['2026-11-06 10:01','started']],1,1],change);
  }finally{f.close();}
 }
});
test('the run record of a schedule keeps its latest 20 runs',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'* * * * *'});
  for(let i=1;i<=25;i++){f.h.on['workspace list']=()=>{throw Error('down');};f.at(new Date(at('2026-11-06T10:00:00+08:00')+i*60000).toISOString());await f.schedules.tick();}
  const runs=f.schedules.runs(s.id);assert.equal(runs.length,20);assert.deepEqual([runs[0].n,runs.at(-1)!.n],[6,25]);
 }finally{f.close();}
});
test('the timer of the schedules checks them every interval from start until stop; starting twice keeps one timer',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-schedules-'));try{
  // Only the timer runs.
  const schedules=new Schedules(new Store(dir),{every:5} as DepsOf<typeof Schedules>);let ticks=0;schedules.tick=loose<typeof schedules.tick>(()=>{ticks++;});
  schedules.start();schedules.start();await later(40);schedules.stop();const seen=ticks;assert.ok(seen>=2&&seen<=10,String(seen));
  await later(30);assert.equal(ticks,seen);
 }finally{fs.rmSync(dir,{recursive:true});}
});
// The agent schedules over a schedule fixture (see scheduleFixture), with its clock; its machine cpu2 is of the Herdr session default.
// f.call(op,fields,t) is a request of the agent of topic t (the first topic by default) that the client of its machine passed on;
// f.click(id,choice,openId) clicks 确认 or 取消 on the card of proposal id, and f.drawn() waits for the cards being redrawn. f.open(messageId)
// opens a ready topic.
function agentFixture(options:TopicOptions={}){
 const f=scheduleFixture({...options,machine:{session:'default',...options.machine}});
 const deps:DepsOf<typeof AgentSchedules>={topics:f.topics,schedules:f.schedules,app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},reply:(...args)=>f.topics.reply(...args),updateCard:(...args)=>f.topics.updateCard(...args),now:()=>f.clock.now};
 const agents=new AgentSchedules(f.store,deps);
 return Object.assign(f,{agents,deps,
  // The answer, read as JSON.
  // The answer of an operation (see ScheduleOps), none for another.
  call:<K extends string>(op:K,fields:Record<string,unknown>={},t=f.store.data.topics[0])=>agents.call(f.m,op,{pane:t.paneId,...fields}) as Promise<K extends keyof ScheduleOps?ScheduleOps[K]['answer']:never>,
  click:(id:string,choice:string,openId='ou_user',a=agents)=>a.click(allowed,{messageId:'om_any',chatId:'oc_1',operator:{openId},action:{tag:'button',value:{schedule:choice,proposal:id}}} as Click),
  drawn:()=>Promise.all(agents.drawing.values()),
  open:async(messageId:string)=>{await f.send({messageId,content:'topic '+messageId});return f.store.data.topics.find(t=>t.rootId===messageId)!;}});
}
const weekdays930={cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交',mode:'new'};
// The card of a confirmation with its two buttons for proposal id.
const confirmButtons=(id:string)=>({tag:'column_set',horizontal_spacing:'8px',columns:[['确认','primary','confirm'],['取消','default','cancel']].map(([content,type,choice])=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value:{schedule:choice,proposal:id}}]}]}))});
const nextWeekdays=['2026-11-09 周一 09:30','2026-11-10 周二 09:30','2026-11-11 周三 09:30','2026-11-12 周四 09:30','2026-11-13 周五 09:30'];
const aboutWeekdays=(task='总结昨天的提交')=>[plainText('时间：每周一至周五 09:30（Asia/Shanghai，cron：30 9 * * 1-5）'),plainText('接下来 5 次运行：\n'+nextWeekdays.join('\n')),plainText('任务：\n'+task)];
const newTopicMode=plainText('模式：每次开新话题。每次运行时机器人在群里发一条消息，在它下面开一个新话题，交给一个新的 Agent'),intoThisMode=plainText('模式：发进这个话题。每次运行把任务发给这个话题里的 Agent，它记得之前的对话');
const boundTo=plainText('绑定：个人助手（work · cpu2 · Claude）');
test('an agent is known by the machine whose client passed its request on and by its pane: a ready topic there whose agent is still linked; any other pane, machine, Herdr session or topic is refused, and a topic whose agent is gone ends',async()=>{
 const other:Machine={id:'m2',name:'cpu1',session:'default',enabled:true};
 const f=agentFixture({machines:[other]});try{
  const t=await f.open('om_1');
  assert.deepEqual(await f.call('list'),{binding:{id:'b',name:'个人助手'},topicId:t!.id,schedules:[]});
  assert.equal((await f.call('list',{session:'default'})).topicId,t!.id);
  const notTopic=/这个 pane 里的 Agent 不属于任何进行中的飞书话题/;
  // The same pane on another machine is another agent, whatever machine the request names.
  for(const [m,request,error] of [[f.m,{},/缺少 pane/],[f.m,{pane:''},/缺少 pane/],[f.m,{pane:'w1:p9'},notTopic],[other,{pane:t!.paneId},notTopic],[other,{pane:t!.paneId,machine:'cpu2',machineId:'m'},notTopic],
   [f.m,{pane:t!.paneId,session:'work'},/这个 Agent 在 Herdr session work 里，Bridge 连接的是这台机器的 session default/]] satisfies [Machine,object,RegExp][])
   await assert.rejects(f.agents.call(m,'list',request),error,JSON.stringify(request));
  for(const request of [null,[],'list'])await assert.rejects(f.agents.call(f.m,'list',request),/请求内容无效/,JSON.stringify(request));
  await assert.rejects(f.call('loop'),/未知的操作：loop/);
  f.m.enabled=false;await assert.rejects(f.call('list'),/Bridge 已断开机器 cpu2 的桥接/);f.m.enabled=true;
  // The agent no longer reports remote answers: the topic ends, and the agent is refused.
  delete f.h.agents[0].remote_answers;f.replies.length=0;
  await assert.rejects(f.call('list'),notTopic);assert.equal(t!.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('该话题的会话已结束，请发起新话题')]);
  await assert.rejects(f.call('list'),notTopic);
 }finally{f.close();}
});
test('list, runs, pause, resume and remove act at once on the schedules of the binding of the agent\'s topic, named by their id or its first characters; another binding\'s schedules do not exist for it',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1'),other=await f.open('om_2');f.at('2026-11-06T10:00:00+08:00');
  f.store.data.bindings.push({...route,id:'b2',chatId:'oc_2'});
  const s=f.schedules.add({...daily,cron:'30 9 * * 1-5'}),into=f.schedules.add({...daily,mode:'into',topicId:other!.id,cron:'0 18 * * *'}),foreign=f.schedules.add({...daily,bindingId:'b2'});
  const entry=(x:Schedule,more?:object)=>{const {runs,...rest}=x;return {...rest,...more};};
  const listed=await f.call('list');
  assert.deepEqual(listed,{binding:{id:'b',name:'个人助手'},topicId:t!.id,schedules:[
   entry(s,{phrase:'每周一至周五 09:30',next:at('2026-11-09T09:30:00+08:00')}),entry(into,{phrase:'每天 18:00',next:at('2026-11-06T18:00:00+08:00'),here:false,topicTitle:other!.title})]});
  assert.deepEqual((await f.call('list',{},other)).schedules.map(x=>x.here),[undefined,true]);
  assert.deepEqual(await f.call('runs',{id:s.id.slice(0,8)}),{schedule:listed.schedules[0],runs:[]});
  const paused=await f.call('pause',{id:s.id.slice(0,4)});assert.deepEqual([paused.schedule.id,paused.schedule.paused,paused.schedule.next],[s.id,true,null]);assert.equal(f.store.data.schedules[0].paused,true);
  f.at('2026-11-10T10:00:00+08:00');const resumed=await f.call('resume',{id:s.id});
  assert.deepEqual([resumed.schedule.paused,resumed.schedule.next],[false,at('2026-11-11T09:30:00+08:00')]);
  assert.deepEqual(await f.call('remove',{id:into.id}),{schedule:{...entry(into,{phrase:'每天 18:00',next:at('2026-11-10T18:00:00+08:00'),here:false,topicTitle:other!.title})}});
  assert.deepEqual(f.store.data.schedules.map(x=>x.id),[s.id,foreign.id]);
  for(const op of ['runs','pause','resume','remove','update']){
   await assert.rejects(f.call(op,{id:foreign.id,task:'x'}),/定时任务不存在/,op);await assert.rejects(f.call(op,{id:'nope'}),/定时任务不存在/,op);await assert.rejects(f.call(op,{}),/缺少定时任务 ID/,op);
  }
  assert.equal(f.store.data.schedules[1].paused,false);
  // Ids that share their first characters need more of them.
  const twin=f.schedules.add(daily);f.store.data.schedules.at(-1)!.id=s.id.slice(0,4)+twin.id.slice(4);
  await assert.rejects(f.call('pause',{id:s.id.slice(0,4)}),new RegExp(`有多个定时任务的 ID 以 ${s.id.slice(0,4)} 开头`));
  assert.equal((await f.call('pause',{id:s.id.slice(0,8)})).schedule.id,s.id);
 }finally{f.close();}
});
test('an agent submits a schedule as a card in its topic\'s thread that shows it in plain words with its next runs, the task, the mode and the binding; only 确认 adds it, and the card then shows the outcome without buttons',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');f.replies.length=0;
  const r=await f.call('add',{...weekdays930,task:' 总结昨天的提交\n'}),id=t!.proposal!.id;
  assert.deepEqual(r,{proposal:{id,kind:'add',expiresAt:at('2026-11-06T10:30:00+08:00'),timeZone:'Asia/Shanghai',phrase:'每周一至周五 09:30',next:nextWeekdays.map(x=>at(x.replace(/ 周. /,'T')+':00+08:00'))}});
  assert.deepEqual(f.replies,[['a','oc_1','om_1',{card:cardOf('确认定时任务','blue',[plainText('这个话题里的 Agent 提交了一个定时任务，核对无误后点「确认」才会生效。'),...aboutWeekdays(),newTopicMode,boundTo,
   plainText('到 2026-11-06 周五 10:30 前有效，过期没有确认就不会生效'),confirmButtons(id)])}]]);
  // The proposal is on disk with the topic; nothing is added yet.
  assert.deepEqual(new Store(f.dir).data.topics[0].proposal,{id,kind:'add',fields:{mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交'},messageId:'om_bot_1',expiresAt:at('2026-11-06T10:30:00+08:00')});
  assert.deepEqual(f.schedules.list(),[]);
  f.at('2026-11-06T10:05:00+08:00');assert.deepEqual(f.click(id,'confirm'),{toast:{type:'success',content:'定时任务已生效'}});await f.drawn();
  const [s]=f.store.data.schedules;
  assert.deepEqual([s.bindingId,s.mode,s.cron,s.timeZone,s.task,s.createdBy,s.handledUntil,s.paused],['b','new','30 9 * * 1-5','Asia/Shanghai','总结昨天的提交',{topicId:t!.id,openId:'ou_user'},at('2026-11-06T10:05:00+08:00'),false]);
  assert.equal('proposal' in t!,false);assert.equal('proposal' in new Store(f.dir).data.topics[0],false);
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('定时任务已生效 · '+s.id.slice(0,8),'green',[...aboutWeekdays(),newTopicMode,boundTo,{tag:'markdown',content:'已确认 · <at id=ou_user></at>'}])]]);
  // A second click finds nothing to confirm.
  assert.deepEqual(f.click(id,'confirm'),{toast:{type:'info',content:'这张卡片已失效'}});assert.equal(f.store.data.schedules.length,1);
  assert.deepEqual(scheduleLogs(f).map(l=>l[1].replace(/[0-9a-f]{8}/g,'<id>')),['个人助手：已发出定时任务的确认卡片','个人助手：已添加定时任务 <id>（30 9 * * 1-5，Asia/Shanghai，每次开新话题）']);
 }finally{f.close();}
});
test('取消 drops a submitted schedule, a mode into schedule goes into the agent\'s own topic, and a card whose topic has ended by then adds nothing; a click without a proposal behind it does nothing',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');
  await f.call('add',weekdays930);const first=t!.proposal;
  assert.deepEqual(f.click(first!.id,'cancel','ou_other'),{toast:{type:'info',content:'已取消'}});await f.drawn();
  assert.deepEqual(f.store.data.schedules,[]);assert.deepEqual(f.updated.at(-1),['a',first!.messageId,cardOf('定时任务已取消','grey',[aboutWeekdays()[0],aboutWeekdays()[2],newTopicMode,boundTo,{tag:'markdown',content:'已取消 · <at id=ou_other></at>'}])]);
  // Mode into: this topic.
  await f.call('add',{...weekdays930,mode:'into'});const into=t!.proposal;
  assert.deepEqual(f.replies.at(-1)![3].card.body.elements.slice(4,6),[intoThisMode,boundTo]);
  f.click(into!.id,'confirm');await f.drawn();
  assert.deepEqual(f.store.data.schedules.map(s=>[s.mode,s.topicId]),[['into',t!.id]]);assert.equal(f.updated.at(-1)![2].body.elements[3].text.content,intoThisMode.text.content);
  // The topic ends while its card waits: confirming adds nothing and the card says why.
  await f.call('add',{...weekdays930,mode:'into',task:'再看一次'});const late=t!.proposal;
  await f.topics.end(allowed,t,'结束');
  assert.deepEqual(f.click(late!.id,'confirm'),{toast:{type:'error',content:'没有生效：这个话题的会话已结束，定时任务不能发进来'}});await f.drawn();
  assert.equal(f.store.data.schedules.length,1);
  assert.deepEqual(f.updated.at(-1),['a',late!.messageId,cardOf('定时任务没有生效','red',[aboutWeekdays()[0],plainText('任务：\n再看一次'),intoThisMode,boundTo,plainText('没有生效：这个话题的会话已结束，定时任务不能发进来')])]);
  // Mode new does not need the topic.
  const n=await f.open('om_2');await f.call('add',weekdays930,n);const later=n!.proposal;await f.topics.end(allowed,n,'结束');
  f.click(later!.id,'confirm');await f.drawn();assert.deepEqual(f.store.data.schedules.map(s=>s.mode),['into','new']);
  for(const [value,label] of [[{schedule:'confirm',proposal:'gone'},'gone'],[{schedule:'later',proposal:late!.id},'choice'],[{},'empty']] satisfies [object,string][])
   assert.deepEqual(f.agents.click(allowed,{messageId:'om_x',chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',value}} as Clicked),{toast:{type:'info',content:'这张卡片已失效'}},label);
  // Another app does not reach the topic's card.
  const o=await f.open('om_3');await f.call('add',weekdays930,o);
  assert.deepEqual(f.agents.click({...allowed,id:'a2'},{messageId:'om_x',chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',value:{schedule:'confirm',proposal:o!.proposal!.id}}} as Clicked),{toast:{type:'info',content:'这张卡片已失效'}});
  assert.ok(o!.proposal);
 }finally{f.close();}
});
test('a topic has one card waiting at a time: another submission is refused until the card is clicked or expires after 30 minutes, when the card shows that it expired; other topics have their own',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1'),u=await f.open('om_2');f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add(daily);
  await f.call('add',weekdays930);const first=t!.proposal;
  const busy=/这个话题已有一张等待确认的定时任务卡片，到 2026-11-06 周五 10:30 过期。请主人先在卡片上点确认或取消，再重新提交/;
  await assert.rejects(f.call('add',{...weekdays930,task:'另一个'}),busy);await assert.rejects(f.call('update',{id:s.id,task:'另一个'}),busy);
  await f.call('add',weekdays930,u);assert.ok(u!.proposal);
  // The timer draws cards that expired; one that has not expired stays.
  f.at('2026-11-06T10:29:59+08:00');await f.agents.expire();assert.equal(t!.proposal,first);
  f.at('2026-11-06T10:30:00+08:00');await f.agents.expire();
  assert.equal('proposal' in t!,false);assert.equal('proposal' in u!,false);
  assert.deepEqual(f.updated.find(x=>x[1]===first!.messageId),['a',first!.messageId,cardOf('定时任务的确认已过期','grey',[aboutWeekdays()[0],aboutWeekdays()[2],newTopicMode,boundTo,plainText('过期前没有确认，没有生效')])]);
  assert.deepEqual(f.click(first!.id,'confirm'),{toast:{type:'info',content:'这张卡片已失效'}});
  await f.call('add',weekdays930);const second=t!.proposal;
  // A click after the card expired, before the timer saw it, adds nothing; a submission then replaces the expired card.
  f.at('2026-11-06T11:00:00+08:00');assert.deepEqual(f.click(second!.id,'confirm'),{toast:{type:'info',content:'这张卡片已过期，定时任务没有生效'}});await f.drawn();
  assert.equal(f.updated.at(-1)![2].header!.title.content,'定时任务的确认已过期');
  await f.call('add',weekdays930);const third=t!.proposal;f.at('2026-11-06T11:31:00+08:00');f.updated.length=0;
  await f.call('add',{...weekdays930,task:'新的'});await f.drawn();
  assert.deepEqual(f.updated.map(x=>[x[1],x[2].header!.title.content]),[[third!.messageId,'定时任务的确认已过期']]);assert.equal(t!.proposal!.fields.task,'新的');
  assert.deepEqual(f.schedules.list().map(x=>x.id),[s.id]);
 }finally{f.close();}
});
test('a submission that is invalid, too long for its card or whose card cannot be posted is refused, and leaves nothing waiting',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');f.replies.length=0;
  for(const [fields,error] of [[{mode:'loop'},/模式无效/],[{mode:undefined},/模式无效/],[{cron:'61 * * * *'},/分钟/],[{cron:'0 0 31 2 *'},/不会再运行/],[{timeZone:'Mars/Base'},/时区无效/],[{timeZone:undefined},/时区无效/],[{task:' '},/任务文字/],
   // Serialized twice a quote takes 4 bytes: 8000 of them make a card over 30 KB.
   [{task:'"'.repeat(8000)},/任务文字太长，确认卡片放不下/]])
   await assert.rejects(f.call('add',{...weekdays930,...fields}),error,JSON.stringify(fields).slice(0,40));
  assert.deepEqual(f.replies,[]);assert.equal('proposal' in t!,false);
  f.topics.reply=async()=>{throw Error('飞书未连接');};
  await assert.rejects(f.call('add',weekdays930),/确认卡片没有发出去，请稍后重试/);assert.equal('proposal' in t!,false);assert.equal('proposal' in new Store(f.dir).data.topics[0],false);
  assert.deepEqual(scheduleLogs(f).at(-1),['error','个人助手：确认卡片未发出，飞书未连接']);
 }finally{f.close();}
});
test('an agent changes the time or the task of a schedule through a card that shows what it was; confirming changes it unless it was removed meanwhile',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');
  const s=f.schedules.add({...daily,cron:'0 9 * * *'});f.replies.length=0;
  await assert.rejects(f.call('update',{id:s.id}),/没有要修改的内容/);
  const r=await f.call('update',{id:s.id.slice(0,8),cron:'30 9 * * 1-5'}),p=t!.proposal,short=s.id.slice(0,8);
  assert.deepEqual([r.proposal!.kind,r.proposal!.scheduleId,p!.scheduleId,p!.before,p!.fields],['update',s.id,s.id,{cron:'0 9 * * *',timeZone:'Asia/Shanghai',task:'总结昨天的提交'},{mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交'}]);
  assert.deepEqual(f.replies[0][3].card,cardOf('确认修改定时任务 · '+short,'blue',[plainText(`这个话题里的 Agent 提交了对定时任务 ${short} 的修改，核对无误后点「确认」才会生效。`),
   plainText('时间：每周一至周五 09:30（Asia/Shanghai，cron：30 9 * * 1-5）\n原来的时间：每天 09:00（Asia/Shanghai，cron：0 9 * * *）'),...aboutWeekdays().slice(1),newTopicMode,boundTo,plainText('到 2026-11-06 周五 10:30 前有效，过期没有确认就不会生效'),confirmButtons(p!.id)]));
  f.at('2026-11-06T10:01:00+08:00');assert.deepEqual(f.click(p!.id,'confirm'),{toast:{type:'success',content:'定时任务已修改'}});await f.drawn();
  assert.deepEqual([f.store.data.schedules[0].cron,f.store.data.schedules[0].handledUntil],['30 9 * * 1-5',at('2026-11-06T10:01:00+08:00')]);
  assert.equal(f.updated[0][2].header!.title.content,'定时任务已修改 · '+short);
  // A task alone: the card marks the task as changed and keeps the time as it was.
  await f.call('update',{id:short,task:'新的任务'});
  assert.deepEqual(f.replies.at(-1)![3].card.body.elements.slice(1,4),[aboutWeekdays()[0],aboutWeekdays()[1],plainText('任务（已修改）：\n新的任务')]);
  f.schedules.remove(s.id);
  assert.deepEqual(f.click(t!.proposal!.id,'confirm'),{toast:{type:'error',content:'没有生效：定时任务不存在'}});await f.drawn();
  assert.equal(f.updated.at(-1)![2].header!.title.content,'修改没有生效 · '+short);assert.deepEqual(f.store.data.schedules,[]);
 }finally{f.close();}
});
test('a click that comes before the post of its card has resolved draws the card it came from',async()=>{
 const f=agentFixture();try{
  await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');let posted:((id:string)=>void)|undefined;f.topics.reply=()=>new Promise<string>(r=>{posted=r;});
  const sent=f.call('add',weekdays930);for(let i=0;i<50&&!posted;i++)await later(5);
  assert.deepEqual(f.click(f.store.data.topics[0].proposal!.id,'confirm'),{toast:{type:'success',content:'定时任务已生效'}});await f.drawn();
  posted!('om_card');await sent;
  assert.deepEqual(f.updated.map(u=>[u[1],u[2].header!.title.content]),[['om_any','定时任务已生效 · '+f.store.data.schedules[0].id.slice(0,8)]]);
 }finally{f.close();}
});
test('a card waiting for its click survives a restart of Bridge: the click is answered from the state file',async()=>{
 const f=agentFixture();try{
  await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');await f.call('add',weekdays930);const id=f.store.data.topics[0].proposal!.id;
  const {store,topics}=f.restart(),schedules=new Schedules(store,{topics,app:f.deps.app,send:async()=>'om_post',reply:f.deps.reply,now:f.deps.now});
  const agents=new AgentSchedules(store,{...f.deps,topics,schedules});
  assert.deepEqual(f.click(id,'confirm','ou_user',agents),{toast:{type:'success',content:'定时任务已生效'}});await Promise.all(agents.drawing.values());
  assert.equal(store.data.schedules.length,1);assert.equal(new Store(f.dir).data.schedules.length,1);
 }finally{f.close();}
});
test('the timer of the agent schedules checks for expired cards every interval from start until stop; starting twice keeps one timer',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-agent-schedules-'));try{
  // Only the timer runs.
  const agents=new AgentSchedules(new Store(dir),{every:5} as DepsOf<typeof AgentSchedules>);let checks=0;agents.expire=loose<typeof agents.expire>(()=>{checks++;});
  agents.start();agents.start();await later(40);agents.stop();const seen=checks;assert.ok(seen>=2&&seen<=10,String(seen));
  await later(30);assert.equal(checks,seen);
 }finally{fs.rmSync(dir,{recursive:true});}
});
// The Bridge client of a machine as bridge-schedule sees it: an HTTP server on a Unix socket in a directory of its own, where answer(op,body)
// returns [status, data]. f.requests records each request as [method, path, content type, body].
async function fakeClient(answer:(op:string,body:unknown)=>[number,unknown]|Promise<[number,unknown]>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-agent-')),socket=path.join(dir,'client.sock'),requests:unknown[][]=[];
 const server=http.createServer(async(req,res)=>{
  let s='';for await(const c of req)s+=c;const body=JSON.parse(s);requests.push([req.method,req.url,req.headers['content-type'],body]);
  const [code,data]=await answer(req.url!.replace(/^\/(schedules|skills)\//,''),body);res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));
 });
 await new Promise<void>(r=>server.listen(socket,r));
 return {dir,socket,requests,close:()=>new Promise<void>(r=>server.close(()=>{fs.rmSync(dir,{recursive:true});r();}))};
}
// Runs bridge-schedule with args in env (the socket that of client, its pane w1:p1) and resolves to {code, out, err}.
async function schedule(client:{socket:string},args:string[],{env={}}:{env?:NodeJS.ProcessEnv}={}){
 let out='',err='';
 const code=await runCommand(args,{env:{BRIDGE_CLIENT_SOCKET:client.socket,HERDR_PANE_ID:'w1:p1',...env},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},timeZone:'Asia/Shanghai'});
 return {code,out,err};
}
// Runs bridge-skill with args in env (the socket that of client) and resolves to {code, out, err}.
async function skill(client:{socket:string},args:string[],{env={}}:{env?:NodeJS.ProcessEnv}={}){
 let out='',err='';
 const code=await runSkill(args,{env:{BRIDGE_CLIENT_SOCKET:client.socket,...env},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}});
 return {code,out,err};
}
const sid=(n:number)=>`${n}0000000-0000-4000-8000-00000000000${n}`.slice(0,36);
test('bridge-schedule reads its operation, the id and options in any order, with a value after the option or after =; anything else is a usage error',()=>{
 assert.deepEqual(parseCommand(['add','--cron','30 9 * * 1-5','--mode=new','--task','--看起来像选项','--tz','UTC','--json']),{op:'add',json:true,cron:'30 9 * * 1-5',mode:'new',task:'--看起来像选项',timeZone:'UTC'});
 assert.deepEqual(parseCommand(['pause','1a2b3c4d','--pane','w1:p2','--session=work']),{op:'pause',id:'1a2b3c4d',json:false,pane:'w1:p2',session:'work'});
 assert.deepEqual(parseCommand(['--help']),{json:false,help:true});
 // The machine is the one it runs on, which its client vouches for: no option names another.
 for(const [args,error] of [[['add','--cron'],/--cron 缺少值/],[['list','--loop'],/未知的参数：--loop/],[['pause','a','b'],/多余的参数：b/],[['list','--machine','cpu2'],/未知的参数：--machine/],[['--stdin','list'],/未知的参数：--stdin/]] satisfies [string[],RegExp][])
  assert.throws(()=>parseCommand(args),error,args.join(' '));
});
test('bridge-schedule sends its request to the Bridge client of its machine with the pane and the Herdr session of its agent and the time zone of its machine, and prints what Bridge answers for the agent to read, or the answer itself with --json',async()=>{
 const due=(iso:string)=>at(iso);
 const list={binding:{id:'b',name:'个人助手'},topicId:'t1',schedules:[
  {id:sid(1),bindingId:'b',mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交\n第二行',paused:false,next:due('2026-11-09T09:30:00+08:00'),phrase:'每周一至周五 09:30'},
  {id:sid(2),bindingId:'b',mode:'into',topicId:'t1',here:true,topicTitle:'看看',cron:'0 18 * * *',timeZone:'Asia/Shanghai',task:'看一下',paused:true,next:null,phrase:'每天 18:00'},
  {id:sid(3),bindingId:'b',mode:'into',topicId:'t2',here:false,topicTitle:'另一个话题',cron:'0 8 * * *',timeZone:'UTC',task:'x'.repeat(300),paused:false,next:null,phrase:'每天 08:00'}]};
 const [first]=list.schedules,runs={schedule:first,runs:[
  {due:due('2026-11-06T09:30:00+08:00'),at:due('2026-11-06T09:30:05+08:00'),outcome:'started',n:1,topicId:'t3'},
  {due:due('2026-11-09T09:30:00+08:00'),at:due('2026-11-09T10:15:00+08:00'),outcome:'started',n:2,topicId:'t4'},
  {due:due('2026-11-10T09:30:00+08:00'),at:due('2026-11-10T09:30:00+08:00'),outcome:'skipped',reason:'上次还没结束，跳过'},
  {due:due('2026-11-11T09:30:00+08:00'),last:due('2026-11-12T09:30:00+08:00'),at:due('2026-11-12T12:00:00+08:00'),outcome:'missed',reason:'Bridge 停机，错过'},
  {due:due('2026-11-13T09:30:00+08:00'),at:due('2026-11-13T09:30:00+08:00'),outcome:'failed',n:3,topicId:'t5',reason:'Agent 启动失败'}]};
 const proposal=(kind:string,more?:object)=>({proposal:{id:'p1',kind,...more,expiresAt:due('2026-11-06T10:30:00+08:00'),timeZone:'Asia/Shanghai',phrase:'每周一至周五 09:30',next:[due('2026-11-09T09:30:00+08:00'),due('2026-11-10T09:30:00+08:00')]}});
 const answers:Record<string,unknown>={list:list,runs,pause:{schedule:{...first,paused:true,next:null}},resume:{schedule:first},remove:{schedule:first},add:proposal('add'),update:proposal('update',{scheduleId:sid(1)})};
 const client=await fakeClient(op=>[200,answers[op]]);try{
  const text:Record<string,string[]>={
   list:['绑定「个人助手」上有 3 个定时任务：',
    `${sid(1).slice(0,8)} · 每次开新话题 · 每周一至周五 09:30（Asia/Shanghai，cron：30 9 * * 1-5）`,'  下次运行：2026-11-09 周一 09:30','  任务：总结昨天的提交 第二行',
    `${sid(2).slice(0,8)} · 发进这个话题 · 每天 18:00（Asia/Shanghai，cron：0 18 * * *） · 已暂停`,'  任务：看一下',
    `${sid(3).slice(0,8)} · 发进话题「另一个话题」 · 每天 08:00（UTC，cron：0 8 * * *）`,'  下次运行：不会再运行',`  任务：${'x'.repeat(199)}…`],
   runs:[`定时任务 ${sid(1).slice(0,8)}（每周一至周五 09:30，Asia/Shanghai）最近 5 次运行：`,'2026-11-06 周五 09:30 · 已运行 · 第 1 次','2026-11-09 周一 09:30 · 已运行 · 第 2 次 · 补跑于 2026-11-09 周一 10:15',
    '2026-11-10 周二 09:30 · 跳过：上次还没结束，跳过','2026-11-11 周三 09:30 至 2026-11-12 周四 09:30 · 错过：Bridge 停机，错过','2026-11-13 周五 09:30 · 失败：Agent 启动失败 · 第 3 次'],
   pause:[`已暂停定时任务 ${sid(1).slice(0,8)}（每周一至周五 09:30）。恢复之前不会运行，暂停期间的时间恢复后也不补跑。`],
   resume:[`已恢复定时任务 ${sid(1).slice(0,8)}，下次运行：2026-11-09 周一 09:30。`],
   remove:[`已删除定时任务 ${sid(1).slice(0,8)}（每周一至周五 09:30）。它开过的话题保留。`],
   add:['已在这个话题里发了确认卡片：每周一至周五 09:30（Asia/Shanghai），下次运行 2026-11-09 周一 09:30。主人在卡片上点「确认」后才生效；到 2026-11-06 周五 10:30 还没有确认就作废。'],
   update:[`已在这个话题里发了修改定时任务 ${sid(1).slice(0,8)} 的确认卡片：每周一至周五 09:30（Asia/Shanghai），下次运行 2026-11-09 周一 09:30。主人在卡片上点「确认」后才生效；到 2026-11-06 周五 10:30 还没有确认就作废。`]};
  const args:Record<string,string[]>={list:['list'],runs:['runs','1a2b'],pause:['pause','1a2b'],resume:['resume','1a2b'],remove:['remove','1a2b'],add:['add','--cron','30 9 * * 1-5','--mode','new','--task','总结'],update:['update','1a2b','--task','新的']};
  for(const op of Object.keys(text)){
   assert.deepEqual(await schedule(client,args[op]),{code:0,out:text[op].join('\n')+'\n',err:''},op);
   assert.deepEqual(await schedule(client,[...args[op],'--json']),{code:0,out:JSON.stringify(answers[op],null,2)+'\n',err:''},op);
  }
  // Each request: the operation in the path, JSON, the agent's pane and Herdr session; a new schedule without --tz takes the machine's time zone.
  assert.deepEqual(client.requests.filter((r,i)=>i%2===0).map(r=>[r[0],r[1],r[2]]),Object.keys(text).map(op=>['POST','/schedules/'+op,'application/json']));
  assert.deepEqual(client.requests.map(r=>r[3]).filter((r,i)=>i%2===0),[{pane:'w1:p1'},{pane:'w1:p1',id:'1a2b'},{pane:'w1:p1',id:'1a2b'},{pane:'w1:p1',id:'1a2b'},{pane:'w1:p1',id:'1a2b'},
   {pane:'w1:p1',cron:'30 9 * * 1-5',mode:'new',task:'总结',timeZone:'Asia/Shanghai'},{pane:'w1:p1',id:'1a2b',task:'新的'}]);
  client.requests.length=0;
  await schedule(client,['list','--pane','w2:p3'],{env:{HERDR_SESSION:'work'}});await schedule(client,['add','--tz','UTC','--cron','0 9 * * *','--mode','into','--task','t']);
  assert.deepEqual(client.requests.map(r=>r[3]),[{pane:'w2:p3',session:'work'},{pane:'w1:p1',timeZone:'UTC',cron:'0 9 * * *',mode:'into',task:'t'}]);
 }finally{await client.close();}
});
test('bridge-schedule prints what was refused and exits 1, a usage error with the usage and exits 2, and names the Bridge client of its machine when it cannot reach it: no socket, a socket nothing listens on, or one it may not open',async()=>{
 const client=await fakeClient(()=>[400,{error:'定时任务不存在'}]);try{
  assert.deepEqual(await schedule(client,['pause','x']),{code:1,out:'',err:'bridge-schedule: 定时任务不存在\n'});
  for(const args of [[],['loop'],['list','--loop']]){const r=await schedule(client,args);assert.equal(r.code,2,args.join(' '));assert.match(r.err,/用法：\n  bridge-schedule add --cron/);}
  const help=await schedule(client,['--help']);assert.equal(help.code,0);assert.match(help.out,/^用法：/);assert.deepEqual(client.requests.map(r=>r[1]),['/schedules/pause']);
  // A socket that a client left when it ended.
  const gone={socket:path.join(client.dir,'none.sock')},stale={socket:path.join(client.dir,'stale.sock')};
  execFileSync(process.execPath,['-e',`require('node:net').createServer().listen(${JSON.stringify(stale.socket)},()=>process.exit(0))`]);assert.ok(fs.existsSync(stale.socket));
  for(const c of [gone,stale])assert.deepEqual(await schedule(c,['list']),{code:1,out:'',err:`bridge-schedule: 连不上本机的 Bridge 客户端（${c.socket}）：客户端没有运行，或者没有打开这个 socket\n`},c.socket);
  // A socket it may not open, as in the sandbox of an agent that forbids connections.
  fs.chmodSync(client.socket,0);
  if(process.getuid?.()!==0)assert.deepEqual(await schedule(client,['list']),{code:1,out:'',err:`bridge-schedule: 没有权限连接本机的 Bridge 客户端（${client.socket}）：如果命令运行在 Agent 的沙箱里，需要在沙箱外运行这条命令\n`});
 }finally{await client.close();}
});
// Runs program with args in env without blocking, so that a fake Bridge of this process can answer it; resolves to {status, stdout, stderr}.
function spawned(program:string,args:string[],env:NodeJS.ProcessEnv){
 return new Promise<{status:number|null,stdout:string,stderr:string}>((resolve,reject)=>{const p=spawn(program,args,{env});let stdout='',stderr='';p.stdout.on('data',d=>{stdout+=d;});p.stderr.on('data',d=>{stderr+=d;});p.on('error',reject);p.on('close',status=>resolve({status,stdout,stderr}));});
}
test('bridge-schedule --help is complete on its own, since the skill that tells agents when to use it leaves the details to it: every operation with what it does, every option with its values, the syntax of a cron expression, the exit codes and what to do on each error that the agent has to handle',async()=>{
 const client=await fakeClient(()=>[200,{}]);try{
  const {code,out}=await schedule(client,['--help']);assert.equal(code,0);assert.equal(out,usage);assert.deepEqual(client.requests,[]);
  for(const op of ['add','list','runs','update','pause','resume','remove']){assert.ok(out.includes('  bridge-schedule '+op),op);assert.match(out,new RegExp(`^  ${op} +\\S`,'m'),op);}
  for(const option of ['--cron','--tz','--mode','--task','--json','--pane','--session','--help','HERDR_PANE_ID','HERDR_SESSION'])assert.ok(out.includes(option),option);
  for(const fact of ['5 个字段','IANA','0 和 7 都是星期日','@daily','退出码','确认卡片','30 分钟','开头几位','连不上本机的 Bridge 客户端','本机的 Bridge 客户端没有连上控制面','没有权限连接本机的 Bridge 客户端','不属于任何进行中的飞书话题'])assert.ok(out.includes(fact),fact);
 }finally{await client.close();}
});
test('bridge-skill reads its operation and the arguments that each takes, the words of a search, and --json for the reads; anything else is a usage error',()=>{
 assert.deepEqual(parseSkill(['list','--json']),{op:'list',args:[],json:true});assert.deepEqual(parseSkill(['search','部署','CI']),{op:'search',args:['部署','CI'],json:false});
 assert.deepEqual(parseSkill(['read','alpha']),{op:'read',args:['alpha'],json:false});assert.deepEqual(parseSkill(['import','./alpha']),{op:'import',args:['./alpha'],json:false});
 assert.deepEqual(parseSkill(['export','alpha']),{op:'export',args:['alpha'],json:false});assert.deepEqual(parseSkill(['export','alpha','/tmp/x']),{op:'export',args:['alpha','/tmp/x'],json:false});
 assert.deepEqual(parseSkill(['preload','alpha','off']),{op:'preload',args:['alpha','off'],json:false});assert.deepEqual(parseSkill(['remove','alpha']),{op:'remove',args:['alpha'],json:false});
 assert.deepEqual(parseSkill(['-h']),{args:[],json:false,help:true});
 for(const [args,error] of [[[],/^缺少操作$/],[['make'],/^未知的操作：make$/],[['list','x'],/^多余的参数：x$/],[['search'],/^缺少要搜索的词$/],[['read'],/^缺少 skill 的名称$/],[['read','a','b'],/^多余的参数：b$/],
  [['import'],/^缺少 skill 的目录$/],[['export','a','b','c'],/^多余的参数：c$/],[['preload','a'],/^preload 要写 on 或 off$/],[['preload','a','yes'],/^preload 要写 on 或 off$/],[['remove'],/^缺少 skill 的名称$/],
  [['remove','a','--json'],/^--json 只用于 list、search 和 read$/],[['list','--all'],/^未知的参数：--all$/]] satisfies [string[],RegExp][])
  assert.throws(()=>parseSkill(args),(e:Thrown)=>e.usage===true&&error.test(e.message),args.join(' '));
});
test('bridge-skill lists, searches and reads skills through the Bridge client of its machine and prints them for the agent to read, or the answer itself with --json; a skill with other files comes with the directory of this machine that holds them',async()=>{
 const index=[{name:'bridge-schedule',description:'定时任务\n第二行',preload:true,digest:'a'.repeat(64)},{name:'deploy-notes',description:'部署前后要检查的事项。',preload:false,digest:'b'.repeat(64)}];
 const text='---\nname: deploy-notes\ndescription: 部署前后要检查的事项。\n---\n先看 CI。\n',kept='/home/u/.local/share/herdr-bridge/skills/deploy-notes';
 const answers:Record<string,unknown>={list:{skills:index},search:{skills:[index[1]]},read:{name:'deploy-notes',description:'部署前后要检查的事项。',preload:false,text,files:['references/a.md','scripts/check.sh'],path:kept}};
 const client=await fakeClient(op=>[200,answers[op]]);try{
  assert.deepEqual(await skill(client,['list']),{code:0,out:'平台上有 2 个 skill：\nbridge-schedule · 默认加载\n  定时任务 第二行\ndeploy-notes · 按需读取\n  部署前后要检查的事项。\n',err:''});
  assert.deepEqual(await skill(client,['search','部署','CI']),{code:0,out:'匹配「部署 CI」的 skill 有 1 个：\ndeploy-notes · 按需读取\n  部署前后要检查的事项。\n',err:''});
  assert.deepEqual(await skill(client,['read','deploy-notes']),{code:0,out:`deploy-notes 带有其他文件，在这台机器的 ${kept} 里：\n  references/a.md\n  scripts/check.sh\nSKILL.md 里提到的相对路径都相对这个目录。\n\n${text}`,err:''});
  for(const [op,...args] of [['list'],['search','x'],['read','x']])assert.deepEqual(await skill(client,[op,...args,'--json']),{code:0,out:JSON.stringify(answers[op],null,2)+'\n',err:''},op);
  assert.deepEqual(client.requests.slice(0,3),[['POST','/skills/list','application/json',{}],['POST','/skills/search','application/json',{query:'部署 CI'}],['POST','/skills/read','application/json',{name:'deploy-notes'}]]);
 }finally{await client.close();}
 // No skill at all, none that matches, and a skill of SKILL.md alone, which is all there is to read.
 const empty=await fakeClient(op=>[200,op==='read'?{name:'a',description:'d',preload:false,text:'---\nname: a\n---',files:[]}:{skills:[]}]);try{
  assert.deepEqual(await skill(empty,['list']),{code:0,out:'平台上还没有 skill。\n',err:''});assert.deepEqual(await skill(empty,['search','x']),{code:0,out:'没有匹配「x」的 skill。\n',err:''});
  assert.deepEqual(await skill(empty,['read','a']),{code:0,out:'---\nname: a\n---\n',err:''});
 }finally{await empty.close();}
});
test('bridge-skill prints what was refused and exits 1, a usage error with the usage and exits 2, names the Bridge client of its machine when it cannot reach it, and does not manage skills without the address and the access key of the console',async()=>{
 const client=await fakeClient(()=>[400,{error:'skill 不存在：x'}]);try{
  assert.deepEqual(await skill(client,['read','x']),{code:1,out:'',err:'bridge-skill: skill 不存在：x\n'});
  for(const args of [[],['make'],['read']]){const r=await skill(client,args);assert.equal(r.code,2,args.join(' '));assert.match(r.err,/用法：\n  bridge-skill list/);}
  const help=await skill(client,['--help']);assert.equal(help.code,0);assert.equal(help.out,skillUsage);
  const gone={socket:path.join(client.dir,'none.sock')};
  assert.deepEqual(await skill(gone,['list']),{code:1,out:'',err:`bridge-skill: 连不上本机的 Bridge 客户端（${gone.socket}）：客户端没有运行，或者没有打开这个 socket\n`});
  const needed='bridge-skill: 管理 skill 要设置 BRIDGE_URL（管理台的地址，例如 http://<控制面>:8080）和 BRIDGE_ACCESS_KEY（管理台的访问密钥）\n';
  for(const [args,env] of [[['import','.'],{}],[['export','x'],{BRIDGE_URL:'http://127.0.0.1:9'}],[['preload','x','on'],{BRIDGE_ACCESS_KEY:'k'}],[['remove','x'],{}]] satisfies [string[],NodeJS.ProcessEnv][])assert.deepEqual(await skill(client,args,{env}),{code:1,out:'',err:needed},args.join(' '));
  const closed=`http://127.0.0.1:${await freePort()}`;
  assert.deepEqual(await skill(client,['remove','x'],{env:{BRIDGE_URL:closed,BRIDGE_ACCESS_KEY:'k'}}),{code:1,out:'',err:`bridge-skill: 连不上控制面 ${closed}：ECONNREFUSED\n`});
  assert.deepEqual(client.requests.map(r=>r[1]),['/skills/read']);
 }finally{await client.close();}
});
test('bridge-skill --help is complete on its own, since the entry skill that tells agents about the platform leaves the details to it: every operation with what it does and what it takes, where the files of a skill go, what the management commands need, the exit codes and what to do on each error that the agent has to handle',async()=>{
 const {code,out,err}=await skill({socket:'/nonexistent'},['--help']);assert.deepEqual([code,err],[0,'']);assert.equal(out,skillUsage);
 for(const op of ['list','search','read','import','export','preload','remove']){assert.ok(out.includes('  bridge-skill '+op),op);assert.match(out,new RegExp(`^  ${op} +\\S`,'m'),op);}
 for(const fact of ['--json','-h, --help','BRIDGE_URL','BRIDGE_ACCESS_KEY','access-key','默认加载','按需读取','~/.local/share/herdr-bridge/skills/<名称>','相对路径','frontmatter','软链接','退出码',
  '连不上本机的 Bridge 客户端','本机的 Bridge 客户端没有连上控制面','没有权限连接本机的 Bridge 客户端','skill 不存在'])assert.ok(out.includes(fact),fact);
 // Bridge has no projects: the two kinds of skill are 默认加载 and 按需读取.
 assert.doesNotMatch(out,/项目|everywhere/);
});
const minutes=(n:number)=>n*60000;
function pendingFixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pending-')),store=new Store(dir),replies:unknown[][]=[],clock={now:1000};
 const pending=new PendingChats(store,{reply:loose<DepsOf<typeof PendingChats>['reply']>(async(a,chatId,rootId,content)=>{replies.push([a.id,chatId,rootId,content]);}),now:()=>clock.now});
 return {dir,store,replies,clock,pending,close(){fs.rmSync(dir,{recursive:true});}};
}
const firstDm:NormalizedMessage={...inbound,chatType:'p2p',messageId:'om_first',content:'first private prompt'};
test('an unbound chat gets one reply in the thread of its message that says it has no binding, and its message is not kept',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,firstDm);
  assert.deepEqual(f.replies,[['a','oc_1','om_first',{card:untitledOf('这个聊天还没有绑定 Bridge。',[plainText('这个聊天还没有绑定 Bridge。')])}]]);
  assert.deepEqual(f.store.data.logs.map(l=>[l.kind,l.message]),[['会话绑定','bot：私聊 oc_1 尚未绑定']]);assert.ok(!fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes('first private prompt'));
  await f.pending.open(allowed,{...firstDm,chatId:'oc_group',chatType:'group',messageId:'om_group'});assert.deepEqual(f.replies.map(r=>[r[1],r[2]]),[['oc_1','om_first'],['oc_group','om_group']]);
 }finally{f.close();}
});
test('a chat that was told gets no second reply within half an hour and is told again after it',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,firstDm);f.clock.now+=minutes(29);await f.pending.open(allowed,{...firstDm,messageId:'om_second'});assert.equal(f.replies.length,1);
  f.clock.now+=minutes(1);await f.pending.open(allowed,{...firstDm,messageId:'om_third'});assert.deepEqual(f.replies.map(r=>r[2]),['om_first','om_third']);
 }finally{f.close();}
});
test('a reply that fails is logged and the chat is not told again for it',async()=>{
 const f=pendingFixture();try{
  f.pending.reply=async()=>{throw Error('飞书未连接');};await f.pending.open(allowed,firstDm);
  assert.equal(f.store.data.logs.at(-1)!.level,'error');assert.match(f.store.data.logs.at(-1)!.message,/飞书未连接/);
 }finally{f.close();}
});
test('BRIDGE_URL must be an http(s) origin; a trailing slash is dropped',()=>{
 for(const [v,origin] of [['http://bridge.example:8080/','http://bridge.example:8080'],['https://bridge.example','https://bridge.example'],['',''],[undefined,'']])assert.equal(consoleUrl(v),origin);
 for(const v of ['http://bridge.example/admin','http://bridge.example/?x=1','http://bridge.example/#a','ftp://bridge.example','bridge.example:8080','http://user:pw@bridge.example','not a url'])assert.throws(()=>consoleUrl(v),/BRIDGE_URL/,v);
});

const png=Buffer.from('89504e470d0a1a0a0000','hex');
// The app's slash commands as Feishu lists them, by default the bridge's own with their descriptions.
const slashPath='/open-apis/application/v7/app_slash_commands',described=(text:string)=>({default_value:text,i18n:{zh_cn:text}});
const registered=[{command_id:'c-adopt',command:'adopt',description:described('接管正在运行的 Agent')},{command_id:'c-release',command:'release',description:described('结束接管')},{command_id:'c-stop',command:'stop',description:described('停止 Agent 当前这一轮')},
 {command_id:'c-wt',command:'wt',description:described('在新的 Git worktree 里开一个话题')}];
// A connected channel whose bot info comes from info() and whose slash command calls are answered by commands(request); every avatar
// download is answered by avatar(url).
type BotOptions={info?:()=>unknown,avatar?:(url:string)=>Response|Promise<Response>,commands?:(o:ApiRequest)=>unknown};
function botFixture({info,avatar,commands=()=>({code:0,msg:'success',data:{items:registered}})}:BotOptions={}){
 const requests:ApiRequest[]=[],downloads:string[]=[];
 const channel={on(){},connect:async()=>{},disconnect:async()=>{},getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async(o:ApiRequest)=>{requests.push(o);return o.url==='/open-apis/bot/v3/info'?info!():commands(o);}}};
 const f=platformFixture({channelFactory:()=>fakeChannel(channel),fetch:async(url,options)=>{downloads.push(String(url));assert.ok(options!.signal);return avatar!(String(url));}});
 const a={id:'app-1',name:'注册时的名称',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:['ou_user'],enabled:true} as App;f.store.data.apps=[a];f.store.save();
 return {...f,a,requests,downloads,file:path.join(f.dir,'avatars','app-1')};
}
const botInfo=(bot={})=>()=>({code:0,bot:{app_name:'飞书机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/avatar.png',...bot}});
test('connecting and verifying take the name and open_id from Feishu and store the https avatar',async()=>{
 const f=botFixture({info:botInfo(),avatar:()=>new Response(png,{headers:{'content-type':'image/png'}})});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'},{method:'GET',url:slashPath}]);assert.deepEqual(f.downloads,['https://cdn.example/avatar.png']);
  assert.equal(f.a.name,'飞书机器人');assert.equal(f.a.botOpenId,'ou_bot');assert.equal('botName' in f.a,false);assert.ok(f.a.verifiedAt!>0);
  assert.deepEqual(fs.readFileSync(f.file),png);assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(f.a.avatar!.type,'image/png');assert.ok(f.a.avatar!.updatedAt>0);
  assert.deepEqual(new Store(f.dir).data.apps[0].avatar,f.a.avatar);assert.equal(f.platforms.status(f.a).connection,'connected');
  const avatar=await f.platforms.avatar('app-1');assert.deepEqual([avatar!.type,avatar!.body],['image/png',png]);
  f.requests.length=0;const jpeg=Buffer.from('ffd8ffe0','hex');
  f.platforms.fetch=async()=>new Response(jpeg,{headers:{'content-type':'image/jpeg; charset=binary'}});f.platforms.channel(f.a).rawClient.request=loose<LarkChannel['rawClient']['request']>(async o=>{f.requests.push(o as ApiRequest);return {code:0,data:{bot:{app_name:'改名后的机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/new.jpg'}}};});
  assert.deepEqual(await f.platforms.verify(f.a),{verified:true,name:'改名后的机器人'});
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'}]);assert.equal(f.a.name,'改名后的机器人');assert.deepEqual(fs.readFileSync(f.file),jpeg);assert.equal(f.a.avatar!.type,'image/jpeg');
 }finally{f.close();}
});
test('an avatar that is not https, over 1 MB or not an image is not stored; the old avatar and the connection stay',async()=>{
 const cases:[string,()=>Response,number][]=[['http://cdn.example/a.png',()=>new Response(png,{headers:{'content-type':'image/png'}}),0],
  ['https://cdn.example/big.png',()=>new Response(Buffer.alloc(1024*1024+1),{headers:{'content-type':'image/png'}}),1],
  ['https://cdn.example/page',()=>new Response('<html>',{headers:{'content-type':'text/html'}}),1],
  ['https://cdn.example/missing',()=>new Response('no',{status:404,headers:{'content-type':'image/png'}}),1]];
 for(const [url,avatar,downloads] of cases){
  const f=botFixture({info:botInfo({avatar_url:url}),avatar});try{
   fs.mkdirSync(path.dirname(f.file));fs.writeFileSync(f.file,'old');const old={type:'image/png',updatedAt:1};f.a.avatar=old;
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',url);
   assert.equal(f.downloads.length,downloads,url);assert.equal(fs.readFileSync(f.file,'utf8'),'old',url);assert.deepEqual(f.a.avatar,old,url);assert.equal(f.a.name,'飞书机器人');
   assert.equal(f.store.data.logs.at(-1)!.level,'error',url);
   await f.platforms.verify(f.a);assert.equal(fs.readFileSync(f.file,'utf8'),'old',url);
  }finally{f.close();}
 }
});
test('an svg avatar is rejected because it can carry script; the old avatar stays',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
 for(const type of ['image/svg+xml','image/svg+xml; charset=utf-8','IMAGE/SVG+XML']){
  const f=botFixture({info:botInfo({avatar_url:'https://cdn.example/avatar.svg'}),avatar:()=>new Response(svg,{headers:{'content-type':type}})});try{
   fs.mkdirSync(path.dirname(f.file));fs.writeFileSync(f.file,'old');const old={type:'image/png',updatedAt:1};f.a.avatar=old;
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',type);
   assert.equal(f.downloads.length,1,type);assert.equal(fs.readFileSync(f.file,'utf8'),'old',type);assert.deepEqual(f.a.avatar,old,type);
   assert.equal(f.store.data.logs.at(-1)!.level,'error',type);assert.match(f.store.data.logs.at(-1)!.message,/头像/,type);
   const served=await f.platforms.avatar('app-1');assert.deepEqual([served!.type,served!.body.toString()],['image/png','old'],type);
  }finally{f.close();}
 }
});
test('a failed bot info request is only logged after connecting but fails a credential check',async()=>{
 const f=botFixture({info:()=>({code:99991663,msg:'invalid'}),avatar:()=>assert.fail('no download')});try{
  await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected');assert.equal(f.a.name,'注册时的名称');assert.equal(f.store.data.logs.at(-1)!.level,'error');
  await assert.rejects(f.platforms.verify(f.a),/应用凭证验证失败/);assert.equal(await f.platforms.avatar('app-1'),null);assert.equal(await f.platforms.avatar('../state.json'),null);
 }finally{f.close();}
});
test('connecting offers the commands in the slash command panel of the app: a missing one is created and one with another description updated; commands of the app are never deleted',async()=>{
 const items=[registered[0],{...registered[1],description:described('旧的说明')},{command_id:'c-deploy',command:'deploy',description:described('部署')}];
 const f=botFixture({info:botInfo({avatar_url:''}),avatar:()=>assert.fail('no download'),commands:o=>o.method==='GET'?{code:0,data:{items}}:{code:0,data:{command_id:'c-new'}}});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests.slice(1),[{method:'GET',url:slashPath},{method:'PATCH',url:slashPath+'/c-release',data:{command:'release',description:described('结束接管')}},{method:'POST',url:slashPath,data:{command:'stop',description:described('停止 Agent 当前这一轮')}},
   {method:'POST',url:slashPath,data:{command:'wt',description:described('在新的 Git worktree 里开一个话题')}}]);
  assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='斜杠命令').map(l=>[l.level,l.message]),[['info','飞书机器人：已注册斜杠命令 /release、/stop、/wt']]);
 }finally{f.close();}
});
test('without the slash command scopes, or when Feishu refuses a command, connecting logs one line and the app stays connected; every connection tries again',async()=>{
 const denied=(code:number)=>()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:{code,msg:'Access denied. One of the following scopes is required'}}});};
 const scopes='飞书机器人：未能注册斜杠命令，应用缺少权限 application:app_slash_command:read / write；命令仍可手动输入';
 for(const [commands,message,calls] of [[denied(99991672),scopes,1],[o=>o.method==='GET'?{code:0,data:{items:[]}}:denied(99991640)(),scopes,2],
  [()=>({code:40000000,msg:'command already exists'}),'飞书机器人：未能注册斜杠命令，飞书接口错误 40000000：command already exists',1]] satisfies [BotOptions['commands'],string,number][]){
  const f=botFixture({info:botInfo({avatar_url:''}),avatar:()=>assert.fail('no download'),commands});try{
   const logs=()=>f.store.data.logs.filter(l=>l.kind==='斜杠命令').map(l=>[l.level,l.message]);
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',message);
   assert.deepEqual(logs(),[['error',message]]);assert.equal(f.requests.length-1,calls,message);
   await f.platforms.stop(f.a.id);await f.platforms.start(f.a);assert.equal(logs().length,2,message);
  }finally{f.close();}
 }
});
test('an OpenAPI call through the connected channel resolves to the data of a response with code 0, or to a body without that envelope; it rejects with Feishu\'s code otherwise, also for an HTTP error status',async()=>{
 const f=platformFixture(),answers:(()=>unknown)[]=[],seen:unknown[]=[];try{
  await assert.rejects(f.platforms.request(allowed,{method:'GET',url:'/x'}),/飞书未连接/);
  f.platforms.runtime.set('a',runtimeOf({getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async(o:unknown)=>{seen.push(o);return answers.shift()!();}}}));
  answers.push(()=>({code:0,msg:'success',data:{cot_id:'1'}}),()=>({cot_id:'2',message_id:'om_2'}),()=>({code:230001,msg:'bad request'}),
   ()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:{code:99991672,msg:'denied'}}});},()=>{throw Error('timeout of 10000ms exceeded');});
  const call={method:'POST',url:'/open-apis/im/v1/message_cot',params:{receive_id_type:'chat_id'},data:{receive_id:'oc_1'}};
  assert.deepEqual(await f.platforms.request(allowed,call),{cot_id:'1'});assert.deepEqual(seen,[call]);
  assert.deepEqual(await f.platforms.request(allowed,call),{cot_id:'2',message_id:'om_2'});
  await assert.rejects(f.platforms.request(allowed,call),(e:Thrown)=>e.code===230001&&e.message==='飞书接口错误 230001：bad request');
  await assert.rejects(f.platforms.request(allowed,call),(e:Thrown)=>e.code===99991672&&e.message==='飞书接口错误 99991672：denied');
  await assert.rejects(f.platforms.request(allowed,call),/^Error: timeout of 10000ms exceeded$/);
 }finally{f.close();}
});
test('removing an app deletes its avatar',async()=>{
 const f=botFixture({info:botInfo(),avatar:()=>new Response(png,{headers:{'content-type':'image/png'}})});try{
  await f.platforms.start(f.a);assert.ok(fs.existsSync(f.file));
  await f.platforms.remove('app-1');assert.equal(fs.existsSync(f.file),false);assert.deepEqual(new Store(f.dir).data.apps,[]);assert.equal(f.platforms.runtime.has('app-1'),false);
  await assert.rejects(f.platforms.remove('../state.json'),/应用不存在/);assert.ok(fs.existsSync(path.join(f.dir,'state.json')));
 }finally{f.close();}
});

test('official onboarding automatically connects after persisting credentials',async()=>{
 let connected=false;
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_auto',client_secret:'private',user_info:{open_id:'ou_owner'}};},{connect:loose<Connect>(async a=>{assert.equal(new Store(f.store.dir).data.apps[0].appId,'cli_auto');assert.equal(f.registrations.status()!.status,'connecting');a.enabled=true;f.store.save();connected=true;})});
 try{f.registrations.start({})!;await f.registrations.current!.done;assert.ok(connected);assert.equal(f.registrations.status()!.status,'completed');assert.equal(f.store.data.apps[0].enabled,true);}finally{f.close();}
});
test('existing app selection keeps its identity, bindings and allowlist',async()=>{
 const app=normalizeApp({name:'existing',appId:'cli_existing',appSecret:'saved',allowedUsers:['ou_existing']});let target;
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);ready(o);return {client_id:app.appId,client_secret:'sdk',user_info:{open_id:'ou_other'}};},{connect:loose<Connect>(async a=>{target=a;})});
 try{f.store.data.apps.push(app);f.store.data.bindings.push({appId:app.id} as Binding);f.registrations.start({})!;await f.registrations.current!.done;assert.equal(f.store.data.apps.length,1);assert.equal(target,app);assert.deepEqual(app.allowedUsers,['ou_existing']);assert.equal(f.registrations.status()!.appId,app.id);assert.equal(f.store.data.bindings[0].appId,app.id);}finally{f.close();}
});
test('connection failure retains the added app for retry without showing false success',async()=>{
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_failed',client_secret:'private',user_info:{open_id:'ou_owner'}};},{connect:async()=>{throw Error('private response');}});
 try{f.registrations.start({})!;await f.registrations.current!.done;assert.equal(f.registrations.status()!.status,'connection_error');assert.equal(f.store.data.apps.length,1);assert.equal(f.registrations.status()!.appId,f.store.data.apps[0].id);assert.ok(!JSON.stringify(f.registrations.status()).includes('private'));}finally{f.close();}
});

test('channel startup and shutdown do not revive a cancelled connection',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lifecycle-'));let resolve!:(value?:unknown)=>void,options!:LarkChannelOptions;const handlers:Handlers={};let closes=0;
 const channel=fakeChannel({on:(name:string,fn:Handlers[string])=>handlers[name]=fn,connect:()=>new Promise(r=>resolve=r),disconnect:async()=>{},rawWsClient:{close:()=>closes++},getConnectionStatus:()=>({state:'connected'})});
 const store=new Store(dir),messages:unknown[]=[],p=new Platforms(store,{onMessage:(...args)=>messages.push(args),channelFactory:o=>{options=o;return channel;}} as DepsOf<typeof Platforms>),a={id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu',enabled:true} as App;
 try{store.data.bindings=[route];const pending=p.start(a);const rejected=assert.rejects(pending,/连接失败/);assert.equal(options.safety!.batch!.text!.delayMs,0);await p.stop(a.id);resolve();await rejected;assert.ok(closes>=2);assert.equal(p.runtime.has(a.id),false);handlers.message({...inbound,senderId:'ou_owner'});assert.deepEqual(messages,[]);}finally{fs.rmSync(dir,{recursive:true});}
});
test('the server changes the defaults of a binding that exists and creates none, lists projects and agent configurations, serves app avatars and reports topics without message ids, reactions, request cards, COT, the card of a worktree or a schedule waiting for confirmation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),agents=[{agent:'claude',pane_id:'w1:p1',agent_status:'idle',agent_session:{value:'s-1'}}];
 fs.mkdirSync(path.join(state,'avatars'),{recursive:true});fs.writeFileSync(path.join(state,'avatars','app-avatar'),png);fs.writeFileSync(path.join(state,'avatars','app-gone'),png);
 const topic={bindingId:'b-old',appId:'x',chatId:'oc_9',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',error:'',messageIds:['om_1'],reactions:[{messageId:'om_1',reactionId:'r_1',stateSeq:1}],cards:[{requestId:1,messageId:'om_card',title:'权限确认 · Bash'}],cot:{cotId:'c1',messageId:'om_cot',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false},proposal:{id:'p1',kind:'add',fields:{mode:'new',cron:'0 9 * * *',timeZone:'UTC',task:'x'},messageId:'om_p',expiresAt:1},createdAt:1};
 const worktree={branch:'feat/x',path:'/src/r-worktrees/feat-x',root:'/src/r'};
 const app={name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false};
 const project={description:'',repos:[],skills:[],workMode:'shared'},projects=[{...project,id:'p-1',name:'work',adopted:{machineId:'m',dir:'~/work'}},{...project,id:'p-2',name:'other'}];
 const agentConfigs=[{id:'c-1',name:'cpu2 · Claude',machineId:'m',kind:'claude',permissionMode:'default'},{id:'c-2',name:'cpu2 · Codex',machineId:'m',kind:'codex'}];
 const group={id:'b-group',name:'群',appId:'x',chatId:'oc_8',chatType:'group',requireMention:false,enabled:true,defaultProjectId:'p-1',defaultAgentConfigId:'c-1',workspaces:{m:'w9'}};
 const direct={id:'b-direct',name:'私聊',appId:'x',chatId:'oc_7',chatType:'p2p',requireMention:false,enabled:true,defaultAgentConfigId:'c-1'};
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({apps:[{...app,id:'app-avatar',avatar:{type:'image/png',updatedAt:5}},{...app,id:'app-plain',appId:'cli_plain'},{...app,id:'app-gone',appId:'cli_gone',avatar:{type:'image/png',updatedAt:5}}],
  projects,agentConfigs,bindings:[{id:'b-old',name:'旧',appId:'x',chatId:'oc_9',chatType:'group',requireMention:true,enabled:true,defaultProjectId:'p-1',defaultAgentConfigId:'c-1'},group,direct],topics:[{...topic,id:'t1',state:'starting'},{...topic,id:'t2',bindingId:'b-keep',state:'ready',worktree:{...worktree,card:{messageId:'om_wt',heading:'话题已结束',text:'x'}}}]}));
 fs.writeFileSync(herdr,`#!/bin/sh\nif [ "$3" = agent ]; then echo '${JSON.stringify({result:{agents}})}'; else echo '{"result":{"panes":[{"pane_id":"w1:p1"}]}}'; fi\n`,{mode:0o700});
 const port=await new Promise<number>(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address() as AddressInfo;s.close(()=>r(port));});});
 const server=spawn(process.execPath,['server.ts'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1',BRIDGE_URL:'http://127.0.0.1:'+port+'/'},stdio:['ignore','pipe','inherit']});let client:ClientProcess|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim();
  const api=async(p:string,body?:object):Promise<Answer>=>{const r=await fetch(`http://127.0.0.1:${port}/api/${p}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  // A first start adds no machine; a new one is offline until its client is in, and connecting it then reports that.
  assert.deepEqual((await api('state')).body.machines,[]);
  const machineId=(await api('machines/save',{name:'fake',session:'default',type:'local',binary:herdr,enabled:true})).body.id;
  const offline={state:'offline',agents:[],panes:[]};assert.deepEqual(await api('machines/connect',{id:machineId}),{status:200,body:offline});
  let [m]=(await api('state')).body.machines;assert.deepEqual(m,{id:machineId,name:'fake',session:'default',enabled:true,hasToken:false,client:{state:'offline'},...offline});
  const s=(await api('state')).body;assert.deepEqual(Object.keys(s).sort(),['agentConfigs','apps','bindings','host','logs','machines','projects','registration','skills','topics','version']);
  assert.deepEqual(s.projects,[{...project,id:'p-1',name:'work',adopted:true},{...project,id:'p-2',name:'other',adopted:false}]);assert.deepEqual(s.agentConfigs,agentConfigs);
  // The console sees a binding without the Herdr workspaces of its topics.
  const {workspaces,...shown}=group;assert.deepEqual(s.bindings.map((b:Binding)=>b.id),['b-old','b-group','b-direct']);assert.deepEqual(s.bindings.slice(1),[shown,direct]);assert.deepEqual(s.apps[0].avatar,{type:'image/png',updatedAt:5});
  const {messageIds,reactions,cards,cot,proposal,...listed}={...topic,id:'t1',state:'failed',error:'Bridge 重启时 Agent 启动未完成'};assert.deepEqual(s.topics[0],listed);for(const key of ['messageIds','reactions','cards','cot','proposal'])assert.equal(key in s.topics[1],false,key);
  assert.deepEqual(s.topics[1].worktree,worktree);
  // The console only changes the defaults of a binding: other fields sent along are ignored, and a refused change keeps the saved bindings as they are.
  assert.deepEqual(await api('bindings/save',{id:'b-group',defaultProjectId:'p-2',defaultAgentConfigId:'c-2',requireMention:true,name:'改名',chatId:'oc_x',chatType:'p2p',workspaces:{}}),{status:200,body:{ok:true}});
  for(const [body,error] of [[{id:'b-group',defaultProjectId:'gone'},'项目不存在'],[{id:'b-group',defaultAgentConfigId:'gone'},'Agent 配置不存在'],[{id:'b-direct',defaultProjectId:'p-1'},'私聊不固定项目'],
   [{id:'b-group',enabled:'no'},'字段无效：enabled'],[{id:'unknown',defaultAgentConfigId:'c-1'},'会话绑定不存在'],[{chatId:'oc_new',name:'新',defaultAgentConfigId:'c-1',defaultProjectId:'p-1'},'会话绑定不存在']] satisfies [object,string][])
   assert.deepEqual(await api('bindings/save',body),{status:400,body:{error}},JSON.stringify(body));
  const changed={...group,defaultProjectId:'p-2',defaultAgentConfigId:'c-2',requireMention:true},{workspaces:_,...changedShown}=changed;
  assert.deepEqual((await api('state')).body.bindings.slice(1),[changedShown,direct]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).bindings.slice(1),[changed,direct]);
  assert.deepEqual((await api('state')).body.logs.filter((l:Log)=>l.kind==='会话绑定').map((l:Log)=>l.message),['群：other · cpu2 · Codex，之后新开的话题生效']);
  assert.equal((await api('bindings/remove',{id:'b-old'})).status,200);assert.deepEqual((await api('state')).body.topics.map((t:ConsoleTopic)=>t.id),['t2']);
  const avatar=async(id:string,headers:Record<string,string>={authorization:'Bearer '+key})=>fetch(`http://127.0.0.1:${port}/api/apps/avatar?id=${encodeURIComponent(id)}`,{headers});
  const image=await avatar('app-avatar');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'private, max-age=300');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await avatar('app-avatar',{})).status,401);for(const id of ['app-plain','unknown','../state.json'])assert.equal((await avatar(id)).status,404,id);
  assert.equal((await api('apps/remove',{id:'app-gone'})).status,200);assert.equal(fs.existsSync(path.join(state,'avatars','app-gone')),false);assert.ok(fs.existsSync(path.join(state,'avatars','app-avatar')));
  assert.equal((await api('apps/remove',{id:'../avatars/app-avatar'})).status,400);assert.ok(fs.existsSync(path.join(state,'avatars','app-avatar')));
  // Once the client of the machine is in, Bridge polls Herdr there through it, with the Herdr of the client's config.
  const {config}=(await api('machines/token',{id:machineId})).body;
  client=bridgeClient(configFile(dir,'client.json',JSON.stringify({...JSON.parse(config),herdr})),{BRIDGE_CLIENT_SOCKET:path.join(dir,'client.sock')});
  m=await until(async()=>{const [x]=(await api('state')).body.machines;return x.state==='connected'&&x;},'Herdr of the machine is polled');
  assert.deepEqual(m.agents,agents);assert.deepEqual(m.panes,[{pane_id:'w1:p1'}]);
  assert.deepEqual(Object.keys(m).sort(),['agents','checkedAt','client','enabled','hasToken','id','name','panes','session','state']);assert.deepEqual([m.client.state,m.hasToken],['online',true]);
  assert.equal((await api('machines/connect',{id:machineId})).body.state,'connected');
  // Disconnected from bridging, the machine is disabled whatever its client does; once its client is gone, it is offline.
  assert.equal((await api('machines/disconnect',{id:machineId})).status,200);assert.deepEqual((({state,agents,panes})=>({state,agents,panes}))((await api('state')).body.machines[0]),{state:'disabled',agents:[],panes:[]});
  assert.equal((await api('machines/connect',{id:machineId})).body.state,'connected');client.kill();await client.exited;
  await until(async()=>(await api('state')).body.machines[0].state==='offline','the machine is offline without its client');
  assert.equal((await api('machines/install',{id:machineId})).status,404);
 }finally{client?.kill();server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true});}
});
test('the server migrates machines of an older state file at start and polls Herdr through the client of each; it hands every refreshed agent list to the topics, which forward new replies, remove the reactions of ended turns and send cards for new requests; the topic\'s agent reaches it with bridge-schedule through the client of its machine, and the same pane on another machine does not; removing the binding turns off remote answers for its topic and removes its attachment directory',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),calls=path.join(dir,'calls'),attachments=path.join(dir,'work','.herdr-bridge','t');
 const agent={agent:'claude',name:'feishu-1',pane_id:'w1:p1',agent_status:'idle',state_change_seq:2,reply_seq:1,request_ids:[1],remote_answers:true};
 fs.mkdirSync(state);
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({machines:[{id:'m',name:'fake',type:'local',session:'default',binary:herdr,enabled:true},{id:'m2',name:'other',type:'local',session:'default',binary:herdr,enabled:true}],
  apps:[{id:'app',name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false}],projects:[{id:'p',name:'work',description:'',repos:[],skills:[],workMode:'shared',adopted:{machineId:'m',dir:'~/work'}}],agentConfigs:[{id:'c',name:'fake · Claude',machineId:'m',kind:'claude',permissionMode:'default'}],
  bindings:[{id:'b',name:'助手',appId:'app',chatId:'oc_1',chatType:'group',requireMention:false,enabled:true,defaultProjectId:'p',defaultAgentConfigId:'c'}],
  topics:[{id:'t',bindingId:'b',appId:'app',chatId:'oc_1',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',state:'ready',error:'',messageIds:['om_1'],
   reactions:[{messageId:'om_1',reactionId:'r_1',stateSeq:1}],attachmentDir:attachments,createdAt:1}]}));
 fs.mkdirSync(attachments,{recursive:true});fs.writeFileSync(path.join(attachments,'om_1-1.png'),'png');
 fs.writeFileSync(herdr,['#!/bin/sh',`echo "$*" >> ${quoted(calls)}`,'case "$3 $4" in',
  ` 'agent list') echo ${quoted(JSON.stringify({result:{type:'agent_list',agents:[agent]}}))};;`,
  ` 'agent replies') echo ${quoted(JSON.stringify({result:{type:'agent_replies',agent,replies:[{seq:1,text:'hi'}]}}))};;`,
  ` 'agent requests') echo ${quoted(JSON.stringify({result:{type:'agent_requests',agent,requests:[bash]}}))};;`,
  ` *) echo '{"result":{"panes":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 const port=await new Promise<number>(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address() as AddressInfo;s.close(()=>r(port));});}),clients:ClientProcess[]=[];
 const server=spawn(process.execPath,['server.ts'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1',BRIDGE_URL:''},stdio:['ignore','pipe','inherit']});
 try{
  await new Promise<void>((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),api=async(p:string):Promise<Json>=>(await fetch(`http://127.0.0.1:${port}/api/${p}`,{headers:{authorization:'Bearer '+key}})).json();
  // The machines lost what only SSH needed, and the log names the Herdr path that the clients have to be told.
  const saved=JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8'));assert.deepEqual(saved.machines,[{id:'m',name:'fake',session:'default',enabled:true},{id:'m2',name:'other',session:'default',enabled:true}]);
  assert.deepEqual(saved.logs.map((l:Log)=>l.message),[`机器改为经客户端连接，去掉了 fake、other 的连接方式、地址、端口和 Herdr 路径；fake 的 Herdr 在 ${herdr}，other 的 Herdr 在 ${herdr}，请写进对应机器客户端配置的 herdr`]);
  // Nothing is polled until the client of a machine is in; each machine has a client with its own token and socket, and the Herdr of its config.
  const post=async(p:string,body:object):Promise<Json>=>(await fetch(`http://127.0.0.1:${port}/api/${p}`,{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify(body)})).json();
  const [own,other]=['m','m2'].map(id=>path.join(dir,id+'.sock'));await later(300);assert.equal(fs.existsSync(calls),false);
  for(const [id,socket] of [['m',own],['m2',other]])clients.push(bridgeClient(configFile(dir,id+'.json',JSON.stringify({...JSON.parse((await post('machines/token',{id})).config),herdr})),{BRIDGE_CLIENT_SOCKET:socket}));
  await until(async()=>(await api('state')).machines.every((m:ConsoleMachine)=>m.client.state==='online'),'both clients are online');
  // The app is not connected, so the forward, the removal and the card fail and are logged; no Feishu request is made.
  let s:Json;for(let i=0;i<100;i++){s=await api('state');if(s.logs.some((l:Log)=>l.kind==='请求卡片'))break;await later(50);}
  assert.equal(s.topics[0].replySeq,1);assert.deepEqual(s.logs.filter((l:Log)=>['回复转发','消息表情','请求卡片'].includes(l.kind)).map((l:Log)=>[l.level,l.message]),[['error','助手：feishu-1 的回复未发出，飞书未连接'],['error','feishu-1：未能取消表情，飞书未连接'],['error','feishu-1：请求 #1 的卡片未发出，飞书未连接']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).topics[0].reactions,[]);
  assert.deepEqual(fs.readFileSync(calls,'utf8').split('\n').filter(l=>l.includes('replies')||l.includes('requests')),['--session default agent replies w1:p1 --after 0','--session default agent requests w1:p1']);
  // The agent of the topic reaches Bridge with bridge-schedule through the client of its machine, on a socket that only its user can open;
  // Bridge takes the machine from the client's connection.
  assert.equal(fs.statSync(own).mode&0o777,0o600);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')&&!k.startsWith('BRIDGE_')));
  const cli=(socket:string,...args:string[])=>spawned(process.execPath,[path.join(bridgeDir,'bin','bridge-schedule.ts'),...args],{...env,BRIDGE_CLIENT_SOCKET:socket,HERDR_PANE_ID:'w1:p1'});
  assert.deepEqual(await cli(own,'list'),{status:0,stdout:'绑定「助手」上没有定时任务。\n',stderr:''});
  // The app is not connected, so the card cannot be posted; another pane is no topic's agent, and neither is the same pane on another machine.
  assert.deepEqual(await cli(own,'add','--cron','0 9 * * *','--mode','new','--task','x'),{status:1,stdout:'',stderr:'bridge-schedule: 确认卡片没有发出去，请稍后重试\n'});
  const notTopic={status:1,stdout:'',stderr:'bridge-schedule: 这个 pane 里的 Agent 不属于任何进行中的飞书话题：bridge-schedule 只能由飞书话题里的 Agent 运行\n'};
  assert.deepEqual(await cli(own,'list','--pane','w1:p9'),notTopic);assert.deepEqual(await cli(other,'list'),notTopic);
  // What the agent reads of a refusal is cleaned like the console's errors.
  assert.deepEqual(await cli(own,'list','--session','token=abc'),{status:1,stdout:'',stderr:'bridge-schedule: 这个 Agent 在 Herdr session token=[已隐藏] 里，Bridge 连接的是这台机器的 session default\n'});
  const removed=await fetch(`http://127.0.0.1:${port}/api/bindings/remove`,{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({id:'b'})});assert.equal(removed.status,200);
  const off=()=>fs.readFileSync(calls,'utf8').split('\n').filter(l=>l.includes('remote-answers'));for(let i=0;i<100&&!off().length;i++)await later(50);
  assert.deepEqual(off(),['--session default pane remote-answers w1:p1 off']);assert.deepEqual((await api('state')).topics,[]);
  for(let i=0;i<100&&fs.existsSync(attachments);i++)await later(50);assert.equal(fs.existsSync(attachments),false);assert.ok(fs.existsSync(path.dirname(attachments)));
 }finally{for(const c of clients)c.kill();server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true});}
});
test('the server refuses to start with a BRIDGE_URL that is not an http(s) origin',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-'));try{
  const server=spawn(process.execPath,['server.ts'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:dir,PORT:'0',BIND:'127.0.0.1',BRIDGE_URL:'http://bridge.example/admin'},stdio:['ignore','pipe','pipe']});
  let err='';server.stderr.on('data',d=>{err+=d;});const timer=setTimeout(()=>server.kill(),5000);const code=await new Promise(r=>server.once('exit',r));clearTimeout(timer);
  assert.notEqual(code,0);assert.match(err,/BRIDGE_URL/);assert.equal(fs.existsSync(path.join(dir,'access-key')),false);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('the server migrates the bindings of an older state file at start, and once the client of their machine is in it turns a project whose directory is the root of a repository with an origin into a repository project',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-'))),state=path.join(dir,'state'),home=path.join(dir,'home'),app=path.join(home,'code','app'),port=await freePort(),origin=`http://127.0.0.1:${port}`;
 fs.mkdirSync(app,{recursive:true});fs.mkdirSync(path.join(home,'code','plain'));git(app,'init','-q');git(app,'remote','add','origin','git@example.com:team/app.git');
 fs.mkdirSync(state);
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({machines:[{id:'m',name:'cpu1',session:'default',enabled:true}],
  bindings:[oldBinding('b1',{machineId:'m',cwd:'~/code/app',kind:'claude'}),oldBinding('b2',{machineId:'m',cwd:'~/code/plain',kind:'codex'})]}));
 const server=await bridgeServer(state,port,{BRIDGE_URL:''});let client:ClientProcess|undefined;
 try{
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),admin={authorization:'Bearer '+key};
  const api=async(p:string,body?:object):Promise<Answer>=>{const r=await fetch(`${origin}/api/${p}`,{method:body?'POST':'GET',headers:admin,body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const shown=async()=>(await api('state')).body;
  let s=await shown();
  assert.deepEqual(s.projects.map((p:Project)=>[p.name,p.workMode,p.adopted]),[['app','shared',true],['plain','shared',true]]);assert.deepEqual(s.agentConfigs.map((c:AgentConfig)=>c.name),['cpu1 · Claude','cpu1 · Codex']);
  assert.deepEqual(s.bindings.map((b:Binding)=>[b.id,b.chatType,b.defaultProjectId===s.projects[b.id==='b1'?0:1].id]),[['b1','group',true],['b2','group',true]]);
  const disk=JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8'));assert.deepEqual(disk.projects[0].adopted,{machineId:'m',dir:'~/code/app'});assert.equal('cwd' in disk.bindings[0],false);
  const {config}=(await api('machines/token',{id:'m'})).body;
  client=bridgeClient(configFile(dir,'client.json',JSON.stringify({...JSON.parse(config),herdr:fakeHerdrBinary(dir)})),{HOME:home,BRIDGE_CLIENT_SOCKET:path.join(dir,'client.sock')});
  s=await until(async()=>{const x=await shown();return x.projects[0].repos.length&&x;},'the project of the repository is converted');
  assert.deepEqual(s.projects.map((p:Project)=>[p.name,p.repos,p.workMode,p.adopted]),[['app',['git@example.com:team/app.git'],'isolated',false],['plain',[],'shared',true]]);
  const saved=JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8'));await until(()=>JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).projects[1].adopted.inspected,'the other directory is marked as asked');
  assert.equal('adopted' in saved.projects[0],false);
 }finally{client?.kill();await server.stop();fs.rmSync(dir,{recursive:true});}
});
test('the server creates, changes and removes projects and agent configurations, refuses what is invalid or still in use, and only reads requests that are JSON objects; a project saved with repositories asks a machine to describe them, which fails harmlessly while no client can',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-'))),state=path.join(dir,'state'),home=path.join(dir,'home'),port=await freePort(),origin=`http://127.0.0.1:${port}`;
 fs.mkdirSync(home);fs.mkdirSync(state);
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({machines:[{id:'m',name:'cpu1',session:'default',enabled:true}]}));
 const server=await bridgeServer(state,port,{BRIDGE_URL:''});let client:ClientProcess|undefined;
 try{
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim();
  const api=async(p:string,body?:object|string):Promise<Answer>=>{const r=await fetch(`${origin}/api/${p}`,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+key},body:typeof body==='string'?body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const shown=async()=>(await api('state')).body;
  for(const bad of ['[]','null','"x"','5','{'])assert.equal((await api('projects/save',bad)).status,400,bad);
  assert.deepEqual(await api('projects/save','[]'),{status:400,body:{error:'请求内容无效'}});
  // Projects: created, changed in place and refused when invalid.
  const created=await api('projects/save',{name:'genvi',description:'增长',repos:['git@code.byted.org:growth/genvi.git'],skills:[],workMode:'isolated'});assert.equal(created.status,200);
  const id=created.body.id as string;assert.match(id,/^[0-9a-f-]{36}$/);
  assert.deepEqual((await shown()).projects,[{id,name:'genvi',description:'增长',repos:['git@code.byted.org:growth/genvi.git'],skills:[],workMode:'isolated',adopted:false}]);
  assert.deepEqual(await api('projects/save',{id,name:'genvi',description:'增长服务',repos:['git@code.byted.org:growth/genvi.git','https://github.com/a/b'],skills:['gone']}),{status:400,body:{error:'skill 不存在：gone'}});
  assert.equal((await api('projects/save',{id,name:'genvi',description:'',repos:'a b'})).status,400);
  assert.deepEqual(await api('projects/save',{id,name:'genvi',description:'增长服务',repos:[],workMode:'shared'}),{status:200,body:{id}});
  assert.deepEqual((await shown()).projects.map((p:Project)=>[p.name,p.description,p.repos,p.workMode]),[['genvi','增长服务',[],'shared']]);
  assert.deepEqual(await api('projects/save',{id:'gone',name:'x'}),{status:400,body:{error:'项目不存在'}});
  // Agent configurations: machine, kind, model, mode and commands; the name defaults, and a name is not taken twice.
  const made=await api('agent-configs/save',{machineId:'m',kind:'claude',model:'sonnet',permissionMode:'auto',allowedCommands:['butler']});assert.equal(made.status,200);
  const config=made.body.id as string;
  assert.deepEqual((await shown()).agentConfigs,[{id:config,name:'cpu1 · Claude · sonnet',machineId:'m',kind:'claude',model:'sonnet',permissionMode:'auto',allowedCommands:['butler']}]);
  for(const [body,error] of [[{machineId:'gone',kind:'claude'},'机器连接不存在'],[{machineId:'m',kind:'bash'},'Agent 类型无效'],[{machineId:'m',kind:'codex',allowedCommands:['butler']},'只有 Claude 可以限制可执行的命令'],
   [{name:'cpu1 · Claude · sonnet',machineId:'m',kind:'codex'},'已有同名的 Agent 配置'],[{id:'gone',machineId:'m',kind:'codex'},'Agent 配置不存在']] satisfies [object,string][])
   assert.deepEqual(await api('agent-configs/save',body),{status:400,body:{error}},JSON.stringify(body));
  assert.deepEqual(await api('agent-configs/save',{id:config,name:'管家',machineId:'m',kind:'claude',allowedCommands:['butler']}),{status:200,body:{id:config}});
  // A machine that has a configuration stays.
  assert.deepEqual(await api('machines/remove',{id:'m'}),{status:400,body:{error:'请先移除该机器上的 Agent 配置'}});
  // Without a client the machine is offline: the project that asks for a description finds none to ask, and nothing is logged.
  assert.deepEqual((await shown()).logs.filter((l:Log)=>l.kind==='项目'),[]);
  const {config:text}=(await api('machines/token',{id:'m'})).body;
  client=bridgeClient(configFile(dir,'client.json',JSON.stringify({...JSON.parse(text),herdr:fakeHerdrBinary(dir)})),{HOME:home,BRIDGE_CLIENT_SOCKET:path.join(dir,'client.sock')});
  await until(async()=>(await shown()).machines[0].client.state==='online','the client is online');
  const other=await api('projects/save',{name:'promoter',repos:['git@code.byted.org:growth/promoter.git']});assert.equal(other.status,200);
  const log=await until(async()=>(await shown()).logs.find((l:Log)=>l.kind==='项目'),'the failed description is logged');
  assert.deepEqual([log.level,log.message],['error','promoter：未能从仓库生成描述，这个操作还没有实现：describeRepos']);assert.equal((await shown()).projects.find((p:Project)=>p.name==='promoter').description,'');
  assert.deepEqual(await api('projects/remove',{id:other.body.id}),{status:200,body:{ok:true}});assert.deepEqual(await api('projects/remove',{id:other.body.id}),{status:400,body:{error:'项目不存在'}});
  assert.deepEqual(await api('agent-configs/remove',{id:config}),{status:200,body:{ok:true}});assert.deepEqual(await api('agent-configs/remove',{id:config}),{status:400,body:{error:'Agent 配置不存在'}});
  assert.deepEqual((await shown()).agentConfigs,[]);
 }finally{client?.kill();await server.stop();fs.rmSync(dir,{recursive:true});}
});
test('the server keeps skills for the console and the access key alone: the state lists their index without their files; it reads a skill with its files, creates and edits its SKILL.md, imports a whole directory past the limit of other requests up to that of a skill, sets whether it is loaded by default and removes it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),port=await freePort(),origin=`http://127.0.0.1:${port}`;
 const server=await bridgeServer(state,port,{BRIDGE_URL:''});
 try{
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),admin={authorization:'Bearer '+key};
  const api=async(p:string,body?:object,headers:Record<string,string>=admin):Promise<Answer>=>{const r=await fetch(`${origin}/api/${p}`,{method:body?'POST':'GET',headers,body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  // Without the login or the access key nothing is read or written, also from the console's own origin.
  assert.deepEqual(await api('skills/read?name=alpha',undefined,{}),{status:401,body:{error:'请先登录'}});
  for(const p of ['skills/save','skills/import','skills/preload','skills/remove'])assert.deepEqual(await api(p,{name:'alpha',text:skillText('alpha','a'),create:true},{origin}),{status:401,body:{error:'请先登录'}},p);
  assert.deepEqual((await api('state')).body.skills,[]);
  const text=skillText('alpha','用来测试','secret-body\n');assert.deepEqual(await api('skills/save',{name:'alpha',text,create:true}),{status:200,body:{ok:true}});
  let s=(await api('state')).body;assert.deepEqual(s.skills.map((x:Skill)=>Object.keys(x).sort()),[['description','digest','name','preload']]);
  const [entry]=s.skills;assert.deepEqual(entry,{name:'alpha',description:'用来测试',preload:false,digest:entry.digest});assert.ok(!JSON.stringify(s).includes('secret-body'));
  assert.deepEqual(await api('skills/read?name=alpha'),{status:200,body:{...entry,files:encoded({'SKILL.md':text})}});
  assert.deepEqual(await api('skills/save',{name:'alpha',text,create:true}),{status:400,body:{error:'skill 已存在：alpha'}});
  // A directory larger than other requests may be; other requests keep their limit.
  const big='x'.repeat(200000);
  assert.deepEqual(await api('skills/import',{name:'alpha',files:encoded({'SKILL.md':text,'ref/big.txt':big})}),{status:200,body:{ok:true}});
  assert.deepEqual(await api('bindings/permission-mode',{id:'x',pad:big}),{status:400,body:{error:'请求内容过大'}});
  assert.deepEqual(await api('skills/import',{name:'alpha',files:encoded({'SKILL.md':text,big:'x'.repeat(skillLimit)})}),{status:400,body:{error:`skill 的文件合计 ${skillLimit+Buffer.byteLength(text)} 字节，超过上限 ${skillLimit} 字节`}});
  // An edit of SKILL.md keeps the other files; a body that arrives in pieces, one of them ending inside a character, is read as the text it is.
  const edited=skillText('alpha','改过的描述',`${'中文'.repeat(40000)}\n`),raw=Buffer.from(JSON.stringify({name:'alpha',text:edited})),cut=raw.indexOf(Buffer.from('中'))+1;
  const saved=await new Promise((resolve,reject)=>{
   const req=http.request(`${origin}/api/skills/save`,{method:'POST',headers:{...admin,'content-length':raw.length}},res=>{let b='';res.on('data',d=>{b+=d;});res.on('end',()=>resolve([res.statusCode,JSON.parse(b)]));});
   req.on('error',reject);req.write(raw.subarray(0,cut));setTimeout(()=>req.end(raw.subarray(cut)),50);
  });
  assert.deepEqual(saved,[200,{ok:true}]);assert.deepEqual((await api('skills/read?name=alpha')).body.files,encoded({'SKILL.md':edited,'ref/big.txt':big}));
  assert.deepEqual(await api('skills/preload',{name:'alpha',preload:true}),{status:200,body:{ok:true}});
  s=(await api('state')).body;assert.deepEqual(s.skills.map((x:Skill)=>[x.name,x.description,x.preload]),[['alpha','改过的描述',true]]);
  assert.deepEqual(await api('skills/preload',{name:'alpha',preload:false}),{status:200,body:{ok:true}});
  s=(await api('state')).body;assert.deepEqual(s.skills.map((x:Skill)=>[x.name,x.preload]),[['alpha',false]]);
  assert.deepEqual(s.logs.filter((l:Log)=>l.kind==='skill').map((l:Log)=>l.message),['新建了 skill alpha','导入了 skill alpha','修改了 skill alpha 的 SKILL.md','skill alpha 已设为默认加载，之后新开的话题生效','skill alpha 已设为按需读取，之后新开的话题生效']);
  assert.deepEqual(await api('skills/remove',{name:'alpha'}),{status:200,body:{ok:true}});assert.deepEqual((await api('state')).body.skills,[]);
  assert.deepEqual(await api('skills/read?name=alpha'),{status:400,body:{error:'skill 不存在：alpha'}});
 }finally{await server.stop();fs.rmSync(dir,{recursive:true});}
});
test('bridge-skill with a real Bridge and the real client of a machine: the access key imports a skill directory, sets it to load by default, exports it as it was imported and removes it; agents on the machine list, search and read it through the client, which puts its other files into the store of the machine; the socket of the client takes no write whatever it sends, and the management commands need the right key',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skill-cli-'))),state=path.join(dir,'state'),home=path.join(dir,'home'),socket=path.join(dir,'client.sock'),port=await freePort(),origin=`http://127.0.0.1:${port}`;
 fs.mkdirSync(home);const server=await bridgeServer(state,port,{BRIDGE_URL:''});let client:ClientProcess|undefined;
 try{
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),admin={BRIDGE_URL:origin+'/',BRIDGE_ACCESS_KEY:key};
  const api=async(p:string,body?:object):Promise<Json>=>(await fetch(`${origin}/api/${p}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key},body:body&&JSON.stringify(body)})).json();
  const {id}=await api('machines/save',{name:'cpu2',session:'default',enabled:true}),{config}=await api('machines/token',{id});
  client=bridgeClient(configFile(dir,'client.json',config),{HOME:home,BRIDGE_CLIENT_SOCKET:socket});
  await until(async()=>fs.existsSync(socket)&&(await api('state')).machines[0].client.state==='online','the client is online');
  const cli=(env:Record<string,string>,...args:string[])=>spawned(process.execPath,[path.join(bridgeDir,'bin','bridge-skill.ts'),...args],clientEnv({BRIDGE_CLIENT_SOCKET:socket,...env}));
  // A skill directory with a file in a subdirectory.
  const src=path.join(dir,'src','deploy-notes'),text=skillText('deploy-notes','部署前后要检查的事项。','先运行 scripts/check.sh。\n');
  fs.mkdirSync(path.join(src,'scripts'),{recursive:true});fs.writeFileSync(path.join(src,'SKILL.md'),text);fs.writeFileSync(path.join(src,'scripts','check.sh'),'echo ok\n');
  assert.deepEqual(await cli(admin,'import',src),{status:0,stdout:'已导入 skill deploy-notes，共 2 个文件。\n',stderr:''});
  assert.deepEqual(await cli(admin,'preload','deploy-notes','on'),{status:0,stdout:'已把 skill deploy-notes 设为默认加载，之后新开的话题生效。\n',stderr:''});
  // An agent of the machine reads it through the client, without the key.
  const listed='deploy-notes · 默认加载\n  部署前后要检查的事项。\n';
  assert.deepEqual(await cli({},'list'),{status:0,stdout:'平台上有 1 个 skill：\n'+listed,stderr:''});assert.deepEqual(await cli({},'search','CHECK.SH'),{status:0,stdout:'匹配「CHECK.SH」的 skill 有 1 个：\n'+listed,stderr:''});
  const kept=path.join(home,'.local/share/herdr-bridge/skills/deploy-notes');
  assert.deepEqual(await cli({},'read','deploy-notes'),{status:0,stdout:`deploy-notes 带有其他文件，在这台机器的 ${kept} 里：\n  scripts/check.sh\nSKILL.md 里提到的相对路径都相对这个目录。\n\n${text}`,stderr:''});
  assert.equal(fs.readFileSync(path.join(kept,'scripts','check.sh'),'utf8'),'echo ok\n');
  // The socket of the client takes reads only: the control plane answers no write that comes that way, whatever it carries.
  const raw=(p:string,body:object)=>new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,method:'POST',path:p,agent:false},res=>{let b='';res.on('data',d=>{b+=d;});res.on('end',()=>resolve([res.statusCode,JSON.parse(b)]));});req.on('error',reject);req.end(JSON.stringify(body));});
  for(const op of ['import','save','preload','remove'])assert.deepEqual(await raw('/skills/'+op,{name:'deploy-notes',files:{},text:'x',preload:false,key}),[400,{error:'未知的操作：'+op}],op);
  assert.deepEqual((await api('state')).skills.map((s:Skill)=>[s.name,s.preload]),[['deploy-notes',true]]);
  // Export writes the skill as it was imported, into a directory of its name, and refuses a place that exists.
  const out=path.join(dir,'out');fs.mkdirSync(out);
  assert.deepEqual(await cli(admin,'export','deploy-notes',out),{status:0,stdout:`已导出到 ${path.join(out,'deploy-notes')}。\n`,stderr:''});assert.deepEqual(tree(path.join(out,'deploy-notes')),tree(src));
  assert.deepEqual(await cli(admin,'export','deploy-notes',out),{status:1,stdout:'',stderr:`bridge-skill: ${path.join(out,'deploy-notes')} 已经存在\n`});
  // A wrong key, a directory with a link, a path that is no directory, and a skill that the platform refuses.
  assert.deepEqual(await cli({...admin,BRIDGE_ACCESS_KEY:'wrong'},'remove','deploy-notes'),{status:1,stdout:'',stderr:'bridge-skill: 请先登录\n'});
  fs.symlinkSync(path.join(src,'SKILL.md'),path.join(src,'scripts','link'));assert.deepEqual(await cli(admin,'import',src),{status:1,stdout:'',stderr:'bridge-skill: 只能导入普通文件和目录：scripts/link\n'});fs.rmSync(path.join(src,'scripts','link'));
  assert.deepEqual(await cli(admin,'import',path.join(dir,'none')),{status:1,stdout:'',stderr:`bridge-skill: 不是目录：${path.join(dir,'none')}\n`});
  const bad=path.join(dir,'src','Bad');fs.mkdirSync(bad);fs.writeFileSync(path.join(bad,'SKILL.md'),skillText('Bad','x'));assert.match((await cli(admin,'import',bad)).stderr,/^bridge-skill: skill 名称无效：Bad，/);
  assert.deepEqual(await cli(admin,'preload','deploy-notes','off'),{status:0,stdout:'已把 skill deploy-notes 设为按需读取，之后新开的话题生效。\n',stderr:''});
  assert.deepEqual(await cli(admin,'remove','deploy-notes'),{status:0,stdout:'已删除 skill deploy-notes。\n',stderr:''});
  assert.deepEqual(await cli({},'read','deploy-notes'),{status:1,stdout:'',stderr:'bridge-skill: skill 不存在：deploy-notes\n'});
 }finally{client?.kill();await server.stop();fs.rmSync(dir,{recursive:true});}
});

// The client of a machine and its connection to the control plane (link.ts, clients.ts, client.ts).
const bridgeDir=path.dirname(fileURLToPath(import.meta.url));
// A port that nothing listens on (the address of a server listening on TCP).
const freePort=()=>new Promise<number>(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address() as AddressInfo;s.close(()=>r(port));});});
// Polls check every 50 ms until it gives something truthy and resolves to that; fails naming what after ms.
async function until<T>(check:()=>T|Promise<T>,what:string,ms=8000):Promise<T>{for(const end=Date.now()+ms;Date.now()<end;await later(50)){const v=await check();if(v)return v;}assert.fail('timed out waiting until '+what);}
// The code and the reason with which ws closes.
const closeOf=(ws:WebSocket)=>new Promise<[number,string]>(r=>ws.addEventListener('close',e=>r([e.code,e.reason])));
// What the test of link makes up: methods of any params and results, which it calls with or without params.
type Made={[method:string]:{params:any,result:Json}};
type Caller={call:(method:string,params?:object,options?:{timeoutMs?:number})=>Promise<Json>};
// A WebSocket of Node to url with the token, once open; one that the other side refuses before the upgrade rejects.
const dial=(url:string,token?:string)=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(url,{headers:token?{authorization:'Bearer '+token}:{}});ws.onopen=()=>resolve(ws);ws.onerror=()=>reject(Error('not upgraded'));});
// The frames that arrive on ws, parsed; wait(check) resolves to the first one that check accepts.
type Frames=Json[]&{wait:(check:(frame:Json)=>unknown)=>Promise<Json>};
function framesOf(ws:{addEventListener(type:'message',listener:(e:{data:Json})=>void):void}):Frames{const frames:Json[]=[];ws.addEventListener('message',e=>frames.push(JSON.parse(e.data)));return Object.assign(frames,{wait:(check:(frame:Json)=>unknown)=>until(()=>frames.find(check),'a frame')});}
const hello=(ws:WebSocket,params:object)=>ws.send(JSON.stringify({id:1,method:'hello',params}));
// A config file of the client with mode.
const configFile=(dir:string,name:string,text:string,mode=0o600)=>{const file=path.join(dir,name);fs.writeFileSync(file,text,{mode});fs.chmodSync(file,mode);return file;};
// The environment of a client process: none of the test's Bridge, Herdr or proxy variables, then every proxy variable pointing at a closed port.
const clientEnv=(env:Record<string,string>)=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(BRIDGE_|HERDR_)|proxy$/i.test(k))),...Object.fromEntries(['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','all_proxy'].map(k=>[k,'http://127.0.0.1:9'])),...env});
// A client process (bin/bridge-client.ts) with the config file given and env, which names a socket of its own with BRIDGE_CLIENT_SOCKET
// or HOME: the default one may belong to the client of this machine. log collects its stderr and exited resolves to its exit code.
function bridgeClient(config:string,env:Record<string,string>){
 assert.ok(env?.BRIDGE_CLIENT_SOCKET||env?.HOME,'a client of a test needs a socket of its own');
 const p=Object.assign(spawn(process.execPath,[path.join(bridgeDir,'bin','bridge-client.ts')],{env:clientEnv({BRIDGE_CLIENT_CONFIG:config,...env}),stdio:['ignore','ignore','pipe']}),{log:''});
 p.stderr.on('data',d=>{p.log+=d;});return Object.assign(p,{exited:new Promise<number|null>(r=>p.once('exit',code=>r(code)))});
}
type ClientProcess=ReturnType<typeof bridgeClient>;
// Bridge (server.ts) on port with the state directory state, once it listens; stop() ends it.
async function bridgeServer(state:string,port:number,env:Record<string,string>={}){
 const server=spawn(process.execPath,['server.ts'],{cwd:bridgeDir,env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1',...env},stdio:['ignore','pipe','inherit']});
 await new Promise<void>((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
 return Object.assign(server,{stop:async()=>{server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));}});
}
// Clients alone on an HTTP server of this process, with the machine cpu2 of the Herdr session default and its token.
type ClientsFixture=Awaited<ReturnType<typeof clientsFixture>>;
async function clientsFixture(options?:DepsOf<typeof Clients>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-clients-')),store=new Store(dir);store.data.machines.push({id:'m',name:'cpu2',session:'default',enabled:true});
 const clients=new Clients(store,options),server=http.createServer((req,res)=>res.end()).on('upgrade',(...args)=>clients.upgrade(...args));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const token=clients.issue(store.data.machines[0]);
 return {store,clients,token,url:`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/client`,close(){clients.close();server.close();fs.rmSync(dir,{recursive:true});}};
}
test('a link carries requests both ways on one WebSocket: answers find their request by id in any order, errors keep their code, a method outside the set is refused, frames that are not JSON are ignored, and a request fails after its timeout or once the connection closes',async()=>{
 const wss=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>wss.once('listening',r));
 const accepted=new Promise<WsSocket>(r=>wss.once('connection',r)),client=await dial(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`),server=await accepted;
 try{
  let release!:(value?:unknown)=>void;const gate=new Promise(r=>{release=r;});
  // The test makes up the methods of both sides, and calls them with or without params, also ones that the other side lacks.
  const control=link<Made,Made>(server,{echo:params=>({echo:params})}) as Caller;
  const machine=link<Made,Made>(client,{wait:async()=>{await gate;return {waited:true};},double:({n})=>({n:n*2}),fail:()=>{throw Object.assign(Error('不行'),{code:'nope'});},hang:()=>new Promise(()=>{})}) as Caller;
  // The first request is answered after the second; each answer still goes to its own request.
  const first=control.call('wait'),second=control.call('double',{n:2});
  assert.deepEqual(await second,{n:4});release();assert.deepEqual(await first,{waited:true});
  // Frames that are not JSON, and answers to no request, are ignored.
  client.send('not json');server.send('{"id":99,"result":1}');
  // Each side numbers its own requests: the client's first one has the id of the control plane's first one.
  assert.deepEqual(await machine.call('echo',{x:1}),{echo:{x:1}});
  await assert.rejects(control.call('fail'),(e:Thrown)=>e.message==='不行'&&e.code==='nope');
  for(const method of ['run','constructor','__proto__','toString'])await assert.rejects(control.call(method,{argv:['rm','-rf','/']}),(e:Thrown)=>e.code==='unknown_method'&&e.message==='不支持的操作：'+method,method);
  await assert.rejects(control.call('hang',{},{timeoutMs:50}),(e:Thrown)=>e.timedOut===true&&e.message==='请求超时：hang');
  const pending=control.call('hang');client.close();await assert.rejects(pending,/连接已断开/);
  await assert.rejects(control.call('double',{n:1}),/连接已断开/);await assert.rejects(machine.call('echo'),/连接已断开/);
 }finally{client.close();wss.close();}
});
test('the control plane takes a client at /api/client only from an allowed Host, with its machine\'s token and after a hello with its protocol; it refuses with a close code and a reason, and a machine keeps the reason of a refused version, logged once, until a client gets in',async()=>{
 let hostAllowed=false;const f=await clientsFixture({allowedHost:()=>hostAllowed,helloMs:200});
 try{
  assert.deepEqual(await closeOf(await dial(f.url,f.token)),[closeCodes.host,'不允许的 Host']);hostAllowed=true;
  await assert.rejects(dial(f.url.replace('/api/client','/api/other'),f.token),/not upgraded/);
  for(const token of [undefined,'wrong',f.token+'x'])assert.deepEqual(await closeOf(await dial(f.url,token)),[closeCodes.token,'token 无效'],token);
  assert.deepEqual(await closeOf(await dial(f.url,f.token)),[closeCodes.hello,'没有及时完成握手']);
  const refused=(p:string|number)=>`版本不一致：控制面协议 ${protocol}，客户端协议 ${p}`;
  for(const p of ['1'.repeat(300),protocol+1,protocol+1]){const ws=await dial(f.url,f.token),closed=closeOf(ws);hello(ws,{protocol:p,host:'old'});assert.deepEqual(await closed,[closeCodes.version,refused(typeof p==='number'?p:'未知')]);}
  assert.deepEqual(f.clients.status('m'),{state:'refused',error:refused(protocol+1)});assert.deepEqual(f.clients.status('other'),{state:'offline'});
  assert.deepEqual(f.store.data.logs.filter(l=>l.level==='error').map(l=>l.message),[`cpu2：客户端被拒绝，${refused('未知')}`,`cpu2：客户端被拒绝，${refused(protocol+1)}`]);
  const ws=await dial(f.url,f.token),frames=framesOf(ws);hello(ws,{protocol,host:'cpu2-host'});
  assert.deepEqual(await frames.wait(x=>x.id===1),{id:1,result:{machine:{id:'m',name:'cpu2'},heartbeatMs:15000}});
  // Online, which the line checks.
  const s=f.clients.status('m') as Extract<ClientStatus,{state:'online'}>;assert.deepEqual([s.state,s.host],['online','cpu2-host']);assert.ok(Math.abs(s.since-Date.now())<5000);
  ws.close();await until(()=>f.clients.status('m').state==='offline','the client is offline');
 }finally{f.close();}
});
test('a peer that sends a frame no client may send, with or without the right token, or drops a request for another path, does not bring the control plane down',async()=>{
 const f=await clientsFixture(),port=Number(new URL(f.url).port);
 const upgrade=(p:string,token:string)=>[`GET ${p} HTTP/1.1`,'Host: 127.0.0.1','Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version: 13','Authorization: Bearer '+token,'',''].join('\r\n');
 try{
  // A text frame without a mask, which a client must never send.
  for(const token of [f.token,'wrong']){
   const s=net.connect(port,'127.0.0.1'),closed=new Promise(r=>s.on('close',r));let got='';s.on('data',d=>{got+=d.toString('latin1');});s.on('error',()=>{});
   s.write(upgrade('/api/client',token));await until(()=>got.startsWith('HTTP/1.1 101'),'the upgrade');s.write(Buffer.from([0x81,0x02,0x68,0x69]));await closed;
  }
  const s=net.connect(port,'127.0.0.1');s.on('error',()=>{});s.write(upgrade('/api/other',f.token));s.resetAndDestroy();await later(100);
  const ws=await dial(f.url,f.token);await link<ClientApi,ControlApi>(ws,{ping:()=>({})}).call('hello',{protocol,host:'h'});assert.equal(f.clients.status('m').state,'online');
  ws.close();await until(()=>f.clients.status('m').state==='offline','the client is offline');
 }finally{f.close();}
});
test('the control plane pings each client every heartbeat and drops one that does not answer within it; a machine is offline once its client is gone',async()=>{
 const f=await clientsFixture({heartbeatMs:100});
 try{
  const answering=await dial(f.url,f.token),result=await link<ClientApi,ControlApi>(answering,{ping:()=>({})}).call('hello',{protocol,host:'a'});
  assert.equal(result.heartbeatMs,100);await later(450);assert.equal(f.clients.status('m').state,'online');
  answering.close();await until(()=>f.clients.status('m').state==='offline','the closed client is offline');
  const mute=await dial(f.url,f.token),frames=framesOf(mute),closed=closeOf(mute);hello(mute,{protocol,host:'b'});
  await frames.wait(x=>x.method==='ping');assert.equal(f.clients.status('m').state,'online');
  assert.equal((await closed)[0],1006);await until(()=>f.clients.status('m').state==='offline','the mute client is offline');
  assert.deepEqual(f.store.data.logs.map(l=>l.message),['cpu2：生成了新的客户端 token，旧 token 已失效','cpu2 的客户端已连接（a）','cpu2 的客户端已断开','cpu2 的客户端已连接（b）','cpu2 的客户端已断开']);
 }finally{f.close();}
});
test('the client dials the URL of its config with its token, says hello with its protocol and host, answers pings and refuses other methods; it reconnects after the control plane drops it or goes silent, logs why, ignores proxy variables and exits once another client of its machine replaces it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-client-')),wss=new WebSocketServer({port:0,host:'127.0.0.1'}),connections:{ws:WsSocket,req:http.IncomingMessage,frames:Frames}[]=[];await new Promise(r=>wss.once('listening',r));
 wss.on('connection',(ws,req)=>connections.push({ws,req,frames:framesOf(ws)}));
 const client=bridgeClient(configFile(dir,'client.json',configText(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`,'machine-token')),{BRIDGE_CLIENT_SOCKET:path.join(dir,'client.sock')});
 const connection=(n:number)=>until(()=>connections[n],'connection '+(n+1)),welcome=(c:typeof connections[number],h:Json,heartbeatMs:number)=>c.ws.send(JSON.stringify({id:h.id,result:{machine:{id:'m',name:'cpu2'},heartbeatMs}}));
 try{
  let c=await connection(0);assert.equal(c.req.url,'/api/client');assert.equal(c.req.headers.authorization,'Bearer machine-token');
  let h=await c.frames.wait(x=>x.method==='hello');assert.deepEqual(h.params,{protocol,host:os.hostname()});welcome(c,h,60000);
  await until(()=>client.log.includes('已连接控制面，机器「cpu2」'),'the client says it is connected');
  c.ws.send(JSON.stringify({id:1,method:'ping',params:{}}));c.ws.send(JSON.stringify({id:2,method:'exec',params:{argv:['id']}}));
  assert.deepEqual(await c.frames.wait(x=>x.id===1&&!x.method),{id:1,result:{}});
  assert.deepEqual(await c.frames.wait(x=>x.id===2&&!x.method),{id:2,error:{message:'不支持的操作：exec',code:'unknown_method'}});
  // Dropped with a reason, it dials again a second later.
  c.ws.close(closeCodes.token,'token 已重新生成');
  c=await connection(1);h=await c.frames.wait(x=>x.method==='hello');welcome(c,h,100);
  // Nothing from the control plane for three heartbeats: it gives up on the connection and dials again.
  c=await connection(2);h=await c.frames.wait(x=>x.method==='hello');welcome(c,h,60000);
  assert.match(client.log,/与控制面的连接断开（4001：token 已重新生成），1 秒后重连/);assert.match(client.log,/控制面 0\.3 秒没有消息，1 秒后重连/);
  c.ws.close(closeCodes.replaced,'这台机器的另一个客户端已连接');
  assert.equal(await client.exited,0);assert.match(client.log,/与控制面的连接断开（4004：这台机器的另一个客户端已连接），不再重连/);assert.equal(connections.length,3);
 }finally{client.kill();wss.close();fs.rmSync(dir,{recursive:true});}
});
test('the client does not start without a config file it can use or with Node\'s proxy support turned on; the config the console hands out points at the client endpoint of the control plane',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-client-'));
 try{
  assert.deepEqual(JSON.parse(configText('http://bridge.example:8080','t')),{url:'ws://bridge.example:8080/api/client',token:'t'});
  assert.deepEqual(JSON.parse(configText('https://bridge.example','t')),{url:'wss://bridge.example/api/client',token:'t'});
  const run=(env:Record<string,string>)=>{const r=spawnSync(process.execPath,[path.join(bridgeDir,'bin','bridge-client.ts')],{env:clientEnv(env),encoding:'utf8',timeout:5000});return [r.status,r.stderr] as const;};
  const good=configFile(dir,'good.json',configText('http://127.0.0.1:9','t'));
  for(const [env,error] of [
   [{BRIDGE_CLIENT_CONFIG:path.join(dir,'none.json')},`读不到配置文件 ${path.join(dir,'none.json')}`],
   [{XDG_CONFIG_HOME:dir},`读不到配置文件 ${path.join(dir,'herdr-bridge','client.json')}`],
   [{BRIDGE_CLIENT_CONFIG:configFile(dir,'open.json',configText('http://127.0.0.1:9','t'),0o644)},'权限是 644，其他用户也能读到 token，改成 600'],
   [{BRIDGE_CLIENT_CONFIG:configFile(dir,'text.json','url=ws://x')},'不是有效的 JSON'],
   [{BRIDGE_CLIENT_CONFIG:configFile(dir,'http.json',JSON.stringify({url:'http://127.0.0.1:9/api/client',token:'t'}))},'url 必须是 ws:// 或 wss:// 开头的控制面地址'],
   [{BRIDGE_CLIENT_CONFIG:configFile(dir,'empty.json',JSON.stringify({url:'ws://127.0.0.1:9/api/client',token:''}))},'缺少 token'],
   [{BRIDGE_CLIENT_CONFIG:good,NODE_USE_ENV_PROXY:'1'},'NODE_USE_ENV_PROXY'],
   [{BRIDGE_CLIENT_CONFIG:good,NODE_OPTIONS:'--use-env-proxy'},'--use-env-proxy'],
  ] satisfies [Record<string,string>,string][]){const [status,stderr]=run(env);assert.equal(status,1,stderr);assert.ok(stderr.startsWith('bridge-client: ')&&stderr.includes(error),stderr);}
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('the client, bridge-schedule and bridge-skill run on Node alone: bin/bridge-client.ts, bin/bridge-schedule.ts, bin/bridge-skill.ts and everything they import load only Node\'s built-in modules and each other, never a package',()=>{
 // Node erases the type-only imports of a .ts file, which load nothing.
 const imports=(bin:string)=>{
  const seen=new Set<string>(),visit=(file:string)=>{if(seen.has(file))return;seen.add(file);
   for(const [,spec] of fs.readFileSync(file,'utf8').matchAll(/(?:^import\b(?!\s+type\b)[^'"]*?|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm)){if(spec.startsWith('node:'))continue;assert.ok(/^\.\.?\//.test(spec),`${path.relative(bridgeDir,file)} imports ${spec}`);visit(path.resolve(path.dirname(file),spec));}};
  visit(path.join(bridgeDir,'bin',bin));return [...seen].map(f=>path.relative(bridgeDir,f)).sort();
 };
 assert.deepEqual(imports('bridge-client.ts'),['bin/bridge-client.ts','client.ts','link.ts','machine.ts']);
 assert.deepEqual(imports('bridge-schedule.ts'),['bin/bridge-schedule.ts','client.ts','cron.ts','link.ts','machine.ts','request-cards.ts','schedule-command.ts']);
 assert.deepEqual(imports('bridge-skill.ts'),['bin/bridge-skill.ts','client.ts','link.ts','machine.ts','skill-command.ts']);
});
// Stops the client processes started and closes the clients fixture f once none of its machines is online any more.
async function stopClients(f:ClientsFixture,started:ClientProcess[]){
 for(const c of started)c.kill();await Promise.all(started.map(c=>c.exited));
 await until(()=>f.store.data.machines.every(m=>f.clients.status(m.id).state!=='online'),'the clients are gone');f.close();
}
// What bridge-schedule prints while the client of its machine is not connected to the control plane.
const notConnected='bridge-schedule: 本机的 Bridge 客户端没有连上控制面：请稍后重试，一直这样时请主人查看这台机器上客户端的日志\n';
test('the client answers bridge-schedule and bridge-skill on its socket, 0600 in a directory 0700 that it creates and in place of a socket left by an earlier client: POST /schedules/<op> and /skills/<op> with a JSON body go to the control plane as the requests schedules and skills {op, body} with 60 seconds to answer; it answers 200 with the result, 400 with what the control plane refused or when it did not answer in time, 503 while the client is not connected, and 404 for anything else',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-client-')),socket=path.join(dir,'state','herdr-bridge','client.sock'),stale=path.join(dir,'stale.sock'),calls:unknown[][]=[];let peer:Peer<ControlApi>|null=null,answer:()=>unknown;
 const server=await serve(socket,()=>peer);
 const raw=(method:string,p:string,body:string)=>new Promise<[number|undefined,Json]>((resolve,reject)=>{const req=http.request({socketPath:socket,method,path:p,agent:false},res=>{let s='';res.on('data',d=>{s+=d;});res.on('end',()=>resolve([res.statusCode,JSON.parse(s)]));});req.on('error',reject);req.end(body);});
 try{
  assert.equal(fs.statSync(socket).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(socket)).mode&0o777,0o700);
  // A socket that an earlier client left when it ended.
  execFileSync(process.execPath,['-e',`require('node:net').createServer().listen(${JSON.stringify(stale)},()=>process.exit(0))`]);assert.ok(fs.existsSync(stale));
  const replaced=await serve(stale,()=>null);assert.deepEqual(await schedule({socket:stale},['list']),{code:1,out:'',err:notConnected});replaced.close();
  assert.deepEqual(await schedule({socket},['list']),{code:1,out:'',err:notConnected});assert.equal((await raw('POST','/schedules/list','{}'))[0],503);
  peer={call:loose<Peer<ControlApi>['call']>(async(...args)=>{calls.push(args);return answer();})};answer=()=>({binding:{id:'b',name:'助手'},topicId:'t',schedules:[]});
  assert.deepEqual(await schedule({socket},['list','--json'],{env:{HERDR_SESSION:'work'}}),{code:0,out:JSON.stringify(answer(),null,2)+'\n',err:''});
  assert.deepEqual(calls,[['schedules',{op:'list',body:{pane:'w1:p1',session:'work'}},{timeoutMs:60000}]]);
  assert.deepEqual(await raw('POST','/skills/read','{"name":"alpha"}'),[200,answer()]);assert.deepEqual(calls.at(-1),['skills',{op:'read',body:{name:'alpha'}},{timeoutMs:60000}]);
  answer=()=>{throw Object.assign(Error('定时任务不存在'),{code:'x'});};assert.deepEqual(await schedule({socket},['pause','x']),{code:1,out:'',err:'bridge-schedule: 定时任务不存在\n'});
  answer=()=>{throw Object.assign(Error('请求超时：schedules'),{timedOut:true});};assert.deepEqual(await schedule({socket},['list']),{code:1,out:'',err:'bridge-schedule: 控制面 60 秒内没有回答\n'});
  for(const [method,p] of [['GET','/schedules/list'],['POST','/schedules/'],['POST','/schedules/LIST'],['POST','/run'],['POST','/schedules/list/x'],['GET','/skills/list'],['POST','/skills/'],['POST','/skill/list'],['POST','/skills/list/x']])
   assert.deepEqual(await raw(method,p,'{}'),[404,{error:'接口不存在'}],method+' '+p);
  assert.deepEqual(await raw('POST','/schedules/list','not json'),[400,{error:'请求内容不是 JSON'}]);assert.deepEqual(await raw('POST','/schedules/list','x'.repeat(100001)),[400,{error:'请求内容过大'}]);
  assert.equal(calls.length,4);
  // A body that arrives in pieces, one of them ending inside a character, is read as the text it is.
  answer=()=>({});const text=Buffer.from(JSON.stringify({task:'定时任务'}));
  await new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,method:'POST',path:'/schedules/add',agent:false},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.write(text.subarray(0,10));setTimeout(()=>req.end(text.subarray(10)),50);});
  assert.deepEqual(calls.at(-1)![1],{op:'add',body:{task:'定时任务'}});
 }finally{server.close();fs.rmSync(dir,{recursive:true});}
});
test('a client passes bridge-schedule on over its connection, and the control plane answers it for the machine of that connection: the clients of two machines each reach their own, what the control plane refuses comes back as it is, a connection must say hello first, and a client that is not connected says so',async()=>{
 const seen:unknown[]=[],f=await clientsFixture({methods:{schedules:(m,params)=>{seen.push([m.id,params]);if((params.body as {id?:string}).id==='gone')throw Error('定时任务不存在');return {binding:{id:'b',name:m.name},topicId:'t',schedules:[]};}}});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-client-')),started:ClientProcess[]=[];
 const start=(name:string,token:string)=>{const socket=path.join(dir,name+'.sock');started.push(bridgeClient(configFile(dir,name+'.json',JSON.stringify({url:f.url,token})),{BRIDGE_CLIENT_SOCKET:socket}));return {socket};};
 try{
  const raw=await dial(f.url,f.token);await assert.rejects(link<ClientApi,ControlApi>(raw,{}).call('schedules',{op:'list',body:{}}),/客户端还没有完成握手/);raw.close();
  const m2={id:'m2',name:'cpu1',session:'default',enabled:true};f.store.data.machines.push(m2);
  const a=start('a',f.token),b=start('b',f.clients.issue(m2)),wrong=start('wrong','not-the-token');
  await until(()=>['m','m2'].every(id=>f.clients.status(id).state==='online')&&fs.existsSync(wrong.socket),'both clients are online and the third has its socket');
  const listed=(name:string)=>({code:0,out:JSON.stringify({binding:{id:'b',name},topicId:'t',schedules:[]},null,2)+'\n',err:''});
  assert.deepEqual(await schedule(a,['list','--json'],{env:{HERDR_SESSION:'work'}}),listed('cpu2'));assert.deepEqual(await schedule(b,['list','--json']),listed('cpu1'));
  assert.deepEqual(await schedule(b,['pause','gone']),{code:1,out:'',err:'bridge-schedule: 定时任务不存在\n'});
  assert.deepEqual(await schedule(wrong,['list']),{code:1,out:'',err:notConnected});
  assert.deepEqual(seen,[['m',{op:'list',body:{pane:'w1:p1',session:'work'}}],['m2',{op:'list',body:{pane:'w1:p1'}}],['m2',{op:'pause',body:{pane:'w1:p1',id:'gone'}}]]);
 }finally{await stopClients(f,started);fs.rmSync(dir,{recursive:true});}
});
test('without BRIDGE_CLIENT_SOCKET the client and bridge-schedule find the socket from the home directory alone, so that the service and the panes of Herdr agree whatever XDG_RUNTIME_DIR or XDG_STATE_HOME each has; a client that cannot open its socket logs why and stays connected',async()=>{
 const f=await clientsFixture({methods:{schedules:m=>({binding:{id:'b',name:m.name},topicId:'t',schedules:[]})}}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-home-')),started=[];
 const config=configFile(dir,'client.json',JSON.stringify({url:f.url,token:f.token})),socket=path.join(dir,'.local','state','herdr-bridge','client.sock');
 try{
  const first=bridgeClient(config,{HOME:dir,XDG_RUNTIME_DIR:path.join(dir,'run-service'),XDG_STATE_HOME:path.join(dir,'state-service')});started.push(first);
  await until(()=>f.clients.status('m').state==='online'&&fs.existsSync(socket),'the client is online with its socket');
  const r=await spawned(process.execPath,[path.join(bridgeDir,'bin','bridge-schedule.ts'),'list'],clientEnv({HOME:dir,XDG_RUNTIME_DIR:path.join(dir,'run-pane'),XDG_STATE_HOME:path.join(dir,'state-pane'),HERDR_PANE_ID:'w1:p1'}));
  assert.deepEqual(r,{status:0,stdout:'绑定「cpu2」上没有定时任务。\n',stderr:''});
  first.kill();await first.exited;await until(()=>f.clients.status('m').state==='offline','the first client is gone');
  const long=path.join(dir,'s'.repeat(120),'client.sock'),second=bridgeClient(config,{BRIDGE_CLIENT_SOCKET:long});started.push(second);
  await until(()=>f.clients.status('m').state==='online','the second client is online');
  assert.ok(second.log.includes(`bridge-client: 没能打开 bridge-schedule 和 bridge-skill 用的 socket ${long}：`),second.log);
 }finally{await stopClients(f,started);fs.rmSync(dir,{recursive:true});}
});
test('a machine\'s client gets in with the token that the console generates and the state keeps only as a hash; the console shows it online with its host, refused with the reason of a version mismatch, or offline; a newer client of the machine replaces the older, which exits; a new token drops the client of the old one, which is refused from then on; the client reconnects after the control plane restarts, and removing the machine drops it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),port=await freePort(),clients:ClientProcess[]=[];
 fs.mkdirSync(state);
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({machines:[{id:'m',name:'cpu2',session:'default',enabled:false}]}));
 let server=await bridgeServer(state,port,{BRIDGE_URL:''});
 // The clients of the machine run on this one host, where bridge-schedule finds the socket of the one that is in.
 const socket=path.join(dir,'client.sock'),start=(config:string,env:Record<string,string>={BRIDGE_CLIENT_SOCKET:socket})=>{const c=bridgeClient(config,env);clients.push(c);return c;},origin=`http://127.0.0.1:${port}`;
 try{
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim();
  const api=async(p:string,body?:object):Promise<Answer>=>{const r=await fetch(`${origin}/api/${p}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const machine=async()=>(await api('state')).body.machines[0],online=async()=>{const m=await machine();return m.client.state==='online'&&m;};
  let m=await machine();assert.equal(m.hasToken,false);assert.deepEqual(m.client,{state:'offline'});
  assert.deepEqual(await api('machines/token',{id:'gone'}),{status:400,body:{error:'机器连接不存在'}});
  // The config holds the address that the console was reached at.
  const issued=await api('machines/token',{id:'m'});assert.equal(issued.status,200);assert.deepEqual(Object.keys(issued.body),['config']);
  const {url,token}=JSON.parse(issued.body.config);assert.equal(url,`ws://127.0.0.1:${port}/api/client`);assert.match(token,/^[\w-]{43}$/);
  const saved=fs.readFileSync(path.join(state,'state.json'),'utf8');assert.ok(!saved.includes(token));assert.equal(JSON.parse(saved).machines[0].tokenHash,crypto.createHash('sha256').update(token).digest('hex'));
  m=await machine();assert.equal(m.hasToken,true);assert.equal('tokenHash' in m,false);
  // A client of another protocol version is refused, and the console shows why.
  const stale=await dial(url,token),staleClosed=closeOf(stale),mismatch=`版本不一致：控制面协议 ${protocol}，客户端协议 ${protocol+1}`;
  hello(stale,{protocol:protocol+1,host:'old'});assert.deepEqual(await staleClosed,[closeCodes.version,mismatch]);
  assert.deepEqual((await machine()).client,{state:'refused',error:mismatch});
  // The client with the token gets in; one with another token does not.
  const config=configFile(dir,'client.json',issued.body.config),first=start(config);
  m=await until(online,'the client is online');assert.equal(m.client.host,os.hostname());
  const wrong=start(configFile(dir,'wrong.json',configText(origin,'not-the-token')),{BRIDGE_CLIENT_SOCKET:path.join(dir,'wrong.sock')});
  await until(()=>wrong.log.includes('（4001：token 无效）'),'the wrong token is refused');wrong.kill();
  // A second client of the machine replaces the first, which stops; the socket is the second's, and it reaches the control plane, which
  // answers for the machine of its connection (disconnected from bridging).
  const second=start(config);assert.equal(await first.exited,0);assert.match(first.log,/这台机器的另一个客户端已连接/);
  await until(()=>second.log.includes('已连接控制面'),'the second client is in');assert.equal((await machine()).client.state,'online');
  assert.deepEqual(await schedule({socket},['list']),{code:1,out:'',err:'bridge-schedule: Bridge 已断开机器 cpu2 的桥接\n'});
  // A new token drops the client of the old one, which is refused from then on.
  const renewed=JSON.parse((await api('machines/token',{id:'m'})).body.config);assert.notEqual(renewed.token,token);
  await until(()=>second.log.includes('（4001：token 已重新生成）'),'the client of the old token is dropped');
  await until(()=>second.log.includes('（4001：token 无效）'),'the old token is refused');assert.deepEqual((await machine()).client,{state:'offline'});second.kill();
  // The client of the new token gets in, and again after the control plane restarts.
  const third=start(configFile(dir,'renewed.json',configText(origin,renewed.token)));await until(online,'the client of the new token is online');
  await server.stop();server=await bridgeServer(state,port,{BRIDGE_URL:''});
  await until(online,'the client is back after the restart',15000);await until(()=>third.log.split('已连接控制面').length===3,'the client says it is connected again');
  // Removing the machine drops its client.
  assert.equal((await api('machines/remove',{id:'m'})).status,200);await until(()=>third.log.includes('（4001：机器已移除）'),'the client of the removed machine is dropped');
  const logs=(await api('state')).body.logs.filter((l:Log)=>l.kind==='机器连接').map((l:Log)=>l.message);
  for(const message of [`cpu2：客户端被拒绝，${mismatch}`,`cpu2 的客户端已连接（${os.hostname()}）`,`cpu2 的客户端已连接（${os.hostname()}），替换了之前的连接`,'cpu2：生成了新的客户端 token，旧 token 已失效','cpu2 的客户端已断开'])assert.ok(logs.includes(message),message);
 }finally{for(const c of clients)c.kill();await server.stop();fs.rmSync(dir,{recursive:true});}
});

// What the control plane does on a machine through its client (core.ts operations, Clients.call, machine.ts).
// A shell word that is s as it is.
const quoted=(s:unknown)=>"'"+String(s).replaceAll("'","'\\''")+"'";
// Whether no process has id pid any more.
const gone=(pid:number)=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
// A real client process of machine m (see clientsFixture) connected to the control plane of the tests, with herdr, when given, as the Herdr
// of its config and env for its process, which gets a socket of its own; call is Clients.call, and ops are the operations of the control
// plane through it (see operations in core.ts).
async function machineFixture({herdr,env={}}:{herdr?:string,env?:Record<string,string>}={}){
 const f=await clientsFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-machine-'));
 const client=bridgeClient(configFile(dir,'client.json',JSON.stringify({url:f.url,token:f.token,...herdr&&{herdr}})),{BRIDGE_CLIENT_SOCKET:path.join(dir,'client.sock'),...env});
 await until(()=>f.clients.online('m'),'the client is online');
 const call:Call=(...args)=>f.clients.call(...args);
 return {...f,m:f.store.data.machines[0],client,call,ops:operations(call),async close(){await stopClients(f,[client]);fs.rmSync(dir,{recursive:true});}};
}
// A fake Herdr in dir whose third argument, the first after --session <name>, says what it does; hang records its pid and that of a child it
// waits for in dir/pid and dir/child.
function fakeHerdrBinary(dir:string){
 const bin=path.join(dir,'herdr');
 fs.writeFileSync(bin,['#!/bin/sh','case "$3" in',
  ` blocked) echo 'warning: noise' >&2; echo '{"id":"cli:agent:prompt","error":{"code":"agent_blocked","message":"agent w1:p1 is blocked"}}' >&2; exit 1;;`,
  ` usage) echo 'agent prompt requires text' >&2; exit 2;;`,
  ` slow) sleep 0.3; echo '{"id":"x","result":{"type":"ok"}}';;`,
  ` cwd) printf '{"result":{"cwd":"%s","text":"%s"}}' "$5" "$6";;`,
  ` text) echo 'not json';;`,
  ` hang) sleep 30 & echo $! > ${quoted(path.join(dir,'child'))}; echo $$ > ${quoted(path.join(dir,'pid'))}; wait;;`,
  ` *) echo '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 return bin;
}
test('Herdr commands run through the client of the machine with the Herdr of its config in the session of the machine, keep Herdr error codes, honor per-call timeouts and expand ~/ only in path arguments',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-herdr-')),f=await machineFixture({herdr:fakeHerdrBinary(dir)}),{herdr}=f.ops,m=f.m;
 try{
  assert.deepEqual(await herdr(m,['agent','list']),{type:'agent_list',agents:[]});
  await assert.rejects(herdr(m,['blocked']),(e:Thrown)=>e.code==='agent_blocked'&&e.message==='agent w1:p1 is blocked');
  await assert.rejects(herdr(m,['usage']),(e:Thrown)=>e.code===undefined&&/requires text/.test(e.message));
  await assert.rejects(herdr(m,['slow'],{timeoutMs:100}),(e:Thrown)=>e.timedOut===true&&e.message==='herdr 在 0.1 秒内没有结束，已终止');assert.deepEqual(await herdr(m,['slow'],{timeoutMs:5000}),{type:'ok'});
  assert.deepEqual(await herdr(m,['cwd','--cwd',{path:'~/work'},'~/work']),{cwd:os.homedir()+'/work',text:'~/work'});
  await assert.rejects(herdr(m,['text']),/^Error: 远程服务未返回有效 JSON$/);
 }finally{await f.close();fs.rmSync(dir,{recursive:true});}
});
test('a command that runs past the timeout the control plane gave it is killed by the client with the processes it started, and the request fails as timed out; the control plane waits for an answer a little longer than that timeout',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-timeout-')),f=await machineFixture({herdr:fakeHerdrBinary(dir)});
 try{
  const started=Date.now();await assert.rejects(f.ops.herdr(f.m,['hang'],{timeoutMs:500}),(e:Thrown)=>e.timedOut===true&&e.message==='herdr 在 0.5 秒内没有结束，已终止');assert.ok(Date.now()-started<3000);
  const pids=['pid','child'].map(n=>Number(fs.readFileSync(path.join(dir,n),'utf8')));await until(()=>pids.every(gone),'the command and its child are gone');
 }finally{await f.close();fs.rmSync(dir,{recursive:true});}
 // A client that never answers: the request carries its timeout, and the control plane gives up graceMs after it.
 const g=await clientsFixture({graceMs:300});
 try{
  const ws=await dial(g.url,g.token),got:ClientApi['herdr']['params'][]=[];await link<ClientApi,ControlApi>(ws,{ping:()=>({}),herdr:params=>{got.push(params);return new Promise(()=>{});}}).call('hello',{protocol,host:'h'});
  const started=Date.now();await assert.rejects(g.clients.call(g.store.data.machines[0],'herdr',{session:'default',args:['x']},{timeoutMs:200}),(e:Thrown)=>e.timedOut===true&&e.message==='请求超时：herdr');
  const waited=Date.now()-started;assert.ok(waited>=450&&waited<2000,String(waited));assert.deepEqual(got,[{session:'default',args:['x'],timeoutMs:200}]);
  ws.close();await until(()=>!g.clients.online('m'),'the client is gone');
 }finally{g.close();}
});
test('a request for a machine whose client is not in fails at once and says that the machine is offline; one whose connection ends before the answer fails then, and the client still ends the command at its timeout',async()=>{
 const f=await clientsFixture(),m=f.store.data.machines[0];
 try{
  const started=Date.now(),offline=(e:Thrown)=>e.code==='client_offline'&&e.message==='机器 cpu2 离线：它的 Bridge 客户端没有连上';
  await assert.rejects(f.clients.call(m,'herdr',{session:'default',args:['agent','list']}),offline);await assert.rejects(operations((...a)=>f.clients.call(...a)).herdr(m,['agent','list']),offline);
  assert.ok(Date.now()-started<200);assert.equal(f.clients.online('m'),false);
 }finally{f.close();}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-drop-')),g=await machineFixture({herdr:fakeHerdrBinary(dir)});
 try{
  const pending=g.ops.herdr(g.m,['hang'],{timeoutMs:1500});await until(()=>fs.existsSync(path.join(dir,'pid')),'the command runs');
  g.clients.drop('m','测试断开');await assert.rejects(pending,/连接已断开/);
  const pids=['pid','child'].map(n=>Number(fs.readFileSync(path.join(dir,n),'utf8')));await until(()=>pids.every(gone),'the command and its child are gone',5000);
 }finally{await g.close();fs.rmSync(dir,{recursive:true});}
});
test('the client does only what its fixed set of methods names, none of which runs a command the control plane names, and refuses params of another shape',async()=>{
 const f=await machineFixture();
 // The test asks for methods and sends params that the client refuses.
 const call=f.call as (m:Machine,method:string,params:object)=>Promise<unknown>;
 try{
  for(const method of ['exec','run','spawn','shell','constructor','__proto__'])await assert.rejects(call(f.m,method,{argv:['id']}),(e:Thrown)=>e.code==='unknown_method',method);
  const skill={name:'a',digest:'d',files:{'SKILL.md':''}},skills={store:'~/s',skills:[skill],dir:'.claude/skills',as:'link',cwd:'~/w'};
  for(const [method,params] of [['herdr',{session:'default',args:'agent list'}],['herdr',{session:'default',args:[{cwd:'x'}]}],['herdr',{session:'default',args:[{path:'relative'}]}],['herdr',{args:[]}],
   ['mkdir',{path:'relative/dir'}],['mkdir',{}],['git',{cwd:'~/x',args:[1]}],['git',{cwd:'x',args:[]}],['exists',{}],['askCheapModel',{cwd:'~/x'}],['inspectDirectory',{}],['inspectDirectory',{path:'relative'}],
   ['storeFile',{root:'~/w/.herdr-bridge',dir:'..',name:'a',body:''}],['storeFile',{root:'~/w/.herdr-bridge',dir:'t',name:'a/b',body:''}],['storeFile',{root:'~/w/.herdr-bridge',dir:'t',name:'a',body:1}],
   ['placeSkills',{...skills,as:'move'}],['placeSkills',{...skills,dir:'/abs'}],['placeSkills',{...skills,skills:{a:skill}}],['placeSkills',{...skills,skills:[{...skill,name:'../a'}]}],['placeSkills',{...skills,skills:[{...skill,name:'a/b'}]}],
   ['placeSkills',{...skills,skills:[{...skill,digest:''}]}],['placeSkills',{...skills,skills:[{...skill,files:null}]}],['placeSkills',{...skills,skills:[{...skill,files:{'../x':''}}]}],['placeSkills',{...skills,skills:[{...skill,files:{'/x':''}}]}],
   ['placeSkills',{...skills,skills:[{...skill,files:{x:1}}]}],['stockSkill',{store:'~/s'}],['stockSkill',{store:'relative',skill}],['stockSkill',{store:'~/s',skill:{...skill,name:'a/b'}}],['stockSkill',{store:'~/s',skill:{...skill,files:{'../x':''}}}]] satisfies [string,object][])
   await assert.rejects(call(f.m,method,params),(e:Thrown)=>e.code==='invalid_params',method+' '+JSON.stringify(params));
 }finally{await f.close();}
});
test('the client creates directories, stores attachments only under a .herdr-bridge directory and removes only a directory directly under one, as the control plane asks: files 0600 in directories 0700, a .gitignore of * and the clean-up of directories of other topics unchanged for 7 days',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-files-'))),home=path.join(dir,'home');fs.mkdirSync(home);
 const f=await machineFixture({env:{HOME:home}}),{makeDirectory,storeFile,removeDirectory}=f.ops,m=f.m;
 try{
  const target=path.join(home,'a','b','c');
  await makeDirectory(m,'~/a/b/c');assert.ok(fs.statSync(target).isDirectory());await makeDirectory(m,target);
  fs.writeFileSync(path.join(home,'plain'),'');await assert.rejects(makeDirectory(m,'~/plain/x'),/mkdir/);
  await storeFileBehaves(f.ops,m,home);
  // A root that is not a .herdr-bridge directory, also once its links are resolved, gets nothing, and nothing of its own is cleaned up.
  const keep=['work/.herdr-bridge/t2/sub','victim/t3','work/.herdr-bridge/file'];
  for(const p of keep.slice(0,2))fs.mkdirSync(path.join(home,p),{recursive:true});fs.writeFileSync(path.join(home,keep[2]),'');fs.symlinkSync(path.join(home,'victim'),path.join(home,'link'));
  fs.mkdirSync(path.join(home,'outer'));fs.symlinkSync(path.join(home,'victim'),path.join(home,'outer','.herdr-bridge'));age(path.join(home,'victim','t3'),30);
  for(const root of ['~/','~/work','~/work/.herdr-bridge/t1','~/.herdr-bridge/../victim','~/outer/.herdr-bridge'])await assert.rejects(storeFile(m,root,'t','x.png',Buffer.from('x')),(e:Thrown)=>e.code==='refused',root);
  assert.deepEqual(fs.readdirSync(path.join(home,'victim')),['t3']);assert.equal(fs.existsSync(path.join(home,'t')),false);
  // Only a directory directly under a .herdr-bridge directory, which is one also when its path is resolved, is removed.
  for(const p of ['~/work','~/work/.herdr-bridge','~/work/.herdr-bridge/t2/sub','~/work/.herdr-bridge/../victim','~/work/.herdr-bridge/file','~/victim/t3','~/outer/.herdr-bridge/t3','~/link/t3','/','~/gone/x'])
   await assert.rejects(removeDirectory(m,p),(e:Thrown)=>e.code==='refused',p);
  for(const p of [...keep,'victim','work/.herdr-bridge'])assert.ok(fs.existsSync(path.join(home,p)),p);
  // A topic directory under a .herdr-bridge directory that is gone, or not there yet, is removed already.
  await removeDirectory(m,'~/gone/.herdr-bridge/t1');await removeDirectory(m,'~/work/.herdr-bridge/t9');
 }finally{await f.close();fs.rmSync(dir,{recursive:true});}
});
test('the operations that prepare a topic\'s workspace, remove it, prepare an agent\'s launch and describe repositories are in the contract and refuse, as not implemented yet, until a client implements them',async()=>{
 const f=await machineFixture(),project={id:'p',repos:['git@example.com:team/app.git'],workMode:'isolated' as const},{ops,m}=f;
 try{
  const refused=(e:Thrown)=>e.code==='not_implemented'&&/^Error: 这个操作还没有实现：/.test(String(e));
  await assert.rejects(ops.prepareWorkspace(m,{project,topicId:'t',branch:'topic/x'}),refused);await assert.rejects(ops.removeWorkspace(m,{project,topicId:'t',branch:'topic/x'}),refused);
  await assert.rejects(ops.prepareLaunch(m,{kind:'claude',model:'sonnet',permissionMode:'auto',allowedCommands:['butler'],dir:'~/work'}),refused);await assert.rejects(ops.describeRepos(m,{repos:project.repos}),refused);
 }finally{await f.close();}
});
test('the client says whether a directory is the root of a Git repository and what its origin is: nothing for a directory that is not a root, one that is missing or a repository without origin',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-inspect-'))),home=path.join(dir,'home'),code=path.join(home,'code');fs.mkdirSync(code,{recursive:true});
 const f=await machineFixture({env:{HOME:home}}),inspect=(p:string)=>f.ops.inspectDirectory(f.m,p);
 try{
  const repo=(name:string,origin?:string)=>{const p=path.join(code,name);fs.mkdirSync(p);git(p,'init','-q');if(origin)git(p,'remote','add','origin',origin);return p;};
  repo('app','git@example.com:team/app.git');repo('bare');repo('web','https://example.com/team/web.git');
  assert.deepEqual(await inspect('~/code/app'),{origin:'git@example.com:team/app.git'});assert.deepEqual(await inspect(path.join(code,'web')),{origin:'https://example.com/team/web.git'});
  assert.deepEqual(await inspect('~/code/bare'),{origin:null});
  // A directory inside a repository, one that holds clones without being a repository, and one that is not there are no repository roots.
  fs.mkdirSync(path.join(code,'app','src'));fs.mkdirSync(path.join(code,'projects'));fs.cpSync(path.join(code,'app'),path.join(code,'projects','app'),{recursive:true});
  for(const p of ['~/code/app/src','~/code/projects','~/code/none','~/none/at/all'])assert.deepEqual(await inspect(p),{origin:null},p);
  // A link to a root is that root, and the root of a linked worktree is the root of its checkout.
  fs.symlinkSync(path.join(code,'app'),path.join(code,'alias'));assert.deepEqual(await inspect('~/code/alias'),{origin:'git@example.com:team/app.git'});
  git(path.join(code,'app'),'commit','-q','--allow-empty','-m','x');git(path.join(code,'app'),'worktree','add','-q','-b','topic',path.join(code,'topic'));
  assert.deepEqual(await inspect('~/code/topic'),{origin:'git@example.com:team/app.git'});
 }finally{await f.close();fs.rmSync(dir,{recursive:true});}
});
test('placing skills through the client links Claude\'s and Codex\'s skills to the store of the machine and copies them for Antigravity, writes only changed content, leaves skills that are not Bridge\'s alone and records the placed paths once in the info/exclude of a Git repository',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skills-'))),home=path.join(dir,'home');fs.mkdirSync(home);
 const f=await machineFixture({env:{HOME:home}});
 try{await placeSkillsBehaves(f.call,f.m,dir);}finally{await f.close();fs.rmSync(dir,{recursive:true});}
});
test('the client puts a skill that an agent reads into the store of its machine, with Bridge\'s marker holding its digest, and leaves it as it is while the digest stays',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-stock-'))),home=path.join(dir,'home');fs.mkdirSync(home);
 const f=await machineFixture({env:{HOME:home}}),kept=path.join(home,'.local/share/herdr-bridge/skills'),store='~/.local/share/herdr-bridge/skills';
 try{
  const skill={name:'alpha',digest:'d1',files:encoded({'SKILL.md':'x\n','ref/a.md':'a\n'})};
  assert.equal(await f.call(f.m,'stockSkill',{store,skill}),path.join(kept,'alpha'));assert.deepEqual(tree(path.join(kept,'alpha')),{'.herdr-bridge-skill':'d1\n','SKILL.md':'x\n','ref/a.md':'a\n'});
  fs.writeFileSync(path.join(kept,'alpha','extra'),'');await f.call(f.m,'stockSkill',{store,skill});assert.ok(fs.existsSync(path.join(kept,'alpha','extra')));
  await f.call(f.m,'stockSkill',{store,skill:{...skill,digest:'d2',files:encoded({'SKILL.md':'y\n'})}});
  assert.deepEqual(tree(path.join(kept,'alpha')),{'.herdr-bridge-skill':'d2\n','SKILL.md':'y\n'});assert.deepEqual(fs.readdirSync(kept),['alpha']);
 }finally{await f.close();fs.rmSync(dir,{recursive:true});}
});
test('the client runs commands with the environment that the user\'s shell sets up as a login shell without a terminal, captured once at its start and without the HERDR_* variables: they find programs on the PATH of the shell\'s startup files, which the client\'s own PATH lacks, whatever those files print; git never prompts and speaks English, claude names a branch in the directory given with the prompt on stdin, and Herdr is ~/.local/bin/herdr unless the config says otherwise; a shell that fails leaves the client its own environment',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-env-'))),home=path.join(dir,'home'),bin=path.join(dir,'bin'),shell=path.join(dir,'shell'),repo=path.join(home,'repo');
 for(const d of [repo,bin,path.join(home,'.local','bin')])fs.mkdirSync(d,{recursive:true});
 // The user's shell: as a login shell, like bash with a ~/.profile, it prints a greeting and puts bin first on the PATH.
 fs.writeFileSync(shell,['#!/bin/sh','[ "$1" = -l ] && { echo welcome; PATH='+quoted(bin)+':$PATH; export PATH; FROM_SHELL=1; export FROM_SHELL; shift; }','exec /bin/sh "$@"',''].join('\n'),{mode:0o700});
 fs.writeFileSync(path.join(home,'.local','bin','herdr'),['#!/bin/sh','printf \'{"result":{"args":"%s","shell":"%s","pane":"%s","path":"%s"}}\' "$*" "$FROM_SHELL" "$HERDR_PANE_ID" "$PATH"',''].join('\n'),{mode:0o700});
 fs.writeFileSync(path.join(bin,'git'),['#!/bin/sh','printf \'%s|%s|%s|%s\' "$*" "$GIT_TERMINAL_PROMPT" "$LC_ALL" "$HERDR_PANE_ID"',''].join('\n'),{mode:0o700});
 fs.writeFileSync(path.join(bin,'claude'),['#!/bin/sh','echo "BRANCH=feat/from-shell $*"','pwd','cat',''].join('\n'),{mode:0o700});
 const env={HOME:home,SHELL:shell,PATH:'/usr/bin:/bin',HERDR_PANE_ID:'w1:p1',HERDR_SESSION:'other'};
 const f=await machineFixture({env});
 try{
  assert.deepEqual(await f.ops.herdr(f.m,['agent','list']),{args:'--session default agent list',shell:'1',pane:'',path:`${bin}:/usr/bin:/bin`});
  assert.deepEqual(await f.ops.git(f.m,'~/repo',['status','--porcelain']),{code:0,stdout:`-C ${repo} status --porcelain|0|C|`,stderr:''});
  assert.deepEqual(await f.ops.askCheapModel(f.m,'~/repo','给登录页加验证码\n'),{code:0,stdout:`BRANCH=feat/from-shell -p --model haiku\n${repo}\n给登录页加验证码\n`,stderr:''});
  assert.equal(await f.ops.exists(f.m,'~/repo'),true);assert.equal(await f.ops.exists(f.m,'~/none'),false);
 }finally{await f.close();}
 // A shell that fails: the client logs why and runs Herdr with its own environment, still without the HERDR_* variables, where claude is not found.
 fs.writeFileSync(shell,'#!/bin/sh\necho broken >&2\nexit 3\n',{mode:0o700});
 const g=await machineFixture({env});
 try{
  assert.deepEqual(await g.ops.herdr(g.m,['agent','list']),{args:'--session default agent list',shell:'',pane:'',path:'/usr/bin:/bin'});
  assert.match(g.client.log,/没能取得登录 shell 的环境，命令按客户端自己的环境运行：.*退出码 3：broken/);
  await assert.rejects(g.ops.askCheapModel(g.m,'~/repo','x'),/ENOENT/);
 }finally{await g.close();fs.rmSync(dir,{recursive:true});}
});

test('SDK cache isolates apps and honors namespaces and absolute expiry',async()=>{const a=channelCache(),b=channelCache();await a.set('same','seen',Date.now()+60000,{namespace:'dedup'});assert.equal(await a.get('same',{namespace:'dedup'}),'seen');assert.equal(await b.get('same',{namespace:'dedup'}),undefined);assert.equal(await a.get('same',{namespace:'token'}),undefined);await a.set('expired','old',Date.now()-1);assert.equal(await a.get('expired'),undefined);});

test('static files map the two pages, the theme script and hashed assets and reject every other path',()=>{
 const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),html='text/html; charset=utf-8';
 assert.deepEqual(staticFile('/'),{file:path.join(dist,'index.html'),type:html,immutable:false});assert.deepEqual(staticFile('/connect'),{file:path.join(dist,'connect.html'),type:html,immutable:false});
 assert.deepEqual(staticFile('/theme.js'),{file:path.join(dist,'theme.js'),type:'text/javascript; charset=utf-8',immutable:false});
 for(const [name,type] of [['index-AbC_1.js','text/javascript; charset=utf-8'],['index-x.css','text/css; charset=utf-8'],['mark.svg','image/svg+xml'],['qr.png','image/png'],['font.woff2','font/woff2']])assert.deepEqual(staticFile('/assets/'+name),{file:path.join(dist,'assets',name),type,immutable:true});
 for(const p of ['/index.html','/connect.html','/connect/','/app.js','/style.css','/assets/','/assets/x.map','/assets/x.html','/assets/x.json','/assets/x.JS','/assets/..','/assets/.js','/assets/../server.ts','/assets/..%2Fserver.ts','/assets/sub/x.js','/assets/x.js/','/api/state','/health'])assert.equal(staticFile(p),null,p);
});
test('static responses: pages return 503 before the build, missing assets 404, hashed assets are immutable',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-web-')),dist=path.join(root,'dist');
 const send=async(p:string)=>{const r:Sent={};await sendStatic({writeHead(code,headers){r.code=code;r.headers=headers;},end(body){r.body=String(body??'');}},staticFile(p,dist)!);return r;};
 try{
  for(const p of ['/','/connect']){const r=await send(p);assert.equal(r.code,503);assert.equal(r.body,'前端尚未构建，运行 npm run build');}
  assert.equal((await send('/assets/index-a.js')).code,404);
  fs.mkdirSync(path.join(dist,'assets'),{recursive:true});fs.writeFileSync(path.join(dist,'index.html'),'<!doctype html>');fs.writeFileSync(path.join(dist,'assets','index-a.js'),'export{}');
  const page=await send('/');assert.equal(page.code,200);assert.equal(page.body,'<!doctype html>');assert.equal(page.headers['Content-Type'],'text/html; charset=utf-8');assert.equal(page.headers['Cache-Control'],'no-cache');
  const asset=await send('/assets/index-a.js');assert.equal(asset.code,200);assert.equal(asset.body,'export{}');assert.equal(asset.headers['Cache-Control'],'public, max-age=31536000, immutable');
  assert.equal((await send('/assets/index-b.js')).code,404);assert.equal((await send('/connect')).code,404);
  assert.equal((await send('/theme.js')).code,404);fs.writeFileSync(path.join(dist,'theme.js'),'(()=>{})();');
  const theme=await send('/theme.js');assert.equal(theme.code,200);assert.equal(theme.body,'(()=>{})();');assert.equal(theme.headers['Content-Type'],'text/javascript; charset=utf-8');assert.equal(theme.headers['Cache-Control'],'no-cache');
 }finally{fs.rmSync(root,{recursive:true});}
});
test('built admin pages load only files the server serves and stay within the CSP',()=>{
 const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),read=(f:string)=>fs.readFileSync(path.join(dist,f),'utf8'),assets=fs.readdirSync(path.join(dist,'assets'));
 for(const name of assets)assert.ok(staticFile('/assets/'+name),`dist/assets/${name} cannot be served`);
 for(const html of ['index.html','connect.html']){
  const page=read(html);assert.doesNotMatch(page,/\sstyle=|<style|<script(?![^>]*\ssrc=)|<[a-z][^>]*\son[a-z]+=/i,html+' has an inline style, script or event handler');
  const urls=[...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map(m=>m[1]).filter(u=>!u.startsWith('#')&&!u.startsWith('data:image/'));assert.ok(urls.some(u=>u.endsWith('.js'))&&urls.some(u=>u.endsWith('.css')),html+' loads no script or stylesheet');
  for(const url of urls){const asset=staticFile(url);assert.ok(asset&&fs.existsSync(asset.file),`${html} loads ${url}, which the server does not serve`);}
  // The theme script runs as a classic, blocking script ahead of the stylesheet and the app, so a stored theme is applied before first paint.
  const head=page.slice(0,page.indexOf('</head>')),theme=head.indexOf('<script src="/theme.js"></script>');
  assert.ok(theme>=0&&theme<head.search(/<link rel="stylesheet"|<script type="module"/),html+' does not run /theme.js before its stylesheet and app');
  assert.match(head,/<meta name="color-scheme" content="light dark">/,html+' does not offer both color schemes');
 }
 assert.doesNotMatch(read('theme.js'),/^\s*(?:import|export)\b/m,'theme.js must stay a classic script');
 for(const name of assets.filter(n=>n.endsWith('.css'))){const css=read('assets/'+name);assert.doesNotMatch(css,/@import/,name);for(const [,url] of css.matchAll(/url\(\s*['"]?([^'")\s]+)/g))assert.match(url,/^(?:data:image\/svg\+xml|\/assets\/)/,`${name} loads ${url}`);}
 for(const name of assets.filter(n=>n.endsWith('.js'))){const js=read('assets/'+name);for(const [,from,dynamic] of js.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)){const spec=from??dynamic,file=spec.replace(/^\.\//,'');assert.ok(/^[\w.-]+\.js$/.test(file)&&assets.includes(file),`${name} imports ${spec}`);}}
});
