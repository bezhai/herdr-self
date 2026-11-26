// Tests of messages.ts (see package.json); run with node --test.
import {test} from 'node:test';import strictAssert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Messages,ownerSink} from './messages.ts';import {Outbox} from './outbox.ts';import {notice} from './message-cards.ts';import {Store} from './core.ts';import {Tasks} from './task-core.ts';import {sourceCard,draftCard} from './outbound-cards.ts';import {clip} from './request-cards.ts';
import type {Call} from './core.ts';import type {App,Machine,Topic} from './state.ts';import type {ClientApi,OwnerMessage,Sent} from './link.ts';import type {Click} from './request-cards.ts';import type {MessageOps} from './messages.ts';import type {Body} from './outbound-cards.ts';
import type {Delivery,Policy} from './task-types.ts';
// The assertions of node:assert/strict without narrowing what they check: the state of a delivery changes after an assertion.
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
// A doc that open-lark found in a sent message and gave the chat access to.
const doc={url:'https://example.feishu.cn/docx/abc',title:'方案',granted:true};
// An image and a file as bridge-message sends them, and a text that links the doc.
const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2]),pdf=Buffer.from('%PDF-1.7 报告');
const files=[{kind:'image',name:'截图.png',data:png.toString('base64')},{kind:'file',name:'季度报告.pdf',data:pdf.toString('base64')}];
const linked='方案见 https://example.feishu.cn/docx/abc';
// The policy of server.ts: what goes out as the owner needs approval, nothing else does.
const policy:Policy={deliver:(_t,_o,target)=>'sink' in target&&target.sink==='as-owner'?'approve':'allow',end:()=>'allow'};
// A ready topic with only the fields Messages reads; it has no task yet.
function makeTopic():Topic{return {id:'t',bindingId:'b',appId:'a',chatId:'oc_topic',rootId:'om_root',machineId:'agent',workspaceId:'w',tabId:'tab',paneId:'pane',agentName:'agent',title:'话题',state:'ready',error:'',messageIds:[],replySeq:0,reactions:[],cards:[],createdAt:now,task:{messageId:'om_first',content:'整理一下周报'}};}
// A fixture whose caller, owner channel and Feishu cards are fakes, over a real task core on :memory:. respond replaces the owner channel's answers.
function fixture(options:{caller?:Deps['topics']['caller'],owner?:Machine|null}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-messages-')),store=new Store(dir),topic=makeTopic(),calls:CallRecord[]=[],replies:ReplyRecord[]=[],updates:UpdateRecord[]=[];
 let owner=options.owner===undefined?ownerMachine:options.owner,rejectReply:Error|null=null,rejectUpdate:Error|null=null;
 let handler:Handler=method=>{
  if(method==='openLarkMessage')return message;if(method==='openLarkChat')return chat;if(method==='openLarkReply'||method==='openLarkSend')return sent;
  if(method==='openLarkImage')return {messageId:'img-1'};if(method==='openLarkFile')return {messageId:'file-1'};if(method==='openLarkDocAccess')return {docs:[doc]};
  throw Error('未预料的调用：'+method);
 };
 const caller=options.caller??(async()=>topic),queue:Deps['topics']['queue']=<T>(_t:Topic,task:()=>T|Promise<T>)=>Promise.resolve(task());
 const call=fakeCall(async(machine,method,params)=>{calls.push({machine,method,params});return handler(method,params);});
 const reply:Deps['reply']=async(a,chatId,rootId,{card})=>{if(rejectReply)throw rejectReply;replies.push({app:a,chatId,rootId,card});return 'om_card_'+replies.length;};
 const updateCard:Deps['updateCard']=async(a,messageId,card)=>{if(rejectUpdate)throw rejectUpdate;updates.push({app:a,messageId,card});};
 store.data.topics.push(topic);store.save();
 const outbox=new Outbox(path.join(dir,'outbox'));
 const tasks=new Tasks(':memory:',{sinks:{'as-owner':ownerSink({owner:()=>owner,call,outbox})},policy,now:()=>now});
 // The topic's task is made when something first needs it, as Topics.task does.
 const task:Deps['topics']['task']=t=>{if(!t.taskId){t.taskId=tasks.create(t.task?.content||t.title).id;store.save();}return t.taskId;};
 const messages=new Messages(store,{tasks,topics:{caller,queue,task},app:()=>app,owner:()=>owner,call,reply,updateCard,outbox,now:()=>now});
 // Wait for the observers of the task core and for the asynchronous work that a click deliberately does not make Feishu's callback wait for.
 const flush=async()=>{for(let i=0;i<4;i++){await new Promise<void>(resolve=>setImmediate(resolve));await tasks.settled();}};
 return {dir,store,topic,tasks,messages,calls,replies,updates,flush,outbox,
  // The names in the outbox: the bytes of attachments and the progress of sends.
  kept:()=>fs.readdirSync(path.join(dir,'outbox')).sort(),
  deliveries:():Delivery[]=>topic.taskId?tasks.get(topic.taskId).deliveries:[],
  respond(next:Handler){handler=next;},setOwner(next:Machine|null){owner=next;},failReply(e:Error|null){rejectReply=e;},failUpdate(e:Error|null){rejectUpdate=e;},
  async close(){await tasks.close();fs.rmSync(dir,{recursive:true});}};
}
// Calls one op with its answer narrowed to that op, just as message-command consumes MessageOps.
async function invoke<K extends keyof MessageOps>(f:ReturnType<typeof fixture>,op:K,request:unknown):Promise<MessageOps[K]['answer']>{
 return await f.messages.call(agentMachine,op,request) as MessageOps[K]['answer'];
}
// A click of one of a delivery's buttons, with the submitted text when the editing form supplies it.
function click(d:Delivery,action:'send'|'edit'|'drop'|'cancel',text?:string,messageId='om_card_early'):Click{return {messageId,operator:{openId:'ou_owner'},action:{value:{draft:action,deliveryId:d.id,render:1},...text!==undefined&&{formValue:{text}}}};}
// The delivery d as the task core has it now.
const current=(f:ReturnType<typeof fixture>,d:Delivery)=>f.tasks.get(f.topic.taskId!).deliveries.find(x=>x.id===d.id)!;
const bodyOf=(d:Delivery)=>d.body as Body;
const lastLog=(f:ReturnType<typeof fixture>)=>f.store.data.logs.at(-1)!;
const toast=(content:string)=>({toast:{type:'info',content}});

