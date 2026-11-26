import {publicText,oneOf,isRecord} from './core.ts';
import {sourceCard,draftCard} from './outbound-cards.ts';import {topicOfTask} from './task-topic.ts';import {fits,notice} from './message-cards.ts';import {clip} from './request-cards.ts';
import type {Store,Call} from './core.ts';
import type {App,Machine,Topic,Mention} from './state.ts';
import type {Topics} from './topics.ts';
import type {Platforms} from './platform.ts';
import type {Click} from './request-cards.ts';
import type {Address,Body,DraftView} from './outbound-cards.ts';
import type {OwnerMessage,Sent} from './link.ts';
import type {Tasks} from './task-core.ts';
import type {Delivery,Input,JournalRecord,Sink} from './task-types.ts';
import type {CardActionResponse} from '@larksuite/channel';
// bridge-message on the control plane (see message-command.ts), built on the task core (see task-core.ts). The topic of the agent is a task (see Topics.task): a message that the agent brings in (attach) is an input of it, read by its id through the owner's
// channel so that where it came from is what Feishu says, not what the agent tells; a message that it drafts to send as the owner, a reply that
// quotes an input in its chat (reply) or a message to a chat (send), is an output delivered to the sink as-owner, whose policy asks for approval.
// The sink sends through the owner's channel, open-lark on the machine that runs it (see open-lark.ts), once someone on the app's allowlist clicks
// send on the draft's card in the topic's thread: what goes out in the owner's name is theirs to decide, and a click reaches Bridge from Feishu,
// past the agent. The thread shows all this as an observer of the task's journal (thread-cards): the source cards and the draft cards are drawn
// from the records, and clicks turn into decisions of the core. The requests come through the client of the agent's machine like those of
// bridge-schedule, and the topic is that of the agent's pane (see Topics.caller). Every message sent, and every send that failed, is logged as 消息.
// The agent can take back (withdraw) a draft of its topic that still waits for the owner, which ends it as the owner's 不发 does.

