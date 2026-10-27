import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {tempStore,post,LINK_BASE} from './helpers.mjs';
import {Matters} from '../matters.mjs';
import {review} from '../review.mjs';
import {DEFAULTS} from '../processor.mjs';
import {Store} from '../store.mjs';

process.env.TZ='Asia/Shanghai';
const T0=Date.parse('2026-10-23T09:00:00+08:00'),min=n=>T0+n*60e3,NOW=T0+3*86400e3;
// A fake model: answer(data, call) returns the reply for one prompt (an object, a string, or it throws); every prompt
// it saw is kept.
function fakeModel(answer=()=>({updates:[]})){
 const model={calls:[],async ask({system,prompt}){
  const data=JSON.parse(prompt.slice(prompt.indexOf('{')));model.calls.push({system,prompt,data});
  const out=await answer(data,model.calls.length);return typeof out==='string'?out:JSON.stringify(out);
 }};
 return model;
}
const messagesOf=data=>data.chats.flatMap(c=>c.messages);
function setup(t,{answer,options}={}){
 const {store}=tempStore(t),matters=new Matters(store),model=fakeModel(answer);
 // A matter as a batch would have made it, from messages already processed.
 const made=(title,ids,urgency='normal')=>matters.apply({created:[{title,who:'陈帆',ask:`处理${title}`,due:null,urgency,messageIds:ids}],processedIds:ids,now:min(100)})[0];
 const run=(extra={},stopped)=>review({store,matters,model,options:{...DEFAULTS,...options,...extra},now:()=>NOW,stopped});
 return {store,matters,model,made,run};
}

test('the review shows every open matter with its latest messages and its chats\' latest, mine included, and applies what the model decides',async t=>{
 const {store,matters,model,made,run}=setup(t,{answer:d=>{
  const id=title=>d.matters.find(m=>m.title===title).matter;
  return {updates:[{matter:id('审批合并请求'),status:'closed',reason:'TA已经回复「已批」'},{matter:id('查询任务成功'),status:'closed',reason:'只是成功通知，不用TA做什么'},
   {matter:id('评审方案'),urgency:'high',due:'今天 18:00'}]};
 }});
 const ask=post(store,{text:'@原智鸿 帮忙审批下合并请求',at:min(1)});
 for(let i=0;i<3;i++)post(store,{chat:'g2',name:'李四',text:`大群闲聊${i}`,at:min(2+i)});
 const sql=post(store,{chat:'sql',name:'SQL 平台',type:'bot',text:'查询任务运行成功',at:min(3)});
 const plan=post(store,{chat:'g2',text:'@原智鸿 方案评审一下',at:min(1)});
 post(store,{mine:true,text:'已批',at:min(10)});
 post(store,{chat:'g1',sender:'zebra',name:'Zebra2.0自动化投放平台',type:'bot',text:'投放任务完成',at:min(11)});matters.ignore('zebra','Zebra2.0自动化投放平台');
 const a=made('审批合并请求',[ask]),b=made('查询任务成功',[sql],'low'),c=made('评审方案',[plan]);
 matters.close(made('我已经关掉的',[post(store,{chat:'old',text:'旧事',at:min(0)})]),'不用了');
 const r=await run();
 assert.deepEqual(r,{runs:1,reviewed:3,closed:2,complete:true});
 const [call]=model.calls,d=call.data;
 assert.match(call.system,/不新建事项/);
 assert.deepEqual(d.matters.map(m=>m.matter).sort(),[a,b,c].sort(),'every open matter, and only those');
 const shown=d.matters.find(m=>m.matter===a);
 assert.deepEqual({since:shown.since,last:shown.last,chats:shown.chats},{since:'10-23 09:01',last:'10-23 09:01',chats:['项目群']});
 const texts=messagesOf(d).map(m=>m.text);
 assert.ok(texts.includes('已批')&&messagesOf(d).find(m=>m.text==='已批').mine,'my reply in its chat comes along');
 assert.ok(texts.includes('大群闲聊2'),'the latest messages of the matter\'s chats');
 assert.ok(!texts.some(t=>/投放任务完成|旧事/.test(t)),'no ignored senders, no closed matters');
 const ended=matters.matter(a);
 assert.deepEqual([ended.status,ended.closedBy,ended.reason,ended.closedAt],['closed','model','TA已经回复「已批」',NOW]);
 assert.equal(matters.matter(b).status,'closed');
 const kept=matters.matter(c);assert.deepEqual([kept.status,kept.urgency,kept.due],['open','high','今天 18:00']);
 assert.equal(matters.list({all:true}).length,4,'a review makes no matter');
 const [runRecord]=matters.runs();
 assert.deepEqual([runRecord.kind,runRecord.ok,runRecord.messages,runRecord.matters],['review',true,0,3]);assert.ok(runRecord.output.includes('已批'));
});

