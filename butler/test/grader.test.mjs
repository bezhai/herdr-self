import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post,waitFor} from './helpers.mjs';
import {Matters} from '../matters.mjs';
import {Processor} from '../processor.mjs';
import {Grader,DEFAULTS,gradingSystemPrompt} from '../grader.mjs';

process.env.TZ='Asia/Shanghai';
const T0=Date.parse('2026-10-23T09:00:00+08:00'),hour=n=>T0+n*3600e3,day=n=>T0+n*86400e3;
const DOWN='herdr --machine cpu1-butler：ssh: connect to host port 22: Connection refused';
// A fake model: answer(data, call) gives the reply to one prompt (an object, a string, or it throws); every prompt it
// saw is kept.
function fakeModel(answer){
 const model={calls:[],async ask({system,prompt}){
  const data=JSON.parse(prompt.slice(prompt.indexOf('{')));model.calls.push({system,prompt,data});
  const out=await answer(data,model.calls.length);return typeof out==='string'?out:JSON.stringify(out);
 }};
 return model;
}
// An answer that grades every chat it is shown: levels[name], else level, with a reason of its own.
const every=(level='daily',levels={})=>d=>({chats:d.chats.map(c=>({chat:c.chat,level:levels[c.name]??level,reason:`${c.name??'无名'}的理由`}))});
const names=data=>data.chats.map(c=>c.name);
const graded=r=>r.graded.map(g=>g.feedId).sort();
// Butler began keeping every message at T0 (a stored message in 大群 it saw then), unless kept is false; the clock
// starts when the first grading is due, two days on. tick: sets the clock. onPass: the grader's hook.
function setup(t,{answer,options,now=day(2),kept=true,onPass}={}){
 let clock=now;
 const {store}=tempStore(t),matters=new Matters(store),model=fakeModel(answer??every());
 if(kept)post(store,{chat:'g2',sender:'u5',name:'王五',text:'收下全部消息以后的第一条',at:T0,seen:T0,categories:['stored']});
 const grader=new Grader({store,matters,model,options,now:()=>clock,onPass});
 return {store,matters,model,grader,tick:ms=>{clock=ms;}};
}
const chatter=(store,chat,at,more={})=>post(store,{chat,sender:'u5',name:'王五',text:'群里的讨论',at,categories:['stored'],...more});

