// The daily read's tables in butler's store (see reading.mjs): the topics the model made of a chat's messages of a
// day, picked or not, and the messages each is made of; and for each chat and day it took up, how far it has read it.
// A topic belongs to one chat and one day, and its number stands for it: a correction points at a topic, and an exam
// asks again whether to pick one from its title and summary. The processor's process writes them; the command line
// reads them, from a process of its own, as it reads the matters (see matters.mjs).

const SCHEMA=`
CREATE TABLE IF NOT EXISTS topics(
 id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, feed_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, area TEXT NOT NULL,
 picked INTEGER NOT NULL, reason TEXT, run_id INTEGER, at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS topics_by_day ON topics(day,feed_id);
CREATE TABLE IF NOT EXISTS topic_messages(
 topic_id INTEGER NOT NULL REFERENCES topics(id), message_id TEXT NOT NULL REFERENCES messages(id), PRIMARY KEY(topic_id,message_id));
CREATE INDEX IF NOT EXISTS topic_messages_by_message ON topic_messages(message_id);
CREATE TABLE IF NOT EXISTS readings(
 day TEXT NOT NULL, feed_id TEXT NOT NULL, level TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, until_at INTEGER, until_id TEXT,
 flagged INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, error TEXT, done_at INTEGER, PRIMARY KEY(day,feed_id));
`;
// What a topic is about: my work, my interests (the two parts of 关于TA, see profile.mjs) or neither.
export const AREAS=['work','interest','other'];

export class Topics{
 constructor(store){this.store=store;this.db=store.db;this.db.exec(SCHEMA);}
 #all(sql,...p){return this.db.prepare(sql).all(...p);}
 #get(sql,...p){return this.db.prepare(sql).get(...p);}
 #run(sql,...p){return this.db.prepare(sql).run(...p);}
 #tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}

