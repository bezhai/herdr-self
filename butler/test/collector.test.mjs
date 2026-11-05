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
import {Matters} from '../matters.mjs';
import {FAST} from './helpers.mjs';

const cats=(store,id)=>store.message(id)?.categories;

test('pushed messages are stored by category: what is not about me as stored, and of an ignored chat only what is about me',async t=>{
 const {lark,store,running}=await setup(t);
 const dm=lark.chat({name:'张三',chatMode:'direct'}),bot=lark.chat({name:'机器人',chatMode:'direct'}),noisy=lark.chat({name:'闲聊群',memberCount:300});
 const instant=lark.chat({name:'即时的群'}),muted=lark.chat({name:'忽略的群'});
 await running();store.setLevel(instant,'instant',{by:'owner',now:lark.now()});store.setLevel(muted,'ignore',{by:'owner'});
 const mine=lark.post(noisy,{mine:true,text:'我的提问'});
 const m={dm:lark.post(dm,{text:'私聊'}),myDm:lark.post(dm,{mine:true,text:'我回私聊'}),atMe:lark.post(noisy,{atMe:true,text:'看下'}),
  atAllOnly:lark.post(noisy,{atAll:true,isAtMe:true,text:'通知'}),atAllAndMe:lark.post(noisy,{atAll:true,atMe:true,text:'通知和我'}),
  reply:lark.post(noisy,{replyTo:mine.id,text:'回复你'}),unrelated:lark.post(noisy,{text:'无关'}),instantMsg:lark.post(instant,{text:'即时群消息'}),
  ignored:lark.post(muted,{text:'忽略的群里的闲聊'}),ignoredAtMe:lark.post(muted,{atMe:true,text:'忽略的群里 @我'}),bot:lark.post(bot,{senderType:'bot',text:'机器人'})};
 await waitFor(()=>store.message(m.bot.id)&&store.message(m.atMe.id)?.chatName==='闲聊群',{message:'pushed messages and the chat name'});
 assert.deepEqual(cats(store,m.dm.id),['dm']);assert.deepEqual(cats(store,m.myDm.id),['dm','own']);assert.equal(store.message(m.myDm.id).isMine,true);
 assert.deepEqual(cats(store,m.atMe.id),['mention']);assert.deepEqual(cats(store,m.atAllAndMe.id),['mention']);assert.equal(store.message(m.atAllAndMe.id).mentionsAll,true);
 assert.deepEqual(cats(store,m.reply.id),['reply']);assert.deepEqual(cats(store,m.instantMsg.id),['instant']);
 assert.deepEqual(cats(store,m.bot.id),['instant'],'a bot\'s direct chat goes by its level, which is instant until it is graded');assert.equal(store.message(m.bot.id).senderType,'bot');
 assert.deepEqual(cats(store,mine.id),['own']);
 for(const v of [m.atAllOnly,m.unrelated])assert.deepEqual(cats(store,v.id),['stored'],v.textPreview);
 assert.equal(store.message(m.ignored.id),undefined,'nothing of an ignored chat is kept');assert.deepEqual(cats(store,m.ignoredAtMe.id),['mention'],'but what is about me');
 const r=store.message(m.atMe.id);
 assert.deepEqual({chatId:r.chatId,chatName:r.chatName,chatKind:r.chatKind,senderId:r.senderId,senderName:r.senderName,senderType:r.senderType,text:r.text,isMine:r.isMine,mentionsAll:r.mentionsAll,isRecalled:r.isRecalled,isEdited:r.isEdited,threadRole:r.threadRole},
  {chatId:noisy,chatName:'闲聊群',chatKind:'group',senderId:m.atMe.senderId,senderName:'同事',senderType:'user',text:'@我看下',isMine:false,mentionsAll:false,isRecalled:false,isEdited:false,threadRole:'none'});
 assert.deepEqual(r.parts,m.atMe.parts);assert.equal(r.createdAt,Date.parse(m.atMe.createdAt));
 assert.equal(r.link,`${LINK_BASE}/messenger/${noisy}?message=${r.id}&position=${m.atMe.position}`);
 assert.equal(store.message(m.dm.id).chatKind,'direct');
});

