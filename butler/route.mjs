// Handing my new Feishu messages to the agents they concern. A round (the processor runs one every few minutes, see processor.mjs)
// takes every message butler saw since the last round, whatever its category, and the live topics of Bridge (GET /api/topics/context),
// and asks the model which topic needs to know which of them; each topic gets at most one short digest for the round (POST
// /api/topics/digest), which Bridge gives its agent once the agent is free. Which message matters to which topic is the model's call:
// code only supplies facts, the links between a message and a topic (see LINKS), and leaves out two kinds of message that are news to
// no one: my messages in a Bridge topic thread, which Bridge gives that topic's agent itself, and the messages of Bridge's bot and of
// butler's own bot, which are their own output. The model sees messages and topics under refs of its own (m1…, t1…), so that ids never
// pass through it; a digest gets the message ids in place of the refs, for the agent to read the originals with ol. Routing is off,
// dry-run or on (BUTLER_ROUTING, see config.mjs): dry-run does everything but hand the digests over, and keeps them for review.
import {parse,prose,DATA} from './prompt.mjs';
import {BridgeError} from './bridge-client.mjs';
import {OpenLarkError} from './open-lark.mjs';

const DAY=86_400_000;
// everyMs: how long after a round the next one routes (the processor's rounds come every 10 minutes, and sooner when I answer a
// matter). startMs: how far back the first round looks. settleMs: how long a message must have been in the store, so that one being
// written while the round reads is not passed over, and that a topic I start in a chat with Bridge's bot has the bot's answer in its
// thread by then, which leaves my message out (see CANDIDATES). maxAgeMs: how old a message may be, by when it was sent, to be news: history
// collected late (a group I just joined) is not. perRound: how many messages a round takes at most; the rest wait for the next.
// maxMessages and maxPromptBytes: what one prompt holds at most, halved until it fits. textChars: how much of a message's text a prompt
// shows. given and givenChars: how many of each topic's latest digests a prompt shows, and how much of each. retryMs: how long a chat that open-lark did not find waits
// before it is asked again.
export const DEFAULTS={everyMs:300_000,startMs:600_000,settleMs:60_000,maxAgeMs:DAY,perRound:1500,maxMessages:300,maxPromptBytes:100_000,textChars:500,given:3,givenChars:500,retryMs:3_600_000};
// The facts code finds between a message and a topic, in the words the model reads them.
export const LINKS={replyToSent:'回复了话题发出的消息',inSentThread:'在话题发出的消息所在的 thread 里',replyToSource:'回复了话题的来源消息',
 inSourceThread:'在话题来源消息所在的 thread 里',touchedChat:'在话题的来源或草稿所在的聊天里',group:'在话题所在的群里',groupThread:'在话题所在的群里的一个 Bridge 话题 thread 里'};
// What the model reads of the state of a draft (see Bridge's DeliveryState).
const STATES={delivered:'已发出',awaiting:'等确认',sending:'正在发',failed:'发送失败',rejected:'没有发'};
// The table of what each round gave each topic: one row per topic and round, with the messages, the digest and its status: dry (a
// dry-run's, never sent), pending (to hand over), given (Bridge took it) or dropped (Bridge refused it, error says why). It is made when
// routing first runs, so that the dry run of the command line, which keeps nothing, leaves the store as it was.
const SCHEMA=`
CREATE TABLE IF NOT EXISTS routed(
 id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, topic_id TEXT NOT NULL, topic_title TEXT NOT NULL, message_ids TEXT NOT NULL,
 text TEXT NOT NULL, status TEXT NOT NULL, run_ids TEXT NOT NULL, sent_at INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS routed_by_topic ON routed(topic_id,id);
CREATE INDEX IF NOT EXISTS routed_pending ON routed(id) WHERE status='pending';`;
// The meta of routing: {cursor: {at, id}, the first_seen_at and id of the last message routed, at: when the last round started, mode, and
// what that round did}; and the feed ids of the topics' chats by open chat id, as open-lark found them.
const META='routing',OPEN_CHATS='routing.openChats';
// The messages a round takes: seen after the cursor and settled, sent within maxAgeMs, by no one in senders (Bridge's bot and butler's
// own), and none of mine in a thread where Bridge's bot posted (a Bridge topic thread, whose root I or the bot sent), oldest seen first.
const CANDIDATES=`SELECT m.id FROM messages m WHERE m.created_at>=? AND m.first_seen_at<=? AND (m.first_seen_at>? OR m.first_seen_at=? AND m.id>?)
 AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT value FROM json_each(?)))
 AND NOT (m.is_mine=1 AND m.root_id IS NOT NULL AND (EXISTS(SELECT 1 FROM messages b WHERE b.id=m.root_id AND b.sender_id=?) OR EXISTS(SELECT 1 FROM messages b WHERE b.root_id=m.root_id AND b.sender_id=?)))
 ORDER BY m.first_seen_at,m.id LIMIT ?`;
