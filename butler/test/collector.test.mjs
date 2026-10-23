import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,waitFor,sleep,LINK_BASE} from './helpers.mjs';
import {CATALOG} from './fake-open-lark.mjs';
import {readOnly,REQUIRED_ROUTES} from '../open-lark.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startFakeOpenLark} from './fake-open-lark.mjs';
import {Store} from '../store.mjs';
import {Collector} from '../collector.mjs';
import {FAST} from './helpers.mjs';

const cats=(store,id)=>store.message(id)?.categories;

test('pushed messages are stored by category; unrelated group messages and @all alone are not',async t=>{
 const {lark,store,running}=await setup(t);
 const dm=lark.chat({name:'张三',chatMode:'direct'}),noisy=lark.chat({name:'闲聊群',memberCount:300}),watched=lark.chat({name:'关注的群'});
 await running();store.watch(watched,lark.now());
 const mine=lark.post(noisy,{mine:true,text:'我的提问'});
 const m={dm:lark.post(dm,{text:'私聊'}),myDm:lark.post(dm,{mine:true,text:'我回私聊'}),atMe:lark.post(noisy,{atMe:true,text:'看下'}),
  atAllOnly:lark.post(noisy,{atAll:true,isAtMe:true,text:'通知'}),atAllAndMe:lark.post(noisy,{atAll:true,atMe:true,text:'通知和我'}),
  reply:lark.post(noisy,{replyTo:mine.id,text:'回复你'}),unrelated:lark.post(noisy,{text:'无关'}),watchedMsg:lark.post(watched,{text:'关注群消息'}),bot:lark.post(dm,{senderType:'bot',text:'机器人'})};
 await waitFor(()=>store.message(m.bot.id)&&store.message(m.atMe.id)?.chatName==='闲聊群',{message:'pushed messages and the chat name'});
 assert.deepEqual(cats(store,m.dm.id),['dm']);assert.deepEqual(cats(store,m.myDm.id),['dm']);assert.equal(store.message(m.myDm.id).isMine,true);
 assert.deepEqual(cats(store,m.atMe.id),['mention']);assert.deepEqual(cats(store,m.atAllAndMe.id),['mention']);assert.equal(store.message(m.atAllAndMe.id).mentionsAll,true);
 assert.deepEqual(cats(store,m.reply.id),['reply']);assert.deepEqual(cats(store,m.watchedMsg.id),['watched']);assert.equal(store.message(m.bot.id).senderType,'bot');
 for(const v of [mine,m.atAllOnly,m.unrelated])assert.equal(store.message(v.id),undefined,v.textPreview);
 const r=store.message(m.atMe.id);
 assert.deepEqual({chatId:r.chatId,chatName:r.chatName,chatKind:r.chatKind,senderId:r.senderId,senderName:r.senderName,senderType:r.senderType,text:r.text,isMine:r.isMine,mentionsAll:r.mentionsAll,isRecalled:r.isRecalled,isEdited:r.isEdited,threadRole:r.threadRole},
  {chatId:noisy,chatName:'闲聊群',chatKind:'group',senderId:m.atMe.senderId,senderName:'同事',senderType:'user',text:'@我看下',isMine:false,mentionsAll:false,isRecalled:false,isEdited:false,threadRole:'none'});
 assert.deepEqual(r.parts,m.atMe.parts);assert.equal(r.createdAt,Date.parse(m.atMe.createdAt));
 assert.equal(r.link,`${LINK_BASE}/messenger/${noisy}?message=${r.id}&position=${m.atMe.position}`);
 assert.equal(store.message(m.dm.id).chatKind,'direct');
});