test('a direct chat not graded yet is instant: what a bot says there goes to the model; once the model grades it store, only what I say there does',async t=>{
 const {lark,store,running}=await setup(t);const bot=lark.chat({name:'Argos平台报警',chatMode:'direct'});await running();const matters=new Matters(store);
 const alert=lark.post(bot,{senderType:'bot',text:'告警：CPU 高'});await waitFor(()=>store.message(alert.id),{message:'the pushed alert'});
 assert.deepEqual(cats(store,alert.id),['instant']);assert.deepEqual(matters.pending(40).map(m=>m.id),[alert.id]);assert.equal(matters.pendingCount(),1);
 store.setLevel(bot,'store',{by:'model',reason:'只是监控通知',now:lark.now()});
 const later=lark.post(bot,{senderType:'bot',text:'告警恢复'}),mine=lark.post(bot,{mine:true,text:'收到'});
 await waitFor(()=>store.message(later.id)&&store.message(mine.id),{message:'what came after the grade'});
 assert.deepEqual(cats(store,later.id),['stored']);assert.deepEqual(cats(store,mine.id),['dm','own']);
 assert.deepEqual(matters.pending(40).map(m=>m.id),[alert.id,mine.id],'only kept, it never waits');assert.equal(matters.pendingCount(),2);
});

test('every message I send is stored as own, pushed or read by position, in any normal group, and a reply to it counts as a reply to me',async t=>{
 const {lark,store,running}=await setup(t);
 const dm=lark.chat({name:'张三',chatMode:'direct'}),group=lark.chat({name:'没有级别的群',memberCount:300}),other=lark.chat({name:'另一个群'});
 const c=await running();
 const pushed=lark.post(group,{mine:true,text:'收到，我今天捋一下'}),inDm=lark.post(dm,{mine:true,text:'私聊里我说的'});
 await waitFor(()=>store.message(pushed.id)&&store.message(inDm.id),{message:'my pushed messages'});
 // Written by open-lark without an event: the changed group is read by position and my message is kept.
 const quiet=lark.post(other,{mine:true,text:'只写库的我的消息'},{event:'none'}),unrelated=lark.post(other,{text:'别人的闲聊'},{event:'none'});
 await c.reconcile('periodic');
 assert.deepEqual(cats(store,pushed.id),['own']);assert.deepEqual(cats(store,quiet.id),['own']);assert.deepEqual(cats(store,inDm.id),['dm','own']);
 assert.equal(store.message(pushed.id).isMine,true);assert.deepEqual(cats(store,unrelated.id),['stored'],'others\' messages there are kept as stored');
 // A reply that does not carry who sent the message it answers: butler's own record of it says it was mine.
 const reply=lark.post(other,{replyTo:quiet.id,text:'好的'},{event:'none'});delete lark.messages.get(reply.id).replyTo;
 await c.reconcile('periodic');assert.deepEqual(cats(store,reply.id),['reply']);
});

test('a store from before own keeps my earlier messages as own too',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let store=new Store(file,{linkBase:LINK_BASE});
 const record=(id,isMine,category)=>store.upsertMessage({id,feedId:'d1',chatKind:'direct',senderId:isMine?'me':'u1',senderName:null,senderType:'user',createdAt:Date.now(),position:'1',
  threadRole:'none',rootId:null,parentId:null,replyToSenderId:null,text:'x',parts:'[]',unreadable:false,isMine,mentionsAll:false,isRecalled:false,isEdited:false,isEphemeral:false},[category]);
 // As the previous version recorded them: my message in a direct chat only as dm.
 record('1',true,'dm');record('2',false,'dm');store.close();
 store=new Store(file,{linkBase:LINK_BASE});t.after(()=>store.close());
 assert.deepEqual(cats(store,'1'),['dm','own']);assert.deepEqual(cats(store,'2'),['dm']);
});

const reactionsOf=(store,id)=>store.message(id)?.reactions;
const keys=(store,id)=>store.ownerReactions(id).map(r=>r.key);

