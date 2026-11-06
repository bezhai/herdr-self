import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post,waitFor} from './helpers.mjs';
import {Matters} from '../matters.mjs';
import {Topics} from '../topics.mjs';
import {Reader,DEFAULTS,readingSystemPrompt} from '../reading.mjs';

process.env.TZ='Asia/Shanghai';
const DAY='2026-11-06',at=(day,time)=>Date.parse(`${day}T${time}:00+08:00`),on=time=>at(DAY,time);
const DOWN='herdr --machine cpu1-butler：ssh: connect to host port 22: Connection refused';
// A fake model: answer(data, call) gives the reply to one prompt (an object, a string, or it throws); every prompt it
// saw is kept. gate: a promise each call waits for first.
function fakeModel(answer,gate){
 const model={calls:[],async ask({system,prompt}){
  const data=JSON.parse(prompt.slice(prompt.indexOf('{')));model.calls.push({system,prompt,data});
  await gate;const out=await answer(data,model.calls.length);return typeof out==='string'?out:JSON.stringify(out);
 }};
 return model;
}
const fresh=c=>c.messages.filter(m=>m.new);
const ref=(data,text)=>{const m=data.chats.flatMap(c=>c.messages).find(m=>m.text===text);assert.ok(m,`message in prompt: ${text}`);return m.ref;};
// An answer that makes one topic of each chat's new messages, picked unless the chat is in notPicked, or carries on
// the chat's last topic when it has one.
const oneEach=(notPicked=[])=>d=>({topics:d.chats.map(c=>{const messages=fresh(c).map(m=>m.ref),last=c.topics?.at(-1);
 return last?{topic:last.topic,messages}:{title:`${c.name}的话题`,summary:`${c.name}的要点`,area:'work',picked:!notPicked.includes(c.name),reason:`${c.name}的理由`,messages};}),flagged:[]});
// Butler began keeping every message at kept (a stored message of 杂谈群, a group without a level, which is never read);
// the clock starts at now. tick: sets the clock.
function setup(t,{answer,options,now=at('2026-11-07','06:00'),kept=at('2026-11-05','18:32'),gate}={}){
 let clock=now;
 const {store}=tempStore(t),matters=new Matters(store),topics=new Topics(store),model=fakeModel(answer??oneEach(),gate);
 if(kept!==undefined)post(store,{chat:'杂谈群',text:'开始全收',at:kept,seen:kept,categories:['stored']});
 const reader=new Reader({store,matters,topics,model,options,now:()=>clock});
 return {store,matters,topics,model,reader,tick:ms=>{clock=ms;}};
}
// A message of someone else that the collector only kept, in chat.
const say=(store,chat,text,time,more={})=>post(store,{chat,sender:'u5',name:'王五',text,at:time,categories:['stored'],...more});
const daily=(store,...chats)=>{for(const c of chats)store.setLevel(c,'daily',{by:'owner',now:at('2026-11-01','10:00')});};

