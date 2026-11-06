// Grading: the model gives each active chat a level (see rules.mjs LEVELS) and one sentence of why, by 关于TA and my
// notes, on a timer of its own in the processor's process (see cli.mjs), so that a pass of many runs never holds up the
// batches, the review or 关于TA, nor waits for them. A chat is active when the store has messages of it from the last
// week, chats seen only through push included; an inactive chat is not graded. Nor is a chat whose level I set: the
// model never changes mine, and shown mine it would see my answer. What the model is shown of a chat: what butler knows
// of it (name, kind, members, whether I muted it), how busy it is and how much of it bots say, what I did there in the
// last month (my messages, @ of me, my reactions), its level and its latest messages, each cut short; and once per
// prompt 关于TA and my notes. Which level fits is the model's call alone: no rule here looks at keywords, senders or
// groups. When chats are due is dueAt's; the processor's process runs the grader beside the processor, on a timer of
// its own, and the command line grades chats when I ask.
// The exam: the chats whose level I set (the bank of corrections) are graded again as a pass would grade them, but
// shown as ungraded, and each answer is compared with my level; the share right tells whether 关于TA has learnt what
// I meant, and the wrong answers go into the next 关于TA (see profile.mjs). It runs on the same timer, one pass or exam
// at a time, after a new 关于TA or a change of my notes (see #examDue).
import {clean,parse,DATA,PROFILE} from './prompt.mjs';
import {LEVELS} from './rules.mjs';
import {DEFAULTS as PROCESSOR,numbers,same} from './processor.mjs';

const DAY=86400e3;
// checkMs: how often the grader looks for chats that are due. retryMs: how long it waits after a pass that left chats
// ungraded (a run failed, or the answer left some out), so that a failing model is not asked every minute. sampleMs:
// how long butler must have kept every message before anything is graded (the first grading needs a sample of every
// chat); newChatMs: how old the first message of a chat seen since must be. activeMs: how recent a chat's messages
// make it active, and the window its activity is counted over; involvementMs: the window of what I did there; both
// the processor's, which 关于TA is written with (see processor.mjs).
// everyMs: how long a grading stands. notesDelayMs: how long my notes must stay as they are before the chats graded
// before they changed are graded again. burstMessages within burstMs: what a chat the model put at instant hands the
// batches before it is graded again at once, at most once per burstMs. sampleMessages: how many of a chat's latest
// messages the model is shown, each cut to textChars. maxPromptBytes: the processor's limit; a prompt holds as many
// chats as fit it, and no more than maxChats, so that no answer has to give that many reasons (a long answer risks
// herdr's 64 KiB cut and reasons written in haste). examMs: how long after an exam, or one that failed, the next may
// start at the earliest.
export const DEFAULTS={checkMs:60_000,retryMs:600_000,sampleMs:2*DAY,newChatMs:DAY,activeMs:PROCESSOR.activeMs,involvementMs:PROCESSOR.involvementMs,everyMs:7*DAY,notesDelayMs:3600e3,
 burstMessages:30,burstMs:3600e3,sampleMessages:30,textChars:100,maxPromptBytes:PROCESSOR.maxPromptBytes,maxChats:25,examMs:3600e3};
const message=e=>e?.message??String(e);
const at=ms=>new Date(ms).toLocaleString('sv-SE').slice(0,16),short=ms=>at(ms).slice(5);
const isBot=r=>r.senderType==='bot'||r.senderType==='agent';

