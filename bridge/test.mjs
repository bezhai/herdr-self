import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import net from 'node:net';
import {normalizeMachine,remoteInvocation,herdr,quote,Store} from './core.mjs';import {normalizeApp,normalizeBinding,routable,Platforms,channelCache} from './platform.mjs';import {Topics} from './topics.mjs';
import {PendingChats,consoleUrl} from './pending-chats.mjs';
import {Registrations} from './registration.mjs';import {staticFile,sendStatic} from './web-assets.mjs';import {fileURLToPath} from 'node:url';
import {normalize} from '@larksuite/channel';

function platformFixture(options){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-platform-')),store=new Store(dir),messages=[],unbound=[];return {dir,store,messages,unbound,platforms:new Platforms(store,{onMessage:(...args)=>messages.push(args),onUnbound:(...args)=>unbound.push(args),...options}),close(){fs.rmSync(dir,{recursive:true});}};}
const route={id:'b',name:'个人助手',enabled:true,appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:false};
const inbound={senderType:'user',senderId:'ou_user',chatId:'oc_1',messageId:'om_1',rawContentType:'text',content:'private prompt'};
const allowed={id:'a',name:'bot',enabled:true,allowedUsers:['ou_user']};
function registrationFixture(register,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-registration-')),store=new Store(dir);
 const registrations=new Registrations(store,{register,qr:async()=>'data:image/png;base64,test',...options});
 return {store,registrations,close(){registrations.stop();fs.rmSync(dir,{recursive:true});}};
}
const ready=o=>o.onQRCodeReady({url:'https://open.feishu.cn/page/launcher?user_code=test',expireIn:600});
test('registration stores credentials server-side, uses minimal bot scopes and allows only the creator',async()=>{
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);assert.equal(o.addons.preset,false);assert.equal(o.addons.scopes.user,undefined);assert.deepEqual(o.addons.events.items.tenant,['im.message.receive_v1']);ready(o);return {client_id:'cli_test',client_secret:'private-test-secret',user_info:{open_id:'ou_owner',tenant_brand:'feishu'}};});
 try{f.registrations.start({name:'test'});await f.registrations.current.done;assert.equal(f.registrations.status().status,'completed');const a=new Store(f.store.dir).data.apps[0];assert.equal(a.appSecret,'private-test-secret');assert.deepEqual(a.allowedUsers,['ou_owner']);assert.equal(a.enabled,false);assert.equal(a.domain,'feishu');assert.ok(!JSON.stringify(f.registrations.status()).includes('private-test-secret'));assert.equal(f.registrations.status().url,undefined);assert.equal(fs.statSync(path.join(f.store.dir,'state.json')).mode&0o777,0o600);}finally{f.close();}
});
test('duplicate starts reuse pending flow; cancellation fences a late SDK result and stale cancel',async()=>{
 let resolve;let calls=0;const f=registrationFixture(o=>{calls++;ready(o);return new Promise(r=>resolve=r);});
 try{const one=f.registrations.start({name:'one'}),two=f.registrations.start({name:'two'});assert.equal(one.id,two.id);assert.equal(calls,1);const done=f.registrations.current.done;f.registrations.cancel(one.id);resolve({client_id:'cli_late',client_secret:'late'});await done;assert.equal(f.store.data.apps.length,0);assert.equal(f.registrations.status().status,'cancelled');const next=f.registrations.start({name:'next'});assert.notEqual(next.id,one.id);assert.throws(()=>f.registrations.cancel(one.id));f.registrations.cancel(next.id);resolve({});await f.registrations.current.done;}finally{f.close();}
});
test('denial, expiry and errors do not expose SDK details or credentials',async()=>{
 for(const [error,status] of [[{code:'access_denied'},'denied'],[{code:'expired_token'},'expired'],[{message:'secret must not leak',response:{device_code:'private'}},'error']]){
  const f=registrationFixture(async o=>{ready(o);throw error;});try{f.registrations.start({name:'test'});await f.registrations.current.done;assert.equal(f.registrations.status().status,status);assert.equal(f.registrations.status().url,undefined);assert.ok(!JSON.stringify(f.registrations.status()).includes('private'));assert.equal(f.store.data.apps.length,0);}finally{f.close();}
 }
});
test('registration rejects unsafe URLs, handles missing owner and honors Lark tenant brand',async()=>{
 const bad=registrationFixture(async o=>{o.onQRCodeReady({url:'https://attacker.example/qr',expireIn:600});return {};});
 try{bad.registrations.start({name:'test'});await bad.registrations.current.done;assert.equal(bad.registrations.status().status,'error');assert.equal(bad.registrations.status().url,undefined);}finally{bad.close();}
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_lark',client_secret:'secret',user_info:{tenant_brand:'lark'}};});
 try{f.registrations.start({name:'test'});await f.registrations.current.done;assert.equal(f.store.data.apps[0].domain,'lark');assert.deepEqual(f.store.data.apps[0].allowedUsers,[]);assert.equal(f.store.data.apps[0].enabled,false);assert.equal(f.registrations.status().status,'needs_owner');}finally{f.close();}
});
test('begin timeout ignores late callback and does not publish an expired authorization link',async()=>{
 let options,resolve;const f=registrationFixture(o=>{options=o;return new Promise(r=>resolve=r);},{timeoutMs:10});
 try{f.registrations.start({name:'test'});await new Promise(r=>setTimeout(r,25));ready(options);resolve({client_id:'cli_late',client_secret:'late'});await f.registrations.current.done;assert.equal(f.registrations.status().status,'error');assert.equal(f.registrations.status().url,undefined);assert.equal(f.store.data.apps.length,0);}finally{f.close();}
});
test('SSH machine rejects option and shell injection; command arguments remain quoted',()=>{
 for(const host of ['-oProxyCommand=x','a;touch /tmp/bad','a$(id)','x\ny'])assert.throws(()=>normalizeMachine({name:'test',host}));
 const m=normalizeMachine({name:'test',host:'user@host',binary:'~/.local/bin/herdr'});const [bin,args]=remoteInvocation(m,['--session','default','agent','prompt','w1:p1',"x'; echo hacked"]);assert.equal(bin,'ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('--'));assert.match(args.at(-1),/sh -c/);
 const remote=remoteInvocation(m,['tab','create','--cwd',{path:'~/w x'},'--label','~/not-a-path'])[1].at(-1);assert.ok(remote.includes(quote(`"$HOME"/'w x'`).slice(1,-1)));assert.ok(remote.includes(quote(quote('~/not-a-path')).slice(1,-1)));
 const local=normalizeMachine({name:'local',type:'local',binary:'~/bin/herdr'});assert.deepEqual(remoteInvocation(local,['--cwd',{path:'~/w x'},{path:'/srv'},'~/text']),[os.homedir()+'/bin/herdr',['--cwd',os.homedir()+'/w x','/srv','~/text']]);
 assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',session:'../default'}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',port:-1}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',binary:'herdr'}),/Herdr 路径/);
});
test('a binding routes the pending chat of an app to a working directory and agent kind on a machine; app and chat never come from the client',()=>{
 const chat={token:'t',appId:'a',chatId:'oc_1',chatType:'group'},input={name:'助手',appId:'forged',chatId:'oc_forged',machineId:'m',cwd:'~/code/x',kind:'codex',requireMention:false};
 const {id,...b}=normalizeBinding({...input,rootId:'om_1',paneId:'w1:p1'},chat,[]);assert.match(id,/^[0-9a-f-]{36}$/);assert.deepEqual(b,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'codex',requireMention:false,enabled:true});
 assert.equal(normalizeBinding({...input,requireMention:undefined},chat,[]).requireMention,true);assert.equal(normalizeBinding({...input,cwd:'/srv/app',kind:'claude'},chat,[]).cwd,'/srv/app');
 for(const requireMention of [true,undefined])assert.equal(normalizeBinding({...input,requireMention},{...chat,chatType:'p2p'},[]).requireMention,false);
 for(const cwd of ['relative','/a b','~/$(id)','/x;y','',undefined])assert.throws(()=>normalizeBinding({...input,cwd},chat,[]));assert.throws(()=>normalizeBinding({...input,cwd:'work'},chat,[]),/工作目录/);
 for(const kind of ['bash','',undefined])assert.throws(()=>normalizeBinding({...input,kind},chat,[]),/Agent 类型/);
 assert.throws(()=>normalizeBinding(input,chat,[{appId:'a',chatId:'oc_1'}]),/该聊天已有绑定/);assert.equal(normalizeBinding(input,chat,[{appId:'other',chatId:'oc_1'},{appId:'a',chatId:'oc_2'}]).chatId,'oc_1');
});
test('Bridge takes text and rich text without resources from a person; mentions are left to topic handling',async()=>{
 const raw={sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{message_id:'om_message',chat_id:'oc_1',chat_type:'group',root_id:'om_root',message_type:'text',content:'{"text":"@_user_1 hi"}',mentions:[{key:'@_user_1',id:{open_id:'ou_bot'},name:'bot'}]}};
 const e=await normalize(raw,{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(e.content.trim(),'hi');assert.equal(e.chatType,'group');assert.equal(e.mentionedBot,true);assert.equal(routable(e),true);assert.equal(routable({...e,senderType:'bot'}),false);
 const other=await normalize({...raw,message:{...raw.message,mentions:[{key:'@_user_1',id:{open_id:'ou_other'},name:'other'}]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(other.mentionedBot,false);assert.equal(routable(other),true);assert.equal(routable({...e,resources:[{type:'image'}]}),false);assert.equal(routable({...e,rawContentType:'image'}),false);
 const dm=await normalize({...raw,message:{...raw.message,chat_type:'p2p',root_id:undefined,mentions:[]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(dm.chatType,'p2p');assert.equal(routable(dm),true);
});
test('secrets are preserved only for the same application and are not part of the app status',()=>{const old={id:'a',appId:'cli_old',appSecret:'saved'};assert.equal(normalizeApp({name:'bot',appId:'cli_old',allowedUsers:[]},old).appSecret,'saved');assert.throws(()=>normalizeApp({name:'bot',appId:'cli_new',allowedUsers:[]},old));
 const f=platformFixture();try{assert.ok(!('appSecret' in JSON.parse(JSON.stringify(f.platforms.status({...old,allowedUsers:[]})))));}finally{f.close();}
});
test('a routed message goes to the topic handler with its app and binding, whether or not it mentions the bot',()=>{
 const f=platformFixture();try{f.store.data.bindings=[{...route,requireMention:true}];f.platforms.receive(allowed,inbound);
 assert.deepEqual(f.messages,[[allowed,f.store.data.bindings[0],inbound]]);assert.deepEqual(f.store.data.logs,[]);}finally{f.close();}
});
test('messages from outside the allowlist, to a disabled app, of another kind or empty are not passed on',()=>{
 const f=platformFixture();try{f.store.data.bindings=[route];const dm={...inbound,chatId:'oc_2',chatType:'p2p'};
 for(const [app,msg] of [[allowed,{...inbound,senderId:'ou_other'}],[allowed,{...dm,senderId:'ou_other'}],[{...allowed,enabled:false},inbound],[{...allowed,enabled:false},dm],[allowed,{...inbound,content:'  '}],[allowed,{...dm,content:'  '}],[allowed,{...dm,senderType:'bot'}],[allowed,{...dm,resources:[{type:'image'}]}]])f.platforms.receive(app,msg);
 assert.deepEqual([f.messages,f.unbound],[[],[]]);}finally{f.close();}
});
test('a chat without a binding asks for one on any direct message but only on group messages that mention the bot; a disabled binding blocks both',()=>{
 const f=platformFixture();try{f.store.data.bindings=[route,{...route,id:'off',chatId:'oc_off',enabled:false}];
  const dm={...inbound,chatId:'oc_dm',chatType:'p2p'},group={...inbound,chatId:'oc_group',chatType:'group',mentionedBot:false},mentioned={...group,messageId:'om_2',mentionedBot:true};
  for(const [app,msg] of [[allowed,dm],[allowed,group],[allowed,mentioned],[allowed,{...mentioned,chatId:'oc_off'}],[allowed,{...dm,chatId:'oc_off'}],[{...allowed,id:'other'},{...inbound,chatType:'p2p'}]])f.platforms.receive(app,msg);
  assert.deepEqual(f.unbound,[[allowed,dm],[allowed,mentioned],[{...allowed,id:'other'},{...inbound,chatType:'p2p'}]]);assert.deepEqual(f.messages,[]);
 }finally{f.close();}
});
test('a state file with legacy message queues loads only machines, apps, bindings, topics and logs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-'));try{
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({machines:[{id:'m'}],apps:[{id:'a'}],bindings:[{id:'b'}],inbox:[{text:'old prompt'}],outbox:[{key:'k'}],logs:[{kind:'x'}]}));
  const store=new Store(dir);assert.deepEqual(store.data,{machines:[{id:'m'}],apps:[{id:'a'}],bindings:[{id:'b'}],topics:[],logs:[{kind:'x'}]});store.save();assert.ok(!fs.readFileSync(path.join(dir,'state.json'),'utf8').includes('old prompt'));
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('platform channels listen for messages and connection events only and never retry a send',()=>{
 let options;const handlers={},f=platformFixture({channelFactory:o=>{options=o;return {on:(name,fn)=>{handlers[name]=fn;}};}});
 try{f.platforms.channel({id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu'});
 assert.deepEqual(Object.keys(handlers).sort(),['error','message','reconnected','reconnecting']);assert.deepEqual(options.outbound,{retry:{maxAttempts:1}});assert.deepEqual(options.safety.chatQueue,{enabled:true,mergeWhileBusy:false});}finally{f.close();}
});
test('replies go into the topic thread and fail without a connected channel',async()=>{
 const f=platformFixture(),sent=[];try{
  await assert.rejects(f.platforms.reply(allowed,'oc_1','om_1','hi'),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),send:async(...args)=>{sent.push(args);return {messageId:'om_r'};}}});
  await f.platforms.reply(allowed,'oc_1','om_1','hi');assert.deepEqual(sent,[['oc_1',{text:'hi'},{replyTo:'om_1',replyInThread:true}]]);
 }finally{f.close();}
});
test('a start failure with a local path and an English Herdr error keeps them out of the Feishu notice',async()=>{
 const f=topicFixture(),raw='no herdr server is running at /home/someone/.config/herdr/herdr.sock; run `herdr server`';try{
  f.h.on['workspace list']=()=>{throw Error(raw);};await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.replies.map(r=>r[3]),['启动失败，请在 Bridge 管理台查看原因']);assert.ok(f.replies.every(r=>!r[3].includes('/home/')&&!r[3].includes('herdr server')));
  assert.equal(f.store.data.topics[0].error,raw);
 }finally{f.close();}
});
test('Herdr commands keep Herdr error codes, honor per-call timeouts and expand ~/ only in path arguments',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-herdr-')),bin=path.join(dir,'herdr');
 fs.writeFileSync(bin,['#!/bin/sh','case "$3" in',
  ` blocked) echo 'warning: noise' >&2; echo '{"id":"cli:agent:prompt","error":{"code":"agent_blocked","message":"agent w1:p1 is blocked"}}' >&2; exit 1;;`,
  ` usage) echo 'agent prompt requires text' >&2; exit 2;;`,
  ` slow) sleep 0.3; echo '{"id":"x","result":{"type":"ok"}}';;`,
  ` cwd) printf '{"result":{"cwd":"%s","text":"%s"}}' "$5" "$6";;`,
  ` *) echo '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 const m=normalizeMachine({name:'local',type:'local',binary:bin});
 try{
  assert.deepEqual(await herdr(m,['agent','list']),{type:'agent_list',agents:[]});
  await assert.rejects(herdr(m,['blocked']),e=>e.code==='agent_blocked'&&e.message==='agent w1:p1 is blocked');
  await assert.rejects(herdr(m,['usage']),e=>e.code===undefined&&/requires text/.test(e.message));
  await assert.rejects(herdr(m,['slow'],{timeoutMs:100}),/连接超时/);assert.deepEqual(await herdr(m,['slow'],{timeoutMs:5000}),{type:'ok'});
  assert.deepEqual(await herdr(m,['cwd','--cwd',{path:'~/work'},'~/work']),{cwd:os.homedir()+'/work',text:'~/work'});
 }finally{fs.rmSync(dir,{recursive:true});}
});

const coded=(code,message)=>Object.assign(Error(message),{code});
// In-memory Herdr: records every CLI call; h.on['<group> <verb>'] replaces the next such call and may call run(args) for the default result.
function fakeHerdr(){
 const h={calls:[],timeouts:[],machines:[],workspaces:[],agents:[],created:0,panes:0,on:{}};
 const run=args=>{
  const [group,verb]=args;
  if(group==='workspace'&&verb==='list')return {type:'workspace_list',workspaces:h.workspaces};
  if(group==='workspace'&&verb==='create'){const id='w'+ ++h.created,n=++h.panes;h.workspaces.push({workspace_id:id,label:args[5]});return {type:'workspace_created',workspace:{workspace_id:id},tab:{tab_id:`${id}:t${n}`},root_pane:{pane_id:`${id}:p${n}`}};}
  if(group==='tab'&&verb==='rename')return {type:'tab_info',tab:{tab_id:args[2],label:args[3]}};
  if(group==='tab'&&verb==='create'){const n=++h.panes;return {type:'tab_created',tab:{tab_id:`${args[3]}:t${n}`},root_pane:{pane_id:`${args[3]}:p${n}`}};}
  if(group==='agent'&&verb==='start'){const agent={name:args[2],agent:args[4],pane_id:args[6],agent_status:'idle'};h.agents.push(agent);return {type:'agent_started',agent,argv:[args[4]]};}
  if(group==='agent'&&verb==='list')return {type:'agent_list',agents:h.agents};
  if(group==='agent'&&verb==='prompt')return {type:'agent_prompted',agent:h.agents.find(a=>a.pane_id===args[2])};
  throw Error('unexpected herdr '+args.join(' '));
 };
 h.herdr=async(m,args,options={})=>{h.calls.push(args);h.timeouts.push(options.timeoutMs);h.machines.push(m.id);await null;const key=args[0]+' '+args[1],hook=h.on[key];if(hook){delete h.on[key];return hook(args,run);}return run(args);};
 return h;
}
function topicFixture({binding,machine}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-')),store=new Store(dir),h=fakeHerdr(),replies=[],m={id:'m',name:'cpu2',enabled:true,...machine};
 store.data.bindings=[{...route,...binding}];store.save();const b=store.data.bindings[0];
 const topics=new Topics(store,{herdr:h.herdr,machine:id=>{if(id!==m.id)throw Error('机器连接不存在');return m;},reply:async(a,chatId,rootId,text)=>{replies.push([a.id,chatId,rootId,text]);}});
 const send=msg=>topics.handle(allowed,b,{senderType:'user',senderId:'ou_user',chatId:'oc_1',rawContentType:'text',...msg});
 return {dir,store,h,replies,b,send,close(){fs.rmSync(dir,{recursive:true});}};
}
const later=ms=>new Promise(r=>setTimeout(r,ms));
test('a new topic creates the binding workspace, names its root tab after the topic, starts the agent there with a longer timeout and prompts it',async()=>{
 const f=topicFixture(),text='请帮我修复登录页在移动端点击提交按钮后没有任何反应的问题',title=text.slice(0,24);try{
  await f.send({messageId:'om_1',content:' '+text+'\n'});
  const [t]=f.store.data.topics,{id,agentName,createdAt,...rest}=t;
  assert.equal(agentName,'feishu-'+id.slice(0,8));assert.match(agentName,/^feishu-[0-9a-f]{8}$/);assert.ok(createdAt>0);
  assert.deepEqual(f.h.calls,[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w1:t1',title],['agent','start',agentName,'--kind','claude','--pane','w1:p1','--timeout','60000'],['agent','prompt','w1:p1',text]]);
  assert.deepEqual(f.h.timeouts,[undefined,undefined,undefined,70000,undefined]);assert.deepEqual([...new Set(f.h.machines)],['m']);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',title,state:'ready',error:'',messageIds:['om_1']});
  assert.equal(new Store(f.dir).data.bindings[0].workspaceId,'w1');assert.equal(new Store(f.dir).data.topics[0].state,'ready');
  assert.deepEqual(f.replies,[['a','oc_1','om_1',`已在 cpu2 的 Herdr 中启动 claude：飞书 · 个人助手 / ${title}`]]);
 }finally{f.close();}
});
test('another topic opens a tab in the same workspace; replies in a topic prompt its pane without a new tab',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'第一个话题'});await f.send({messageId:'om_2',content:'第二个\n  话题'});
  const second=f.store.data.topics[1];
  assert.deepEqual(f.h.calls.slice(5),[['workspace','list'],['tab','create','--workspace','w1','--cwd',{path:'~/work'},'--label','第二个 话题','--no-focus'],['agent','start',second.agentName,'--kind','claude','--pane','w1:p2','--timeout','60000'],['agent','prompt','w1:p2','第二个\n  话题']]);
  assert.deepEqual([second.rootId,second.tabId,second.title],['om_2','w1:t2','第二个 话题']);
  f.h.calls.length=0;await f.send({messageId:'om_3',rootId:'om_1',content:'继续第一个'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','继续第一个']]);
  assert.equal(f.store.data.topics.length,2);assert.deepEqual(f.store.data.topics[0].messageIds,['om_1','om_3']);assert.deepEqual(f.replies.map(r=>r[2]),['om_1','om_2']);
 }finally{f.close();}
});
test('a message id is persisted before any Herdr call and handled at most once; each topic keeps its latest 50 ids',async()=>{
 const f=topicFixture();try{
  let saved;f.h.on['workspace list']=(args,run)=>{saved=JSON.parse(fs.readFileSync(path.join(f.dir,'state.json'),'utf8')).topics;return run(args);};
  const msg={messageId:'om_1',content:'hi'};await Promise.all([f.send(msg),f.send(msg)]);await f.send(msg);
  assert.deepEqual(saved.map(t=>[t.state,t.messageIds]),[['starting',['om_1']]]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);
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
  assert.equal(f.b.workspaceId,'w2');assert.equal(f.store.data.topics[1].paneId,'w2:p2');
 }finally{f.close();}
});
test('a workspace id that Herdr reassigned to another workspace is not reused; a new workspace is created',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});f.h.workspaces[0].label='用户自己的工作区';f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(f.h.calls.slice(0,3),[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w2:t2','two']]);
  assert.equal(f.h.calls.some(c=>c[0]==='tab'&&c[1]==='create'),false);assert.deepEqual([f.b.workspaceId,f.store.data.topics[1].paneId],['w2','w2:p2']);
 }finally{f.close();}
});
test('a topic whose named agent is gone is closed with one notice and gets no further prompts',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});
  f.h.agents.splice(0,1,{name:'someone-else',pane_id:'w1:p1',agent_status:'idle'});f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(f.store.data.topics[0].state,'closed');
  assert.deepEqual(f.replies,[['a','oc_1','om_1','该话题的会话已结束，请发起新话题']]);
 }finally{f.close();}
});
test('a failed start marks the topic failed with a notice that carries no error details; the next message retries in a new tab',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','agent target pane w1:p1 is not an available shell');};
  await f.send({messageId:'om_1',content:'one'});
  const t=f.store.data.topics[0];assert.deepEqual([t.state,t.error],['failed','agent target pane w1:p1 is not an available shell']);assert.equal(new Store(f.dir).data.topics[0].state,'failed');
  assert.deepEqual(f.replies.map(r=>r[3]),['启动失败，请在 Bridge 管理台查看原因']);assert.match(f.store.data.logs.at(-1).message,/agent target pane w1:p1 is not an available shell/);assert.equal(f.h.calls.some(c=>c[1]==='prompt'),false);
  f.h.calls.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.h.calls,[['workspace','list'],['tab','create','--workspace','w1','--cwd',{path:'~/work'},'--label','one','--no-focus'],['agent','start',t.agentName,'--kind','claude','--pane','w1:p2','--timeout','60000'],['agent','prompt','w1:p2','two']]);
  assert.deepEqual([t.state,t.error,t.paneId,f.store.data.topics.length],['ready','','w1:p2',1]);
 }finally{f.close();}
});
test('a topic on a disconnected machine fails without calling Herdr',async()=>{
 const f=topicFixture({machine:{enabled:false}});try{
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual([f.h.calls,f.store.data.topics[0].state,f.store.data.topics[0].error,f.replies.map(r=>r[3])],[[],'failed','机器连接已停用',['启动失败，请在 Bridge 管理台查看原因']]);
 }finally{f.close();}
});
test('agent_not_ready at start still opens the topic; agent_blocked sends a notice; other prompt errors are only logged',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=(args,run)=>{run(args);throw coded('agent_not_ready','agent is blocked during startup and is not ready for prompts');};
  f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked and requires interactive input');};
  await f.send({messageId:'om_1',content:'one'});
  assert.equal(f.store.data.topics[0].state,'ready');assert.deepEqual(f.replies.map(r=>r[3]).slice(1),['Agent 正在等待确认，请到 Herdr 中处理后重发这条消息']);
  f.h.on['agent prompt']=()=>{throw coded('agent_prompt_failed','pty closed');};f.replies.length=0;const logs=f.store.data.logs.length;
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.replies,[]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,2);assert.equal(f.store.data.topics[0].state,'ready');
  const errors=f.store.data.logs.slice(logs);assert.equal(errors.length,1);assert.equal(errors[0].level,'error');assert.match(errors[0].message,/pty closed/);
 }finally{f.close();}
});
test('requireMention applies only to the message that opens a topic',async()=>{
 const f=topicFixture({binding:{requireMention:true}});try{
  await f.send({messageId:'om_1',content:'no mention'});assert.deepEqual([f.store.data.topics.length,f.h.calls.length],[0,0]);
  await f.send({messageId:'om_2',content:'with mention',mentionedBot:true});await f.send({messageId:'om_3',rootId:'om_2',content:'follow-up'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['with mention','follow-up']);
 }finally{f.close();}
});
test('topics still starting when Bridge restarts are marked failed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-'));try{
  const store=new Store(dir);store.data.topics=[{id:'t1',state:'starting',error:''},{id:'t2',state:'ready',error:''}];store.save();
  new Topics(new Store(dir),{herdr:async()=>{},machine:()=>{},reply:async()=>{}});
  assert.deepEqual(new Store(dir).data.topics.map(t=>[t.state,t.error]),[['failed','Bridge 重启时 Agent 启动未完成'],['ready','']]);
 }finally{fs.rmSync(dir,{recursive:true});}
});

const minutes=n=>n*60000;
function pendingFixture({bridgeUrl='http://bridge.example:8080',onBound}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pending-')),store=new Store(dir),replies=[],bound=[],clock={now:1000};
 store.data.apps=[{...allowed}];store.data.machines=[{id:'m',name:'cpu2'}];store.save();
 const lookup=(collection,error)=>id=>{const x=store.data[collection].find(y=>y.id===id);if(!x)throw Error(error);return x;};
 const pending=new PendingChats(store,{reply:async(a,chatId,rootId,text)=>{replies.push([a.id,chatId,rootId,text]);},onBound:onBound||((...args)=>{bound.push(args);}),
  app:lookup('apps','应用不存在'),machine:lookup('machines','机器连接不存在'),bridgeUrl,now:()=>clock.now});
 return {dir,store,replies,bound,clock,pending,close(){fs.rmSync(dir,{recursive:true});}};
}
const firstDm={...inbound,chatType:'p2p',messageId:'om_first',content:'first private prompt'};
const form={name:'飞书私聊',machineId:'m',cwd:'~/work',kind:'claude',requireMention:true};
test('an unbound chat gets a pending record kept in memory only and one reply in the thread of its message with the binding link',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,firstDm);
  const [chat]=f.pending.list();assert.match(chat.token,/^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(chat,{token:chat.token,appId:'a',chatId:'oc_1',chatType:'p2p',createdAt:1000,expiresAt:1000+minutes(30)});
  assert.deepEqual(f.replies,[['a','oc_1','om_first',`这个聊天还没有连接到 Herdr，打开链接完成绑定：http://bridge.example:8080/?bind=${chat.token}`]]);
  assert.ok(!fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes('first private prompt'));assert.ok(!fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes(chat.token));
  await f.pending.open(allowed,{...firstDm,chatId:'oc_group',chatType:'group',messageId:'om_group'});assert.deepEqual(f.pending.list().map(c=>[c.chatId,c.chatType]),[['oc_1','p2p'],['oc_group','group']]);
 }finally{f.close();}
});
test('a chat with a live record gets no second reply and keeps its first message; once expired it gets a new token',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,firstDm);const [{token}]=f.pending.list();
  f.clock.now+=minutes(29);await f.pending.open(allowed,{...firstDm,messageId:'om_second',content:'second'});
  assert.equal(f.replies.length,1);assert.deepEqual(f.pending.list().map(c=>c.token),[token]);
  f.clock.now+=minutes(1);assert.deepEqual(f.pending.list(),[]);
  await f.pending.open(allowed,{...firstDm,messageId:'om_third',content:'third'});
  const [chat]=f.pending.list();assert.notEqual(chat.token,token);assert.equal(chat.createdAt,1000+minutes(30));assert.equal(f.replies.length,2);assert.equal(f.replies[1][2],'om_third');
  f.pending.bind({...form,token:chat.token});assert.equal(f.bound[0][2].messageId,'om_third');
 }finally{f.close();}
});
test('without BRIDGE_URL the reply points to the console instead of a link; a failed reply is logged',async()=>{
 const f=pendingFixture({bridgeUrl:''});try{
  await f.pending.open(allowed,firstDm);assert.deepEqual(f.replies.map(r=>r[3]),['这个聊天还没有连接到 Herdr，请在 Bridge 管理台「会话绑定」中完成绑定。']);
  f.pending.reply=async()=>{throw Error('飞书未连接');};await f.pending.open(allowed,{...firstDm,chatId:'oc_2'});
  assert.equal(f.pending.list().length,2);assert.equal(f.store.data.logs.at(-1).level,'error');assert.match(f.store.data.logs.at(-1).message,/飞书未连接/);
 }finally{f.close();}
});
test('BRIDGE_URL must be an http(s) origin; a trailing slash is dropped',()=>{
 for(const [v,origin] of [['http://bridge.example:8080/','http://bridge.example:8080'],['https://bridge.example','https://bridge.example'],['',''],[undefined,'']])assert.equal(consoleUrl(v),origin);
 for(const v of ['http://bridge.example/admin','http://bridge.example/?x=1','http://bridge.example/#a','ftp://bridge.example','bridge.example:8080','http://user:pw@bridge.example','not a url'])assert.throws(()=>consoleUrl(v),/BRIDGE_URL/,v);
});
test('binding a pending chat takes app and chat from the record, spends the token and hands the first message over without waiting',async()=>{
 const f=pendingFixture({onBound:(...args)=>{f.bound.push(args);return new Promise(()=>{});}});try{
  await f.pending.open(allowed,firstDm);await f.pending.open(allowed,{...firstDm,chatId:'oc_2',messageId:'om_other'});const [{token},other]=f.pending.list();
  const binding=f.pending.bind({...form,token,appId:'forged',chatId:'oc_forged'});
  const {id,...rest}=binding;assert.deepEqual(rest,{name:'飞书私聊',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:false,enabled:true});
  assert.deepEqual(new Store(f.dir).data.bindings,[binding]);assert.deepEqual(f.bound,[[f.store.data.apps[0],binding,firstDm]]);
  assert.deepEqual(f.pending.list().map(c=>c.token),[other.token]);
  assert.throws(()=>f.pending.bind({...form,token}),/^Error: 绑定链接已失效，请在飞书里重新发消息$/);
  for(const bad of [{token:'unknown'},{token:undefined},{}])assert.throws(()=>f.pending.bind({...form,...bad}),/绑定链接已失效/);
  // An invalid form or an unknown machine keeps the token for another try.
  assert.throws(()=>f.pending.bind({...form,token:other.token,cwd:'relative'}),/工作目录/);assert.throws(()=>f.pending.bind({...form,token:other.token,machineId:'gone'}),/机器连接不存在/);
  assert.deepEqual(f.pending.list().map(c=>c.token),[other.token]);assert.equal(f.store.data.bindings.length,1);
 }finally{f.close();}
});
test('a group binding keeps the mention choice; a chat whose app was removed cannot be bound',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,{...firstDm,chatType:'group',chatId:'oc_group'});
  assert.equal(f.pending.bind({...form,token:f.pending.list()[0].token}).requireMention,true);
  await f.pending.open(allowed,{...firstDm,chatType:'group',chatId:'oc_group2',messageId:'om_g2'});f.store.data.apps=[];
  assert.throws(()=>f.pending.bind({...form,token:f.pending.list()[0].token}),/应用不存在/);
 }finally{f.close();}
});

