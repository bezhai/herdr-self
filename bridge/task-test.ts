// Tests of task-core.ts (see package.json); run with node --test. Vocabulary is deliberately neutral: sinks s1/s2, addresses {room:'r1'}, refs src:1.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Tasks} from './task-core.ts';
import type {Verdict,Target,JournalRecord} from './task-types.ts';
// A sink that records its calls; fail makes the next calls reject, receipt numbers them.
function fakeSink(){const calls:{to:unknown,body:unknown,key:string}[]=[];const s={calls,fail:null as string|null,send:async(to:unknown,body:unknown,key:string)=>{calls.push({to,body,key});if(s.fail)throw Error(s.fail);return {receipt:calls.length};}};return s;}
// A policy whose answers tests set: by sink name for deliveries ('task' for task targets) and one for ends.
function fakePolicy(){const p={deliveries:{} as Record<string,Verdict>,end:'allow' as Verdict,
 deliver:(_t:unknown,_o:unknown,target:Target):Verdict=>p.deliveries['sink' in target?target.sink:'task']??'allow'};return p;}
// A fixture with a clock the test advances, sinks s1 and s2 and a database in memory or at a path.
function fixture(file=':memory:'){
 const s1=fakeSink(),s2=fakeSink(),policy=fakePolicy();let t=1000;
 const open=()=>new Tasks(file,{sinks:{s1,s2},policy:{deliver:policy.deliver,end:()=>policy.end},now:()=>t++});
 return {s1,s2,policy,tasks:open(),open};
}
const types=(rs:JournalRecord[])=>rs.map(r=>r.type);
const code=(c:string)=>(e:unknown)=>(e as {code?:string}).code===c;
const tick=()=>new Promise(r=>setImmediate(r));

test('create journals the task and its first inputs; goal changes are journaled', async()=>{
 const {tasks}=fixture();
 const t=tasks.create('say hi to r1',[{body:'a',ref:'src:1'},{body:'b'}]);
 assert.equal(t.goal,'say hi to r1');assert.equal(t.state,'open');
 tasks.setGoal(t.id,'say hello to r1');
 const v=tasks.get(t.id);
 assert.equal(v.goal,'say hello to r1');assert.deepEqual(v.inputs.map(i=>i.body),['a','b']);
 const j=tasks.journal(t.id);
 assert.deepEqual(types(j),['task.created','input.added','input.added','goal.changed']);
 assert.deepEqual(j[3]!.data,{from:'say hi to r1',to:'say hello to r1'});
 assert.ok(j[0]!.seq<j[1]!.seq&&j[0]!.at<j[3]!.at);
 assert.deepEqual(types(tasks.journal(t.id,j[2]!.seq)),['goal.changed']);
 assert.throws(()=>tasks.get('nope'),code('not_found'));assert.throws(()=>tasks.setGoal('nope','x'),code('not_found'));
});

test('addInput with a ref already in the task returns the existing input and journals nothing', async()=>{
 const {tasks}=fixture();const t=tasks.create('g'),u=tasks.create('g2');
 const a=tasks.addInput(t.id,{n:1},'src:1'),b=tasks.addInput(t.id,{n:2},'src:1'),c=tasks.addInput(u.id,{n:3},'src:1');
 assert.equal(b.id,a.id);assert.deepEqual(b.body,{n:1});assert.notEqual(c.id,a.id);
 tasks.addInput(t.id,'x');tasks.addInput(t.id,'x');
 assert.equal(tasks.get(t.id).inputs.length,3);
 assert.deepEqual(types(tasks.journal(t.id)),['task.created','input.added','input.added','input.added']);
});

