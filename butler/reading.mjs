// The daily read: every night the model reads the day before (local time, 00:00 to 24:00) of each chat at the daily or
// instant level, splits each chat's messages into topics and picks those worth my while by 关于TA and my notes. The
// topics, picked and not, are stored (see topics.mjs) as context to be looked up later; nothing is pushed to me.
// Messages of a daily chat that I may have to act on are flagged (see Store.flag), so that the batches take them and
// judge them by their own bar; an instant chat's messages go to the batches anyway. What a topic is, which messages
// make it, whether to pick it and what to flag is the model's call: this only gathers what it is shown and checks that
// the answer points at nothing else. Small chats go several to a model run; a big one goes alone, in segments, each
// later one shown the topics made of the earlier ones and the messages just before it, so that a discussion that goes
// on stays one topic. It runs on a timer of its own in the processor's process (see cli.mjs), beside the batches and
// grading, and once butler is back from being down it reads the days it missed, the latest few of them.
import {arrange,clean,parse,FACTS,DATA,PROFILE} from './prompt.mjs';
import {ungradedLevel} from './rules.mjs';
import {AREAS} from './topics.mjs';
import {DEFAULTS as PROCESSOR} from './processor.mjs';

// checkMs: how often the reader looks for a day to read. atMs: how long after midnight the day before is read, so that
// what reaches butler late (a reconciliation, replies fetched later) is in it, and so that what it flags reaches the
// batches in the morning, not at night, when the matters made of it could send a digest out of hours. catchUpDays: how many of the days due
// are read, the latest; the older ones, missed while butler was down, are passed over. retryMs: how long after a read
// that did not finish to try again. skipAfter: how many unusable answers to a chat's messages alone give up its day.
// maxPromptBytes and textChars: the batches'; maxChats: how many chats a prompt holds at most, so that no answer has to
// give the topics of too many; contextMessages: how many messages before a later segment come along, the batches'.
export const DEFAULTS={checkMs:60_000,atMs:6*3600e3,catchUpDays:3,retryMs:1_800_000,skipAfter:3,maxPromptBytes:PROCESSOR.maxPromptBytes,maxChats:20,
 contextMessages:PROCESSOR.contextMessages,textChars:PROCESSOR.textChars};
// The levels whose chats are read.
const READ=['daily','instant'];
const message=e=>e?.message??String(e);
const at=ms=>new Date(ms).toLocaleString('sv-SE').slice(0,16);
const memo=fn=>{const known=new Map();return k=>{if(!known.has(k))known.set(k,fn(k));return known.get(k);};};
// Days are local and written YYYY-MM-DD.
export const dayOf=ms=>new Date(ms).toLocaleString('sv-SE').slice(0,10);
const parts=day=>day.split('-').map(Number);
export const startOf=day=>{const [y,m,d]=parts(day);return new Date(y,m-1,d).getTime();};
export const nextDay=(day,n=1)=>{const [y,m,d]=parts(day);return dayOf(new Date(y,m-1,d+n).getTime());};
// The first whole day from t on.
const wholeFrom=t=>{const day=dayOf(t);return startOf(day)===t?day:nextDay(day);};

