import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post,LINK_BASE} from './helpers.mjs';
import {Matters} from '../matters.mjs';
import {Processor} from '../processor.mjs';

const T0=Date.parse('2026-10-23T09:00:00+08:00'),min=n=>T0+n*60e3;
// A fake model: answer(data, call) returns the reply object for one prompt; every prompt it saw is kept.
function fakeModel(answer){
 const model={calls:[],busy:0,overlapped:false,
  async ask({system,prompt}){
   if(model.busy++)model.overlapped=true;
   try{const data=JSON.parse(prompt.slice(prompt.indexOf('{')));model.calls.push({system,prompt,data});await new Promise(r=>setTimeout(r,5));
    const out=await answer(data,model.calls.length);return typeof out==='string'?out:JSON.stringify(out);}
   finally{model.busy-=1;}
  }};
 return model;
}
const messagesOf=data=>data.chats.flatMap(c=>c.messages);
const ref=(data,text)=>{const m=messagesOf(data).find(m=>m.text.includes(text));assert.ok(m,`message in prompt: ${text}`);return m.ref;};
const none={new:[],updates:[]};
function setup(t,{answer,options}={}){
 const {store}=tempStore(t),matters=new Matters(store),model=fakeModel(answer??(()=>none));
 const processor=new Processor({store,matters,model,options:{maxMessages:40,...options}});
 return {store,matters,model,processor};
}

test('new messages become matters: the model decides, butler keeps the sources and makes the links',async t=>{
 const {store,matters,model,processor}=setup(t,{answer:d=>({new:[{title:'评审接口方案',who:'陈帆',ask:'看一下接口方案并给意见',due:'2026-10-24 18:00',urgency:'high',
  messages:[ref(d,'帮忙看下'),ref(d,'文档在这')]}],updates:[]})});
 const ask=post(store,{text:'@原智鸿 帮忙看下接口方案，明天下班前要',at:min(1),categories:['mention','watched']});
 const doc=post(store,{text:'文档在这',at:min(2)});
 post(store,{chat:'g2',name:'李四',text:'中午吃啥',at:min(3)});
 const before=JSON.stringify(store.list({limit:100}));
 const r=await processor.runOnce();
 assert.equal(r.runs,1);assert.equal(model.calls.length,1);
 const [m]=matters.list();
 assert.deepEqual({title:m.title,who:m.who,ask:m.ask,due:m.due,urgency:m.urgency,status:m.status},
  {title:'评审接口方案',who:'陈帆',ask:'看一下接口方案并给意见',due:'2026-10-24 18:00',urgency:'high',status:'open'});
 assert.deepEqual(m.messageIds,[ask,doc]);assert.deepEqual(m.chats,['项目群']);
 assert.equal(m.since,min(1),'a matter dates from its earliest message, not from when butler made it');assert.ok(m.openedAt>min(3));
 assert.equal(m.link,store.message(ask).link);assert.ok(m.link.startsWith(`${LINK_BASE}/messenger/g1?message=${ask}`));
 assert.equal(matters.pendingCount(),0,'every message of the batch was processed, the ones that are no matter too');
 assert.equal(JSON.stringify(store.list({limit:100})),before,'the collector\'s messages are only read');
 assert.equal((await processor.runOnce()).runs,0,'nothing new, no model run');
});

test('a follow-up goes to the open matter it belongs to, which the model sees with its earlier messages',async t=>{
 const {store,matters,model,processor}=setup(t,{answer:(d,n)=>n===1
  ?{new:[{title:'评审方案',who:'陈帆',ask:'看方案',due:null,urgency:'normal',messages:[ref(d,'看下方案')]}],updates:[]}
  :{new:[],updates:[{matter:d.openMatters[0].matter,messages:[ref(d,'方案更新了')],due:'今天 18:00',status:'open'}]}});
 const first=post(store,{text:'@原智鸿 看下方案',at:min(1)});
 await processor.runOnce();
 const follow=post(store,{text:'方案更新了，按新的看，今天 18:00 前',at:min(30)});
 await processor.runOnce();
 const d=model.calls[1].data;
 assert.equal(d.openMatters.length,1);assert.equal(d.openMatters[0].title,'评审方案');
 const earlier=messagesOf(d).find(m=>m.text.includes('看下方案'));
 assert.ok(earlier&&!earlier.new,'the earlier message comes along as context');assert.deepEqual(d.openMatters[0].messages,[earlier.ref]);
 const [m]=matters.list();
 assert.deepEqual(m.messageIds,[first,follow]);assert.equal(m.due,'今天 18:00');assert.equal(m.status,'open');
 assert.equal(matters.list({all:true}).length,1,'no second matter');
});