test('allow: the sink is called with the delivery key and the receipt is kept', async()=>{
 const {tasks,s1}=fixture();const t=tasks.create('g'),o=tasks.addOutput(t.id,{text:'hello'});
 const d=await tasks.deliver(o.id,{sink:'s1',to:{room:'r1'}});
 assert.equal(d.state,'delivered');assert.deepEqual(d.receipt,{receipt:1});
 assert.deepEqual(s1.calls,[{to:{room:'r1'},body:{text:'hello'},key:d.key}]);
 assert.deepEqual(types(tasks.journal(t.id)),['task.created','output.added','delivery.sending','delivery.delivered']);
 await assert.rejects(tasks.deliver(o.id,{sink:'zz',to:1}),code('unknown_sink'));
 await assert.rejects(tasks.deliver('nope',{sink:'s1',to:1}),code('not_found'));
 await assert.rejects(tasks.deliver(o.id,{task:'nope'}),code('not_found'));
});

test('deny rejects the delivery without calling the sink', async()=>{
 const {tasks,s1,policy}=fixture();policy.deliveries.s1='deny';
 const t=tasks.create('g'),o=tasks.addOutput(t.id,'x');
 const d=await tasks.deliver(o.id,{sink:'s1',to:'r'});
 assert.equal(d.state,'rejected');assert.equal(s1.calls.length,0);
 assert.deepEqual(types(tasks.journal(t.id)).slice(-1),['delivery.rejected']);
});

test('approve waits for decide; approving sends, rejecting records the decision and note', async()=>{
 const {tasks,s1,policy}=fixture();policy.deliveries.s1='approve';
 const t=tasks.create('g'),o=tasks.addOutput(t.id,'x');
 const d=await tasks.deliver(o.id,{sink:'s1',to:'r'});
 assert.equal(d.state,'awaiting');assert.equal(s1.calls.length,0);
 const ok=await tasks.decide(d.id,true,undefined,'fine');
 assert.equal(ok.state,'delivered');assert.equal(s1.calls[0]!.key,d.key);assert.equal(s1.calls[0]!.body,'x');
 const j=tasks.journal(t.id);assert.deepEqual(types(j).slice(-3),['delivery.awaiting','delivery.sending','delivery.delivered']);
 assert.equal(j.at(-2)!.data.decision,'approved');assert.equal(j.at(-2)!.data.note,'fine');
 await assert.rejects(tasks.decide(d.id,true),code('bad_state'));
 const o2=tasks.addOutput(t.id,'y'),d2=await tasks.deliver(o2.id,{sink:'s1',to:'r'});
 const no=await tasks.decide(d2.id,false,undefined,'not this');
 assert.equal(no.state,'rejected');assert.equal(s1.calls.length,1);
 assert.deepEqual(tasks.journal(t.id).at(-1)!.data.note,'not this');assert.equal(tasks.journal(t.id).at(-1)!.data.decision,'rejected');
});

test('approving with a changed body replaces the body and the key; the same body keeps the key', async()=>{
 const {tasks,s1,policy}=fixture();policy.deliveries.s1='approve';
 const t=tasks.create('g'),o=tasks.addOutput(t.id,{text:'draft'});
 const d=await tasks.deliver(o.id,{sink:'s1',to:'r'});
 const e=await tasks.decide(d.id,true,{text:'edited'});
 assert.deepEqual(e.body,{text:'edited'});assert.notEqual(e.key,d.key);assert.deepEqual(s1.calls[0],{to:'r',body:{text:'edited'},key:e.key});
 const o2=tasks.addOutput(t.id,{text:'same'}),d2=await tasks.deliver(o2.id,{sink:'s1',to:'r'});
 const e2=await tasks.decide(d2.id,true,{text:'same'});assert.equal(e2.key,d2.key);
});