test('a message pushed twice is stored once; edits and recalls update that record',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});await running();
 const v=lark.post(dm,{text:'原文'});lark.emit({type:'message.upserted',feedId:dm,messageId:v.id,message:v});
 lark.emit({type:'message.upserted',feedId:dm,messageId:'sync:complete'});
 await waitFor(()=>store.message(v.id));await sleep(30);
 assert.equal(store.counts().total,1);
 lark.edit(v.id,'改过的');await waitFor(()=>store.message(v.id).text==='改过的');assert.equal(store.message(v.id).isEdited,true);
 lark.recall(v.id);await waitFor(()=>store.message(v.id).isRecalled);
 // The record follows open-lark's view of the recalled message (here: no retained content).
 await waitFor(()=>store.message(v.id).text==='',{message:'recalled view'});
 assert.equal(store.counts().total,1);assert.deepEqual(cats(store,v.id),['dm']);
 // A page read before the recall arrived does not bring the old content back.
 lark.messages.get(v.id).isRecalled=false;lark.messages.get(v.id).parts=[{kind:'text',text:'旧内容'}];
 lark.emit({type:'message.upserted',feedId:dm,messageId:v.id,message:lark.messages.get(v.id)});await sleep(30);
 assert.equal(store.message(v.id).text,'');assert.equal(store.message(v.id).isRecalled,true);
});

test('an event without its message is completed with GET /messages/:id',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});await running();
 const v=lark.post(dm,{text:'只有 id 的推送'},{event:'bare'});
 await waitFor(()=>store.message(v.id));assert.equal(store.message(v.id).text,'只有 id 的推送');
 assert.ok(lark.requests.some(r=>r.path===`/agent/v1/messages/${v.id}`));
});

test('reconciliation recovers what was missed while the collector was down, without storing unrelated messages',async t=>{
 const {lark,store,running}=await setup(t);
 const dm=lark.chat({name:'张三',chatMode:'direct'}),watched=lark.chat({name:'关注的群'}),other=lark.chat({name:'别的群'});
 const first=await running();store.watch(watched,lark.now());
 const seen=lark.post(dm,{text:'停机前'}),root=lark.post(watched,{text:'关注群里的讨论'}),mine=lark.post(other,{mine:true,text:'我在别的群说话'});
 await first.reconcile('periodic');await first.stop();
 // While butler is down: open-lark stores some messages without events (backfill, gap repair) and pushes others to nobody.
 const missed=[lark.post(dm,{text:'停机时的私聊'}),lark.post(watched,{text:'停机时的关注群消息'},{event:'none'}),
  lark.post(watched,{thread:root.id,text:'停机时的话题回复'},{event:'none'}),
  lark.post(other,{atMe:true,text:'停机时@我'},{event:'none'}),lark.post(other,{replyTo:mine.id,text:'停机时回复我'},{event:'none'})];
 const unrelated=lark.post(other,{text:'无关'},{event:'none'});
 const many=Array.from({length:130},(_,i)=>lark.post(dm,{text:`第${i}条`},{event:'none'}));
 // A chat butler has never read: from its newest messages back to when collection started, over several pages.
 const fresh=lark.chat({name:'新的私聊',chatMode:'direct'}),newDm=Array.from({length:120},(_,i)=>lark.post(fresh,{text:`新私聊${i}`},{event:'none'}));
 await running();
 for(const v of [seen,...missed,...many,...newDm])assert.ok(store.message(v.id),`missing ${v.textPreview}`);
 assert.deepEqual(cats(store,missed[2].id),['watched']);assert.deepEqual(cats(store,missed[3].id),['mention']);assert.deepEqual(cats(store,missed[4].id),['reply']);
 assert.equal(store.message(unrelated.id),undefined);assert.equal(store.message(mine.id),undefined);
});

test('reconciliation picks up messages open-lark stored without an event while the collector runs',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'}),group=lark.chat({name:'项目群'});
 const c=await running();const mine=lark.post(group,{mine:true,text:'方案见文档'});lark.post(dm,{text:'第一条'});await c.reconcile('periodic');
 const quiet=lark.post(dm,{text:'只写库的私聊'},{event:'none'}),reply=lark.post(group,{replyTo:mine.id,text:'只写库的回复'},{event:'none'});
 await sleep(30);assert.equal(store.message(quiet.id),undefined);
 await c.reconcile('periodic');
 assert.deepEqual(cats(store,quiet.id),['dm']);assert.deepEqual(cats(store,reply.id),['reply']);
});

