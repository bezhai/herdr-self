import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import net from 'node:net';
import {normalizeMachine,remoteInvocation,herdr,makeDirectory,quote,Store} from './core.mjs';import {normalizeApp,normalizeBinding,setPermissionMode,routable,Platforms,channelCache} from './platform.mjs';import {Topics} from './topics.mjs';
import {PendingChats,consoleUrl} from './pending-chats.mjs';
import {check} from './request-cards.mjs';import {nameOf} from './adoption.mjs';
import {Registrations} from './registration.mjs';import {staticFile,sendStatic} from './web-assets.mjs';import {fileURLToPath} from 'node:url';
import {normalize} from '@larksuite/channel';

function platformFixture(options){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-platform-')),store=new Store(dir),messages=[],unbound=[];return {dir,store,messages,unbound,platforms:new Platforms(store,{onMessage:(...args)=>messages.push(args),onUnbound:(...args)=>unbound.push(args),...options}),close(){fs.rmSync(dir,{recursive:true});}};}
const route={id:'b',name:'个人助手',enabled:true,appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:false};
const inbound={senderType:'user',senderId:'ou_user',chatId:'oc_1',messageId:'om_1',rawContentType:'text',content:'private prompt'};
const allowed={id:'a',name:'bot',enabled:true,allowedUsers:['ou_user']};
const plainText=content=>({tag:'div',text:{tag:'plain_text',content}});
// What Bridge posts into a thread besides request and adoption cards: cards without a header whose summary, which the chat list and
// notifications show, is the beginning of the text, the whole text unless given. A notice shows plain text, a reply its markdown in the
// full width.
const untitledOf=(summary,elements,config)=>({schema:'2.0',config:{...config,summary:{content:summary}},body:{elements}});
const notice=(text,summary=text)=>({card:untitledOf(summary,[plainText(text)])});
const replyOf=(text,summary=text,...after)=>({card:untitledOf(summary,[{tag:'markdown',content:text},...after],{width_mode:'fill'})});
const markdownIn=card=>card.body.elements[0].content;
// What a reply that Herdr cut ends with.
const truncatedNote=plainText('（回复过长，已截断，完整内容请在 Herdr 中查看）');
function registrationFixture(register,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-registration-')),store=new Store(dir);
 const registrations=new Registrations(store,{register,qr:async()=>'data:image/png;base64,test',...options});
 return {store,registrations,close(){registrations.stop();fs.rmSync(dir,{recursive:true});}};
}
const ready=o=>o.onQRCodeReady({url:'https://open.feishu.cn/page/launcher?user_code=test',expireIn:600});
test('registration stores credentials server-side, uses minimal bot scopes and allows only the creator',async()=>{
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);assert.equal(o.addons.preset,false);assert.equal(o.addons.scopes.user,undefined);assert.deepEqual(o.addons.events.items.tenant,['im.message.receive_v1']);
  assert.deepEqual(o.addons.scopes.tenant,['im:message:send_as_bot','im:message.p2p_msg:readonly','im:message.group_at_msg:readonly','application:bot.basic_info:read','im:message.reactions:write_only','application:app_slash_command:read','application:app_slash_command:write']);ready(o);return {client_id:'cli_test',client_secret:'private-test-secret',user_info:{open_id:'ou_owner',tenant_brand:'feishu'}};});
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
 const m=normalizeMachine({name:'test',host:'user@host',binary:'~/.local/bin/herdr'});const [bin,args]=remoteInvocation(m,[{path:m.binary},'--session','default','agent','prompt','w1:p1',"x'; echo hacked"]);assert.equal(bin,'ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('--'));assert.match(args.at(-1),/sh -c/);
 const shell=command=>'env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c '+quote(command);
 assert.equal(args.at(-1),shell(`"$HOME"/'.local/bin/herdr' '--session' 'default' 'agent' 'prompt' 'w1:p1' 'x'\\''; echo hacked'`));
 const remote=remoteInvocation(m,[{path:m.binary},'tab','create','--cwd',{path:'~/w x'},'--label','~/not-a-path'])[1].at(-1);assert.ok(remote.includes(quote(`"$HOME"/'w x'`).slice(1,-1)));assert.ok(remote.includes(quote(quote('~/not-a-path')).slice(1,-1)));
 // The program is a command name or a {path}; only {path} expands ~/, on the target machine.
 assert.equal(remoteInvocation(m,['mkdir','-p','--',{path:'~/w x'}])[1].at(-1),shell(`'mkdir' '-p' '--' "$HOME"/'w x'`));
 assert.equal(remoteInvocation(m,['mkdir;id','--',{path:"/srv/a'b"}])[1].at(-1),shell(`'mkdir;id' '--' '/srv/a'\\''b'`));
 const local=normalizeMachine({name:'local',type:'local',binary:'~/bin/herdr'});assert.deepEqual(remoteInvocation(local,[{path:local.binary},'--cwd',{path:'~/w x'},{path:'/srv'},'~/text']),[os.homedir()+'/bin/herdr',['--cwd',os.homedir()+'/w x','/srv','~/text']]);
 assert.deepEqual(remoteInvocation(local,['mkdir','-p','--',{path:'~/w x'}]),['mkdir',['-p','--',os.homedir()+'/w x']]);assert.deepEqual(remoteInvocation(local,[{path:'/opt/herdr'}]),['/opt/herdr',[]]);
 assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',session:'../default'}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',port:-1}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',binary:'herdr'}),/Herdr 路径/);
});
test('a binding routes the pending chat of an app to a working directory and agent kind on a machine; app and chat never come from the client',()=>{
 const chat={token:'t',appId:'a',chatId:'oc_1',chatType:'group'},input={name:'助手',appId:'forged',chatId:'oc_forged',machineId:'m',cwd:'~/code/x',kind:'codex',requireMention:false};
 const {id,...b}=normalizeBinding({...input,rootId:'om_1',paneId:'w1:p1'},chat,[]);assert.match(id,/^[0-9a-f-]{36}$/);assert.deepEqual(b,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'codex',requireMention:false,enabled:true});
 assert.equal(normalizeBinding({...input,requireMention:undefined},chat,[]).requireMention,true);assert.equal(normalizeBinding({...input,cwd:'/srv/app',kind:'claude'},chat,[]).cwd,'/srv/app');
 for(const requireMention of [true,undefined])assert.equal(normalizeBinding({...input,requireMention},{...chat,chatType:'p2p'},[]).requireMention,false);
 for(const cwd of ['relative','/a b','~/$(id)','/x;y','',undefined])assert.throws(()=>normalizeBinding({...input,cwd},chat,[]));assert.throws(()=>normalizeBinding({...input,cwd:'work'},chat,[]),/工作目录/);
 for(const kind of ['claude','codex','agy'])assert.equal(normalizeBinding({...input,kind},chat,[]).kind,kind);
 for(const kind of ['bash','antigravity','Agy','',undefined])assert.throws(()=>normalizeBinding({...input,kind},chat,[]),/^Error: Agent 类型无效$/,String(kind));
 assert.throws(()=>normalizeBinding(input,chat,[{appId:'a',chatId:'oc_1'}]),/该聊天已有绑定/);assert.equal(normalizeBinding(input,chat,[{appId:'other',chatId:'oc_1'},{appId:'a',chatId:'oc_2'}]).chatId,'oc_1');
});
test('a Claude binding has the permission mode default or auto, default when none is given; Codex and Antigravity bindings have none',()=>{
 const chat={token:'t',appId:'a',chatId:'oc_1',chatType:'group'},input={name:'助手',machineId:'m',cwd:'~/code/x',kind:'claude'};
 const {id,...b}=normalizeBinding(input,chat,[]);assert.deepEqual(b,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'claude',permissionMode:'default',requireMention:true,enabled:true});
 for(const permissionMode of ['default','auto'])assert.equal(normalizeBinding({...input,permissionMode},chat,[]).permissionMode,permissionMode);
 for(const permissionMode of ['acceptEdits','plan','bypassPermissions','dontAsk','AUTO',1])assert.throws(()=>normalizeBinding({...input,permissionMode},chat,[]),/^Error: 权限模式无效$/,String(permissionMode));
 for(const kind of ['codex','agy'])for(const permissionMode of [undefined,'auto','bypassPermissions'])assert.equal('permissionMode' in normalizeBinding({...input,kind,permissionMode},chat,[]),false,kind+' '+permissionMode);
 const {id:agyId,...agy}=normalizeBinding({...input,kind:'agy',permissionMode:'auto'},chat,[]);assert.deepEqual(agy,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'agy',requireMention:true,enabled:true});
});
test('changing the permission mode of a Claude binding changes that field only; Codex and Antigravity bindings and other modes are refused',()=>{
 const claude={...route},codex={...route,kind:'codex'},agy={...route,kind:'agy'};
 setPermissionMode(claude,'auto');assert.deepEqual(claude,{...route,permissionMode:'auto'});setPermissionMode(claude,'default');assert.deepEqual(claude,{...route,permissionMode:'default'});
 for(const mode of ['bypassPermissions','plan','',undefined])assert.throws(()=>setPermissionMode(claude,mode),/^Error: 权限模式无效$/);assert.equal(claude.permissionMode,'default');
 for(const other of [codex,agy]){const before={...other};assert.throws(()=>setPermissionMode(other,'auto'),/^Error: 只有 Claude 绑定可以设置权限模式$/,other.kind);assert.deepEqual(other,before);}
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
test('platform channels listen for messages, card clicks and connection events only, take clicks in their own queue and never retry a send',()=>{
 let options;const handlers={},f=platformFixture({channelFactory:o=>{options=o;return {on:(name,fn)=>{handlers[name]=fn;}};}});
 try{f.platforms.channel({id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu'});
 assert.deepEqual(Object.keys(handlers).sort(),['cardAction','error','message','reconnected','reconnecting']);assert.deepEqual(options.outbound,{retry:{maxAttempts:1}});
 // A click must not wait behind the chat's messages.
 assert.deepEqual(options.safety.chatQueue,{enabled:true,mergeWhileBusy:false,cardActions:'separate'});}finally{f.close();}
});
test('replies go into the topic thread as cards, resolve to their message id and fail without a connected channel; cards are updated the same way',async()=>{
 const f=platformFixture(),sent=[],updates=[];try{
  await assert.rejects(f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0'}}),/飞书未连接/);await assert.rejects(f.platforms.updateCard(allowed,'om_card',{schema:'2.0'}),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),send:async(...args)=>{sent.push(args);return {messageId:'om_r'+sent.length};},updateCard:async(...args)=>{updates.push(args);}}});
  assert.equal(await f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0'}}),'om_r1');assert.equal(await f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0',body:{}}}),'om_r2');
  assert.deepEqual(sent,[['oc_1',{card:{schema:'2.0'}},{replyTo:'om_1',replyInThread:true}],['oc_1',{card:{schema:'2.0',body:{}}},{replyTo:'om_1',replyInThread:true}]]);
  assert.equal(await f.platforms.updateCard(allowed,'om_r2',{schema:'2.0',body:{}}),undefined);assert.deepEqual(updates,[['om_r2',{schema:'2.0',body:{}}]]);
 }finally{f.close();}
});
test('a card click reaches the card handler with its app, whose answer goes back to Feishu; people outside the allowlist and clicks on a disabled app get a toast',()=>{
 const handlers={},clicks=[],f=platformFixture({channelFactory:()=>({on:(name,fn)=>{handlers[name]=fn;}}),onCardAction:(...args)=>{clicks.push(args);return {toast:{type:'info',content:'正在提交'}};}});
 try{
  const a={...allowed,appId:'cli_test',appSecret:'private',domain:'feishu'};f.platforms.channel(a);
  const click=openId=>({messageId:'om_card',chatId:'oc_1',operator:{openId},action:{tag:'button',value:{request:1}}});
  assert.deepEqual(handlers.cardAction(click('ou_user')),{toast:{type:'info',content:'正在提交'}});assert.deepEqual(clicks,[[a,click('ou_user')]]);
  const refused={toast:{type:'error',content:'你不在这个应用的允许名单中，不能处理这个请求'}};
  assert.deepEqual(handlers.cardAction(click('ou_other')),refused);assert.deepEqual(handlers.cardAction({...click('ou_user'),operator:undefined}),refused);
  a.enabled=false;assert.deepEqual(handlers.cardAction(click('ou_user')),refused);assert.equal(clicks.length,1);
 }finally{f.close();}
});
test('message reactions are added and removed through the connected channel and fail without one',async()=>{
 const f=platformFixture(),calls=[];try{
  await assert.rejects(f.platforms.react(allowed,'om_1','OneSecond'),/飞书未连接/);await assert.rejects(f.platforms.unreact(allowed,'om_1','r_1'),/飞书未连接/);
  const channel={getConnectionStatus:()=>({state:'reconnecting'}),addReaction:async(...args)=>{calls.push(['add',...args]);return 'r_1';},removeReaction:async(...args)=>{calls.push(['remove',...args]);}};
  f.platforms.runtime.set('a',{channel});
  await assert.rejects(f.platforms.react(allowed,'om_1','OneSecond'),/飞书未连接/);await assert.rejects(f.platforms.unreact(allowed,'om_1','r_1'),/飞书未连接/);assert.deepEqual(calls,[]);
  channel.getConnectionStatus=()=>({state:'connected'});
  assert.equal(await f.platforms.react(allowed,'om_1','OneSecond'),'r_1');assert.equal(await f.platforms.unreact(allowed,'om_1','r_1'),undefined);
  assert.deepEqual(calls,[['add','om_1','OneSecond'],['remove','om_1','r_1']]);
 }finally{f.close();}
});
test('a start failure with a local path and an English Herdr error keeps them out of the Feishu notice',async()=>{
 const f=topicFixture(),raw='no herdr server is running at /home/someone/.config/herdr/herdr.sock; run `herdr server`';try{
  f.h.on['workspace list']=()=>{throw Error(raw);};await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);assert.ok(f.replies.every(r=>!JSON.stringify(r[3]).includes('/home/')&&!JSON.stringify(r[3]).includes('herdr server')));
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
  ` text) echo 'not json';;`,
  ` *) echo '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 const m=normalizeMachine({name:'local',type:'local',binary:bin});
 try{
  assert.deepEqual(await herdr(m,['agent','list']),{type:'agent_list',agents:[]});
  await assert.rejects(herdr(m,['blocked']),e=>e.code==='agent_blocked'&&e.message==='agent w1:p1 is blocked');
  await assert.rejects(herdr(m,['usage']),e=>e.code===undefined&&/requires text/.test(e.message));
  await assert.rejects(herdr(m,['slow'],{timeoutMs:100}),/连接超时/);assert.deepEqual(await herdr(m,['slow'],{timeoutMs:5000}),{type:'ok'});
  assert.deepEqual(await herdr(m,['cwd','--cwd',{path:'~/work'},'~/work']),{cwd:os.homedir()+'/work',text:'~/work'});
  await assert.rejects(herdr(m,['text']),/^Error: 远程服务未返回有效 JSON$/);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('makeDirectory creates nested directories on a local machine, succeeds again when they exist and reports what mkdir says on failure',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-mkdir-')),target=path.join(dir,'a','b','c'),m=normalizeMachine({name:'local',type:'local'});
 try{
  await makeDirectory(m,target);assert.ok(fs.statSync(target).isDirectory());
  await makeDirectory(m,target);assert.ok(fs.statSync(target).isDirectory());
  fs.writeFileSync(path.join(dir,'file'),'');await assert.rejects(makeDirectory(m,path.join(dir,'file','x')),/mkdir/);
 }finally{fs.rmSync(dir,{recursive:true});}
});

const coded=(code,message)=>Object.assign(Error(message),{code});
// In-memory Herdr: records every CLI call; h.on['<group> <verb>'] replaces the next such call and may call run(args) for the default result.
// Agents start idle with state_change_seq 1; a prompt returns the agent as it is.
// h.retained[paneId] holds the replies Herdr keeps for the agent of that pane. h.made records every makeDirectory as [machine id, path].
// h.requests[paneId] holds the requests the agent of that pane waits on; an answer removes its request.
// `pane remote-answers <pane> on|off` sets or clears remote_answers on the agent of that pane; turning it on for a pane without an agent fails.
// `api snapshot` returns the agents with h.workspaces, h.tabs and h.panes, the entries that only carry what Bridge reads (ids and labels).
// h.hosts[machine id], when present, is another machine with its own agents, retained replies and requests; every call to a host with
// down fails with that message. h.toolCalls[paneId] holds the tool call records Herdr keeps for the agent of that pane; `agent send-keys`
// only succeeds.
function fakeHerdr(){
 const h={calls:[],timeouts:[],machines:[],workspaces:[],tabs:[],panes:[],agents:[],retained:{},requests:{},toolCalls:{},hosts:{},made:[],created:0,opened:0,on:{}};
 const run=(args,host=h)=>{
  const [group,verb]=args;
  if(group==='workspace'&&verb==='list')return {type:'workspace_list',workspaces:h.workspaces};
  if(group==='workspace'&&verb==='create'){const id='w'+ ++h.created,n=++h.opened;h.workspaces.push({workspace_id:id,label:args[5]});return {type:'workspace_created',workspace:{workspace_id:id},tab:{tab_id:`${id}:t${n}`},root_pane:{pane_id:`${id}:p${n}`}};}
  if(group==='tab'&&verb==='rename')return {type:'tab_info',tab:{tab_id:args[2],label:args[3]}};
  if(group==='tab'&&verb==='create'){const n=++h.opened;return {type:'tab_created',tab:{tab_id:`${args[3]}:t${n}`},root_pane:{pane_id:`${args[3]}:p${n}`}};}
  if(group==='agent'&&verb==='start'){const agent={name:args[2],agent:args[4],pane_id:args[6],agent_status:'idle',state_change_seq:1};h.agents.push(agent);return {type:'agent_started',agent,argv:[args[4]]};}
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
  if(group==='pane'&&verb==='remote-answers'){
   const agent=host.agents.find(a=>a.pane_id===args[2]);if(args[3]==='on'&&!agent)throw coded('agent_not_found',`pane ${args[2]} has no agent`);
   if(agent){if(args[3]==='on')agent.remote_answers=true;else delete agent.remote_answers;}return {type:'ok'};
  }
  throw Error('unexpected herdr '+args.join(' '));
 };
 h.herdr=async(m,args,options={})=>{
  h.calls.push(args);h.timeouts.push(options.timeoutMs);h.machines.push(m.id);await null;const host=h.hosts[m.id]||h;if(host.down)throw Error(host.down);
  const key=args[0]+' '+args[1],hook=h.on[key];if(hook){delete h.on[key];return hook(args,a=>run(a,host));}return run(args,host);
 };
 h.makeDirectory=async(m,dir)=>{h.made.push([m.id,dir]);await null;};
 return h;
}
// Calls as [machine id, ...args].
const callsOn=f=>f.h.calls.map((c,i)=>[f.h.machines[i],...c]);
const cotPath='/open-apis/im/v1/message_cot';
// The binding's machine m is cpu2; machines are further machines of the store. f.api records the Feishu OpenAPI requests of the topics,
// the COT calls: a COT is created as c<n> in message om_cot_<n>. With cot false Feishu refuses every request, like for an app without the
// scope. restart() reads the state file into a new Topics with the same fakes, as after a Bridge restart.
function topicFixture({binding,machine,machines=[],cot=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-')),store=new Store(dir),h=fakeHerdr(),replies=[],reacted=[],unreacted=[],updated=[],api=[],m={id:'m',name:'cpu2',enabled:true,...machine};
 store.data.machines=[m,...machines];store.data.bindings=[{...route,...binding}];store.save();const b=store.data.bindings[0];let sent=0,cots=0;
 // Every reply resolves to the next message id om_bot_<n>.
 const deps={herdr:h.herdr,makeDirectory:h.makeDirectory,machine:id=>{const x=store.data.machines.find(y=>y.id===id);if(!x)throw Error('机器连接不存在');return x;},app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},
  reply:async(a,chatId,rootId,content)=>{replies.push([a.id,chatId,rootId,content]);return 'om_bot_'+ ++sent;},
  react:async(a,messageId,emojiType)=>{reacted.push([a.id,messageId,emojiType]);return 'r_'+messageId;},unreact:async(a,messageId,reactionId)=>{unreacted.push([a.id,messageId,reactionId]);},
  updateCard:async(a,messageId,card)=>{updated.push([a.id,messageId,card]);},
  request:async(a,o)=>{api.push(o);await null;if(!cot)throw Object.assign(Error('飞书接口错误 99991672：Access denied'),{code:99991672});return o.method==='POST'&&o.url===cotPath?{cot_id:'c'+ ++cots,message_id:'om_cot_'+cots}:{};}};
 const topics=new Topics(store,deps);
 const send=msg=>topics.handle(allowed,b,{senderType:'user',senderId:'ou_user',chatId:'oc_1',rawContentType:'text',...msg});
 const restart=()=>{const s=new Store(dir);return {store:s,topics:new Topics(s,deps)};};
 return {dir,store,h,m,topics,replies,reacted,unreacted,updated,api,b,send,restart,close(){fs.rmSync(dir,{recursive:true});}};
}
// The COT calls of fixture f in order: ['create', message the COT answers], ['update', cot id, ...[event type, event]] and ['complete', cot
// id, reason].
const cotLog=f=>f.api.map(o=>o.method==='PUT'?['update',o.data.cot_id,...o.data.events.map(e=>[e.event_type,JSON.parse(e.content)])]
 :o.url.startsWith(cotPath+'/complete/')?['complete',o.url.slice(cotPath.length+'/complete/'.length),o.params.reason]:['create',o.data.origin_message_id]);
const cotLogs=f=>f.store.data.logs.filter(l=>l.kind==='执行过程').map(l=>[l.level,l.message]);
// An agent list with the agents of fixture f as they are, changed by fields.
const list=(f,fields)=>f.h.agents.map(a=>({...a,...fields}));
const later=ms=>new Promise(r=>setTimeout(r,ms));
test('a new topic creates the binding workspace, names its root tab after the topic, starts the agent there with a longer timeout, turns on remote answers for its pane and prompts it',async()=>{
 const f=topicFixture(),text='请帮我修复登录页在移动端点击提交按钮后没有任何反应的问题',title=text.slice(0,24);try{
  await f.send({messageId:'om_1',content:' '+text+'\n'});
  const [t]=f.store.data.topics,{id,agentName,createdAt,...rest}=t;
  assert.equal(agentName,'feishu-'+id.slice(0,8));assert.match(agentName,/^feishu-[0-9a-f]{8}$/);assert.ok(createdAt>0);
  assert.deepEqual(f.h.calls,[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w1:t1',title],['agent','start',agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1',text]]);
  assert.deepEqual(f.h.timeouts,[undefined,undefined,undefined,70000,undefined,undefined]);assert.deepEqual([...new Set(f.h.machines)],['m']);assert.equal(f.h.agents[0].remote_answers,true);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',title,state:'ready',error:'',messageIds:['om_1'],replySeq:0,reactions:[],cards:[],
   cot:{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false}});
  assert.equal(new Store(f.dir).data.bindings[0].workspaceId,'w1');assert.equal(new Store(f.dir).data.topics[0].state,'ready');
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
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1','om_2','om_3']);assert.deepEqual(f.store.data.topics.map(t=>[t.cot.origin,t.reactions.map(r=>r.messageId)]),[['om_1',['om_3']],['om_2',[]]]);
 }finally{f.close();}
});
test('a Claude binding starts each topic agent with -- --permission-mode and its mode, default when the binding has none; a Codex binding starts its agent with -- --no-daemon; an Antigravity binding passes nothing on',async()=>{
 for(const [binding,args] of [[{},['--','--permission-mode','default']],[{permissionMode:'default'},['--','--permission-mode','default']],[{permissionMode:'auto'},['--','--permission-mode','auto']],[{kind:'codex'},['--','--no-daemon']],[{kind:'agy'},[]]]){
  const f=topicFixture({binding});try{
   await f.send({messageId:'om_1',content:'one'});
   assert.deepEqual(f.h.calls.filter(c=>c[1]==='start'),[['agent','start',f.store.data.topics[0].agentName,'--kind',f.b.kind,'--pane','w1:p1','--timeout','60000',...args]],JSON.stringify(binding));
  }finally{f.close();}
 }
});
test('a changed permission mode applies to the topics opened afterwards; a running topic keeps its agent',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});setPermissionMode(f.b,'auto');
  await f.send({messageId:'om_2',rootId:'om_1',content:'more'});await f.send({messageId:'om_3',content:'two'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='start').map(c=>c.slice(-3)),[['--','--permission-mode','default'],['--','--permission-mode','auto']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[2]),['w1:p1','w1:p1','w1:p2']);
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
test('each new topic creates its working directory on the machine before any workspace call, whether it creates the workspace or a tab in it',async()=>{
 const f=topicFixture();try{
  const seen=[],before=(args,run)=>{seen.push([...f.h.made]);return run(args);};
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
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.match(f.store.data.logs.at(-1).message,/启动失败.*Permission denied/);
 }finally{f.close();}
});
test('a topic whose named agent is gone is closed with one notice and gets no further prompts',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});
  f.h.agents.splice(0,1,{name:'someone-else',pane_id:'w1:p1',agent_status:'idle'});f.h.calls.length=0;f.replies.length=0;
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
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);assert.match(f.store.data.logs.at(-1).message,/agent target pane w1:p1 is not an available shell/);assert.equal(f.h.calls.some(c=>c[1]==='prompt'),false);
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
test('requireMention applies only to the message that opens a topic',async()=>{
 const f=topicFixture({binding:{requireMention:true}});try{
  await f.send({messageId:'om_1',content:'no mention'});assert.deepEqual([f.store.data.topics.length,f.h.calls.length],[0,0]);
  await f.send({messageId:'om_2',content:'with mention',mentionedBot:true});await f.send({messageId:'om_3',rootId:'om_2',content:'follow-up'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['with mention','follow-up']);
 }finally{f.close();}
});
test('topics still starting when Bridge restarts are marked failed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-'));try{
  const store=new Store(dir);store.data.topics=[{id:'t1',state:'starting',error:''},{id:'t2',state:'ready',error:''},{id:'t3',state:'choosing',error:'',adopted:{picker:'om_card'}}];store.save();
  new Topics(new Store(dir),{herdr:async()=>{},machine:()=>{},reply:async()=>{}});
  assert.deepEqual(new Store(dir).data.topics.map(t=>[t.state,t.error]),[['failed','Bridge 重启时 Agent 启动未完成'],['ready',''],['choosing','']]);
 }finally{fs.rmSync(dir,{recursive:true});}
});

// A ready topic whose agent runs in w1:p1, with the COT c1 of its first message om_1 open unless the fixture options refuse it;
// snapshot(seq) is an agent list in which that agent reports reply_seq seq.
async function readyTopic(options){
 const f=topicFixture(options);await f.send({messageId:'om_1',content:'one'});f.h.calls.length=0;f.replies.length=0;f.api.length=0;
 return {...f,t:f.store.data.topics[0],snapshot:reply_seq=>f.h.agents.map(a=>({...a,reply_seq}))};
}
const forwarded=f=>f.store.data.logs.filter(l=>l.kind==='回复转发').map(l=>[l.level,l.message]);
test('new replies of a topic agent are fetched after the stored seq and sent in order into its thread as cards without a header, whose summary is the beginning of the reply with its whitespace collapsed; a topic without a seq counts from 0',async()=>{
 const f=await readyTopic();try{
  delete f.t.replySeq;f.h.retained['w1:p1']=[{seq:1,text:'**第一条**'},{seq:2,text:'第二条\n\n- 列表'}];
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
  await f.topics.sync(f.m,f.snapshot(3));await f.topics.sync(f.m,f.h.agents);delete f.t.replySeq;await f.topics.sync(f.m,f.h.agents);
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
  const seen=[];f.topics.reply=async(a,chatId,rootId,{card})=>{seen.push([markdownIn(card),new Store(f.dir).data.topics[0].replySeq]);if(markdownIn(card)==='一')throw Error('飞书未连接');};
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
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','2']]);assert.deepEqual(f.replies.at(-1)[3],replyOf('快照之后'));
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
const requestBytes=card=>Buffer.byteLength(JSON.stringify({content:JSON.stringify(card),msg_type:'interactive',reply_in_thread:true}));
test('a reply too large for one card goes out as several cards in order, each request within 30 KB however much its text grows when serialized twice; a code block split between cards is closed and opened again with its info string, a line too long for a card is cut, and only the last card has the truncation note',async()=>{
 const f=await readyTopic();try{
  // Serialized twice, a quote or backslash takes 4 bytes and a CJK character 3.
  const code=Array.from({length:700},(_,i)=>`const path${i} = "C:\\\\路径\\\\${i}";`),long='"'.repeat(12000);
  const text=['开头的说明','```ts',...code,'```','代码之后',long,'结尾'].join('\n');assert.ok(Buffer.byteLength(text)<=64*1024);
  f.h.retained['w1:p1']=[{seq:1,text,truncated:true}];await f.topics.sync(f.m,f.snapshot(1));
  const cards=f.replies.map(r=>r[3].card),parts=cards.map(markdownIn),lines=parts.flatMap(p=>p.split('\n'));
  assert.ok(cards.length>2);assert.deepEqual([f.t.replySeq,forwarded(f)],[1,[['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]]);
  for(const [i,card] of cards.entries()){
   assert.ok(requestBytes(card)<=30000,`card ${i}: ${requestBytes(card)} bytes`);assert.equal(card.header,undefined);assert.equal(card.config.width_mode,'fill');
   const summary=card.config.summary.content;assert.ok([...summary].length<=100&&parts[i].replace(/\s+/g,' ').trim().startsWith(summary.replace(/…$/,'')),`card ${i}: ${summary}`);
   // Every card opens and closes its code blocks.
   assert.equal(parts[i].split('\n').filter(l=>l.startsWith('```')).length%2,0,`card ${i}`);
   assert.deepEqual(card.body.elements.slice(1),i===cards.length-1?[truncatedNote]:[],`card ${i}`);
  }
  // Splitting does not waste the room of a card.
  assert.ok(requestBytes(cards[0])>20000);
  assert.ok(parts[0].startsWith('开头的说明\n```ts\nconst path0 ')&&parts[0].endsWith('\n```'));assert.ok(parts[1].startsWith('```ts\nconst '));assert.ok(parts.at(-1).endsWith('\n结尾'));
  // No code line is lost or cut; the long line is cut into pieces that start cards and add up to it.
  assert.deepEqual(lines.filter(l=>l.startsWith('const ')),code);
  const pieces=lines.filter(l=>/^"+$/.test(l));assert.ok(pieces.length>1);assert.equal(pieces.join(''),long);for(const piece of pieces)assert.ok(parts.some(p=>p.startsWith(piece)));
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
  f.store.data.topics=[{...topic,id:'ready',rootId:'om_ready'},...['closed','failed','starting','choosing'].map(state=>({...topic,id:state,rootId:'om_'+state,state})),{...topic,id:'elsewhere',rootId:'om_elsewhere',machineId:'m2'},
   {...topic,id:'adopted',rootId:'om_adopted',paneId:'w1:p4',agentName:'review',adopted:{picker:'om_card',kind:'claude'}}];
  f.h.retained={'w1:p1':[{seq:1,text:'hi'}],'w1:p4':[{seq:1,text:'adopted hi'}]};
  await f.topics.sync(f.m,[{name:'someone-else',pane_id:'w1:p1',reply_seq:1,remote_answers:true},{pane_id:'w1:p4',reply_seq:1,remote_answers:true}]);
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

const onDisk=f=>new Store(f.dir).data.topics[0].reactions;
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
  let before;f.h.on['agent prompt']=(args,run)=>{before=onDisk(f);const r=run(args);return {...r,agent:{...r.agent,state_change_seq:7}};};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(before,[{messageId:'om_1',reactionId:'r_om_1',stateSeq:null}]);assert.deepEqual(onDisk(f),[{messageId:'om_1',reactionId:'r_om_1',stateSeq:7}]);assert.deepEqual(f.unreacted,[]);
 }finally{f.close();}
});
test('sync removes the reaction of a turn that has ended: the agent is idle or done and has changed state since the prompt',async()=>{
 const f=await readyTopic({cot:false});try{
  const agent=(agent_status,state_change_seq)=>[{...f.h.agents[0],agent_status,state_change_seq}];
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
  const events=[];f.topics.reply=async(a,chatId,rootId,{card})=>{events.push('reply '+markdownIn(card));};f.topics.unreact=async(a,messageId)=>{events.push('unreact '+messageId);};
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
  assert.equal(failed,1);assert.deepEqual([f.store.data.logs.at(-1).level,f.store.data.logs.at(-1).kind],['error','消息投递']);assert.match(f.store.data.logs.at(-1).message,/disk full/);
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
const bash={id:1,kind:'permission',tool_name:'Bash',description:'列出文件',input_preview:'ls -la',decisions:['allow','allow_always','deny']};
const edit={id:2,kind:'permission',tool_name:'Edit',input_preview:'{"file_path":"a.txt"}',decisions:['allow','deny']};
const ask={id:3,kind:'question',tool_name:'AskUserQuestion',input_preview:'{}',questions:[
 {question:'用哪种数据库？',header:'数据库',options:[{label:'PostgreSQL',description:'关系型'},{label:'SQLite'}],multi_select:false},
 {question:'需要哪些功能？',options:[{label:'登录'},{label:'搜索'},{label:'导出'}],multi_select:true}]};
const cardOf=(title,template,elements)=>({schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:title},template},body:{elements}});
const expiredCard=title=>cardOf(title,'grey',[plainText('已失效（超时、已在终端处理或本轮已结束）')]);
// Every element with the tag, at any depth.
const find=(x,tag)=>x&&typeof x==='object'?[...x.tag===tag?[x]:[],...Object.values(x).flatMap(v=>find(v,tag))]:[];
// A ready topic whose agent in w1:p1 waits on requests. pending(ids) is an agent list that reports those request ids; cards() the cards
// sent into the thread; value(card,decision) the callback value of a button; click(...) a click by an allowed person; settled() waits for
// the answers that clicks started.
async function requestTopic(...requests){
 const f=await readyTopic();f.h.requests['w1:p1']=requests;
 return {...f,
  pending:(ids=f.h.requests['w1:p1'].map(r=>r.id),fields={})=>f.h.agents.map(a=>({...a,request_ids:ids,...fields})),
  cards:()=>f.replies.filter(r=>r[3].card.header).map(r=>r[3].card),records:()=>new Store(f.dir).data.topics[0].cards,
  value:(card,decision)=>find(card,'button').find(b=>!decision||b.behaviors[0].value.decision===decision).behaviors[0].value,
  click:(messageId,value,formValue,openId='ou_user')=>f.topics.click(allowed,{messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',value,formValue}}),
  settled:()=>Promise.all(f.topics.answering.values()),
 };
}
const cardLogs=f=>f.store.data.logs.filter(l=>l.kind==='请求卡片').map(l=>[l.level,l.message]);
test('each new request gets a card in the topic thread, recorded with its request id, card message and title only after Feishu took it',async()=>{
 const f=await requestTopic(bash,edit);try{
  const reply=f.topics.reply,onDiskAtSend=[];f.topics.reply=async(...args)=>{onDiskAtSend.push(f.records()||[]);return reply(...args);};
  await f.topics.sync(f.m,f.pending());
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1']]);assert.deepEqual(f.replies.map(r=>r.slice(0,3)),[['a','oc_1','om_1'],['a','oc_1','om_1']]);
  const buttons=(value,...decisions)=>({tag:'column_set',horizontal_spacing:'8px',columns:decisions.map(([content,type,decision])=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value:{...value,decision}}]}]}))});
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
  const options=labels=>labels.map((content,i)=>({text:{tag:'plain_text',content},value:String(i)})),other=i=>({tag:'input',name:'other'+i,width:'fill',placeholder:{tag:'plain_text',content:'其他（填写后以此为准）'}});
  assert.deepEqual(f.cards(),[cardOf('Agent 提问','blue',[{tag:'form',name:'answers',elements:[
   plainText('数据库：用哪种数据库？\n· PostgreSQL：关系型'),{tag:'select_static',name:'q0',width:'fill',placeholder:{tag:'plain_text',content:'选择一项'},options:options(['PostgreSQL','SQLite'])},other(0),
   plainText('需要哪些功能？'),{tag:'multi_select_static',name:'q1',width:'fill',placeholder:{tag:'plain_text',content:'选择一项或多项'},options:options(['登录','搜索','导出'])},other(1),
   {tag:'button',text:{tag:'plain_text',content:'提交'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{request:3,check:check(ask),render:1,questions:2}}]}]}])]);
  assert.deepEqual(f.records(),[{requestId:3,messageId:'om_bot_1',title:'Agent 提问'}]);
 }finally{f.close();}
});
test('Herdr leaves out empty lists and false flags: a question without options has only the 其他 input and is answered by it; a permission without decisions has no buttons',async()=>{
 const open={id:6,kind:'question',tool_name:'AskUserQuestion',input_preview:'{}',questions:[{question:'项目叫什么？'}]},bare={id:7,kind:'permission',tool_name:'Bash',input_preview:'ls'};
 const f=await requestTopic(open,bare);try{
  await f.topics.sync(f.m,f.pending());const [card,plainCard]=f.cards();
  assert.deepEqual(find(card,'form')[0].elements.map(e=>e.tag),['div','input','button']);
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
  let onDiskAtUpdate;const update=f.topics.updateCard;f.topics.updateCard=async(...args)=>{onDiskAtUpdate=f.records();return update(...args);};
  await f.topics.sync(f.m,f.pending([2,3]));
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(onDiskAtUpdate.map(c=>c.requestId),[2,3]);assert.deepEqual(f.h.calls,[]);
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
  let release;f.h.on['agent prompt']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
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
  assert.deepEqual(f.updated.map(u=>[u[1],u[2].header.template,find(u[2],'markdown')[0].content]),[['om_bot_1','red','已拒绝 · <at id=ou_user></at>'],['om_bot_2','green','已总是允许 · <at id=ou_user></at>']]);
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
  let release;f.h.on['agent answer']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
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
  f.h.requests['w1:p1']=[];const list=(agent_status,state_change_seq,request_ids)=>f.h.agents.map(a=>({...a,agent_status,state_change_seq,request_ids}));
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
const opened=(id,name,title,icon)=>[['TOOL_CALL_START',{toolCallId:id,toolCallName:name,title,icon}],['TOOL_CALL_END',{toolCallId:id}]];
const closed=(id,failed=false)=>['TOOL_CALL_RESULT',{messageId:'result-'+id,toolCallId:id,role:'tool',content:failed?'失败':'完成',isError:failed}];
const said=(id,text)=>[['TEXT_MESSAGE_START',{messageId:id,role:'assistant'}],['TEXT_MESSAGE_CONTENT',{messageId:id,delta:text}],['TEXT_MESSAGE_END',{messageId:id}]];
const stopped=f=>f.store.data.logs.filter(l=>l.kind==='话题停止').map(l=>[l.level,l.message]);
test('a prompted message gets a COT in the topic thread, created after the prompt, which takes the place of its reaction and is kept in the topic record; the COT shows its run started',async()=>{
 const f=topicFixture();try{
  let prompted;const request=f.topics.request;f.topics.request=async(a,o)=>{prompted??=f.h.calls.some(c=>c[1]==='prompt');return request(a,o);};
  await f.send({messageId:'om_1',content:'one'});
  assert.equal(prompted,true);
  assert.deepEqual(f.api[0],{method:'POST',url:cotPath,params:{receive_id_type:'chat_id'},data:{receive_id:'oc_1',origin_message_id:'om_1',reply_in_thread:true}});
  const update=f.api[1];assert.deepEqual([update.method,update.url,update.data.message_id,update.data.cot_id],['PUT',cotPath,'om_cot_1','c1']);
  // Every event carries its AG-UI event as JSON and a timestamp in ms.
  assert.ok(update.data.events.every(e=>Object.keys(e).join()==='event_type,content,timestamp'&&typeof e.content==='string'&&Math.abs(e.timestamp-Date.now())<60000));
  assert.deepEqual(cotLog(f),[['create','om_1'],['update','c1',['RUN_STARTED',run]]]);
  assert.deepEqual(new Store(f.dir).data.topics[0].cot,{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false});
  // The reaction marked the message at once; the COT takes its place.
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1']);assert.deepEqual(f.unreacted.map(r=>r[1]),['om_1']);assert.deepEqual(onDisk(f),[]);assert.deepEqual(cotLogs(f),[]);
 }finally{f.close();}
});
test('the COT starts after the tool calls that the agent made before the prompt',async()=>{
 const f=topicFixture();try{
  f.h.on['agent prompt']=(args,run)=>{const r=run(args);return {...r,agent:{...r.agent,tool_call_seq:12}};};
  await f.send({messageId:'om_1',content:'one'});assert.equal(f.store.data.topics[0].cot.toolSeq,12);
 }finally{f.close();}
});
test('a message prompted while the COT of an earlier one is open keeps its reaction until its turn ends; a message that is not prompted gets no COT',async()=>{
 const f=await readyTopic();try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.api,[]);assert.deepEqual(onDisk(f),[{messageId:'om_2',reactionId:'r_om_2',stateSeq:1}]);assert.equal(f.t.cot.origin,'om_1');
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
  const calls=f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'npm test'},{seq:4,tool_call_id:'t2',phase:'start',tool_name:'Read',title:'src/a.rs'},{seq:6,tool_call_id:'t1',phase:'end',tool_name:'Bash'}];
  const working=seq=>list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:seq});
  await f.topics.sync(f.m,working(6));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','0']]);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','npm test','bash'),...opened('t2','Read','src/a.rs','read'),closed('t1')]]);assert.equal(new Store(f.dir).data.topics[0].cot.toolSeq,6);
  // The same list again shows nothing new.
  await f.topics.sync(f.m,working(6));assert.equal(f.h.calls.length,1);assert.equal(f.api.length,1);
  calls.push({seq:9,tool_call_id:'t2',phase:'end',tool_name:'Read',failed:true},{seq:10,tool_call_id:'t3',phase:'start',tool_name:'Grep'},{seq:11,tool_call_id:'t4',phase:'start',tool_name:'apply_patch',title:'a.rs'},
   {seq:12,tool_call_id:'t5',phase:'start',tool_name:'shell',title:'ls'},{seq:13,tool_call_id:'t6',phase:'start',tool_name:'Task',title:'审查改动'},{seq:14,tool_call_id:'t7',phase:'start',tool_name:'Edit',title:'很'.repeat(300)});
  f.h.calls.length=0;f.api.length=0;await f.topics.sync(f.m,working(14));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','6']]);
  assert.deepEqual(cotLog(f),[['update','c1',closed('t2',true),...opened('t3','Grep','Grep','search'),...opened('t4','apply_patch','a.rs','write'),...opened('t5','shell','ls','bash'),...opened('t6','Task','审查改动','default'),...opened('t7','Edit','很'.repeat(199)+'…','write')]]);
  assert.equal(f.t.cot.toolSeq,14);assert.deepEqual(cotLogs(f),[]);
 }finally{f.close();}
});
test('a tool call seq below the stored one, after Herdr restarted or handed off and counts from 1 again, fetches all tool calls and shows those up to the list; more than 50 events go out in updates of at most 50, in order',async()=>{
 const f=await readyTopic();try{
  f.t.cot.toolSeq=40;f.h.toolCalls['w1:p1']=Array.from({length:31},(_,i)=>({seq:i+1,tool_call_id:'t'+(i+1),phase:'start',tool_name:'Bash',title:'step '+(i+1)}));
  await f.topics.sync(f.m,list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:30}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1']]);
  const batches=f.api.map(o=>o.data.events);assert.deepEqual(batches.map(b=>b.length),[50,10]);
  assert.deepEqual(cotLog(f).flatMap(u=>u.slice(2)),Array.from({length:30},(_,i)=>opened('t'+(i+1),'Bash','step '+(i+1),'bash')).flat());
  const stamps=batches.flat().map(e=>e.timestamp);assert.ok(stamps.every((s,i)=>!i||s>stamps[i-1]));assert.equal(f.t.cot.toolSeq,30);
  f.h.calls.length=0;f.api.length=0;await f.topics.sync(f.m,list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:31}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','30']]);assert.deepEqual(cotLog(f),[['update','c1',...opened('t31','Bash','step 31','bash')]]);
 }finally{f.close();}
});
test('tool calls that cannot be fetched are fetched again with the next list; an update Feishu refuses is logged once and not repeated',async()=>{
 const f=await readyTopic();try{
  f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls'}];const working=list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:3});
  f.h.on['agent tool-calls']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};await f.topics.sync(f.m,working);
  assert.deepEqual(f.api,[]);assert.equal(f.t.cot.toolSeq,0);assert.deepEqual(cotLogs(f),[['error',`${f.t.agentName}：未能读取工具调用，连接超时，请检查 SSH 与 Herdr 状态`]]);
  const request=f.topics.request;f.topics.request=async(a,o)=>{f.api.push(o);throw Error('飞书未连接');};
  await f.topics.sync(f.m,working);await f.topics.sync(f.m,working);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls','bash')]]);assert.equal(f.t.cot.toolSeq,3);assert.deepEqual(cotLogs(f).at(-1),['error',`${f.t.agentName}：COT 未能更新，飞书未连接`]);
  f.topics.request=request;
 }finally{f.close();}
});
test('while the agent waits for a confirmation, on a request card or blocked without one, the COT status says so after the steps that led there; once it runs again the COT says that before the steps that follow, each change once',async()=>{
 const f=await requestTopic(bash);try{
  f.h.toolCalls['w1:p1']=[{seq:2,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls -la'}];
  const waiting=f.pending([1],{agent_status:'blocked',state_change_seq:3,tool_call_seq:2});
  await f.topics.sync(f.m,waiting);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls -la','bash'),...said('status-3','等待确认')]]);assert.equal(new Store(f.dir).data.topics[0].cot.waiting,true);
  assert.equal(f.cards().length,1);await f.topics.sync(f.m,waiting);assert.equal(f.api.length,1);
  f.h.toolCalls['w1:p1'].push({seq:5,tool_call_id:'t1',phase:'end',tool_name:'Bash'});f.api.length=0;
  await f.topics.sync(f.m,f.pending([],{agent_status:'working',state_change_seq:4,tool_call_seq:5}));
  assert.deepEqual(cotLog(f),[['update','c1',...said('status-4','继续运行'),closed('t1')]]);assert.equal(f.t.cot.waiting,false);
  // Blocked without a request, such as on a question that Feishu cannot answer.
  f.api.length=0;await f.topics.sync(f.m,f.pending([],{agent_status:'blocked',state_change_seq:6,tool_call_seq:5}));
  assert.deepEqual(cotLog(f),[['update','c1',...said('status-6','等待确认')]]);
 }finally{f.close();}
});
test('once its turn ends the COT shows its last steps, finishes as done and is completed, after the replies went out as cards; the next prompted message gets a new COT',async()=>{
 const f=await readyTopic();try{
  const order=[],reply=f.topics.reply,request=f.topics.request;f.topics.reply=async(...args)=>{order.push('reply');return reply(...args);};f.topics.request=async(a,o)=>{order.push(o.method);return request(a,o);};
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
  const request=g.topics.request;g.topics.request=async(a,o)=>{if(o.method!=='PUT')return request(a,o);g.api.push(o);throw Error('飞书未连接');};
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
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list'],['agent','list']]);assert.deepEqual(f.api,[]);assert.equal(f.t.cot.cotId,'c1');
  assert.deepEqual(f.replies.map(r=>r[3]),Array(3).fill(notice('Agent 当前没有在运行的一轮')));
  f.h.agents[0].agent_status='working';f.replies.length=0;f.h.on['agent send-keys']=()=>{throw coded('agent_not_ready','agent w1:p1 is not ready');};
  await f.send({messageId:'om_4',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能停止 Agent，请稍后重试')]);assert.deepEqual(stopped(f),[['error',`${f.t.agentName}：未能停止，agent w1:p1 is not ready`]]);assert.equal(f.t.cot.cotId,'c1');
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
const option=(content,choice)=>({text:{tag:'plain_text',content},value:JSON.stringify(choice)});
const pickerForm=(render,...options)=>({tag:'form',name:'picker',elements:[{tag:'select_static',name:'agent',width:'fill',placeholder:{tag:'plain_text',content:'选择要接管的 Agent'},options},
 {tag:'button',text:{tag:'plain_text',content:'接管'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{adopt:true,render}}]}]});
const claudeOption=option('cpu2 · 赤尾重构 · Claude · 空闲',claudeChoice),codexOption=option('cpu2 · 出题 · Codex · 运行中',codexChoice),cpu1Down=plainText('cpu1 · 连接失败');
// The picker of the agents above with its render number; a notice comes first.
const pickerCard=(render,notice)=>cardOf('接管 Agent','blue',[...notice?[plainText(notice)]:[],pickerForm(render,claudeOption,codexOption),cpu1Down]);
const introLines=['话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在终端的 pane 里运行。'];
const adoptLogs=f=>f.store.data.logs.filter(l=>l.kind==='话题接管').map(l=>[l.level,l.message]);
// What a submission of the picker form holds: the value of the chosen option, a raw string as is, or nothing when no option was chosen.
const formValue=adopt=>adopt===undefined?{}:{agent:typeof adopt==='string'?adopt:JSON.stringify(adopt)};
async function adoptFixture(binding){
 const f=topicFixture({binding,machines:[{id:'m2',name:'cpu1',enabled:true},{id:'m3',name:'gpu1',enabled:true},{id:'m4',name:'gpu2',enabled:false}]});
 await f.send({messageId:'om_1',content:'bridge topic',mentionedBot:true});
 f.h.agents.push(structuredClone(claudePane),structuredClone(codexPane),{name:'shell',pane_id:'w2:p3',workspace_id:'w2',tab_id:'w2:t1',agent_status:'unknown',state_change_seq:0});
 // Herdr labels a tab without a name by its position.
 f.h.workspaces.push({workspace_id:'w2',label:'herdr'});f.h.tabs.push({tab_id:'w2:t1',workspace_id:'w2',label:'1'},{tab_id:'w2:t2',workspace_id:'w2',label:'出题'});
 f.h.panes.push({pane_id:'w2:p1',workspace_id:'w2',tab_id:'w2:t1',label:'赤尾重构'},{pane_id:'w2:p2',workspace_id:'w2',tab_id:'w2:t2'},{pane_id:'w2:p3',workspace_id:'w2',tab_id:'w2:t1'});
 f.h.retained['w2:p1']=[{seq:1,text:'旧回复'},{seq:2,text:'\n改好了。\n\n- 修复了登录'}];
 f.h.hosts.m2={down:'ssh: connect to host cpu1 port 22: Connection timed out'};f.h.hosts.m3={agents:[],retained:{},requests:{}};
 f.h.calls.length=0;f.h.machines.length=0;f.reacted.length=0;f.unreacted.length=0;f.api.length=0;
 return {...f,
  // The topic whose thread starts at message id.
  topic:id=>f.store.data.topics.find(t=>t.rootId===id),
  pickers:()=>f.replies.filter(r=>r[3].card.header).map(r=>r[3].card),
  // A submission of picker messageId by an allowed person with agent adopt chosen (see formValue).
  pick:(messageId,adopt,render=1,openId='ou_user')=>f.topics.click(allowed,{messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',name:'submit',value:{adopt:true,render},formValue:formValue(adopt)}}),
  settled:()=>Promise.all(f.topics.answering.values()),
  // Sends /adopt and submits agent adopt on its picker, which is reply om_bot_<n>.
  async adopt(rootId,adopt,n=1){await f.send({messageId:rootId,content:'/adopt'});f.topics.click(allowed,{messageId:'om_bot_'+n,chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',name:'submit',value:{adopt:true,render:n},formValue:formValue(adopt)}});await Promise.all(f.topics.answering.values());return f.store.data.topics.find(t=>t.rootId===rootId);},
 };
}
test('an agent is named by the label of its pane, else the label given to its tab, else the label of its workspace, else its pane; agents that would share a name are told apart by their panes',()=>{
 const snapshot=(agents,{panes=[],tabs=[],workspaces=[]}={})=>({agents,panes,tabs,workspaces}),workspaces=[{workspace_id:'w1',label:'herdr'}];
 const x={agent:'claude',pane_id:'w1:p1',tab_id:'w1:t1',workspace_id:'w1'};
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
  f.store.data.topics.push({...f.topic('om_1'),id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p4'},{...f.topic('om_1'),id:'old',rootId:'om_old',paneId:'w2:p2',state:'closed'});
  await f.send({messageId:'om_cmd',content:' /adopt '});
  assert.deepEqual(f.replies,[['a','oc_1','om_cmd',{card:pickerCard(1)}]]);
  assert.deepEqual(callsOn(f).map(c=>JSON.stringify(c)).sort(),[['m','api','snapshot'],['m2','api','snapshot'],['m3','api','snapshot']].map(c=>JSON.stringify(c)).sort());
  const {id,createdAt,...rest}=f.topic('om_cmd');assert.ok(createdAt>0);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_cmd',machineId:'',workspaceId:'',tabId:'',paneId:'',agentName:'',title:'接管 Agent',state:'choosing',error:'',messageIds:['om_cmd'],replySeq:0,reactions:[],cards:[],adopted:{picker:'om_bot_1'}});
  assert.deepEqual(new Store(f.dir).data.topics.find(t=>t.id===id).adopted,{picker:'om_bot_1'});
  assert.deepEqual(f.reacted,[]);assert.equal(f.h.calls.some(c=>['workspace','tab'].includes(c[0])||c[1]==='start'||c[1]==='prompt'),false);
  assert.deepEqual(adoptLogs(f),[['error','cpu1：ssh: connect to host cpu1 port 22: Connection timed out'],['info','个人助手：已发送可接管的 Agent 列表']]);
 }finally{f.close();}
});
test('/adopt is a command only on a root message: in a thread it is a message to the agent, a mention-only group needs the @, and a repeated delivery sends one picker',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'/adopt'});
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
  assert.equal(f.topic('om_old').adopted,undefined);assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['/接管']);assert.equal(f.pickers().length,0);
  const t=await f.adopt('om_cmd',claudeChoice,1);f.h.calls.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'/结束接管'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w2:p1','/结束接管']]);assert.equal(t.state,'ready');
 }finally{f.close();}
});
test('a message in the thread of a picker before any selection gets a notice, is not prompted and opens no tab',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'先说一句'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies,[['a','oc_1','om_cmd',notice('请先在上面的卡片中选择要接管的 Agent')]]);
  assert.deepEqual(f.unreacted,[['a','om_2','r_om_2']]);assert.deepEqual([f.topic('om_cmd').state,f.topic('om_cmd').messageIds],['choosing',['om_cmd','om_2']]);
 }finally{f.close();}
});
test('a picker that Feishu refuses is logged and its topic closed',async()=>{
 const f=await adoptFixture();try{
  f.topics.reply=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_cmd',content:'/adopt'});
  assert.equal(f.topic('om_cmd').state,'closed');assert.deepEqual(adoptLogs(f).at(-1),['error','个人助手：可接管的 Agent 列表未发出，飞书未连接']);
 }finally{f.close();}
});
test('submitting an agent turns on its remote answers, links the topic to its machine and pane under its pane name, posts the intro with its full latest reply and marks the picker adopted',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.h.machines.length=0;f.replies.length=0;
  assert.deepEqual(f.pick('om_bot_1',claudeChoice),{toast:{type:'info',content:'正在接管'}});
  await f.settled();
  assert.deepEqual(callsOn(f),[['m','api','snapshot'],['m','pane','remote-answers','w2:p1','on'],['m','agent','replies','w2:p1','--after','1']]);
  const t=f.topic('om_cmd'),{id,createdAt,messageIds,...rest}=t;
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_cmd',machineId:'m',workspaceId:'w2',tabId:'w2:t1',paneId:'w2:p1',agentName:'赤尾重构',title:'接管 · 赤尾重构',state:'ready',error:'',replySeq:2,reactions:[],cards:[],adopted:{picker:'om_bot_1',kind:'claude',session:'s-claude'}});
  assert.equal(new Store(f.dir).data.topics.find(x=>x.id===id).state,'ready');assert.equal(f.h.agents.find(a=>a.pane_id==='w2:p1').remote_answers,true);
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
  const t=f.topic('om_cmd');assert.deepEqual([t.paneId,t.agentName,t.title,t.replySeq,t.adopted],['w2:p2','出题','接管 · 出题',0,{picker:'om_bot_1',kind:'codex'}]);
 }finally{f.close();}
});
test('a selection whose agent exited or changed meanwhile, whose remote answers cannot be turned on or whose machine was disconnected links nothing and redraws the picker with the reason and the agents left',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});const t=f.topic('om_cmd');
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w2:p1');f.h.calls.length=0;
  assert.deepEqual(f.pick('om_bot_1',claudeChoice),{toast:{type:'info',content:'正在接管'}});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('接管 Agent','blue',[plainText('所选的 Agent 已退出或已变化，请重新选择'),pickerForm(2,codexOption),cpu1Down])]]);
  assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.deepEqual([t.state,t.paneId],['choosing','']);
  // The same pane with another session holds another agent.
  f.h.agents.push({...structuredClone(claudePane),agent_session:{...claudePane.agent_session,value:'s-other'}});f.h.calls.length=0;
  f.pick('om_bot_1',claudeChoice,2);await f.settled();
  assert.deepEqual(f.updated.at(-1)[2].body.elements[0],plainText('所选的 Agent 已退出或已变化，请重新选择'));assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.equal(t.state,'choosing');
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  f.pick('om_bot_1',codexChoice,3);await f.settled();
  assert.deepEqual(f.updated.at(-1)[2].body.elements[0],plainText('接管失败，请稍后重试'));assert.deepEqual([t.state,t.paneId],['choosing','']);
  assert.deepEqual(adoptLogs(f).filter(l=>l[1].startsWith('个人助手：接管失败')),[['error','个人助手：接管失败，连接超时，请检查 SSH 与 Herdr 状态']]);
  // A machine disconnected meanwhile is left out of the redrawn picker.
  f.m.enabled=false;f.pick('om_bot_1',codexChoice,4);await f.settled();
  assert.deepEqual(f.updated.at(-1)[2],cardOf('接管 Agent','blue',[plainText('所选的机器已断开，请重新选择'),plainText('没有可以接管的 Agent'),cpu1Down]));
  assert.deepEqual([t.state,t.paneId],['choosing','']);f.m.enabled=true;
  // A selection from the redrawn picker still works.
  f.pick('om_bot_1',codexChoice,5);await f.settled();assert.deepEqual([t.state,t.paneId],['ready','w2:p2']);
 }finally{f.close();}
});
test('two pickers selecting the same agent at once link it to one topic only; the other picker says it was adopted meanwhile and no longer lists it',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_a',content:'/adopt'});await f.send({messageId:'om_b',content:'/adopt'});
  f.h.calls.length=0;f.pick('om_bot_1',codexChoice);f.pick('om_bot_2',codexChoice,2);await f.settled();
  assert.deepEqual([f.topic('om_a').state,f.topic('om_b').state],['ready','choosing']);assert.equal(f.h.calls.filter(c=>c[0]==='pane').length,1);
  const [,,card]=f.updated.find(u=>u[1]==='om_bot_2');
  assert.deepEqual(card,cardOf('接管 Agent','blue',[plainText('所选的 Agent 已被其他话题接管，请重新选择'),pickerForm(3,claudeOption),cpu1Down]));
 }finally{f.close();}
});
test('agents offered under the same name on one machine are told apart by their panes, in the picker and in the topic that adopts one; agents that topics hold do not count',async()=>{
 const f=await adoptFixture();try{
  // A second Codex split into the 出题 tab, and a Claude there that a ready topic of another binding holds.
  f.h.agents.push({agent:'codex',pane_id:'w2:p5',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:2},{agent:'claude',pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:1,remote_answers:true});
  f.h.panes.push({pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2'},{pane_id:'w2:p5',workspace_id:'w2',tab_id:'w2:t2'});
  f.store.data.topics.push({...f.topic('om_1'),id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p4'});
  const offered=card=>find(card,'select_static')[0].options.map(o=>o.text.content);
  await f.send({messageId:'om_a',content:'/adopt'});
  assert.deepEqual(offered(f.pickers()[0]),['cpu2 · 赤尾重构 · Claude · 空闲','cpu2 · 出题 (w2:p2) · Codex · 运行中','cpu2 · 出题 (w2:p5) · Codex · 空闲']);
  f.pick('om_bot_1',{machine:'m',pane:'w2:p5',kind:'codex'});await f.settled();
  assert.deepEqual([f.topic('om_a').agentName,f.topic('om_a').title],['出题 (w2:p5)','接管 · 出题 (w2:p5)']);
  // Once a topic holds w2:p5, the Codex left goes by the tab's name alone.
  await f.send({messageId:'om_b',content:'/adopt'});
  assert.deepEqual(offered(f.pickers()[1]),['cpu2 · 赤尾重构 · Claude · 空闲','cpu2 · 出题 · Codex · 运行中']);
  f.pick('om_bot_3',codexChoice,2);await f.settled();
  assert.deepEqual([f.topic('om_b').agentName,f.topic('om_b').title],['出题','接管 · 出题']);
 }finally{f.close();}
});
test('a submission without a chosen agent, or with a value that is no choice of the picker, gets a warning, adopts nothing and draws the picker again so that it can be submitted again',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});const t=f.topic('om_cmd');f.h.calls.length=0;
  assert.deepEqual(f.pick('om_bot_1',undefined),{toast:{type:'warning',content:'请选择要接管的 Agent'}});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',pickerCard(2,'请选择要接管的 Agent')]]);
  for(const [i,value] of ['not json','null','{"machine":"m"}'].entries()){
   assert.deepEqual(f.pick('om_bot_1',value,2+i),{toast:{type:'warning',content:'请选择要接管的 Agent'}},value);await f.settled();
   assert.deepEqual(f.updated.at(-1)[2],pickerCard(3+i,'请选择要接管的 Agent'),value);
  }
  assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.deepEqual([t.state,t.paneId],['choosing','']);
  // The picker drawn again takes a choice.
  f.pick('om_bot_1',claudeChoice,5);await f.settled();assert.deepEqual([t.state,t.paneId,t.agentName],['ready','w2:p1','赤尾重构']);
 }finally{f.close();}
});
test('a click on a picker without a topic gets a toast that the card has expired; a second click while one is being adopted waits for it',async()=>{
 const f=await adoptFixture();try{
  assert.deepEqual(f.pick('om_unknown',claudeChoice),{toast:{type:'info',content:'这张卡片已失效，请重新发送 /adopt'}});
  await f.send({messageId:'om_cmd',content:'/adopt'});
  let release;f.h.on['pane remote-answers']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  f.pick('om_bot_1',claudeChoice);await later(5);
  assert.deepEqual(f.pick('om_bot_1',codexChoice,1,'ou_owner'),{toast:{type:'info',content:'正在接管，请稍候'}});
  release();await f.settled();assert.equal(f.topic('om_cmd').paneId,'w2:p1');assert.equal(f.h.calls.filter(c=>c[0]==='pane').length,1);
 }finally{f.close();}
});
test('an adopted topic prompts its pane, forwards only the replies after the one in the intro, sends request cards, opens a COT for a prompted message and completes it when the turn ends, and never opens a tab',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);f.h.calls.length=0;f.h.machines.length=0;f.replies.length=0;f.api.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});
  assert.deepEqual(callsOn(f),[['m','agent','list'],['m','agent','prompt','w2:p1','继续']]);assert.deepEqual([t.reactions,t.cot.origin,t.cot.stateSeq],[[],'om_2',4]);
  assert.deepEqual(cotLog(f),[['create','om_2'],['update','c2',['RUN_STARTED',{threadId:'om_cmd',runId:'om_2'}]]]);
  const agent=f.h.agents.find(a=>a.pane_id==='w2:p1');f.h.retained['w2:p1'].push({seq:3,text:'新回复'});f.h.requests['w2:p1']=[bash];f.h.calls.length=0;
  await f.topics.sync(f.m,f.h.agents.map(a=>a===agent?{...a,reply_seq:3,request_ids:[1],agent_status:'done',state_change_seq:9}:a));
  assert.deepEqual(f.replies.map(r=>r[2]),['om_cmd','om_cmd']);assert.deepEqual(f.replies[0][3],replyOf('新回复'));assert.equal(f.replies[1][3].card.header.title.content,'权限确认 · Bash');
  assert.deepEqual(f.h.calls,[['agent','replies','w2:p1','--after','2'],['agent','requests','w2:p1']]);
  assert.deepEqual(cotLog(f).slice(2),[['update','c2',['RUN_FINISHED',{threadId:'om_cmd',runId:'om_2',status:'done'}]],['complete','c2','done']]);assert.equal(t.cot,undefined);
  assert.deepEqual(t.cards,[{requestId:1,messageId:'om_bot_5',title:'权限确认 · Bash'}]);
 }finally{f.close();}
});
test('/release in an adopted topic turns off its remote answers and ends the topic without touching the pane, which keeps running; later messages are not prompted',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});
  f.h.calls.length=0;f.replies.length=0;f.reacted.length=0;f.unreacted.length=0;f.api.length=0;
  await f.send({messageId:'om_3',rootId:'om_cmd',content:' /release '});
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w2:p1','off']]);assert.equal(t.state,'closed');assert.equal(new Store(f.dir).data.topics.find(x=>x.id===t.id).state,'closed');
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_cmd',notice('已结束接管。Agent 仍在终端的 pane 里运行，话题里的消息不再发给它')]]);
  assert.equal(f.h.agents.find(a=>a.pane_id==='w2:p1').remote_answers,undefined);assert.deepEqual(adoptLogs(f).at(-1),['info','个人助手：已结束接管 cpu2 上的 赤尾重构']);
  // The command gets no reaction; the COT of the turn still running ends as failed with the topic.
  assert.deepEqual(f.reacted,[]);assert.deepEqual(f.unreacted,[]);assert.deepEqual(cotLog(f),[['update','c2',['RUN_ERROR',{message:'话题已结束'}]],['complete','c2','error']]);
  f.h.calls.length=0;await f.send({messageId:'om_4',rootId:'om_cmd',content:'还在吗'});await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release'});
  assert.deepEqual(f.h.calls,[]);assert.equal(f.replies.length,1);
 }finally{f.close();}
});
test('/release anywhere but an adopted topic is an ordinary message: a bridge topic prompts it to its agent',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'/release'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','/release']]);assert.equal(f.topic('om_1').state,'ready');
 }finally{f.close();}
});
test('when /release cannot turn off remote answers the topic stays linked with a notice, unless its agent turns out to be gone, which ends the topic',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);f.replies.length=0;
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'/release'});
  assert.equal(t.state,'ready');assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能结束接管，请稍后重试')]);assert.match(adoptLogs(f).at(-1)[1],/^个人助手：未能结束接管，连接超时/);
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w2:p1');f.h.on['pane remote-answers']=()=>{throw coded('pane_not_found','pane w2:p1 not found');};f.replies.length=0;
  await f.send({messageId:'om_3',rootId:'om_cmd',content:'/release'});
  assert.equal(t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[adoptedGone]);
 }finally{f.close();}
});
test('an adopted topic ends with its own notice when its pane closes, its agent exits or another agent takes the pane; no pane is closed',async()=>{
 const changes={gone:agents=>agents.filter(a=>a.pane_id!=='w2:p1'),replaced:agents=>agents.map(a=>a.pane_id==='w2:p1'?{...a,agent:'codex',agent_session:undefined,remote_answers:undefined}:a)};
 for(const [name,change] of Object.entries(changes)){
  const f=await adoptFixture();try{
   const t=await f.adopt('om_cmd',claudeChoice);f.h.calls.length=0;f.replies.length=0;f.h.agents=change(f.h.agents);
   await f.topics.sync(f.m,f.h.agents);
   assert.equal(t.state,'closed',name);assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_cmd',adoptedGone]],name);assert.deepEqual(f.h.calls,[['agent','list']],name);
   assert.equal(f.topic('om_1').state,'ready',name);
  }finally{f.close();}
 }
});
test('removing a binding drops its topics, turns off remote answers for those linked to an agent, bridge-opened or adopted, and shows their open COT failed; a failure is only logged',async()=>{
 const f=await adoptFixture();try{
  await f.adopt('om_cmd',claudeChoice);await f.send({messageId:'om_cmd2',content:'/adopt'});
  const {cot,...linked}=f.topic('om_1'),other={...linked,id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p2'};f.store.data.topics.push(other);
  f.h.calls.length=0;f.h.machines.length=0;f.api.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.store.data.topics,[other]);assert.deepEqual(new Store(f.dir).data.topics.map(t=>t.id),['other']);
  assert.deepEqual(callsOn(f),[['m','pane','remote-answers','w1:p1','off'],['m','pane','remote-answers','w2:p1','off']]);
  assert.equal(cot.cotId,'c1');assert.deepEqual(cotLog(f),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};await f.topics.unbind('other');
  assert.deepEqual(f.store.data.topics,[]);assert.match(f.store.data.logs.at(-1).message,/未能关闭.*连接超时/);
 }finally{f.close();}
});