// One line: it travels as a command-line argument, and herdr refuses control characters there.
export function readingSystemPrompt(me){
 return [
  `你替「${me}」读TA在飞书上的聊天前一天的消息：把每个聊天的消息拆成话题，按「关于TA」和TA的说明挑出TA值得看的。挑出的话题以后TA问起时当作上下文给TA看；没挑的也存下，供TA检查有没有漏挑。`,
  `你会收到一个 JSON：now 是现在的时间；day 是读的那一天；${PROFILE}；notes 是TA自己写下的说明，是TA的原话，和「关于TA」不一致时以说明为准；chats 是要读的聊天：chat 是这次的编号，name 是名称，kind 为 direct 是私聊、group 是群、topic 是话题群，level 是它的级别（daily 是每日，instant 是即时），topics 是这一天已经从这个聊天拆出的话题（一个聊天的消息太多时分几次读，后面几次才有），messages 是消息，从早到晚，new 为 true 的是这次要读的，其余是帮助理解的上下文（前面的消息、话题的第一条和被回复的消息）。`,
  FACTS,
  '话题是同一件事的一段讨论、一个问题和对它的回答，或者一条通知：同一个话题串里的、互相回复的、时间接近又在说同一件事的消息归成一个话题。一个话题只属于一个聊天。表情、寒暄这类说不上话题的零碎消息可以不归进任何话题。新消息接着 topics 里的哪个话题说，就归到那个话题上，不要另开一个；需要时按新消息改它的标题和要点。',
  '挑不挑由你按「关于TA」和说明判断：和TA的工作有关（TA在做的项目和系统、归TA的事、TA该知道的结论和决定），或者是TA感兴趣的话题，就挑出来（picked 为 true）；和TA关系不大的不挑。机器人的例行通知和闲聊通常不挑，除非内容和TA的工作或兴趣直接相关。area 写这个话题属于TA的工作（work）、兴趣（interest），还是都不是（other）。',
  '每日级别（daily）的聊天里，可能要TA本人去做、回复或决定什么的新消息（不管有没有 @TA），把编号列在 flagged 里：它们会交给整理待办的模型再判断，拿不准时也可以列。即时级别（instant）的聊天的消息都会交给它，不用列。',
  DATA,
  '只输出一个 JSON 对象，不要输出任何别的文字：{"topics":[话题],"flagged":["消息编号"]}。新话题写成 {"title":"一句话标题","summary":"要点或结论，写具体","area":"work、interest 或 other","picked":true 或 false,"reason":"挑或不挑的一句理由","messages":["构成它的新消息的编号"]}；接着 topics 里的话题写成 {"topic":"话题编号","messages":["新归到它的消息编号"]}，标题、要点、area、picked 或 reason 要改时一起写上新的。',
  'title、summary 和 reason 是给TA看的，用平常的话写，不要写消息编号和话题编号，也不要写链接。没有话题时输出 {"topics":[],"flagged":[]}。',
 ].join(' ');
}

// chats: each with feedId, name, kind, level, records (the messages to read, store records, oldest first), context
// (records that help read them) and topics (those made of it so far that day, see Topics.ofDay). about: 关于TA (the
// meta profile) and my notes. Chats go under ids of this prompt (c1, c2, …), messages under refs (m1, m2, …, see
// prompt.mjs arrange) and topics under refs too (t1, t2, …), never butler's ids. Returns the prompt, what each message
// and topic ref stands for, the chat and level of each message to read (fresh, by id) and how many there are.
export function composeReading({now,day,me,meId,about:{profile,notes=[]}={},chats,textChars=DEFAULTS.textChars}){
 const fresh=new Map(chats.flatMap(c=>c.records.map(r=>[r.id,{feedId:c.feedId,level:c.level}])));
 const shown=arrange(chats.flatMap(c=>[...c.records,...c.context]),new Set(fresh.keys()),{textChars,me,meId}),byId=new Map(chats.map(c=>[c.feedId,c])),topicRefs=new Map();
 const list=shown.chats.map((s,i)=>{
  const c=byId.get(shown.chatIds[i]);
  const topics=c.topics.map(t=>{const topic=`t${topicRefs.size+1}`;topicRefs.set(topic,{id:t.id,feedId:c.feedId});return {topic,title:t.title,summary:t.summary,area:t.area,picked:t.picked,reason:t.reason};});
  return {chat:`c${i+1}`,name:c.name,kind:s.kind,level:c.level,...topics.length&&{topics},messages:s.messages};
 });
 const data={now:at(now),day,profile:profile?.text??null,notes:notes.map(n=>n.text),chats:list};
 return {system:readingSystemPrompt(me),prompt:`以下是这次要读的聊天：\n${JSON.stringify(data)}`,refs:shown.refs,topicRefs,fresh,messages:fresh.size};
}