test('a thread reply in a watched group is reconciled even when no new main message follows it',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'关注的群'});
 const c=await running();store.watch(group,lark.now());
 const root=lark.post(group,{text:'讨论'});for(let i=0;i<6;i++)lark.post(group,{text:`后面第${i}条`});await c.reconcile('periodic');
 // Its position is <= 0 and its root is older than the rows read again, so only a page whose first row is no later
 // than the last read row brings it in, by time.
 const reply=lark.post(group,{thread:root.id,text:'话题里的新回复'},{event:'none'}),last=lark.post(group,{thread:root.id,text:'又一个回复'},{event:'none'});
 await c.reconcile('periodic');
 assert.deepEqual(cats(store,reply.id),['watched']);assert.deepEqual(cats(store,last.id),['watched']);
});

test('after an open-lark restart the event socket reconnects and reconciliation catches up',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running();lark.post(dm,{text:'重启前'});await c.reconcile('periodic');
 lark.goDown();await waitFor(()=>!c.connected,{message:'disconnect'});
 // open-lark replays its startup backlog before the agent port listens: those events reach nobody.
 const lost=lark.post(dm,{text:'重启期间'});
 await sleep(60);lark.up();
 await waitFor(()=>store.message(lost.id),{message:'catch-up after reconnect'});
 assert.equal(c.connected,true);
});

test('a changed reply count fetches the replies of a thread I started',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'项目群'});await running();
 const root=lark.post(group,{mine:true,text:'我发起的讨论'});
 // A background thread sync stores replies without events and only sends the root again with its new count.
 const r1=lark.post(group,{thread:root.id,text:'第一个回复'},{event:'root-only'}),r2=lark.post(group,{thread:root.id,replyTo:r1.id,text:'回复第一个回复'},{event:'root-only'});
 await waitFor(()=>store.message(r2.id),{message:'thread replies'});
 assert.deepEqual(cats(store,root.id),['thread']);assert.deepEqual(cats(store,r1.id),['reply','thread']);assert.deepEqual(cats(store,r2.id),['thread']);
 const reply=store.message(r1.id);assert.equal(reply.threadRole,'reply');assert.equal(reply.rootId,root.id);
 assert.equal(reply.link,`${LINK_BASE}/messenger/${group}?message=${r1.id}&position=${root.position}&thread=${root.id}`);
 assert.ok(lark.requests.some(r=>r.path===`/agent/v1/messages/${root.id}/thread`));
 // Already known as my thread: now only the grown count of the re-sent root says there is more.
 const r3=lark.post(group,{thread:root.id,text:'后来的回复'},{event:'root-only'});
 await waitFor(()=>store.message(r3.id),{message:'reply announced only by the root'});assert.deepEqual(cats(store,r3.id),['reply','thread']);
});

test('a reply count announced while its thread is being fetched is fetched too',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'项目群'});const c=await running();
 const root=lark.post(group,{mine:true,text:'讨论'}),path=`/agent/v1/messages/${root.id}/thread`;
 lark.delay(path,150);lark.post(group,{thread:root.id,text:'第一个回复'},{event:'root-only'});
 await waitFor(()=>lark.requests.some(r=>r.path===path),{message:'first thread request'});
 // The root is announced again while the first answer, without this reply, is still on its way.
 const late=lark.post(group,{thread:root.id,text:'取回复时才同步到的'},{event:'root-only'});
 await waitFor(()=>store.message(late.id),{message:'the reply announced during the fetch'});await c.idle();
});

