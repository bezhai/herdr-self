import test from 'node:test';
import assert from 'node:assert/strict';
import {composePrompt,readReply} from '../prompt.mjs';

process.env.TZ='Asia/Shanghai';// the prompt shows local times

const at=s=>Date.parse(`2026-10-23T${s}:00+08:00`);
const rec=o=>({id:'x',chatId:'g1',chatName:'项目群',chatKind:'group',senderId:'u1',senderName:'陈帆',senderType:'user',createdAt:at('10:00'),
 threadRole:'none',rootId:null,parentId:null,text:'hi',isMine:false,categories:['watched'],mentionsAll:false,isRecalled:false,isEdited:false,unreadable:false,...o});
const data=prompt=>JSON.parse(prompt.slice(prompt.indexOf('{')));

test('the prompt hands the model plain facts and refs of its own, never butler ids',()=>{
 const root=rec({id:'7001',text:'方案评审放这个话题',threadRole:'root',rootId:'7001',createdAt:at('09:00')});
 const reply=rec({id:'7002',text:'@原智鸿 帮忙看下这个方案',threadRole:'reply',rootId:'7001',parentId:'7001',categories:['mention','watched'],mentionsAll:true});
 const mine=rec({id:'7003',senderName:'原智鸿',isMine:true,text:'好的',createdAt:at('10:05'),categories:['watched']});
 const dm=rec({id:'7004',chatId:'d1',chatName:'Argos平台报警',chatKind:'direct',senderName:'Argos平台报警',senderType:'bot',text:'告警：CPU 高',categories:['dm'],createdAt:at('09:30')});
 const matter={id:12,title:'评审方案',who:'陈帆',ask:'看方案',due:null,urgency:'normal',since:at('09:00'),openedAt:at('09:10'),chats:['项目群'],messageIds:['7001']};
 const {system,prompt,refs}=composePrompt({now:at('10:10'),me:'原智鸿',batch:[reply,mine,dm],context:[root],openMatters:[matter]});
 assert.match(system,/原智鸿/);assert.doesNotMatch(system,/\n/,'the system prompt goes on a command line, so it is one line');
 const d=data(prompt);
 assert.equal(d.me,'原智鸿');assert.equal(d.now,'2026-10-23 10:10');
 assert.deepEqual(d.chats.map(c=>[c.chat,c.kind]),[['项目群','group'],['Argos平台报警','direct']],'chats in the order of their first new message');
 const [m1,m2,m3]=d.chats[0].messages;
 assert.deepEqual(m1,{ref:'m1',time:'10-23 09:00',sender:'陈帆',senderType:'user',categories:['watched'],thread:'root',text:'方案评审放这个话题'});
 assert.deepEqual(m2,{ref:'m2',new:true,time:'10-23 10:00',sender:'陈帆',senderType:'user',categories:['mention','watched'],mentionsAll:true,thread:'reply',root:'m1',text:'@原智鸿 帮忙看下这个方案'});
 assert.equal(m3.mine,true);assert.equal(m3.new,true);
 assert.equal(d.chats[1].messages[0].senderType,'bot');
 assert.deepEqual(d.openMatters,[{matter:12,title:'评审方案',who:'陈帆',ask:'看方案',due:null,urgency:'normal',since:'10-23 09:00',chats:['项目群'],messages:['m1']}]);
 assert.deepEqual([...refs.entries()].map(([r,v])=>[r,v.id,v.isNew,v.isMine]),[['m1','7001',false,false],['m2','7002',true,false],['m3','7003',true,true],['m4','7004',true,false]]);
 assert.doesNotMatch(prompt,/700[1-4]/,'butler ids stay out of the prompt');
 assert.doesNotMatch(prompt,/http/,'no links either');
});

test('long texts are cut and the states of a message are told',()=>{
 const long=rec({id:'1',text:'长'.repeat(5000),isRecalled:true,isEdited:true,unreadable:true});
 const {prompt}=composePrompt({now:at('11:00'),me:'我',batch:[long],context:[],openMatters:[],textChars:100});
 const m=data(prompt).chats[0].messages[0];
 assert.ok(m.text.length<120);assert.match(m.text,/截断/);assert.equal(m.recalled,true);assert.equal(m.edited,true);assert.equal(m.unreadable,true);
});

