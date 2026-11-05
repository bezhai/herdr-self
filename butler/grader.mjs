// Grading: the model gives each active chat a level (see rules.mjs LEVELS) and one sentence of why, by 关于TA and my
// notes, on a model queue of its own (see model-queue.mjs and cli.mjs), so that a pass of many runs never holds up the
// batches, the review, 关于TA or the conversation. A chat is active when the store has messages of it from the last
// week, chats seen only through push included; an inactive chat is not graded. Nor is a chat whose level I set: the
// model never changes mine, and shown mine it would see my answer. What the model is shown of a chat: what butler knows
// of it (name, kind, members, whether I muted it), how busy it is and how much of it bots say, what I did there in the
// last month (my messages, @ of me, my reactions), its level and its latest messages, each cut short; and once per
// prompt 关于TA and my notes. Which level fits is the model's call alone: no rule here looks at keywords, senders or
// groups. When chats are due is dueAt's; the processor's process runs the grader beside the processor, on a timer of
// its own, and the command line grades chats when I ask.
import {clean,parse,DATA} from './prompt.mjs';
import {LEVELS} from './rules.mjs';
import {DEFAULTS as PROCESSOR,numbers,same} from './processor.mjs';

const DAY=86400e3;
// checkMs: how often the grader looks for chats that are due. retryMs: how long it waits after a pass that left chats
// ungraded (a run failed, or the answer left some out), so that a failing model is not asked every minute. sampleMs:
// how long butler must have kept every message before anything is graded (the first grading needs a sample of every
// chat); newChatMs: how old the first message of a chat seen since must be. activeMs: how recent a chat's messages
// make it active, and the window its activity is counted over; involvementMs: the window of what I did there.
// everyMs: how long a grading stands. notesDelayMs: how long my notes must stay as they are before the chats graded
// before they changed are graded again. burstMessages within burstMs: what a chat the model put at instant hands the
// batches before it is graded again at once, at most once per burstMs. sampleMessages: how many of a chat's latest
// messages the model is shown, each cut to textChars. maxPromptBytes: the processor's limit; a prompt holds as many
// chats as fit it, and no more than maxChats, so that no answer has to give that many reasons (a long answer risks
// herdr's 64 KiB cut and reasons written in haste).
export const DEFAULTS={checkMs:60_000,retryMs:600_000,sampleMs:2*DAY,newChatMs:DAY,activeMs:7*DAY,involvementMs:30*DAY,everyMs:7*DAY,notesDelayMs:3600e3,
 burstMessages:30,burstMs:3600e3,sampleMessages:30,textChars:100,maxPromptBytes:PROCESSOR.maxPromptBytes,maxChats:25};
const message=e=>e?.message??String(e);
const at=ms=>new Date(ms).toLocaleString('sv-SE').slice(0,16),short=ms=>at(ms).slice(5);
const isBot=r=>r.senderType==='bot'||r.senderType==='agent';