// A thread of mine whose fetch fails with `status`: announced by a background sync, the first fetch already failed.
async function failingThread(t,status){
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'项目群'}),dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running(),root=lark.post(group,{mine:true,text:'讨论'}),path=`/agent/v1/messages/${root.id}/thread`;
 lark.fail(path,status);lark.post(group,{thread:root.id,text:'回复'},{event:'root-only'});
 await waitFor(()=>lark.requests.some(r=>r.path===path),{message:'first thread request'});await c.idle();
 return {lark,store,c,group,root,dm,requests:()=>lark.requests.filter(r=>r.path===path).length,
  errors:()=>store.errors(100).filter(e=>e.source.includes(root.id))};
}
for(const status of [404,500])test(`a burst of pushed messages does not retry a thread that failed with ${status}`,async t=>{
 const f=await failingThread(t,status);
 for(let i=0;i<20;i++){f.lark.post(f.dm,{text:`消息${i}`});await sleep(15);}
 await waitFor(()=>f.store.counts().dm===20);await sleep(50);await f.c.idle();
 assert.equal(f.requests(),1);
});
for(const status of [403,404])test(`a ${status} on a thread settles it with one error`,async t=>{
 const f=await failingThread(t,status);
 assert.equal(f.store.thread(f.root.id).stale,false);assert.equal(f.errors().length,1);
 await f.c.reconcile('periodic');await f.c.reconcile('manual');
 assert.equal(f.requests(),1,'neither cycles nor the thread feed ask again');assert.equal(f.errors().length,1);
});
test('a thread that keeps failing is retried by cycles only and given up after a bound',async t=>{
 const f=await failingThread(t,500),bound=f.c.options.threadAttempts;
 assert.equal(f.errors().length,0,'a failed attempt is not yet an error');
 for(let n=2;n<=bound;n++){assert.equal(f.store.thread(f.root.id).stale,true);await f.c.reconcile('periodic');assert.equal(f.requests(),n);}
 assert.equal(f.store.thread(f.root.id).stale,false,'given up');assert.equal(f.errors().length,1);assert.match(f.errors()[0].message,/放弃/);
 await f.c.reconcile('periodic');await f.c.reconcile('manual');assert.equal(f.requests(),bound);
 // More replies announced later are new work: fetched again, and now it works.
 f.lark.failures=[];const r=f.lark.post(f.group,{thread:f.root.id,text:'后来的回复'},{event:'root-only'});
 await waitFor(()=>f.store.message(r.id),{message:'fetch after new replies'});
});

test('the thread feed finds new replies in a topic I took part in while the collector was down',async t=>{
 const {lark,store,running}=await setup(t);const topic=lark.chat({name:'话题群',chatMode:'topic'});
 const first=await running();const root=lark.post(topic,{text:'别人的话题'}),mine=lark.post(topic,{thread:root.id,mine:true,text:'我的回复'});
 await waitFor(()=>store.message(mine.id));await first.reconcile('periodic');await first.stop();
 assert.equal(store.message(root.id),undefined,'the root came before I took part');
 // A topic reply that does not move the conversation entry: only the thread feed and its reply count show it.
 const later=lark.post(topic,{thread:root.id,text:'之后的回复'},{event:'none',touch:false});
 await running();
 assert.deepEqual(cats(store,later.id),['thread']);assert.deepEqual(cats(store,mine.id),['thread']);
});

test('the @me sweep finds a mention in a group that is not watched and whose entry did not change',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'大群',memberCount:2000});
 const c=await running();
 const v=lark.post(group,{atMe:true,text:'求助'},{event:'none',touch:false}),all=lark.post(group,{atAll:true,isAtMe:true,text:'全员通知'},{event:'none',touch:false});
 await c.reconcile('periodic');assert.equal(store.message(v.id),undefined,'periodic reconciliation does not see it');
 await c.reconcile('manual');
 assert.deepEqual(cats(store,v.id),['mention']);assert.equal(store.message(all.id),undefined);
 assert.equal(store.message(v.id).chatName,'大群','named in the same cycle that found it');
 const sweep=lark.requests.filter(r=>r.path==='/agent/v1/search/mention-history').at(-1);
 assert.equal(typeof sweep.body.startTime,'number');assert.equal(typeof sweep.body.endTime,'number');assert.ok(sweep.body.limit<=50);
});

test('a failed upstream @me search is an error and does not move the sweep window',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'大群'});
 const c=await running();const swept=store.meta('mentions.sweptUntil');assert.ok(swept);
 const v=lark.post(group,{atMe:true,text:'搜索失败时的@我'},{event:'none',touch:false});
 lark.searchFails=true;await c.reconcile('manual');
 assert.match(store.status().errors[0].message,/搜索失败/);assert.equal(store.meta('mentions.sweptUntil'),swept);assert.equal(store.message(v.id),undefined);
 lark.searchFails=false;await c.reconcile('manual');assert.deepEqual(cats(store,v.id),['mention']);
});

