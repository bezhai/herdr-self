import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post} from './helpers.mjs';
import {Matters} from '../matters.mjs';
import {writeProfile} from '../profile.mjs';
import {DEFAULTS} from '../processor.mjs';

process.env.TZ='Asia/Shanghai';
const T0=Date.parse('2026-10-23T09:00:00+08:00'),min=n=>T0+n*60e3,NOW=T0+86400e3;
// A fake model: answer(data, call) returns the reply for one prompt (an object, a string, or it throws); every prompt
// it saw is kept.
function fakeModel(answer=()=>({profile:'角色：GEO 服务的后端'})){
 const model={calls:[],async ask({system,prompt}){
  const data=JSON.parse(prompt.slice(prompt.indexOf('{')));model.calls.push({system,prompt,data});
  const out=await answer(data,model.calls.length);return typeof out==='string'?out:JSON.stringify(out);
 }};
 return model;
}
const messagesOf=data=>data.chats.flatMap(c=>c.messages);
function setup(t,{answer,options}={}){
 const {store}=tempStore(t),matters=new Matters(store),model=fakeModel(answer);
 const write=(extra={})=>writeProfile({matters,model,options:{...DEFAULTS,...options,...extra},notes:matters.notes(),now:()=>NOW});
 return {store,matters,model,write};
}

test('the profile is written from my messages, each with the message it answered or else the one before it, and my notes',async t=>{
 const {store,matters,model,write}=setup(t,{answer:()=>({profile:'角色：GEO 服务的后端\n通常不归TA：审批，见 https://evil.example/x'})});
 post(store,{text:'早上好',at:min(0)});
 const asked=post(store,{text:'@原智鸿 GEO 接口超时了',at:min(1),categories:['mention','watched']});
 post(store,{text:'这期间别的话',at:min(2)});
 post(store,{mine:true,text:'我看下，是缓存的问题',at:min(3),parentId:asked,threadRole:'reply',rootId:asked});
 post(store,{chat:'d1',name:'张三',sender:'u3',text:'方案什么时候给',at:min(4)});
 post(store,{chat:'d1',mine:true,text:'周五给你',at:min(5)});
 post(store,{chat:'g2',sender:'zebra',name:'Zebra2.0自动化投放平台',type:'bot',text:'投放任务完成',at:min(6)});matters.ignore('zebra','Zebra2.0自动化投放平台');
 post(store,{chat:'g2',mine:true,text:'收到',at:min(7)});
 post(store,{chat:'g2',text:'我自己不在的对话',at:min(8)});
 matters.addNote('审批不归我管',min(9));
 const r=await write();
 assert.deepEqual(r,{text:'角色：GEO 服务的后端\n通常不归TA：审批，见 [链接]',messages:3});
 const [call]=model.calls,d=call.data;
 assert.match(call.system,/「关于TA」/);assert.deepEqual(d.notes,['审批不归我管']);assert.equal(d.me,'原智鸿');
 assert.deepEqual(d.chats.map(c=>[c.chat,c.messages.map(m=>m.text)]),[['大群',['收到']],['张三',['方案什么时候给','周五给你']],['项目群',['@原智鸿 GEO 接口超时了','我看下，是缓存的问题']]],
  'the newest chat first; the message replied to, not the one just before; ignored senders never come along');
 assert.ok(messagesOf(d).filter(m=>m.mine).length===3);
 const [run]=matters.runs();
 assert.deepEqual([run.kind,run.ok,run.messages,run.matters,run.startedAt],['profile',true,3,undefined,NOW]);assert.match(run.output,/GEO 服务的后端/);
});

test('when my messages do not fit one prompt, the newest that fit go',async t=>{
 const {store,model,write}=setup(t,{options:{maxPromptBytes:15500}});
 for(let i=0;i<20;i++)post(store,{chat:`c${i}`,mine:true,text:`${i}号${'长'.repeat(300)}`,at:min(i)});
 const r=await write();
 const [call]=model.calls,texts=messagesOf(call.data).map(m=>m.text);
 assert.ok(Buffer.byteLength(call.prompt)<=15500);
 assert.ok(texts.some(x=>x.startsWith('19号')),'the newest is there');assert.ok(!texts.some(x=>x.startsWith('0号')),'the oldest is not');
 assert.equal(r.messages,texts.length);assert.ok(r.messages>10&&r.messages<20,`as many as fit, not just the newer half: ${r.messages}`);
});

test('with no message of mine the profile comes from my notes alone, and with neither there is no model run',async t=>{
 const {store,matters,model,write}=setup(t);
 post(store,{text:'别人的消息',at:min(0)});
 assert.equal(await write(),undefined);assert.equal(model.calls.length,0);assert.deepEqual(matters.runs(),[]);
 matters.addNote('我负责 GEO 服务',min(1));
 assert.deepEqual(await write(),{text:'角色：GEO 服务的后端',messages:0});
 assert.deepEqual(model.calls[0].data.chats,[]);assert.deepEqual(model.calls[0].data.notes,['我负责 GEO 服务']);
});

test('a reply that cannot be used is recorded as a failed run and rejects',async t=>{
 const {store,matters,write}=setup(t,{answer:()=>'TA是做后端的'});
 post(store,{mine:true,text:'收到',at:min(0)});
 await assert.rejects(write(),/不是 JSON/);
 const [run]=matters.runs();
 assert.deepEqual([run.kind,run.ok,run.output],['profile',false,'TA是做后端的']);assert.match(run.error,/不是 JSON/);
});

test('my notes are kept in order, each under a number of its own, and removed by it',t=>{
 const {matters}=setup(t);
 const a=matters.addNote('审批不归我管',min(0)),b=matters.addNote('Meego 的通知不用管',min(1));
 assert.deepEqual(matters.notes(),[{id:a,text:'审批不归我管',at:min(0)},{id:b,text:'Meego 的通知不用管',at:min(1)}]);
 assert.deepEqual(matters.removeNote(a),{id:a,text:'审批不归我管',at:min(0)});assert.equal(matters.removeNote(a),undefined);
 const c=matters.addNote('第三条',min(2));
 assert.ok(c>b,'a number is never given again');assert.deepEqual(matters.notes().map(n=>n.id),[b,c]);
});