test('call rejects an unknown operation and a non-object request before looking up the topic',async t=>{
 const f=fixture({owner:null});t.after(f.close);
 await assert.rejects(f.messages.call(agentMachine,'unknown',null),/未知的操作：unknown/);
 await assert.rejects(invoke(f,'send',null),/请求内容无效/);
});
test('an agent outside a live topic is refused with the caller error unchanged',async t=>{
 const reason='这个 pane 里的 Agent 不属于任何进行中的飞书话题：bridge-message 只能由飞书话题里的 Agent 运行';
 const f=fixture({caller:async()=>{throw Error(reason);}});t.after(f.close);
 await assert.rejects(invoke(f,'attach',{pane:'pane',messageId:'message-1'}),(e:any)=>e.message===reason);
 assert.equal(f.calls.length,0);assert.equal(f.replies.length,0);assert.equal(f.tasks.list().length,0);
});
test('every operation needs the configured open-lark machine',async t=>{
 const f=fixture({owner:null});t.after(f.close);
 await assert.rejects(invoke(f,'attach',{pane:'pane',messageId:'message-1'}),/Bridge 没有配置 open-lark 所在的机器（控制面的 BRIDGE_OPEN_LARK_MACHINE）/);
});
test('the first use makes the topic a task whose goal is the first message, or the title without one, and later uses reuse it',async t=>{
 const f=fixture();t.after(f.close);
 await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 assert.equal(f.tasks.list().length,1);assert.equal(f.tasks.get(f.topic.taskId!).goal,'整理一下周报');
 assert.equal(new Store(f.dir).data.topics[0].taskId,f.topic.taskId);
 await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});assert.equal(f.tasks.list().length,1);
 const g=fixture();t.after(g.close);delete g.topic.task;
 await invoke(g,'attach',{pane:'pane',messageId:'message-1'});assert.equal(g.tasks.get(g.topic.taskId!).goal,'话题');
});
test('attach adds the message as read as an input with an open-lark ref, posts its source card and is idempotent',async t=>{
 const f=fixture();t.after(f.close);
 const first=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 assert.equal(first.input.ref,'open-lark:message-1');assert.deepEqual(first.input.body,message);
 assert.deepEqual(f.tasks.get(f.topic.taskId!).inputs.map(i=>i.id),[first.input.id]);
 assert.deepEqual(f.replies,[{app,chatId:'oc_topic',rootId:'om_root',card:sourceCard(message,now)}]);
 assert.deepEqual(f.calls,[{machine:ownerMachine,method:'openLarkMessage',params:{messageId:'message-1'}}]);
 const again=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 assert.equal(again.input.id,first.input.id);assert.equal(f.tasks.get(f.topic.taskId!).inputs.length,1);assert.equal(f.replies.length,1);
});
test('attach reports an owner-channel failure in the terms of a send failure',async t=>{
 const f=fixture();t.after(f.close);f.respond(()=>{throw Object.assign(Error('offline'),{code:'channel_unreachable'});});
 await assert.rejects(invoke(f,'attach',{pane:'pane',messageId:'message-1'}),/open-lark 没有响应/);
 assert.equal(f.tasks.get(f.topic.taskId!).inputs.length,0);assert.equal(f.replies.length,0);
});
test('a card that does not fit is refused before anything is recorded',async t=>{
 const f=fixture();t.after(f.close);
 await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'长'.repeat(60000),mentions:[]}),/正文太长，确认卡片放不下，请缩短后重新提交/);
 assert.equal(f.replies.length,0);assert.equal(f.deliveries().length,0);assert.equal(f.tasks.get(f.topic.taskId!).outputs.length,0);
});
test('a card that Feishu refuses is logged with its reason, reported to the agent and leaves the delivery rejected',async t=>{
 const f=fixture();t.after(f.close);f.failReply(Error('invalid card\nsecond line'));
 await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'你好'}),/确认卡片没有发出去：invalid card，请稍后重试/);
 assert.deepEqual(f.deliveries().map(d=>d.state),['rejected']);
 assert.deepEqual(f.store.data.logs.find(l=>l.level==='error'),{at:lastLog(f).at,kind:'消息',level:'error',message:'确认卡片没有发出去：invalid card'});
});
test('reply refuses a message that is not an input of this topic',async t=>{
 const f=fixture();t.after(f.close);
 await assert.rejects(invoke(f,'reply',{pane:'pane',messageId:'elsewhere',text:'回复'}),/这条消息不在本话题的来源里，先用 attach 放进来/);
 assert.equal(f.replies.length,0);assert.equal(f.deliveries().length,0);
});
test('send drafts for the chat open-lark reports rather than the chat the agent names, as an awaiting delivery to as-owner',async t=>{
 const f=fixture();t.after(f.close);f.respond(method=>method==='openLarkChat'?{chatId:'actual-chat',chatName:'真实群名',chatType:'group'}:sent);
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'agent-chat',text:'正文',mentions:[]});
 assert.deepEqual(d.target,{sink:'as-owner',to:{chatId:'actual-chat',chatName:'真实群名',chatType:'group'}});assert.deepEqual(d.body,{text:'正文',mentions:[]});assert.equal(d.state,'awaiting');
 assert.deepEqual(f.tasks.get(f.topic.taskId!).outputs.map(o=>[o.id,o.body]),[[d.output,{text:'正文',mentions:[]}]]);
 assert.deepEqual(f.replies[0].card,draftCard(d,'pending',{render:1,now}));assert.equal(f.replies[0].chatId,'oc_topic');assert.equal(f.replies[0].rootId,'om_root');
 assert.deepEqual(f.topic.deliveryCards,{[d.id]:'om_card_1'});assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);
});
test('a draft with a mention missing from its text is refused',async t=>{
 const f=fixture();t.after(f.close);
 await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'没有提到名字',mentions:[{id:'u2',name:'孙栎倩'}]}),/正文里没有 @孙栎倩/);
 assert.equal(f.deliveries().length,0);assert.equal(f.replies.length,0);
});
test('reply uses the chat of its input and quotes it, then sends through openLarkReply with the key as client id',async t=>{
 const f=fixture();t.after(f.close);
 await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 const {delivery:d}=await invoke(f,'reply',{pane:'pane',messageId:'message-1',text:'引用回复',mentions:[]});
 assert.deepEqual(d.target,{sink:'as-owner',to:{chatId:'chat-1',chatName:'GEO 小分队',chatType:'group',replyTo:'message-1'}});
 assert.deepEqual(f.replies[1].card,draftCard(d,'pending',{render:1,now,quoted:message}));
 assert.deepEqual(f.messages.click(app,click(d,'send')),toast('正在发送'));await f.flush();
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkReply',params:{messageId:'message-1',clientId:d.key,text:'引用回复',mentions:[]}});
 const after=current(f,d);assert.equal(after.state,'delivered');assert.deepEqual(after.receipt,sent);
 assert.deepEqual(f.updates.at(-1),{app,messageId:'om_card_2',card:draftCard(after,'sent',{render:2,now,quoted:message})});
});
test('a reply to a message inside a thread goes into that thread, and its card says so',async t=>{
 const f=fixture();t.after(f.close);const threaded:OwnerMessage={...message,inThread:true};
 f.respond(method=>method==='openLarkMessage'?threaded:sent);
 const {input}=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});assert.equal(input.body.inThread,true);
 const {delivery:d}=await invoke(f,'reply',{pane:'pane',messageId:'message-1',text:'跟进',mentions:[]});
 assert.deepEqual(d.target,{sink:'as-owner',to:{chatId:'chat-1',chatName:'GEO 小分队',chatType:'group',replyTo:'message-1',thread:true}});
 assert.deepEqual(f.replies[1].card,draftCard(d,'pending',{render:1,now,quoted:threaded}));assert.match(JSON.stringify(f.replies[1].card),/，发在话题里/);
 f.messages.click(app,click(d,'send'));await f.flush();
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkReply',params:{messageId:'message-1',clientId:d.key,text:'跟进',mentions:[],thread:true}});
 assert.equal(current(f,d).state,'delivered');
});
test('a successful send logs the owner, chat and clipped text and redraws the card as sent',async t=>{
 const f=fixture();t.after(f.close);const text='一'.repeat(50)+'末尾';
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text,mentions:[]});
 assert.deepEqual(f.messages.click(app,click(d,'send')),toast('正在发送'));await f.flush();
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkSend',params:{chatId:'chat-2',clientId:d.key,text,mentions:[]}});
 assert.deepEqual(f.updates.at(-1),{app,messageId:'om_card_1',card:draftCard(current(f,d),'sent',{render:2,now})});
 assert.deepEqual(lastLog(f),{at:lastLog(f).at,kind:'消息',level:'info',message:`以 主人 的身份发到 产品讨论：${clip(text,40)}`});
 assert.deepEqual(f.messages.click(app,click(d,'send')),toast('这条消息已经发送'));
});
test('submitting edited text sends that text under a new key and drops mentions no longer in it',async t=>{
 const f=fixture();t.after(f.close);const mentions=[{id:'u1',name:'陈帆'},{id:'u2',name:'孙栎倩'}];
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'@陈帆 @孙栎倩 旧正文',mentions});
 f.messages.click(app,click(d,'send','@陈帆 新正文'));await f.flush();
 const after=current(f,d);assert.deepEqual(after.body,{text:'@陈帆 新正文',mentions:[{id:'u1',name:'陈帆'}]});assert.notEqual(after.key,d.key);
 assert.deepEqual(f.calls.at(-1),{machine:ownerMachine,method:'openLarkSend',params:{chatId:'chat-2',clientId:after.key,text:'@陈帆 新正文',mentions:[{id:'u1',name:'陈帆'}]}});
 assert.equal(after.state,'delivered');assert.deepEqual(f.updates.at(-1)!.card,draftCard(after,'sent',{render:2,now}));
});
test('drop rejects the delivery and a later stale send click does not send it',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 assert.deepEqual(f.messages.click(app,click(d,'drop')),toast('已取消发送'));await f.flush();
 assert.equal(current(f,d).state,'rejected');assert.deepEqual(f.updates.at(-1)!.card,draftCard(current(f,d),'dropped',{render:2,now}));
 const updates=f.updates.length;assert.deepEqual(f.messages.click(app,click(d,'send')),toast('这条消息已取消发送'));await f.flush();
 assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);assert.equal(f.updates.length,updates);
});
test('withdraw takes back an awaiting draft of the topic by a unique prefix of its id: the card says the agent withdrew it and a stale click sends nothing',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 const {delivery:w}=await invoke(f,'withdraw',{pane:'pane',draftId:' '+d.id.slice(0,8)+' '});
 assert.equal(w.id,d.id);assert.equal(w.state,'rejected');assert.equal(f.tasks.journal(f.topic.taskId!).at(-1)!.data.decision,'withdrawn');
 await f.flush();assert.deepEqual(f.updates.at(-1),{app,messageId:'om_card_1',card:draftCard(current(f,d),'withdrawn',{render:2,now})});
 assert.deepEqual(f.messages.click(app,click(d,'send')),toast('这条消息已取消发送'));await f.flush();
 assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);assert.equal(f.updates.length,1);
});
test('withdraw refuses a missing id, a draft of another task, an ambiguous prefix, and a draft that is sending, sent, failed, not sent or being edited',async t=>{
 const f=fixture();t.after(f.close);const draft=async()=>(await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]})).delivery;
 const withdraw=(draftId:unknown)=>invoke(f,'withdraw',{pane:'pane',draftId});
 await assert.rejects(withdraw(undefined),/^Error: 缺少草稿 ID$/);await assert.rejects(withdraw('  '),/缺少草稿 ID/);
 const other=f.tasks.create('别的话题'),elsewhere=await f.tasks.deliver(f.tasks.addOutput(other.id,{text:'别处',mentions:[]}).id,{sink:'as-owner',to:chat});
 await assert.rejects(withdraw(elsewhere.id),(e:Error)=>e.message===`本话题没有 ID 以 ${elsewhere.id} 开头的草稿：只能撤回这个话题里起草的草稿，ID 见 reply 或 send 的输出`);
 assert.equal(f.tasks.get(other.id).deliveries[0].state,'awaiting');
 // Of 17 drafts, two share the first hexadecimal digit of their ids.
 const many=[];for(let i=0;i<17;i++)many.push(await draft());
 const shared=many.map(d=>d.id[0]).find((c,i,all)=>all.indexOf(c)!==i)!;
 await assert.rejects(withdraw(shared),(e:Error)=>e.message===`有多个草稿的 ID 以 ${shared} 开头，请写完整的 ID`);
 // The owner channel answers sends as answer does and reads chats as usual.
 const sends=(answer:()=>unknown)=>f.respond(method=>method==='openLarkChat'?chat:method==='openLarkSend'?answer():sent);
 let resolve!:(value:Sent)=>void;const sending=await draft();sends(()=>new Promise<Sent>(r=>{resolve=r;}));
 f.messages.click(app,click(sending,'send'));await new Promise<void>(r=>setImmediate(r));
 await assert.rejects(withdraw(sending.id),(e:Error)=>e.message==='这份草稿正在发送，不能撤回');
 resolve(sent);await f.flush();await assert.rejects(withdraw(sending.id),(e:Error)=>e.message==='这份草稿已经发出，不能撤回');
 const failed=await draft();sends(()=>{throw Object.assign(Error('x'),{code:'channel_unreachable'});});
 f.messages.click(app,click(failed,'send'));await f.flush();assert.equal(current(f,failed).state,'failed');
 await assert.rejects(withdraw(failed.id),(e:Error)=>e.message==='主人点过「发送」但没有发出去，不能撤回：由主人在卡片上重试或者点「不发」');
 const dropped=await draft();f.messages.click(app,click(dropped,'drop'));await f.flush();
 await assert.rejects(withdraw(dropped.id),(e:Error)=>e.message==='这份草稿已经不发了，不用撤回');
 const edited=await draft();f.messages.click(app,click(edited,'edit'));await f.flush();
 await assert.rejects(withdraw(edited.id),(e:Error)=>e.message==='主人正在修改这份草稿，不能撤回：等主人改完发送或者取消修改');
 f.messages.click(app,click(edited,'cancel'));await f.flush();assert.equal((await withdraw(edited.id)).delivery.state,'rejected');
 await assert.rejects(withdraw(edited.id),(e:Error)=>e.message==='这份草稿已经不发了，不用撤回');
});
test('edit draws the form and cancel restores the pending card without changing the delivery',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'原正文',mentions:[]});
 assert.deepEqual(f.messages.click(app,click(d,'edit')),toast('请修改正文'));await f.flush();
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(d,'editing',{render:2,now}));
 assert.deepEqual(f.messages.click(app,click(d,'cancel','没有保存的正文')),toast('已取消修改'));await f.flush();
 assert.deepEqual(current(f,d),d);assert.deepEqual(f.updates.at(-1)!.card,draftCard(d,'pending',{render:3,now}));assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);
});
test('send failures name their cause on a pending card, log an error, and a retry click sends with the same key',async t=>{
 const cases:[string,Error,string][]=[
  ['client offline',Object.assign(Error('offline'),{code:'client_offline'}),'cpu2 的 Bridge 客户端不在线'],
  ['channel unconfigured',Object.assign(Error('no config'),{code:'channel_unconfigured'}),'cpu2 的 Bridge 客户端没有配置 open-lark'],
  ['channel unreachable',Object.assign(Error('unreachable'),{code:'channel_unreachable'}),'open-lark 没有响应'],
  ['request timeout',Object.assign(Error('timeout'),{timedOut:true}),'open-lark 没有响应'],
  ['channel refused',Object.assign(Error('SENDER_CHANGED：账号已更换'),{code:'channel_refused'}),'open-lark 拒绝了这次发送：SENDER_CHANGED：账号已更换'],
 ];
 for(const [name,error,reason] of cases)await t.test(name,async t=>{
  const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
  f.respond(method=>{if(method==='openLarkSend')throw error;return sent;});f.messages.click(app,click(d,'send'));await f.flush();
  const failed=current(f,d);assert.equal(failed.state,'failed');assert.equal(failed.error,reason);assert.deepEqual(f.updates.at(-1)!.card,draftCard(failed,'pending',{render:2,now}));
  assert.deepEqual(lastLog(f),{at:lastLog(f).at,kind:'消息',level:'error',message:'未能发到 产品讨论：'+reason});
  f.respond(()=>sent);assert.deepEqual(f.messages.click(app,click(d,'send')),toast('正在发送'));await f.flush();
  const sends=f.calls.filter(c=>c.method==='openLarkSend');assert.equal(sends.length,2);assert.deepEqual(sends.map(c=>c.params.clientId),[d.key,d.key]);
  assert.deepEqual([current(f,d).state,current(f,d).error],['delivered',null]);assert.deepEqual(f.updates.at(-1)!.card,draftCard(current(f,d),'sent',{render:4,now}));
 });
});
test('a refused send keeps the full multiline open-lark explanation on the card and in the log',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 const explanation='第一行说明\n'+'后'.repeat(250)+'\n最后一行',error=Object.assign(Error('REFUSED：'+explanation),{code:'channel_refused'}),reason='open-lark 拒绝了这次发送：REFUSED：'+explanation;
 f.respond(method=>{if(method==='openLarkSend')throw error;return sent;});f.messages.click(app,click(d,'send'));await f.flush();
 assert.equal(current(f,d).error,reason);assert.deepEqual(f.updates.at(-1)!.card,draftCard(current(f,d),'pending',{render:2,now}));
 assert.equal(lastLog(f).message,'未能发到 产品讨论：'+reason);assert.equal(lastLog(f).level,'error');
});
test('a send click without an owner fails on the card and can be retried after configuration',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});f.setOwner(null);
 f.messages.click(app,click(d,'send'));await f.flush();assert.equal(current(f,d).error,'没有配置 open-lark 所在的机器');assert.equal(current(f,d).state,'failed');
 assert.equal(lastLog(f).message,'未能发到 产品讨论：没有配置 open-lark 所在的机器');
 f.setOwner(ownerMachine);f.messages.click(app,click(d,'send'));await f.flush();assert.equal(current(f,d).state,'delivered');
});
test('an edit form with whitespace-only text is refused on the card and sends nothing',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 f.messages.click(app,click(d,'send','  \n '));await f.flush();
 assert.equal(current(f,d).state,'awaiting');assert.deepEqual(f.updates.at(-1)!.card,draftCard(current(f,d),'pending',{render:2,now,failure:'正文不能为空'}));
 assert.equal(f.calls.filter(c=>c.method==='openLarkSend').length,0);assert.deepEqual(lastLog(f),{at:lastLog(f).at,kind:'消息',level:'error',message:'未能发到 产品讨论：正文不能为空'});
});
test('two clicks of the same card while a send is in flight produce only one send',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});let resolve!:(value:Sent)=>void;
 f.respond(method=>method==='openLarkSend'?new Promise<Sent>(r=>{resolve=r;}):sent);
 const first=f.messages.click(app,click(d,'send')),second=f.messages.click(app,click(d,'send'));
 assert.deepEqual(first,toast('正在发送'));assert.deepEqual(second,toast('正在发送，请稍候'));
 await new Promise<void>(r=>setImmediate(r));assert.equal(f.calls.filter(c=>c.method==='openLarkSend').length,1);resolve(sent);await f.flush();
 assert.equal(current(f,d).state,'delivered');assert.equal(f.calls.filter(c=>c.method==='openLarkSend').length,1);
});
test('a click that arrives before the card id was saved records the card id of the event',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 delete f.topic.deliveryCards![d.id];f.messages.click(app,click(d,'edit',undefined,'om_early'));await f.flush();
 assert.equal(f.topic.deliveryCards![d.id],'om_early');assert.equal(f.updates.at(-1)!.messageId,'om_early');
});
test('a click on an old draft card or on an unknown delivery gets only an expired-card toast',async t=>{
 const f=fixture();t.after(f.close);await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 const old={messageId:'om_old',operator:{openId:'ou_owner'},action:{value:{draft:'send',draftId:'old-draft',render:1}}} as Click;
 assert.deepEqual(f.messages.click(app,old),toast('这张卡片已失效'));
 assert.deepEqual(f.messages.click(app,click({id:'missing'} as Delivery,'send')),toast('这张卡片已失效'));await f.flush();
 assert.equal(f.updates.length,0);assert.equal(f.calls.some(c=>c.method==='openLarkSend'),false);
});
test('a failure while drawing one record is logged and does not stall the records after it',async t=>{
 const f=fixture();t.after(f.close);f.failReply(Error('card refused'));
 const first=await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 assert.equal(f.tasks.get(f.topic.taskId!).inputs.length,1);assert.equal(f.replies.length,0);
 assert.ok(f.store.data.logs.some(l=>l.level==='error'&&l.message.includes('card refused')));
 f.failReply(null);f.respond(method=>method==='openLarkMessage'?{...message,messageId:'message-2'}:method==='openLarkChat'?chat:sent);
 const second=await invoke(f,'attach',{pane:'pane',messageId:'message-2'});assert.notEqual(second.input.id,first.input.id);
 assert.deepEqual(f.replies.map(r=>r.card),[sourceCard({...message,messageId:'message-2'},now)]);
});
test('a failed card update is only logged and never turns a successful send into a retry',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 f.failUpdate(Error('update refused'));f.messages.click(app,click(d,'send'));await f.flush();
 assert.equal(current(f,d).state,'delivered');assert.ok(f.store.data.logs.some(l=>l.level==='error'&&l.message.includes('update refused')));
});