test('a mention open-lark has not stored yet is resolved around its position or retried later',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'大群'}),other=lark.chat({name:'另一个群'});
 const c=await running();const root=lark.post(other,{text:'话题'},{event:'none',touch:false});
 const v=lark.post(group,{atMe:true,text:'在主序列里'},{event:'none',touch:false,stored:false});
 const r=lark.post(other,{thread:root.id,atMe:true,text:'在话题里'},{event:'none',touch:false,stored:false});
 await c.reconcile('manual');
 assert.deepEqual(cats(store,v.id),['mention']);assert.equal(store.message(r.id),undefined);assert.equal(store.status().pendingMentions,1);
 lark.notStored.delete(r.id);await c.reconcile('periodic');
 assert.deepEqual(cats(store,r.id),['mention']);assert.equal(store.status().pendingMentions,0);
});

test('watch list changes apply at once and a newly watched group is collected from when it was added',async t=>{
 const {lark,store,running}=await setup(t);const g=lark.chat({name:'新关注群'});const c=await running();
 const before=lark.post(g,{text:'加入前'});await c.idle();await sleep(30);
 store.watch(g,lark.now());
 const after=lark.post(g,{text:'加入后'});await waitFor(()=>store.message(after.id));
 assert.deepEqual(cats(store,after.id),['watched']);
 const quiet=lark.post(g,{text:'加入后只写库'},{event:'none'});await c.reconcile('periodic');
 assert.deepEqual(cats(store,quiet.id),['watched']);assert.equal(store.message(before.id),undefined);
 store.unwatch(g);
 const removed=lark.post(g,{text:'移出后'});lark.post(g,{text:'移出后只写库'},{event:'none'});await c.reconcile('periodic');await sleep(30);
 assert.equal(store.message(removed.id),undefined);assert.equal(store.counts().total,2);
});

test('open-lark not live holds the reconciliation watermark until sync returns to live',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running();lark.post(dm,{text:'第一条'});await c.reconcile('periodic');
 lark.setSync('degraded','polling');await sleep(5);const createdWhilePolling=Date.now();await sleep(5);
 await c.reconcile('periodic');await sleep(5);await c.reconcile('periodic');
 // open-lark only now stores a message created while it was polling; the chat's rank is that older time.
 const v=lark.post(dm,{text:'轮询期间的消息',at:createdWhilePolling},{event:'none'});
 lark.setSync('live','frontier');
 await waitFor(()=>store.message(v.id),{message:'reconcile on sync live'});
});

test('a gap reported by open-lark keeps the chat for later cycles, then is skipped with one error',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running();lark.post(dm,{text:'第一条'});await c.reconcile('periodic');const cursor=store.chat(dm).cursor;
 lark.gaps.add(dm);lark.post(dm,{text:'缺口旁边'},{event:'none'});await c.reconcile('periodic');
 assert.equal(store.chat(dm).dirty,true);assert.equal(store.chat(dm).cursor,cursor);assert.equal(store.errors(100).length,0);
 lark.gaps.delete(dm);await c.reconcile('periodic');assert.equal(store.chat(dm).dirty,false);assert.ok(store.chat(dm).cursor>cursor);
 // A gap that stays: after the bound one error, and the cursor moves past it so the next read does not stop there again.
 lark.gaps.add(dm);const v=lark.post(dm,{text:'一直有缺口'},{event:'none'});
 for(let n=0;n<c.options.readAttempts;n++)await c.reconcile('periodic');
 assert.equal(store.chat(dm).dirty,false);assert.equal(store.errors(100).length,1);assert.match(store.errors(1)[0].message,/缺口/);
 assert.equal(store.chat(dm).cursor,Number(v.position));
});

// open-lark's message window comes from its stored last position of the chat, which its feed refresh sets to 0 for
// topic groups. Live, that gave a tail page with only the chat's position-0 message and no maxPosition, and forward
// pages that were empty with hasNewer:false while newer messages existed.
test('a tail page without a positive maxPosition is not a read: the chat stays unread for later cycles',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});const c=await running();
 lark.freezeWindow(dm,0);const v=lark.post(dm,{text:'窗口坏掉时的私聊'},{event:'none'});
 await c.reconcile('periodic');
 assert.equal(store.chat(dm).cursor,null);assert.equal(store.chat(dm).dirty,true);assert.equal(store.message(v.id),undefined);assert.equal(store.errors(100).length,0);
 lark.thawWindow(dm);await c.reconcile('periodic');
 assert.equal(store.chat(dm).cursor,Number(v.position));assert.equal(store.chat(dm).dirty,false);assert.deepEqual(cats(store,v.id),['dm']);
});