test('a matter ends when the model says so, with its reason; my own messages are context and never a matter',async t=>{
 const {store,matters,model,processor}=setup(t,{answer:(d,n)=>n===1
  ?{new:[{title:'确认上线时间',who:'陈帆',ask:'确认周五能否上线',due:'周五',urgency:'normal',messages:[ref(d,'周五能上线吗')]}],updates:[]}
  :{new:[{title:'我自己说的',who:'我',ask:'x',urgency:'low',messages:[ref(d,'可以，周五上')]}],
    updates:[{matter:d.openMatters[0].matter,messages:[ref(d,'可以，周五上')],status:'closed',reason:'我已回复周五可以上线'}]}});
 post(store,{text:'@原智鸿 周五能上线吗',at:min(1)});
 await processor.runOnce();
 const reply=post(store,{mine:true,text:'可以，周五上',at:min(5)});
 await processor.runOnce();
 const mine=messagesOf(model.calls[1].data).find(m=>m.text.includes('可以，周五上'));
 assert.equal(mine.mine,true);assert.equal(mine.new,true);assert.match(model.calls[1].system,/上下文/);
 const all=matters.list({all:true});
 assert.equal(all.length,1,'a matter made only of my messages is refused');
 assert.equal(all[0].status,'closed');assert.equal(all[0].reason,'我已回复周五可以上线');assert.ok(all[0].closedAt);
 assert.ok(all[0].messageIds.includes(reply));assert.deepEqual(matters.list(),[],'closed matters are not open');
 assert.ok(store.errors().some(e=>/我自己说的/.test(e.message)),'the refused part is on record');
});

test('ignored senders never reach the model, not even as context, and un-ignoring does not bring old messages back',async t=>{
 const {store,matters,model,processor}=setup(t);
 post(store,{chat:'g1',sender:'zebra',name:'Zebra2.0自动化投放平台',type:'bot',text:'投放任务完成 #1',at:min(0)});
 const colleague=post(store,{chat:'g1',text:'@原智鸿 这个投放结果对吗',at:min(1)});
 post(store,{chat:'bot',sender:'zebra',name:'Zebra2.0自动化投放平台',type:'bot',text:'投放任务完成 #2',at:min(2)});
 matters.ignore('zebra','Zebra2.0自动化投放平台');
 assert.deepEqual(matters.ignoredSenders().map(s=>[s.senderId,s.name]),[['zebra','Zebra2.0自动化投放平台']]);
 await processor.runOnce();
 assert.equal(model.calls.length,1);
 assert.doesNotMatch(model.calls[0].prompt,/投放任务完成|Zebra/);
 assert.deepEqual(messagesOf(model.calls[0].data).map(m=>m.text),['@原智鸿 这个投放结果对吗']);
 matters.unignore('zebra');assert.deepEqual(matters.ignoredSenders(),[]);
 assert.equal(matters.pendingCount(),0,'skipped while ignored, so they stay skipped');
 assert.ok(colleague);
});

test('only my own messages and nothing open: no model run',async t=>{
 const {store,matters,model,processor}=setup(t,{answer:(d,n)=>n===1?{new:[{title:'回复张三',who:'张三',ask:'回复他',urgency:'normal',messages:[ref(d,'在吗')]}],updates:[]}:none});
 post(store,{chat:'d1',mine:true,text:'我发的第一条',at:min(1)});
 await processor.runOnce();
 assert.equal(model.calls.length,0);assert.equal(matters.pendingCount(),0);
 post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:min(2)});
 await processor.runOnce();
 assert.equal(model.calls.length,1);assert.equal(matters.list().length,1);
 post(store,{chat:'g2',mine:true,text:'我在别的群说的',at:min(3)});
 await processor.runOnce();
 assert.equal(model.calls.length,2,'with a matter open, my messages go to the model: they may end it');
});

