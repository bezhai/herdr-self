// Tests of messages.ts (see package.json); run with node --test.
import {test} from 'node:test';import strictAssert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Messages} from './messages.ts';import {Store} from './core.ts';import {sourceCard,draftCard} from './outbound-cards.ts';import {clip} from './request-cards.ts';
import type {Call} from './core.ts';import type {App,Machine,Topic,Draft,Source} from './state.ts';import type {ClientApi,OwnerMessage,Sent} from './link.ts';import type {Click} from './request-cards.ts';import type {MessageOps} from './messages.ts';
// The assertions of node:assert/strict without narrowing what they check: a draft changes state after an assertion.
type Narrowing='equal'|'deepEqual'|'ok';
type Assert=Omit<typeof strictAssert,Narrowing>&{[K in Narrowing]:(...args:Parameters<typeof strictAssert[K]>)=>void};
const assert:Assert=strictAssert;
type Deps=NonNullable<ConstructorParameters<typeof Messages>[1]>;
type Handler=(method:keyof ClientApi,params:Record<string,any>)=>unknown;
type CallRecord={machine:Machine,method:keyof ClientApi,params:Record<string,any>};
type ReplyRecord={app:App,chatId:string,rootId:string,card:object};
type UpdateRecord={app:App,messageId:string,card:object};
// A fake of Clients.call, whose generic signature a method-name based test handler does not need.
const fakeCall=(call:(m:Machine,method:keyof ClientApi,params:Record<string,any>)=>Promise<unknown>)=>call as unknown as Call;
const now=Date.parse('2026-11-11T10:00:00Z');
const agentMachine:Machine={id:'agent',name:'cpu1',session:'default',enabled:true};
const ownerMachine:Machine={id:'owner',name:'cpu2',session:'default',enabled:true};
const app:App={id:'a',name:'机器人',appId:'cli_test',appSecret:'test',domain:'feishu',allowedUsers:['ou_owner'],enabled:true,verifiedAt:now};
const message:OwnerMessage={chatId:'chat-1',chatName:'GEO 小分队',chatType:'group',messageId:'message-1',sender:{id:'u1',name:'陈帆'},at:now-1000,text:'原消息',link:'https://example.test/message'};
const chat={chatId:'chat-2',chatName:'产品讨论',chatType:'group'} as const;
const sent:Sent={messageId:'sent-1',at:now+1000,owner:'主人'};
// A ready topic with only the fields Messages reads; the other collections stay empty.
function makeTopic():Topic{return {id:'t',bindingId:'b',appId:'a',chatId:'oc_topic',rootId:'om_root',machineId:'agent',workspaceId:'w',tabId:'tab',paneId:'pane',agentName:'agent',title:'话题',state:'ready',error:'',messageIds:[],replySeq:0,reactions:[],cards:[],createdAt:now};}
// A fixture whose caller, owner channel and Feishu cards are fakes. respond replaces the owner channel's answers during a test.
function fixture(options:{caller?:Deps['topics']['caller'],owner?:Machine|null}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-messages-')),store=new Store(dir),topic=makeTopic(),calls:CallRecord[]=[],replies:ReplyRecord[]=[],updates:UpdateRecord[]=[];
 let owner=options.owner===undefined?ownerMachine:options.owner;
 let handler:Handler=method=>{if(method==='openLarkMessage')return message;if(method==='openLarkChat')return chat;if(method==='openLarkReply'||method==='openLarkSend')return sent;throw Error('未预料的调用：'+method);};
 const caller=options.caller??(async()=>topic),queue:Deps['topics']['queue']=<T>(_t:Topic,task:()=>T|Promise<T>)=>Promise.resolve(task());
 const call=fakeCall(async(machine,method,params)=>{calls.push({machine,method,params});return handler(method,params);});
 const reply:Deps['reply']=async(a,chatId,rootId,{card})=>{replies.push({app:a,chatId,rootId,card});return 'om_card_' + replies.length;};
 const updateCard:Deps['updateCard']=async(a,messageId,card)=>{updates.push({app:a,messageId,card});};
 store.data.topics.push(topic);store.save();
 const messages=new Messages(store,{topics:{caller,queue},app:()=>app,owner:()=>owner,call,reply,updateCard,now:()=>now});
 return {dir,store,topic,messages,calls,replies,updates,respond(next:Handler){handler=next;},setOwner(next:Machine|null){owner=next;},close(){fs.rmSync(dir,{recursive:true});}};
}
// Calls one op with its answer narrowed to that op, just as message-command consumes MessageOps.
async function invoke<K extends keyof MessageOps>(f:ReturnType<typeof fixture>,op:K,request:unknown):Promise<MessageOps[K]['answer']>{
 return await f.messages.call(agentMachine,op,request) as MessageOps[K]['answer'];
}
// A click of one of a draft's buttons, with the submitted text when the editing form supplies it.
function click(d:Draft,draft:'send'|'edit'|'drop'|'cancel',text?:string):Click{return {messageId:d.cardId||'om_card_early',operator:{openId:'ou_owner'},action:{value:{draft,draftId:d.id,render:1},...text!==undefined&&{formValue:{text}}}};}
// The first card is drawn before reply resolves to its card id, which is not part of that drawing.
const atPost=(d:Draft):Draft=>{const copy={...d};delete copy.cardId;return copy;};
// Wait for the asynchronous work that click deliberately does not make Feishu's callback wait for.
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('call rejects an unknown operation and a non-object request before looking up the topic',async t=>{
 const f=fixture({owner:null});t.after(f.close);
 await assert.rejects(f.messages.call(agentMachine,'unknown',null),/未知的操作：unknown/);
 await assert.rejects(invoke(f,'send',null),/请求内容无效/);
});
test('an agent outside a live topic is refused with the caller error unchanged',async t=>{
 const reason='这个 pane 里的 Agent 不属于任何进行中的飞书话题：bridge-message 只能由飞书话题里的 Agent 运行';
 const f=fixture({caller:async()=>{throw Error(reason);}});t.after(f.close);
 await assert.rejects(invoke(f,'attach',{pane:'pane',messageId:'message-1'}),(e:any)=>e.message===reason);
 assert.equal(f.calls.length,0);assert.equal(f.replies.length,0);
});
test('every operation needs the configured open-lark machine',async t=>{
 const f=fixture({owner:null});t.after(f.close);
 await assert.rejects(invoke(f,'attach',{pane:'pane',messageId:'message-1'}),/Bridge 没有配置 open-lark 所在的机器（控制面的 BRIDGE_OPEN_LARK_MACHINE）/);
});
test('attach stores only the source metadata, posts its source card and is idempotent',async t=>{
 const f=fixture();t.after(f.close);
 const first=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 const expected:Source={chatId:'chat-1',chatName:'GEO 小分队',chatType:'group',messageId:'message-1',sender:{id:'u1',name:'陈帆'},at:now-1000,cardId:'om_card_1'};
 assert.deepEqual(first,{source:expected});assert.equal('text' in first.source,false);assert.equal('link' in first.source,false);
 assert.deepEqual(f.replies,[{app,chatId:'oc_topic',rootId:'om_root',card:sourceCard(message,now)}]);
 assert.deepEqual(f.calls,[{machine:ownerMachine,method:'openLarkMessage',params:{messageId:'message-1'}}]);
 const again=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 assert.equal(again.source,first.source);assert.equal(f.calls.length,1);assert.equal(f.replies.length,1);
 assert.deepEqual(new Store(f.dir).data.topics[0].sources,[expected]);
});
test('attach reports an owner-channel failure in the terms of a send failure',async t=>{
 const f=fixture();t.after(f.close);f.respond(()=>{throw Object.assign(Error('offline'),{code:'channel_unreachable'});});
 await assert.rejects(invoke(f,'attach',{pane:'pane',messageId:'message-1'}),/open-lark 没有响应/);
 assert.equal(f.topic.sources?.length??0,0);assert.equal(f.replies.length,0);
});
test('reply refuses a message that is not a source of this topic',async t=>{
 const f=fixture();t.after(f.close);
 await assert.rejects(invoke(f,'reply',{pane:'pane',messageId:'elsewhere',text:'回复'}),/这条消息不在本话题的来源里，先用 attach 放进来/);
 assert.equal(f.replies.length,0);assert.equal(f.topic.drafts?.length??0,0);
});
test('send drafts for the chat open-lark reports rather than the chat the agent names',async t=>{
 const f=fixture();t.after(f.close);f.respond(method=>method==='openLarkChat'?{chatId:'actual-chat',chatName:'真实群名',chatType:'group'}:sent);
 const {draft}=await invoke(f,'send',{pane:'pane',chatId:'agent-chat',text:'正文',mentions:[]});
 assert.deepEqual([draft.chatId,draft.chatName,draft.chatType,draft.state,draft.text,draft.createdAt],['actual-chat','真实群名','group','pending','正文',now]);
 assert.match(draft.id,/^[0-9a-f-]{36}$/);assert.match(draft.clientId,/^[0-9a-f-]{36}$/);
 assert.deepEqual(f.replies[0].card,draftCard(atPost(draft),'pending',{render:1,now}));
 assert.equal(f.replies[0].chatId,'oc_topic');assert.equal(f.replies[0].rootId,'om_root');
});
test('a draft with a mention missing from its text is refused',async t=>{
 const f=fixture();t.after(f.close);
 await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'没有提到名字',mentions:[{id:'u2',name:'孙栎倩'}]}),/正文里没有 @孙栎倩/);
 assert.equal(f.topic.drafts?.length??0,0);assert.equal(f.replies.length,0);
});
test('reply uses its source chat and quoted source, then sends through openLarkReply',async t=>{
 const f=fixture();t.after(f.close);
 const {source}=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 const {draft}=await invoke(f,'reply',{pane:'pane',messageId:'message-1',text:'引用回复',mentions:[]});
 assert.deepEqual([draft.chatId,draft.chatName,draft.chatType,draft.replyTo],['chat-1','GEO 小分队','group','message-1']);
 assert.deepEqual(f.replies[1].card,draftCard(atPost(draft),'pending',{render:1,now,quoted:source}));
 assert.deepEqual(f.messages.click(app,click(draft,'send')),{toast:{type:'info',content:'正在发送'}});await settled();
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkReply',params:{messageId:'message-1',clientId:draft.clientId,text:'引用回复',mentions:[]}});
 assert.equal(draft.state,'sent');assert.deepEqual(f.updates.at(-1),{app,messageId:'om_card_2',card:draftCard(draft,'sent',{render:2,now,quoted:source})});
});
test('a successful send records the sent message and logs the owner, chat and clipped text',async t=>{
 const f=fixture();t.after(f.close);const text='一'.repeat(50)+'末尾';
 const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text,mentions:[]});f.topic.state='closed';
 const response=f.messages.click(app,click(draft,'send'));assert.deepEqual(response,{toast:{type:'info',content:'正在发送'}});await settled();
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkSend',params:{chatId:'chat-2',clientId:draft.clientId,text,mentions:[]}});
 assert.deepEqual([draft.state,draft.sentId,draft.sentAt,draft.failure],['sent','sent-1',now+1000,undefined]);
 assert.deepEqual(f.updates.at(-1),{app,messageId:'om_card_1',card:draftCard(draft,'sent',{render:2,now})});
 assert.deepEqual(f.store.data.logs.at(-1),{at:f.store.data.logs.at(-1)!.at,kind:'消息',level:'info',message:`以 主人 的身份发到 产品讨论：${clip(text,40)}`});
});
test('submitting edited text sends that text under a new client id and drops mentions no longer in it',async t=>{
 const f=fixture();t.after(f.close);const mentions=[{id:'u1',name:'陈帆'},{id:'u2',name:'孙栎倩'}];
 const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'@陈帆 @孙栎倩 旧正文',mentions});const oldClientId=draft.clientId;
 f.messages.click(app,click(draft,'send','@陈帆 新正文'));await settled();
 assert.equal(draft.text,'@陈帆 新正文');assert.notEqual(draft.clientId,oldClientId);assert.deepEqual(draft.mentions,[{id:'u1',name:'陈帆'}]);
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkSend',params:{chatId:'chat-2',clientId:draft.clientId,text:'@陈帆 新正文',mentions:[{id:'u1',name:'陈帆'}]}});
 assert.equal(draft.state,'sent');assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'sent',{render:2,now}));
});
test('drop marks a draft unsent and a later stale send click does not send it',async t=>{
 const f=fixture();t.after(f.close);const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 assert.deepEqual(f.messages.click(app,click(draft,'drop')),{toast:{type:'info',content:'已取消发送'}});await settled();
 assert.equal(draft.state,'dropped');assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'dropped',{render:2,now}));
 const updates=f.updates.length;f.messages.click(app,click(draft,'send'));await settled();
 assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);assert.equal(f.updates.length,updates);
});
test('edit draws the form and cancel restores the pending card without changing the draft',async t=>{
 const f=fixture();t.after(f.close);const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'原正文',mentions:[]}),clientId=draft.clientId;
 assert.deepEqual(f.messages.click(app,click(draft,'edit')),{toast:{type:'info',content:'请修改正文'}});await settled();
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'editing',{render:2,now}));
 assert.deepEqual(f.messages.click(app,click(draft,'cancel','没有保存的正文')),{toast:{type:'info',content:'已取消修改'}});await settled();
 assert.deepEqual([draft.text,draft.clientId,draft.state],['原正文',clientId,'pending']);
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'pending',{render:3,now}));assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);
});
test('send failures name their cause on a pending card, log an error and can be retried',async t=>{
 const cases:[string,Error,string][]=[
  ['client offline',Object.assign(Error('offline'),{code:'client_offline'}),'cpu2 的 Bridge 客户端不在线'],
  ['channel unconfigured',Object.assign(Error('no config'),{code:'channel_unconfigured'}),'cpu2 的 Bridge 客户端没有配置 open-lark'],
  ['channel unreachable',Object.assign(Error('unreachable'),{code:'channel_unreachable'}),'open-lark 没有响应'],
  ['request timeout',Object.assign(Error('timeout'),{timedOut:true}),'open-lark 没有响应'],
  ['channel refused',Object.assign(Error('SENDER_CHANGED：账号已更换'),{code:'channel_refused'}),'open-lark 拒绝了这次发送：SENDER_CHANGED：账号已更换'],
 ];
 for(const [name,error,reason] of cases)await t.test(name,async t=>{
  const f=fixture();t.after(f.close);const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
  f.respond(method=>{if(method==='openLarkSend')throw error;return sent;});f.messages.click(app,click(draft,'send'));await settled();
  assert.equal(draft.state,'pending');assert.equal(draft.failure,reason);assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'pending',{render:2,now}));
  assert.deepEqual(f.store.data.logs.at(-1),{at:f.store.data.logs.at(-1)!.at,kind:'消息',level:'error',message:'未能发到 产品讨论：'+reason});
  f.respond(()=>sent);f.messages.click(app,click(draft,'send'));await settled();
  assert.equal(f.calls.filter(c=>c.method==='openLarkSend').length,2);assert.deepEqual([draft.state,draft.failure],['sent',undefined]);
  assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'sent',{render:3,now}));
 });
});
test('a refused send keeps the full multiline open-lark explanation on the card and in the log',async t=>{
 const f=fixture();t.after(f.close);const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 const explanation='第一行说明\n'+'后'.repeat(250)+'\n最后一行',error=Object.assign(Error('REFUSED：'+explanation),{code:'channel_refused'}),reason='open-lark 拒绝了这次发送：REFUSED：'+explanation;
 f.respond(method=>{if(method==='openLarkSend')throw error;return sent;});f.messages.click(app,click(draft,'send'));await settled();
 assert.equal(draft.failure,reason);assert.deepEqual(f.updates.at(-1)!.card,draftCard(draft,'pending',{render:2,now}));
 assert.equal(f.store.data.logs.at(-1)!.message,'未能发到 产品讨论：'+reason);assert.equal(f.store.data.logs.at(-1)!.level,'error');
});
test('a send click without an owner fails on the card and can be retried after configuration',async t=>{
 const f=fixture();t.after(f.close);const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});f.setOwner(null);
 f.messages.click(app,click(draft,'send'));await settled();assert.equal(draft.failure,'没有配置 open-lark 所在的机器');assert.equal(draft.state,'pending');
 assert.equal(f.store.data.logs.at(-1)!.message,'未能发到 产品讨论：没有配置 open-lark 所在的机器');
 f.setOwner(ownerMachine);f.messages.click(app,click(draft,'send'));await settled();assert.equal(draft.state,'sent');
});
test('two clicks of the same card while a send is in flight produce only one send',async t=>{
 const f=fixture();t.after(f.close);const {draft}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});let resolve!:(value:Sent)=>void;
 f.respond(method=>method==='openLarkSend'?new Promise<Sent>(r=>{resolve=r;}):sent);
 const first=f.messages.click(app,click(draft,'send')),second=f.messages.click(app,click(draft,'send'));
 assert.deepEqual(first,{toast:{type:'info',content:'正在发送'}});assert.deepEqual(second,{toast:{type:'info',content:'正在发送，请稍候'}});
 assert.equal(f.calls.filter(c=>c.method==='openLarkSend').length,1);resolve(sent);await settled();
 assert.equal(draft.state,'sent');assert.equal(f.calls.filter(c=>c.method==='openLarkSend').length,1);
});
test('a click whose draft id is not in the app gets only an expired-card toast',t=>{
 const f=fixture();t.after(f.close);const d={id:'missing'} as Draft;
 assert.deepEqual(f.messages.click(app,click(d,'send')),{toast:{type:'info',content:'这张卡片已失效'}});assert.equal(f.updates.length,0);
});