for(const frozenAt of ['zero','the cursor'])test(`a forward read that ends below the entry's last message is not the end (window at ${frozenAt})`,async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});const c=await running();
 lark.post(dm,{text:'第一条'});await c.reconcile('periodic');const cursor=store.chat(dm).cursor;assert.ok(cursor>0);
 lark.freezeWindow(dm,frozenAt==='zero'?0:cursor);const v=lark.post(dm,{text:'窗口坏掉时的私聊'},{event:'none'});
 await c.reconcile('periodic');
 assert.equal(store.chat(dm).cursor,cursor);assert.equal(store.chat(dm).dirty,true,'not settled below the last message');assert.equal(store.message(v.id),undefined);
 lark.thawWindow(dm);await c.reconcile('periodic');
 assert.deepEqual(cats(store,v.id),['dm']);assert.equal(store.chat(dm).dirty,false);
});

test('a chat that cannot be read to its last message is given up after a bound with one error, until it changes again',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});const c=await running();
 lark.post(dm,{text:'第一条'});await c.reconcile('periodic');
 lark.freezeWindow(dm,0);lark.post(dm,{text:'读不到'},{event:'none'});
 for(let n=1;n<c.options.readAttempts;n++){await c.reconcile('periodic');assert.equal(store.chat(dm).dirty,true);assert.equal(store.errors(100).length,0);}
 await c.reconcile('periodic');
 assert.equal(store.chat(dm).dirty,false);const errors=store.errors(100);assert.equal(errors.length,1);assert.match(errors[0].source,/张三/);
 const reads=()=>lark.requests.filter(r=>r.path===`/agent/v1/conversations/${dm}/messages`).length,before=reads();
 await c.reconcile('periodic');assert.equal(reads(),before,'given up: no more reads');
 lark.thawWindow(dm);const v=lark.post(dm,{text:'之后的私聊'},{event:'none'});await c.reconcile('periodic');assert.deepEqual(cats(store,v.id),['dm']);
});

// Live, open-lark's stored last position of a direct chat with a bot stayed one behind its newest message for cycles on
// end, while that message had been pushed and stored. A chat read to its cursor whose window is then held there while
// `posts` arrive: 'pushed' ones butler stores at once (they @ me, so that it does in any chat), 'quiet' ones only open-lark.
async function laggingWindow(t,{chatMode='direct',watched=false,posts}){
 const {lark,store,running}=await setup(t);const id=lark.chat({name:'机器人',chatMode});const c=await running();
 if(watched)store.watch(id,lark.now());
 lark.post(id,{text:'第一条'});await c.reconcile('periodic');const cursor=store.chat(id).cursor;assert.ok(cursor>0);
 lark.freezeWindow(id,cursor);
 const last=posts.map(p=>lark.post(id,{atMe:true,text:p},{event:p==='pushed'?'full':'none'})).at(-1);
 await waitFor(()=>store.message(last.id),{message:'the pushed message'});
 return {store,c,id,cursor,last,asked:()=>lark.requests.some(r=>r.path===`/agent/v1/messages/${last.id}`)};
}
for(const [what,options] of [['a direct chat',{posts:['pushed']}],['a direct chat two behind',{posts:['pushed','pushed']}],['a watched group',{chatMode:'group',watched:true,posts:['pushed']}],['a group that is not watched',{chatMode:'group',posts:['pushed']}]])
 test(`${what} whose window lags behind messages butler stored is read to its last message without asking open-lark for it`,async t=>{
  const w=await laggingWindow(t,options);await w.c.reconcile('periodic');
  assert.equal(w.store.chat(w.id).dirty,false,'settled in the first cycle');assert.equal(w.store.chat(w.id).cursor,Number(w.last.position));
  assert.deepEqual(w.store.errors(100),[]);assert.equal(w.asked(),false,'no GET /messages/:id');
 });