// One line: it travels as a command-line argument, and herdr refuses control characters there.
export function gradingSystemPrompt(me){
 return [
  `你替「${me}」给TA在飞书上的聊天分级：管家按级别决定怎么处理一个聊天的消息。`,
  '级别有四个。instant（即时）：这个聊天的每条消息都马上交给整理待办的模型，每天也读一遍、挑出话题，最费成本，适合常有要TA本人去做、回复或决定的事出现的聊天。daily（每日）：每天读一遍，挑出和TA的工作有关或者TA感兴趣的话题，读到的可能要TA去做的事交给整理待办的模型，适合有TA关心的讨论、但不用马上看的聊天。store（只存不看）：存下来但不读，以后回头找时能找到，适合和TA的工作和兴趣关系不大的聊天。ignore（忽略）：连存都不存，只用于纯粹的噪音，比如刷屏的广告或者和TA毫无关系的通知。',
  '和TA直接相关的消息（@TA、真人发给TA的私聊、回复TA的消息、TA参与的话题、TA自己发的）不管聊天是什么级别，都会交给整理待办的模型；所以只是偶尔 @TA 的聊天不需要定为即时，即时留给别的消息也常常要TA去做什么的聊天。',
  `你会收到一个 JSON：now 是现在的时间；${PROFILE}；notes 是TA自己写下的说明，是TA的原话，和「关于TA」不一致时以说明为准；chats 是要分级的聊天：chat 是这次的编号，name 是名称，kind 为 direct 是私聊、group 是群、topic 是话题群，members 是人数，muted 为 true 是TA设了免打扰（管家不知道时没有这两项），perDay 是最近一周平均每天的消息数（管家收下全部消息还不满一周时从那时算起），botShare 是其中机器人发的占百分之几，mine、mentions 和 reactions 是最近 30 天TA在这里发的消息数、被 @ 的次数和加的表情数，level 是它现在的级别（by 为 model 是你以前的判断；null 是还没有分级，这时私聊按即时、群按只存不看），messages 是最近的消息，从早到晚，sender 是发送者，bot 为 true 是机器人，mine 为 true 是TA自己发的，text 只有开头一段。`,
  '每个聊天该是什么级别，由你按「关于TA」、说明和这些事实判断。',
  DATA,
  '只输出一个 JSON 对象，不要输出任何别的文字：{"chats":[{"chat":"c1","level":"instant、daily、store 或 ignore","reason":"一句话"}]}，给你的每个聊天写一项。reason 是写给TA看的一句平常的中文：这是个什么聊天、为什么是这个级别；不要写编号，也不要写链接。',
 ].join(' ');
}

// chats: what the model is shown of each (see Grader #facts): feedId, name, kind, members, muted, perDay, botShare,
// mine, mentions, reactions, level (the store's) and records (its latest messages, oldest first). about: 关于TA (the
// meta profile) and my notes. Every chat goes under an id of this prompt (c1, c2, …), never its feed id. Returns the
// prompt, how many messages it shows, and what each id stands for ({feedId, name}).
export function composeGrading({now,me,about:{profile,notes=[]}={},chats,textChars=DEFAULTS.textChars}){
 const refs=new Map(),cut=text=>{const t=text.replace(/\s+/g,' ').trim();return t.length>textChars?`${t.slice(0,textChars)}…`:t;};
 const shown=r=>({time:short(r.createdAt),sender:r.senderName??r.senderId,...isBot(r)&&{bot:true},...r.isMine&&{mine:true},text:cut(r.text)});
 const list=chats.map((c,i)=>{
  const chat=`c${i+1}`;refs.set(chat,{feedId:c.feedId,name:c.name});
  return {chat,name:c.name,kind:c.kind,members:c.members,muted:c.muted,perDay:c.perDay,botShare:c.botShare,mine:c.mine,mentions:c.mentions,reactions:c.reactions,
   level:c.level?.level??null,by:c.level?.by,messages:c.records.map(shown)};
 });
 const data={now:at(now),profile:profile?.text??null,notes:notes.map(n=>n.text),chats:list};
 return {system:gradingSystemPrompt(me),prompt:`以下是这次要分级的聊天：\n${JSON.stringify(data)}`,refs,messages:chats.reduce((n,c)=>n+c.records.length,0)};
}