test('the thread shows when the task ended and when it was reopened, with the reason, as notices',async t=>{
 const f=fixture();t.after(f.close);
 await invoke(f,'attach',{pane:'pane',messageId:'message-1'});await f.flush();f.replies.length=0;
 f.tasks.end(f.topic.taskId!,'achieved','周报已整理并发给了主人');await f.flush();
 f.tasks.reopen(f.topic.taskId!,'owner wrote');await f.flush();
 f.tasks.end(f.topic.taskId!,'dropped','主人说不用了');await f.flush();
 assert.deepEqual(f.replies.map(r=>r.card),[notice('任务已完成：周报已整理并发给了主人'),notice('任务已重新打开'),notice('任务已放弃：主人说不用了')]);
 assert.deepEqual(f.replies.map(r=>[r.chatId,r.rootId]),Array(3).fill(['oc_topic','om_root']));
});
test('attach brings a message into an ended task without reopening it',async t=>{
 const f=fixture();t.after(f.close);
 await invoke(f,'attach',{pane:'pane',messageId:'message-1'});f.tasks.end(f.topic.taskId!,'achieved','好了');
 await invoke(f,'attach',{pane:'pane',messageId:'message-2'});
 assert.equal(f.tasks.get(f.topic.taskId!).state,'achieved');assert.equal(f.tasks.get(f.topic.taskId!).inputs.length,2);
});
test('reply and send on an ended task are refused with a readable message and draft nothing',async t=>{
 const f=fixture();t.after(f.close);
 await invoke(f,'attach',{pane:'pane',messageId:'message-1'});f.tasks.end(f.topic.taskId!,'achieved','好了');f.replies.length=0;
 const refused=(e:Error&{code?:string})=>e.message==='这个任务已经结束，不能再起草消息：主人在话题里再写一条消息后任务会重新打开'&&e.code===undefined;
 await assert.rejects(invoke(f,'reply',{pane:'pane',messageId:'message-1',text:'好的'}),refused);
 await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'你好'}),refused);
 assert.equal(f.deliveries().length,0);assert.equal(f.tasks.get(f.topic.taskId!).outputs.length,0);
});
// The fixture's topic and a later one that holds the same task, as a re-adopted agent session does (see Topics.adopt).
function later(f:ReturnType<typeof fixture>){const t:Topic={...f.topic,id:'t2',rootId:'om_root2',chatId:'oc_topic2',createdAt:now+1,deliveryCards:undefined};f.store.data.topics.push(t);f.store.save();return t;}
test('of the topics that hold a task, the notices of its end and reopening and the source cards go to the latest one, whatever the order of the list',async t=>{
 const f=fixture();t.after(f.close);await invoke(f,'attach',{pane:'pane',messageId:'message-1'});await f.flush();
 const second=later(f);f.store.data.topics.reverse();f.replies.length=0;
 f.tasks.end(f.topic.taskId!,'achieved','好了');await f.flush();f.tasks.reopen(f.topic.taskId!,'owner wrote');await f.flush();
 assert.deepEqual(f.replies.map(r=>[r.chatId,r.rootId,r.card]),[['oc_topic2','om_root2',notice('任务已完成：好了')],['oc_topic2','om_root2',notice('任务已重新打开')]]);
 assert.equal(second.taskId,f.topic.taskId);
});
test('a click on a draft card that an earlier topic of the task posted redraws that card and sends the delivery',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 later(f);f.store.data.topics.reverse();
 assert.deepEqual(f.messages.click(app,click(d,'send',undefined,'om_card_1')),toast('正在发送'));await f.flush();
 assert.equal(current(f,d).state,'delivered');assert.deepEqual(f.updates.map(u=>u.messageId),['om_card_1']);
 assert.equal(f.store.data.topics.find(x=>x.id==='t2')!.deliveryCards,undefined);
});
test('a draft that is made after the task moved to a later topic is drawn in that topic, and a click before its card id was saved finds that topic',async t=>{
 const f=fixture();t.after(f.close);await invoke(f,'attach',{pane:'pane',messageId:'message-1'});const second=later(f);f.topic.deliveryCards=undefined;f.replies.length=0;
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[]});
 assert.deepEqual(f.replies.map(r=>r.rootId),['om_root2']);assert.deepEqual(Object.keys(second.deliveryCards??{}),[d.id]);
 delete second.deliveryCards![d.id];f.messages.click(app,click(d,'edit',undefined,'om_early'));await f.flush();
 assert.equal(second.deliveryCards![d.id],'om_early');assert.equal(f.topic.deliveryCards?.[d.id],undefined);
});