// The model's answer: the topics it made, each in the chat of its messages and with at least one message to read; the
// topics it carried on, given ones, with the fields it changed and messages of their chat; and the messages it flagged,
// those to read of daily chats. Texts are cleaned (links replaced) and cut; an unknown area is other, and a picked that
// is not true or false is not picked. What points elsewhere or breaks the rules is left out and listed in problems; an
// answer that is not the asked-for object throws.
const TITLE=80,SUMMARY=400,REASON=200;
const isObject=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function readTopics(text,{refs,topicRefs,fresh}){
 const v=parse(text);
 if(!isObject(v)||!Array.isArray(v.topics))throw Error(`模型的回复缺少 topics：${String(text).slice(0,200)}`);
 const created=[],updated=[],flagged=[],problems=[];
 // The messages to read a list points at, all of one chat (chat, or that of the first), each once.
 const messagesOf=(list,what,chat)=>{
  const ids=[];
  for(const ref of Array.isArray(list)?list:[]){
   const known=refs.get(String(ref)),c=known&&fresh.get(known.id);
   if(!c){problems.push(`${what}引用了${known?'不是这次要读的':'不存在的'}消息 ${String(ref).slice(0,20)}`);continue;}
   if((chat??=c.feedId)!==c.feedId){problems.push(`${what}引用了别的聊天的消息 ${ref}`);continue;}
   if(!ids.includes(known.id))ids.push(known.id);
  }
  return {ids,chat};
 };
 // A topic's fields; of one carried on (carried), only those it changes.
 const fields=(item,what,carried)=>{
  const out={},kept=carried?'，没有改':'';
  for(const [k,max] of [['title',TITLE],['summary',SUMMARY],['reason',REASON]]){const value=clean(item[k],max);if(value||!carried)out[k]=value;}
  if(AREAS.includes(item.area))out.area=item.area;
  else if(item.area!==undefined||!carried){problems.push(`${what}的 area ${String(item.area).slice(0,20)} 不认识${kept||'，按 other 处理'}`);if(!carried)out.area='other';}
  if(typeof item.picked==='boolean')out.picked=item.picked;
  else if(item.picked!==undefined||!carried){problems.push(`${what}的 picked 不是 true 或 false${kept||'，按没挑处理'}`);if(!carried)out.picked=false;}
  return out;
 };
 for(const item of v.topics){
  if(!isObject(item)){problems.push(`一个话题不是对象：${String(JSON.stringify(item)).slice(0,100)}`);continue;}
  if(item.topic!=null){
   const known=topicRefs.get(String(item.topic));
   if(!known){problems.push(`回复引用了不存在的话题 ${String(item.topic).slice(0,20)}`);continue;}
   const what=`话题 ${item.topic} `,{ids}=messagesOf(item.messages,what,known.feedId),changes=fields(item,what,true);
   if(ids.length||Object.keys(changes).length)updated.push({topicId:known.id,changes,messageIds:ids});
   continue;
  }
  const title=clean(item.title,TITLE);
  if(!title){problems.push(`一个话题没有标题：${JSON.stringify(item).slice(0,200)}`);continue;}
  const what=`话题「${title}」`,{ids,chat}=messagesOf(item.messages,what);
  if(!ids.length){problems.push(`${what}没有引用这次要读的消息，没有采纳`);continue;}
  created.push({feedId:chat,...fields(item,what,false),messageIds:ids});
 }
 for(const ref of Array.isArray(v.flagged)?v.flagged:[]){
  const known=refs.get(String(ref)),c=known&&fresh.get(known.id);
  if(!c)problems.push(`flagged 引用了${known?'不是这次要读的':'不存在的'}消息 ${String(ref).slice(0,20)}`);
  else if(c.level!=='daily')problems.push(`flagged 引用了即时级别的聊天里的消息 ${ref}，它本来就交给整理待办的模型`);
  else if(!flagged.includes(known.id))flagged.push(known.id);
 }
 return {created,updated,flagged,problems};
}