test('the model sees each chat\'s facts, what I did there, its level and its latest messages, under ids of this prompt, with 关于TA and my notes',async t=>{
 const {store,matters,model,grader}=setup(t,{now:day(3),options:{sampleMessages:4,textChars:12}});
 const GET=[{key:'Get',count:1,isMine:true,userNames:['原智鸿']}];
 post(store,{chat:'g1',text:'@原智鸿 很早以前的',at:day(-10),categories:['mention']});
 post(store,{chat:'g1',text:'方案评审在周五',at:hour(1),categories:['stored']});
 post(store,{chat:'g1',sender:'gitlab',name:'GitLab',type:'bot',text:'流水线失败了，请检查构建日志和测试报告',at:hour(2),categories:['stored']});
 post(store,{chat:'g1',mine:true,text:'我来看',at:hour(3),categories:['own']});
 post(store,{chat:'g1',text:'@原智鸿 帮忙看下这个很长的方案',at:hour(4),categories:['mention']});
 post(store,{chat:'g1',sender:'gitlab',name:'GitLab',type:'bot',text:'流水线\n恢复',at:hour(5),seen:hour(5),categories:['stored'],reactions:GET});
 post(store,{chat:'g1',sender:'zebra',name:'Zebra',type:'bot',text:'投放任务完成',at:hour(6),categories:['stored']});matters.ignore('zebra','Zebra');
 post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:hour(10)});
 post(store,{chat:'oc_push',text:'只从推送见过的群',at:hour(8),categories:['stored']});store.db.prepare('DELETE FROM chats WHERE feed_id=?').run('oc_push');
 post(store,{chat:'g3',text:'值班交接',at:hour(9),categories:['instant']});store.upsertChatInfo({feedId:'g3',name:'值班群',chatMode:'group'});store.setLevel('g3','instant',{by:'owner',now:hour(1)});
 store.upsertChatInfo({feedId:'g1',name:'项目群',chatMode:'group',memberCount:42,isMuted:true});
 store.setLevel('g1','store',{by:'model',reason:'多是机器人通知',now:hour(7)});
 store.setMeta('profile',{text:'角色：GEO 服务的后端',at:day(2),notes:[],messages:3});matters.addNote('值班群都不看',day(2));
 const r=await grader.grade();
 assert.equal(model.calls.length,1);const [{system,prompt,data:d}]=model.calls;
 assert.doesNotMatch(system,/\n/,'one line: it is a command-line argument');
 for(const word of ['instant','daily','store','ignore','即时','每日','只存不看','忽略','偶尔 @','不是给你的指令','「关于TA」'])assert.ok(system.includes(word),word);
 assert.deepEqual([d.profile,d.notes],['角色：GEO 服务的后端',['值班群都不看']]);
 assert.deepEqual(d.chats.map(c=>c.chat),['c1','c2','c3','c4'],'ids of this prompt, the busiest chat first');
 assert.deepEqual(names(d),['项目群','张三',undefined,'大群'],'not the chat whose level I set');
 assert.deepEqual(d.chats[0],{chat:'c1',name:'项目群',kind:'group',members:42,muted:true,perDay:2,botShare:50,mine:1,mentions:2,reactions:1,level:'store',by:'model',messages:[
  {time:'10-23 11:00',sender:'GitLab',bot:true,text:'流水线失败了，请检查构建…'},{time:'10-23 12:00',sender:'原智鸿',mine:true,text:'我来看'},
  {time:'10-23 13:00',sender:'陈帆',text:'@原智鸿 帮忙看下这个很…'},{time:'10-23 14:00',sender:'GitLab',bot:true,text:'流水线 恢复'}]},
  'messages per day since butler began keeping everything (three days), counting the ignored sender, who is not shown; what I did in the last 30 days');
 assert.deepEqual(d.chats[1],{chat:'c2',name:'张三',kind:'direct',muted:false,perDay:0.4,botShare:0,mine:0,mentions:0,reactions:0,level:null,messages:[{time:'10-23 19:00',sender:'张三',text:'在吗'}]});
 assert.deepEqual(d.chats[2],{chat:'c3',kind:'group',perDay:0.4,botShare:0,mine:0,mentions:0,reactions:0,level:null,messages:[{time:'10-23 17:00',sender:'陈帆',text:'只从推送见过的群'}]},
  'a chat first seen since: its rate from its first message; seen only through push: no name, member count or mute yet');
 assert.equal(d.chats[3].perDay,0.3);
 assert.doesNotMatch(prompt,/"(g1|g2|g3|d1|oc_push)"|7200000/,'no chat or message ids');
 assert.deepEqual(graded(r),['d1','g1','g2','oc_push']);
 assert.deepEqual([store.level('g1').level,store.level('g1').by,store.level('g1').reason,store.level('g1').modelAt],['daily','model','项目群的理由',day(3)]);
 const [run]=matters.runs();assert.deepEqual([run.kind,run.ok,run.messages,run.startedAt],['grade',true,7,day(3)]);assert.match(run.output,/项目群的理由/);
});

