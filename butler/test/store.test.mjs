import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {tempStore,post,LINK_BASE} from './helpers.mjs';
import {Store} from '../store.mjs';
import {Matters} from '../matters.mjs';

const T0=Date.parse('2026-10-23T09:00:00+08:00'),min=n=>T0+n*60e3;
const cats=(store,id)=>store.message(id)?.categories;
const levelOf=(store,id)=>{const l=store.level(id);return l&&{level:l.level,by:l.by,reason:l.reason,since:l.since,modelLevel:l.modelLevel,modelReason:l.modelReason};};

test('a chat\'s level is mine when I set one, else the model\'s; it begins when the level changes, and clearing mine brings the model\'s back',async t=>{
 const {store}=tempStore(t);store.upsertChatInfo({feedId:'g1',name:'项目群',chatMode:'group'});
 let r=store.setLevel('g1','instant',{by:'owner',now:min(0)});
 assert.equal(r.before,undefined);assert.deepEqual(levelOf(store,'g1'),{level:'instant',by:'owner',reason:null,since:min(0),modelLevel:null,modelReason:null});
 r=store.setLevel('g1','store',{by:'model',reason:'多是转发，和TA的工作无关',now:min(1)});
 assert.deepEqual(levelOf(store,'g1'),{level:'instant',by:'owner',reason:null,since:min(0),modelLevel:'store',modelReason:'多是转发，和TA的工作无关'},'the model does not change mine, its own is kept beside it');
 assert.deepEqual([r.before.level,r.after.level],['instant','instant']);
 store.setLevel('g1','instant',{by:'owner',reason:'我在跟这个项目',now:min(2)});
 assert.equal(store.level('g1').since,min(0),'the same level again does not begin anew');assert.equal(store.level('g1').reason,'我在跟这个项目');
 r=store.setLevel('g1','daily',{by:'owner',now:min(3)});
 assert.deepEqual([r.before.level,r.after.level,r.after.since],['instant','daily',min(3)]);
 r=store.clearLevel('g1',min(4));
 assert.deepEqual(levelOf(store,'g1'),{level:'store',by:'model',reason:'多是转发，和TA的工作无关',since:min(4),modelLevel:'store',modelReason:'多是转发，和TA的工作无关'});
 assert.deepEqual([r.before.level,r.before.by,r.after.level,r.after.by],['daily','owner','store','model']);
 r=store.clearLevel('g1',min(5));assert.equal(r.after.since,min(4),'nothing of mine to clear: nothing changes');
 store.setLevel('g1','daily',{by:'model',reason:'偶尔有和TA有关的讨论',now:min(6)});
 assert.deepEqual([store.level('g1').level,store.level('g1').by,store.level('g1').since],['daily','model',min(6)],'without mine, the model\'s applies');
 // A level of mine on a chat the model never graded goes altogether.
 store.setLevel('d1','instant',{by:'owner',now:min(7)});r=store.clearLevel('d1',min(8));
 assert.equal(r.before.level,'instant');assert.equal(r.after,undefined);assert.equal(store.level('d1'),undefined);
 assert.throws(()=>store.setLevel('g1','watched',{by:'owner'}),/级别/);assert.throws(()=>store.setLevel('g1','instant',{by:'someone'}),/owner|model/);
 assert.deepEqual(store.levels().map(l=>[l.feedId,l.name,l.level,l.by]),[['g1','项目群','daily','model']]);
 assert.equal(store.instantSince('g1'),undefined);store.setLevel('g1','instant',{by:'owner',now:min(9)});assert.equal(store.instantSince('g1'),min(9));
 assert.deepEqual(store.status().levels,{instant:1,daily:0,store:0,ignore:0,owner:1});
});

test('stored stands for no other category: it gives way to one that comes later and never joins one',t=>{
 const {store}=tempStore(t);
 const a=post(store,{text:'别人的讨论',categories:['stored']});assert.deepEqual(cats(store,a),['stored']);
 post(store,{id:a,text:'别人的讨论',categories:['reply']});assert.deepEqual(cats(store,a),['reply'],'it turned out to answer me');
 post(store,{id:a,text:'别人的讨论',categories:['stored']});assert.deepEqual(cats(store,a),['reply'],'a later read that sees no reason does not take one away');
 const b=post(store,{text:'即时群里的',categories:['instant']});post(store,{id:b,text:'即时群里的',categories:['stored']});
 assert.deepEqual(cats(store,b),['instant'],'read again after the chat was no longer instant');
 assert.equal(store.counts().stored,0);
});