test('reactions are kept on stored messages without who exactly reacted, and one of mine becomes an owner reaction once',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running();const v=lark.post(dm,{text:'帮忙看下'});await waitFor(()=>store.message(v.id));
 assert.deepEqual(reactionsOf(store,v.id),[]);assert.deepEqual(store.ownerReactions(v.id),[]);
 // open-lark stores them without any event here; the next read of the chat by position brings them.
 lark.react(v.id,'THUMBSUP',{name:'李四',event:false});lark.react(v.id,'THUMBSUP',{name:'王五',event:false});lark.react(v.id,'Get',{mine:true,event:false});
 lark.post(dm,{text:'下一条'},{event:'none'});const before=Date.now();await c.reconcile('periodic');
 assert.deepEqual(reactionsOf(store,v.id),[{key:'THUMBSUP',count:2,isMine:false,userNames:['李四','王五']},{key:'Get',count:1,isMine:true,userNames:['我']}]);
 const [own]=store.ownerReactions(v.id);
 assert.deepEqual([own.messageId,own.key],[v.id,'Get']);assert.ok(own.at>=before,'when butler saw it');
 lark.post(dm,{text:'再一条'},{event:'none'});await c.reconcile('periodic');
 assert.deepEqual(keys(store,v.id),['Get'],'reading it again is no new reaction of mine');
});

test('reaction.updated refreshes the reactions of a message butler holds once per burst, from open-lark\'s own store',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'}),group=lark.chat({name:'忽略的群'});
 const c=await running();store.setLevel(group,'ignore',{by:'owner'});const v=lark.post(dm,{text:'方案发你了'}),other=lark.post(group,{text:'和我无关'});
 await waitFor(()=>store.message(v.id));
 const asked=id=>lark.requests.filter(r=>r.path===`/agent/v1/messages/${id}/reactions`).length;
 // A burst: several reactions on one message, and one on a message butler does not hold.
 lark.react(v.id,'OK',{name:'李四'});lark.react(v.id,'Get',{mine:true});lark.react(v.id,'OK',{name:'王五'});lark.react(other.id,'Get',{mine:true});
 await waitFor(()=>reactionsOf(store,v.id).length===2,{message:'reactions after the event'});await sleep(50);
 assert.deepEqual(reactionsOf(store,v.id),[{key:'OK',count:2,isMine:false,userNames:['李四','王五']},{key:'Get',count:1,isMine:true,userNames:['我']}]);
 assert.equal(asked(v.id),1,'one read for the burst');assert.equal(asked(other.id),0,'none for a message butler does not hold');
 assert.equal(store.message(other.id),undefined);
 assert.ok(!lark.requests.some(r=>r.path===`/agent/v1/messages/${v.id}`),'not GET /messages/:id, which asks Lark about the chat');
 assert.deepEqual(keys(store,v.id),['Get']);
 // Taking it back only changes the current reactions; adding it again is not a second reaction of mine.
 lark.react(v.id,'Get',{mine:true,cancel:true});
 await waitFor(()=>reactionsOf(store,v.id).length===1,{message:'the cancel'});
 assert.deepEqual(reactionsOf(store,v.id),[{key:'OK',count:2,isMine:false,userNames:['李四','王五']}]);assert.deepEqual(keys(store,v.id),['Get']);
 lark.react(v.id,'Get',{mine:true});await waitFor(()=>reactionsOf(store,v.id).length===2,{message:'added again'});
 lark.react(v.id,'DONE',{mine:true});await waitFor(()=>reactionsOf(store,v.id).length===3,{message:'another key'});
 assert.deepEqual(keys(store,v.id),['Get','DONE']);
 await c.idle();assert.deepEqual(store.errors(100),[]);
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

test('reconciliation recovers what was missed while the collector was down, and keeps nothing of an ignored chat but what is about me',async t=>{
 const {lark,store,running}=await setup(t);
 const dm=lark.chat({name:'张三',chatMode:'direct'}),instant=lark.chat({name:'即时的群'}),other=lark.chat({name:'别的群'}),muted=lark.chat({name:'忽略的群'});
 const first=await running();store.setLevel(instant,'instant',{by:'owner',now:lark.now()});store.setLevel(muted,'ignore',{by:'owner'});
 const seen=lark.post(dm,{text:'停机前'}),root=lark.post(instant,{text:'即时群里的讨论'}),mine=lark.post(other,{mine:true,text:'我在别的群说话'});
 await first.reconcile('periodic');await first.stop();
 // While butler is down: open-lark stores some messages without events (backfill, gap repair) and pushes others to nobody.
 const missed=[lark.post(dm,{text:'停机时的私聊'}),lark.post(instant,{text:'停机时的即时群消息'},{event:'none'}),
  lark.post(instant,{thread:root.id,text:'停机时的话题回复'},{event:'none'}),
  lark.post(other,{atMe:true,text:'停机时@我'},{event:'none'}),lark.post(other,{replyTo:mine.id,text:'停机时回复我'},{event:'none'}),
  lark.post(muted,{atMe:true,text:'忽略的群里停机时@我'},{event:'none'})];
 const unrelated=lark.post(other,{text:'无关'},{event:'none'}),ignored=lark.post(muted,{text:'忽略的群里停机时的闲聊'},{event:'none'});
 const many=Array.from({length:130},(_,i)=>lark.post(dm,{text:`第${i}条`},{event:'none'}));
 // A chat butler has never read: from its newest messages back to when collection started, over several pages.
 const fresh=lark.chat({name:'新的私聊',chatMode:'direct'}),newDm=Array.from({length:120},(_,i)=>lark.post(fresh,{text:`新私聊${i}`},{event:'none'}));
 await running();
 for(const v of [seen,...missed,...many,...newDm])assert.ok(store.message(v.id),`missing ${v.textPreview}`);
 assert.deepEqual(cats(store,missed[2].id),['instant']);assert.deepEqual(cats(store,missed[3].id),['mention']);assert.deepEqual(cats(store,missed[4].id),['reply']);
 assert.deepEqual(cats(store,missed[5].id),['mention']);assert.equal(store.message(ignored.id),undefined);
 assert.deepEqual(cats(store,unrelated.id),['stored']);assert.deepEqual(cats(store,mine.id),['own']);
});

test('reconciliation picks up messages open-lark stored without an event while the collector runs',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'}),group=lark.chat({name:'项目群'});
 const c=await running();const mine=lark.post(group,{mine:true,text:'方案见文档'});lark.post(dm,{text:'第一条'});await c.reconcile('periodic');
 const quiet=lark.post(dm,{text:'只写库的私聊'},{event:'none'}),reply=lark.post(group,{replyTo:mine.id,text:'只写库的回复'},{event:'none'});
 await sleep(30);assert.equal(store.message(quiet.id),undefined);
 await c.reconcile('periodic');
 assert.deepEqual(cats(store,quiet.id),['dm']);assert.deepEqual(cats(store,reply.id),['reply']);
});

