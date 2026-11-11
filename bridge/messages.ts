import {uuid,publicText,oneOf,isRecord} from './core.ts';
import {sourceCard,draftCard} from './outbound-cards.ts';import {fits} from './message-cards.ts';import {clip} from './request-cards.ts';
import type {Store,Call} from './core.ts';
import type {App,Machine,Topic,Source,Draft,Mention,OwnerChat} from './state.ts';
import type {Topics} from './topics.ts';
import type {Platforms} from './platform.ts';
import type {Click} from './request-cards.ts';
import type {DraftView} from './outbound-cards.ts';
import type {CardActionResponse} from '@larksuite/channel';
// bridge-message on the control plane (see message-command.ts). The agent of a topic brings a Feishu message into its topic (attach): Bridge
// reads it by its id through the owner's channel and posts a source card, so that where it came from is what Feishu says, not what the
// agent tells. It drafts messages to send as the owner: a reply that quotes a source of the topic in its chat (reply), or a message to a
// chat (send). A draft goes out through the owner's channel, open-lark on the machine that runs it (see open-lark.ts), only when someone on
// the app's allowlist clicks send on its card in the topic's thread: what goes out in the owner's name is theirs to decide, and a click
// reaches Bridge from Feishu, past the agent. The requests come through the client of the agent's machine like those of bridge-schedule,
// and the topic is that of the agent's pane (see Topics.caller). Every message sent, and every send that failed, is logged as 消息.

