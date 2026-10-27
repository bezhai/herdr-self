// The processor's own tables in butler's store: the ignore list, which messages have been processed, the matters and
// their source messages, and the model runs. The collector's tables (messages, chats, …) are only read here; the
// processor is a separate process on the same SQLite file (WAL, busy timeout). The bot, in the processor's process,
// edits the ignore list and closes and reopens matters through this same class.

const SCHEMA=`
CREATE TABLE IF NOT EXISTS ignored_senders(sender_id TEXT PRIMARY KEY, name TEXT, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS processed(
 message_id TEXT PRIMARY KEY REFERENCES messages(id), outcome TEXT NOT NULL, run_id INTEGER, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS matters(
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, who TEXT NOT NULL, ask TEXT NOT NULL, due TEXT, urgency TEXT NOT NULL,
 status TEXT NOT NULL, reason TEXT, opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT);
CREATE TABLE IF NOT EXISTS matter_messages(
 matter_id INTEGER NOT NULL REFERENCES matters(id), message_id TEXT NOT NULL REFERENCES messages(id), added_at INTEGER NOT NULL,
 PRIMARY KEY(matter_id,message_id));
CREATE INDEX IF NOT EXISTS matter_messages_by_message ON matter_messages(message_id);
CREATE TABLE IF NOT EXISTS message_failures(
 message_id TEXT PRIMARY KEY REFERENCES messages(id), strikes INTEGER NOT NULL, last_error TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS model_runs(
 id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, messages INTEGER NOT NULL, prompt_bytes INTEGER NOT NULL,
 ok INTEGER, error TEXT, output TEXT, kind TEXT NOT NULL DEFAULT 'batch', matters INTEGER);
`;
// Columns added after a store's processor tables were first created, added when it is opened. closed_by: model (it
// judged the matter ended) or owner (I closed it in the conversation). A model run's kind: batch (of new messages)
// or review (of the open matters, see review.mjs); runs from before reviews were batches. Its matters: how many open
// matters it was shown, unknown for runs from before.
const ADDED_COLUMNS=[['matters','closed_by','TEXT'],['model_runs','kind',"TEXT NOT NULL DEFAULT 'batch'"],['model_runs','matters','INTEGER']];
const UNPROCESSED='NOT EXISTS(SELECT 1 FROM processed p WHERE p.message_id=m.id)';
const NOT_IGNORED='NOT EXISTS(SELECT 1 FROM ignored_senders i WHERE i.sender_id=m.sender_id)';
const NOT_IN='m.id NOT IN (SELECT value FROM json_each(?))';

