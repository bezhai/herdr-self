// butler's own store: one SQLite file. The collector writes it; the CLI and the processor (other processes) read it,
// set chat levels and flag messages for the batches (see flag), so it runs in WAL mode with a busy timeout and the
// collector reads a chat's level on every message. What grading is told of the chats (see grader.mjs) is read here too.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CATEGORIES,LEVELS,messageLink,reactionsOf} from './rules.mjs';

const SCHEMA=`
CREATE TABLE IF NOT EXISTS messages(
 id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, chat_kind TEXT NOT NULL,
 sender_id TEXT, sender_name TEXT, sender_type TEXT, created_at INTEGER NOT NULL, position TEXT,
 thread_role TEXT NOT NULL, root_id TEXT, parent_id TEXT, reply_to_sender_id TEXT,
 text TEXT NOT NULL, parts TEXT NOT NULL, unreadable INTEGER NOT NULL, is_mine INTEGER NOT NULL, mentions_all INTEGER NOT NULL,
 is_recalled INTEGER NOT NULL, is_edited INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 is_ephemeral INTEGER NOT NULL DEFAULT 0, reactions TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_root ON messages(root_id);
CREATE INDEX IF NOT EXISTS messages_by_chat ON messages(feed_id,created_at);
CREATE INDEX IF NOT EXISTS messages_mine ON messages(created_at) WHERE is_mine=1;
CREATE TABLE IF NOT EXISTS message_categories(
 message_id TEXT NOT NULL REFERENCES messages(id), category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id,category));
CREATE INDEX IF NOT EXISTS categories_by_time ON message_categories(category,created_at);
CREATE INDEX IF NOT EXISTS categories_batched ON message_categories(created_at,message_id) WHERE category<>'stored';
CREATE TABLE IF NOT EXISTS owner_reactions(
 message_id TEXT NOT NULL REFERENCES messages(id), key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(message_id,key));
CREATE INDEX IF NOT EXISTS owner_reactions_by_time ON owner_reactions(at);
CREATE TABLE IF NOT EXISTS chats(
 feed_id TEXT PRIMARY KEY, name TEXT, chat_mode TEXT, member_count INTEGER, is_muted INTEGER, last_active_at INTEGER,
 cursor INTEGER, signature TEXT, pending_signature TEXT, dirty INTEGER NOT NULL DEFAULT 0, read_retries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_levels(
 feed_id TEXT PRIMARY KEY, level TEXT NOT NULL, reason TEXT, set_by TEXT NOT NULL, since INTEGER NOT NULL, model_level TEXT, model_reason TEXT, model_at INTEGER);
CREATE TABLE IF NOT EXISTS level_changes(
 id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id TEXT NOT NULL, at INTEGER NOT NULL, changed_by TEXT NOT NULL,
 before_level TEXT, before_by TEXT, after_level TEXT, after_by TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS level_changes_by_time ON level_changes(at);
CREATE TABLE IF NOT EXISTS threads(
 root_id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, reply_count INTEGER NOT NULL DEFAULT 0, announced_count INTEGER NOT NULL DEFAULT 0,
 root_position TEXT, participated_since INTEGER, stale INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, checked_at INTEGER);
CREATE TABLE IF NOT EXISTS pending_mentions(
 message_id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, position INTEGER, created_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL);
`;
// Columns added after a store was first created, added to an older store when it is opened.
const ADDED_COLUMNS=[['chats','read_retries','INTEGER NOT NULL DEFAULT 0'],['threads','announced_count','INTEGER NOT NULL DEFAULT 0'],
 ['threads','attempts','INTEGER NOT NULL DEFAULT 0'],['threads','last_error','TEXT'],['messages','is_ephemeral','INTEGER NOT NULL DEFAULT 0'],
 ['messages','reactions',"TEXT NOT NULL DEFAULT '[]'"],['chat_levels','model_at','INTEGER']];
// The store keeps nearly every message of most chats (see rules.mjs), so what runs often reads through an index on a
// small part of it: messages_by_chat for a chat's latest messages, messages_mine for mine, categories_batched for what
// batches take (every category but stored); messages_by_chat replaces an index on the chat alone.
const KEEP_ERRORS=100;
const order=c=>CATEGORIES.indexOf(c);
const SETTERS=['owner','model'];