for(const [what,options] of [['a group that is not watched missing a position before it',{chatMode:'group',posts:['quiet','pushed']}],['a direct chat missing a position before it',{posts:['quiet','pushed']}]])
 test(`${what} whose window lags behind its stored last message is still short, and given up after the bound`,async t=>{
  const w=await laggingWindow(t,options);
  for(let n=1;n<w.c.options.readAttempts;n++){await w.c.reconcile('periodic');assert.equal(w.store.chat(w.id).dirty,true);assert.equal(w.store.chat(w.id).cursor,w.cursor);}
  await w.c.reconcile('periodic');
  assert.equal(w.store.chat(w.id).dirty,false);const errors=w.store.errors(100);assert.equal(errors.length,1);
  assert.match(errors[0].message,new RegExp(`读到 ${w.cursor} 仍没读到.*${w.last.id}`));
  assert.equal(w.asked(),false,'butler\'s store has its position: no GET /messages/:id');
 });

test('one chat reads at most a few pages per cycle and goes on in the next',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});const c=await running();
 lark.post(dm,{text:'第一条'});await c.reconcile('periodic');
 const many=Array.from({length:700},(_,i)=>lark.post(dm,{text:`第${i}条`},{event:'none'}));
 const reads=()=>lark.requests.filter(r=>r.path===`/agent/v1/conversations/${dm}/messages`).length,before=reads();
 await c.reconcile('periodic');
 assert.ok(reads()-before<=5,`${reads()-before} pages in one cycle`);assert.equal(store.chat(dm).dirty,true);
 await c.reconcile('periodic');await c.reconcile('periodic');
 assert.equal(store.chat(dm).dirty,false);for(const v of many)assert.ok(store.message(v.id),v.textPreview);
});

test('topic groups are never read by position; my topics come from the thread feed and @me from the sweep',async t=>{
 const {lark,store,running}=await setup(t);const topic=lark.chat({name:'话题群',chatMode:'topic'}),watchedTopic=lark.chat({name:'关注的话题群',chatMode:'topic'});
 const first=await running();store.watch(watchedTopic,lark.now());
 lark.freezeWindow(topic,0);lark.freezeWindow(watchedTopic,0);
 const root=lark.post(topic,{text:'别人的话题'}),mine=lark.post(topic,{thread:root.id,mine:true,text:'我的回复'});
 const pushed=lark.post(watchedTopic,{text:'关注的话题群里推送来的'});
 lark.emit({type:'message.upserted',feedId:topic,messageId:'sync:complete'});
 await waitFor(()=>store.message(mine.id)&&store.message(pushed.id));await first.reconcile('periodic');await first.stop();
 // While butler is down: a reply in my topic and an @me in another topic, neither moving the conversation entry.
 const later=lark.post(topic,{thread:root.id,text:'之后的回复'},{event:'none',touch:false});
 const other=lark.post(topic,{text:'另一个话题'},{event:'none',touch:false}),atMe=lark.post(topic,{thread:other.id,atMe:true,text:'@我'},{event:'none',touch:false});
 const c=await running();await c.reconcile('manual');
 assert.deepEqual(cats(store,later.id),['thread']);assert.deepEqual(cats(store,atMe.id),['mention']);assert.deepEqual(cats(store,pushed.id),['watched']);
 assert.deepEqual(lark.requests.filter(r=>r.path.endsWith('/messages')&&(r.path.includes(topic)||r.path.includes(watchedTopic))).map(r=>r.path),[]);
 for(const id of [topic,watchedTopic])assert.ok(!store.chat(id)?.cursor,'no cursor for a topic group');
});