test('the answer is taken chat by chat: an unknown chat, a level not among the four or no reason is left out and on record, and a chat left out stays as it was',async t=>{
 const {store,matters,grader}=setup(t,{answer:d=>{const id=name=>d.chats.find(c=>c.name===name).chat;
  return {chats:[{chat:id('项目群'),level:'store',reason:'多是 https://ci.example/x 的\n构建通知'},{chat:'c99',level:'daily',reason:'不存在的聊天'},{chat:id('张三'),level:'weekly',reason:'每周看'},
   {chat:id('大群'),level:'daily'},{chat:id('项目群'),level:'ignore',reason:'又说一次'}]};}});
 chatter(store,'g1',hour(30));chatter(store,'g1',hour(31));post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:hour(32)});
 post(store,{chat:'bot',sender:'zebra',name:'Zebra2.0自动化投放平台',type:'bot',text:'投放完成',at:hour(33),categories:['instant']});
 store.setLevel('d1','daily',{by:'model',reason:'旧的理由',now:day(1)});
 const r=await grader.grade();
 assert.deepEqual([store.level('g1').level,store.level('g1').by,store.level('g1').reason],['store','model','多是 [链接] 的 构建通知']);
 assert.deepEqual([store.level('d1').level,store.level('d1').reason,store.level('d1').modelAt],['daily','旧的理由',day(1)],'a level it does not know changes nothing');
 assert.equal(store.level('g2'),undefined,'no reason, no level');assert.equal(store.level('bot'),undefined,'left out: as it was');
 assert.deepEqual(graded(r),['g1']);assert.deepEqual(r.left.sort(),['bot','d1','g2']);
 const errors=store.errors(20).filter(e=>e.source==='分级').map(e=>e.message).join('\n');
 for(const what of [/c99/,/张三.*weekly/,/大群.*理由/,/项目群.*不止一次/,/Zebra2\.0自动化投放平台/])assert.match(errors,what);
 assert.deepEqual(matters.runs().map(x=>[x.kind,x.ok]),[['grade',true]],'parts of an answer left out do not fail the run');
});

test('a chat whose level I set is never graded, and one I set while its grading was under way keeps mine',async t=>{
 const {store,model,grader}=setup(t,{answer:d=>{store.setLevel('d1','store',{by:'owner',now:day(2)});return every('instant')(d);}});
 chatter(store,'g1',hour(20));post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:hour(20)});
 store.setLevel('g1','instant',{by:'owner',now:day(1)});
 assert.deepEqual(grader.plan().due.map(c=>c.feedId).sort(),['d1','g2']);
 await grader.grade();
 assert.ok(!names(model.calls[0].data).includes('项目群'));
 assert.deepEqual([store.level('g1').level,store.level('g1').by,store.level('g1').modelLevel],['instant','owner',null]);
 assert.deepEqual([store.level('d1').level,store.level('d1').by,store.level('d1').modelLevel,store.level('d1').modelReason],['store','owner','instant','张三的理由'],
  'mine stays; the model\'s is kept beside it');
 const r=await grader.grade(['g1']);assert.equal(r.chats,0);assert.equal(model.calls.length,1,'asked for by name, still not shown to the model');
});

test('chats too many for one prompt are graded in parts, each within the limit and each chat once; a chat too big alone keeps its newest messages',async t=>{
 const {store,matters,model,grader}=setup(t,{options:{maxPromptBytes:6000,textChars:100}});
 for(let i=0;i<12;i++)for(let j=0;j<5;j++)chatter(store,`room${i}`,hour(24+i)+j*60e3,{text:`${i}-${j}${'长'.repeat(80)}`});
 for(let j=0;j<30;j++)chatter(store,'big',hour(40)+j*60e3,{text:`big-${j}${'长'.repeat(95)}`});
 const r=await grader.grade();
 assert.ok(model.calls.length>=5,`${model.calls.length} parts`);
 for(const call of model.calls)assert.ok(Buffer.byteLength(call.prompt)<=6000,`${Buffer.byteLength(call.prompt)} bytes`);
 const shown=model.calls.flatMap(c=>names(c.data));
 assert.equal(shown.length,14);assert.equal(new Set(shown).size,14,'each chat once');assert.equal(r.graded.length,14);
 const big=model.calls.flatMap(c=>c.data.chats).find(c=>c.name==='big').messages.map(m=>m.text.split('长')[0]);
 assert.ok(big.length<30&&big.length>0);assert.equal(big.at(-1),'big-29','the newest are kept');
 assert.ok(matters.runs().every(x=>x.kind==='grade'&&x.ok));
});

test('a prompt holds at most maxChats chats, however small they are: the answer needs a reason for each',async t=>{
 const {store,model,grader}=setup(t,{options:{maxChats:4}});
 for(let i=0;i<9;i++)chatter(store,`room${i}`,hour(10+i));
 const r=await grader.grade();
 assert.deepEqual(model.calls.map(c=>c.data.chats.length),[4,4,2]);assert.equal(r.graded.length,10);
 assert.equal(DEFAULTS.maxChats,25);
});