const refs=new Map([['m1',{id:'a',isNew:false,isMine:false}],['m2',{id:'b',isNew:true,isMine:false}],['m3',{id:'c',isNew:true,isMine:true}]]);
const read=(o,matterIds=[5])=>readReply(typeof o==='string'?o:JSON.stringify(o),{refs,matterIds:new Set(matterIds)});

test('a reply is read into new matters and updates in butler terms',()=>{
 const r=read({new:[{title:'看方案',who:'陈帆',ask:'评审方案',due:'2026-10-24 18:00',urgency:'high',messages:['m1','m2']}],
  updates:[{matter:5,messages:['m3'],status:'closed',reason:'我已回复处理完了',urgency:'low'}]});
 assert.deepEqual(r.created,[{title:'看方案',who:'陈帆',ask:'评审方案',due:'2026-10-24 18:00',urgency:'high',messageIds:['a','b']}]);
 assert.deepEqual(r.updated,[{matterId:5,messageIds:['c'],changes:{urgency:'low'},close:'我已回复处理完了'}]);
 assert.deepEqual(r.problems,[]);
 assert.deepEqual(read({new:[],updates:[]}),{created:[],updated:[],problems:[]});
});

test('a fenced or wrapped JSON reply is still read; anything else is an error',()=>{
 const fenced='好的，结果如下：\n```json\n{"new":[],"updates":[{"matter":5,"messages":["m2"],"status":"open"}]}\n```';
 assert.deepEqual(read(fenced).updated,[{matterId:5,messageIds:['b'],changes:{},close:undefined}]);
 assert.throws(()=>read('我无法完成'),/不是 JSON/);
 assert.throws(()=>read('{"new": [}'),/不是 JSON/);
 assert.throws(()=>read('{"items":[]}'),/new.*updates/);
 assert.throws(()=>read('[]'),/new.*updates/);
});

test('the model may only point at what butler gave it; links and ids never come from it',()=>{
 const r=read({new:[
  {title:'编造的',who:'x',ask:'y',urgency:'normal',messages:['m9']},
  {title:'只有我的消息',who:'x',ask:'y',urgency:'normal',messages:['m3']},
  {title:'只有旧消息',who:'x',ask:'y',urgency:'normal',messages:['m1']},
  {title:'打开 https://evil.example/x 看看',who:'陈帆',ask:'点 http://a.b/c?d=1 填表',due:null,urgency:'urgent!!',messages:['m2','m7'],link:'https://evil.example',id:99}],
  updates:[{matter:6,messages:['m2'],status:'closed',reason:'r'},{matter:5,status:'closed'},{matter:5,messages:['m8'],title:''}]});
 assert.equal(r.created.length,1);
 const [m]=r.created;
 assert.deepEqual(m.messageIds,['b'],'unknown refs are dropped');
 assert.doesNotMatch(m.title+m.ask,/http|evil/,'URLs in model text are replaced');
 assert.equal(m.urgency,'normal','an unknown urgency falls back to normal');
 assert.ok(!('link' in m)&&!('id' in m));
 assert.deepEqual(r.updated,[],'a close without reason does not close, an empty title does not replace one, and what is left changes nothing');
 for(const p of [/m9/,/只有我的消息/,/只有旧消息/,/m7/,/#6/,/理由/,/m8/,/urgent/])assert.ok(r.problems.some(x=>p.test(x)),`problem reported: ${p}`);
});

test('model text is trimmed to sane lengths',()=>{
 const r=read({new:[{title:'题'.repeat(500),who:'人'.repeat(500),ask:'事'.repeat(5000),due:'期'.repeat(500),urgency:'low',messages:['m2']}],updates:[]});
 const [m]=r.created;
 assert.ok(m.title.length<=80&&m.who.length<=60&&m.ask.length<=400&&m.due.length<=40);
});
