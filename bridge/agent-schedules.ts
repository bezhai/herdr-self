import {uuid,publicText,oneOf,isRecord} from './core.ts';
import {parseCron,upcoming,when,phrase} from './cron.ts';
import {isMode,short} from './schedules.ts';
import {pendingCard,settledCard} from './schedule-cards.ts';
import {fits} from './message-cards.ts';
import type {Store} from './core.ts';
import type {App,Machine,Topic,Proposal,Submission,Schedule,Run} from './state.ts';
import type {Topics} from './topics.ts';
import type {Schedules,Listed} from './schedules.ts';
import type {Platforms} from './platform.ts';
import type {Click} from './request-cards.ts';
import type {View,Outcome} from './schedule-cards.ts';
// Schedules as the agent of a topic manages them with bridge-schedule (see schedule-command.ts). The agent is known by its machine, the one
// whose client passed its request on (see Clients), and its pane, which resolve to a ready topic whose agent is still linked (see
// Topics.alive), and it reaches only the schedules of that topic's binding. Listing, the runs, pausing, resuming and removing act at once:
// they can only make schedules run less. Adding one or changing its time or task posts a card into the topic's thread, and takes effect
// only when a person on the app's allowlist clicks 确认 on it (see Platforms): the agent may have misread the time, or have been talked
// into it by what it read, and a click reaches Bridge from Feishu, past the agent. The token of the client proves the machine, but no
// secret proves the pane: an agent that claims another pane of its machine reaches that topic's schedules, which it can then read, pause
// or remove, and its cards go to that topic, where they still need the click.
// How long a card waits for its click: enough to read it and to come back from a short interruption, short enough that the runs it lists
// still lie ahead, that a card left alone soon stops blocking the next submission of its topic, and that a card the agent was talked into
// does not stay clickable for long.
const wait=30*60000;
// The runs a card lists.
const shown=5;
const toast=(type:string,content:string)=>({toast:{type,content}});
const brief=(e:Error|undefined)=>publicText(e?.message).split('\n')[0].slice(0,200);
// What bridge-schedule sends through the client of its machine (see call and schedule-command.ts): the options that it was given and the id,
// with the agent's pane and session, whatever the operation; and the answer of each operation. A schedule is listed as entry shows it, and
// a proposal as propose returns it.
export type ScheduleRequest={id?:string,mode?:string,cron?:string,timeZone?:string,task?:string,pane?:string,session?:string};
type Entry=Listed&{phrase:string,here?:boolean,topicTitle?:string|null};
type Proposed={id:string,kind:Proposal['kind'],scheduleId?:string,expiresAt:number,timeZone:string,phrase:string,next:number[]};
type Answers={add:{proposal:Proposed},list:{binding:{id:string,name:string},topicId:string,schedules:Entry[]},runs:{schedule:Entry,runs:Run[]},
 update:{proposal:Proposed},pause:{schedule:Entry},resume:{schedule:Entry},remove:{schedule:Entry}};