// ---- when chats are graded
test('nothing is graded before butler has kept every message for two days; then every active chat with no level is, and a chat first seen later once its first message is a day old',async t=>{
 const {store,model,grader,tick}=setup(t,{now:day(2)-60e3});
 chatter(store,'g1',hour(5));post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:day(-4)});chatter(store,'quiet',day(-6));
 assert.equal(grader.check(),undefined);assert.equal(model.calls.length,0);
 tick(day(2));
 let r=await grader.check();
 assert.deepEqual(graded(r),['d1','g1','g2'],'not a chat silent for a week');
 assert.equal(grader.check(),undefined,'nothing else is due');
 chatter(store,'g9',day(2)+3600e3);tick(day(2)+7200e3);
 assert.equal(grader.check(),undefined,'a chat first seen later waits until its first message is a day old');
 tick(day(3)+3600e3);r=await grader.check();
 assert.deepEqual(graded(r),['g9']);assert.deepEqual(names(model.calls[1].data),['g9']);
 const none=setup(t,{kept:false,now:day(30)});
 post(none.store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:day(29)});
 assert.equal(none.grader.check(),undefined,'nothing kept beyond what is about me: no sample to grade from');
});

test('every chat is graded again a week after its last grading; 关于TA rewritten is no reason',async t=>{
 const {store,model,grader,tick}=setup(t);
 chatter(store,'g1',hour(20));
 await grader.check();
 store.setMeta('profile',{text:'新的关于TA',at:day(3),notes:[],messages:9});tick(day(3));
 assert.equal(grader.check(),undefined);
 chatter(store,'g1',day(8));tick(day(9)-60e3);
 assert.equal(grader.check(),undefined);
 tick(day(9));const r=await grader.check();
 assert.deepEqual(graded(r),['g1'],'大群 has said nothing for a week');assert.equal(model.calls[1].data.profile,'新的关于TA');
 assert.equal(store.level('g1').modelAt,day(9));
});

test('when my notes change, the chats graded before are graded again once the notes have stayed as they are for an hour',async t=>{
 const {store,matters,model,grader,tick}=setup(t);
 const at=n=>day(2)+n*60e3;
 chatter(store,'g1',hour(20));
 await grader.check();
 matters.addNote('值班群都不看',at(1));tick(at(1));assert.equal(grader.check(),undefined);
 tick(at(30));const note=matters.addNote('机器人通知只存',at(30));assert.equal(grader.check(),undefined,'another change: the hour starts again');
 chatter(store,'g8',day(1));tick(at(40));
 const fresh=await grader.check();assert.deepEqual(graded(fresh),['g8'],'a chat graded with the notes as they are now');
 tick(at(89));assert.equal(grader.check(),undefined);
 tick(at(90));const r=await grader.check();
 assert.deepEqual(graded(r),['g1','g2'],'the chats graded before the change');assert.deepEqual(model.calls[2].data.notes,['值班群都不看','机器人通知只存']);
 tick(at(200));assert.equal(grader.check(),undefined,'and once');
 matters.removeNote(note);tick(at(201));grader.check();tick(at(261));
 assert.deepEqual(graded(await grader.check()),['g1','g2','g8'],'a note removed: the same');
});

test('a chat the model put at instant is graded again at once when it hands the batches burstMessages within the hour; not one I put there, and not twice in the hour',async t=>{
 const {store,matters,grader,tick}=setup(t,{options:{burstMessages:5},answer:every('instant')});
 const at=n=>day(2)+n*60e3,flood=(chat,from,n,more={})=>{for(let i=0;i<n;i++)post(store,{chat,text:`告警 ${i}`,at:at(from+i),categories:['instant'],...more});};
 chatter(store,'g1',hour(20));chatter(store,'g3',hour(20));chatter(store,'g4',hour(20));
 await grader.check();
 store.setLevel('g3','instant',{by:'owner',now:at(1)});
 flood('g1',61,5);flood('g3',61,5);flood('g2',61,4);flood('g4',61,5,{sender:'zebra',name:'Zebra',type:'bot'});matters.ignore('zebra','Zebra');
 tick(at(55));assert.equal(grader.check(),undefined,'graded within the hour');
 tick(at(70));const r=await grader.check();
 assert.deepEqual(graded(r),['g1'],'not mine, not below burstMessages, not an ignored sender\'s');
 flood('g1',71,5);tick(at(80));assert.equal(grader.check(),undefined,'not again within the hour');
 flood('g1',125,5);tick(at(131));assert.deepEqual(graded(await grader.check()),['g1']);
});