test('retry reuses the key, goes through the policy again and only applies to failed deliveries', async()=>{
 const {tasks,s1,policy}=fixture();const t=tasks.create('g'),o=tasks.addOutput(t.id,'x');
 s1.fail='down';
 const d=await tasks.deliver(o.id,{sink:'s1',to:'r'});
 assert.equal(d.state,'failed');assert.equal(d.error,'down');
 s1.fail=null;
 const r=await tasks.retry(d.id);
 assert.equal(r.state,'delivered');assert.equal(r.key,d.key);assert.equal(s1.calls[1]!.key,s1.calls[0]!.key);
 await assert.rejects(tasks.retry(d.id),code('bad_state'));
 s1.fail='down';const o2=tasks.addOutput(t.id,'y'),f=await tasks.deliver(o2.id,{sink:'s1',to:'r'});
 policy.deliveries.s1='approve';
 assert.equal((await tasks.retry(f.id)).state,'awaiting');
 const f2=await tasks.decide(f.id,false);assert.equal(f2.state,'rejected');
 const o3=tasks.addOutput(t.id,'z');policy.deliveries.s1='allow';s1.fail='down';
 const g=await tasks.deliver(o3.id,{sink:'s1',to:'r'});policy.deliveries.s1='deny';
 assert.equal((await tasks.retry(g.id)).state,'rejected');
});

test('deliver of the same output and target returns the live delivery; a rejected or failed one allows a new one', async()=>{
 const {tasks,policy,s1}=fixture();policy.deliveries.s1='approve';
 const t=tasks.create('g'),o=tasks.addOutput(t.id,'x');
 const a=await tasks.deliver(o.id,{sink:'s1',to:{room:'r1'}}),b=await tasks.deliver(o.id,{sink:'s1',to:{room:'r1'}});
 assert.equal(b.id,a.id);
 const other=await tasks.deliver(o.id,{sink:'s1',to:{room:'r2'}});assert.notEqual(other.id,a.id);
 await tasks.decide(a.id,true);assert.equal((await tasks.deliver(o.id,{sink:'s1',to:{room:'r1'}})).id,a.id);
 await tasks.decide(other.id,false);
 const again=await tasks.deliver(o.id,{sink:'s1',to:{room:'r2'}});assert.notEqual(again.id,other.id);
 assert.equal(s1.calls.length,1);
});