const png=Buffer.from('89504e470d0a1a0a0000','hex');
// A connected channel whose bot info comes from info(); every avatar download is answered by avatar(url).
function botFixture({info,avatar}={}){
 const requests=[],downloads=[];
 const channel={on(){},connect:async()=>{},disconnect:async()=>{},getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async o=>{requests.push(o);return info();}}};
 const f=platformFixture({channelFactory:()=>channel,fetch:async(url,options)=>{downloads.push(String(url));assert.ok(options.signal);return avatar(String(url));}});
 const a={id:'app-1',name:'注册时的名称',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:['ou_user'],enabled:true};f.store.data.apps=[a];f.store.save();
 return {...f,a,requests,downloads,file:path.join(f.dir,'avatars','app-1')};
}
const botInfo=(bot={})=>()=>({code:0,bot:{app_name:'飞书机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/avatar.png',...bot}});
test('connecting and verifying take the name and open_id from Feishu and store the https avatar',async()=>{
 const f=botFixture({info:botInfo(),avatar:()=>new Response(png,{headers:{'content-type':'image/png'}})});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'}]);assert.deepEqual(f.downloads,['https://cdn.example/avatar.png']);
  assert.equal(f.a.name,'飞书机器人');assert.equal(f.a.botOpenId,'ou_bot');assert.equal('botName' in f.a,false);assert.ok(f.a.verifiedAt>0);
  assert.deepEqual(fs.readFileSync(f.file),png);assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(f.a.avatar.type,'image/png');assert.ok(f.a.avatar.updatedAt>0);
  assert.deepEqual(new Store(f.dir).data.apps[0].avatar,f.a.avatar);assert.equal(f.platforms.status(f.a).connection,'connected');
  const avatar=await f.platforms.avatar('app-1');assert.deepEqual([avatar.type,avatar.body],['image/png',png]);
  f.requests.length=0;const jpeg=Buffer.from('ffd8ffe0','hex');
  f.platforms.fetch=async()=>new Response(jpeg,{headers:{'content-type':'image/jpeg; charset=binary'}});f.platforms.channel(f.a).rawClient.request=async o=>{f.requests.push(o);return {code:0,data:{bot:{app_name:'改名后的机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/new.jpg'}}};};
  assert.deepEqual(await f.platforms.verify(f.a),{verified:true,name:'改名后的机器人'});
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'}]);assert.equal(f.a.name,'改名后的机器人');assert.deepEqual(fs.readFileSync(f.file),jpeg);assert.equal(f.a.avatar.type,'image/jpeg');
 }finally{f.close();}
});
test('an avatar that is not https, over 1 MB or not an image is not stored; the old avatar and the connection stay',async()=>{
 const cases=[['http://cdn.example/a.png',()=>new Response(png,{headers:{'content-type':'image/png'}}),0],
  ['https://cdn.example/big.png',()=>new Response(Buffer.alloc(1024*1024+1),{headers:{'content-type':'image/png'}}),1],
  ['https://cdn.example/page',()=>new Response('<html>',{headers:{'content-type':'text/html'}}),1],
  ['https://cdn.example/missing',()=>new Response('no',{status:404,headers:{'content-type':'image/png'}}),1]];
 for(const [url,avatar,downloads] of cases){
  const f=botFixture({info:botInfo({avatar_url:url}),avatar});try{
   fs.mkdirSync(path.dirname(f.file));fs.writeFileSync(f.file,'old');const old={type:'image/png',updatedAt:1};f.a.avatar=old;
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',url);
   assert.equal(f.downloads.length,downloads,url);assert.equal(fs.readFileSync(f.file,'utf8'),'old',url);assert.deepEqual(f.a.avatar,old,url);assert.equal(f.a.name,'飞书机器人');
   assert.equal(f.store.data.logs.at(-1).level,'error',url);
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
   assert.equal(f.store.data.logs.at(-1).level,'error',type);assert.match(f.store.data.logs.at(-1).message,/头像/,type);
   const served=await f.platforms.avatar('app-1');assert.deepEqual([served.type,served.body.toString()],['image/png','old'],type);
  }finally{f.close();}
 }
});
test('a failed bot info request is only logged after connecting but fails a credential check',async()=>{
 const f=botFixture({info:()=>({code:99991663,msg:'invalid'}),avatar:()=>assert.fail('no download')});try{
  await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected');assert.equal(f.a.name,'注册时的名称');assert.equal(f.store.data.logs.at(-1).level,'error');
  await assert.rejects(f.platforms.verify(f.a),/应用凭证验证失败/);assert.equal(await f.platforms.avatar('app-1'),null);assert.equal(await f.platforms.avatar('../state.json'),null);
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
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_auto',client_secret:'private',user_info:{open_id:'ou_owner'}};},{connect:async a=>{assert.equal(new Store(f.store.dir).data.apps[0].appId,'cli_auto');assert.equal(f.registrations.status().status,'connecting');a.enabled=true;f.store.save();connected=true;}});
 try{f.registrations.start({});await f.registrations.current.done;assert.ok(connected);assert.equal(f.registrations.status().status,'completed');assert.equal(f.store.data.apps[0].enabled,true);}finally{f.close();}
});
test('existing app selection keeps its identity, bindings and allowlist',async()=>{
 const app=normalizeApp({name:'existing',appId:'cli_existing',appSecret:'saved',allowedUsers:['ou_existing']});let target;
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);ready(o);return {client_id:app.appId,client_secret:'sdk',user_info:{open_id:'ou_other'}};},{connect:async a=>{target=a;}});
 try{f.store.data.apps.push(app);f.store.data.bindings.push({appId:app.id});f.registrations.start({});await f.registrations.current.done;assert.equal(f.store.data.apps.length,1);assert.equal(target,app);assert.deepEqual(app.allowedUsers,['ou_existing']);assert.equal(f.registrations.status().appId,app.id);assert.equal(f.store.data.bindings[0].appId,app.id);}finally{f.close();}
});
test('connection failure retains the added app for retry without showing false success',async()=>{
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_failed',client_secret:'private',user_info:{open_id:'ou_owner'}};},{connect:async()=>{throw Error('private response');}});
 try{f.registrations.start({});await f.registrations.current.done;assert.equal(f.registrations.status().status,'connection_error');assert.equal(f.store.data.apps.length,1);assert.equal(f.registrations.status().appId,f.store.data.apps[0].id);assert.ok(!JSON.stringify(f.registrations.status()).includes('private'));}finally{f.close();}
});