test('a thread reply in an instant group is reconciled even when no new main message follows it',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'即时的群'});
 const c=await running();store.setLevel(group,'instant',{by:'owner',now:lark.now()});
 const root=lark.post(group,{text:'讨论'});for(let i=0;i<6;i++)lark.post(group,{text:`后面第${i}条`});await c.reconcile('periodic');
 // Its position is <= 0 and its root is older than the rows read again, so only a page whose first row is no later
 // than the last read row brings it in, by time.
 const reply=lark.post(group,{thread:root.id,text:'话题里的新回复'},{event:'none'}),last=lark.post(group,{thread:root.id,text:'又一个回复'},{event:'none'});
 await c.reconcile('periodic');
 assert.deepEqual(cats(store,reply.id),['instant']);assert.deepEqual(cats(store,last.id),['instant']);
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
 assert.deepEqual(cats(store,root.id),['thread','own']);assert.deepEqual(cats(store,r1.id),['reply','thread']);assert.deepEqual(cats(store,r2.id),['thread']);
 const reply=store.message(r1.id);assert.equal(reply.threadRole,'reply');assert.equal(reply.rootId,root.id);
 assert.equal(reply.link,`${LINK_BASE}/messenger/${group}?message=${r1.id}&position=${root.position}&thread=${root.id}`);
 assert.ok(lark.requests.some(r=>r.path===`/agent/v1/messages/${root.id}/thread`));
 // Already known as my thread: now only the grown count of the re-sent root says there is more.
 const r3=lark.post(group,{thread:root.id,text:'后来的回复'},{event:'root-only'});
 await waitFor(()=>store.message(r3.id),{message:'reply announced only by the root'});assert.deepEqual(cats(store,r3.id),['reply','thread']);
});