// The model's answer: a level and a reason for each chat it graded ({feedId, name, level, reason}), as far as the chat
// is one it was shown (refs), the level one of LEVELS and the reason given (links replaced); only a chat's first item
// counts. The rest is listed in problems, and so are the chats it left out. An answer that is not the asked-for object
// throws.
const REASON=200;
export function readGrades(text,{refs}){
 const v=parse(text);
 if(!v||typeof v!=='object'||Array.isArray(v)||!Array.isArray(v.chats))throw Error(`模型的回复缺少 chats：${String(text).slice(0,200)}`);
 const grades=[],problems=[],seen=new Set(),nameOf=known=>known.name??'一个没有名称的聊天';
 for(const item of v.chats){
  const chat=String(item?.chat??''),known=refs.get(chat);
  if(!known){problems.push(`分级引用了不存在的聊天 ${chat.slice(0,40)}`);continue;}
  if(seen.has(chat)){problems.push(`${nameOf(known)} 分了不止一次，只看第一次`);continue;}
  seen.add(chat);
  if(!LEVELS.includes(item.level)){problems.push(`${nameOf(known)} 的级别 ${String(item.level).slice(0,40)} 不认识，没有采纳`);continue;}
  const reason=clean(item.reason,REASON);if(!reason){problems.push(`${nameOf(known)} 没有写理由，没有采纳`);continue;}
  grades.push({feedId:known.feedId,name:known.name,level:item.level,reason});
 }
 for(const [chat,known] of refs)if(!seen.has(chat))problems.push(`回复里没有 ${nameOf(known)}`);
 return {grades,problems};
}

// When a chat (see Store.activity) is due to be graded, in ms; Infinity when no rule makes it due. Nothing is before
// butler has kept every message for sampleMs (start: since when; undefined: not yet), and a chat whose level I set
// never is. Then a chat with no level is once its first message is newChatMs old; a graded one everyMs after the
// model last graded it, notesDelayMs after my notes last changed (notesAt) when it was graded before that, and at once
// when the model put it at instant, last graded it more than burstMs ago, and it has handed the batches burstMessages
// within burstMs (batched: by chat).
export function dueAt(chat,{now,start,notesAt,batched,options:o}){
 const l=chat.level;
 if(start===undefined||l?.by==='owner')return Infinity;
 const sampled=start+o.sampleMs;
 if(!l)return Math.max(sampled,chat.firstAt+o.newChatMs);
 const last=l.modelAt??0,burst=l.level==='instant'&&last<=now-o.burstMs&&(batched.get(chat.feedId)??0)>=o.burstMessages;
 return Math.max(sampled,Math.min(last+o.everyMs,notesAt>last?notesAt+o.notesDelayMs:Infinity,burst?now:Infinity));
}

// What a grading run and an exam run say of answers they could not use in full, and of a run that failed.
const SAYS={grade:{problem:'模型回复里没有采纳的部分：',failed:'这次没有分级，之后再分'},exam:{problem:'重做纠正题时模型回复里没有采纳的部分，这个聊天算作做错：',failed:'的纠正题这次没有重做完，之后再做'}};

