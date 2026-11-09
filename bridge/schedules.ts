import {uuid,enqueue,publicText} from './core.ts';
import {parseCron,zone,next,previous,when} from './cron.ts';
import {notice} from './message-cards.ts';
import {clip} from './request-cards.ts';
import {titleOf} from './attachments.ts';
import type {Store} from './core.ts';
import type {App,Mode,Schedule,Run,Topic} from './state.ts';
import type {Topics} from './topics.ts';
import type {Platforms} from './platform.ts';
// Schedules: besides a person's message, the other way that work reaches the agents of a binding. At each time of its cron expression in
// its time zone (see cron.ts) a schedule either opens a new topic for its task (mode new: the bot posts the run's card into the chat and
// the topic opens under it, see Topics.begin) or gives its task to the agent of one topic of the binding, as a person's message in its
// thread would (mode into). Bridge only decides when and where; what the task means is the agent's.
export const modes:Record<Mode,string>={new:'每次开新话题',into:'发进话题'};
// Whether v names a mode: a string that is the name of a property of modes. Not a value that merely prints as one, such as a list.
export const isMode=(v:unknown):v is Mode=>typeof v==='string'&&Object.hasOwn(modes,v);
// The latest time due runs only when it is at most this late; the times before it, which only a Bridge that was down leaves, are missed.
const grace=2*3600000;
// Mode new keeps the topics of its latest runs, and of the older runs those in which a person wrote within the quiet time (see prune).
const kept=3,quiet=24*3600000;
// The runs that a schedule keeps in its record.
const history=20;
// The longest task: as long as a message that a person can prompt an agent with (see forwardable in platform.ts).
const taskLimit=16000;
// What cards and logs call schedule s: the first 8 characters of its id, which bridge-schedule also takes (see AgentSchedules).
export const short=(s:{id:string})=>s.id.slice(0,8);
const brief=(e:Error|undefined)=>publicText(e?.message).split('\n')[0].slice(0,200);
const busyReason='上次还没结束，跳过',endedReason='话题已结束，定时任务已暂停',unboundReason='绑定已移除，定时任务已暂停',missedReason='Bridge 停机，错过';
// Whether an agent of an agent list works or waits for a confirmation.
const working=(agent:{agent_status:string}|null|undefined)=>['working','blocked'].includes(agent?.agent_status);
// The card of run n of schedule s, due at due: which schedule, which run, when, and its task.
const runCard=(s:Schedule,n:number,due:number)=>({card:notice(`定时任务 ${short(s)} · 第 ${n} 次运行 · ${when(due,s.timeZone)}\n${clip(s.task,300)}`)});
// A schedule as list returns it: without its runs, with the time of its next run.
export type Listed=Omit<Schedule,'runs'>&{next:number|null};
// A schedule as add takes it, every field still to be checked.
type Asked={bindingId:unknown,mode:unknown,topicId?:unknown,cron:unknown,timeZone:unknown,task:unknown,createdBy?:Record<string,unknown>};
// The topics that the runs of schedule s opened.
type Scheduled=Topic&{scheduled:NonNullable<Topic['scheduled']>};
const by=(s:Schedule)=>(t:Topic):t is Scheduled=>t.scheduled?.id===s.id;
type Deps={topics:Pick<Topics,'begin'|'queue'|'alive'|'prompt'|'notify'|'retire'>,app:(id:string)=>App,send:Platforms['send'],reply:Platforms['reply'],now?:()=>number,every?:number};
export class Schedules{
 declare store:Store;declare topics:Deps['topics'];declare app:Deps['app'];declare send:Deps['send'];declare reply:Deps['reply'];declare now:()=>number;declare every:number;
 declare queues:Map<string,Promise<unknown>>;declare timer:NodeJS.Timeout|null;
 // topics are the topics of the bindings (see topics.ts); app(id) returns an app or throws; send(app,chatId,{card}) posts a message of the
 // bot into a chat outside any thread and resolves to its id, and reply(app,chatId,rootId,{card}) one into the thread of a topic. now() is
 // the clock, and every the milliseconds between two checks of the timer.
 constructor(store:Store,{topics,app,send,reply,now=Date.now,every=10000}:Deps){
  this.store=store;this.topics=topics;this.app=app;this.send=send;this.reply=reply;this.now=now;this.every=every;this.queues=new Map();this.timer=null;
 }
 start(){this.timer??=setInterval(()=>this.tick(),this.every);}
 stop(){clearInterval(this.timer??undefined);this.timer=null;}
 // A new schedule of binding bindingId: mode new opens a new topic at each run, mode into gives the task to the agent of topic topicId of
 // the binding. cron and timeZone say when and task what (see check); createdBy says who asked for it, as {topicId, openId}, both optional.
 // Its times count from now. Returns a copy of the record {id, bindingId, mode, topicId?, cron, timeZone, task, paused, createdBy,
 // createdAt, handledUntil, count, runs}: the times up to handledUntil are handled, count runs have started, and runs holds the latest
 // runs as {due, at, outcome, n?, topicId?, reason?, last?}, where due is the time of the run and at when Bridge handled it; outcome is
 // started (n numbers it, topicId is the topic it opened or prompted), skipped or failed with reason, or missed with reason, last being the
 // latest of the times missed since due.
 add({bindingId,mode,topicId,cron,timeZone,task,createdBy}:Asked){
  const b=this.binding(bindingId);if(!b)throw Error('会话绑定不存在');
  if(!isMode(mode))throw Error('模式无效，应为 new 或 into');
  const topic=mode==='into'?this.store.data.topics.find(t=>t.id===topicId&&t.bindingId===b.id):null;
  if(mode==='into'&&!topic)throw Error('话题不存在');
  const now=this.now(),s:Schedule={id:uuid(),bindingId:b.id,mode,...topic&&{topicId:topic.id},...this.check({cron,timeZone,task}),paused:false,
   createdBy:Object.fromEntries(['topicId','openId'].filter(k=>typeof createdBy?.[k]==='string').map(k=>[k,createdBy?.[k]])),createdAt:now,handledUntil:now,count:0,runs:[]};
  this.store.data.schedules.push(s);this.store.save();this.log(s,`已添加定时任务 ${short(s)}（${s.cron}，${s.timeZone}，${modes[mode]}）`);
  return structuredClone(s);
 }
 // cron, timeZone and task as stored: the expression with single spaces, the time zone in its canonical form and the task trimmed, at most
 // 16000 characters. Throws when one is invalid or the expression has no time left to run.
 check({cron,timeZone,task}:{cron:unknown,timeZone:unknown,task:unknown}){
  const c=parseCron(cron),tz=zone(timeZone);
  if(typeof task!=='string'||!task.trim()||task.trim().length>taskLimit)throw Error(`任务文字为空或超过 ${taskLimit} 字`);
  if(next(c,tz,this.now())==null)throw Error('这个时间表达式不会再运行');
  return {cron:String(cron).trim().split(/\s+/).join(' '),timeZone:tz,task:task.trim()};
 }
 // Changes the cron expression, the time zone or the task of schedule id, checked like add; the mode, the binding and the topic stay. Its
 // times count from now. Returns a copy.
 update(id:string,{cron,timeZone,task}:{cron?:unknown,timeZone?:unknown,task?:unknown,[field:string]:unknown}={}){
  const s=this.get(id);Object.assign(s,this.check({cron:cron??s.cron,timeZone:timeZone??s.timeZone,task:task??s.task}),{handledUntil:this.now()});
  this.store.save();this.log(s,`定时任务 ${short(s)} 已修改（${s.cron}，${s.timeZone}）`);return structuredClone(s);
 }
 pause(id:string){const s=this.get(id);s.paused=true;this.store.save();this.log(s,`定时任务 ${short(s)} 已暂停`);return structuredClone(s);}
 // Its times count from now: the times that fell into the pause are not made up for.
 resume(id:string){const s=this.get(id);Object.assign(s,{paused:false,handledUntil:this.now()});this.store.save();this.log(s,`定时任务 ${short(s)} 已恢复`);return structuredClone(s);}
 // The topics that its runs opened stay.
 remove(id:string){const s=this.get(id);this.store.data.schedules=this.store.data.schedules.filter(x=>x!==s);this.store.save();this.log(s,`定时任务 ${short(s)} 已删除`);}
 // Copies of the schedules, of binding bindingId when given, without their runs and with next, the time of their next run, null while paused.
 list(bindingId?:string):Listed[]{
  const now=this.now();
  return this.store.data.schedules.filter(s=>!bindingId||s.bindingId===bindingId).map(({runs,...s})=>({...structuredClone(s),next:s.paused?null:next(parseCron(s.cron),s.timeZone,Math.max(now,s.handledUntil))}));
 }
 runs(id:string){return structuredClone(this.get(id).runs);}
 get(id:string){const s=this.store.data.schedules.find(x=>x.id===id);if(!s)throw Error('定时任务不存在');return s;}
 // Runs what is due in the schedules that are not paused, each schedule in its own queue (see fire), and resolves once those runs are
 // recorded. A schedule handles its times in order and each at most once: handledUntil, the latest time due, and the record of the times it
 // missed are on disk before anything is awaited (see due). A schedule whose times cannot be computed, such as one whose time zone Intl no
 // longer knows, is paused. Never rejects.
 tick(){
  const now=this.now();
  return Promise.all(this.store.data.schedules.filter(s=>!s.paused).map(s=>{
   let due:number|undefined;try{due=this.due(s,now);}
   catch(e){s.paused=true;this.store.save();this.log(s,`定时任务 ${short(s)} 的时间无法计算，已暂停：${brief(e)}`,'error');return;}
   if(due!=null)return enqueue(this.queues,s.id,()=>this.fire(s,due));
  }));
 }
 // The time of schedule s to run at now, or nothing. Of the times due only the latest runs, and only when it is at most 2 hours late: a
 // short restart does not cost a daily run, and one after a long stop does not start a series of runs. The other times due are recorded as
 // missed, in one record from the first to the last of them.
 due(s:Schedule,now:number){
  // A time is due, so there is a latest.
  const c=parseCron(s.cron),first=next(c,s.timeZone,s.handledUntil);if(first==null||first>now)return;
  const latest=previous(c,s.timeZone,now+1)!,late=now-latest>grace;
  s.handledUntil=latest;
  if(late||first<latest){const last=late?latest:previous(c,s.timeZone,latest)!;this.record(s,{due:first,...last>first&&{last},at:now,outcome:'missed',reason:missedReason});}
  else this.store.save();
  return late?undefined:latest;
 }
 // Runs schedule s for its time due in its mode, unless it was removed or paused while queued. Never rejects: a failure is recorded with a
 // reason that carries no details, which only the log keeps.
 async fire(s:Schedule,due:number){
  if(s.paused||!this.store.data.schedules.includes(s))return;
  const at=this.now();
  try{await (s.mode==='into'?this.into(s,due,at):this.open(s,due,at));}
  catch(e){this.record(s,{due,at,outcome:'failed',reason:'运行出错，详见 Bridge 日志'});this.log(s,`定时任务 ${short(s)} 运行出错，${brief(e)}`,'error');}
 }
 // A run of schedule s in mode new: unless the agent of its previous run has not finished (see busy), the bot posts the run's card into the
 // chat of the binding and a topic opens under it with the task as its first message (see Topics.begin), which nobody wrote and gets no
 // reaction; then the topics of older runs go (see prune). A run whose topic did not get the task to its agent is failed. A binding that
 // was removed pauses the schedule.
 async open(s:Schedule,due:number,at:number){
  const b=this.binding(s.bindingId);
  if(!b){s.paused=true;this.record(s,{due,at,outcome:'skipped',reason:unboundReason});this.log(s,`定时任务 ${short(s)} 的绑定已移除，已暂停`);return;}
  const last=this.store.data.topics.filter(by(s)).reduce<Scheduled|null>((x,t)=>!x||t.scheduled.n>x.scheduled.n?t:x,null);
  if(await this.busy(last))return this.record(s,{due,at,outcome:'skipped',reason:busyReason});
  const a=this.app(b.appId),n=s.count+1;let root:string;
  try{root=await this.send(a,b.chatId,runCard(s,n,due));}
  catch(e){this.record(s,{due,at,outcome:'failed',reason:'未能在群里发出这次运行的消息'});this.log(s,`定时任务 ${short(s)} 未能发出运行的消息，${brief(e)}`,'error');return;}
  const {topic,delivered}=this.topics.begin(a,b,root,{title:titleOf({content:s.task}),msg:{messageId:root,content:s.task},fields:{scheduled:{id:s.id,n}}});
  s.count=n;const run=this.record(s,{due,at,outcome:'started',n,topicId:topic.id});
  const [agent]=await Promise.all([delivered,this.prune(s)]);
  if(!agent)this.fail(run,topic.state==='failed'?'Agent 启动失败':'任务没有发给 Agent');
 }
 // Whether topic t has not finished: it is still starting, or its agent works or waits for a confirmation. The agent is read in the topic's
 // queue, after what is queued there (see Topics.alive, which also ends a topic whose agent is gone).
 async busy(t:Topic|null){
  if(t?.state==='starting')return true;
  if(t?.state!=='ready')return false;
  return working(await this.topics.queue(t,()=>this.topics.alive(this.app(t.appId),t)));
 }
 // A run of schedule s in mode into, in the queue of its topic: unless the agent works or waits for a confirmation, the run's card goes into
 // the thread and the task to the agent like a person's message, without a reaction, and the COT of the turn answers the card (see
 // Topics.prompt). A topic that has ended, also one whose agent turns out to be gone, pauses the schedule (see ended).
 async into(s:Schedule,due:number,at:number){
  const t=this.store.data.topics.find(x=>x.id===s.topicId),b=t&&this.binding(t.bindingId);
  if(!t||!b||!['starting','ready'].includes(t.state))return this.ended(s,t,{due,at});
  await this.topics.queue(t,async()=>{
   const a=this.app(t.appId),agent=await this.topics.alive(a,t);
   if(!agent)return this.ended(s,t,{due,at});
   if(working(agent))return this.record(s,{due,at,outcome:'skipped',reason:busyReason});
   const n=s.count+1;let card:string;
   try{card=await this.reply(a,t.chatId,t.rootId,runCard(s,n,due));}
   catch(e){this.record(s,{due,at,outcome:'failed',reason:'未能在话题里发出这次运行的消息'});this.log(s,`定时任务 ${short(s)} 未能发出运行的消息，${brief(e)}`,'error');return;}
   s.count=n;const run=this.record(s,{due,at,outcome:'started',n,topicId:t.id});
   let agentPrompted;try{agentPrompted=await this.topics.prompt(a,b,t,{messageId:card,content:s.task});}
   catch(e){this.log(s,`定时任务 ${short(s)} 的任务没有发给 Agent，${brief(e)}`,'error');}
   if(!agentPrompted)this.fail(run,'任务没有发给 Agent');
  });
 }
 // Schedule s in mode into whose topic t has ended, or went with its binding, skips its run and pauses: another agent in the same topic
 // would not remember the earlier runs. A topic that is still there gets a notice in its thread.
 async ended(s:Schedule,t:Topic|undefined,run:{due:number,at:number}){
  s.paused=true;this.record(s,{...run,outcome:'skipped',reason:endedReason});this.log(s,`定时任务 ${short(s)} 的话题已结束，已暂停`);
  if(t)await this.topics.notify(this.app(t.appId),t,`定时任务 ${short(s)} 已暂停：这个话题的会话已结束，定时任务不会在这里另起一个 Agent`);
 }
 // Ends the topics that schedule s opened before its latest 3 runs and closes the panes of their agents (see Topics.retire), except one in
 // which a person wrote within a day: they may still be talking to its agent. Each daily run would otherwise keep an agent of a few hundred
 // MB running. A topic that has ended already keeps its pane. Never rejects.
 prune(s:Schedule){
  const now=this.now(),opened=this.store.data.topics.filter(by(s)).sort((x,y)=>y.scheduled.n-x.scheduled.n);
  return Promise.all(opened.slice(kept).filter(t=>t.state==='ready'&&!(now-(t.scheduled.messageAt??-Infinity)<quiet))
   .map(t=>this.topics.retire(t,`这个话题来自定时任务 ${short(s)}，定时任务只保留最近 ${kept} 次运行的话题，Agent 已关闭`)));
 }
 // Appends run to the record of schedule s, which keeps the latest 20 runs, and returns it.
 record(s:Schedule,run:Run){s.runs=[...s.runs,run].slice(-history);this.store.save();return run;}
 fail(run:Run,reason:string){Object.assign(run,{outcome:'failed',reason});this.store.save();}
 binding(id:unknown){return this.store.data.bindings.find(x=>x.id===id);}
 log(s:Schedule,text:string,level?:'info'|'error'){const b=this.binding(s.bindingId);this.store.log('定时任务',(b?b.name+'：':'')+text,level);}
}