test('when the model cannot be reached the messages wait, and a later run takes them in smaller batches until one succeeds',async t=>{
 let down=true;
 const {store,matters,model,processor}=setup(t,{options:{maxMessages:4},answer:()=>{if(down)throw Error('herdr --machine cpu1-butler：ssh: connect to host port 22: Connection refused');return none;}});
 for(let i=0;i<6;i++)post(store,{text:`消息${i}`,at:min(i)});
 let r=await processor.runOnce();
 assert.equal(r.runs,1);assert.equal(r.failures,1);assert.equal(matters.pendingCount(),6,'nothing is lost');
 assert.ok(store.errors().some(e=>e.source==='加工'&&/Connection refused/.test(e.message)));
 r=await processor.runOnce();
 assert.equal(messagesOf(model.calls[1].data).filter(m=>m.new).length,2,'a failure halves the next batch');
 down=false;r=await processor.runOnce();
 assert.equal(r.failures,0);assert.equal(matters.pendingCount(),0);
 assert.deepEqual(model.calls.slice(2).map(c=>messagesOf(c.data).filter(m=>m.new).length),[1,4,1],'a success restores the batch size');
 const runs=matters.runs();
 assert.deepEqual(runs.map(x=>x.ok),[false,false,true,true,true]);assert.ok(runs.every(x=>x.messages>0&&x.finishedAt>=x.startedAt));
});

test('a reply that is not the asked-for JSON leaves the batch pending and is kept for inspection',async t=>{
 const {store,matters,processor}=setup(t,{answer:()=>'抱歉，我不能处理'});
 post(store,{text:'在吗',at:min(1)});
 const r=await processor.runOnce();
 assert.equal(r.failures,1);assert.equal(matters.pendingCount(),1);
 const [run]=matters.runs();assert.equal(run.ok,false);assert.equal(run.output,'抱歉，我不能处理');assert.match(run.error,/JSON/);
});

test('batches run one at a time, oldest messages first, within the size limit',async t=>{
 const {store,model,processor}=setup(t,{options:{maxMessages:3}});
 for(let i=0;i<7;i++)post(store,{chat:i%2?'g1':'g2',text:`第${i}条`,at:min(10-i)});
 const r=await processor.runOnce();
 assert.equal(r.runs,3);assert.equal(model.overlapped,false);
 const order=model.calls.map(c=>messagesOf(c.data).filter(m=>m.new).map(m=>Number(/第(\d)条/.exec(m.text)[1])));
 assert.deepEqual(order.map(b=>b.length),[3,3,1]);
 assert.deepEqual(order.map(b=>Math.max(...b)),[6,3,0],'the oldest (highest number here) go first');
});

test('a prompt too large for one run is split',async t=>{
 const {store,model,processor}=setup(t,{options:{maxMessages:10,maxPromptBytes:6000}});
 for(let i=0;i<6;i++)post(store,{text:`${i}${'长'.repeat(1400)}`,at:min(i)});
 await processor.runOnce();
 assert.ok(model.calls.length>1);assert.ok(model.calls.every(c=>Buffer.byteLength(c.prompt)<=6000));
 assert.equal(model.calls.reduce((n,c)=>n+messagesOf(c.data).filter(m=>m.new).length,0),6);
});

test('a second processor on the same store refuses to start while the first runs',async t=>{
 const {store,matters,model,processor}=setup(t);
 await processor.start();t.after(()=>processor.stop());
 // Another process (pid) on the same store: this one is alive and its heartbeat is fresh.
 const other=new Processor({store,matters,model,pid:process.pid+1});
 await assert.rejects(other.start(),/已经在运行/);
 await processor.stop();await other.start();await other.stop();
});

// A model that cannot use one message: whenever that message is among the new ones it answers, but not with the
// asked-for JSON; everything else it handles. failOthers: what it does with the rest instead (a function that may throw).
const newTexts=d=>messagesOf(d).filter(m=>m.new).map(m=>m.text);
function poisoned(text,failOthers){return (d,n)=>{if(newTexts(d).some(x=>x.includes(text)))return '我没法处理这条';return failOthers?failOthers(d,n):none;};}