// The days to read at now, oldest first: from the first day to read (from), or the day after the last one read
// (through), up to the latest whose time has come (atMs after the midnight that ends it). Of those the catchUpDays
// latest are due and the older ones, missed while butler was down, skipped. upcoming: the next day to read, and next:
// when it is due, now when one is. Without from (butler has not begun keeping every message) nothing is.
export function plan({now,from,through,options:o}){
 if(from===undefined)return {due:[],skipped:[]};
 const today=dayOf(now),latest=nextDay(today,now>=startOf(today)+o.atMs?-1:-2),first=through===undefined||through<from?from:nextDay(through);
 const days=[];for(let d=first;d<=latest;d=nextDay(d))days.push(d);
 const due=days.slice(-o.catchUpDays),skipped=days.slice(0,days.length-due.length);
 return {due,skipped,upcoming:due[0]??first,next:due.length?now:startOf(nextDay(first))+o.atMs};
}

export class Reader{
 #timer;#passes=new Set();#halting=false;#most=Infinity;
 // model: {ask({system, prompt}) → reply text, name}: herdr (see herdr-model.mjs), each run a claude of its own beside
 // the batches' and grading's. topics: the read's tables (see topics.mjs). now: the clock.
 constructor({store,matters,topics,model,options={},now=Date.now,log=()=>{}}){
  Object.assign(this,{store,matters,topics,model,options:{...DEFAULTS,...options},now,log});
 }
 // Looks for days to read now and every checkMs; what goes wrong is recorded.
 start(){
  this.#halting=false;
  const failed=e=>this.store.addError('读取',`查看要读的日子时出错：${message(e)}`);
  const tick=()=>{try{this.check()?.catch(failed);}catch(e){failed(e);}};
  this.#timer=setInterval(tick,this.options.checkMs);tick();
 }
 // No further run starts; waits for the one under way.
 async stop(){this.#halting=true;clearInterval(this.#timer);await Promise.allSettled([...this.#passes]);}

 // Reads the days due (see plan), oldest first, the next only once one is done, unless a read that did not finish
 // was less than retryMs ago. The days passed over go on record (meta reading skipped). Nothing starts while a read is
 // under way. Returns the read, or undefined when none starts.
 check(){
  if(this.#passes.size||this.#halting)return undefined;
  const m=this.#meta();
  if(this.now()-m.failedAt<this.options.retryMs)return undefined;
  const {due,skipped}=plan({now:this.now(),from:m.from,through:m.through,options:this.options});
  if(skipped.length){
   this.store.setMeta('reading',{...m,through:skipped.at(-1),skipped});
   this.log(`读取：停机期间没读的 ${skipped.length} 天不补读了（${skipped.join('、')}），只补最近的 ${this.options.catchUpDays} 天`);
  }
  return due.length?this.#track(this.#days(due)):undefined;
 }
 // Reads one day now, as a check would (see #read).
 read(day){return this.#track(this.#read(day));}
 // What status shows: the last day read to the end (meta reading last: day, at, chats, the topics picked and not, the
 // messages flagged and the chats given up), the last day read or passed over (through), a read that did not finish
 // since (failedDay, failedAt, error) and when it goes again (retryAt), the days due now (due) or the next one to read
 // and when (upcoming, next), the days passed over after butler was down (skipped) and the first day to read (from).
 status(){
  const m=this.store.meta('reading')??{},from=m.from??this.#from(),{due,upcoming,next}=plan({now:this.now(),from,through:m.through,options:this.options});
  return {...m,from,due,upcoming,next,...m.failedAt!==undefined&&{retryAt:m.failedAt+this.options.retryMs}};
 }

 // The first day to read: the first whole day butler kept every message on (see Store.keptSince), the day before
 // which is not all there; undefined before it began.
 #from(){const kept=this.store.keptSince();return kept===undefined?undefined:wholeFrom(kept);}
 // The meta reading, with the first day to read set once it is known: keptSince reads every stored message.
 #meta(){
  const m=this.store.meta('reading')??{};if(m.from!==undefined)return m;
  const from=this.#from();if(from===undefined)return m;
  const out={...m,from};this.store.setMeta('reading',out);return out;
 }
 // A read under way, for check and stop.
 #track(run){
  const p=run.finally(()=>this.#passes.delete(p));
  this.#passes.add(p);return p;
 }
 async #days(due){for(const day of due){const r=await this.#read(day);if(!r.complete)return;}}

 // One read of a day: the chats to read (see #chats) that are not read to the end, in parts (see #part), one model run
 // each. A run that gets no answer ends the read: the model or its machine is not there. One whose answer cannot be
 // used goes again at once with half as many chats; a chat alone counts it against itself (see Topics.strike) and is
 // set aside for the rest of the read. The day is done when every chat is read to the end or given up, and recorded
 // (meta reading: last and through); else it goes again retryMs later (failedAt), from where it stopped. A stop keeps
 // what was read and records nothing. Resolves with the day, the runs, how many chats and whether it is done.
 async #read(day){
  const from=startOf(day),until=startOf(nextDay(day)),chats=this.#chats(from,until),aside=new Set();
  const about={profile:this.store.meta('profile'),notes:this.matters.notes()};
  const left=()=>chats.map(c=>({...c,reading:this.topics.reading(day,c.feedId)})).filter(c=>!c.reading?.doneAt&&!aside.has(c.feedId));
  let runs=0,error;
  for(let rest=left();rest.length&&!this.#halting;rest=left()){
   const part=this.#part(rest,{day,from,until,about});if(!part)continue;
   runs+=1;const r=await this.#run(part,day);
   if(r.ok){this.#most=Infinity;continue;}
   error=r.error;this.#most=Math.max(1,Math.ceil(part.chats.length/2));
   if(!r.answered)break;
   if(part.chats.length===1){const [c]=part.chats;this.topics.strike(day,c.feedId,{level:c.level,error:r.error,skipAfter:this.options.skipAfter,now:this.now()});aside.add(c.feedId);}
  }
  const complete=chats.every(c=>this.topics.reading(day,c.feedId)?.doneAt);
  if(this.#halting&&!complete)return {day,runs,chats:chats.length,complete};
  const m=this.store.meta('reading')??{};
  if(complete){
   const last={day,at:this.now(),...this.topics.summary(day)};
   this.store.setMeta('reading',{...m,through:m.through>day?m.through:day,last,failedAt:undefined,failedDay:undefined,error:undefined});
   this.log(`读取 ${day}：${last.chats} 个聊天，挑出 ${last.picked} 个话题、没挑 ${last.notPicked} 个，标出 ${last.flagged} 条消息交给批次，模型运行 ${runs} 次${last.failed.length?`；${last.failed.length} 个聊天读不成，放弃了`:''}`);
  }else this.store.setMeta('reading',{...m,failedAt:this.now(),failedDay:day,error});
  return {day,runs,chats:chats.length,complete,error};
 }
 // The chats to read of a day (from, until: its bounds in ms): those with messages then whose level as the day ended
 // (see Store.levelAt; a chat with none goes by ungradedLevel) is daily or instant, the busiest first.
 #chats(from,until){
  return this.matters.chatsBetween(from,until).map(c=>({...c,level:this.store.levelAt(c.feedId,until-1)??ungradedLevel(c.kind)})).filter(c=>READ.includes(c.level));
 }
 // The next part: as many whole chats from the front of rest as fit maxPromptBytes, no more than maxChats or the last
 // failure left (#most). A chat that does not fit alone goes alone with some of its messages, at least one: a segment,
 // its unread messages shared out evenly over as few as fit. A chat that an answer failed for alone goes alone too, in
 // segments of half the size for each such failure.
 // A chat's messages are read when it is first considered; a chat with none left is read to the end, and there is no
 // part (undefined).
 #part(rest,{day,from,until,about}){
  const o=this.options,me=this.matters.me(),meId=this.matters.meId(),visible=memo(id=>this.matters.visible(id)),unit=c=>this.#unit(c,{day,from,until,visible});
  const compose=list=>({...composeReading({now:this.now(),day,me,meId,about,chats:list,textChars:o.textChars}),chats:list});
  const [first]=rest,whole=unit(first),strikes=first.reading?.strikes??0,budget=o.maxPromptBytes/2**strikes,fits=(p,max=o.maxPromptBytes)=>Buffer.byteLength(p.prompt)<=max;
  if(!whole.records.length){this.topics.apply({day,read:[{feedId:first.feedId,level:first.level,messages:0,until:first.reading?.until,done:true}],now:this.now()});return undefined;}
  let part=compose([whole]);
  if(fits(part,budget)){
   const most=strikes?1:Math.min(rest.length,o.maxChats,this.#most);
   for(let n=1,next;n<most&&!rest[n].reading?.strikes&&fits(next=compose([...part.chats,unit(rest[n])]));n++)part=next;
   return {...part,chats:part.chats.map(c=>({...c,done:true}))};
  }
  const segment=k=>compose([unit({...first,records:whole.records.slice(0,k)})]),n=whole.records.length;
  let lo=1,hi=n-1;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fits(segment(mid),budget))lo=mid;else hi=mid-1;}
  // What is left shared out evenly over as many segments as it takes: no small one at the end, and room for the
  // topics, which the later segments carry and which grow.
  part=segment(Math.ceil(n/Math.ceil(n/lo)));
  return {...part,chats:part.chats.map(c=>({...c,done:false}))};
 }
 // A chat as composeReading takes it: its messages of the day not read yet (records, unless it has them: a segment);
 // as context the thread roots and the messages replied to that are not among them and, for a chat read on from where
 // an earlier part stopped, the contextMessages before them; and the topics made of it so far that day.
 #unit(c,{day,from,until,visible}){
  const u=c.reading?.until,records=c.records??this.matters.between(c.feedId,from,until).filter(r=>!u||r.createdAt>u.at||r.createdAt===u.at&&r.id>u.id);
  const ids=new Set(records.map(r=>r.id)),context=new Map(),add=r=>{if(r&&!ids.has(r.id))context.set(r.id,r);};
  if(u&&records.length)for(const r of this.matters.before(c.feedId,records[0].createdAt,this.options.contextMessages))add(r);
  for(const r of records){if(r.rootId&&r.rootId!==r.id)add(visible(r.rootId));if(r.parentId)add(visible(r.parentId));}
  return {...c,records,context:[...context.values()],topics:u?this.topics.ofDay(day,c.feedId):[]};
 }
 // One run, recorded in model_runs (kind read; messages: how many it was given to read). What the answer flags is
 // flagged first and the rest written after (Topics.apply): flagging again changes nothing, so a crash between the two
 // only has the part read again. answered: the model gave an answer that could not be used, as opposed to none.
 async #run({chats,system,prompt,refs,topicRefs,fresh,messages},day){
  let answered=false;
  try{
   await this.matters.recordRun({model:this.model,kind:'read',messages,system,prompt,now:this.now},(output,runId)=>{
    let reply;try{reply=readTopics(output,{refs,topicRefs,fresh});}catch(e){answered=true;throw e;}
    const flagged=new Set(this.store.flag(reply.flagged));
    this.topics.apply({day,runId,created:reply.created,updated:reply.updated,now:this.now(),read:chats.map(c=>({feedId:c.feedId,level:c.level,messages:c.records.length,
     until:{at:c.records.at(-1).createdAt,id:c.records.at(-1).id},flagged:c.records.filter(r=>flagged.has(r.id)).length,done:c.done}))});
    for(const p of reply.problems)this.store.addError('读取',`模型回复里没有采纳的部分：${p}`);
   });
   return {ok:true};
  }catch(e){
   answered||=e?.answered===true;
   const names=chats.map(c=>c.name??'一个没有名称的聊天');
   this.store.addError('读取',`${names.slice(0,3).join('、')}${names.length>3?` 等 ${names.length} 个聊天`:''}在 ${day} 的消息这次没有读成，之后再读：${message(e)}`);
   return {ok:false,answered,error:message(e)};
  }
 }
}