test('a store from before levels: watched groups are instant by me from when they were watched, their messages instant, and a bot\'s direct messages instant, not dm',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const old=new DatabaseSync(file);
 old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, chat_kind TEXT NOT NULL, sender_id TEXT, sender_name TEXT, sender_type TEXT,
  created_at INTEGER NOT NULL, position TEXT, thread_role TEXT NOT NULL, root_id TEXT, parent_id TEXT, reply_to_sender_id TEXT, text TEXT NOT NULL, parts TEXT NOT NULL,
  unreadable INTEGER NOT NULL, is_mine INTEGER NOT NULL, mentions_all INTEGER NOT NULL, is_recalled INTEGER NOT NULL, is_edited INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_ephemeral INTEGER NOT NULL DEFAULT 0, reactions TEXT NOT NULL DEFAULT '[]');
  CREATE INDEX messages_feed ON messages(feed_id);
  CREATE TABLE message_categories(message_id TEXT NOT NULL REFERENCES messages(id), category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id,category));
  CREATE TABLE watches(feed_id TEXT PRIMARY KEY, since INTEGER NOT NULL);`);
 const message=(id,feed,kind,type,mine,categories)=>{
  old.prepare(`INSERT INTO messages(id,feed_id,chat_kind,sender_id,sender_type,created_at,position,thread_role,text,parts,unreadable,is_mine,mentions_all,is_recalled,is_edited,first_seen_at,updated_at)
   VALUES(?,?,?,?,?,?,'1','none','x','[]',0,?,0,0,0,?,?)`).run(id,feed,kind,mine?'me':'s',type,min(1),mine?1:0,min(1),min(1));
  for(const c of categories)old.prepare('INSERT INTO message_categories VALUES(?,?,?)').run(id,c,min(1));
 };
 old.prepare('INSERT INTO watches VALUES(?,?)').run('g1',min(0));old.prepare('INSERT INTO watches VALUES(?,?)').run('g2',min(-60));
 message('w','g1','group','user',false,['watched']);message('wm','g1','group','user',false,['mention','watched']);
 message('b','bot','direct','bot',false,['dm']);message('a','agent','direct','agent',false,['dm']);message('br','bot','direct','bot',false,['dm','reply']);
 message('p','d1','direct','user',false,['dm']);message('me','bot','direct','user',true,['dm','own']);old.close();
 const store=new Store(file,{linkBase:LINK_BASE});t.after(()=>store.close());
 assert.deepEqual(['g1','g2'].map(id=>levelOf(store,id)),[{level:'instant',by:'owner',reason:null,since:min(0),modelLevel:null,modelReason:null},
  {level:'instant',by:'owner',reason:null,since:min(-60),modelLevel:null,modelReason:null}]);
 assert.deepEqual(['w','wm','b','a','br','p','me'].map(id=>cats(store,id)),[['instant'],['mention','instant'],['instant'],['instant'],['reply','instant'],['dm'],['dm','own']]);
 const tables=new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map(r=>r.name));
 assert.ok(!tables.has('watches'),'the watch list is gone');assert.ok(!tables.has('messages_feed'),'its index is replaced by one by chat and time');
 store.close();const again=new Store(file,{linkBase:LINK_BASE});t.after(()=>again.close());
 assert.deepEqual(['g1','g2'].map(id=>again.level(id).since),[min(0),min(-60)],'opening it again changes nothing');
});

// Every statement a call prepares, with its query plan. No ANALYZE statistics are kept (sqlite_stat1), so a plan
// does not depend on how many rows there are: an empty store plans as the live one, with hundreds of thousands of
// messages, would.
function plans(db,call){
 const sqls=[],prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){sqls.push(sql);return prepare.call(this,sql);};
 try{call();}finally{DatabaseSync.prototype.prepare=prepare;}
 return sqls.filter(s=>/^\s*(WITH|SELECT|INSERT)/i.test(s)).map(sql=>({sql,plan:db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r=>r.detail)}));
}
// A scan of the messages or of the categories (the aliases these queries give them, or their names), unless it goes
// through an index that only holds what batches take or my own messages; the processed table grows with them.
const FULL=/^SCAN (m|r|c|mc|p|messages|message_categories|processed)\b(?! USING (COVERING )?INDEX (categories_batched|messages_mine)\b)/;

test('the queries that run often go through indexes: none reads every message, and none sorts a whole chat',t=>{
 const {store,file}=tempStore(t),matters=new Matters(store);
 const ask=post(store,{text:'@原智鸿 帮忙看下',at:min(1),categories:['mention']});post(store,{mine:true,text:'我看下',at:min(2),categories:['own']});
 post(store,{text:'闲聊',at:min(3),categories:['stored'],reactions:[{key:'Get',count:1,isMine:true,userNames:['原智鸿']}]});
 matters.apply({created:[{title:'看下',who:'陈帆',ask:'看',urgency:'normal',messageIds:[ask]}],processedIds:[ask]});
 const calls={pending:()=>matters.pending(40,['x']),pendingCount:()=>matters.pendingCount(),pendingReactions:()=>matters.pendingReactions(40),
  ownerWaiting:()=>matters.ownerWaiting(),skipIgnored:()=>matters.skipIgnored(),before:()=>matters.before('g1',min(9),8),
  responses:()=>matters.responses(['g1'],min(0),min(9),5),visible:()=>matters.visible(ask),mine:()=>matters.mine(1000),me:()=>matters.me(),meId:()=>matters.meId(),
  senders:()=>matters.senders(),level:()=>store.level('g1'),chatsMissingInfo:()=>store.chatsMissingInfo(20),open:()=>new Store(file,{linkBase:LINK_BASE}).close()};
 for(const [name,call] of Object.entries(calls))for(const {sql,plan} of plans(store.db,call)){
  const full=plan.filter(l=>FULL.test(l));
  assert.deepEqual(full,[],`${name} scans:\n${sql}\n${plan.join('\n')}`);
  if(name==='before')assert.ok(!plan.some(l=>/TEMP B-TREE FOR ORDER BY/.test(l)),`${name} sorts the whole chat:\n${plan.join('\n')}`);
  // What I did in a matter's chats is read from my messages and my reactions, never from all that was said there.
  if(name==='ownerWaiting'||name==='responses')assert.ok(!plan.some(l=>/messages_by_chat/.test(l)),`${name} reads the chats:\n${sql}\n${plan.join('\n')}`);
  if(name==='chatsMissingInfo')assert.ok(!plan.some(l=>/^SCAN .*messages_by_chat/.test(l)),`${name} reads every message's chat:\n${plan.join('\n')}`);
 }
});