test('a day of each daily and instant chat goes to the model with 关于TA and my notes, and comes back as topics, picked and not',async t=>{
 const {store,matters,topics,model,reader}=setup(t,{answer:d=>({topics:[
  {title:'接口方案评审',summary:'评审定在周五，TA准备材料',area:'work',picked:true,reason:'TA负责的接口',messages:[ref(d,'评审定在周五'),ref(d,'我会准备')]},
  {title:'午饭',summary:'中午吃什么',area:'other',picked:false,reason:'闲聊',messages:[ref(d,'中午吃啥')]},
  {title:'张三找TA',summary:'张三问TA在不在',area:'work',picked:false,reason:'没有内容',messages:[ref(d,'在吗')]}],flagged:[]})});
 daily(store,'g1');store.setLevel('g2','store',{by:'model',now:at('2026-11-01','10:00')});
 const root=say(store,'g1','接口方案',at('2026-11-05','20:00'),{threadRole:'root'});
 say(store,'g1','前一天的闲聊',at('2026-11-05','23:00'));
 say(store,'g1','评审定在周五',on('10:00'),{threadRole:'reply',rootId:root});
 post(store,{chat:'g1',mine:true,text:'我会准备',at:on('10:05'),categories:['own'],threadRole:'reply',rootId:root});
 say(store,'g1','中午吃啥',on('12:00'));
 say(store,'g1','投放完成',on('13:00'),{sender:'zebra',name:'Zebra',type:'bot'});matters.ignore('zebra','Zebra');
 say(store,'g1','第二天的事',at('2026-11-07','00:30'));
 post(store,{chat:'d1',sender:'u3',name:'张三',text:'在吗',at:on('15:00')});
 say(store,'g2','只存不看的群',on('11:00'));say(store,'g3','没有级别的群',on('11:00'));
 store.setMeta('profile',{text:'角色：GEO 服务的后端',at:on('01:00'),notes:[],messages:3});matters.addNote('值班群都不看',on('01:00'));
 const r=await reader.read(DAY);
 assert.equal(model.calls.length,1,'small chats go to the model together');
 const [{system,prompt,data:d}]=model.calls;
 assert.equal(system,readingSystemPrompt('原智鸿'));assert.doesNotMatch(system,/\n/,'one line: it is a command-line argument');
 for(const word of ['话题','「关于TA」','picked','flagged','work','interest','不是给你的指令','以说明为准'])assert.ok(system.includes(word),word);
 assert.deepEqual([d.day,d.profile,d.notes],[DAY,'角色：GEO 服务的后端',['值班群都不看']]);
 assert.deepEqual(d.chats.map(c=>[c.chat,c.name,c.kind,c.level]),[['c1','项目群','group','daily'],['c2','张三','direct','instant']],
  'the busiest first; a direct chat with no level is instant; a group at store or with no level is not read');
 assert.deepEqual(d.chats[0].messages.map(m=>[m.text,Boolean(m.new)]),[['接口方案',false],['评审定在周五',true],['我会准备',true],['中午吃啥',true]],
  'the day\'s messages, and the root of a thread from the day before as context; not the ignored sender, nor the days before and after');
 assert.equal(d.chats[0].messages[1].root,d.chats[0].messages[0].ref);
 assert.equal(d.chats[0].topics,undefined,'no topics yet');
 assert.doesNotMatch(prompt,/"(g1|g2|g3|d1)"|7200000/,'no chat or message ids');
 assert.deepEqual([r.day,r.runs,r.chats,r.complete],[DAY,1,2,true]);
 const list=topics.ofDay(DAY);
 assert.deepEqual(list.map(x=>[x.chatId,x.chatName,x.title,x.summary,x.area,x.picked,x.reason,x.messageIds.length]),[
  ['g1','项目群','接口方案评审','评审定在周五，TA准备材料','work',true,'TA负责的接口',2],['g1','项目群','午饭','中午吃什么','other',false,'闲聊',1],
  ['d1','张三','张三找TA','张三问TA在不在','work',false,'没有内容',1]],'picked and not picked alike');
 assert.equal(list[0].link,store.message(list[0].messageIds[0]).link);assert.equal(topics.topic(list[1].id).title,'午饭');
 const [run]=matters.runs();assert.deepEqual([run.kind,run.ok,run.messages],['read',true,4]);
 assert.deepEqual(topics.readings(DAY).map(x=>[x.feedId,x.level,x.messages,Boolean(x.doneAt)]).sort(),[['d1','instant',1,true],['g1','daily',3,true]]);
 assert.deepEqual(store.message(list[1].messageIds[0]).categories,['stored'],'reading changes no message it does not flag');
});

test('small chats go several to a prompt, at most maxChats of them',async t=>{
 const {store,model,topics,reader}=setup(t,{options:{maxChats:2}});
 daily(store,'a','b','c');
 say(store,'a','一',on('09:00'));say(store,'a','二',on('09:01'));say(store,'b','三',on('09:02'));say(store,'c','四',on('09:03'));
 await reader.read(DAY);
 assert.deepEqual(model.calls.map(c=>c.data.chats.map(x=>x.name)),[['a','b'],['c']]);
 assert.deepEqual(topics.ofDay(DAY).map(x=>[x.title,x.messageIds.length]),[['a的话题',2],['b的话题',1],['c的话题',1]]);
});