test('deliveries left sending by a crash become failed (interrupted) on open and retry with the same key', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-test-')),file=path.join(dir,'t.db');
 try{
  const f=fixture(file);const t=f.tasks.create('g'),o=f.tasks.addOutput(t.id,'x');
  let release=()=>{};f.s1.send=()=>new Promise<never>((_,rej)=>{release=()=>rej(Error('late'));});
  const pending=f.tasks.deliver(o.id,{sink:'s1',to:'r'});await tick();
  const sending=f.tasks.get(t.id).deliveries[0]!;assert.equal(sending.state,'sending');
  const f2=fixture(file);
  const d=f2.tasks.get(t.id).deliveries[0]!;
  assert.equal(d.state,'failed');assert.equal(d.error,'interrupted');assert.equal(d.key,sending.key);
  assert.equal(f2.tasks.journal(t.id).at(-1)!.type,'delivery.failed');
  assert.equal((await f2.tasks.retry(d.id)).key,sending.key);assert.equal(f2.s1.calls[0]!.key,sending.key);
  release();await pending.catch(()=>{});
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('delivering to a task is one transaction that adds an input carrying the delivery id', async()=>{
 const {tasks}=fixture();const a=tasks.create('ask b'),b=tasks.create('answer a');
 const o=tasks.addOutput(b.id,{answer:42});
 const d=await tasks.deliver(o.id,{task:a.id});
 assert.equal(d.state,'delivered');
 const inp=tasks.get(a.id).inputs;assert.equal(inp.length,1);assert.deepEqual(inp[0]!.body,{answer:42});assert.equal(inp[0]!.delivery,d.id);assert.equal(inp[0]!.ref,null);
 assert.deepEqual(types(tasks.journal(a.id)),['task.created','input.added']);
 assert.deepEqual(types(tasks.journal(b.id)),['task.created','output.added','delivery.delivered']);
});

test('a task-to-task delivery that needs approval waits, then delivers on approval', async()=>{
 const {tasks,policy}=fixture();policy.deliveries.task='approve';
 const a=tasks.create('a'),b=tasks.create('b'),o=tasks.addOutput(b.id,'r');
 const d=await tasks.deliver(o.id,{task:a.id});assert.equal(d.state,'awaiting');assert.equal(tasks.get(a.id).inputs.length,0);
 assert.equal((await tasks.decide(d.id,true,'edited')).state,'delivered');assert.deepEqual(tasks.get(a.id).inputs.map(i=>i.body),['edited']);
});

test('an ended task refuses outputs and deliveries but keeps inputs, and reopen restores them', async()=>{
 const {tasks,policy}=fixture();policy.deliveries.s1='approve';
 const t=tasks.create('g'),o=tasks.addOutput(t.id,'x'),f=tasks.addOutput(t.id,'y');
 const d=await tasks.deliver(o.id,{sink:'s1',to:'r'});
 tasks.end(t.id,'dropped','no need');
 assert.equal(tasks.get(t.id).state,'dropped');
 assert.throws(()=>tasks.addOutput(t.id,'z'),code('ended'));
 await assert.rejects(tasks.deliver(f.id,{sink:'s1',to:'r'}),code('ended'));
 await assert.rejects(tasks.decide(d.id,true),code('ended'));
 await assert.rejects(tasks.retry(d.id),code('ended'));
 const inp=tasks.addInput(t.id,'late','src:9');assert.equal(tasks.get(t.id).inputs.at(-1)!.id,inp.id);
 assert.throws(()=>tasks.end(t.id,'dropped','again'),code('ended'));
 assert.throws(()=>tasks.reopen('nope','x'),code('not_found'));
 tasks.reopen(t.id,'the input came back');assert.equal(tasks.get(t.id).state,'open');
 assert.throws(()=>tasks.reopen(t.id,'x'),code('bad_state'));
 tasks.addOutput(t.id,'ok');
 assert.deepEqual(types(tasks.journal(t.id)).slice(-4),['task.ended','input.added','task.reopened','output.added']);
});

test('achieved is refused while a delivery is awaiting or sending; dropped works and rejects awaiting ones', async()=>{
 const {tasks,policy,s1}=fixture();policy.deliveries.s1='approve';
 const t=tasks.create('g'),o=tasks.addOutput(t.id,'x');
 const d=await tasks.deliver(o.id,{sink:'s1',to:'r'});
 assert.throws(()=>tasks.end(t.id,'achieved','done'),code('pending'));assert.equal(tasks.get(t.id).state,'open');
 await tasks.decide(d.id,true);tasks.end(t.id,'achieved','done');assert.equal(tasks.get(t.id).state,'achieved');
 const u=tasks.create('g2'),p=tasks.addOutput(u.id,'x');const w=await tasks.deliver(p.id,{sink:'s1',to:'r'});
 tasks.end(u.id,'dropped','abandon');
 assert.equal(tasks.get(u.id).deliveries[0]!.state,'rejected');assert.equal(tasks.get(u.id).state,'dropped');assert.equal(w.state,'awaiting');
 policy.deliveries.s1='allow';let release=()=>{};s1.send=()=>new Promise<{receipt:number}>(r=>{release=()=>r({receipt:0});});
 const v=tasks.create('g3'),q=tasks.addOutput(v.id,'x'),run=tasks.deliver(q.id,{sink:'s1',to:'r'});await tick();
 assert.throws(()=>tasks.end(v.id,'achieved','x'),code('pending'));release();await run;tasks.end(v.id,'achieved','x');
});

test('the end policy: deny refuses, approve keeps the task open until decideEnd', async()=>{
 const {tasks,policy}=fixture();const t=tasks.create('g');
 policy.end='deny';assert.throws(()=>tasks.end(t.id,'dropped','x'),code('denied'));assert.equal(tasks.get(t.id).state,'open');
 policy.end='approve';
 const r=tasks.end(t.id,'achieved','done');assert.equal(r.state,'open');assert.deepEqual(r.pendingEnd,{outcome:'achieved',reason:'done'});
 assert.throws(()=>tasks.end(t.id,'dropped','x'),code('bad_state'));
 tasks.decideEnd(t.id,false,'not yet');assert.equal(tasks.get(t.id).pendingEnd,null);assert.equal(tasks.get(t.id).state,'open');
 tasks.end(t.id,'achieved','done again');const e=tasks.decideEnd(t.id,true,'ok');assert.equal(e.state,'achieved');assert.equal(e.pendingEnd,null);
 assert.throws(()=>tasks.decideEnd(t.id,true),code('ended'));assert.throws(()=>tasks.decideEnd(tasks.create('g3').id,true),code('bad_state'));
 assert.deepEqual(types(tasks.journal(t.id)).slice(1,6),['end.denied','end.requested','end.rejected','end.requested','task.ended']);
 const u=tasks.create('g2');tasks.end(u.id,'dropped','x');assert.equal(tasks.get(u.id).pendingEnd!.outcome,'dropped');
});

test('observers see every record in order, a new name starts at the latest, a throwing handler gets the record again', async()=>{
 const {tasks}=fixture();const t=tasks.create('before');
 const seen:string[]=[];let boom=true;
 const stop=tasks.observe('v',r=>{if(r.type==='goal.changed'&&boom){boom=false;throw Error('x');}seen.push(r.type);});
 await tasks.settled();assert.deepEqual(seen,[]);
 tasks.addInput(t.id,'a');tasks.setGoal(t.id,'g2');tasks.addInput(t.id,'b');await tasks.settled();
 assert.deepEqual(seen,['input.added']);
 tasks.addInput(t.id,'c');await tasks.settled();
 assert.deepEqual(seen,['input.added','goal.changed','input.added','input.added']);
 stop();tasks.addInput(t.id,'d');await tasks.settled();assert.equal(seen.length,4);
 let again=0;tasks.observe('v',()=>{again++;});await tasks.settled();assert.equal(again,1);
});

test('an observer awaits its handler before the next record, and may call operations', async()=>{
 const {tasks}=fixture();const t=tasks.create('g');const order:string[]=[];
 tasks.observe('w',async r=>{order.push('start '+r.type);await tick();await tick();order.push('end '+r.type);if(r.type==='input.added')tasks.addOutput(t.id,'echo');});
 tasks.addInput(t.id,'a');tasks.setGoal(t.id,'h');await tasks.settled();
 assert.deepEqual(order,['start input.added','end input.added','start goal.changed','end goal.changed','start output.added','end output.added']);
});

test('everything and the observers cursors survive reopening the database', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-test-')),file=path.join(dir,'t.db');
 try{
  const f=fixture(file);const t=f.tasks.create('g',[{body:1,ref:'src:1'}]),o=f.tasks.addOutput(t.id,'x');
  await f.tasks.deliver(o.id,{sink:'s1',to:'r'});
  const seen:number[]=[];const stop=f.tasks.observe('v',r=>{seen.push(r.seq);});
  f.tasks.addInput(t.id,'a');await f.tasks.settled();
  const before=f.tasks.get(t.id),journal=f.tasks.journal(t.id);stop();
  f.tasks.addInput(t.id,'missed-while-down');
  await f.tasks.close();
  const g=f.open();
  assert.deepEqual(g.get(t.id),{...before,inputs:[...before.inputs,g.get(t.id).inputs.at(-1)!]});
  assert.equal(g.journal(t.id).length,journal.length+1);assert.deepEqual(g.list().map(x=>x.id),[t.id]);assert.equal(g.list('achieved').length,0);
  assert.equal(g.addInput(t.id,'dup','src:1').body,1);
  const resumed:string[]=[];g.observe('v',r=>{resumed.push(r.type);});await g.settled();
  assert.deepEqual(resumed,['input.added']);
  await g.close();
 }finally{fs.rmSync(dir,{recursive:true});}
});

// The four real cases, as plain scenarios.
test('scenario: a request is answered through a sink that needs approval, then closed on the requester acknowledgement', async()=>{
 const {tasks,s1,policy}=fixture();policy.deliveries.s1='approve';
 const t=tasks.create('answer the question from p1',[{body:'what is x?',ref:'src:1'}]);
 const o=tasks.addOutput(t.id,'x is 1');const d=await tasks.deliver(o.id,{sink:'s1',to:{room:'r1'}});
 assert.equal(d.state,'awaiting');await tasks.decide(d.id,true,'x is one');
 assert.equal(s1.calls[0]!.body,'x is one');
 tasks.addInput(t.id,'thanks','src:2');tasks.end(t.id,'achieved','p1 acknowledged');
 assert.equal(tasks.get(t.id).state,'achieved');
});
test('scenario: a code change is delivered to a sink', async()=>{
 const {tasks,s2}=fixture();const t=tasks.create('fix the bug in repo q');
 const o=tasks.addOutput(t.id,{diff:'--- a\n+++ b'});await tasks.deliver(o.id,{sink:'s2',to:{repo:'q',branch:'fix'}});
 assert.deepEqual(s2.calls[0]!.to,{repo:'q',branch:'fix'});tasks.end(t.id,'achieved','change delivered');assert.equal(tasks.list('achieved').length,1);
});
test('scenario: a scheduled report is delivered and ended directly', async()=>{
 const {tasks,s1}=fixture();const t=tasks.create('daily report to r2');
 const o=tasks.addOutput(t.id,'all quiet');await tasks.deliver(o.id,{sink:'s1',to:{room:'r2'}});tasks.end(t.id,'achieved','sent');
 assert.equal(s1.calls.length,1);assert.equal(tasks.get(t.id).state,'achieved');
});
test('scenario: task A creates task B and the result of B arrives in A as an input', async()=>{
 const {tasks}=fixture();const a=tasks.create('plan the trip'),b=tasks.create('find a flight',[{body:'to city c'}]);
 const o=tasks.addOutput(b.id,{flight:'f1'});await tasks.deliver(o.id,{task:a.id});tasks.end(b.id,'achieved','found');
 assert.deepEqual(tasks.get(a.id).inputs.map(i=>i.body),[{flight:'f1'}]);assert.equal(tasks.get(b.id).state,'achieved');
});

test('a delivery whose sink is gone after reopening fails with an error naming the sink', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-test-')),file=path.join(dir,'t.db');
 try{
  const f=fixture(file);f.s1.fail='down';const t=f.tasks.create('g'),o=f.tasks.addOutput(t.id,'x');
  const d=await f.tasks.deliver(o.id,{sink:'s1',to:'r'});await f.tasks.close();
  const g=new Tasks(file,{sinks:{s2:f.s2},policy:{deliver:()=>'allow',end:()=>'allow'},now:()=>5000});
  const r=await g.retry(d.id);
  assert.equal(r.state,'failed');assert.match(r.error!,/s1/);assert.match(r.error!,/sink/);assert.equal(g.get(t.id).deliveries[0]!.state,'failed');
  await g.close();
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('a replaced observer whose handler is still running does not move the cursor backwards', async()=>{
 const {tasks}=fixture();const t=tasks.create('g');
 let release=()=>{};const gate=new Promise<void>(r=>{release=r;});
 const stopOld=tasks.observe('v',()=>gate);
 tasks.addInput(t.id,'a');await tick();
 stopOld();const seen:string[]=[];tasks.observe('v',r=>{seen.push(r.type);});
 tasks.addInput(t.id,'b');await tick();await tick();
 assert.equal(seen.length,2);
 release();await tick();await tick();
 const late:string[]=[];tasks.observe('v',r=>{late.push(r.type);});await tasks.settled();
 assert.deepEqual(late,[]);
});
