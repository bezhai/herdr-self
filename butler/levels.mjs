// The level cards in my direct chat with the bot, and how butler words a level. The level list shows every chat's
// level and reason, a folded panel per level: it goes out once after the first scheduled grading pass that graded
// chats. The weekly card shows what the model changed in the week (and the chats it graded for the first time), each
// chat with a ⋯ to set my own level, how many corrections I made that week and how the model did when it last re-took
// my corrections (the exams, see grader.mjs): it goes out at the first slot of the week, only when the model changed
// something. The last is a short card of what the model newly inferred about me when it wrote 关于TA, so that I can
// correct it. Names and reasons come from the chats and the model: always plain text.
import {LEVELS,LEVEL_NAMES,ungradedLevel} from './rules.mjs';
import {weekSlot} from './schedule.mjs';
import {DEFAULTS as GRADING} from './grader.mjs';
import {cards,plain,lines,panel,paged,AGENT_GROUP} from './cards.mjs';

const GREY={text_size:'notation',text_color:'grey'};
const day=ms=>new Date(ms).toLocaleString('sv-SE').slice(5,10);
const message=e=>e?.message??String(e);
// A chat's level as butler words it (see Store.level), mine marked as set by who (你 on a card, 我 on the command
// line); a chat without one, with the level it goes by until it is graded (see rules.mjs ungradedLevel).
export const levelName=(l,chatMode,who='你')=>l?`${LEVEL_NAMES[l.level]}${l.by==='owner'?`（${who}定的）`:''}`:`未分级（按${LEVEL_NAMES[ungradedLevel(chatMode)]}）`;
// What a level I set does from then on.
export const LEVEL_EFFECT={instant:'它的全部消息交给模型',daily:'存下它的消息，每日的整理还没有做，现在和只存不看一样',store:'存下它的消息，不交给模型',ignore:'不再存它的消息'};
// A correction (see Store.levelChanges): I set a level, and it changed the chat's. Confirming the level a chat has, or
// clearing mine, is none.
export const isCorrection=c=>c.by==='owner'&&c.after?.by==='owner'&&c.before?.level!==c.after.level;
const unnamed='（名称未知的聊天）';

// ---- the level list
// A level's lines go in panels of about this many bytes, so that a level with hundreds of chats goes on over cards.
const PANEL_BYTES=12_000;
// The level list as of at: every chat with a level (see Store.levels), a folded panel per level, instant first, each
// chat a line with its name and reason, mine marked; then the chats with messages in the last activeMs that have no
// level yet. A level whose lines fill more than one panel goes on in numbered parts. In as few cards as hold it.
export function levelListCards(store,{at,activeMs=GRADING.activeMs}){
 const all=store.levels(),graded=new Set(all.map(l=>l.feedId));
 const groups=[...LEVELS.map(level=>[LEVEL_NAMES[level],all.filter(l=>l.level===level).map(l=>`${l.name||unnamed}${l.by==='owner'?'（你定的）':''}${l.reason?` — ${l.reason}`:''}`)]),
  ['还没有分级',store.activity(at-activeMs).filter(c=>!graded.has(c.feedId)).map(c=>`${c.name||unnamed}（按${LEVEL_NAMES[ungradedLevel(c.kind)]}）`)]].filter(([,rows])=>rows.length);
 const elements=[plain(`你定的级别模型不改。想改哪个、问哪个为什么是这个级别，到 ${AGENT_GROUP}里说。`,GREY)];
 for(const [name,rows] of groups){
  const parts=[[]];let used=0;
  for(const row of rows){const n=Buffer.byteLength(row)+1;if(parts.at(-1).length&&used+n>PANEL_BYTES){parts.push([]);used=0;}parts.at(-1).push(row);used+=n;}
  parts.forEach((part,i)=>elements.push(panel(`${name} ${rows.length} 个${parts.length>1?`（${i+1}/${parts.length}）`:''}`,lines(part))));
 }
 return cards(elements,{title:'聊天的分级',summary:groups.map(([name,rows])=>`${name} ${rows.length}`).join(' · ')||'还没有聊天有级别'});
}