 // ---- topics: day (local, YYYY-MM-DD), the chat (chatId, chatName), title, summary (its points or conclusion), area
 // (see AREAS), picked, reason (why it was picked or not), its messages, oldest first, and the link of the first.
 #topic(row){
  if(!row)return undefined;
  const ids=this.#all('SELECT t.message_id FROM topic_messages t JOIN messages m ON m.id=t.message_id WHERE t.topic_id=? ORDER BY m.created_at,m.id',row.id).map(r=>r.message_id);
  return {id:row.id,day:row.day,chatId:row.feed_id,chatName:row.name??undefined,title:row.title,summary:row.summary,area:row.area,picked:Boolean(row.picked),
   reason:row.reason??undefined,messageIds:ids,link:ids.length?this.store.message(ids[0])?.link:undefined,at:row.at,updatedAt:row.updated_at};
 }
 static #select='SELECT t.*,c.name FROM topics t LEFT JOIN chats c ON c.feed_id=t.feed_id';
 topic(id){return this.#topic(this.#get(`${Topics.#select} WHERE t.id=?`,id));}
 // The topics of a day, of one chat when feedId is given, in the order they were made.
 ofDay(day,feedId){
  return (feedId===undefined?this.#all(`${Topics.#select} WHERE t.day=? ORDER BY t.id`,day):this.#all(`${Topics.#select} WHERE t.day=? AND t.feed_id=? ORDER BY t.id`,day,feedId)).map(r=>this.#topic(r));
 }

 // ---- readings: one for each chat and day the read took up. level: the chat's, as the day ended; messages: how many
 // it read; until ({at, id}): the last message read, in time order, so that a chat read in segments goes on after it;
 // flagged: how many of its messages it flagged for the batches (see Store.flag); strikes: answers to its messages
 // alone that could not be used, and error, the last one's; doneAt: when it was read to the end, or given up (with an
 // error then).
 static #reading=r=>r&&{day:r.day,feedId:r.feed_id,level:r.level,messages:r.messages,until:r.until_at==null?undefined:{at:r.until_at,id:r.until_id},
  flagged:r.flagged,strikes:r.strikes,error:r.error??undefined,doneAt:r.done_at??undefined};
 reading(day,feedId){return Topics.#reading(this.#get('SELECT * FROM readings WHERE day=? AND feed_id=?',day,feedId));}
 readings(day){return this.#all('SELECT * FROM readings WHERE day=? ORDER BY rowid',day).map(Topics.#reading);}
 // What a model run made of a part of a day, in one transaction: the topics it made (created: feedId, title, summary,
 // area, picked, reason, messageIds), those it carried on (updated: topicId, the fields it changed, messages added) and
 // for each chat of the part how far it is now read (read: feedId, level, messages, until, flagged, done; a chat read to
 // the end has its last error cleared). runId: the run. Returns the numbers of the topics made.
 apply({day,runId=null,created=[],updated=[],read=[],now=Date.now()}){
  return this.#tx(()=>{
   const link=this.db.prepare('INSERT OR IGNORE INTO topic_messages(topic_id,message_id) VALUES(?,?)'),ids=[];
   for(const t of created){
    const id=Number(this.#run('INSERT INTO topics(day,feed_id,title,summary,area,picked,reason,run_id,at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
     day,t.feedId,t.title,t.summary,t.area,t.picked?1:0,t.reason||null,runId,now,now).lastInsertRowid);
    for(const m of t.messageIds)link.run(id,m);ids.push(id);
   }
   for(const u of updated){
    const c=u.changes??{};
    this.#run('UPDATE topics SET title=COALESCE(?,title),summary=COALESCE(?,summary),area=COALESCE(?,area),picked=COALESCE(?,picked),reason=COALESCE(?,reason),updated_at=? WHERE id=?',
     c.title??null,c.summary??null,c.area??null,c.picked===undefined?null:c.picked?1:0,c.reason??null,now,u.topicId);
    for(const m of u.messageIds)link.run(u.topicId,m);
   }
   for(const r of read)this.#run(`INSERT INTO readings(day,feed_id,level,messages,until_at,until_id,flagged,done_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(day,feed_id) DO UPDATE SET level=excluded.level,messages=readings.messages+excluded.messages,until_at=excluded.until_at,until_id=excluded.until_id,
     flagged=readings.flagged+excluded.flagged,done_at=excluded.done_at,error=CASE WHEN excluded.done_at IS NULL THEN readings.error END`,
    day,r.feedId,r.level,r.messages,r.until?.at??null,r.until?.id??null,r.flagged??0,r.done?now:null);
   return ids;
  });
 }
 // An answer to the chat's messages alone that could not be used; at skipAfter of them its day is given up: done, with
 // the error. Returns how many there have been.
 strike(day,feedId,{level,error,skipAfter,now=Date.now()}){
  this.#run(`INSERT INTO readings(day,feed_id,level,strikes,error) VALUES(?,?,?,1,?) ON CONFLICT(day,feed_id) DO UPDATE SET strikes=readings.strikes+1,error=excluded.error`,
   day,feedId,level,String(error).slice(0,500));
  const {strikes}=this.reading(day,feedId);
  if(strikes>=skipAfter)this.#run('UPDATE readings SET done_at=? WHERE day=? AND feed_id=?',now,day,feedId);
  return strikes;
 }
 // A day as read: how many chats, the topics picked and not, the messages flagged, and the chats given up ({feedId,
 // name, error}).
 summary(day){
  const t=this.#get('SELECT count(*) n,COALESCE(sum(picked),0) picked FROM topics WHERE day=?',day),r=this.#get('SELECT count(*) n,COALESCE(sum(flagged),0) flagged FROM readings WHERE day=?',day);
  const failed=this.#all('SELECT r.feed_id,r.error,c.name FROM readings r LEFT JOIN chats c ON c.feed_id=r.feed_id WHERE r.day=? AND r.done_at IS NOT NULL AND r.error IS NOT NULL ORDER BY r.rowid',day)
   .map(x=>({feedId:x.feed_id,name:x.name??undefined,error:x.error}));
  return {chats:r.n,picked:t.picked,notPicked:t.n-t.picked,flagged:r.flagged,failed};
 }
}