test('the latest few messages: of each matter, and of each of its chats',async t=>{
 const {store,model,made,run}=setup(t,{options:{matterMessages:2,contextMessages:3}});
 const ids=[];for(let i=0;i<6;i++)ids.push(post(store,{text:`事项消息${i}`,at:min(i)}));
 for(let i=0;i<5;i++)post(store,{text:`后来的${i}`,at:min(10+i)});
 made('一件事',ids);
 await run();
 assert.deepEqual(messagesOf(model.calls[0].data).map(m=>m.text),['事项消息4','事项消息5','后来的2','后来的3','后来的4']);
});

test('a reply that would make a matter, or points elsewhere, has those parts left out and on record',async t=>{
 const {store,matters,made,run}=setup(t,{answer:d=>({new:[{title:'冒出来的',who:'x',ask:'y',urgency:'low',messages:['m1']}],
  updates:[{matter:999,status:'closed',reason:'r'},{matter:d.matters[0].matter,status:'closed'}]})});
 made('一件事',[post(store,{text:'@原智鸿 看下',at:min(1)})]);
 const r=await run();
 assert.deepEqual([r.closed,r.complete],[0,true]);
 assert.equal(matters.list({all:true}).length,1);assert.equal(matters.list().length,1,'no reason, no close');
 const errors=store.errors(10).map(e=>e.message).join('\n');
 for(const p of [/新建/,/#999/,/理由/])assert.match(errors,p);
});

test('matters too many for one prompt are reviewed in parts, each within the limit, matters of one chat together',async t=>{
 const {store,model,made,run}=setup(t,{options:{maxPromptBytes:9000}});
 const chats=['g1','g2','c3','c4'],byTitle=new Map();
 for(let i=0;i<12;i++){const chat=chats[i%4];byTitle.set(`事项${i}`,chat);made(`事项${i}`,[post(store,{chat,text:`${i}${'长'.repeat(400)}`,at:min(i)})]);}
 const r=await run();
 assert.ok(r.runs>1);assert.deepEqual([r.reviewed,r.complete],[12,true]);
 assert.ok(model.calls.every(c=>Buffer.byteLength(c.prompt)<=9000));
 const parts=model.calls.map(c=>c.data.matters.map(m=>m.title));
 assert.deepEqual(parts.flat().sort(),[...byTitle.keys()].sort(),'every matter once');
 const order=parts.flat().map(x=>byTitle.get(x));
 assert.equal(order.filter((c,i)=>c!==order[i-1]).length,chats.length,'the matters of one chat follow one another');
 assert.ok(parts.some(p=>p.length>1),'a part holds as many matters as fit');
});

test('a part that fails is recorded and rejects; the parts before it stay applied, nothing after it runs',async t=>{
 const {store,matters,model,made,run}=setup(t,{options:{maxPromptBytes:5000},answer:(d,n)=>{
  if(n===2)throw Error('herdr --machine cpu1-butler：ssh: connect to host port 22: Connection refused');
  return {updates:d.matters.map(m=>({matter:m.matter,status:'closed',reason:'过时了'}))};
 }});
 for(let i=0;i<6;i++)made(`事项${i}`,[post(store,{chat:`c${i}`,text:`${i}${'长'.repeat(700)}`,at:min(i)})]);
 await assert.rejects(run(),/Connection refused/);
 assert.equal(model.calls.length,2);
 const first=model.calls[0].data.matters.length;
 assert.equal(matters.list().length,6-first,'the first part\'s closes stand');
 assert.deepEqual(matters.runs().map(r=>[r.kind,r.ok]),[['review',true],['review',false]]);
 assert.match(matters.runs()[1].error,/Connection refused/);
});

test('stopping between parts: no further part starts, and the review is not complete',async t=>{
 let stop=false;
 const {store,model,made,run}=setup(t,{options:{maxPromptBytes:5000},answer:()=>{stop=true;return {updates:[]};}});
 for(let i=0;i<4;i++)made(`事项${i}`,[post(store,{chat:`c${i}`,text:`${i}${'长'.repeat(700)}`,at:min(i)})]);
 const r=await run({},()=>stop);
 assert.deepEqual([r.runs,r.complete],[1,false]);assert.ok(r.reviewed<4);assert.equal(model.calls.length,1);
});

test('with nothing open there is no model run',async t=>{
 const {model,run}=setup(t);
 assert.deepEqual(await run(),{runs:0,reviewed:0,closed:0,complete:true});assert.equal(model.calls.length,0);
});

test('model runs recorded before reviews existed count as batches',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(file);
 db.exec('CREATE TABLE model_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, messages INTEGER NOT NULL, prompt_bytes INTEGER NOT NULL, ok INTEGER, error TEXT, output TEXT)');
 db.prepare('INSERT INTO model_runs(started_at,messages,prompt_bytes,ok) VALUES(?,?,?,1)').run(T0,12,3000);db.close();
 const store=new Store(file,{linkBase:LINK_BASE});t.after(()=>store.close());
 const [old]=new Matters(store).runs();
 assert.deepEqual([old.kind,old.messages,old.matters],['batch',12,undefined]);
});