// The longest digest of one route and of a topic's round, which Bridge takes at most.
const ROUTE_CHARS=1000,DIGEST_CHARS=2000;
// A ref the model writes for a message in a digest.
const REF=/(?<![A-Za-z0-9_])m\d+(?!\d)/g;
const message=e=>e?.message??String(e);
const at=ms=>new Date(ms).toLocaleString('sv-SE').slice(0,16),short=ms=>at(ms).slice(5);
const one=text=>String(text??'').replace(/\s+/g,' ').trim();

// One line: it goes as a command-line argument, and herdr refuses control characters there. me: my name.
export function routeSystemPrompt(me){
 return [
  `你替「${me}」把TA飞书上新来的消息转给TA在 Herdr Bridge 里进行中的话题。每个话题里有一个 Agent 在替TA做一件事；你给每个话题只挑出它做这件事需要知道的消息，写成一段简短的摘要交给它的 Agent，Agent 会自己去读原消息。`,
  `你会收到一个 JSON：now 是现在的时间；topics 是进行中的话题：ref 是话题编号，title 是标题，goal 是交给它的事，group 是它所在的聊天，exchanges 是最近几轮${me}在话题里说的话和 Agent 的回复，sources 是 Agent 放进话题的飞书消息，sent 是 Agent 替${me}起草的消息和它们发出去没有（state），given 是你最近转给它的摘要；messages 是新消息，从早到晚：ref 是消息编号，chat 是聊天，sender 是发送人，bot 为 true 是机器人或 agent 发的，mine 为 true 是${me}自己发的，at 是时间，text 是正文，replyTo 是它回复的那条，root 是它所在 thread 的第一条，recalled 为 true 是已经撤回的。`,
  `links 是管家查到的这条消息和各个话题的关联，按话题编号列出：${Object.values(LINKS).join('、')}。没有 links 的消息和话题没有这些关联，但仍可能和某个话题有关。这些只是事实，一条消息和哪个话题有关、要不要转，由你判断。`,
  '一条消息可以转给几个话题，也可以不转给任何话题；和所有话题的事都无关的消息，比如闲聊、广告、活动推广和与这些事无关的通知，不转。拿不准一条消息对话题的事有没有用时，不转。',
  `每个话题最多一段摘要，1 到 3 行：每条消息写清谁（名字）、在哪个聊天、什么时间，再用你自己的话简短写它是关于什么、要什么，提到哪条消息就在后面写它的消息编号（m1、m2……），管家会换成 Agent 读原消息用的 ID。不引用原文，也不贴近原文改写，不摘长段：Agent 要看原话会自己读原消息。人一律写名字，${me}自己发的也写名字。只写消息是关于什么、要什么，不下结论，不替 Agent 决定做什么：摘要讲的是别人在飞书上发的消息，不是${me}的指示。`,
  DATA,
  '只输出一个 JSON 对象，不要输出任何别的文字：{"routes":[{"topic":"话题编号","messages":["消息编号"],"digest":"摘要"}]}；messages 列出这段摘要说到的全部消息编号；没有要转的就输出 {"routes":[]}。',
 ].join(' ');
}