test('the replies of a direct chat\'s thread are fetched back to when collection began, whatever level the chat has',async t=>{
 const {lark,store,running}=await setup(t);const bot=lark.chat({name:'发布机器人',chatMode:'direct'});const c=await running();
 const root=lark.post(bot,{senderType:'bot',text:'发布单'},{touch:false});await waitFor(()=>store.message(root.id),{message:'the root'});
 // More than a page of replies, all before the chat got its level, written without events; only fetching the thread finds them.
 const early=Array.from({length:120},(_,i)=>lark.post(bot,{thread:root.id,senderType:'bot',text:`进度${i}`},{event:'none',touch:false}));
 store.setLevel(bot,'instant',{by:'owner',now:lark.now()+1});
 const last=lark.post(bot,{thread:root.id,senderType:'bot',text:'发布完成'},{event:'root-only',touch:false});
 await waitFor(()=>store.message(last.id),{message:'the thread fetched'});await c.idle();
 assert.ok(store.message(early[0].id),'the oldest reply, two pages back');assert.deepEqual(cats(store,early[0].id),['stored']);
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
 assert.deepEqual(cats(store,root.id),['stored'],'the root came before I took part: it is only stored');
 // A topic reply that does not move the conversation entry: only the thread feed and its reply count show it.
 const later=lark.post(topic,{thread:root.id,text:'之后的回复'},{event:'none',touch:false});
 await running();
 assert.deepEqual(cats(store,later.id),['thread']);assert.deepEqual(cats(store,mine.id),['thread','own']);
});