// The attachments of a draft as its body has them, given the ids the outbox gave their bytes.
const metadata=(ids:string[])=>[{kind:'image',name:'截图.png',size:png.length,id:ids[0]},{kind:'file',name:'季度报告.pdf',size:pdf.length,id:ids[1]}];
const idsOf=(d:Delivery)=>(bodyOf(d).attachments??[]).map(a=>a.id);
test('a draft keeps the bytes of its images and files in the outbox and only their names and sizes in its body, and its card lists them',async t=>{
 const f=fixture();t.after(f.close);
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:linked,mentions:[],attachments:files,docAccess:'edit'});
 const ids=idsOf(d);assert.equal(ids.length,2);for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.deepEqual(d.body,{text:linked,mentions:[],attachments:metadata(ids),docAccess:'edit'});
 assert.deepEqual(f.kept(),[...ids].sort());assert.deepEqual(f.outbox.read(ids[0]),png);assert.deepEqual(f.outbox.read(ids[1]),pdf);
 assert.equal(fs.statSync(f.outbox.dir).mode&0o777,0o700);for(const id of ids)assert.equal(fs.statSync(path.join(f.outbox.dir,id)).mode&0o777,0o600);
 assert.deepEqual(f.replies[0].card,draftCard(d,'pending',{render:1,now}));assert.equal(f.calls.some(c=>c.method==='openLarkImage'||c.method==='openLarkFile'),false);
});
test('attachments and doc access that cannot go out are refused before anything is stored or drafted',async t=>{
 const f=fixture();t.after(f.close);
 const image=(name:string,bytes:Buffer)=>({kind:'image',name,data:bytes.toString('base64')}),file=(name:string,size:number)=>({kind:'file',name,data:Buffer.alloc(size,1).toString('base64')});
 const cases:[object,string][]=[
  [{attachments:'截图.png'},'附件无效'],[{attachments:[{kind:'video',name:'a.mp4',data:'AAAA'}]},'附件只能是图片（image）或文件（file）'],
  [{attachments:[{kind:'file',name:' ',data:'AAAA'}]},'附件缺少文件名'],[{attachments:[{kind:'file',name:'长'.repeat(256),data:'AAAA'}]},'文件名不能超过 255 个字'],
  [{attachments:[{kind:'file',name:'a.pdf',data:'不是 base64'}]},'a.pdf 的内容不是 base64'],[{attachments:[{kind:'file',name:'空.txt',data:''}]},'空.txt 是空的'],
  [{attachments:[image('假图.png',pdf)]},'假图.png 不是 PNG、JPEG、GIF、WebP 或 BMP 图片'],
  [{attachments:[image('大图.png',Buffer.concat([png,Buffer.alloc(7.5*1024*1024-png.length+1)]))]},'图片 大图.png 超过 7.5 MB：open-lark 发不了这么大的图片，改用 --file 发送'],
  [{attachments:[file('大文件.zip',20*1024*1024+1)]},'大文件.zip 超过每个附件 20 MB 的上限'],
  [{attachments:[file('1.bin',18*1024*1024),file('2.bin',18*1024*1024),file('3.bin',18*1024*1024)]},'附件加起来超过每份草稿 50 MB 的上限'],
  [{docAccess:'read'},'文档权限只能是 view（查看）或 edit（编辑）'],[{text:'没有链接的正文',docAccess:'view'},'正文里没有链接，没有可以开放权限的文档'],
 ];
 for(const [fields,error] of cases){
  await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:linked,mentions:[],...fields}),(e:Error)=>e.message===error,error);
  assert.equal(f.deliveries().length,0,error);assert.deepEqual(f.kept(),[],error);
 }
 assert.equal(f.replies.length,0);
});
test('after 发送 the text goes first, then each attachment in its order where the text went, then the doc access, and the bytes leave the outbox',async t=>{
 const f=fixture();t.after(f.close);const threaded:OwnerMessage={...message,inThread:true};
 f.respond(method=>method==='openLarkMessage'?threaded:method==='openLarkReply'?{...sent,threadRoot:'root-1'}:method==='openLarkImage'?{messageId:'img-1'}:method==='openLarkFile'?{messageId:null}:{docs:[doc]});
 await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 const {delivery:d}=await invoke(f,'reply',{pane:'pane',messageId:'message-1',text:linked,mentions:[],attachments:files,docAccess:'edit'}),ids=idsOf(d);
 f.calls.length=0;f.messages.click(app,click(d,'send'));await f.flush();
 assert.deepEqual(f.calls.map(c=>[c.method,c.params]),[
  ['openLarkReply',{messageId:'message-1',clientId:d.key,text:linked,mentions:[],thread:true}],
  ['openLarkImage',{chatId:'chat-1',clientId:ids[0],name:'截图.png',mimeType:'image/png',data:png.toString('base64'),replyTo:'message-1',thread:true}],
  ['openLarkFile',{chatId:'chat-1',clientId:ids[1],name:'季度报告.pdf',data:pdf.toString('base64'),replyTo:'message-1',threadRoot:'root-1'}],
  ['openLarkDocAccess',{messageId:'sent-1',role:'edit'}],
 ]);
 const after=current(f,d);assert.equal(after.state,'delivered');assert.deepEqual(after.receipt,{...sent,threadRoot:'root-1',attachments:['img-1',null],docs:[doc]});
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(after,'sent',{render:2,now,quoted:threaded}));assert.deepEqual(f.kept(),[]);
});
test('attachments of a new message go to its chat, and those of a quote reply quote the same message',async t=>{
 const f=fixture();t.after(f.close);await invoke(f,'attach',{pane:'pane',messageId:'message-1'});
 const {delivery:s}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[],attachments:files});
 const {delivery:r}=await invoke(f,'reply',{pane:'pane',messageId:'message-1',text:'回复',mentions:[],attachments:files});
 for(const d of [s,r]){f.calls.length=0;f.messages.click(app,click(d,'send'));await f.flush();
  const where=d===s?{chatId:'chat-2'}:{chatId:'chat-1',replyTo:'message-1'},ids=idsOf(d);
  assert.deepEqual(f.calls.slice(1).map(c=>[c.method,c.params]),[
   ['openLarkImage',{...where,clientId:ids[0],name:'截图.png',mimeType:'image/png',data:png.toString('base64')}],['openLarkFile',{...where,clientId:ids[1],name:'季度报告.pdf',data:pdf.toString('base64')}]]);
  assert.deepEqual(current(f,d).receipt,{...sent,attachments:['img-1','file-1']});
 }
});
test('an attachment that fails fails the delivery with what already went out; 发送 then sends only the rest, and 修改 is gone meanwhile',async t=>{
 const f=fixture();t.after(f.close);let down=true;
 f.respond(method=>{if(method==='openLarkChat')return chat;if(method==='openLarkImage')return {messageId:'img-1'};if(method==='openLarkFile'){if(down)throw Object.assign(Error('x'),{code:'channel_unreachable'});return {messageId:'file-1'};}if(method==='openLarkDocAccess')return {docs:[doc]};return sent;});
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:linked,mentions:[],attachments:files,docAccess:'view'}),ids=idsOf(d);
 f.messages.click(app,click(d,'send'));await f.flush();
 const failed=current(f,d),progress=f.outbox.progress(d.key);
 assert.equal(failed.state,'failed');assert.equal(failed.error,'正文和前 1 个附件已发出，文件 季度报告.pdf 没有发出去：open-lark 没有响应');
 assert.deepEqual(progress,{text:sent,attachments:{[ids[0]]:'img-1'}});
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(failed,'pending',{render:2,now,progress}));
 const updates=f.updates.length;assert.deepEqual(f.messages.click(app,click(d,'edit')),toast('正文已经发出，不能再修改'));await f.flush();assert.equal(f.updates.length,updates);
 assert.deepEqual(f.kept(),[...ids,d.key+'.json'].sort());
 down=false;f.calls.length=0;f.messages.click(app,click(d,'send'));await f.flush();
 assert.deepEqual(f.calls.map(c=>c.method),['openLarkFile','openLarkDocAccess']);
 assert.equal(current(f,d).state,'delivered');assert.deepEqual(current(f,d).receipt,{...sent,attachments:['img-1','file-1'],docs:[doc]});assert.deepEqual(f.kept(),[]);
});
test('不发 after a partial send says on the card what went out and removes the bytes and the progress',async t=>{
 const f=fixture();t.after(f.close);
 f.respond(method=>{if(method==='openLarkChat')return chat;if(method==='openLarkImage')throw Object.assign(Error('图片太大'),{code:'channel_refused'});return sent;});
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[],attachments:files});
 f.messages.click(app,click(d,'send'));await f.flush();assert.equal(current(f,d).error,'正文已发出，图片 截图.png 没有发出去：open-lark 拒绝了这次发送：图片太大');
 f.messages.click(app,click(d,'drop'));await f.flush();
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(current(f,d),'dropped',{render:3,now,progress:{text:sent,attachments:{}}}));assert.deepEqual(f.kept(),[]);
});
test('doc access that fails does not undo the sent message: the delivery is delivered and the card says why access was not opened',async t=>{
 const f=fixture();t.after(f.close);
 f.respond(method=>{if(method==='openLarkChat')return chat;if(method==='openLarkDocAccess')throw Object.assign(Error('MESSAGE_DOC_PERMISSION_REFUSED：无权限'),{code:'channel_refused'});return sent;});
 const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:linked,mentions:[],docAccess:'edit'});
 f.messages.click(app,click(d,'send'));await f.flush();
 const after=current(f,d);assert.equal(after.state,'delivered');assert.deepEqual(after.receipt,{...sent,docs:[],docsError:'open-lark 拒绝了这次发送：MESSAGE_DOC_PERMISSION_REFUSED：无权限'});
 assert.deepEqual(f.updates.at(-1)!.card,draftCard(after,'sent',{render:2,now}));
 const partly=[doc,{url:'https://example.feishu.cn/sheets/def',title:'表格',granted:false,reason:'只能开放查看权限'}];
 f.respond(method=>method==='openLarkChat'?chat:method==='openLarkDocAccess'?{docs:partly}:sent);
 const {delivery:e}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:linked,mentions:[],docAccess:'edit'});
 f.messages.click(app,click(e,'send'));await f.flush();assert.deepEqual(current(f,e).receipt,{...sent,docs:partly});
});
test('the bytes of a draft go once it is not sent, withdrawn, its card is refused or its task has ended, and stay while it waits or failed in an open task',async t=>{
 const f=fixture();t.after(f.close);const draft=async()=>(await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[],attachments:files})).delivery;
 const dropped=await draft();f.messages.click(app,click(dropped,'drop'));await f.flush();
 const withdrawn=await draft();await invoke(f,'withdraw',{pane:'pane',draftId:withdrawn.id});await f.flush();assert.deepEqual(f.kept(),[]);
 f.failReply(Error('invalid card'));await assert.rejects(draft(),/确认卡片没有发出去/);await f.flush();assert.deepEqual(f.kept(),[]);f.failReply(null);
 const waiting=await draft(),failing=await draft();f.respond(method=>{if(method==='openLarkChat')return chat;throw Object.assign(Error('x'),{code:'client_offline'});});
 f.messages.click(app,click(failing,'send'));await f.flush();assert.equal(current(f,failing).state,'failed');
 assert.deepEqual(f.kept(),[...idsOf(waiting),...idsOf(failing)].sort());
 f.tasks.end(f.topic.taskId!,'dropped','不用了');await f.flush();assert.deepEqual(f.kept(),[]);
 await assert.rejects(invoke(f,'send',{pane:'pane',chatId:'chat-2',text:'正文',mentions:[],attachments:files}),/这个任务已经结束/);assert.deepEqual(f.kept(),[]);
});
test('an edited text keeps the attachments and the doc access of the draft',async t=>{
 const f=fixture();t.after(f.close);const {delivery:d}=await invoke(f,'send',{pane:'pane',chatId:'chat-2',text:linked,mentions:[],attachments:files,docAccess:'view'});
 f.messages.click(app,click(d,'send','改过的 https://example.feishu.cn/docx/abc'));await f.flush();
 assert.deepEqual(current(f,d).body,{text:'改过的 https://example.feishu.cn/docx/abc',mentions:[],attachments:metadata(idsOf(d)),docAccess:'view'});assert.equal(current(f,d).state,'delivered');
});