export class Store{
 // linkBase: open-lark's web address for message links. log: also gets every recorded error (the service's journal).
 constructor(file,{linkBase,log}){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  // The busy timeout comes with the connection: its first statement already reads the file, and while another process
  // that opened it at the same moment recovers the WAL the last run left, a read with no timeout fails at once.
  this.file=file;this.linkBase=linkBase;this.log=log;this.db=new DatabaseSync(file,{timeout:5000});
  this.db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;');this.db.exec(SCHEMA);this.#upgrade();
 }
 // A store created by an earlier version: chats.gap_retries became read_retries, later columns are added, my
 // messages recorded before the own category have it too, and the table of the conversation butler once held in my
 // direct chat goes: talking to butler moved to an agent that works the command line (see cli.mjs).
 #upgrade(){
  const columns=table=>new Set(this.#all(`PRAGMA table_info(${table})`).map(c=>c.name));
  if(columns('chats').has('gap_retries'))this.db.exec('ALTER TABLE chats RENAME COLUMN gap_retries TO read_retries');
  for(const [table,column,definition] of ADDED_COLUMNS)if(!columns(table).has(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  const ownless=`FROM messages m WHERE m.is_mine=1 AND NOT EXISTS(SELECT 1 FROM message_categories c WHERE c.message_id=m.id AND c.category='own')`;
  if(this.#get(`SELECT 1 ${ownless} LIMIT 1`))this.#run(`INSERT INTO message_categories(message_id,category,created_at) SELECT m.id,'own',m.created_at ${ownless}`);
  this.db.exec('DROP INDEX IF EXISTS messages_feed;DROP TABLE IF EXISTS conversation;');
  if(this.#get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='watches'"))this.#tx(()=>this.#levelsFromWatches());
 }
 // A store from before chat levels: a watched group is one I set to instant from when it was watched, its messages'
 // watched category is instant, and a direct message from a bot or an agent, which was dm, is instant instead: dm is
 // what a person writes, and its chat, a direct chat not graded yet, is instant (see rules.mjs ungradedLevel).
 #levelsFromWatches(){
  this.#run(`INSERT OR IGNORE INTO chat_levels(feed_id,level,set_by,since) SELECT feed_id,'instant','owner',since FROM watches`);
  this.#run(`UPDATE message_categories SET category='instant' WHERE category='watched'`);
  const bots=`SELECT id FROM messages WHERE sender_type IN ('bot','agent')`;
  this.#run(`INSERT OR IGNORE INTO message_categories(message_id,category,created_at) SELECT message_id,'instant',created_at FROM message_categories
   WHERE category='dm' AND message_id IN (${bots})`);
  this.#run(`DELETE FROM message_categories WHERE category='dm' AND message_id IN (${bots})`);
  this.db.exec('DROP TABLE watches');
 }
 close(){if(this.db.isOpen)this.db.close();}
 #all(sql,...p){return this.db.prepare(sql).all(...p);}
 #get(sql,...p){return this.db.prepare(sql).get(...p);}
 #run(sql,...p){return this.db.prepare(sql).run(...p);}
 #tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}

 // ---- messages
 // Inserts or updates one record; categories only accumulate, but for stored, which stands for no other: it gives way
 // to one that comes later and never joins one. Recalled and edited are sticky, and a view that is less
 // recalled or less edited than the stored record (a page fetched before the edit arrived) does not replace its content.
 // Reactions (JSON, see rules.mjs recordOf) are the view's when it has them, and each of mine is an owner reaction.
 upsertMessage(r,categories,now=Date.now()){
  this.#tx(()=>{
   this.#run(`INSERT INTO messages(id,feed_id,chat_kind,sender_id,sender_name,sender_type,created_at,position,thread_role,root_id,parent_id,reply_to_sender_id,text,parts,unreadable,is_mine,mentions_all,is_recalled,is_edited,is_ephemeral,reactions,first_seen_at,updated_at)
    VALUES($id,$feedId,$chatKind,$senderId,$senderName,$senderType,$createdAt,$position,$threadRole,$rootId,$parentId,$replyToSenderId,$text,$parts,$unreadable,$isMine,$mentionsAll,$isRecalled,$isEdited,$isEphemeral,COALESCE($reactions,'[]'),$now,$now)
    ON CONFLICT(id) DO UPDATE SET chat_kind=excluded.chat_kind,sender_name=excluded.sender_name,sender_type=excluded.sender_type,position=excluded.position,
     thread_role=excluded.thread_role,root_id=excluded.root_id,parent_id=excluded.parent_id,reply_to_sender_id=excluded.reply_to_sender_id,
     text=CASE WHEN excluded.is_recalled<messages.is_recalled OR excluded.is_edited<messages.is_edited THEN messages.text ELSE excluded.text END,
     parts=CASE WHEN excluded.is_recalled<messages.is_recalled OR excluded.is_edited<messages.is_edited THEN messages.parts ELSE excluded.parts END,
     unreadable=CASE WHEN excluded.is_recalled<messages.is_recalled OR excluded.is_edited<messages.is_edited THEN messages.unreadable ELSE excluded.unreadable END,
     mentions_all=excluded.mentions_all,is_recalled=MAX(messages.is_recalled,excluded.is_recalled),is_edited=MAX(messages.is_edited,excluded.is_edited),is_ephemeral=excluded.is_ephemeral,reactions=COALESCE($reactions,messages.reactions),updated_at=excluded.updated_at`,
    {...r,unreadable:r.unreadable?1:0,isMine:r.isMine?1:0,mentionsAll:r.mentionsAll?1:0,isRecalled:r.isRecalled?1:0,isEdited:r.isEdited?1:0,isEphemeral:r.isEphemeral?1:0,reactions:r.reactions??null,now});
   const add=this.db.prepare('INSERT OR IGNORE INTO message_categories(message_id,category,created_at) VALUES(?,?,?)'),reasons=categories.filter(c=>c!=='stored');
   for(const c of reasons)add.run(r.id,c,r.createdAt);
   if(reasons.length)this.#run("DELETE FROM message_categories WHERE message_id=? AND category='stored'",r.id);
   else if(categories.includes('stored'))this.#run("INSERT INTO message_categories(message_id,category,created_at) SELECT ?,'stored',? WHERE NOT EXISTS(SELECT 1 FROM message_categories WHERE message_id=?)",r.id,r.createdAt,r.id);
   if(r.reactions!=null)this.#ownerReacted(r.id,JSON.parse(r.reactions),now);
  });
 }
 // Messages of a daily chat that the daily read took for something I may have to act on (see reading.mjs): a stored
 // one becomes flagged, which batches take, as any other category does stored's place. One with another category
 // already goes to the batches and stays as it is. The only category the processor gives; returns the ids flagged.
 flag(ids){
  return this.#tx(()=>{
   const stored=this.#all("SELECT message_id id,created_at FROM message_categories WHERE category='stored' AND message_id IN (SELECT value FROM json_each(?))",JSON.stringify(ids));
   const add=this.db.prepare("INSERT OR IGNORE INTO message_categories(message_id,category,created_at) VALUES(?,'flagged',?)"),drop=this.db.prepare("DELETE FROM message_categories WHERE message_id=? AND category='stored'");
   for(const r of stored){add.run(r.id,r.created_at);drop.run(r.id);}
   return stored.map(r=>r.id);
  });
 }
 // The current reactions of a message butler holds, as open-lark lists them (GET /messages/:id/reactions).
 setReactions(id,list,now=Date.now()){
  const reactions=reactionsOf(list)??[];
  this.#tx(()=>{if(Number(this.#run('UPDATE messages SET reactions=?,updated_at=? WHERE id=?',JSON.stringify(reactions),now,id).changes))this.#ownerReacted(id,reactions,now);});
 }
 // A reaction of mine is recorded when butler first sees it, once per message and key: taking it back changes only the
 // message's current reactions, and adding it again is nothing new.
 #ownerReacted(id,reactions,now){
  const add=this.db.prepare('INSERT OR IGNORE INTO owner_reactions(message_id,key,at) VALUES(?,?,?)');
  for(const r of reactions)if(r.isMine)add.run(id,r.key,now);
 }
 // My reactions to a message, in the order butler saw them.
 ownerReactions(messageId){return this.#all('SELECT * FROM owner_reactions WHERE message_id=? ORDER BY at,rowid',messageId).map(r=>({messageId:r.message_id,key:r.key,at:r.at}));}
 markRecalled(id,now=Date.now()){this.#run('UPDATE messages SET is_recalled=1,updated_at=? WHERE id=?',now,id);}
 hasMessage(id){return Boolean(this.#get('SELECT 1 FROM messages WHERE id=?',id));}
 hasMessagesIn(feedId){return Boolean(this.#get('SELECT 1 FROM messages WHERE feed_id=? LIMIT 1',feedId));}
 // The position of a message butler holds in this chat, as open-lark gave it (text); undefined when it holds none.
 position(feedId,id){return this.#get('SELECT position FROM messages WHERE id=? AND feed_id=?',id,feedId)?.position;}
 // Whether butler holds a message of the chat at every position from..to (> 0; true when from>to). Positions are
 // integers kept as text, so they are compared as integers. Main-sequence positions are dense with one message each,
 // apart from ephemeral messages (only I see them), which open-lark puts at the position of the message before them:
 // those do not count, or one would stand for a message butler never saw.
 holdsPositions(feedId,from,to){
  return this.#get('SELECT count(DISTINCT CAST(position AS INTEGER)) n FROM messages WHERE feed_id=? AND is_ephemeral=0 AND CAST(position AS INTEGER) BETWEEN ? AND ?',feedId,from,to).n===Math.max(0,to-from+1);
 }
 isMine(id){return Boolean(this.#get('SELECT is_mine FROM messages WHERE id=?',id)?.is_mine);}
 hasCategory(id,category){return Boolean(this.#get('SELECT 1 FROM message_categories WHERE message_id=? AND category=?',id,category));}
 static #select=`SELECT m.*,c.name AS chat_name,c.chat_mode,COALESCE(t.root_position,r.position) AS root_position,
  (SELECT group_concat(category) FROM message_categories WHERE message_id=m.id) AS categories
  FROM messages m LEFT JOIN chats c ON c.feed_id=m.feed_id LEFT JOIN threads t ON t.root_id=m.root_id LEFT JOIN messages r ON r.id=m.root_id`;
 #record(row){
  if(!row)return undefined;
  const record={id:row.id,chatId:row.feed_id,chatName:row.chat_name??null,chatKind:row.chat_mode??row.chat_kind,senderId:row.sender_id,senderName:row.sender_name,
   senderType:row.sender_type,createdAt:row.created_at,position:row.position,threadRole:row.thread_role,rootId:row.root_id,parentId:row.parent_id,
   replyToSenderId:row.reply_to_sender_id,text:row.text,parts:JSON.parse(row.parts),unreadable:Boolean(row.unreadable),isMine:Boolean(row.is_mine),
   mentionsAll:Boolean(row.mentions_all),isRecalled:Boolean(row.is_recalled),isEdited:Boolean(row.is_edited),reactions:JSON.parse(row.reactions??'[]'),
   categories:(row.categories??'').split(',').filter(Boolean).sort((a,b)=>order(a)-order(b)),firstSeenAt:row.first_seen_at,updatedAt:row.updated_at};
  record.link=messageLink(this.linkBase,{feedId:row.feed_id,id:row.id,position:row.position,threadRole:row.thread_role,rootId:row.root_id,rootPosition:row.root_position});
  return record;
 }
 message(id){return this.#record(this.#get(`${Store.#select} WHERE m.id=?`,id));}
 // Newest first. category: one of CATEGORIES; since/until: ms.
 list({category,since=0,until=Number.MAX_SAFE_INTEGER,limit=50}={}){
  const where=['m.created_at>=?','m.created_at<=?'],params=[since,until];
  if(category){where.push('EXISTS(SELECT 1 FROM message_categories mc WHERE mc.message_id=m.id AND mc.category=?)');params.push(category);}
  return this.#all(`${Store.#select} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`,...params,limit).map(r=>this.#record(r));
 }
 counts(){
  const out={total:this.#get('SELECT count(*) n FROM messages').n};
  for(const c of CATEGORIES)out[c]=0;
  for(const {category,n} of this.#all('SELECT category,count(*) n FROM message_categories GROUP BY category'))out[category]=n;
  return out;
 }

 // ---- chats: what butler knows of each chat and how far it has read it
 upsertChatInfo(c){
  this.#run(`INSERT INTO chats(feed_id,name,chat_mode,member_count,is_muted,last_active_at) VALUES(?,?,?,?,?,?)
   ON CONFLICT(feed_id) DO UPDATE SET name=excluded.name,chat_mode=excluded.chat_mode,member_count=excluded.member_count,is_muted=excluded.is_muted,
    last_active_at=COALESCE(excluded.last_active_at,chats.last_active_at)`,
   c.feedId,c.name??null,c.chatMode??null,c.memberCount??null,c.isMuted?1:0,c.rankAt?Date.parse(c.rankAt):null);
 }
 chat(feedId){
  const r=this.#get('SELECT * FROM chats WHERE feed_id=?',feedId);
  return r&&{feedId:r.feed_id,name:r.name,chatMode:r.chat_mode,memberCount:r.member_count,isMuted:Boolean(r.is_muted),lastActiveAt:r.last_active_at,
   cursor:r.cursor,signature:r.signature,pendingSignature:r.pending_signature,dirty:Boolean(r.dirty),readRetries:r.read_retries};
 }
 // Chats butler has seen, most recently active first; groups: the group chats among them, normal and topic.
 chats(){return this.#all('SELECT feed_id FROM chats ORDER BY last_active_at DESC').map(r=>this.chat(r.feed_id));}
 groups(){return this.chats().filter(c=>c.chatMode==='group'||c.chatMode==='topic');}
 markDirty(feedId,signature){
  this.#run(`INSERT INTO chats(feed_id,dirty,pending_signature) VALUES(?,1,?) ON CONFLICT(feed_id) DO UPDATE SET dirty=1,pending_signature=COALESCE(excluded.pending_signature,chats.pending_signature)`,feedId,signature??null);
 }
 dirtyChats(limit){return this.#all('SELECT feed_id FROM chats WHERE dirty=1 ORDER BY last_active_at DESC LIMIT ?',limit).map(r=>r.feed_id);}
 setCursor(feedId,cursor){this.#run('INSERT INTO chats(feed_id,cursor) VALUES(?,?) ON CONFLICT(feed_id) DO UPDATE SET cursor=excluded.cursor',feedId,cursor);}
 // The chat has been read up to what its conversation entry showed when it was marked (or reading it was given up).
 settleChat(feedId){this.#run('UPDATE chats SET signature=COALESCE(pending_signature,signature),pending_signature=NULL,dirty=0,read_retries=0 WHERE feed_id=?',feedId);}
 // A read that fell short; returns how many in a row.
 readRetry(feedId){this.#run('UPDATE chats SET read_retries=read_retries+1 WHERE feed_id=?',feedId);return this.#get('SELECT read_retries FROM chats WHERE feed_id=?',feedId).read_retries;}
 // Chats that records point at but butler cannot name. The collector asks every cycle and the store keeps nearly every
 // message, so the chats are walked one seek each in the index by chat, from one chat to the next above it, never
 // message by message.
 chatsMissingInfo(limit){
  return this.#all(`WITH RECURSIVE f(feed_id) AS (SELECT min(feed_id) FROM messages UNION ALL SELECT (SELECT min(feed_id) FROM messages WHERE feed_id>f.feed_id) FROM f WHERE f.feed_id IS NOT NULL)
   SELECT f.feed_id FROM f LEFT JOIN chats c ON c.feed_id=f.feed_id WHERE f.feed_id IS NOT NULL AND c.name IS NULL LIMIT ?`,limit).map(r=>r.feed_id);
 }

 // ---- chat levels (see rules.mjs LEVELS): mine when I set one, else the model's. A level of mine stays until I clear
 // it; the model's last one is kept beside it (modelLevel, modelReason, and modelAt, when it graded the chat last), so
 // that clearing mine brings it back and what I changed can be told from what the model said. since: when the chat got
 // this level, kept while the level stays the same (an instant chat's messages from then on are instant); reason: why,
 // the model's words or mine, if any. A chat with no row has no level yet and goes by rules.mjs ungradedLevel: a direct
 // chat is instant, a group store. Every change is kept in level_changes (see levelChanges), which only grows: the
 // weekly card of what the model changed and the count of my corrections are read from it.
 static #level=r=>r&&{feedId:r.feed_id,level:r.level,reason:r.reason,by:r.set_by,since:r.since,modelLevel:r.model_level,modelReason:r.model_reason,modelAt:r.model_at??undefined};
 level(feedId){return Store.#level(this.#get('SELECT * FROM chat_levels WHERE feed_id=?',feedId));}
 instantSince(feedId){const l=this.level(feedId);return l?.level==='instant'?l.since:undefined;}
 // The chat's level at time t (ms), from its changes: what the first change after t changed it from, or with no change
 // since, the level it has; undefined for none (see rules.mjs ungradedLevel).
 levelAt(feedId,t){
  const next=this.#get('SELECT before_level FROM level_changes WHERE feed_id=? AND at>? ORDER BY at,id LIMIT 1',feedId,t);
  return next?next.before_level??undefined:this.level(feedId)?.level;
 }
 // Chats with a level and what butler knows of them, by level, then the latest to get theirs first.
 levels(){
  return this.#all(`SELECT l.*,c.name,c.chat_mode,c.member_count FROM chat_levels l LEFT JOIN chats c ON c.feed_id=l.feed_id
   ORDER BY CASE l.level ${LEVELS.map((x,i)=>`WHEN '${x}' THEN ${i}`).join(' ')} END,l.since DESC`).map(r=>({...Store.#level(r),name:r.name,chatMode:r.chat_mode,memberCount:r.member_count}));
 }
 // by: owner (I set it) or model (it graded the chat, which leaves a level of mine as it is). Returns the chat's level
 // before and after.
 setLevel(feedId,level,{by,reason=null,now=Date.now()}){
  if(!LEVELS.includes(level))throw Error(`没有这个级别：${level}（可选 ${LEVELS.join(' ')}）`);
  if(!SETTERS.includes(by))throw Error(`级别只能由 owner 或 model 定：${by}`);
  return this.#tx(()=>{
   const before=this.level(feedId),model=by==='model'?{level,reason,at:now}:{level:before?.modelLevel??null,reason:before?.modelReason??null,at:before?.modelAt};
   this.#putLevel(feedId,by==='owner'||before?.by!=='owner'?{level,reason,by}:before,model,before,now);
   return this.#changed(feedId,by,before,now);
  });
 }
 // My level of the chat goes: the model's applies again, or none. Returns the chat's level before and after.
 clearLevel(feedId,now=Date.now()){
  return this.#tx(()=>{
   const before=this.level(feedId);
   if(before?.by!=='owner')return {before,after:before};
   if(before.modelLevel==null)this.#run('DELETE FROM chat_levels WHERE feed_id=?',feedId);
   else{const model={level:before.modelLevel,reason:before.modelReason,at:before.modelAt};this.#putLevel(feedId,{...model,by:'model'},model,before,now);}
   return this.#changed(feedId,'owner',before,now);
  });
 }
 // The chat's level before and after a change by by (owner or model), which goes on record when it is one: the level
 // or who set it differs. The model grading a chat to the level it has, or beside a level of mine, changes nothing.
 #changed(feedId,by,before,now){
  const after=this.level(feedId);
  if(before?.level!==after?.level||before?.by!==after?.by)this.#run(`INSERT INTO level_changes(feed_id,at,changed_by,before_level,before_by,after_level,after_by,reason) VALUES(?,?,?,?,?,?,?,?)`,
   feedId,now,by,before?.level??null,before?.by??null,after?.level??null,after?.by??null,after?.reason??null);
  return {before,after};
 }
 // The changes of chat levels from since up to until (ms, not included), the oldest first: each with the chat (and what
 // butler knows of it), when, who made it (by: owner or model), the level before and after ({level, by}, undefined for
 // none) and the reason the chat had after it. For the weekly card of changes and for counting my corrections.
 levelChanges(since,until=Number.MAX_SAFE_INTEGER){
  const side=(level,by)=>level==null?undefined:{level,by};
  return this.#all(`SELECT h.*,c.name,c.chat_mode FROM level_changes h LEFT JOIN chats c ON c.feed_id=h.feed_id WHERE h.at>=? AND h.at<? ORDER BY h.at,h.id`,since,until)
   .map(r=>({id:r.id,feedId:r.feed_id,name:r.name??undefined,chatMode:r.chat_mode??undefined,at:r.at,by:r.changed_by,before:side(r.before_level,r.before_by),after:side(r.after_level,r.after_by),reason:r.reason}));
 }
 #putLevel(feedId,{level,reason,by},model,before,now){
  this.#run(`INSERT INTO chat_levels(feed_id,level,reason,set_by,since,model_level,model_reason,model_at) VALUES(?,?,?,?,?,?,?,?)
   ON CONFLICT(feed_id) DO UPDATE SET level=excluded.level,reason=excluded.reason,set_by=excluded.set_by,since=excluded.since,model_level=excluded.model_level,model_reason=excluded.model_reason,model_at=excluded.model_at`,
   feedId,level,reason??null,by,before?.level===level?before.since:now,model.level,model.reason??null,model.at??null);
 }

 // ---- what grading is told of the chats (see grader.mjs)
 // When butler began keeping every message of a chat that is not ignored: when it first saw a message it kept for no
 // other reason (stored). Not when that message was sent: a chat read by position for the first time is read back to
 // when collection began. Undefined until there is one. It reads the categories of every stored message, so grading
 // asks only until the moment is long enough ago to stop mattering.
 keptSince(){return this.#get("SELECT min(m.first_seen_at) t FROM message_categories c INDEXED BY categories_by_time JOIN messages m ON m.id=c.message_id WHERE c.category='stored'").t??undefined;}
 // The chats with messages since since (ms), the busiest first, each with: how many of its messages are from from on
 // (by default since) and how many of those a bot or an agent sent, when its first message in the store was, what
 // butler knows of it (no name, member count or mute yet for a chat seen only through push) and its level, if any.
 activity(since,from=since){
  return this.#all(`SELECT a.*,(SELECT min(created_at) FROM messages f WHERE f.feed_id=a.feed_id) first_at,c.name,c.chat_mode,c.member_count,c.is_muted FROM
   (SELECT feed_id,max(chat_kind) chat_kind,sum(created_at>=?) n,sum(created_at>=? AND sender_type IN ('bot','agent')) bots,max(created_at) last FROM messages INDEXED BY messages_created WHERE created_at>=? GROUP BY feed_id) a
   LEFT JOIN chats c ON c.feed_id=a.feed_id ORDER BY a.n DESC,a.last DESC`,from,from,since)
   .map(r=>({feedId:r.feed_id,name:r.name??undefined,kind:r.chat_mode??r.chat_kind,members:r.member_count??undefined,muted:r.is_muted==null?undefined:Boolean(r.is_muted),
    messages:r.n,bots:r.bots,firstAt:r.first_at,level:this.level(r.feed_id)}));
 }
 // What I did in each chat since since (ms): my messages, @ of me (mention) and my reactions (when butler saw them).
 // A Map by chat; chats where I did none of these are not in it. Read from my messages, the mentions and my reactions.
 involvement(since){
  const out=new Map(),add=(key,rows)=>{for(const r of rows){const x=out.get(r.feed_id)??{mine:0,mentions:0,reactions:0};x[key]=r.n;out.set(r.feed_id,x);}};
  add('mine',this.#all('SELECT feed_id,count(*) n FROM messages INDEXED BY messages_mine WHERE is_mine=1 AND created_at>=? GROUP BY feed_id',since));
  add('mentions',this.#all("SELECT m.feed_id,count(*) n FROM message_categories c INDEXED BY categories_by_time JOIN messages m ON m.id=c.message_id WHERE c.category='mention' AND c.created_at>=? GROUP BY m.feed_id",since));
  add('reactions',this.#all('SELECT m.feed_id,count(*) n FROM owner_reactions o CROSS JOIN messages m ON m.id=o.message_id WHERE o.at>=? GROUP BY m.feed_id',since));
  return out;
 }

 // ---- threads butler follows: replies to fetch when the root's reply count moves
 // reply_count: what the last successful fetch saw; announced_count: the highest count a root or the thread feed showed.
 thread(rootId){
  const r=this.#get('SELECT * FROM threads WHERE root_id=?',rootId);
  return r&&{rootId:r.root_id,feedId:r.feed_id,replyCount:r.reply_count,announcedCount:r.announced_count,rootPosition:r.root_position,
   participatedSince:r.participated_since??undefined,stale:Boolean(r.stale),attempts:r.attempts};
 }
 // I took part at time t. Returns whether that is news (first time, or earlier than known): replies after it need fetching.
 participate(rootId,feedId,t){
  const known=this.thread(rootId)?.participatedSince;if(known!==undefined&&known<=t)return false;
  this.#run(`INSERT INTO threads(root_id,feed_id,participated_since) VALUES(?,?,?) ON CONFLICT(root_id) DO UPDATE SET participated_since=excluded.participated_since`,rootId,feedId,t);
  return true;
 }
 // The thread's replies need fetching; announced: the reply count that says so, if one does. Returns whether this is new
 // work: the thread was not waiting for a fetch, or the count is higher than any announced before (replies that a fetch
 // already under way may not see).
 markThreadStale(rootId,feedId,announced){
  const known=this.thread(rootId),fresh=!known||!known.stale||(announced!==undefined&&announced>known.announcedCount);
  this.#run(`INSERT INTO threads(root_id,feed_id,stale,announced_count) VALUES(?,?,1,?) ON CONFLICT(root_id) DO UPDATE SET stale=1,announced_count=MAX(threads.announced_count,excluded.announced_count)`,
   rootId,feedId,announced??0);
  return fresh;
 }
 setRootPosition(rootId,position){this.#run('UPDATE threads SET root_position=? WHERE root_id=?',position,rootId);}
 staleThreads(limit){return this.#all('SELECT root_id FROM threads WHERE stale=1 ORDER BY checked_at IS NOT NULL,checked_at LIMIT ?',limit).map(r=>r.root_id);}
 // Fetched: replyCount is what the fetch saw. Without one (the thread cannot be read, or fetching it was given up),
 // the thread counts as having what was announced, so the same announcement does not bring it back.
 settleThread(rootId,replyCount,rootPosition,now=Date.now()){
  this.#run(`UPDATE threads SET reply_count=COALESCE(?,MAX(reply_count,announced_count)),root_position=COALESCE(?,root_position),stale=0,attempts=0,last_error=NULL,checked_at=? WHERE root_id=?`,
   replyCount??null,rootPosition??null,now,rootId);
 }
 // A fetch failed; the thread stays stale, behind the others. Returns the number of failed attempts so far.
 failThread(rootId,error,now=Date.now()){
  this.#run('UPDATE threads SET attempts=attempts+1,last_error=?,checked_at=? WHERE root_id=?',String(error).slice(0,500),now,rootId);
  return this.thread(rootId)?.attempts??0;
 }

 // ---- @me search hits open-lark could not hand over yet
 addPending(hit,error){
  this.#run(`INSERT INTO pending_mentions(message_id,feed_id,position,created_at,attempts,last_error) VALUES(?,?,?,?,1,?)
   ON CONFLICT(message_id) DO UPDATE SET attempts=pending_mentions.attempts+1,last_error=excluded.last_error`,
   hit.messageId,hit.feedId,hit.position??null,hit.createTime?Date.parse(hit.createTime):null,error);
 }
 pendingMentions(limit){
  return this.#all('SELECT * FROM pending_mentions ORDER BY attempts,created_at LIMIT ?',limit)
   .map(r=>({messageId:r.message_id,feedId:r.feed_id,position:r.position,createTime:r.created_at==null?undefined:new Date(r.created_at).toISOString(),attempts:r.attempts}));
 }
 removePending(id){this.#run('DELETE FROM pending_mentions WHERE message_id=?',id);}

 // ---- meta and errors
 meta(key){const r=this.#get('SELECT value FROM meta WHERE key=?',key);return r?JSON.parse(r.value):undefined;}
 setMeta(key,value){this.#run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
 addError(source,message,at=Date.now()){
  this.log?.(`${source}：${message}`);
  this.#run('INSERT INTO errors(at,source,message) VALUES(?,?,?)',at,source,String(message).slice(0,2000));
  this.#run('DELETE FROM errors WHERE id<=(SELECT max(id) FROM errors)-?',KEEP_ERRORS);
 }
 errors(limit=10){return this.#all('SELECT at,source,message FROM errors ORDER BY id DESC LIMIT ?',limit);}

 // How many chats have each level, and how many of them I set.
 #levelCounts(){
  const out=Object.fromEntries(LEVELS.map(l=>[l,0]));
  for(const {level,n} of this.#all('SELECT level,count(*) n FROM chat_levels GROUP BY level'))out[level]=n;
  return {...out,owner:this.#get("SELECT count(*) n FROM chat_levels WHERE set_by='owner'").n};
 }
 status(){
  const size=f=>{try{return fs.statSync(f).size;}catch{return 0;}};
  return {collector:this.meta('collector')??{},events:this.meta('events')??{},reconcile:this.meta('reconcile')??{},sync:this.meta('sync')??{},
   collectedSince:this.meta('collectedSince'),mentionsSweptUntil:this.meta('mentions.sweptUntil'),threadFeedScannedAt:this.meta('threadFeed.scannedAt'),
   counts:this.counts(),pendingMentions:this.#get('SELECT count(*) n FROM pending_mentions').n,levels:this.#levelCounts(),
   chatsRead:this.#get('SELECT count(*) n FROM chats WHERE cursor>0').n,staleThreads:this.#get('SELECT count(*) n FROM threads WHERE stale=1').n,
   errors:this.errors(10),file:this.file,sizeBytes:size(this.file)+size(`${this.file}-wal`)};
 }
}