test('channel startup and shutdown do not revive a cancelled connection',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lifecycle-'));let resolve,options;const handlers={};let closes=0;
 const channel={on:(name,fn)=>handlers[name]=fn,connect:()=>new Promise(r=>resolve=r),disconnect:async()=>{},rawWsClient:{close:()=>closes++},getConnectionStatus:()=>({state:'connected'})};
 const store=new Store(dir),messages=[],p=new Platforms(store,{onMessage:(...args)=>messages.push(args),channelFactory:o=>{options=o;return channel;}}),a={id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu',enabled:true};
 try{store.data.bindings=[route];const pending=p.start(a);const rejected=assert.rejects(pending,/连接失败/);assert.equal(options.safety.batch.text.delayMs,0);await p.stop(a.id);resolve();await rejected;assert.ok(closes>=2);assert.equal(p.runtime.has(a.id),false);handlers.message({...inbound,senderId:'ou_owner'});assert.deepEqual(messages,[]);}finally{fs.rmSync(dir,{recursive:true});}
});
test('the server lists pending chats, saves bindings only through a link token, serves app avatars and reports topics without message ids',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),agents=[{agent:'claude',pane_id:'w1:p1',agent_status:'idle',agent_session:{value:'s-1'}}];
 fs.mkdirSync(path.join(state,'avatars'),{recursive:true});fs.writeFileSync(path.join(state,'initialized'),'1');fs.writeFileSync(path.join(state,'avatars','app-avatar'),png);fs.writeFileSync(path.join(state,'avatars','app-gone'),png);
 const topic={bindingId:'b-old',appId:'x',chatId:'oc_9',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',error:'',messageIds:['om_1'],createdAt:1};
 const app={name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false};
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({apps:[{...app,id:'app-avatar',avatar:{type:'image/png',updatedAt:5}},{...app,id:'app-plain',appId:'cli_plain'},{...app,id:'app-gone',appId:'cli_gone',avatar:{type:'image/png',updatedAt:5}}],
  bindings:[{id:'b-old',appId:'x',machineId:'m',chatId:'oc_9'}],topics:[{...topic,id:'t1',state:'starting'},{...topic,id:'t2',bindingId:'b-keep',state:'ready'}]}));
 fs.writeFileSync(herdr,`#!/bin/sh\nif [ "$3" = agent ]; then echo '${JSON.stringify({result:{agents}})}'; else echo '{"result":{"panes":[{"pane_id":"w1:p1"}]}}'; fi\n`,{mode:0o700});
 const port=await new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
 const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1',BRIDGE_URL:'http://127.0.0.1:'+port+'/'},stdio:['ignore','pipe','inherit']});
 try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim();
  const api=async(p,body)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${p}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const machineId=(await api('machines/save',{name:'fake',type:'local',binary:herdr,enabled:true})).body.id;
  const input={token:'forged',name:'route',appId:'app-plain',machineId,chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:true};
  assert.deepEqual(await api('bindings/save',input),{status:400,body:{error:'绑定链接已失效，请在飞书里重新发消息'}});
  const s=(await api('state')).body;assert.deepEqual(Object.keys(s).sort(),['apps','bindings','host','logs','machines','pendingChats','registration','topics','version']);
  assert.deepEqual(s.pendingChats,[]);assert.deepEqual(s.bindings.map(b=>b.id),['b-old']);assert.deepEqual(s.apps[0].avatar,{type:'image/png',updatedAt:5});
  const {messageIds,...listed}={...topic,id:'t1',state:'failed',error:'Bridge 重启时 Agent 启动未完成'};assert.deepEqual(s.topics[0],listed);assert.equal('messageIds' in s.topics[1],false);
  assert.equal((await api('bindings/remove',{id:'b-old'})).status,200);assert.deepEqual((await api('state')).body.topics.map(t=>t.id),['t2']);
  const avatar=async(id,headers={authorization:'Bearer '+key})=>fetch(`http://127.0.0.1:${port}/api/apps/avatar?id=${encodeURIComponent(id)}`,{headers});
  const image=await avatar('app-avatar');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'private, max-age=300');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await avatar('app-avatar',{})).status,401);for(const id of ['app-plain','unknown','../state.json'])assert.equal((await avatar(id)).status,404,id);
  assert.equal((await api('apps/remove',{id:'app-gone'})).status,200);assert.equal(fs.existsSync(path.join(state,'avatars','app-gone')),false);assert.ok(fs.existsSync(path.join(state,'avatars','app-avatar')));
  assert.equal((await api('apps/remove',{id:'../avatars/app-avatar'})).status,400);assert.ok(fs.existsSync(path.join(state,'avatars','app-avatar')));
  const [m]=(await api('state')).body.machines;assert.equal(m.state,'connected');assert.deepEqual(m.agents,agents);assert.deepEqual(m.panes,[{pane_id:'w1:p1'}]);
  assert.deepEqual(Object.keys(m).sort(),['agents','binary','checkedAt','enabled','host','id','name','panes','port','session','state','type']);
  assert.equal((await api('machines/install',{id:machineId})).status,404);
 }finally{server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true});}
});
test('the server refuses to start with a BRIDGE_URL that is not an http(s) origin',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-'));try{
  const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:dir,PORT:'0',BIND:'127.0.0.1',BRIDGE_URL:'http://bridge.example/admin'},stdio:['ignore','pipe','pipe']});
  let err='';server.stderr.on('data',d=>{err+=d;});const timer=setTimeout(()=>server.kill(),5000);const code=await new Promise(r=>server.once('exit',r));clearTimeout(timer);
  assert.notEqual(code,0);assert.match(err,/BRIDGE_URL/);assert.equal(fs.existsSync(path.join(dir,'access-key')),false);
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('SDK cache isolates apps and honors namespaces and absolute expiry',async()=>{const a=channelCache(),b=channelCache();await a.set('same','seen',Date.now()+60000,{namespace:'dedup'});assert.equal(await a.get('same',{namespace:'dedup'}),'seen');assert.equal(await b.get('same',{namespace:'dedup'}),undefined);assert.equal(await a.get('same',{namespace:'token'}),undefined);await a.set('expired','old',Date.now()-1);assert.equal(await a.get('expired'),undefined);});