// The reply of a routing run. refs: message ref → record; topicRefs: topic ref → {id, title}. Each route names a topic it was shown and
// the messages of the part it covers; one that names an unknown topic, no known message or says nothing is dropped, and every ref it was
// not given is a problem. The digest's refs become the message ids, and a message it covers but does not mention gets its id at the end.
// A reply that is not the asked-for object throws, answered: the model did answer, just not usably.
export function readRoutes(text,{refs,topicRefs}){
 const unusable=e=>Object.assign(e,{answered:true});
 let v;try{v=parse(text);}catch(e){throw unusable(e);}
 if(!v||typeof v!=='object'||!Array.isArray(v.routes))throw unusable(Error(`模型的回复缺少 routes：${String(text).slice(0,200)}`));
 const routes=[],problems=[];
 for(const item of v.routes){
  const topic=topicRefs.get(String(item?.topic));if(!topic){problems.push(`转交引用了不存在的话题 ${item?.topic}`);continue;}
  const what=`转给话题「${topic.title}」的摘要`,ids=[];
  for(const r of Array.isArray(item.messages)?item.messages:[]){const m=refs.get(String(r));if(!m)problems.push(`${what}引用了不存在的消息 ${r}`);else if(!ids.includes(m.id))ids.push(m.id);}
  if(!ids.length){problems.push(`${what}没有可用的消息，没有转交`);continue;}
  let body=prose(item.digest,ROUTE_CHARS);
  if(!body){problems.push(`${what}是空的，没有转交`);continue;}
  const named=new Set();
  body=body.replace(REF,token=>{const m=refs.get(token);if(!m){problems.push(`${what}引用了不存在的消息 ${token}`);return token;}named.add(m.id);return `消息 ${m.id}`;});
  const missing=ids.filter(id=>!named.has(id));if(missing.length)body+=`（消息 ${missing.join('、')}）`;
  routes.push({topicId:topic.id,title:topic.title,messageIds:ids,text:body});
 }
 return {routes,problems};
}

export class Router{
 #tableMade=false;#missing=new Map();#found=new Map();
 // lark: the read-only open-lark client; bridge: see bridge-client.mjs; model: {name, ask({system, prompt})}; botId: Bridge's bot as
 // open-lark knows it; ownBotId: butler's own bot, when known; mode: dry-run or on.
 constructor({store,matters,lark,bridge,model,botId,ownBotId,mode,now=Date.now,options={}}){
  Object.assign(this,{store,matters,lark,bridge,model,botId,ownBotId,mode,now,options:{...DEFAULTS,...options}});
  this.db=store.db;
 }
 #table(){if(!this.#tableMade){this.db.exec(SCHEMA);this.#tableMade=true;}}
 #exists(){return this.#tableMade||Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='routed'").get());}
 #tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}

 // Whether a round is due: the last one started at least everyMs ago, or there has been none.
 due(){return !(this.now()-this.store.meta(META)?.at<this.options.everyMs);}