test('the @me sweep finds a mention in a group without a level whose entry did not change',async t=>{
 const {lark,store,running}=await setup(t);const group=lark.chat({name:'大群',memberCount:2000});
 const c=await running();
 const v=lark.post(group,{atMe:true,text:'求助'},{event:'none',touch:false}),all=lark.post(group,{atAll:true,isAtMe:true,text:'全员通知'},{event:'none',touch:false});
 await c.reconcile('periodic');assert.equal(store.message(v.id),undefined,'periodic reconciliation does not see it');
 await c.reconcile('manual');
 assert.deepEqual(cats(store,v.id),['mention']);assert.deepEqual(cats(store,all.id),['stored'],'an @all the search also finds is no mention of me');
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

test('a level applies at once: a group set to instant is instant from then on and read every cycle, and once I clear it what follows is only stored',async t=>{
 const {lark,store,running}=await setup(t);const g=lark.chat({name:'新的即时群'});const c=await running();
 const before=lark.post(g,{text:'定级之前'});await waitFor(()=>store.message(before.id));
 store.setLevel(g,'instant',{by:'owner',now:lark.now()});
 const after=lark.post(g,{text:'定级之后'});await waitFor(()=>store.message(after.id));await c.reconcile('periodic');
 assert.deepEqual(cats(store,before.id),['stored'],'what came before is only stored');assert.deepEqual(cats(store,after.id),['instant']);
 // Written without an event and without moving the chat's entry: only reading the instant group every cycle finds it.
 const quiet=lark.post(g,{text:'定级之后只写库'},{event:'none',touch:false});await c.reconcile('periodic');
 assert.deepEqual(cats(store,quiet.id),['instant']);
 store.clearLevel(g);
 const removed=lark.post(g,{text:'取消之后'});await waitFor(()=>store.message(removed.id));await c.reconcile('periodic');
 const unread=lark.post(g,{text:'取消之后只写库'},{event:'none',touch:false});await c.reconcile('periodic');
 assert.deepEqual(cats(store,removed.id),['stored']);assert.equal(store.message(unread.id),undefined,'no longer read every cycle');
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

// Two messages behind: one behind is settled by asking open-lark for the last message (see the lagging-window tests).
for(const frozenAt of ['zero','the cursor'])test(`a forward read that ends below the entry's last message is not the end (window at ${frozenAt})`,async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});const c=await running();
 lark.post(dm,{text:'第一条'});await c.reconcile('periodic');const cursor=store.chat(dm).cursor;assert.ok(cursor>0);
 lark.freezeWindow(dm,frozenAt==='zero'?0:cursor);const v=lark.post(dm,{text:'窗口坏掉时的私聊'},{event:'none'}),last=lark.post(dm,{text:'又一条'},{event:'none'});
 await c.reconcile('periodic');
 assert.equal(store.chat(dm).cursor,cursor);assert.equal(store.chat(dm).dirty,true,'not settled below the last message');assert.equal(store.message(v.id),undefined);
 lark.thawWindow(dm);await c.reconcile('periodic');
 assert.deepEqual(cats(store,v.id),['dm']);assert.deepEqual(cats(store,last.id),['dm']);assert.equal(store.chat(dm).dirty,false);
});

test('a chat that cannot be read to its last message is given up after a bound with one error, until it changes again',async t=>{
 const {lark,store,running}=await setup(t);const dm=lark.chat({name:'张三',chatMode:'direct'});const c=await running();
 lark.post(dm,{text:'第一条'});await c.reconcile('periodic');
 // Two behind, as above.
 lark.freezeWindow(dm,0);lark.post(dm,{text:'读不到'},{event:'none'});lark.post(dm,{text:'也读不到'},{event:'none'});
 for(let n=1;n<c.options.readAttempts;n++){await c.reconcile('periodic');assert.equal(store.chat(dm).dirty,true);assert.equal(store.errors(100).length,0);}
 await c.reconcile('periodic');
 assert.equal(store.chat(dm).dirty,false);const errors=store.errors(100);assert.equal(errors.length,1);assert.match(errors[0].source,/张三/);
 const reads=()=>lark.requests.filter(r=>r.path===`/agent/v1/conversations/${dm}/messages`).length,before=reads();
 await c.reconcile('periodic');assert.equal(reads(),before,'given up: no more reads');
 lark.thawWindow(dm);const v=lark.post(dm,{text:'之后的私聊'},{event:'none'});await c.reconcile('periodic');assert.deepEqual(cats(store,v.id),['dm']);
});

// Live, open-lark's stored last position of a chat stayed one behind its newest message for cycles on end, in a direct
// chat with a bot whose newest message had been pushed and stored, and in a group whose newest message did not concern
// me (then not kept; a group butler keeps nothing of but what concerns me is now an ignored one). A chat read to its
// cursor, at `level` if given, whose window is then held there while `posts` arrive, each '<how>[ <kind>]': 'pushed'
// butler stores at once (it @s me, so that it does in any chat), 'quiet' (@ me as well) and 'unrelated' only open-lark
// stores; kind 'ephemeral' is a message only I see, at the position of the one before it, and 'deleted' one that Lark
// deleted.
async function laggingWindow(t,{chatMode='direct',level,posts}){
 const {lark,store,running}=await setup(t);const id=lark.chat({name:'机器人',chatMode});const c=await running();
 if(level)store.setLevel(id,level,{by:'owner',now:lark.now()});
 lark.post(id,{text:'第一条'});await c.reconcile('periodic');const cursor=store.chat(id).cursor;assert.ok(cursor>0);
 lark.freezeWindow(id,cursor);
 const views=posts.map(p=>{
  const [how,kind]=p.split(' '),v=lark.post(id,{atMe:how!=='unrelated',ephemeral:kind==='ephemeral',text:p},{event:how==='pushed'?'full':'none'});
  if(kind==='deleted')lark.remove(v.id);return {v,pushed:how==='pushed'};
 });
 for(const {v} of views.filter(x=>x.pushed))await waitFor(()=>store.message(v.id),{message:'the pushed messages'});
 const last=views.at(-1).v;
 return {store,c,id,cursor,last,asked:()=>lark.requests.filter(r=>r.path===`/agent/v1/messages/${last.id}`).length};
}
// asks: how often butler asks open-lark for the last message (GET /messages/:id) when its store does not have it.
for(const [what,options,asks] of [['a direct chat',{posts:['pushed']},0],['a direct chat two behind',{posts:['pushed','pushed']},0],
 ['an instant group',{chatMode:'group',level:'instant',posts:['pushed']},0],['a group without a level',{chatMode:'group',posts:['pushed']},0],
 ['a direct chat one behind a message it was not pushed',{posts:['quiet']},1],['an ignored group one behind a message it does not keep',{chatMode:'group',level:'ignore',posts:['unrelated']},1],
 ['a group without a level one behind a message only open-lark stored',{chatMode:'group',posts:['unrelated']},1]])
 test(`${what} whose window lags behind is read to its last message in the first cycle`,async t=>{
  const w=await laggingWindow(t,options);await w.c.reconcile('periodic');
  assert.equal(w.store.chat(w.id).dirty,false,'settled in the first cycle');assert.equal(w.store.chat(w.id).cursor,Number(w.last.position));
  assert.deepEqual(w.store.errors(100),[]);assert.equal(w.asked(),asks,'GET /messages/:id');
 });
// asks: whether butler asks open-lark for the last message in every cycle (it is not in butler's store, or not as one
// that can stand for its position).
for(const [what,options,asks] of [['a group without a level missing a position before it',{chatMode:'group',posts:['quiet','pushed']},false],
 ['a direct chat missing a position before it',{posts:['quiet','pushed']},false],
 ['an ignored group two behind messages it does not keep',{chatMode:'group',level:'ignore',posts:['unrelated','unrelated']},true],
 ['a direct chat whose missing position also holds a pushed ephemeral message',{posts:['quiet','pushed ephemeral','pushed']},false],
 ['a direct chat whose last message is ephemeral, at the missing position before it',{posts:['quiet','quiet ephemeral']},true],
 ['a direct chat whose last message is deleted',{posts:['quiet deleted']},true]])
 test(`${what} whose window lags behind is still short, and given up after the bound`,async t=>{
  const w=await laggingWindow(t,options);
  for(let n=1;n<w.c.options.readAttempts;n++){await w.c.reconcile('periodic');assert.equal(w.store.chat(w.id).dirty,true);assert.equal(w.store.chat(w.id).cursor,w.cursor);}
  await w.c.reconcile('periodic');
  assert.equal(w.store.chat(w.id).dirty,false);const errors=w.store.errors(100);assert.equal(errors.length,1);
  assert.match(errors[0].message,new RegExp(`读到 ${w.cursor} 仍没读到.*${w.last.id}`));
  assert.equal(w.asked(),asks?w.c.options.readAttempts:0,'GET /messages/:id');
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

test('topic groups are never read by position, instant ones neither; my topics come from the thread feed and @me from the sweep',async t=>{
 const {lark,store,running}=await setup(t);const topic=lark.chat({name:'话题群',chatMode:'topic'}),instantTopic=lark.chat({name:'即时的话题群',chatMode:'topic'});
 const first=await running();store.setLevel(instantTopic,'instant',{by:'owner',now:lark.now()});
 lark.freezeWindow(topic,0);lark.freezeWindow(instantTopic,0);
 const root=lark.post(topic,{text:'别人的话题'}),mine=lark.post(topic,{thread:root.id,mine:true,text:'我的回复'});
 const pushed=lark.post(instantTopic,{text:'即时的话题群里推送来的'});
 lark.emit({type:'message.upserted',feedId:topic,messageId:'sync:complete'});
 await waitFor(()=>store.message(mine.id)&&store.message(pushed.id));await first.reconcile('periodic');await first.stop();
 // While butler is down: a reply in my topic and an @me in another topic, neither moving the conversation entry.
 const later=lark.post(topic,{thread:root.id,text:'之后的回复'},{event:'none',touch:false});
 const other=lark.post(topic,{text:'另一个话题'},{event:'none',touch:false}),atMe=lark.post(topic,{thread:other.id,atMe:true,text:'@我'},{event:'none',touch:false});
 const c=await running();await c.reconcile('manual');
 assert.deepEqual(cats(store,later.id),['thread']);assert.deepEqual(cats(store,atMe.id),['mention']);assert.deepEqual(cats(store,pushed.id),['instant']);
 assert.deepEqual(lark.requests.filter(r=>r.path.endsWith('/messages')&&(r.path.includes(topic)||r.path.includes(instantTopic))).map(r=>r.path),[]);
 for(const id of [topic,instantTopic])assert.ok(!store.chat(id)?.cursor,'no cursor for a topic group');
});

test('a store from the previous version is upgraded, and a chat it left at cursor 0 is read from its tail',async t=>{
 const lark=await startFakeOpenLark(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');
 const dm=lark.chat({name:'张三',chatMode:'direct'});
 // The chats table as the deployed version created it, with a row its tail read left at cursor 0.
 const old=new DatabaseSync(file);
 old.exec(`CREATE TABLE chats(feed_id TEXT PRIMARY KEY, name TEXT, chat_mode TEXT, member_count INTEGER, is_muted INTEGER, last_active_at INTEGER,
  cursor INTEGER, signature TEXT, pending_signature TEXT, dirty INTEGER NOT NULL DEFAULT 0, gap_retries INTEGER NOT NULL DEFAULT 0)`);
 old.prepare('INSERT INTO chats(feed_id,name,chat_mode,cursor,dirty) VALUES(?,?,?,0,0)').run(dm,'张三','direct');
 // And its messages table, before is_ephemeral.
 old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, chat_kind TEXT NOT NULL, sender_id TEXT, sender_name TEXT, sender_type TEXT,
  created_at INTEGER NOT NULL, position TEXT, thread_role TEXT NOT NULL, root_id TEXT, parent_id TEXT, reply_to_sender_id TEXT, text TEXT NOT NULL, parts TEXT NOT NULL,
  unreadable INTEGER NOT NULL, is_mine INTEGER NOT NULL, mentions_all INTEGER NOT NULL, is_recalled INTEGER NOT NULL, is_edited INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
 old.prepare(`INSERT INTO messages VALUES('7100000000000000777',?,'direct','u','同事','user',?,'1','none',NULL,NULL,NULL,'旧消息','[]',0,0,0,0,0,?,?)`).run(dm,Date.now(),Date.now(),Date.now());old.close();
 const store=new Store(file,{linkBase:'http://127.0.0.1:3333'}),c=new Collector({store,url:lark.url,token:lark.token,options:FAST});
 t.after(async()=>{await c.stop();await lark.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 await c.start();await waitFor(()=>c.connected);await c.idle();
 const v=lark.post(dm,{text:'升级后的私聊'},{event:'none'});await c.reconcile('periodic');
 const reads=lark.requests.filter(r=>r.path===`/agent/v1/conversations/${dm}/messages`);
 assert.ok(reads.length>=1);assert.equal(reads[0].query.tail,'1','read from the tail, not forward from 0');assert.ok(!reads.some(r=>r.query.afterPosition==='0'));
 assert.deepEqual(cats(store,v.id),['dm']);assert.equal(store.chat(dm).cursor,Number(v.position));
 assert.equal(store.chat(dm).dirty,false);assert.equal(store.chat(dm).name,'张三');assert.deepEqual(store.errors(100),[]);
 assert.deepEqual(store.message('7100000000000000777').reactions,[],'a message from before reactions has none');
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
 const c=await running();store.setLevel(group,'instant',{by:'owner',now:lark.now()});
 const root=lark.post(group,{mine:true,text:'讨论'});lark.post(group,{thread:root.id,text:'回复'},{event:'root-only'});
 lark.post(dm,{text:'私聊'},{event:'bare'});lark.post(topic,{atMe:true,text:'@我'},{event:'none',touch:false});
 const t1=lark.post(topic,{text:'话题'});lark.post(topic,{thread:t1.id,mine:true,text:'我回'});
 await waitFor(()=>store.message(root.id));lark.react(root.id,'Get',{mine:true});
 await waitFor(()=>lark.requests.some(r=>r.path===`/agent/v1/messages/${root.id}/reactions`),{message:'the reactions read'});
 await c.reconcile('manual');await c.idle();
 assert.ok(lark.requests.length>10);
 assert.deepEqual(lark.writes(),[]);assert.deepEqual(lark.requests.filter(r=>r.path.includes('/pins')),[]);
 assert.deepEqual(new Set(lark.requests.filter(r=>r.method!=='GET').map(r=>r.path)),new Set(['/agent/v1/search/mention-history']));
 for(const [method,path] of [['POST','/conversations/1/messages'],['PATCH','/messages/1'],['DELETE','/messages/1'],['GET','/conversations/1/pins'],['POST','/search/page']])
  assert.throws(()=>readOnly(method,path),/只读/);
 assert.doesNotThrow(()=>readOnly('POST','/search/mention-history'));assert.doesNotThrow(()=>readOnly('GET','/conversations/1/messages'));
 assert.ok(REQUIRED_ROUTES.every(r=>CATALOG.some(c=>`${c.method} ${c.path}`===r)));
});