const ops=['attach','reply','send'] as const;
type Op=typeof ops[number];
// A request of bridge-message as the client of the agent's machine passes it on: the agent's pane and session, whatever the op; attach and
// reply name a message by its open-lark id (messageId; that of reply is a source of the topic), send a chat (chatId), and reply and send
// carry the text, with @<name> in it for each of mentions.
export type MessageRequest={pane?:string,session?:string,messageId?:string,chatId?:string,text?:string,mentions?:Mention[]};
// What each op resolves to, for bridge-message to print (see message-command.ts): the source it added, or the draft whose card it posted.
export type Answers={attach:{source:Source},reply:{draft:Draft},send:{draft:Draft}};
export type MessageOps={[K in Op]:{request:MessageRequest,answer:Answers[K]}};
// topics are those of the bindings (see topics.ts); app(id) returns an app or throws; owner() is the machine whose client reaches open-lark,
// or null when none is set or it is gone; call reaches the client of a machine (see Clients.call); reply(app,chatId,rootId,{card}) posts a
// card into the thread of a topic and resolves to its message id, and updateCard(app,messageId,card) replaces it; now() is the clock.
type Deps={topics:Pick<Topics,'caller'|'queue'>,app:(id:string)=>App,owner:()=>Machine|null,call:Call,reply:Platforms['reply'],updateCard:Platforms['updateCard'],now?:()=>number};
// A short, safe error explanation for a refusal or a card-update log. Sending itself uses only the mapped reasons below.
const brief=(e:Error|undefined)=>publicText(e?.message).split('\n')[0].slice(0,200);
const toast=(type:string,content:string)=>({toast:{type,content}});
// The deps stay in deps: reply and call are also names of ops and of the method that dispatches them.
export class Messages{
 declare store:Store;declare deps:Required<Deps>;declare renders:number;declare sending:Map<string,Promise<void>>;
 constructor(store:Store,{now=Date.now,...deps}:Deps){this.store=store;this.deps={...deps,now};this.renders=0;this.sending=new Map();}
 // Request op of the agent in pane pane of Herdr session session (default) on machine m, the machine whose client passed the request on:
 // op is one of ops, done for the agent's topic. Resolves to what the agent reads, and rejects with what to tell it.
 async call(m:Machine,op:string,request:unknown):Promise<Answers[Op]>{
  if(!oneOf(ops,op))throw Error('未知的操作：'+op);
  if(!isRecord(request))throw Error('请求内容无效');
  const t=await this.deps.topics.caller(m,request,'bridge-message'),owner=this.deps.owner();
  if(!owner)throw Error('Bridge 没有配置 open-lark 所在的机器（控制面的 BRIDGE_OPEN_LARK_MACHINE）');
  // One operation at a time in a topic also makes two simultaneous attaches of one message idempotent.
  switch(op){
   case 'attach':return this.deps.topics.queue(t,()=>this.attach(t,request as MessageRequest,owner));
   case 'reply':return this.deps.topics.queue(t,()=>this.reply(t,request as MessageRequest,owner));
   case 'send':return this.deps.topics.queue(t,()=>this.send(t,request as MessageRequest,owner));
  }
 }
 // Brings message messageId into topic t: reads it through the owner's channel, keeps it among the sources of t and posts its source card.
 async attach(t:Topic,request:MessageRequest,owner:Machine):Promise<Answers['attach']>{
  const messageId=this.id(request.messageId,'消息'),existing=(t.sources||[]).find(s=>s.messageId===messageId);if(existing)return {source:existing};
  let m;try{m=await this.deps.call(owner,'openLarkMessage',{messageId});}catch(e){throw Error(this.failure(owner,e));}
  const card=sourceCard(m,this.deps.now()),cardId=await this.deps.reply(this.deps.app(t.appId),t.chatId,t.rootId,{card});
  // The source deliberately drops text and link: the original is visible on its card, not duplicated into the state file.
  const source:Source={chatId:m.chatId,chatName:m.chatName,chatType:m.chatType,messageId:m.messageId,sender:m.sender,at:m.at,cardId};
  t.sources=[...(t.sources||[]),source];this.store.save();return {source};
 }
 // Drafts a reply to source messageId of topic t, in the chat of the source, and posts its card.
 async reply(t:Topic,request:MessageRequest,owner:Machine):Promise<Answers['reply']>{
  const messageId=this.id(request.messageId,'消息'),quoted=(t.sources||[]).find(s=>s.messageId===messageId);
  if(!quoted)throw Error('这条消息不在本话题的来源里，先用 attach 放进来');
  const {text,mentions}=this.checked(request),chat:OwnerChat={chatId:quoted.chatId,chatName:quoted.chatName,chatType:quoted.chatType};
  return {draft:await this.create(t,chat,text,mentions,quoted)};
 }
 // Drafts a message to chat chatId, which it reads through the owner's channel, and posts its card.
 async send(t:Topic,request:MessageRequest,owner:Machine):Promise<Answers['send']>{
  const chatId=this.id(request.chatId,'聊天'),{text,mentions}=this.checked(request);let chat;
  try{chat=await this.deps.call(owner,'openLarkChat',{chatId});}catch(e){throw Error(this.failure(owner,e));}
  return {draft:await this.create(t,chat,text,mentions)};
 }
 // Stores a pending draft before posting its card, so that a click can always find it. A card Feishu refuses removes the record again.
 async create(t:Topic,chat:OwnerChat,text:string,mentions:Mention[],quoted?:Source):Promise<Draft>{
  const now=this.deps.now(),d:Draft={...chat,id:uuid(),...quoted&&{replyTo:quoted.messageId},mentions,text,clientId:uuid(),state:'pending',createdAt:now};
  const card=draftCard(d,'pending',{render:++this.renders,now,quoted});
  if(!fits(card))throw Error('正文太长，确认卡片放不下，请缩短后重新提交');
  t.drafts=[...(t.drafts||[]),d];this.store.save();
  try{d.cardId=await this.deps.reply(this.deps.app(t.appId),t.chatId,t.rootId,{card});this.store.save();return d;}
  catch(e){t.drafts=(t.drafts||[]).filter(x=>x!==d);this.store.save();throw Error('确认卡片没有发出去，请稍后重试');}
 }
 // A click on a draft card from someone on the app's allowlist (see Platforms.cardAction), answered at once: send, edit, drop or cancel
 // (see draftCard in outbound-cards.ts).
 click(a:App,evt:Click):CardActionResponse{
  const v=evt.action?.value||{},t=this.store.data.topics.find(x=>x.appId===a.id&&x.drafts?.some(d=>d.id===v.draftId)),d=t?.drafts?.find(x=>x.id===v.draftId);
  if(!t||!d||!v.draft||!['send','edit','drop','cancel'].includes(v.draft))return toast('info','这张卡片已失效');
  // Feishu can deliver the click before the reply that posted the card returned its message id.
  if(!d.cardId){d.cardId=evt.messageId;this.store.save();}
  if(this.sending.has(d.id))return toast('info','正在发送，请稍候');
  if(v.draft==='send'){
   if(d.state!=='pending')return toast('info',d.state==='sent'?'这条消息已经发送':'这条消息已取消发送');
   const running=this.deliver(a,t,d,evt).finally(()=>this.sending.delete(d.id));this.sending.set(d.id,running);return toast('info','正在发送');
  }
  if(d.state!=='pending')return toast('info',d.state==='sent'?'这条消息已经发送':'这条消息已取消发送');
  if(v.draft==='drop'){d.state='dropped';this.store.save();void this.draw(a,t,d,'dropped');return toast('info','已取消发送');}
  if(v.draft==='edit'){void this.draw(a,t,d,'editing');return toast('info','请修改正文');}
  void this.draw(a,t,d,'pending');return toast('info','已取消修改');
 }
 // Sends d after a click, unless an earlier attempt already finished it. An edited form changes both the text and its idempotency key,
 // and drops only those mentions whose @name the new text no longer has. The caller holds sending until the card has been redrawn.
 async deliver(a:App,t:Topic,d:Draft,evt:Click){
  let owner:Machine|null=null;
  try{
   const edited=evt.action.formValue?.text;
   if(typeof edited==='string'&&edited!==d.text){d.text=edited;d.clientId=uuid();d.mentions=d.mentions.filter(m=>edited.includes('@'+m.name));}
   if(!d.text.trim())throw Error('正文不能为空');
   this.store.save();owner=this.deps.owner();if(!owner)throw Error('没有配置 open-lark 所在的机器');
   const params={clientId:d.clientId,text:d.text,mentions:d.mentions},sent=d.replyTo
    ?await this.deps.call(owner,'openLarkReply',{messageId:d.replyTo,...params})
    :await this.deps.call(owner,'openLarkSend',{chatId:d.chatId,...params});
   Object.assign(d,{state:'sent',sentId:sent.messageId,sentAt:sent.at});delete d.failure;this.store.save();
   this.store.log('消息',`以 ${sent.owner} 的身份发到 ${d.chatName}：${clip(d.text,40)}`);await this.draw(a,t,d,'sent');
  }catch(e){
   const reason=this.failure(owner,e);d.state='pending';d.failure=reason;this.store.save();
   this.store.log('消息',`未能发到 ${d.chatName}：${reason}`,'error');await this.draw(a,t,d,'pending');
  }
 }
 // Replaces d's card in its topic as view. A failed replacement is only logged: in particular, it never turns a successful send into a retry.
 async draw(a:App,t:Topic,d:Draft,view:DraftView){
  const quoted=d.replyTo?(t.sources||[]).find(s=>s.messageId===d.replyTo):undefined,card=draftCard(d,view,{render:++this.renders,now:this.deps.now(),quoted});
  try{await this.deps.updateCard(a,d.cardId!,card);}catch(e){this.store.log('消息',`确认卡片未能更新：${brief(e)}`,'error');}
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
 // The reason a send failed, shared by owner-channel reads and clicks. Unknown errors retain only their short public explanation.
 failure(owner:Machine|null,e:any){
  if(!owner)return '没有配置 open-lark 所在的机器';
  if(e?.code==='client_offline')return `${owner.name} 的 Bridge 客户端不在线`;
  if(e?.code==='channel_unconfigured')return `${owner.name} 的 Bridge 客户端没有配置 open-lark`;
  if(e?.code==='channel_unreachable'||e?.timedOut)return 'open-lark 没有响应';
  if(e?.code==='channel_refused')return 'open-lark 拒绝了这次发送：'+brief(e);
  return brief(e)||'未知错误';
 }
}