export type ScheduleOps={[K in keyof Answers]:{request:ScheduleRequest,answer:Answers[K]}};
// A request as it arrives, every field still to be checked.
type Received={[K in keyof ScheduleRequest]?:unknown};
const ops:(keyof Answers)[]=['add','list','runs','update','pause','resume','remove'];
const notTopic='这个 pane 里的 Agent 不属于任何进行中的飞书话题：bridge-schedule 只能由飞书话题里的 Agent 运行';
type Deps={topics:Pick<Topics,'queue'|'alive'>,schedules:Schedules,app:(id:string)=>App,reply:Platforms['reply'],updateCard:Platforms['updateCard'],now?:()=>number,every?:number};
export class AgentSchedules{
 declare store:Store;declare topics:Deps['topics'];declare schedules:Schedules;declare app:Deps['app'];declare reply:Deps['reply'];declare updateCard:Deps['updateCard'];
 declare now:()=>number;declare every:number;declare timer:NodeJS.Timeout|null;declare drawing:Map<string,Promise<void>>;
 // topics and schedules are those of the bindings (see topics.ts and schedules.ts); app(id) returns an app or throws; reply(app,chatId,
 // rootId,{card}) posts a card into the thread of a topic and resolves to its message id, and updateCard(app,messageId,card) replaces it.
 // now() is the clock, and every the milliseconds between two checks for cards that expired.
 constructor(store:Store,{topics,schedules,app,reply,updateCard,now=Date.now,every=30000}:Deps){
  this.store=store;this.topics=topics;this.schedules=schedules;this.app=app;this.reply=reply;this.updateCard=updateCard;this.now=now;this.every=every;this.timer=null;
  // In memory: the cards being drawn once settled, by proposal id → the promise of the update.
  this.drawing=new Map();
 }
 start(){this.timer??=setInterval(()=>this.expire(),this.every);}
 stop(){clearInterval(this.timer??undefined);this.timer=null;}
 // Request op of the agent in pane pane of Herdr session session (default) on machine m, the machine whose client passed the request on:
 // any machine the request names does not count. op is one of ops: id names a schedule for runs, update, pause, resume and remove; add
 // takes mode, cron, timeZone and task, update any of the last three. Resolves to what the agent reads, and rejects with what to tell it.
 async call(m:Machine,op:string,request:unknown):Promise<Answers[keyof Answers]>{
  if(!oneOf(ops,op))throw Error('未知的操作：'+op);
  if(!isRecord(request))throw Error('请求内容无效');
  return this[op](await this.caller(m,request),request);
 }
 // The ready topic of the agent in pane pane of Herdr session session on machine m, whose agent is still linked: read in the topic's queue,
 // where a topic whose agent is gone ends (see Topics.alive). Pane ids repeat across machines and sessions, and Bridge reaches one session
 // of a machine.
 async caller(m:Machine,{pane,session}:Received){
  if(typeof pane!=='string'||!pane)throw Error('缺少 pane：bridge-schedule 要由 Herdr pane 里的 Agent 运行（HERDR_PANE_ID）');
  if(!m.enabled)throw Error(`Bridge 已断开机器 ${m.name} 的桥接`);
  if((session||'default')!==m.session)throw Error(`这个 Agent 在 Herdr session ${session||'default'} 里，Bridge 连接的是这台机器的 session ${m.session}`);
  const t=this.store.data.topics.find(x=>x.machineId===m.id&&x.paneId===pane&&x.state==='ready');
  if(!t||!await this.topics.queue(t,()=>this.topics.alive(this.app(t.appId),t)))throw Error(notTopic);
  return t;
 }
 // A ready topic belongs to a binding (see Topics.unbind).
 list(t:Topic):Answers['list']{const b=this.binding(t)!;return {binding:{id:b.id,name:b.name},topicId:t.id,schedules:this.schedules.list(b.id).map(s=>this.entry(t,s))};}
 runs(t:Topic,{id}:Received):Answers['runs']{const s=this.own(t,id);return {schedule:this.listed(t,s.id),runs:this.schedules.runs(s.id)};}
 pause(t:Topic,{id}:Received):Answers['pause']{const s=this.own(t,id);this.schedules.pause(s.id);return {schedule:this.listed(t,s.id)};}
 resume(t:Topic,{id}:Received):Answers['resume']{const s=this.own(t,id);this.schedules.resume(s.id);return {schedule:this.listed(t,s.id)};}
 remove(t:Topic,{id}:Received):Answers['remove']{const s=this.own(t,id),schedule=this.listed(t,s.id);this.schedules.remove(s.id);return {schedule};}
 add(t:Topic,{mode,cron,timeZone,task}:Received):Promise<Answers['add']>{
  if(!isMode(mode))throw Error('模式无效，应为 new（每次开新话题）或 into（发进这个话题）');
  return this.propose(t,{kind:'add',fields:{mode,...mode==='into'&&{topicId:t.id},...this.schedules.check({cron,timeZone,task})}});
 }
 // The mode stays, and so does the topic of mode into.
 update(t:Topic,{id,cron,timeZone,task}:Received):Promise<Answers['update']>{
  const s=this.own(t,id);if(cron==null&&timeZone==null&&task==null)throw Error('没有要修改的内容：请给出新的 cron、时区或任务文字');
  const fields={mode:s.mode,...s.mode==='into'&&{topicId:s.topicId},...this.schedules.check({cron:cron??s.cron,timeZone:timeZone??s.timeZone,task:task??s.task})};
  return this.propose(t,{kind:'update',scheduleId:s.id,before:{cron:s.cron,timeZone:s.timeZone,task:s.task},fields});
 }
 // The schedule of the binding of topic t whose id is id or starts with it, such as the 8 characters that cards show.
 own(t:Topic,id:unknown){
  if(typeof id!=='string'||!id.trim())throw Error('缺少定时任务 ID');
  const found=this.store.data.schedules.filter(s=>s.bindingId===t.bindingId&&s.id.startsWith(id.trim()));
  if(found.length>1)throw Error(`有多个定时任务的 ID 以 ${id.trim()} 开头，请写完整的 ID`);
  if(!found.length)throw Error('定时任务不存在');
  return found[0];
 }
 // Schedule s as listed (see Schedules.list) with its time in words, and for mode into whether it goes into topic t and the title of its topic.
 entry(t:Topic,s:Listed):Entry{return {...s,phrase:phrase(parseCron(s.cron)),...s.mode==='into'&&{here:s.topicId===t.id,topicTitle:this.topic(s.topicId)?.title??null}};}
 // A schedule found by own is listed.
 listed(t:Topic,id:string){return this.entry(t,this.schedules.list(t.bindingId).find(s=>s.id===id)!);}
 // Posts the card that asks to confirm proposal p ({kind, scheduleId?, before?, fields}) into the thread of topic t, which holds one such
 // card at a time: while one waits another is refused, and one that expired is settled as such first. The record is on the topic before
 // the card is posted, so that a request meanwhile is refused, and it goes again when the card cannot be posted. Resolves to the proposal
 // as the agent reads it.
 async propose(t:Topic,p:Submission):Promise<{proposal:Proposed}>{
  const now=this.now(),waiting=t.proposal;
  if(waiting&&waiting.expiresAt>now)throw Error(`这个话题已有一张等待确认的定时任务卡片，到 ${when(waiting.expiresAt,waiting.fields.timeZone,{weekday:true})} 过期。请主人先在卡片上点确认或取消，再重新提交`);
  if(waiting)this.close(t,waiting,{result:'expired'});
  const proposal:Proposal={id:uuid(),...p,messageId:'',expiresAt:now+wait},{timeZone}=p.fields,v=this.view(t,proposal,now);
  const card=pendingCard(v.card,proposal.id,when(proposal.expiresAt,timeZone,{weekday:true}));
  if(!fits(card))throw Error('任务文字太长，确认卡片放不下，请缩短后重新提交');
  t.proposal=proposal;this.store.save();
  try{proposal.messageId=await this.reply(this.app(t.appId),t.chatId,t.rootId,{card});this.store.save();}
  catch(e){
   if(t.proposal===proposal){delete t.proposal;this.store.save();}
   this.log(t,`确认卡片未发出，${brief(e)}`,'error');throw Error('确认卡片没有发出去，请稍后重试');
  }
  this.log(t,p.kind==='add'?'已发出定时任务的确认卡片':`已发出修改定时任务 ${short({id:p.scheduleId})} 的确认卡片`);
  // view has the next runs, from now on.
  return {proposal:{id:proposal.id,kind:p.kind,...p.scheduleId&&{scheduleId:p.scheduleId},expiresAt:proposal.expiresAt,timeZone,phrase:v.card.phrase,next:v.next!}};
 }
 // A click on 确认 or 取消 of a card by someone on the app's allowlist (see Platforms), answered at once with a toast; the card shows the
 // outcome afterwards. 确认 adds or changes the schedule as the card shows it, unless the card has expired or what it needs is gone.
 click(a:App,evt:Click){
  const v=evt.action?.value||{},t=this.store.data.topics.find(x=>x.appId===a.id&&x.proposal?.id===v.proposal),p=t?.proposal,openId=evt.operator?.openId;
  if(!p||!['confirm','cancel'].includes(v.schedule))return toast('info','这张卡片已失效');
  // A click can come before the post of the card has resolved to its id.
  p.messageId||=evt.messageId;
  if(p.expiresAt<=this.now()){this.close(t,p,{result:'expired'});return toast('info','这张卡片已过期，定时任务没有生效');}
  if(v.schedule==='cancel'){this.close(t,p,{result:'cancelled',openId});return toast('info','已取消');}
  let s:Schedule;try{s=this.apply(t,p,openId);}
  catch(e){const reason=brief(e);this.close(t,p,{result:'failed',reason});return toast('error','没有生效：'+reason);}
  this.close(t,p,{result:'confirmed',openId},s);
  return toast('success',p.kind==='add'?'定时任务已生效':'定时任务已修改');
 }
 // Adds the schedule of proposal p of topic t for the person openId, or changes it, and returns its copy; throws when it cannot: its
 // binding is gone, the schedule it changes is gone, a mode into schedule's topic has ended, or its time no longer runs.
 apply(t:Topic,p:Proposal,openId:string){
  if(p.kind==='add'){
   if(p.fields.mode==='into'&&t.state!=='ready')throw Error('该话题当前没有运行中的 Agent 会话，不能添加发进这个话题的定时任务');
   return this.schedules.add({bindingId:t.bindingId,...p.fields,createdBy:{topicId:t.id,openId}});
  }
  const s=this.store.data.schedules.find(x=>x.id===p.scheduleId);if(s?.bindingId!==t.bindingId)throw Error('定时任务不存在');
  return this.schedules.update(s.id,p.fields);
 }
 // Draws the cards of the proposals that expired without a click as expired. Never rejects; resolves once they are drawn.
 expire(){
  const now=this.now();
  return Promise.all(this.store.data.topics.filter((t):t is Topic&{proposal:Proposal}=>!!t.proposal&&t.proposal.expiresAt<=now).map(t=>this.close(t,t.proposal,{result:'expired'})));
 }
 // Drops proposal p of topic t and draws its card as outcome (see settledCard), a confirmed one with schedule s and its next runs. At most
 // once, like the other cards: the record goes before Feishu is called, and a failed update is only logged. Resolves once drawn; never rejects.
 close(t:Topic,p:Proposal,outcome:Outcome,s?:Schedule){
  if(t.proposal===p){delete t.proposal;this.store.save();}
  if(outcome.result==='cancelled'||outcome.result==='expired')this.log(t,`定时任务的确认卡片${outcome.result==='cancelled'?'已取消':'已过期'}`);
  const done=(async()=>{
   try{const v=this.view(t,p,s?.handledUntil);if(s)v.card.scheduleId=short(s);await this.updateCard(this.app(t.appId),p.messageId,settledCard(v.card,outcome));}
   catch(e){this.log(t,`确认卡片未能更新，${brief(e)}`,'error');}
  })().finally(()=>this.drawing.delete(p.id));
  this.drawing.set(p.id,done);return done;
 }
 // What the cards of proposal p of topic t show (see schedule-cards.ts) as card, with the runs after from, when given, as next: their
 // instants, and as wall times in the card.
 view(t:Topic,p:Proposal,from?:number):{next:number[]|undefined,card:View}{
  const f=p.fields,b=this.binding(t),changed=p.before&&(p.before.cron!==f.cron||p.before.timeZone!==f.timeZone);
  const next=from==null?undefined:upcoming(parseCron(f.cron),f.timeZone,from,shown);
  return {next,card:{kind:p.kind,...p.scheduleId&&{scheduleId:short({id:p.scheduleId})},phrase:phrase(parseCron(f.cron)),cron:f.cron,timeZone:f.timeZone,
   ...next&&{next:next.map(x=>when(x,f.timeZone,{weekday:true}))},task:f.task,taskChanged:!!p.before&&p.before.task!==f.task,mode:f.mode,here:f.topicId===t.id,topicTitle:this.topic(f.topicId)?.title,
   binding:b?.name??'已删除的绑定',
   // Only a change has a time before.
   ...changed&&{before:{phrase:phrase(parseCron(p.before!.cron)),cron:p.before!.cron,timeZone:p.before!.timeZone}}}};
 }
 binding(t:Topic){return this.store.data.bindings.find(b=>b.id===t.bindingId);}
 topic(id:string|undefined){return id?this.store.data.topics.find(t=>t.id===id):undefined;}
 log(t:Topic,text:string,level?:'info'|'error'){const b=this.binding(t);this.store.log('定时任务',(b?b.name+'：':'')+text,level);}
}