const minutes=n=>n*60000;
function pendingFixture({bridgeUrl='http://bridge.example:8080',onBound}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pending-')),store=new Store(dir),replies=[],bound=[],clock={now:1000};
 store.data.apps=[{...allowed}];store.data.machines=[{id:'m',name:'cpu2'}];store.save();
 const lookup=(collection,error)=>id=>{const x=store.data[collection].find(y=>y.id===id);if(!x)throw Error(error);return x;};
 const pending=new PendingChats(store,{reply:async(a,chatId,rootId,content)=>{replies.push([a.id,chatId,rootId,content]);},onBound:onBound||((...args)=>{bound.push(args);}),
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
  // The link shows its URL and opens it.
  assert.deepEqual(f.replies,[['a','oc_1','om_first',{card:untitledOf('这个聊天还没有连接到 Herdr，打开链接完成绑定：',[plainText('这个聊天还没有连接到 Herdr，打开链接完成绑定：'),{tag:'markdown',content:`<a href='http://bridge.example:8080/?bind=${chat.token}'></a>`}])}]]);
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
  await f.pending.open(allowed,firstDm);assert.deepEqual(f.replies.map(r=>r[3]),[notice('这个聊天还没有连接到 Herdr，请在 Bridge 管理台「会话绑定」中完成绑定。')]);
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
  const {id,...rest}=binding;assert.deepEqual(rest,{name:'飞书私聊',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',permissionMode:'default',requireMention:false,enabled:true});
  assert.deepEqual(new Store(f.dir).data.bindings,[binding]);assert.deepEqual(f.bound,[[f.store.data.apps[0],binding,firstDm]]);
  assert.deepEqual(f.pending.list().map(c=>c.token),[other.token]);
  assert.throws(()=>f.pending.bind({...form,token}),/^Error: 绑定链接已失效，请在飞书里重新发消息$/);
  for(const bad of [{token:'unknown'},{token:undefined},{}])assert.throws(()=>f.pending.bind({...form,...bad}),/绑定链接已失效/);
  // An invalid form or an unknown machine keeps the token for another try.
  assert.throws(()=>f.pending.bind({...form,token:other.token,cwd:'relative'}),/工作目录/);assert.throws(()=>f.pending.bind({...form,token:other.token,machineId:'gone'}),/机器连接不存在/);
  assert.deepEqual(f.pending.list().map(c=>c.token),[other.token]);assert.equal(f.store.data.bindings.length,1);
 }finally{f.close();}
});
test('a group binding keeps the mention choice and the permission mode chosen; a chat whose app was removed cannot be bound',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,{...firstDm,chatType:'group',chatId:'oc_group'});
  const binding=f.pending.bind({...form,permissionMode:'auto',token:f.pending.list()[0].token});assert.deepEqual([binding.requireMention,binding.permissionMode],[true,'auto']);
  await f.pending.open(allowed,{...firstDm,chatType:'group',chatId:'oc_group2',messageId:'om_g2'});f.store.data.apps=[];
  assert.throws(()=>f.pending.bind({...form,token:f.pending.list()[0].token}),/应用不存在/);
 }finally{f.close();}
});