export class Matters{
 constructor(store){
  this.store=store;this.db=store.db;this.db.exec(SCHEMA);
  for(const [table,column,definition] of ADDED_COLUMNS)if(!this.#all(`PRAGMA table_info(${table})`).some(c=>c.name===column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
 }
 #all(sql,...p){return this.db.prepare(sql).all(...p);}
 #get(sql,...p){return this.db.prepare(sql).get(...p);}
 #run(sql,...p){return this.db.prepare(sql).run(...p);}
 #tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}

 // ---- the ignore list: senders whose messages never go to the model
 // Everyone but me who sent a message butler holds, with the name and type of their latest message.
 senders(){
  return this.#all(`SELECT sender_id,sender_name,sender_type,max(created_at) last,count(*) n FROM messages WHERE is_mine=0 AND sender_id IS NOT NULL GROUP BY sender_id ORDER BY n DESC`)
   .map(r=>({senderId:r.sender_id,name:r.sender_name??'',type:r.sender_type,messages:r.n,lastAt:r.last}));
 }
 ignoredSenders(){return this.#all('SELECT * FROM ignored_senders ORDER BY since,name').map(r=>({senderId:r.sender_id,name:r.name??'',since:r.since}));}
 ignore(senderId,name,now=Date.now()){this.#run('INSERT INTO ignored_senders(sender_id,name,since) VALUES(?,?,?) ON CONFLICT(sender_id) DO UPDATE SET name=excluded.name',senderId,name??null,now);}
 unignore(senderId){this.#run('DELETE FROM ignored_senders WHERE sender_id=?',senderId);}
 // Messages of ignored senders count as processed when they are passed by, so taking a sender off the list later
 // does not hand the model everything it sent while it was on it.
 skipIgnored(now=Date.now()){
  return Number(this.#run(`INSERT INTO processed(message_id,outcome,at) SELECT m.id,'ignored',? FROM messages m WHERE ${UNPROCESSED} AND NOT (${NOT_IGNORED})`,now).changes);
 }

 // ---- what the model is given
 #records(ids){return ids.map(r=>this.store.message(r.id)).filter(Boolean);}
 // Unprocessed messages, oldest first, ignored senders and exclude (ids) left out.
 pending(limit,exclude=[]){return this.#records(this.#all(`SELECT id FROM messages m WHERE ${UNPROCESSED} AND ${NOT_IGNORED} AND ${NOT_IN} ORDER BY created_at,id LIMIT ?`,JSON.stringify(exclude),limit));}
 pendingCount(){return this.#get(`SELECT count(*) n FROM messages m WHERE ${UNPROCESSED} AND ${NOT_IGNORED}`).n;}
 // The latest messages of a chat before a time, oldest first, ignored senders left out.
 before(feedId,t,limit){
  return this.#records(this.#all(`SELECT id FROM messages m WHERE feed_id=? AND created_at<? AND ${NOT_IGNORED} ORDER BY created_at DESC,id DESC LIMIT ?`,feedId,t,limit)).reverse();
 }
 // One message for the model, unless it is unknown or its sender is ignored.
 visible(id){return this.#get(`SELECT id FROM messages m WHERE id=? AND ${NOT_IGNORED}`,id)?this.store.message(id):undefined;}
 // My name as my own messages carry it.
 me(){return this.#get('SELECT sender_name FROM messages WHERE is_mine=1 AND sender_name IS NOT NULL ORDER BY created_at DESC LIMIT 1')?.sender_name??'我';}

 // ---- matters
 #matter(row){
  if(!row)return undefined;
  const sources=this.#all('SELECT mm.message_id,m.feed_id,m.created_at,c.name FROM matter_messages mm JOIN messages m ON m.id=mm.message_id LEFT JOIN chats c ON c.feed_id=m.feed_id WHERE mm.matter_id=? ORDER BY m.created_at,m.id',row.id);
  const chatIds=[...new Set(sources.map(s=>s.feed_id))];
  return {id:row.id,title:row.title,who:row.who,ask:row.ask,due:row.due,urgency:row.urgency,status:row.status,reason:row.reason,
   // since: when it started, by its earliest message; lastAt: its latest message; openedAt: when butler made it.
   since:sources[0]?.created_at??row.opened_at,lastAt:sources.at(-1)?.created_at??row.opened_at,openedAt:row.opened_at,updatedAt:row.updated_at,closedAt:row.closed_at,closedBy:row.closed_by,messageIds:sources.map(s=>s.message_id),chatIds,
   chats:chatIds.map(id=>sources.find(s=>s.feed_id===id).name??id),link:sources.length?this.store.message(sources[0].message_id)?.link:undefined};
 }
 matter(id){return this.#matter(this.#get('SELECT * FROM matters WHERE id=?',id));}
 // Open matters, most urgent first, newest first within one urgency; all: closed ones too, after them.
 list({all=false}={}){
  return this.#all(`SELECT * FROM matters ${all?'':"WHERE status='open'"} ORDER BY status='closed',CASE urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,opened_at DESC,id DESC`).map(r=>this.#matter(r));
 }
 // Matters that ended after t, in the order they ended.
 closedSince(t){return this.#all("SELECT * FROM matters WHERE status='closed' AND closed_at>? ORDER BY closed_at,id",t??-1).map(r=>this.#matter(r));}
 // The latest matters to end, latest first.
 recentlyClosed(limit){return this.#all("SELECT * FROM matters WHERE status='closed' ORDER BY closed_at DESC,id DESC LIMIT ?",limit).map(r=>this.#matter(r));}
 // I closed an open matter myself, with my reason if I gave one; returns whether it was open.
 close(id,reason,now=Date.now()){
  return Number(this.#run(`UPDATE matters SET status='closed',reason=?,closed_at=?,closed_by='owner',updated_at=? WHERE id=? AND status='open'`,reason||null,now,now,id).changes)>0;
 }
 // An ended matter is open again; returns whether it had ended.
 reopen(id,now=Date.now()){
  return Number(this.#run(`UPDATE matters SET status='open',reason=NULL,closed_at=NULL,closed_by=NULL,updated_at=? WHERE id=? AND status='closed'`,now,id).changes)>0;
 }
 // A model answer (see prompt.mjs readReply) and the messages it covered, in one transaction. outcome: how the
 // messages were processed (model, or context for my own messages that needed no model).
 apply({runId=null,created=[],updated=[],processedIds=[],outcome='model',now=Date.now()}){
  return this.#tx(()=>{
   const link=this.db.prepare('INSERT OR IGNORE INTO matter_messages(matter_id,message_id,added_at) VALUES(?,?,?)'),ids=[];
   for(const m of created){
    const id=Number(this.#run(`INSERT INTO matters(title,who,ask,due,urgency,status,opened_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)`,m.title,m.who,m.ask,m.due??null,m.urgency,now,now).lastInsertRowid);
    for(const message of m.messageIds)link.run(id,message,now);ids.push(id);
   }
   for(const u of updated){
    const c=u.changes??{};
    this.#run('UPDATE matters SET title=COALESCE(?,title),who=COALESCE(?,who),ask=COALESCE(?,ask),due=COALESCE(?,due),urgency=COALESCE(?,urgency),updated_at=? WHERE id=?',
     c.title??null,c.who??null,c.ask??null,c.due??null,c.urgency??null,now,u.matterId);
    if(u.close)this.#run(`UPDATE matters SET status='closed',reason=?,closed_at=?,closed_by='model' WHERE id=? AND status='open'`,u.close,now,u.matterId);
    for(const message of u.messageIds)link.run(u.matterId,message,now);
   }
   const done=this.db.prepare('INSERT OR IGNORE INTO processed(message_id,outcome,run_id,at) VALUES(?,?,?,?)');
   for(const id of processedIds)done.run(id,outcome,runId,now);
   return ids;
  });
 }

 // ---- messages the model failed on by themselves (see processor.mjs): their strikes, and those given up
 struck(){return new Set(this.#all('SELECT message_id FROM message_failures').map(r=>r.message_id));}
 // One more strike against a message; returns how many it has.
 strike(id,error,now=Date.now()){
  this.#run('INSERT INTO message_failures(message_id,strikes,last_error,at) VALUES(?,1,?,?) ON CONFLICT(message_id) DO UPDATE SET strikes=strikes+1,last_error=excluded.last_error,at=excluded.at',id,String(error).slice(0,500),now);
  return this.#get('SELECT strikes FROM message_failures WHERE message_id=?',id).strikes;
 }
 clearStrikes(ids){this.#run(`DELETE FROM message_failures WHERE message_id IN (SELECT value FROM json_each(?))`,JSON.stringify(ids));}
 skippedCount(){return this.#get(`SELECT count(*) n FROM processed WHERE outcome='failed'`).n;}

 // ---- model runs, kept with the raw reply so a decision can be looked into later
 // messages: the new messages it was given to process (none for a review); matters: the open matters it was shown.
 startRun({kind='batch',messages,matters,promptBytes,now=Date.now()}){
  return Number(this.#run('INSERT INTO model_runs(started_at,kind,messages,matters,prompt_bytes) VALUES(?,?,?,?,?)',now,kind,messages,matters??null,promptBytes).lastInsertRowid);
 }
 finishRun(id,{ok,error,output,now=Date.now()}){this.#run('UPDATE model_runs SET finished_at=?,ok=?,error=?,output=? WHERE id=?',now,ok?1:0,error??null,output??null,id);}
 runs(limit=1000){
  return this.#all('SELECT * FROM (SELECT * FROM model_runs ORDER BY id DESC LIMIT ?) ORDER BY id',limit)
   .map(r=>({id:r.id,kind:r.kind,startedAt:r.started_at,finishedAt:r.finished_at,messages:r.messages,matters:r.matters??undefined,promptBytes:r.prompt_bytes,ok:r.ok===null?undefined:Boolean(r.ok),error:r.error,output:r.output}));
 }
}