test('a pass the model cannot run stops and is on record; the next waits retryMs and then takes up the chats left, in smaller parts',async t=>{
 let down=true;
 const {store,matters,model,grader,tick}=setup(t,{options:{maxPromptBytes:4000,textChars:400},answer:d=>{if(down)throw Error(DOWN);return every()(d);}});
 for(let i=0;i<6;i++)chatter(store,`room${i}`,hour(10+i),{text:'长'.repeat(400)});
 let r=await grader.check();
 const first=model.calls[0].data.chats.length;assert.ok(first>1);
 assert.equal(model.calls.length,1,'the pass stops');assert.match(r.error,/Connection refused/);assert.deepEqual(r.graded,[]);
 const meta=store.meta('grading');assert.deepEqual([meta.at,meta.chats,meta.graded],[day(2),7,0]);assert.match(meta.error,/Connection refused/);
 assert.ok(store.errors().some(e=>e.source==='分级'&&/Connection refused/.test(e.message)));
 assert.deepEqual(matters.runs().map(x=>[x.kind,x.ok]),[['grade',false]]);
 tick(day(2)+60e3);assert.equal(grader.check(),undefined,'not every minute');
 tick(day(2)+DEFAULTS.retryMs-1);assert.equal(grader.check(),undefined);
 down=false;tick(day(2)+DEFAULTS.retryMs);r=await grader.check();
 assert.equal(r.graded.length,7);assert.equal(r.error,undefined);assert.equal(store.meta('grading').error,undefined,'the failure is cleared');
 assert.ok(model.calls[1].data.chats.length<=Math.ceil(first/2),'a failed part halves the next');
});

test('a chat whose answer can never be used ends up alone and holds up no other; a model that answers nothing usable stops the pass',async t=>{
 const {store,model,grader,tick}=setup(t,{answer:d=>names(d).includes('毒')?'我觉得这些聊天都挺重要的':every()(d)});
 for(let i=0;i<3;i++)chatter(store,`room${i}`,hour(10+i));
 for(let i=0;i<9;i++)chatter(store,'毒',hour(20+i));
 let r,passes=0;
 for(let at=day(2);passes<6;at+=DEFAULTS.retryMs,passes++){tick(at);r=await grader.check();if(store.level('room0'))break;}
 assert.ok(passes<4,`${passes} passes`);
 assert.deepEqual(r.left,['毒']);assert.match(r.error,/不是 JSON/);
 assert.deepEqual(['room0','room1','room2','g2'].map(id=>store.level(id)?.level),['daily','daily','daily','daily']);
 assert.equal(store.level('毒'),undefined);
 assert.equal(model.calls.at(-3).data.chats.length,1,'alone in the end');
 const s=setup(t,{answer:()=>'都挺重要的'});
 for(let i=0;i<3;i++)chatter(s.store,`room${i}`,hour(10+i));
 for(let at=day(2);at<day(2)+5*DEFAULTS.retryMs;at+=DEFAULTS.retryMs){s.tick(at);await s.grader.check();}
 assert.ok(s.model.calls.length<=10,`${s.model.calls.length} runs in five passes`);
});

test('grading never waits for the processor: a pass goes through while a batch holds the model',async t=>{
 let release,asked=false,settled=false;const gate=new Promise(r=>{release=r;});
 const {store,matters}=setup(t),busy={async ask(){asked=true;await gate;return '{"new":[],"updates":[]}';}};
 const grader=new Grader({store,matters,model:fakeModel(every()),now:()=>day(2)});
 const processor=new Processor({store,matters,model:busy});
 store.setMeta('profile',{text:'x',at:Date.now(),notes:[],messages:1});store.setMeta('review',{at:Date.now(),reviewed:0,closed:0,profileAt:store.meta('profile').at,notes:[]});
 post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:hour(20)});
 const round=processor.runOnce().finally(()=>{settled=true;});await waitFor(()=>asked,{message:'a batch with the model'});
 const r=await grader.check();
 assert.deepEqual(graded(r),['d1','g2']);assert.equal(settled,false,'the batch is still with the model');
 release();assert.equal((await round).runs,1);
});