const ops=['attach','reply','send','withdraw'] as const;
type Op=typeof ops[number];
// The sink of the owner's messages, as the task core names it, and the prefix of the ref of an input that is a message of open-lark.
export const sinkName='as-owner';
const refPrefix='open-lark:';
// A request of bridge-message as the client of the agent's machine passes it on: the agent's pane and session, whatever the op; attach and
// reply name a message by its open-lark id (messageId; that of reply is an input of the topic's task), send a chat (chatId), and reply and send
// carry the text, with @<name> in it for each of mentions. withdraw names a draft by its delivery's id or a unique start of it (draftId).
export type MessageRequest={pane?:string,session?:string,messageId?:string,chatId?:string,text?:string,mentions?:Mention[],draftId?:string};
// What each op resolves to, for bridge-message to print (see message-command.ts): the input it added, whose body is the message as read, or the
// delivery whose card it posted or that it withdrew.
export type Answers={attach:{input:Input&{body:OwnerMessage}},reply:{delivery:Delivery},send:{delivery:Delivery},withdraw:{delivery:Delivery}};
export type MessageOps={[K in Op]:{request:MessageRequest,answer:Answers[K]}};
// tasks is the task core, whose only sink is that of ownerSink; topics are those of the bindings (see topics.ts); app(id) returns an app or
// throws; owner() is the machine whose client reaches open-lark, or null when none is set or it is gone; call reaches the client of a machine
// (see Clients.call); reply(app,chatId,rootId,{card}) posts a card into the thread of a topic and resolves to its message id, and
// updateCard(app,messageId,card) replaces it; now() is the clock.
type Deps={tasks:Tasks,topics:Pick<Topics,'caller'|'queue'|'task'>,app:(id:string)=>App,owner:()=>Machine|null,call:Call,reply:Platforms['reply'],updateCard:Platforms['updateCard'],now?:()=>number};
// A short, safe error explanation for an unexpected failure or a card-update log. An open-lark refusal keeps its full public explanation below.
const brief=(e:Error|undefined)=>publicText(e?.message).split('\n')[0].slice(0,200);
const toast=(type:string,content:string)=>({toast:{type,content}});
// The reason a send or a read failed, shared by owner-channel calls and the sink. Unknown errors retain only their short public explanation.
function failure(owner:Machine|null,e:any){
 if(!owner)return '没有配置 open-lark 所在的机器';
 if(e?.code==='client_offline')return `${owner.name} 的 Bridge 客户端不在线`;
 if(e?.code==='channel_unconfigured')return `${owner.name} 的 Bridge 客户端没有配置 open-lark`;
 if(e?.code==='channel_unreachable'||e?.timedOut)return 'open-lark 没有响应';
 if(e?.code==='channel_refused')return 'open-lark 拒绝了这次发送：'+publicText(e?.message);
 return brief(e)||'未知错误';
}
// The sink as-owner of the task core: sends a body to an address as the owner through open-lark, as a reply when the address has replyTo, else
// to its chat. The delivery's key is open-lark's client id, which sends the message of a client id at most once. It resolves to the receipt
// (messageId, at, owner) and rejects with the explanation of failure.
export function ownerSink({owner,call}:Pick<Deps,'owner'|'call'>):Sink{
 return {async send(to,body,key){
  const m=owner(),{text,mentions}=body as Body,address=to as Address;
  if(!m)throw Error(failure(null,null));
  try{
   const params={clientId:key,text,mentions};
   return await (address.replyTo?call(m,'openLarkReply',{messageId:address.replyTo,...params}):call(m,'openLarkSend',{chatId:address.chatId,...params})) as Sent;
  }catch(e){throw Error(failure(m,e));}
 }};
}
// The deps stay in deps: reply and call are also names of ops and of the method that dispatches them.
// editing holds the deliveries whose card shows the form of 修改, which withdraw leaves alone. It is not saved: after a restart a withdraw can
// replace an open form, whose submission then finds the draft not sent.
export class Messages{
 declare store:Store;declare deps:Required<Deps>;declare renders:number;declare refused:Map<string,string>;declare editing:Set<string>;
 // Starts the observer thread-cards, which shows the tasks of topics in their threads.
 constructor(store:Store,{now=Date.now,...deps}:Deps){
  this.store=store;this.deps={...deps,now};this.renders=0;this.refused=new Map();this.editing=new Set();
  deps.tasks.observe('thread-cards',r=>this.view(r));
 }
 // Request op of the agent in pane pane of Herdr session session (default) on machine m, the machine whose client passed the request on:
 // op is one of ops, done for the agent's topic. Resolves to what the agent reads, and rejects with what to tell it.
 async call(m:Machine,op:string,request:unknown):Promise<Answers[Op]>{
  if(!oneOf(ops,op))throw Error('未知的操作：'+op);
  if(!isRecord(request))throw Error('请求内容无效');
  const t=await this.deps.topics.caller(m,request,'bridge-message'),owner=this.deps.owner();
  if(!owner)throw Error('Bridge 没有配置 open-lark 所在的机器（控制面的 BRIDGE_OPEN_LARK_MACHINE）');
  // One operation at a time in a topic also keeps its task from being made twice.
  switch(op){
   case 'attach':return this.deps.topics.queue(t,()=>this.attach(t,request as MessageRequest,owner));
   case 'reply':return this.deps.topics.queue(t,()=>this.reply(t,request as MessageRequest));
   case 'send':return this.deps.topics.queue(t,()=>this.send(t,request as MessageRequest,owner));
   case 'withdraw':return this.deps.topics.queue(t,()=>this.withdraw(t,request as MessageRequest));
  }
 }
 // Brings message messageId into the task of topic t: reads it through the owner's channel and adds it as an input, whose ref is its id. The
 // core returns the same input for a message that is already one; its source card is drawn from the journal.
 async attach(t:Topic,request:MessageRequest,owner:Machine):Promise<Answers['attach']>{
  const task=this.deps.topics.task(t),messageId=this.id(request.messageId,'消息');
  let m:OwnerMessage;try{m=await this.deps.call(owner,'openLarkMessage',{messageId});}catch(e){throw Error(failure(owner,e));}
  const input=this.deps.tasks.addInput(task,m,refPrefix+messageId) as Answers['attach']['input'];
  await this.deps.tasks.settled();return {input};
 }
 // Drafts a reply to input messageId of the task of topic t, in the chat of that message.
 async reply(t:Topic,request:MessageRequest):Promise<Answers['reply']>{
  const task=this.deps.topics.task(t),messageId=this.id(request.messageId,'消息'),quoted=this.quoted(task,messageId);
  if(!quoted)throw Error('这条消息不在本话题的来源里，先用 attach 放进来');
  const {text,mentions}=this.checked(request),{chatId,chatName,chatType}=quoted;
  return {delivery:await this.draft(task,{chatId,chatName,chatType,replyTo:messageId},{text,mentions},quoted)};
 }
 // Drafts a message to chat chatId, which it reads through the owner's channel.
 async send(t:Topic,request:MessageRequest,owner:Machine):Promise<Answers['send']>{
  const task=this.deps.topics.task(t),chatId=this.id(request.chatId,'聊天'),{text,mentions}=this.checked(request);let chat;
  try{chat=await this.deps.call(owner,'openLarkChat',{chatId});}catch(e){throw Error(failure(owner,e));}
  return {delivery:await this.draft(task,chat,{text,mentions})};
 }
 // Takes back draft draftId of the task of topic t while it waits for the owner and the owner is not changing its text. Its card is redrawn
 // from the journal, which records the decision as withdrawn. A draft that was sent, is being sent, failed after the owner's 发送, or was not
 // sent is refused with what the agent can do instead.
 async withdraw(t:Topic,request:MessageRequest):Promise<Answers['withdraw']>{
  const task=this.deps.topics.task(t),id=this.id(request.draftId,'草稿');
  const found=this.deps.tasks.get(task).deliveries.filter(d=>'sink' in d.target&&d.target.sink===sinkName&&d.id.startsWith(id));
  if(found.length>1)throw Error(`有多个草稿的 ID 以 ${id} 开头，请写完整的 ID`);
  const d=found[0];if(!d)throw Error(`本话题没有 ID 以 ${id} 开头的草稿：只能撤回这个话题里起草的草稿，ID 见 reply 或 send 的输出`);
  if(d.state==='sending')throw Error('这份草稿正在发送，不能撤回');
  if(d.state==='delivered')throw Error('这份草稿已经发出，不能撤回');
  if(d.state==='failed')throw Error('主人点过「发送」但没有发出去，不能撤回：由主人在卡片上重试或者点「不发」');
  if(d.state==='rejected')throw Error('这份草稿已经不发了，不用撤回');
  if(this.editing.has(d.id))throw Error('主人正在修改这份草稿，不能撤回：等主人改完发送或者取消修改');
  const delivery=this.deps.tasks.withdraw(d.id);await this.deps.tasks.settled();return {delivery};
 }
 // The message that input messageId of task is, if it is one.
 quoted(task:string,messageId:string):OwnerMessage|undefined{return this.deps.tasks.get(task).inputs.find(i=>i.ref===refPrefix+messageId)?.body as OwnerMessage|undefined;}
 // Adds body as an output of task and delivers it to as-owner at address, whose policy leaves it awaiting; its card is drawn from the journal. A
 // card that would not fit is refused before anything is recorded. A card that Feishu refuses rejects the delivery again (see view).
 async draft(task:string,address:Address,body:Body,quoted?:OwnerMessage):Promise<Delivery>{
  const now=this.deps.now(),target={sink:sinkName,to:address};
  // The ids that the card shows are UUIDs, so a probe of that length measures the real card.
  const probe:Delivery={id:'0'.repeat(36),task,output:'',target,body,key:'',state:'awaiting',receipt:null,error:null,createdAt:now};
  if(!fits(draftCard(probe,'pending',{render:this.renders+1,now,quoted})))throw Error('正文太长，确认卡片放不下，请缩短后重新提交');
  const {tasks}=this.deps;let delivery;
  try{delivery=await tasks.deliver(tasks.addOutput(task,body).id,target);}
  catch(e){throw e?.code==='ended'?Error('这个任务已经结束，不能再起草消息：主人在话题里再写一条消息后任务会重新打开'):e;}
  await tasks.settled();
  const reason=this.refused.get(delivery.id);
  if(reason!==undefined){this.refused.delete(delivery.id);throw Error(`确认卡片没有发出去：${reason}，请稍后重试`);}
  return tasks.get(task).deliveries.find(d=>d.id===delivery.id)!;
 }
 // The observer thread-cards: draws one record of a task of a topic in the topic's thread. A record that cannot be drawn is logged and skipped,
 // never thrown, so that one broken card does not stop the view of every later record.
 async view(r:JournalRecord):Promise<void>{
  try{await this.show(r);}catch(e){this.store.log('消息',`话题里的卡片未能画出：${brief(e)}`,'error');}
 }
 // What a record changes in the thread: a task that ended or reopened gets a notice with the reason; an input that is a message gets its source card; an awaiting delivery gets its draft card, or a
 // redrawn one when a retry made it await again; delivered, failed and rejected deliveries redraw it as sent, pending with the reason, and dropped.
 async show(r:JournalRecord):Promise<void>{
  const latest=topicOfTask(this.store.data.topics,r.task);if(!latest)return;
  const ended=r.type==='task.ended'?(r.data.outcome==='achieved'?'任务已完成：':'任务已放弃：')+String(r.data.reason):r.type==='task.reopened'?'任务已重新打开':'';
  if(ended)return void await this.deps.reply(this.deps.app(latest.appId),latest.chatId,latest.rootId,{card:notice(ended)});
  if(r.type==='input.added'){
   const input=this.deps.tasks.get(r.task).inputs.find(i=>i.id===r.data.input);
   if(typeof input?.ref==='string'&&input.ref.startsWith(refPrefix))await this.deps.reply(this.deps.app(latest.appId),latest.chatId,latest.rootId,{card:sourceCard(input.body as OwnerMessage,this.deps.now())});
   return;
  }
  const d=this.deps.tasks.get(r.task).deliveries.find(x=>x.id===r.data.delivery);if(!d||!('sink' in d.target)||d.target.sink!==sinkName)return;
  // A card that an earlier topic of the task posted stays in its own thread, which is where it is redrawn; a new one goes to the latest topic.
  const t=this.store.data.topics.find(x=>x.taskId===r.task&&x.deliveryCards?.[d.id])??latest;
  const to=d.target.to as Address,{text}=d.body as Body;
  if(r.type==='delivery.delivered'||r.type==='delivery.rejected')this.editing.delete(d.id);
  if(r.type==='delivery.awaiting'){
   if(t.deliveryCards?.[d.id])return this.draw(t,d,'pending');
   const quoted=this.quoted(r.task,to.replyTo??'');
   try{
    const cardId=await this.deps.reply(this.deps.app(t.appId),t.chatId,t.rootId,{card:draftCard(d,'pending',{render:++this.renders,now:this.deps.now(),quoted})});
    (t.deliveryCards??={})[d.id]=cardId;this.store.save();
   }catch(e){
    this.store.log('消息',`确认卡片没有发出去：${brief(e)}`,'error');this.refused.set(d.id,brief(e));
    await this.deps.tasks.decide(d.id,false,undefined,'card refused');
   }
  }else if(r.type==='delivery.delivered'){
   this.store.log('消息',`以 ${(d.receipt as Sent).owner} 的身份发到 ${to.chatName}：${clip(text,40)}`);await this.draw(t,d,'sent');
  }else if(r.type==='delivery.failed'){
   this.store.log('消息',`未能发到 ${to.chatName}：${d.error}`,'error');await this.draw(t,d,'pending');
  }else if(r.type==='delivery.rejected')await this.draw(t,d,r.data.decision==='withdrawn'?'withdrawn':'dropped');
 }
 // Replaces the card of delivery d in the thread of t as view, with failure above its text when given. A delivery that has no card yet is not
 // drawn. A failed replacement is only logged: in particular, it never turns a successful send into a retry.
 async draw(t:Topic,d:Delivery,view:DraftView,failure?:string):Promise<void>{
  const cardId=t.deliveryCards?.[d.id];if(!cardId)return;
  const quoted=this.quoted(d.task,(d.target as {to:Address}).to.replyTo??''),card=draftCard(d,view,{render:++this.renders,now:this.deps.now(),quoted,...failure&&{failure}});
  try{await this.deps.updateCard(this.deps.app(t.appId),cardId,card);}catch(e){this.store.log('消息',`确认卡片未能更新：${brief(e)}`,'error');}
 }
 // The topic and the delivery of delivery id, for an app, for a click on the card with message id messageId. Of the topics that hold the task of
 // the delivery, the topic is the one whose thread has the card, so that a card of an earlier thread is still redrawn there, else (the click came
 // before the reply that posted it returned) the topic of the task (see topicOfTask). A click on a card of before the task core, or of another app, finds none.
 find(a:App,id:string,messageId:string):{topic:Topic,delivery:Delivery}|undefined{
  const held=this.store.data.topics.filter(x=>x.appId===a.id&&x.taskId&&this.deps.tasks.get(x.taskId).deliveries.some(d=>d.id===id));
  const topic=held.find(x=>x.deliveryCards?.[id]===messageId)??(held[0]&&topicOfTask(held,held[0].taskId!));if(!topic)return;
  return {topic,delivery:this.deps.tasks.get(topic.taskId!).deliveries.find(d=>d.id===id)!};
 }
 // A click on a draft card from someone on the app's allowlist (see Platforms.cardAction), answered at once: send, edit, drop or cancel
 // (see draftCard in outbound-cards.ts). The delivery's own state, which the core changes synchronously, guards against a second click.
 click(a:App,evt:Click):CardActionResponse{
  const v=evt.action?.value||{},found=typeof v.deliveryId==='string'?this.find(a,v.deliveryId,evt.messageId):undefined;
  if(!found||!v.draft||!['send','edit','drop','cancel'].includes(v.draft))return toast('info','这张卡片已失效');
  const {topic,delivery:d}=found;
  // Feishu can deliver the click before the reply that posted the card returned its message id.
  if(!topic.deliveryCards?.[d.id]){(topic.deliveryCards??={})[d.id]=evt.messageId;this.store.save();}
  if(d.state==='sending')return toast('info','正在发送，请稍候');
  if(d.state==='delivered')return toast('info','这条消息已经发送');
  if(d.state==='rejected')return toast('info','这条消息已取消发送');
  if(v.draft==='edit'){this.editing.add(d.id);void this.draw(topic,d,'editing');return toast('info','请修改正文');}
  this.editing.delete(d.id);
  if(v.draft==='cancel'){void this.draw(topic,d,'pending');return toast('info','已取消修改');}
  void this.settle(topic,d,v.draft==='send',evt.action.formValue?.text);return toast('info',v.draft==='send'?'正在发送':'已取消发送');
 }
 // Decides delivery d after a click: send approves it, with an edited text as its new body (the core gives that a new key), dropping only those
 // mentions whose @name the new text no longer has; drop rejects it. A failed delivery is retried first, since the click is the approval.
 async settle(t:Topic,d:Delivery,approve:boolean,edited?:unknown):Promise<void>{
  const {tasks}=this.deps,current=d.body as Body;let body:Body|undefined;
  try{
   if(approve){
    if(typeof edited==='string'&&edited!==current.text)body={text:edited,mentions:current.mentions.filter(m=>edited.includes('@'+m.name))};
    if(!(body??current).text.trim())throw Error('正文不能为空');
   }
   if(d.state==='failed')await tasks.retry(d.id);
   await tasks.decide(d.id,approve,body);
  }catch(e){
   this.store.log('消息',`未能发到 ${(d.target as {to:Address}).to.chatName}：${brief(e)||'未知错误'}`,'error');
   if(approve)await this.draw(t,d,'pending',brief(e)||'未知错误');
  }
 }
 // The text and mentions of a new draft. Whitespace-only text is empty, and every mention must be visible as @<name> in the text.
 checked(request:MessageRequest){
  if(typeof request.text!=='string'||!request.text.trim())throw Error('正文不能为空');
  const given=request.mentions??[];
  if(!Array.isArray(given)||given.some(m=>!m||typeof m.id!=='string'||!m.id.trim()||typeof m.name!=='string'||!m.name.trim()))throw Error('提及的人无效，每项都要是 {id,name}');
  const mentions=given.map(m=>({id:m.id,name:m.name}));for(const m of mentions)if(!request.text!.includes('@'+m.name))throw Error(`正文里没有 @${m.name}`);
  return {text:request.text,mentions};
 }
 // A nonempty external id, without the whitespace a shell argument can accidentally retain.
 id(value:unknown,label:string){if(typeof value!=='string'||!value.trim())throw Error(`缺少${label} ID`);return value.trim();}
}
