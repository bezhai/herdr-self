import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {normalizeMachine,remoteInvocation,Store,targetAgent} from './core.mjs';import {normalizeApp,selectBinding,Platforms,channelCache} from './platform.mjs';
import {Registrations} from './registration.mjs';
import {normalize,normalizeCardAction,createLarkChannel} from '@larksuite/channel';

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
 const m=normalizeMachine({name:'test',host:'user@host',binary:'~/.local/bin/herdr'});const [bin,args]=remoteInvocation(m,'herdr',['--session','default','agent','prompt','w1:p1',"x'; echo hacked"]);assert.equal(bin,'ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('--'));assert.match(args.at(-1),/sh -c/);
 assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',session:'../default'}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',port:-1}));
});
test('native session mismatch cannot bind a reused pane',()=>{const agents=[{agent:'claude',pane_id:'w1:p1',agent_session:{value:'new'}}];assert.equal(targetAgent({},agents,{paneId:'w1:p1',nativeId:'old'}),undefined);});
test('routing requires a human and exact application/chat/thread/bot mention',async()=>{
 const b={enabled:true,appId:'a',chatId:'oc_1',rootId:'om_root',requireMention:true,botOpenId:'ou_bot'};
 const raw={sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{message_id:'om_message',chat_id:'oc_1',chat_type:'group',root_id:'om_root',message_type:'text',content:'{"text":"@_user_1 hi"}',mentions:[{key:'@_user_1',id:{open_id:'ou_bot'},name:'bot'}]}};
 const e=await normalize(raw,{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(e.content.trim(),'hi');assert.equal(selectBinding([b],'a',e),b);assert.equal(selectBinding([b],'other',e),null);assert.equal(selectBinding([b],'a',{...e,senderType:'bot'}),null);
 const other=await normalize({...raw,message:{...raw.message,mentions:[{key:'@_user_1',id:{open_id:'ou_other'},name:'other'}]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(selectBinding([b],'a',other),null);assert.equal(selectBinding([b],'a',{...e,rootId:'om_other'}),null);assert.equal(selectBinding([b],'a',{...e,resources:[{type:'image'}]}),null);

});
test('secrets are preserved only for the same application',()=>{const old={id:'a',appId:'cli_old',appSecret:'saved'};assert.equal(normalizeApp({name:'bot',appId:'cli_old',allowedUsers:[]},old).appSecret,'saved');assert.throws(()=>normalizeApp({name:'bot',appId:'cli_new',allowedUsers:[]},old));});
test('inbound dedup and sender allowlist are persisted before processing',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-test-'));try{const store=new Store(dir);const p=new Platforms(store,{});const a={id:'a',enabled:true,allowedUsers:['ou_user'],botOpenId:'ou_bot',name:'bot'};store.data.bindings=[{id:'b',enabled:true,appId:'a',chatId:'oc_1',machineId:'m',adapterId:'x',nativeId:'n',paneId:'w1:p1'}];const e={senderType:'user',senderId:'ou_user',chatId:'oc_1',messageId:'om_1',rawContentType:'text',content:'hi'};p.receive(a,e);p.receive(a,e);p.receive(a,{...e,senderId:'ou_unknown'});assert.equal(store.data.inbox.length,1);assert.equal(new Store(dir).data.inbox[0].status,'queued');assert.ok(!('appSecret' in JSON.parse(JSON.stringify(p.status({...a,appSecret:'private'})))));}finally{fs.rmSync(dir,{recursive:true});}
});
test('unknown outbound result is not replayed automatically',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-test-'));try{const store=new Store(dir),p=new Platforms(store,{});let calls=0;p.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),send:async()=>{calls++;throw Error('timeout');}}});const a={id:'a',name:'bot'},job={messageId:'om_1',replyInThread:true};assert.equal(await p.deliverOnce(a,'once',job,{text:'hello'}),false);assert.equal(await p.deliverOnce(a,'once',job,{text:'hello'}),false);assert.equal(calls,1);assert.equal(store.data.outbox[0].status,'unknown');}finally{fs.rmSync(dir,{recursive:true});}
});

test('actual Python MCP entrypoint initializes and emits same-session channel events',async()=>{
 const {spawn}=await import('node:child_process'),net=await import('node:net'),readline=await import('node:readline');
 const temp=fs.mkdtempSync('/tmp/hb-'),id='11111111-1111-1111-1111-111111111111',d=path.join(temp,'.local/share/herdr-bridge',id);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'meta.json'),JSON.stringify({id,pid:process.pid,nativeId:'native',runtime:'default'}));
 const child=spawn('python3',['remote.py','channel',id],{cwd:path.dirname(new URL(import.meta.url).pathname),env:{...process.env,HOME:temp}}),lines=[];readline.createInterface({input:child.stdout}).on('line',l=>lines.push(JSON.parse(l)));
 try{child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n');for(let i=0;i<100&&!lines.length;i++)await new Promise(r=>setTimeout(r,10));assert.equal(lines[0]?.result?.serverInfo.name,'herdr-bridge');
 const send=b=>new Promise((resolve,reject)=>{const c=net.connect(path.join(d,'channel.sock'));c.on('connect',()=>c.write(JSON.stringify(b)+'\n'));c.on('data',x=>{c.end();resolve(JSON.parse(x));});c.on('error',reject);});
 assert.match((await send({kind:'message',nativeId:'stale',chat_id:'x',text:'hi'})).error,/会话已改变/);
 assert.equal((await send({kind:'message',nativeId:'native',chat_id:'x',text:'hi'})).queued,true);
 await new Promise(r=>setTimeout(r,30));assert.ok(lines.some(x=>x.method==='notifications/claude/channel'&&x.params.content==='hi'));
 assert.equal((await send({kind:'message',nativeId:'native',chat_id:'x',text:'hi'})).duplicate,true);
 assert.match((await send({kind:'permission',nativeId:'native',request_id:'stale',behavior:'allow'})).error,/失效/);
 }finally{child.stdin.end();await new Promise(r=>child.on('close',r));fs.rmSync(temp,{recursive:true});}
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

test('real Channel SDK chunks long replies and sends approval cards in the same thread',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-channel-'));const channel=createLarkChannel({appId:'cli_test',appSecret:'test',transport:'webhook',outbound:{retry:{maxAttempts:1},textChunkLimit:8000},logger:{debug(){},info(){},warn(){},error(){}}});
 const calls=[];channel.rawClient.request=async()=>({bot:{open_id:'ou_bot',app_name:'test'}});channel.rawClient.im.v1.message.reply=async args=>{calls.push(args);return {data:{message_id:'om_reply'+calls.length}};};
 const store=new Store(dir),p=new Platforms(store,{}),a={id:'a',name:'test'},run={chatId:'oc_test',messageId:'om_request',replyInThread:true};
 try{await channel.connect();channel.getConnectionStatus=()=>({state:'connected'});p.runtime.set(a.id,{channel});const long='x'.repeat(24000);assert.equal(await p.deliverOnce(a,'long',run,{text:long}),true);assert.ok(calls.length>1);assert.ok(calls.every(c=>c.data.reply_in_thread===true));assert.equal(calls[0].path.message_id,'om_request');assert.equal(calls.map(c=>JSON.parse(c.data.content).text).join(''),long);assert.equal(store.data.outbox[0].chunkIds.length,calls.length);
 const markdown='## Heading\n'+'x'.repeat(100)+'\n';const count=calls.length;assert.equal(await p.deliverOnce(a,'markdown',run,{text:markdown.repeat(200)}),true);assert.ok(calls.length-count>1);assert.ok(calls.slice(count).every(c=>c.data.msg_type==='post'));
 const card={elements:[{tag:'action',actions:[]}]};assert.equal(await p.deliverOnce(a,'card',run,card,'interactive'),true);assert.equal(calls.at(-1).data.msg_type,'interactive');assert.deepEqual(JSON.parse(calls.at(-1).data.content),card);
 const before=calls.length;await p.deliverOnce(a,'card',run,card,'interactive');assert.equal(calls.length,before);
 }finally{await channel.disconnect();fs.rmSync(dir,{recursive:true});}
});
test('normalized card approvals check the operator and native target',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-approval-')),store=new Store(dir),commands=[];
 const p=new Platforms(store,{sendTarget:async(...args)=>commands.push(args)}),a={id:'a',enabled:true,allowedUsers:['ou_owner']},target={nativeId:'native',paneId:'w1:p1'};
 store.data.bindings=[{id:'b',enabled:true}];store.data.inbox=[{id:'job',appId:'a',bindingId:'b',status:'running',target}];
 const e=normalizeCardAction({operator:{open_id:'ou_owner'},context:{open_message_id:'om_card',open_chat_id:'oc_chat'},action:{value:{runId:'job',requestId:'permission',behavior:'deny'},tag:'button'}});
 try{assert.equal((await p.approval(a,e)).toast.type,'success');assert.deepEqual(commands[0],[target,{kind:'permission',request_id:'permission',behavior:'deny'}]);await assert.rejects(p.approval(a,{...e,operator:{openId:'ou_outsider'}}),/无操作权限/);store.data.inbox[0].status='completed';await assert.rejects(p.approval(a,e),/任务已结束/);}finally{fs.rmSync(dir,{recursive:true});}
});
test('channel startup and shutdown do not revive a cancelled connection',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lifecycle-'));let resolve,options;const handlers={};let closes=0;
 const channel={on:(name,fn)=>handlers[name]=fn,connect:()=>new Promise(r=>resolve=r),disconnect:async()=>{},rawWsClient:{close:()=>closes++},getConnectionStatus:()=>({state:'connected'}),getBotIdentity:()=>({openId:'ou_bot',name:'bot'})};
 const store=new Store(dir),p=new Platforms(store,{}, {channelFactory:o=>{options=o;return channel;}}),a={id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu',enabled:true};
 try{const pending=p.start(a);const rejected=assert.rejects(pending,/连接失败/);assert.equal(options.outbound.retry.maxAttempts,1);assert.equal(options.safety.chatQueue.cardActions,'separate');assert.equal(options.safety.batch.text.delayMs,0);await p.stop(a.id);resolve();await rejected;assert.ok(closes>=2);assert.equal(p.runtime.has(a.id),false);handlers.message({senderId:'ou_owner'});assert.equal(store.data.inbox.length,0);}finally{fs.rmSync(dir,{recursive:true});}
});

test('SDK cache isolates apps and honors namespaces and absolute expiry',async()=>{const a=channelCache(),b=channelCache();await a.set('same','seen',Date.now()+60000,{namespace:'dedup'});assert.equal(await a.get('same',{namespace:'dedup'}),'seen');assert.equal(await b.get('same',{namespace:'dedup'}),undefined);assert.equal(await a.get('same',{namespace:'token'}),undefined);await a.set('expired','old',Date.now()-1);assert.equal(await a.get('expired'),undefined);});