test('a running grader checks every checkMs, and stopping it waits for the pass under way',async t=>{
 let release;const gate=new Promise(r=>{release=r;});
 const {store,model,grader}=setup(t,{options:{checkMs:20},answer:async d=>{await gate;return every()(d);}});
 chatter(store,'g1',hour(20));
 grader.start();t.after(()=>{release();return grader.stop();});
 await waitFor(()=>model.calls.length===1,{message:'a pass'});
 await new Promise(r=>setTimeout(r,60));assert.equal(model.calls.length,1,'no second pass while one runs');
 const stopping=grader.stop();release();await stopping;
 assert.equal(store.level('g1').level,'daily');
 chatter(store,'g5',hour(30));await new Promise(r=>setTimeout(r,60));assert.equal(model.calls.length,1,'none after the stop');
});

test('status: the last pass, how many chats the model has graded, how many wait and when the next is due',async t=>{
 const {store,grader,tick}=setup(t,{now:day(1),answer:d=>{if(d.chats.some(c=>c.name==='g7'))throw Error(DOWN);return every()(d);}});
 const pick=s=>({at:s.at,chats:s.chats,graded:s.graded,due:s.due,next:s.next,sampledAt:s.sampledAt,byModel:s.byModel});
 chatter(store,'g1',hour(5));
 assert.deepEqual(pick(grader.status()),{at:undefined,chats:undefined,graded:undefined,due:0,next:day(2),sampledAt:day(2),byModel:0});
 tick(day(2));assert.deepEqual(pick(grader.status()),{at:undefined,chats:undefined,graded:undefined,due:2,next:day(2),sampledAt:day(2),byModel:0});
 await grader.check();
 assert.deepEqual(pick(grader.status()),{at:day(2),chats:2,graded:2,due:0,next:day(9),sampledAt:day(2),byModel:2});
 chatter(store,'g7',day(1)+3600e3);tick(day(2)+3600e3);
 await grader.check();
 const s=grader.status();assert.deepEqual(pick(s),{at:day(2)+3600e3,chats:1,graded:0,due:1,next:day(2)+3600e3+DEFAULTS.retryMs,sampledAt:day(2),byModel:2});
 assert.match(s.error,/Connection refused/);
});

// ---- what grading tells
const byChat=list=>[...list].sort((a,b)=>a.feedId<b.feedId?-1:1);
test('whoever shows grading is told after each pass that graded a chat: how it started, the chats whose level from the model changed, how many were graded and how many not',async t=>{
 const passes=[];let down=false,second=false;
 const {store,grader,tick}=setup(t,{onPass:p=>passes.push(p),answer:d=>{if(down)throw Error(DOWN);
  const r=every('daily',second?{项目群:'store',大群:'instant'}:{项目群:'store'})(d);if(second)r.chats=r.chats.filter(c=>d.chats.find(x=>x.chat===c.chat).name!=='张三');return r;}});
 chatter(store,'g1',hour(20));post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:hour(20)});
 await grader.check();
 assert.equal(passes.length,1);
 assert.deepEqual(byChat(passes[0].changed).map(c=>[c.feedId,c.name,c.before,c.after,c.reason]),
  [['d1','张三',undefined,'daily','张三的理由'],['g1','项目群',undefined,'store','项目群的理由'],['g2','大群',undefined,'daily','大群的理由']],'every chat graded for the first time');
 assert.deepEqual([passes[0].at,passes[0].by,passes[0].graded,passes[0].failed],[day(2),'schedule',3,0],'a pass check started is a scheduled one');
 second=true;for(const c of ['g1','g2'])chatter(store,c,day(8));post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:day(8)});
 tick(day(9));await grader.check();
 assert.deepEqual(passes[1],{at:day(9),by:'schedule',graded:2,failed:1,changed:[{feedId:'g2',name:'大群',before:'daily',after:'instant',reason:'大群的理由'}]},
  'not 项目群, graded the same again; 张三 left out of the answer is not graded');
 await grader.grade(['g1']);
 assert.deepEqual([passes[2].by,passes[2].graded],['request',1],'a pass I asked for (grade) says so');
 down=true;tick(day(20));for(const c of ['g1','g2'])chatter(store,c,day(19));await grader.check();
 assert.equal(passes.length,3,'a pass that graded nothing tells nothing');
});