export class Grader{
 #timer;#passes=new Set();#halting=false;#most=Infinity;#start;
 // model: {ask({system, prompt}) → reply text, name}: herdr (see herdr-model.mjs), each run a claude of its own beside
 // the processor's. now: the clock. onPass({at, by, changed, graded, failed}): called after each pass that graded
 // a chat: by says how the pass started, schedule for one check started (the chats that were due), request for one I
 // asked for (grade, from the command line); changed lists the chats whose level from the model
 // changed ({feedId, name, before: the model's level before, undefined when it had none, after, reason}); graded and
 // failed: how many chats it graded and how many it left. What it throws or rejects with is recorded and changes nothing
 // else.
 constructor({store,matters,model,options={},now=Date.now,log=()=>{},onPass=()=>{}}){
  Object.assign(this,{store,matters,model,options:{...DEFAULTS,...options},now,log,onPass});
 }
 // Looks for chats that are due now and every checkMs; what goes wrong is recorded.
 start(){
  this.#halting=false;
  const failed=e=>this.store.addError('分级',`查看要分级的聊天时出错：${message(e)}`);
  const tick=()=>{try{this.check()?.catch(failed);}catch(e){failed(e);}};
  this.#timer=setInterval(tick,this.options.checkMs);tick();
 }
 // No further run starts; waits for the one under way.
 async stop(){this.#halting=true;clearInterval(this.#timer);await Promise.allSettled([...this.#passes]);}

 // Grades the chats that are due, unless the last pass left chats ungraded less than retryMs ago; with none to grade,
 // takes an exam if one is due (see #examDue): grading decides what the batches take, the exam only measures. Nothing
 // starts while a pass or an exam is under way. Returns the pass or the exam, or undefined when none starts.
 check(){
  if(this.#passes.size||this.#halting)return undefined;
  this.#notes();
  const g=this.store.meta('grading'),due=g?.graded<g?.chats&&this.now()-g.at<this.options.retryMs?[]:this.plan().due;
  if(due.length)return this.#pass(due.map(c=>c.feedId),'schedule');
  const exam=this.#examDue();
  return exam?this.#track(this.#exam(exam)):undefined;
 }
 // Grades these chats (feed ids) now, or every active chat, leaving out those whose level I set; whatever else runs.
 // For the command line. Resolves as a pass does (see #grade).
 grade(feedIds){
  const ids=(feedIds??this.store.activity(this.now()-this.options.activeMs).map(c=>c.feedId)).filter(id=>this.store.level(id)?.by!=='owner');
  return ids.length?this.#pass(ids,'request'):Promise.resolve({runs:0,chats:0,graded:[],left:[]});
 }
 // The active chats due now, the busiest first, and when the next one is due when none is now (see dueAt).
 plan(){
  const now=this.now(),o=this.options,start=this.#kept(),notesAt=this.store.meta('grading')?.notesAt,batched=this.matters.batchedByChat(now-o.burstMs);
  const chats=this.store.activity(now-o.activeMs).map(c=>({...c,dueAt:dueAt(c,{now,start,notesAt,batched,options:o})}));
  const later=chats.map(c=>c.dueAt).filter(t=>t>now&&t<Infinity);
  return {due:chats.filter(c=>c.dueAt<=now),next:later.length?Math.min(...later):undefined};
 }
 // What status shows: the last pass (meta grading: at, how many chats, how many graded, the error if a run failed),
 // how many chats have a level from the model, how many are due, when the next pass is (now, or after the wait that
 // follows a pass that left chats ungraded, or when the next chat is due) and when grading can first begin (sampledAt).
 status(){
  const g=this.store.meta('grading')??{},{due,next}=this.plan(),start=this.#kept(),now=this.now();
  return {...g,due:due.length,next:due.length?Math.max(now,g.graded<g.chats?g.at+this.options.retryMs:now):next,
   sampledAt:start===undefined?undefined:start+this.options.sampleMs,byModel:this.store.levels().filter(l=>l.modelLevel!=null).length};
 }

 // When butler began keeping every message (see Store.keptSince), asked until that is sampleMs ago: from then on it
 // decides nothing, and asking reads every stored message's category.
 #kept(){if(this.#start===undefined||this.now()-this.#start<this.options.sampleMs)this.#start=this.store.keptSince();return this.#start;}
 // My notes as the grader last saw them (meta grading notes, by their numbers) and when they last changed (notesAt).
 // The first look only takes them in: what is graded from then on is graded with them.
 #notes(){
  const g=this.store.meta('grading')??{},notes=numbers(this.matters.notes());
  if(g.notes===undefined||!same(g.notes,notes))this.store.setMeta('grading',{...g,notes,...g.notes&&{notesAt:this.now()}});
 }
 // by: how the pass started (see onPass).
 #pass(ids,by){return this.#track(this.#grade(ids,by));}
 // A pass or an exam under way, for check and stop.
 #track(run){
  const p=run.finally(()=>this.#passes.delete(p));
  this.#passes.add(p);return p;
 }
 // What every run of a pass or an exam is shown besides the chats: 关于TA and my notes, as they are when it starts.
 #about(){return {profile:this.store.meta('profile'),notes:this.matters.notes()};}
 // One pass over these chats, the busiest first (see #walk); what an answer grades is written as the model's level (Store.setLevel leaves
 // a level of mine as it is). The pass is recorded (meta grading) unless a stop cut it short, and whoever shows grading
 // is told what changed (onPass). Resolves with the runs, how many chats there were, those graded ({feedId, name,
 // before, after}, see Store.setLevel), those left (feed ids) and the last error.
 async #grade(ids,by){
  const now=this.now(),write=grades=>grades.map(g=>({feedId:g.feedId,name:g.name,...this.store.setLevel(g.feedId,g.level,{by:'model',reason:g.reason,now:this.now()})}));
  const {runs,done:graded,error}=await this.#walk(this.#facts(ids,now),{kind:'grade',about:this.#about(),now,use:write});
  const done=new Set(graded.map(g=>g.feedId)),left=ids.filter(id=>!done.has(id));
  if(!this.#halting){
   this.store.setMeta('grading',{...this.store.meta('grading'),at:this.now(),chats:ids.length,graded:graded.length,error});
   this.log(`分级：${ids.length} 个聊天，分了 ${graded.length} 个，模型运行 ${runs} 次${error?`；${error}`:''}`);
  }
  if(graded.length){
   const changed=graded.filter(g=>(g.before?.modelLevel??undefined)!==g.after.modelLevel)
    .map(g=>({feedId:g.feedId,name:g.name,before:g.before?.modelLevel??undefined,after:g.after.modelLevel,reason:g.after.modelReason}));
   this.#tell(()=>this.onPass({at:now,by,changed,graded:graded.length,failed:left.length}));
  }
  return {runs,chats:ids.length,graded,left,error};
 }
 // Chats through the model in the order given, as many to a run as fit one prompt (see #part); use(grades) takes the
 // grades of each answer (see readGrades) and returns what it made of them. A run that fails ends the walk, except for
 // a chat alone that got an answer which could not be used: it is left out and the walk goes on, unless the next run
 // fails too, when the model is at fault. A failed run halves the parts after it (down to one chat), so a chat the
 // model cannot grade ends up alone; one that succeeds lets them grow again. Resolves with the runs, what use made of
 // the answers, the last error, and whether no chat is left that a stop or a failure kept from the model (complete).
 async #walk(chats,{kind,about,now,use}){
  const me=this.matters.me(),done=[];
  let rest=chats,runs=0,error,aside=false;
  while(rest.length&&!this.#halting){
   const part=this.#part(rest,{me,about,now});runs+=1;
   const r=await this.#run(part,{kind,use});
   if(r.ok){done.push(...r.done);this.#most=Infinity;aside=false;rest=rest.slice(part.chats.length);continue;}
   error=r.error;this.#most=Math.max(1,Math.ceil(part.chats.length/2));
   if(r.answered&&part.chats.length===1&&!aside){aside=true;rest=rest.slice(1);continue;}
   break;
  }
  return {runs,done,error,complete:!rest.length};
 }
 // What the model is shown of these chats, but for their messages (see #part, and Matters.chatFacts): their activity
 // since butler began keeping every message, at most activeMs back, per day from then or from a chat's first message
 // when that is later; what I did there within involvementMs.
 #facts(ids,now){
  const o=this.options;
  return this.matters.chatFacts(ids,{now,since:now-o.activeMs,from:Math.max(now-o.activeMs,this.#kept()??-Infinity),mineSince:now-o.involvementMs});
 }

 // An exam is due when 关于TA has been written since the last one or my notes have changed since, and then only when
 // 关于TA (its text), my notes or the bank (the chats whose level I set, and my levels) are not what the last one was
 // taken with: a 关于TA written again the same, with nothing else new, tests nothing new, and a level I set waits for
 // the next 关于TA, which learns from it. It waits until 关于TA has caught up with my notes (the processor writes it
 // again when they change), and never comes before grading can begin (sampleMs), before any 关于TA has been written
 // (there is nothing to test), with no level of mine, or within examMs of the last exam or of one that failed.
 // Returns what it would be taken with, or undefined. The meta exam: {at, profileAt, profile (its text), notes (their
 // numbers), bank (feed id=level, sorted)} of the last one taken, and {failedAt, error} of a failure since.
 #examDue(){
  const o=this.options,now=this.now(),start=this.#kept();
  if(start===undefined||now<start+o.sampleMs)return undefined;
  const bank=this.store.levels().filter(l=>l.by==='owner');if(!bank.length)return undefined;
  const about=this.#about(),notes=numbers(about.notes),profile=about.profile?.text,e=this.store.meta('exam'),last=e?.at===undefined?undefined:e;
  if(about.profile?.at===undefined||!same(about.profile.notes,notes)||now-Math.max(e?.at??-Infinity,e?.failedAt??-Infinity)<o.examMs)return undefined;
  const taken={profileAt:about.profile.at,profile,notes,bank:bank.map(l=>`${l.feedId}=${l.level}`).sort()};
  const due=!last||!same(last.notes,notes)||last.profileAt!==taken.profileAt&&(last.profile!==profile||!same(last.bank,taken.bank));
  return due?{chats:bank,about,taken}:undefined;
 }
 // The exam: the chats of the bank (Store.levels), graded as a pass grades them (see #walk) but each shown as ungraded,
 // so that the model never sees my level; its answers change no level. Each is then compared with my level: a chat the
 // answer left out, gave no usable level or that was set aside counts as wrong, with no answer. Recorded in the exams
 // (Matters.addExam) and in model_runs (kind exam); one that fails is not, and goes again examMs later; one a stop cut
 // short goes again at the next check.
 async #exam({chats,about,taken}){
  const now=this.now();
  const r=await this.#walk(this.#facts(chats.map(l=>l.feedId),now).map(c=>({...c,level:undefined})),{kind:'exam',about,now,use:grades=>grades});
  if(!r.complete){if(!this.#halting)this.store.setMeta('exam',{...this.store.meta('exam'),failedAt:now,error:r.error});return r;}
  const answers=new Map(r.done.map(g=>[g.feedId,g]));
  this.matters.addExam({at:now,answers:chats.map(l=>({feedId:l.feedId,name:l.name??answers.get(l.feedId)?.name,owner:l.level,model:answers.get(l.feedId)?.level,reason:answers.get(l.feedId)?.reason}))});
  this.store.setMeta('exam',{at:now,...taken});
  const correct=chats.filter(l=>answers.get(l.feedId)?.level===l.level).length;
  this.log(`重做纠正题：${chats.length} 题，做对 ${correct} 题，模型运行 ${r.runs} 次`);
  return {...r,total:chats.length,correct};
 }
 // The next part: as many chats from the front of rest as fit maxPromptBytes, and no more than maxChats or the last
 // failure left (#most); a chat alone that does not fit keeps the newer half of its messages, down to none. A chat's latest
 // messages (ignored senders left out, as everywhere the model is shown messages) are read when it is first composed.
 #part(rest,{me,about,now}){
  const o=this.options,most=Math.min(rest.length,o.maxChats,this.#most),fits=p=>Buffer.byteLength(p.prompt)<=o.maxPromptBytes;
  const compose=list=>{for(const c of list)c.records??=this.matters.before(c.feedId,now+1,o.sampleMessages);return composeGrading({now,me,about,chats:list,textChars:o.textChars});};
  let n=1,part=compose(rest.slice(0,1));
  for(let next;n<most&&fits(next=compose(rest.slice(0,n+1)));n++)part=next;
  for(let one=rest[0];n===1&&!fits(part)&&one.records.length;part=compose([one]))one={...one,records:one.records.slice(Math.ceil(one.records.length/2))};
  return {chats:rest.slice(0,n),...part};
 }
 // One run, recorded in model_runs (kind: grade or exam; messages: how many it showed); use(grades) takes what the
 // answer grades, and what it leaves out is on record. answered: the model gave an answer that could not be used, as
 // opposed to none.
 async #run({chats,system,prompt,refs,messages},{kind,use}){
  let answered=false;
  try{
   const done=await this.matters.recordRun({model:this.model,kind,messages,system,prompt,now:this.now},output=>{
    let reply;try{reply=readGrades(output,{refs});}catch(e){answered=true;throw e;}
    for(const p of reply.problems)this.store.addError('分级',`${SAYS[kind].problem}${p}`);
    return use(reply.grades);
   });
   return {ok:true,done};
  }catch(e){
   answered||=e?.answered===true;
   this.store.addError('分级',`${chats.length} 个聊天${SAYS[kind].failed}：${message(e)}`);
   return {ok:false,answered,error:message(e)};
  }
 }
 // Calls onPass; what it throws or rejects with is recorded.
 #tell(hook){
  const failed=e=>this.store.addError('分级',`分级有变化，但通知出错：${message(e)}`);
  try{Promise.resolve(hook()).catch(failed);}catch(e){failed(e);}
 }
}