// ---- the weekly card
// What the model changed from from up to to (see Store.levelChanges): each chat whose level it changed, from its
// level before the first change to its level after the last, the reason with that; a chat it graded for the first time
// has none before. A chat whose level ends where it began is no change. Those it graded for the first time at or before
// listed (when the level list went out) were in that list and are left out. Changes first, then the first gradings, each
// in the order the model made them. corrections: how many corrections I made then.
export function weekChanges(store,{from,to,listed}){
 const all=store.levelChanges(from,to),byChat=new Map();
 for(const c of all)if(c.by==='model'){const first=byChat.get(c.feedId);byChat.set(c.feedId,first?{...c,before:first.before,at:first.at}:c);}
 const changes=[...byChat.values()].filter(c=>c.before?c.before.level!==c.after?.level:!(c.at<=listed));
 return {changed:changes.filter(c=>c.before),first:changes.filter(c=>!c.before),corrections:all.filter(isCorrection).length};
}
// At most this many chats are listed, twelve to a card: Feishu takes 200 components a card, and a row has twelve.
const WEEK_LISTED=36,WEEK_ROWS=12;
// One chat on the weekly card: its name; in grey its level before and after the model's change, mine if I have set one
// since, and the model's reason; and a ⋯ with the four levels, the one it has marked, which sends back the level
// chosen (the option), the chat and what value says of the card.
function changeRow(c,{level,value}){
 const facts=[`${levelName(c.before,c.chatMode)} → ${LEVEL_NAMES[c.after.level]}`,...level?.by==='owner'?[`你已定为${LEVEL_NAMES[level.level]}`]:[],...c.reason?[c.reason]:[]];
 return {tag:'column_set',horizontal_spacing:'8px',columns:[
  {tag:'column',width:'weighted',weight:1,vertical_spacing:'4px',elements:[plain(c.name||unnamed),plain(facts.join(' · '),GREY)]},
  {tag:'column',width:'auto',elements:[{tag:'overflow',
   options:LEVELS.map(l=>({text:{tag:'plain_text',content:`${LEVEL_NAMES[l]}${level?.level===l?'（现在）':''}`},value:l})),behaviors:[{type:'callback',value:{...value,chat:c.feedId}}]}]}]};
}
// The card for some of the week's chats (rows), made at at. Its ⋯ send back which week (from, to, listed) and which
// chats the card shows (ids), so that a choice can make it again as it is then (see LevelCards.click); and when it was
// made, as the SDK drops a click it has seen on a message for 12 hours, by its value.
function weekCard(store,rows,{from,to,listed,at,week,exam}){
 const value={act:'level',card:'week',from,to,...listed!==undefined&&{listed},ids:rows.map(c=>c.feedId),t:at},n=week.changed.length,m=week.first.length;
 const said=[`这一周模型改了 ${n} 个聊天的级别，第一次分了 ${m} 个`,week.corrections?`你纠正了 ${week.corrections} 次分级`:'你没有纠正分级',
  ...exam?.total?[`上次重做纠正题（${day(exam.at)}）做对了 ${exam.correct}/${exam.total}（${Math.round(100*exam.correct/exam.total)}%）`]:[]];
 return {schema:'2.0',config:{update_multi:true,summary:{content:`模型改了 ${n} 个聊天的级别，第一次分了 ${m} 个`}},
  header:{title:{tag:'plain_text',content:`分级变化（${day(from)} 至 ${day(to)}）`},template:'blue'},
  body:{vertical_spacing:'12px',elements:[plain(`${said.join('；')}。`,GREY),
   plain(`点右边的 ⋯ 选一个级别，就改成你定的，模型以后不改它。${n+m>WEEK_LISTED?`只列出了 ${WEEK_LISTED} 个，其余的到 ${AGENT_GROUP}里问管家。`:''}`,GREY),
   ...rows.map(c=>changeRow(c,{level:store.level(c.feedId),value}))]}};
}
// The weekly card for the week from from up to to, made at at, in cards of up to twelve chats; none when the model
// changed nothing. ids: only these chats, in this order, for a card made again. exams(limit): the latest re-takes of
// my corrections, the newest first ({at, total, correct}); the card shows the latest before the week ended.
export function weekCards(store,{from,to,listed,at,exams,ids}){
 const week=weekChanges(store,{from,to,listed}),all=[...week.changed,...week.first];
 const rows=ids?ids.map(id=>all.find(c=>c.feedId===id)).filter(Boolean):all.slice(0,WEEK_LISTED);
 const exam=exams(10).find(e=>e.at<to),make=list=>weekCard(store,list,{from,to,listed,at,week,exam});
 return ids?[make(rows)]:paged(rows,make,WEEK_ROWS);
}

// ---- what the model newly inferred about me
export const inferredCards=added=>cards([plain('写「关于TA」时，模型从你的消息和纠正里新推断出这些：'),...lines(added.map(x=>`· ${x}`)),
 plain(`不对的话，到 ${AGENT_GROUP}里告诉管家，它会记成说明，以后以你的话为准。`,GREY)],{title:'关于你的新推断',summary:`模型新推断了 ${added.length} 条关于你的内容`});