test('what the grader\'s hook throws or rejects with is recorded and changes nothing',async t=>{
 for(const onPass of [()=>{throw Error('飞书连不上');},async()=>{throw Error('飞书连不上');}]){
  const {store,grader}=setup(t,{onPass});
  const r=await grader.check();await new Promise(r=>setImmediate(r));
  assert.deepEqual(graded(r),['g2']);assert.equal(store.level('g2').level,'daily');
  assert.ok(store.errors().some(e=>e.source==='分级'&&/通知出错.*飞书连不上/.test(e.message)));
 }
});

// ---- the exam: the chats whose level I set, graded again without my level
// Butler has kept everything for two days and graded what was due (大群), so that what check starts next is an exam.
async function examSetup(t,o={}){
 const s=setup(t,o);
 s.store.setMeta('profile',{text:'【工作】\n角色：GEO 服务的后端',at:day(2),notes:[],messages:3});
 await s.grader.check();s.model.calls.length=0;
 return s;
}
const examined=model=>model.calls.map(c=>names(c.data).sort());

test('an exam grades the chats whose level I set as grading would, each shown as ungraded, and scores the answers against my levels',async t=>{
 const {store,matters,model,grader}=await examSetup(t,{answer:d=>{const r=every('daily',{项目群:'instant',张三:'daily'})(d);r.chats=r.chats.filter(c=>d.chats.find(x=>x.chat===c.chat).name!=='旧群');return r;}});
 chatter(store,'g1',hour(30));post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:hour(30)});chatter(store,'old',day(-20));
 store.setLevel('g1','store',{by:'model',reason:'多是通知',now:day(1)});store.setLevel('g1','instant',{by:'owner',reason:'我负责的项目都在这里讨论',now:day(2)});
 store.setLevel('d1','store',{by:'owner',now:day(2)});store.setLevel('old','daily',{by:'owner',now:day(2)});store.upsertChatInfo({feedId:'old',name:'旧群',chatMode:'group'});
 const before=store.levels();
 await grader.check();
 assert.equal(model.calls.length,1);const [{system,prompt,data:d}]=model.calls;
 assert.equal(system,gradingSystemPrompt(matters.me()),'the grading prompt itself');
 assert.deepEqual(names(d).sort(),['张三','旧群','项目群'],'only the chats whose level I set');
 for(const c of d.chats){assert.equal(c.level,null,'shown as ungraded');assert.ok(!('by' in c));}
 assert.doesNotMatch(prompt,/我负责的项目都在这里讨论|多是通知|owner/,'neither my reason nor the model\'s earlier level');
 assert.equal(d.profile,'【工作】\n角色：GEO 服务的后端');
 assert.deepEqual(d.chats.find(c=>c.name==='旧群').messages.map(m=>m.text),['群里的讨论'],'a chat quiet this week is shown its latest messages all the same');
 const exams=matters.exams(5);assert.equal(exams.length,1);const [e]=exams;
 assert.deepEqual([e.at,e.total,e.correct],[day(2),3,1]);
 assert.deepEqual(byChat(e.wrong),[{feedId:'d1',name:'张三',owner:'store',model:'daily',reason:'张三的理由'},{feedId:'old',name:'旧群',owner:'daily',model:undefined,reason:undefined}],
  'a chat the answer left out counts as wrong');
 assert.deepEqual(store.levels(),before,'an exam changes no level');
 assert.deepEqual(matters.runs().slice(-1).map(r=>[r.kind,r.ok,r.messages]),[['exam',true,3]]);
});

