// butler's own store: one SQLite file. The collector writes it; the CLI (another process) reads it and edits the
// watch list, so it runs in WAL mode with a busy timeout and the collector re-reads the watch list on every message.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CATEGORIES,messageLink} from './rules.mjs';

const SCHEMA=`
CREATE TABLE IF NOT EXISTS messages(
 id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, chat_kind TEXT NOT NULL,
 sender_id TEXT, sender_name TEXT, sender_type TEXT, created_at INTEGER NOT NULL, position TEXT,
 thread_role TEXT NOT NULL, root_id TEXT, parent_id TEXT, reply_to_sender_id TEXT,
 text TEXT NOT NULL, parts TEXT NOT NULL, unreadable INTEGER NOT NULL, is_mine INTEGER NOT NULL, mentions_all INTEGER NOT NULL,
 is_recalled INTEGER NOT NULL, is_edited INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_root ON messages(root_id);
CREATE INDEX IF NOT EXISTS messages_feed ON messages(feed_id);
CREATE TABLE IF NOT EXISTS message_categories(
 message_id TEXT NOT NULL REFERENCES messages(id), category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id,category));
CREATE INDEX IF NOT EXISTS categories_by_time ON message_categories(category,created_at);
CREATE TABLE IF NOT EXISTS chats(
 feed_id TEXT PRIMARY KEY, name TEXT, chat_mode TEXT, member_count INTEGER, is_muted INTEGER, last_active_at INTEGER,
 cursor INTEGER, signature TEXT, pending_signature TEXT, dirty INTEGER NOT NULL DEFAULT 0, read_retries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS watches(feed_id TEXT PRIMARY KEY, since INTEGER NOT NULL);
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
 ['threads','attempts','INTEGER NOT NULL DEFAULT 0'],['threads','last_error','TEXT']];
const KEEP_ERRORS=100;
const order=c=>CATEGORIES.indexOf(c);

export class Store{
 // linkBase: open-lark's web address for message links. log: also gets every recorded error (the service's journal).
 constructor(file,{linkBase,log}){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  this.file=file;this.linkBase=linkBase;this.log=log;this.db=new DatabaseSync(file);
  this.db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');this.db.exec(SCHEMA);this.#upgrade();
 }
 // A store created by an earlier version: chats.gap_retries became read_retries, and later columns are added.
 #upgrade(){
  const columns=table=>new Set(this.#all(`PRAGMA table_info(${table})`).map(c=>c.name));
  if(columns('chats').has('gap_retries'))this.db.exec('ALTER TABLE chats RENAME COLUMN gap_retries TO read_retries');
  for(const [table,column,definition] of ADDED_COLUMNS)if(!columns(table).has(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
 }
 close(){if(this.db.isOpen)this.db.close();}
 #all(sql,...p){return this.db.prepare(sql).all(...p);}
 #get(sql,...p){return this.db.prepare(sql).get(...p);}
 #run(sql,...p){return this.db.prepare(sql).run(...p);}
 #tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}

 // ---- messages
 // Inserts or updates one record; categories only accumulate. Recalled and edited are sticky, and a view that is less
 // recalled or less edited than the stored record (a page fetched before the edit arrived) does not replace its content.
 upsertMessage(r,categories,now=Date.now()){
  this.#tx(()=>{
   this.#run(`INSERT INTO messages(id,feed_id,chat_kind,sender_id,sender_name,sender_type,created_at,position,thread_role,root_id,parent_id,reply_to_sender_id,text,parts,unreadable,is_mine,mentions_all,is_recalled,is_edited,first_seen_at,updated_at)
    VALUES($id,$feedId,$chatKind,$senderId,$senderName,$senderType,$createdAt,$position,$threadRole,$rootId,$parentId,$replyToSenderId,$text,$parts,$unreadable,$isMine,$mentionsAll,$isRecalled,$isEdited,$now,$now)
    ON CONFLICT(id) DO UPDATE SET chat_kind=excluded.chat_kind,sender_name=excluded.sender_name,sender_type=excluded.sender_type,position=excluded.position,
     thread_role=excluded.thread_role,root_id=excluded.root_id,parent_id=excluded.parent_id,reply_to_sender_id=excluded.reply_to_sender_id,
     text=CASE WHEN excluded.is_recalled<messages.is_recalled OR excluded.is_edited<messages.is_edited THEN messages.text ELSE excluded.text END,
     parts=CASE WHEN excluded.is_recalled<messages.is_recalled OR excluded.is_edited<messages.is_edited THEN messages.parts ELSE excluded.parts END,
     unreadable=CASE WHEN excluded.is_recalled<messages.is_recalled OR excluded.is_edited<messages.is_edited THEN messages.unreadable ELSE excluded.unreadable END,
     mentions_all=excluded.mentions_all,is_recalled=MAX(messages.is_recalled,excluded.is_recalled),is_edited=MAX(messages.is_edited,excluded.is_edited),updated_at=excluded.updated_at`,
    {...r,unreadable:r.unreadable?1:0,isMine:r.isMine?1:0,mentionsAll:r.mentionsAll?1:0,isRecalled:r.isRecalled?1:0,isEdited:r.isEdited?1:0,now});
   const add=this.db.prepare('INSERT OR IGNORE INTO message_categories(message_id,category,created_at) VALUES(?,?,?)');
   for(const c of categories)add.run(r.id,c,r.createdAt);
  });
 }
 markRecalled(id,now=Date.now()){this.#run('UPDATE messages SET is_recalled=1,updated_at=? WHERE id=?',now,id);}
 hasMessage(id){return Boolean(this.#get('SELECT 1 FROM messages WHERE id=?',id));}
 hasMessagesIn(feedId){return Boolean(this.#get('SELECT 1 FROM messages WHERE feed_id=? LIMIT 1',feedId));}
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
   mentionsAll:Boolean(row.mentions_all),isRecalled:Boolean(row.is_recalled),isEdited:Boolean(row.is_edited),
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
 // Group chats butler has seen, most recently active first.
 groups(){return this.#all(`SELECT feed_id FROM chats WHERE chat_mode IN ('group','topic') ORDER BY last_active_at DESC`).map(r=>this.chat(r.feed_id));}
 markDirty(feedId,signature){
  this.#run(`INSERT INTO chats(feed_id,dirty,pending_signature) VALUES(?,1,?) ON CONFLICT(feed_id) DO UPDATE SET dirty=1,pending_signature=COALESCE(excluded.pending_signature,chats.pending_signature)`,feedId,signature??null);
 }
 dirtyChats(limit){return this.#all('SELECT feed_id FROM chats WHERE dirty=1 ORDER BY last_active_at DESC LIMIT ?',limit).map(r=>r.feed_id);}
 setCursor(feedId,cursor){this.#run('INSERT INTO chats(feed_id,cursor) VALUES(?,?) ON CONFLICT(feed_id) DO UPDATE SET cursor=excluded.cursor',feedId,cursor);}
 // The chat has been read up to what its conversation entry showed when it was marked (or reading it was given up).
 settleChat(feedId){this.#run('UPDATE chats SET signature=COALESCE(pending_signature,signature),pending_signature=NULL,dirty=0,read_retries=0 WHERE feed_id=?',feedId);}
 // A read that fell short; returns how many in a row.
 readRetry(feedId){this.#run('UPDATE chats SET read_retries=read_retries+1 WHERE feed_id=?',feedId);return this.#get('SELECT read_retries FROM chats WHERE feed_id=?',feedId).read_retries;}
 chatsMissingInfo(limit){return this.#all('SELECT DISTINCT m.feed_id FROM messages m LEFT JOIN chats c ON c.feed_id=m.feed_id WHERE c.name IS NULL LIMIT ?',limit).map(r=>r.feed_id);}

 // ---- watched groups
 watch(feedId,since=Date.now()){this.#run('INSERT INTO watches(feed_id,since) VALUES(?,?) ON CONFLICT(feed_id) DO NOTHING',feedId,since);}
 unwatch(feedId){this.#run('DELETE FROM watches WHERE feed_id=?',feedId);}
 watchSince(feedId){return this.#get('SELECT since FROM watches WHERE feed_id=?',feedId)?.since;}
 watches(){
  return this.#all('SELECT w.feed_id,w.since,c.name,c.chat_mode,c.member_count FROM watches w LEFT JOIN chats c ON c.feed_id=w.feed_id ORDER BY w.since')
   .map(r=>({feedId:r.feed_id,since:r.since,name:r.name,chatMode:r.chat_mode,memberCount:r.member_count}));
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

 status(){
  const size=f=>{try{return fs.statSync(f).size;}catch{return 0;}};
  return {collector:this.meta('collector')??{},events:this.meta('events')??{},reconcile:this.meta('reconcile')??{},sync:this.meta('sync')??{},
   collectedSince:this.meta('collectedSince'),mentionsSweptUntil:this.meta('mentions.sweptUntil'),threadFeedScannedAt:this.meta('threadFeed.scannedAt'),
   counts:this.counts(),pendingMentions:this.#get('SELECT count(*) n FROM pending_mentions').n,watched:this.#get('SELECT count(*) n FROM watches').n,
   chatsRead:this.#get('SELECT count(*) n FROM chats WHERE cursor>0').n,staleThreads:this.#get('SELECT count(*) n FROM threads WHERE stale=1').n,
   errors:this.errors(10),file:this.file,sizeBytes:size(this.file)+size(`${this.file}-wal`)};
 }
}