const png=Buffer.from('89504e470d0a1a0a0000','hex');
// The app's slash commands as Feishu lists them, by default the bridge's own with their descriptions.
const slashPath='/open-apis/application/v7/app_slash_commands',described=text=>({default_value:text,i18n:{zh_cn:text}});
const registered=[{command_id:'c-adopt',command:'adopt',description:described('接管正在运行的 Agent')},{command_id:'c-release',command:'release',description:described('结束接管')},{command_id:'c-stop',command:'stop',description:described('停止 Agent 当前这一轮')}];
// A connected channel whose bot info comes from info() and whose slash command calls are answered by commands(request); every avatar
// download is answered by avatar(url).
function botFixture({info,avatar,commands=()=>({code:0,msg:'success',data:{items:registered}})}={}){
 const requests=[],downloads=[];
 const channel={on(){},connect:async()=>{},disconnect:async()=>{},getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async o=>{requests.push(o);return o.url==='/open-apis/bot/v3/info'?info():commands(o);}}};
 const f=platformFixture({channelFactory:()=>channel,fetch:async(url,options)=>{downloads.push(String(url));assert.ok(options.signal);return avatar(String(url));}});
 const a={id:'app-1',name:'注册时的名称',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:['ou_user'],enabled:true};f.store.data.apps=[a];f.store.save();
 return {...f,a,requests,downloads,file:path.join(f.dir,'avatars','app-1')};
}
const botInfo=(bot={})=>()=>({code:0,bot:{app_name:'飞书机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/avatar.png',...bot}});
test('connecting and verifying take the name and open_id from Feishu and store the https avatar',async()=>{
 const f=botFixture({info:botInfo(),avatar:()=>new Response(png,{headers:{'content-type':'image/png'}})});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'},{method:'GET',url:slashPath}]);assert.deepEqual(f.downloads,['https://cdn.example/avatar.png']);
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
test('connecting offers the commands in the slash command panel of the app: a missing one is created and one with another description updated; commands of the app are never deleted',async()=>{
 const items=[registered[0],{...registered[1],description:described('旧的说明')},{command_id:'c-deploy',command:'deploy',description:described('部署')}];
 const f=botFixture({info:botInfo({avatar_url:''}),avatar:()=>assert.fail('no download'),commands:o=>o.method==='GET'?{code:0,data:{items}}:{code:0,data:{command_id:'c-new'}}});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests.slice(1),[{method:'GET',url:slashPath},{method:'PATCH',url:slashPath+'/c-release',data:{command:'release',description:described('结束接管')}},{method:'POST',url:slashPath,data:{command:'stop',description:described('停止 Agent 当前这一轮')}}]);
  assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='斜杠命令').map(l=>[l.level,l.message]),[['info','飞书机器人：已注册斜杠命令 /release、/stop']]);
 }finally{f.close();}
});
test('without the slash command scopes, or when Feishu refuses a command, connecting logs one line and the app stays connected; every connection tries again',async()=>{
 const denied=code=>()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:{code,msg:'Access denied. One of the following scopes is required'}}});};
 const scopes='飞书机器人：未能注册斜杠命令，应用缺少权限 application:app_slash_command:read / write；命令仍可手动输入';
 for(const [commands,message,calls] of [[denied(99991672),scopes,1],[o=>o.method==='GET'?{code:0,data:{items:[]}}:denied(99991640)(),scopes,2],
  [()=>({code:40000000,msg:'command already exists'}),'飞书机器人：未能注册斜杠命令，飞书接口错误 40000000：command already exists',1]]){
  const f=botFixture({info:botInfo({avatar_url:''}),avatar:()=>assert.fail('no download'),commands});try{
   const logs=()=>f.store.data.logs.filter(l=>l.kind==='斜杠命令').map(l=>[l.level,l.message]);
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',message);
   assert.deepEqual(logs(),[['error',message]]);assert.equal(f.requests.length-1,calls,message);
   await f.platforms.stop(f.a.id);await f.platforms.start(f.a);assert.equal(logs().length,2,message);
  }finally{f.close();}
 }
});
test('an OpenAPI call through the connected channel resolves to the data of a response with code 0, or to a body without that envelope; it rejects with Feishu\'s code otherwise, also for an HTTP error status',async()=>{
 const f=platformFixture(),answers=[],seen=[];try{
  await assert.rejects(f.platforms.request(allowed,{method:'GET',url:'/x'}),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async o=>{seen.push(o);return answers.shift()();}}}});
  answers.push(()=>({code:0,msg:'success',data:{cot_id:'1'}}),()=>({cot_id:'2',message_id:'om_2'}),()=>({code:230001,msg:'bad request'}),
   ()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:{code:99991672,msg:'denied'}}});},()=>{throw Error('timeout of 10000ms exceeded');});
  const call={method:'POST',url:'/open-apis/im/v1/message_cot',params:{receive_id_type:'chat_id'},data:{receive_id:'oc_1'}};
  assert.deepEqual(await f.platforms.request(allowed,call),{cot_id:'1'});assert.deepEqual(seen,[call]);
  assert.deepEqual(await f.platforms.request(allowed,call),{cot_id:'2',message_id:'om_2'});
  await assert.rejects(f.platforms.request(allowed,call),e=>e.code===230001&&e.message==='飞书接口错误 230001：bad request');
  await assert.rejects(f.platforms.request(allowed,call),e=>e.code===99991672&&e.message==='飞书接口错误 99991672：denied');
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
test('the server lists pending chats, saves bindings only through a link token, changes only the permission mode of a Claude binding, serves app avatars and reports topics without message ids, reactions, request cards or COT',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),agents=[{agent:'claude',pane_id:'w1:p1',agent_status:'idle',agent_session:{value:'s-1'}}];
 fs.mkdirSync(path.join(state,'avatars'),{recursive:true});fs.writeFileSync(path.join(state,'initialized'),'1');fs.writeFileSync(path.join(state,'avatars','app-avatar'),png);fs.writeFileSync(path.join(state,'avatars','app-gone'),png);
 const topic={bindingId:'b-old',appId:'x',chatId:'oc_9',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',error:'',messageIds:['om_1'],reactions:[{messageId:'om_1',reactionId:'r_1',stateSeq:1}],cards:[{requestId:1,messageId:'om_card',title:'权限确认 · Bash'}],cot:{cotId:'c1',messageId:'om_cot',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false},createdAt:1};
 const app={name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false};
 const claude={id:'b-claude',name:'助手',appId:'x',machineId:'m',chatId:'oc_8',cwd:'~/work',kind:'claude',requireMention:false,enabled:true},codex={...claude,id:'b-codex',chatId:'oc_7',kind:'codex'},agy={...claude,id:'b-agy',chatId:'oc_6',kind:'agy'};
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({apps:[{...app,id:'app-avatar',avatar:{type:'image/png',updatedAt:5}},{...app,id:'app-plain',appId:'cli_plain'},{...app,id:'app-gone',appId:'cli_gone',avatar:{type:'image/png',updatedAt:5}}],
  bindings:[{id:'b-old',appId:'x',machineId:'m',chatId:'oc_9'},claude,codex,agy],topics:[{...topic,id:'t1',state:'starting'},{...topic,id:'t2',bindingId:'b-keep',state:'ready'}]}));
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
  assert.deepEqual(s.pendingChats,[]);assert.deepEqual(s.bindings.map(b=>b.id),['b-old','b-claude','b-codex','b-agy']);assert.deepEqual(s.apps[0].avatar,{type:'image/png',updatedAt:5});
  const {messageIds,reactions,cards,cot,...listed}={...topic,id:'t1',state:'failed',error:'Bridge 重启时 Agent 启动未完成'};assert.deepEqual(s.topics[0],listed);for(const key of ['messageIds','reactions','cards','cot'])assert.equal(key in s.topics[1],false,key);
  // Other fields sent along are ignored; a refused change keeps the saved bindings as they are.
  assert.deepEqual(await api('bindings/permission-mode',{id:'b-claude',permissionMode:'auto',name:'改名',cwd:'/etc',kind:'codex'}),{status:200,body:{ok:true}});
  for(const [body,error] of [[{id:'b-claude',permissionMode:'bypassPermissions'},'权限模式无效'],[{id:'b-codex',permissionMode:'auto'},'只有 Claude 绑定可以设置权限模式'],[{id:'b-agy',permissionMode:'auto'},'只有 Claude 绑定可以设置权限模式'],[{id:'unknown',permissionMode:'auto'},'会话绑定不存在']])assert.deepEqual(await api('bindings/permission-mode',body),{status:400,body:{error}},body.id);
  const changed=(await api('state')).body;assert.deepEqual(changed.bindings.slice(1),[{...claude,permissionMode:'auto'},codex,agy]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).bindings.slice(1),[{...claude,permissionMode:'auto'},codex,agy]);
  assert.deepEqual(changed.logs.filter(l=>l.kind==='会话绑定').map(l=>l.message),['助手：权限模式改为 auto，之后新开的话题生效']);
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
test('the server hands every refreshed agent list to the topics, which forward new replies, remove the reactions of ended turns and send cards for new requests; removing the binding turns off remote answers for its topic',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),calls=path.join(dir,'calls');
 const agent={agent:'claude',name:'feishu-1',pane_id:'w1:p1',agent_status:'idle',state_change_seq:2,reply_seq:1,request_ids:[1],remote_answers:true};
 fs.mkdirSync(state);fs.writeFileSync(path.join(state,'initialized'),'1');
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({machines:[{id:'m',name:'fake',type:'local',session:'default',binary:herdr,enabled:true}],
  apps:[{id:'app',name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false}],bindings:[{id:'b',name:'助手',appId:'app',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:false,enabled:true}],
  topics:[{id:'t',bindingId:'b',appId:'app',chatId:'oc_1',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',state:'ready',error:'',messageIds:['om_1'],
   reactions:[{messageId:'om_1',reactionId:'r_1',stateSeq:1}],createdAt:1}]}));
 fs.writeFileSync(herdr,['#!/bin/sh',`echo "$*" >> ${quote(calls)}`,'case "$3 $4" in',
  ` 'agent list') echo ${quote(JSON.stringify({result:{type:'agent_list',agents:[agent]}}))};;`,
  ` 'agent replies') echo ${quote(JSON.stringify({result:{type:'agent_replies',agent,replies:[{seq:1,text:'hi'}]}}))};;`,
  ` 'agent requests') echo ${quote(JSON.stringify({result:{type:'agent_requests',agent,requests:[bash]}}))};;`,
  ` *) echo '{"result":{"panes":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 const port=await new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
 const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1'},stdio:['ignore','pipe','inherit']});
 try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),api=async p=>(await fetch(`http://127.0.0.1:${port}/api/${p}`,{headers:{authorization:'Bearer '+key}})).json();
  // The app is not connected, so the forward, the removal and the card fail and are logged; no Feishu request is made.
  let s;for(let i=0;i<100;i++){s=await api('state');if(s.logs.some(l=>l.kind==='请求卡片'))break;await later(50);}
  assert.equal(s.topics[0].replySeq,1);assert.deepEqual(s.logs.filter(l=>['回复转发','消息表情','请求卡片'].includes(l.kind)).map(l=>[l.level,l.message]),[['error','助手：feishu-1 的回复未发出，飞书未连接'],['error','feishu-1：未能取消表情，飞书未连接'],['error','feishu-1：请求 #1 的卡片未发出，飞书未连接']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).topics[0].reactions,[]);
  assert.deepEqual(fs.readFileSync(calls,'utf8').split('\n').filter(l=>l.includes('replies')||l.includes('requests')),['--session default agent replies w1:p1 --after 0','--session default agent requests w1:p1']);
  const removed=await fetch(`http://127.0.0.1:${port}/api/bindings/remove`,{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({id:'b'})});assert.equal(removed.status,200);
  const off=()=>fs.readFileSync(calls,'utf8').split('\n').filter(l=>l.includes('remote-answers'));for(let i=0;i<100&&!off().length;i++)await later(50);
  assert.deepEqual(off(),['--session default pane remote-answers w1:p1 off']);assert.deepEqual((await api('state')).topics,[]);
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