test('an exam follows a new 关于TA or a change of my notes, once 关于TA has caught up with them, if 关于TA, my notes or the levels I set changed since the last; at most once per examMs',async t=>{
 const {store,matters,model,grader,tick}=await examSetup(t);
 const profile=(text,at,notes=[])=>store.setMeta('profile',{text,at,notes,messages:3}),h=n=>day(2)+n*3600e3;
 assert.equal(grader.check(),undefined,'no level of mine, no exam');
 store.setLevel('g2','instant',{by:'owner',now:day(2)});
 const none=setup(t);none.store.setLevel('g2','instant',{by:'owner',now:day(2)});await none.grader.check();
 none.store.setMeta('profile',{failedAt:day(2),error:'x'});
 assert.equal(none.grader.check(),undefined,'no 关于TA yet, nothing to test');
 await grader.check();assert.deepEqual(examined(model),[['大群']],'the first exam: there has been none');
 assert.equal(grader.check(),undefined,'nothing new');
 tick(h(2));store.setLevel('d1','store',{by:'owner',now:h(2)});post(store,{chat:'d1',name:'张三',sender:'u3',text:'在吗',at:day(2)});
 assert.equal(grader.check(),undefined,'a level I set waits for the next 关于TA');
 profile('【工作】\n角色：GEO 服务的后端',h(2));
 await grader.check();assert.deepEqual(examined(model).at(-1),['大群','张三'],'关于TA written again, the same, but a level of mine is new');
 tick(h(3.5));profile('【工作】\n角色：GEO 服务的后端',h(3.5));
 assert.equal(grader.check(),undefined,'关于TA written again, the same, and nothing else new');
 tick(h(4));profile('【工作】\n角色：后端',h(4));
 await grader.check();assert.equal(model.calls.length,3,'a new 关于TA');
 tick(h(4.5));profile('【工作】\n角色：前端',h(4.5));
 assert.equal(grader.check(),undefined,'within the hour');
 tick(h(5));await grader.check();assert.equal(model.calls.length,4,'an hour on');
 tick(h(7));const note=matters.addNote('值班群都不看',h(7));
 assert.equal(grader.check(),undefined,'my notes changed, but 关于TA has not caught up with them');
 profile('【工作】\n角色：前端',h(7),[note]);
 await grader.check();assert.equal(model.calls.length,5);assert.deepEqual(model.calls[4].data.notes,['值班群都不看']);
 assert.equal(DEFAULTS.examMs,3600e3);
 assert.deepEqual(matters.exams(10).map(e=>e.at),[h(7),h(5),h(4),h(2),day(2)],'newest first');
});

test('an exam that fails is on record and tried again examMs later; grading goes first, and its wait after a failure holds up no exam',async t=>{
 let down=false;
 const {store,matters,model,grader,tick}=await examSetup(t,{answer:d=>{if(down)throw Error(DOWN);return names(d).includes('毒')?'都挺重要的':every()(d);}});
 store.setLevel('g1','instant',{by:'owner',now:day(2)});chatter(store,'g1',hour(30));
 down=true;await grader.check();
 assert.deepEqual(matters.exams(5),[]);
 const e=store.meta('exam');assert.equal(e.failedAt,day(2));assert.match(e.error,/Connection refused/);
 assert.ok(store.errors().some(x=>x.source==='分级'&&/纠正题.*Connection refused/.test(x.message)));
 assert.deepEqual(matters.runs().slice(-1).map(r=>[r.kind,r.ok]),[['exam',false]]);
 down=false;tick(day(2)+3600e3-1);assert.equal(grader.check(),undefined);
 chatter(store,'毒',hour(10));chatter(store,'g5',hour(10));tick(day(2)+3600e3);
 let r=await grader.check();assert.deepEqual(r.left,['毒'],'grading goes first');assert.deepEqual(matters.exams(5),[]);
 r=await grader.check();assert.equal(matters.exams(5).length,1,'then the exam, while grading waits after leaving a chat');
 assert.equal(store.meta('exam').error,undefined,'the failure is cleared');assert.equal(model.calls.at(-1).data.chats.length,1);
});