test('a store from the previous version is upgraded, and a chat it left at cursor 0 is read from its tail',async t=>{
 const lark=await startFakeOpenLark(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');
 const dm=lark.chat({name:'张三',chatMode:'direct'});
 // The chats table as the deployed version created it, with a row its tail read left at cursor 0.
 const old=new DatabaseSync(file);
 old.exec(`CREATE TABLE chats(feed_id TEXT PRIMARY KEY, name TEXT, chat_mode TEXT, member_count INTEGER, is_muted INTEGER, last_active_at INTEGER,
  cursor INTEGER, signature TEXT, pending_signature TEXT, dirty INTEGER NOT NULL DEFAULT 0, gap_retries INTEGER NOT NULL DEFAULT 0)`);
 old.prepare('INSERT INTO chats(feed_id,name,chat_mode,cursor,dirty) VALUES(?,?,?,0,0)').run(dm,'张三','direct');old.close();
 const store=new Store(file,{linkBase:'http://127.0.0.1:3333'}),c=new Collector({store,url:lark.url,token:lark.token,options:FAST});
 t.after(async()=>{await c.stop();await lark.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 await c.start();await waitFor(()=>c.connected);await c.idle();
 const v=lark.post(dm,{text:'升级后的私聊'},{event:'none'});await c.reconcile('periodic');
 const reads=lark.requests.filter(r=>r.path===`/agent/v1/conversations/${dm}/messages`);
 assert.ok(reads.length>=1);assert.equal(reads[0].query.tail,'1','read from the tail, not forward from 0');assert.ok(!reads.some(r=>r.query.afterPosition==='0'));
 assert.deepEqual(cats(store,v.id),['dm']);assert.equal(store.chat(dm).cursor,Number(v.position));
 assert.equal(store.chat(dm).dirty,false);assert.equal(store.chat(dm).name,'张三');assert.deepEqual(store.errors(100),[]);
});


test('status shows the event socket, reconciliation times, open-lark sync and recent errors',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running(),t0=Date.now(),v=lark.post(dm,{text:'x'});await waitFor(()=>store.message(v.id));
 lark.fail(`/conversations/${dm}/messages`,500,1);lark.post(dm,{text:'y'},{event:'none'});
 await c.reconcile('periodic');c.flushStatus();
 let s=store.status();
 assert.equal(s.events.connected,true);assert.ok(s.events.lastEventAt>=t0);
 assert.ok(s.reconcile.lastFinishedAt>=s.reconcile.lastStartedAt);assert.equal(s.reconcile.lastErrors,1);
 assert.match(s.errors[0].message,/500/);assert.equal(s.sync.state,'live');assert.equal(s.sync.mode,'frontier');assert.equal(s.counts.dm,1);
 const failedAt=s.reconcile.lastFinishedAt;await sleep(5);await c.reconcile('periodic');s=store.status();
 assert.equal(s.reconcile.lastErrors,0);assert.ok(s.reconcile.lastSuccessAt>failedAt);assert.equal(s.counts.dm,2);
});

test('startup waits until open-lark offers every route it needs',async t=>{
 const {lark,store,collector}=await setup(t);
 lark.routes=lark.routes.filter(r=>r.path!=='/agent/v1/messages/:messageId/thread');
 const c=collector();const started=c.start();
 await waitFor(()=>store.status().errors.some(e=>/缺少.*thread/.test(e.message)),{message:'missing route error'});
 assert.equal(c.connected,false);
 lark.routes=structuredClone(CATALOG);await started;await waitFor(()=>c.connected);
});

test('the collector only reads: no write route and never the pins route',async t=>{
 const {lark,store,running}=await setup(t);
 const dm=lark.chat({name:'张三',chatMode:'direct'}),group=lark.chat({name:'项目群'}),topic=lark.chat({name:'话题群',chatMode:'topic'});
 const c=await running();store.watch(group,lark.now());
 const root=lark.post(group,{mine:true,text:'讨论'});lark.post(group,{thread:root.id,text:'回复'},{event:'root-only'});
 lark.post(dm,{text:'私聊'},{event:'bare'});lark.post(topic,{atMe:true,text:'@我'},{event:'none',touch:false});
 const t1=lark.post(topic,{text:'话题'});lark.post(topic,{thread:t1.id,mine:true,text:'我回'});
 await c.reconcile('manual');await c.idle();
 assert.ok(lark.requests.length>10);
 assert.deepEqual(lark.writes(),[]);assert.deepEqual(lark.requests.filter(r=>r.path.includes('/pins')),[]);
 assert.deepEqual(new Set(lark.requests.filter(r=>r.method!=='GET').map(r=>r.path)),new Set(['/agent/v1/search/mention-history']));
 for(const [method,path] of [['POST','/conversations/1/messages'],['PATCH','/messages/1'],['DELETE','/messages/1'],['GET','/conversations/1/pins'],['POST','/search/page']])
  assert.throws(()=>readOnly(method,path),/只读/);
 assert.doesNotThrow(()=>readOnly('POST','/search/mention-history'));assert.doesNotThrow(()=>readOnly('GET','/conversations/1/messages'));
 assert.ok(REQUIRED_ROUTES.every(r=>CATALOG.some(c=>`${c.method} ${c.path}`===r)));
});