test('static files map the two pages and hashed assets and reject every other path',()=>{
 const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),html='text/html; charset=utf-8';
 assert.deepEqual(staticFile('/'),{file:path.join(dist,'index.html'),type:html,immutable:false});assert.deepEqual(staticFile('/connect'),{file:path.join(dist,'connect.html'),type:html,immutable:false});
 for(const [name,type] of [['index-AbC_1.js','text/javascript; charset=utf-8'],['index-x.css','text/css; charset=utf-8'],['mark.svg','image/svg+xml'],['qr.png','image/png'],['font.woff2','font/woff2']])assert.deepEqual(staticFile('/assets/'+name),{file:path.join(dist,'assets',name),type,immutable:true});
 for(const p of ['/index.html','/connect.html','/connect/','/app.js','/style.css','/assets/','/assets/x.map','/assets/x.html','/assets/x.json','/assets/x.JS','/assets/..','/assets/.js','/assets/../server.mjs','/assets/..%2Fserver.mjs','/assets/sub/x.js','/assets/x.js/','/api/state','/health'])assert.equal(staticFile(p),null,p);
});
test('static responses: pages return 503 before the build, missing assets 404, hashed assets are immutable',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-web-')),dist=path.join(root,'dist');
 const send=async p=>{const r={};await sendStatic({writeHead(code,headers){r.code=code;r.headers=headers;},end(body){r.body=String(body??'');}},staticFile(p,dist));return r;};
 try{
  for(const p of ['/','/connect']){const r=await send(p);assert.equal(r.code,503);assert.equal(r.body,'前端尚未构建，运行 npm run build');}
  assert.equal((await send('/assets/index-a.js')).code,404);
  fs.mkdirSync(path.join(dist,'assets'),{recursive:true});fs.writeFileSync(path.join(dist,'index.html'),'<!doctype html>');fs.writeFileSync(path.join(dist,'assets','index-a.js'),'export{}');
  const page=await send('/');assert.equal(page.code,200);assert.equal(page.body,'<!doctype html>');assert.equal(page.headers['Content-Type'],'text/html; charset=utf-8');assert.equal(page.headers['Cache-Control'],'no-cache');
  const asset=await send('/assets/index-a.js');assert.equal(asset.code,200);assert.equal(asset.body,'export{}');assert.equal(asset.headers['Cache-Control'],'public, max-age=31536000, immutable');
  assert.equal((await send('/assets/index-b.js')).code,404);assert.equal((await send('/connect')).code,404);
 }finally{fs.rmSync(root,{recursive:true});}
});
test('built admin pages load only files the server serves and stay within the CSP',()=>{
 const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),read=f=>fs.readFileSync(path.join(dist,f),'utf8'),assets=fs.readdirSync(path.join(dist,'assets'));
 for(const name of assets)assert.ok(staticFile('/assets/'+name),`dist/assets/${name} cannot be served`);
 for(const html of ['index.html','connect.html']){
  const page=read(html);assert.doesNotMatch(page,/\sstyle=|<style|<script(?![^>]*\ssrc=)|<[a-z][^>]*\son[a-z]+=/i,html+' has an inline style, script or event handler');
  const urls=[...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map(m=>m[1]).filter(u=>!u.startsWith('#')&&!u.startsWith('data:image/'));assert.ok(urls.some(u=>u.endsWith('.js'))&&urls.some(u=>u.endsWith('.css')),html+' loads no script or stylesheet');
  for(const url of urls){const asset=staticFile(url);assert.ok(asset&&fs.existsSync(asset.file),`${html} loads ${url}, which the server does not serve`);}
 }
 for(const name of assets.filter(n=>n.endsWith('.css'))){const css=read('assets/'+name);assert.doesNotMatch(css,/@import/,name);for(const [,url] of css.matchAll(/url\(\s*['"]?([^'")\s]+)/g))assert.match(url,/^(?:data:image\/svg\+xml|\/assets\/)/,`${name} loads ${url}`);}
 for(const name of assets.filter(n=>n.endsWith('.js'))){const js=read('assets/'+name);for(const [,from,dynamic] of js.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)){const spec=from??dynamic,file=spec.replace(/^\.\//,'');assert.ok(/^[\w.-]+\.js$/.test(file)&&assets.includes(file),`${name} imports ${spec}`);}}
});