export class LevelCards{
 #timer;#ticking;#stopped=false;
 // bot: {connected, toOwner(input) → {messageId}}; schedule: the digest schedule, whose weekly slot (see schedule.mjs
 // weekSlot) the weekly card goes out at; exams(limit): see weekCards; now: the clock; retryMs: how long after a
 // failed send to try again.
 constructor({store,bot,schedule,exams=()=>[],now=Date.now,everyMs=60_000,retryMs=300_000}){
  Object.assign(this,{store,bot,schedule,exams,now,everyMs,retryMs});
 }
 start(){this.#stopped=false;this.#timer=setInterval(()=>this.tick(),this.everyMs);this.tick();}
 async stop(){this.#stopped=true;clearInterval(this.#timer);await this.#ticking;}
 // Sends what is due: the level list once the first pass has graded chats, the weekly card once its slot has come.
 // Ticks never overlap: a call during one joins it. Never rejects: a failure is recorded, and tried again retryMs later.
 tick(){this.#ticking??=this.#tick().catch(e=>this.store.addError('分级',`发分级的卡片时出错：${message(e)}`)).finally(()=>{this.#ticking=undefined;});return this.#ticking;}
 // The grader's onPass, after a pass that graded chats ({at, by, changed, graded, failed}): after the first scheduled
 // one (by schedule), the level list is due. A pass I asked for (by request) does not count: graded before the first
 // full pass, one or two chats would make a list of those alone, and the full one would never go out. The list waits
 // for the bot to be connected, so that it is not lost.
 passed({by}={}){
  const m=this.store.meta('levelCards')??{};
  if(by==='schedule'&&m.listAt===undefined&&!m.listDue)this.store.setMeta('levelCards',{...m,listDue:true});
  return this.tick();
 }
 // The processor's onProfile, after 关于TA was written ({text, added, at}): what the model newly inferred (added), if
 // anything, goes to me. Never rejects: a failed send is recorded and not repeated, the next 关于TA brings its own.
 async inferred({added}={}){
  if(!Array.isArray(added)||!added.length)return;
  try{for(const card of inferredCards(added.map(String)))await this.bot.toOwner({card});}
  catch(e){this.store.addError('分级',`「关于TA」的新推断没有发给你：${message(e)}`);}
 }
 // A choice on a weekly card's ⋯ (a CardActionEvent; the bot hands on only mine, see bot.mjs): the chosen level becomes
 // mine for that chat, recorded as any level I set (see Store.setLevel). Feishu wants an answer within 3 seconds: a toast,
 // and the card made again as things are now. undefined for a click that is not such a choice.
 click({action}={}){
  const v=action?.value,level=action?.option;
  if(!v||typeof v!=='object'||v.act!=='level'||v.card!=='week'||!LEVELS.includes(level)||!Array.isArray(v.ids)||!v.ids.includes(v.chat))return undefined;
  const now=this.now(),was=this.store.level(v.chat),chat=this.store.chat(v.chat),name=chat?.name||unnamed;
  let toast;
  if(was?.by==='owner'&&was.level===level)toast={type:'info',content:`${name} 已经是你定的${LEVEL_NAMES[level]}`};
  else{const {before,after}=this.store.setLevel(v.chat,level,{by:'owner',now});toast={type:'success',content:`${name}：${levelName(before,chat?.chatMode)} → ${levelName(after,chat?.chatMode)}`};}
  const [card]=weekCards(this.store,{from:Number(v.from),to:Number(v.to),listed:v.listed,at:now,exams:this.exams,ids:v.ids.map(String)});
  return {toast,card:{type:'raw',data:card}};
 }

 async #tick(){
  if(this.#stopped||!this.bot.connected)return;
  const now=this.now(),m=this.store.meta('levelCards')??{};
  if(now-m.failedAt<this.retryMs)return;
  if(m.listDue){
   if(!await this.#send(levelListCards(this.store,{at:now}),'聊天的分级'))return;
   this.store.setMeta('levelCards',{...this.store.meta('levelCards'),listDue:undefined,listAt:now});
  }
  const slot=weekSlot(now,this.schedule),last=this.store.meta('levelCards')??{};
  if(last.weekSlot>=slot)return;
  const sent=await this.#send(weekCards(this.store,{from:weekSlot(slot-1,this.schedule),to:slot,listed:last.listAt,at:now,exams:this.exams}),'分级变化');
  if(sent)this.store.setMeta('levelCards',{...this.store.meta('levelCards'),weekSlot:slot,...sent.length&&{weekAt:now}});
 }
 // Sends these cards; resolves with them, or undefined when the first could not be sent (it is tried again retryMs
 // later). One after the first that cannot be sent is recorded and left: sending again would repeat the first.
 async #send(list,what){
  for(const [i,card] of list.entries()){
   try{await this.bot.toOwner({card});}
   catch(e){
    this.store.addError('分级',`「${what}」的卡片没有发出去${i?'':`，${Math.round(this.retryMs/60e3)} 分钟后再试`}：${message(e)}`);
    if(!i){this.store.setMeta('levelCards',{...this.store.meta('levelCards'),failedAt:this.now()});return undefined;}
   }
  }
  return list;
 }
}