 // One round: the digests still pending go first; then the messages seen since the cursor, with the live topics, go to the model in
 // parts, and each topic's routes of the round become one digest, kept with the cursor in one transaction and, when on, handed over. A
 // part the model does not answer ends the round, the cursor staying before it; a part whose answer cannot be used is skipped with an
 // error, as it would fail the same way every round. Resolves with {mode, messages, runs, digests, given, dropped, problems, error?};
 // a failure is recorded and resolves with error, and the next round tries again.
 async route(){
  this.#table();
  const now=this.now(),meta=this.store.meta(META)??{},result={mode:this.mode,messages:0,runs:0,digests:0,given:0,dropped:0,problems:[]};
  this.store.setMeta(META,{...meta,at:now,mode:this.mode});
  try{
   if(this.mode==='on')await this.#send(result);
   const cursor=meta.cursor??{at:now-this.options.startMs,id:''},plan=await this.#plan({from:cursor,until:now-this.options.settleMs,keep:true});
   result.messages=plan.messages.length;
   if(!plan.messages.length)return result;
   const asked=plan.topics.length?await this.#ask(plan,{record:true}):{routes:[],problems:[],skipped:[],runs:0,done:plan.messages.length,runIds:[]};
   for(const p of asked.problems)this.store.addError('转交',`模型回复里没有采纳的部分：${p}`);
   for(const s of asked.skipped)this.store.addError('转交',`${s.messages} 条消息没有转交：模型的回答不能用（${s.error}）`);
   const digests=merge(asked.routes),last=plan.messages[asked.done-1];
   this.#tx(()=>{
    for(const d of digests)this.db.prepare('INSERT INTO routed(at,topic_id,topic_title,message_ids,text,status,run_ids) VALUES(?,?,?,?,?,?,?)')
     .run(now,d.topicId,d.title,JSON.stringify(d.messageIds),d.text,this.mode==='on'?'pending':'dry',JSON.stringify(asked.runIds));
    if(last)this.store.setMeta(META,{...this.store.meta(META),cursor:{at:last.firstSeenAt,id:last.id}});
   });
   Object.assign(result,{runs:asked.runs,digests:digests.length,problems:asked.problems});
   if(asked.error){result.error=asked.error;this.store.addError('转交',`转交新消息没有完成，下一轮再试：${asked.error}`);}
   if(this.mode==='on')await this.#send(result);
  }catch(e){
   result.error=message(e);this.store.addError('转交',`转交新消息没有完成，下一轮再试：${message(e)}`);
  }finally{
   const {problems,...done}=result;this.store.setMeta(META,{...this.store.meta(META),last:{...done,problems:problems.length}});
  }
  return result;
 }

 // The dry run of the command line: what a round would route now, from the cursor or from since (ms), without keeping or sending
 // anything: no table, no watermark, no model run recorded, no group kept, nothing handed over. Resolves with {from, until, topics,
 // messages, digests, problems, runs, error?}.
 async preview({since}){
  const now=this.now(),cursor=since!==undefined?{at:since,id:''}:this.store.meta(META)?.cursor??{at:now-this.options.startMs,id:''},until=now-this.options.settleMs;
  const plan=await this.#plan({from:cursor,until,keep:false});
  const asked=plan.topics.length&&plan.messages.length?await this.#ask(plan,{record:false}):{routes:[],problems:[],skipped:[],runs:0};
  return {from:cursor.at,until,topics:plan.topics.map(t=>({id:t.id,title:t.title,feedId:t.feedId??null})),messages:plan.messages,digests:merge(asked.routes),
   problems:[...asked.problems,...asked.skipped.map(s=>`${s.messages} 条消息没有转交：模型的回答不能用（${s.error}）`)],runs:asked.runs,...asked.error&&{error:asked.error}};
 }

 // What the rounds gave the topics, the latest first: since (ms) and at most limit rows.
 log({since=0,limit=100}){
  if(!this.#exists())return [];
  return this.db.prepare('SELECT * FROM routed WHERE at>=? ORDER BY id DESC LIMIT ?').all(since,limit)
   .map(r=>({id:r.id,at:r.at,status:r.status,topicId:r.topic_id,title:r.topic_title,messageIds:JSON.parse(r.message_ids),text:r.text,sentAt:r.sent_at??undefined,error:r.error??undefined}));
 }

 // The messages of a round, from cursor from up to until, and when there are any, the live topics, each with the feed id of its chat
 // (keep: whether a feed id found is kept in the store), what it got lately and the ids that tie messages to it.
 async #plan({from,until,keep}){
  const senders=[this.botId,this.ownBotId].filter(Boolean),o=this.options;
  const ids=this.db.prepare(CANDIDATES).all(this.now()-o.maxAgeMs,until,from.at,from.at,from.id,JSON.stringify(senders),this.botId,this.botId,o.perRound).map(r=>r.id);
  const messages=ids.map(id=>this.store.message(id)).filter(Boolean);
  if(!messages.length)return {messages,topics:[]};
  const topics=[];
  for(const t of await this.bridge.topicContext())topics.push({...t,feedId:await this.#feedOf(t.chatId,keep),given:this.#given(t.id),...this.#touched(t)});
  return {messages,topics};
 }
 // The feed id of the chat whose open chat id is chatId, from the store or else open-lark, which knows the groups I am in; undefined
 // when open-lark does not find it (a direct chat), which is asked again after retryMs. An open-lark that cannot be reached is asked again
 // next round.
 async #feedOf(chatId,keep){
  const kept=this.store.meta(OPEN_CHATS)?.[chatId]??this.#found.get(chatId);if(kept)return kept;
  if(this.now()-this.#missing.get(chatId)<this.options.retryMs)return undefined;
  try{
   const c=await this.lark.openChat(chatId);
   if(c?.feedId){if(keep)this.store.setMeta(OPEN_CHATS,{...this.store.meta(OPEN_CHATS),[chatId]:c.feedId});else this.#found.set(chatId,c.feedId);return c.feedId;}
  }catch(e){if(!(e instanceof OpenLarkError&&e.status<500))return undefined;}
  this.#missing.set(chatId,this.now());return undefined;
 }
 // The latest digests that topic id got or would have got (dry-run), oldest first.
 #given(id){
  if(!this.#exists())return [];
  return this.db.prepare("SELECT at,text FROM routed WHERE topic_id=? AND status<>'dropped' ORDER BY id DESC LIMIT ?").all(id,this.options.given).reverse().map(r=>({at:short(r.at),text:r.text.slice(0,this.options.givenChars)}));
 }
 // The ids that tie a message to topic t: the messages it sent as me (a text and its attachments) and the roots of their threads, the
 // messages it brought in and the roots of theirs, and the chats of both.
 #touched(t){
  const sentIds=new Set(),sentRoots=new Set(),sourceIds=new Set(),sourceRoots=new Set(),chats=new Set(),rootOf=id=>this.store.message(id)?.rootId;
  for(const d of t.drafts??[]){
   chats.add(d.chatId);if(!d.sent)continue;
   for(const id of [d.sent.messageId,...d.sent.attachments??[]]){sentIds.add(id);const root=rootOf(id);if(root)sentRoots.add(root);}
   if(d.sent.threadRoot)sentRoots.add(d.sent.threadRoot);
  }
  for(const s of t.sources??[]){chats.add(s.chatId);sourceIds.add(s.messageId);const root=rootOf(s.messageId);if(root)sourceRoots.add(root);}
  return {sentIds,sentRoots,sourceIds,sourceRoots,chats};
 }
 // The links of message r to topic t (see LINKS). bridgeThread(root): whether Bridge's bot posted in that thread.
 #links(r,t,bridgeThread){
  const out=[],thread=r.rootId&&r.rootId!==r.id?r.rootId:undefined;
  if(r.parentId&&t.sentIds.has(r.parentId))out.push(LINKS.replyToSent);
  if(thread&&(t.sentIds.has(thread)||t.sentRoots.has(thread)))out.push(LINKS.inSentThread);
  if(r.parentId&&t.sourceIds.has(r.parentId))out.push(LINKS.replyToSource);
  if(thread&&(t.sourceIds.has(thread)||t.sourceRoots.has(thread)))out.push(LINKS.inSourceThread);
  if(t.chats.has(r.chatId))out.push(LINKS.touchedChat);
  if(t.feedId&&r.chatId===t.feedId)out.push(r.rootId&&bridgeThread(r.rootId)?LINKS.groupThread:LINKS.group);
  return out;
 }
 // What the model is shown of the messages of part and of the topics, and the refs of both.
 #compose(part,topics,bridgeThread){
  const me=this.matters.me(),o=this.options,refs=new Map(),topicRefs=new Map();
  const shownTopics=topics.map((t,i)=>{const ref=`t${i+1}`;topicRefs.set(ref,{id:t.id,title:t.title});t.ref=ref;
   return {ref,title:t.title,goal:t.goal,group:t.chatName,
    exchanges:(t.exchanges??[]).slice(-4).map(e=>({from:e.from==='owner'?me:'Agent',at:short(e.at),text:e.text})),
    sources:(t.sources??[]).slice(-5).map(s=>({chat:s.chatName,sender:s.sender,at:short(s.at),text:s.text})),
    sent:(t.drafts??[]).slice(-5).map(d=>({chat:d.chatName,at:short(d.at),state:STATES[d.state]??d.state,text:d.text})),given:t.given};});
  const brief=id=>{const x=id&&this.store.message(id);return x?{sender:x.senderName??x.senderId,text:one(x.text).slice(0,100)}:undefined;};
  const messages=part.map((r,i)=>{
   const ref=`m${i+1}`;refs.set(ref,r);
   const links=Object.fromEntries(topics.map(t=>[t.ref,this.#links(r,t,bridgeThread)]).filter(([,l])=>l.length));
   // As a batch shows them (see prompt.mjs arrange): a reply in a thread has its root, and what it replies to when that is not the root.
   const inThread=r.threadRole==='reply'&&r.rootId,replyTo=r.parentId&&!(inThread&&r.parentId===r.rootId)?brief(r.parentId):undefined,root=inThread?brief(r.rootId):undefined;
   return {ref,chat:r.chatName??r.chatId,sender:r.senderName??r.senderId,...r.senderType&&r.senderType!=='user'&&{bot:true},...r.isMine&&{mine:true},at:short(r.createdAt),
    text:one(r.text).slice(0,o.textChars),...r.isRecalled&&{recalled:true},...replyTo&&{replyTo},...root&&{root},...Object.keys(links).length&&{links}};
  });
  const data={now:at(this.now()),me,topics:shownTopics,messages};
  return {system:routeSystemPrompt(me),prompt:`以下是进行中的话题和新消息：\n${JSON.stringify(data)}`,refs,topicRefs};
 }
 // The plan's messages through the model, in parts of at most maxMessages that fit maxPromptBytes; record: whether each run goes into
 // model_runs. Resolves with the routes and problems of the parts done, the parts skipped ({messages, error}), the runs, how many messages
 // the parts done cover (done, from the front), the ids of the recorded runs and the error that ended it, if one did.
 async #ask(plan,{record}){
  const o=this.options,out={routes:[],problems:[],skipped:[],runs:0,done:0,runIds:[]},seen=new Map();
  const bridgeThread=root=>{if(!seen.has(root))seen.set(root,Boolean(this.db.prepare('SELECT 1 FROM messages WHERE sender_id=? AND (id=? OR root_id=?) LIMIT 1').get(this.botId,root,root)));return seen.get(root);};
  let rest=plan.messages;
  while(rest.length){
   let part=rest.slice(0,o.maxMessages),c=this.#compose(part,plan.topics,bridgeThread);
   while(Buffer.byteLength(c.prompt)>o.maxPromptBytes&&part.length>1){part=part.slice(0,Math.ceil(part.length/2));c=this.#compose(part,plan.topics,bridgeThread);}
   out.runs+=1;
   try{
    const read=text=>readRoutes(text,{refs:c.refs,topicRefs:c.topicRefs});
    const reply=record?await this.matters.recordRun({model:this.model,kind:'route',messages:part.length,matters:plan.topics.length,system:c.system,prompt:c.prompt,now:this.now},(text,runId)=>{out.runIds.push(runId);return read(text);})
     :read(await this.model.ask({system:c.system,prompt:c.prompt}));
    out.routes.push(...reply.routes);out.problems.push(...reply.problems);
   }catch(e){
    if(e?.answered!==true){out.error=message(e);break;}
    out.skipped.push({messages:part.length,error:message(e)});
   }
   out.done+=part.length;rest=rest.slice(part.length);
  }
  return out;
 }
 // Hands the pending digests to Bridge, oldest first, each under the key butler-route:<row>, which Bridge answers once. One that Bridge
 // refuses for good (an unknown or ended topic, an invalid request) is dropped with the reason; any other failure (Bridge unreachable or
 // restarting) leaves it and the rest pending for the next round, and is the round's error.
 async #send(result){
  for(const r of this.db.prepare("SELECT id,topic_id,topic_title,text FROM routed WHERE status='pending' ORDER BY id").all()){
   try{
    await this.bridge.giveDigest({topicId:r.topic_id,key:`butler-route:${r.id}`,text:r.text});
    this.db.prepare("UPDATE routed SET status='given',sent_at=?,error=NULL WHERE id=?").run(this.now(),r.id);result.given+=1;
   }catch(e){
    if(e instanceof BridgeError&&[400,404,409].includes(e.status)){
     this.db.prepare("UPDATE routed SET status='dropped',error=? WHERE id=?").run(message(e),r.id);result.dropped+=1;
     this.store.addError('转交',`转给话题「${r.topic_title}」的摘要 Bridge 没有收下，不再转：${message(e)}`);continue;
    }
    this.db.prepare('UPDATE routed SET error=? WHERE id=?').run(message(e),r.id);
    result.error=message(e);this.store.addError('转交',`转给话题「${r.topic_title}」的摘要没有交出去，下一轮再试：${message(e)}`);return;
   }
  }
 }
}

// The routes of a round, one digest per topic: its routes' messages and texts together, in the order they came, the text cut to what
// Bridge takes.
function merge(routes){
 const byTopic=new Map();
 for(const r of routes){
  const d=byTopic.get(r.topicId)??{topicId:r.topicId,title:r.title,messageIds:[],texts:[]};byTopic.set(r.topicId,d);
  for(const id of r.messageIds)if(!d.messageIds.includes(id))d.messageIds.push(id);d.texts.push(r.text);
 }
 return [...byTopic.values()].map(({texts,...d})=>({...d,text:texts.join('\n').slice(0,DIGEST_CHARS)}));
}