test('a message that alone keeps getting an unusable answer is skipped after three such failures, and the rest is not held up',async t=>{
 const {store,matters,model,processor}=setup(t,{options:{maxMessages:4},answer:poisoned('坏消息')});
 const bad=post(store,{chat:'g2',name:'李四',text:'坏消息',at:min(0)});
 for(let i=1;i<=5;i++)post(store,{text:`好消息${i}`,at:min(i)});
 // Halving brings the batch down to the one message.
 assert.deepEqual([await processor.runOnce(),await processor.runOnce()].map(r=>r.failures),[1,1]);
 assert.equal(matters.pendingCount(),6);
 // Alone it fails again; the next run, on other messages, succeeds, so the failure is the message's own.
 let r=await processor.runOnce();
 assert.equal(matters.pendingCount(),1,'the messages behind it went on');assert.deepEqual([...matters.struck()],[bad]);
 const third=model.calls.slice(2);
 assert.deepEqual(newTexts(third[0].data),['坏消息']);assert.ok(third.length>1&&third.slice(1).every(c=>!c.prompt.includes('坏消息')),'it is no context for the others');
 // Each round it goes alone first; a success after it counts the failure. The third one skips it.
 for(let round=2;round<=3;round++){
  post(store,{text:`新消息${round}`,at:min(10+round)});r=await processor.runOnce();
  assert.deepEqual(newTexts(model.calls.at(-2).data),['坏消息']);
 }
 assert.equal(matters.pendingCount(),0);assert.equal(matters.skippedCount(),1);
 const skipped=store.errors().filter(e=>/跳过/.test(e.message));
 assert.equal(skipped.length,1,'one error for the skip');
 assert.match(skipped[0].message,new RegExp(bad));assert.match(skipped[0].message,/坏消息/);assert.match(skipped[0].message,/大群/);assert.match(skipped[0].message,/不是 JSON/);
 post(store,{chat:'g2',text:'之后的消息',at:min(20)});await processor.runOnce();
 assert.doesNotMatch(model.calls.at(-1).prompt,/坏消息/,'a skipped message is no context either');
});

test('a model that fails as a whole never skips a message',async t=>{
 const scenarios={
  unreachable:()=>{throw Error('herdr --machine cpu1-butler：ssh: connect to host port 22: Connection refused');},
  'no reply':()=>{throw Error('模型结束了这一轮，但没有回复');},
  'unusable answers to everything':()=>'服务繁忙',
  'unreachable after the bad one':poisoned('坏消息',()=>{throw Error('herdr agent prompt：timed out waiting for agent status（timeout）');}),
 };
 for(const [name,answer] of Object.entries(scenarios)){
  const {store,matters,model,processor}=setup(t,{options:{maxMessages:4},answer});
  post(store,{text:'坏消息',at:min(0)});for(let i=1;i<=3;i++)post(store,{text:`消息${i}`,at:min(i)});
  for(let round=0;round<10;round++){
   post(store,{text:`第${round}轮的新消息`,at:min(10+round)});const before=model.calls.length,r=await processor.runOnce();
   assert.ok(model.calls.length-before<=2,`${name}: at most one more run after a failure`);assert.ok(r.failures>=1,name);
  }
  assert.equal(matters.skippedCount(),0,name);assert.equal(matters.pendingCount(),14,`${name}: every message still waits`);
  assert.ok(!store.errors().some(e=>/跳过/.test(e.message)),name);
 }
});

test('a message that gets through after failing loses its strikes',async t=>{
 let healed=false;
 const {store,matters,processor}=setup(t,{options:{maxMessages:1},answer:d=>!healed&&newTexts(d).includes('时好时坏')?'嗯？':none});
 post(store,{text:'时好时坏',at:min(0)});post(store,{text:'后面的',at:min(1)});
 await processor.runOnce();assert.equal(matters.struck().size,1);
 healed=true;post(store,{text:'又来一条',at:min(2)});await processor.runOnce();
 assert.equal(matters.struck().size,0);assert.equal(matters.pendingCount(),0);assert.equal(matters.skippedCount(),0);
});