test('a chat too big for one prompt is read in segments, each later one shown the topics so far and the messages just before it, so that a discussion that goes on stays one topic',async t=>{
 const {store,model,topics,reader}=setup(t,{options:{maxPromptBytes:5000}});
 daily(store,'g1');
 const text=i=>`讨论第 ${i} 条，${'内容'.repeat(20)}`,ids=[];
 for(let i=0;i<40;i++)ids.push(say(store,'g1',text(i),on('09:00')+i*60e3));
 const r=await reader.read(DAY);
 assert.ok(model.calls.length>=3,`segments: ${model.calls.length}`);
 for(const c of model.calls)assert.ok(Buffer.byteLength(c.prompt)<=5000,'each within the limit');
 const read=model.calls.map(c=>fresh(c.data.chats[0]).map(m=>m.text));
 assert.deepEqual(read.flat(),ids.map((_,i)=>text(i)),'every message read once, in order');
 const sizes=read.map(r=>r.length);assert.ok(Math.min(...sizes)*2>=Math.max(...sizes),`what is left is shared out evenly, no small segment at the end: ${sizes}`);
 assert.equal(model.calls[0].data.chats[0].topics,undefined);
 for(const [i,c] of model.calls.slice(1).entries()){
  const chat=c.data.chats[0],before=read.slice(0,i+1).flat();
  assert.deepEqual(chat.topics.map(x=>[x.topic,x.title,x.summary,x.area,x.picked,x.reason]),[['t1','项目群的话题','项目群的要点','work',true,'项目群的理由']]);
  assert.deepEqual(chat.messages.filter(m=>!m.new).map(m=>m.text),before.slice(-DEFAULTS.contextMessages),'the messages just before, as context');
 }
 const [topic]=topics.ofDay(DAY);assert.deepEqual(topic.messageIds,ids,'one topic of them all');
 assert.deepEqual([r.complete,r.runs],[true,model.calls.length]);
 const [reading]=topics.readings(DAY);assert.deepEqual([reading.messages,Boolean(reading.doneAt)],[40,true]);
});

test('a chat is read by its level as the day ended, the whole day of it',async t=>{
 const {store,model,reader}=setup(t);
 daily(store,'早上还是每日','一直是每日');store.setLevel('下午成了每日','store',{by:'model',now:at('2026-11-01','10:00')});
 store.setLevel('早上还是每日','store',{by:'owner',now:on('15:00')});store.setLevel('下午成了每日','daily',{by:'owner',now:on('15:00')});
 store.setLevel('一直是每日','ignore',{by:'owner',now:at('2026-11-07','01:00')});store.setLevel('bot','instant',{by:'model',now:at('2026-11-01','10:00')});
 for(const chat of ['早上还是每日','下午成了每日','一直是每日','bot'])for(const time of ['10:00','16:00'])say(store,chat,`${chat} ${time}`,on(time));
 await reader.read(DAY);
 const [{data:d}]=model.calls;
 assert.deepEqual(d.chats.map(c=>[c.name,c.level,fresh(c).length]),[['Zebra2.0自动化投放平台','instant',2],['一直是每日','daily',2],['下午成了每日','daily',2]]);
});

test('messages of a daily chat that I may have to act on are flagged: they leave stored and wait for the batches; the rest of what the answer flags is left out and on record',async t=>{
 const {store,matters,topics,reader}=setup(t,{answer:d=>({topics:[],flagged:[ref(d,'周报今天要交，大家记得填'),ref(d,'帮忙审批一下'),ref(d,'在吗'),ref(d,'@原智鸿 看下'),ref(d,'值班安排'),'m99']})});
 daily(store,'g1');
 const root=say(store,'g1','值班安排',at('2026-11-05','20:00'),{threadRole:'root'});
 const ask=say(store,'g1','周报今天要交，大家记得填',on('10:00')),me=post(store,{chat:'g1',text:'@原智鸿 看下',at:on('10:30'),categories:['mention']});
 say(store,'g1','好的',on('11:00'),{threadRole:'reply',rootId:root});
 const bot=say(store,'bot','帮忙审批一下',on('12:00'),{categories:['instant']}),dm=post(store,{chat:'d1',sender:'u3',name:'张三',text:'在吗',at:on('13:00')});
 const waiting=matters.pendingCount();
 const r=await reader.read(DAY);assert.equal(r.complete,true);
 assert.deepEqual([store.message(ask).categories,store.message(me).categories,store.message(root).categories,store.message(bot).categories,store.message(dm).categories],
  [['flagged'],['mention'],['stored'],['instant'],['dm']]);
 assert.equal(matters.pendingCount(),waiting+1,'the batches take it');assert.ok(matters.pending(40).some(m=>m.id===ask));
 assert.deepEqual(topics.readings(DAY).find(x=>x.feedId==='g1').flagged,1);
 const errors=store.errors(20).map(e=>`${e.source}：${e.message}`).join('\n');
 for(const what of ['不存在的消息 m99','不是这次要读的消息','即时'])assert.match(errors,new RegExp(what));
});