// One line: it travels as a command-line argument, and herdr refuses control characters there.
export function gradingSystemPrompt(me){
 return [
  `你替「${me}」给TA在飞书上的聊天分级：管家按级别决定怎么处理一个聊天的消息。`,
  '级别有四个。instant（即时）：这个聊天的每条消息都马上交给整理待办的模型，最费成本，适合常有要TA本人去做、回复或决定的事出现的聊天。daily（每日）：每天读一遍，挑出和TA的工作有关或者TA感兴趣的话题，适合有TA关心的讨论、但不用马上看的聊天。store（只存不看）：存下来但不读，以后回头找时能找到，适合和TA的工作和兴趣关系不大的聊天。ignore（忽略）：连存都不存，只用于纯粹的噪音，比如刷屏的广告或者和TA毫无关系的通知。',
  '和TA直接相关的消息（@TA、真人发给TA的私聊、回复TA的消息、TA参与的话题、TA自己发的）不管聊天是什么级别，都会交给整理待办的模型；所以只是偶尔 @TA 的聊天不需要定为即时，即时留给别的消息也常常要TA去做什么的聊天。',
  '你会收到一个 JSON：now 是现在的时间；profile 是管家根据TA自己发过的消息归纳的「关于TA」，可能不准，还没有写时是 null；notes 是TA自己写下的说明，是TA的原话，和「关于TA」不一致时以说明为准；chats 是要分级的聊天：chat 是这次的编号，name 是名称，kind 为 direct 是私聊、group 是群、topic 是话题群，members 是人数，muted 为 true 是TA设了免打扰（管家不知道时没有这两项），perDay 是最近一周平均每天的消息数（管家收下全部消息还不满一周时从那时算起），botShare 是其中机器人发的占百分之几，mine、mentions 和 reactions 是最近 30 天TA在这里发的消息数、被 @ 的次数和加的表情数，level 是它现在的级别（by 为 model 是你以前的判断；null 是还没有分级，这时私聊按即时、群按只存不看），messages 是最近的消息，从早到晚，sender 是发送者，bot 为 true 是机器人，mine 为 true 是TA自己发的，text 只有开头一段。',
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

// The model's answer: a level and a reason for each chat it graded, as far as the chat is one it was shown (refs), the
// level one of LEVELS and the reason given (links replaced); only a chat's first item counts. The rest is listed in
// problems, and so are the chats it left out. An answer that is not the asked-for object throws.
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
  grades.push({feedId:known.feedId,level:item.level,reason});
 }
 for(const [chat,known] of refs)if(!seen.has(chat))problems.push(`回复里没有 ${nameOf(known)}，下次再分`);
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

export class Grader{
 #timer;#passes=new Set();#halting=false;#most=Infinity;#start;
 // model: {ask({system, prompt}) → reply text, name}: the background queue in the processor's process, herdr itself
 // on the command line. now: the clock.
 constructor({store,matters,model,options={},now=Date.now,log=()=>{}}){
  Object.assign(this,{store,matters,model,options:{...DEFAULTS,...options},now,log});
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

 // Grades the chats that are due, unless a pass is under way or the last pass left chats ungraded less than retryMs
 // ago. Returns the pass, or undefined when none starts.
 check(){
  if(this.#passes.size||this.#halting)return undefined;
  this.#notes();
  const g=this.store.meta('grading');
  if(g?.graded<g?.chats&&this.now()-g.at<this.options.retryMs)return undefined;
  const {due}=this.plan();
  return due.length?this.#pass(due.map(c=>c.feedId)):undefined;
 }
 // Grades these chats (feed ids) now, or every active chat, leaving out those whose level I set; whatever else runs.
 // For the command line, and the conversation. Resolves as a pass does (see #grade).
 grade(feedIds){
  const ids=(feedIds??this.store.activity(this.now()-this.options.activeMs).map(c=>c.feedId)).filter(id=>this.store.level(id)?.by!=='owner');
  return ids.length?this.#pass(ids):Promise.resolve({runs:0,chats:0,graded:[],left:[]});
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
 #pass(ids){
  const pass=this.#grade(ids).finally(()=>this.#passes.delete(pass));
  this.#passes.add(pass);return pass;
 }
 // One pass over these chats, the busiest first, as many to a run as fit one prompt (see #part). A run that fails
 // ends the pass, except for a chat alone that got an answer which could not be used: it is left to the next pass and
 // this one goes on, unless the next run fails too, when the model is at fault. A failed run halves the parts after it
 // (down to one chat), so a chat the model cannot grade ends up alone; one that succeeds lets them grow again. The pass
 // is recorded (meta grading) unless a stop cut it short. Resolves with the runs, how many chats there were, those
 // graded ({feedId, before, after}, see Store.setLevel), those left (feed ids) and the last error.
 async #grade(ids){
  const now=this.now(),about={profile:this.store.meta('profile'),notes:this.matters.notes()},me=this.matters.me(),graded=[];
  let rest=this.#facts(ids,now),runs=0,error,aside=false;
  while(rest.length&&!this.#halting){
   const part=this.#part(rest,{me,about,now});runs+=1;
   const r=await this.#run(part);
   if(r.ok){graded.push(...r.graded);this.#most=Infinity;aside=false;rest=rest.slice(part.chats.length);continue;}
   error=r.error;this.#most=Math.max(1,Math.ceil(part.chats.length/2));
   if(r.answered&&part.chats.length===1&&!aside){aside=true;rest=rest.slice(1);continue;}
   break;
  }
  const done=new Set(graded.map(g=>g.feedId)),left=ids.filter(id=>!done.has(id));
  if(!this.#halting){
   this.store.setMeta('grading',{...this.store.meta('grading'),at:this.now(),chats:ids.length,graded:graded.length,error});
   this.log(`分级：${ids.length} 个聊天，分了 ${graded.length} 个，模型运行 ${runs} 次${error?`；${error}`:''}`);
  }
  return {runs,chats:ids.length,graded,left,error};
 }
 // What the model is shown of these chats, but for their messages (see #part): their activity since butler began
 // keeping every message, at most activeMs back, per day from then or from a chat's first message when that is later;
 // what I did there within involvementMs.
 #facts(ids,now){
  const o=this.options,from=Math.max(now-o.activeMs,this.#kept()??-Infinity),mine=this.store.involvement(now-o.involvementMs);
  const active=new Map(this.store.activity(now-o.activeMs,from).map(c=>[c.feedId,c]));
  return ids.map(feedId=>{
   const c=active.get(feedId)??this.#quiet(feedId),days=Math.max(1,(now-Math.max(from,c.firstAt??from))/DAY);
   return {...c,perDay:Math.round(c.messages/days*10)/10,botShare:c.messages?Math.round(100*c.bots/c.messages):undefined,...mine.get(feedId)??{mine:0,mentions:0,reactions:0}};
  });
 }
 // A chat I asked to grade that has said nothing within activeMs.
 #quiet(feedId){
  const c=this.store.chat(feedId);
  return {feedId,name:c?.name??undefined,kind:c?.chatMode??undefined,members:c?.memberCount??undefined,muted:c?.isMuted,messages:0,bots:0,level:this.store.level(feedId)};
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
 // One run, recorded in model_runs (kind grade; messages: how many it showed). What the answer grades is written as
 // the model's level (Store.setLevel leaves a level of mine as it is); what it leaves out is on record. answered: the
 // model gave an answer that could not be used, as opposed to none.
 async #run({chats,system,prompt,refs,messages}){
  let answered=false;
  try{
   const graded=await this.matters.recordRun({model:this.model,kind:'grade',messages,system,prompt,now:this.now},output=>{
    let reply;try{reply=readGrades(output,{refs});}catch(e){answered=true;throw e;}
    for(const p of reply.problems)this.store.addError('分级',`模型回复里没有采纳的部分：${p}`);
    return reply.grades.map(g=>({feedId:g.feedId,...this.store.setLevel(g.feedId,g.level,{by:'model',reason:g.reason,now:this.now()})}));
   });
   return {ok:true,graded};
  }catch(e){
   answered||=e?.answered===true;
   this.store.addError('分级',`${chats.length} 个聊天这次没有分级，之后再分：${message(e)}`);
   return {ok:false,answered,error:message(e)};
  }
 }
}