test('the answer is taken topic by topic: what points at messages it was not asked to read or at unknown topics, or has no title, is left out and on record; links are replaced',async t=>{
 const {store,topics,reader}=setup(t,{answer:d=>({topics:[
  {title:'方案 https://docs.example/x 讨论',summary:'见\nhttps://docs.example/x',area:'hobby',picked:'yes',reason:'相关',messages:[ref(d,'方案'),ref(d,'旧消息'),ref(d,'午饭'),'m99']},
  {title:'',summary:'没有标题',area:'work',picked:true,messages:[ref(d,'方案')]},
  {title:'只有上下文',summary:'x',area:'work',picked:true,messages:[ref(d,'旧消息')]},
  {topic:'t7',messages:[ref(d,'方案')]},'不是对象']})});
 daily(store,'g1','g2');
 const old=say(store,'g1','旧消息',at('2026-11-05','20:00'));
 say(store,'g1','方案',on('10:00'),{parentId:old});say(store,'g2','午饭',on('11:00'));
 await reader.read(DAY);
 const list=topics.ofDay(DAY);
 assert.deepEqual(list.map(x=>[x.chatName,x.title,x.summary,x.area,x.picked,x.messageIds.length]),[['项目群','方案 [链接] 讨论','见 [链接]','other',false,1]],
  'one topic, in the chat of its first message, with only the new messages of that chat');
 const errors=store.errors(20).map(e=>e.message).join('\n');
 for(const what of ['不是这次要读的消息','别的聊天','不存在的消息 m99','没有标题','没有引用这次要读的消息','不存在的话题 t7','hobby','picked'])assert.match(errors,new RegExp(what),what);
 assert.equal(topics.readings(DAY).every(x=>x.doneAt),true,'what was read is read, topics or not');
});

test('the day before is read at six in the morning, from the first whole day butler kept every message on; of the days missed while it was down, the latest three',async t=>{
 const {store,model,reader,tick}=setup(t,{now:at('2026-11-06','12:00'),kept:at('2026-11-05','18:32')});
 daily(store,'g1');
 for(let d=5;d<=11;d++)say(store,'g1',`11-${String(d).padStart(2,'0')} 的讨论`,at(`2026-11-${String(d).padStart(2,'0')}`,'20:00'));
 assert.equal(reader.check(),undefined,'11-05 is not a whole day; 11-06 is not over');
 assert.equal(reader.status().next,at('2026-11-07','06:00'));
 tick(at('2026-11-07','05:59'));assert.equal(reader.check(),undefined);
 tick(at('2026-11-07','06:00'));await reader.check();
 assert.deepEqual(model.calls.map(c=>c.data.day),['2026-11-06']);
 assert.equal(reader.check(),undefined,'read');
 let s=reader.status();
 assert.deepEqual([s.last.day,s.last.at,s.last.chats,s.last.picked,s.last.notPicked,s.last.flagged,s.last.failed],['2026-11-06',at('2026-11-07','06:00'),1,1,0,0,[]]);
 assert.deepEqual([s.upcoming,s.next,s.due],['2026-11-07',at('2026-11-08','06:00'),[]]);
 tick(at('2026-11-12','07:00'));await reader.check();
 assert.deepEqual(model.calls.slice(1).map(c=>c.data.day),['2026-11-09','2026-11-10','2026-11-11'],'the latest three, oldest first');
 s=reader.status();assert.deepEqual([s.skipped,s.through,s.last.day],[['2026-11-07','2026-11-08'],'2026-11-11','2026-11-11']);
 assert.deepEqual(model.calls.map(c=>fresh(c.data.chats[0])[0].text),['11-06 的讨论','11-09 的讨论','11-10 的讨论','11-11 的讨论']);
});

test('a read the model cannot answer stops, keeps what was read, and goes on retryMs later from where it stopped, in a big chat from the segment that failed',async t=>{
 const {store,model,topics,reader,tick}=setup(t,{options:{maxPromptBytes:4000,maxChats:1},answer:(d,n)=>{if(n===2)throw Error(DOWN);return oneEach()(d,n);}});
 daily(store,'g1','g2');
 for(let i=0;i<30;i++)say(store,'g1',`讨论第 ${i} 条，${'内容'.repeat(20)}`,on('09:00')+i*60e3);
 say(store,'g2','另一个群',on('10:00'));
 await reader.check();
 assert.equal(model.calls.length,2,'the second segment failed and the read stopped there');
 const m=store.meta('reading');assert.deepEqual([m.failedDay,m.error,m.failedAt,m.through],[DAY,DOWN,at('2026-11-07','06:00'),undefined]);
 assert.equal(reader.status().retryAt,at('2026-11-07','06:00')+DEFAULTS.retryMs);
 assert.match(store.errors(1)[0].message,/项目群.*没有读成/);
 tick(at('2026-11-07','03:10'));assert.equal(reader.check(),undefined,'waits retryMs');
 tick(at('2026-11-07','06:00')+DEFAULTS.retryMs);await reader.check();
 const again=model.calls[2].data.chats[0];
 assert.equal(again.name,'项目群');assert.deepEqual(again.topics.map(x=>x.title),['项目群的话题'],'on from the segment that failed, with the topics so far');
 assert.equal(fresh(again)[0].text,fresh(model.calls[1].data.chats[0])[0].text);
 assert.ok(model.calls.some(c=>c.data.chats[0].name==='大群'));
 assert.deepEqual(topics.ofDay(DAY).map(x=>[x.chatName,x.messageIds.length]),[['项目群',30],['大群',1]]);
 const s=store.meta('reading');assert.deepEqual([s.through,s.failedAt,s.error,s.last.day],[DAY,undefined,undefined,DAY]);
});

test('an answer that cannot be used for a chat alone counts against it: the read goes on with the others, the chat goes again in smaller segments, and after skipAfter its day is given up',async t=>{
 const {store,model,topics,reader,tick}=setup(t,{options:{maxPromptBytes:8000,maxChats:1},answer:(d,n)=>d.chats[0].name==='坏群'?'我读不懂':oneEach()(d,n)});
 daily(store,'坏群','g2');
 for(let i=0;i<30;i++)say(store,'坏群',`第 ${i} 条，${'内容'.repeat(20)}`,on('09:00')+i*60e3);
 say(store,'g2','好的群',on('10:00'));
 const sizes=()=>model.calls.filter(c=>c.data.chats[0].name==='坏群').map(c=>Buffer.byteLength(c.prompt));
 let t0=at('2026-11-07','06:00');
 await reader.check();
 assert.deepEqual(model.calls.map(c=>c.data.chats[0].name),['坏群','大群'],'the read goes on with the others');
 assert.deepEqual([topics.reading(DAY,'坏群').strikes,Boolean(topics.reading(DAY,'g2').doneAt)],[1,true]);
 assert.equal(store.meta('reading').failedDay,DAY,'not done yet');
 for(let i=2;i<=DEFAULTS.skipAfter;i++){t0+=DEFAULTS.retryMs;tick(t0);await reader.check();}
 const [a,b,c]=sizes();assert.ok(a<=8000&&b<=4000&&c<=2000,`each try in smaller segments: ${sizes()}`);
 assert.deepEqual([topics.reading(DAY,'坏群').strikes,Boolean(topics.reading(DAY,'坏群').doneAt),topics.reading(DAY,'坏群').error],[3,true,'模型的回复不是 JSON：我读不懂']);
 const s=store.meta('reading');
 assert.deepEqual([s.through,s.last.chats,s.last.failed],[DAY,2,[{feedId:'坏群',name:'坏群',error:'模型的回复不是 JSON：我读不懂'}]]);
 assert.ok(model.calls.length>=DEFAULTS.skipAfter+1);
});

test('an answer that cannot be used for several chats is tried again at once with fewer of them',async t=>{
 const {store,model,topics,reader}=setup(t,{answer:d=>d.chats.length>1?'太多了':oneEach()(d)});
 daily(store,'a','b','c');say(store,'a','一',on('09:00'));say(store,'b','二',on('09:01'));say(store,'c','三',on('09:02'));
 const r=await reader.read(DAY);
 assert.deepEqual(model.calls.map(c=>c.data.chats.length),[3,2,1,2,1,1],'halved after a failure, whole again after a success');
 assert.deepEqual([r.complete,topics.ofDay(DAY).length],[true,3]);
});

test('a running reader checks every checkMs, and stopping it waits for the run under way and starts no other',async t=>{
 let open;const gate=new Promise(r=>{open=r;});
 const {store,model,topics,reader}=setup(t,{options:{checkMs:20,maxChats:1},gate});
 daily(store,'a','b');say(store,'a','一',on('09:00'));say(store,'b','二',on('09:01'));
 reader.start();t.after(()=>reader.stop());
 await waitFor(()=>model.calls.length===1,{message:'first run'});
 const stopped=reader.stop();open();await stopped;
 assert.equal(model.calls.length,1,'no run starts after the stop');
 assert.deepEqual(topics.ofDay(DAY).map(x=>x.title),['a的话题'],'the run under way is kept');
 assert.equal(store.meta('reading').failedAt,undefined,'a stop is no failure');
});
