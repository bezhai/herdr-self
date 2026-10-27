import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post} from './helpers.mjs';
import {OWNER,shown} from './fake-channel.mjs';
import {Matters} from '../matters.mjs';
import {Processor} from '../processor.mjs';
import {ModelQueue} from '../model-queue.mjs';
import {Conversation,readTurn} from '../conversation.mjs';

process.env.TZ='Asia/Shanghai';
const T=Date.parse('2026-10-23T15:00:00+08:00');

// A fake model: each ask takes the next scripted answer (an object, a string, or a function of the prompt's data
// that may throw); every prompt it saw is kept. gate: a promise an ask waits for before answering.
function fakeModel(){
 const model={calls:[],script:[],busy:0,overlapped:false,gate:undefined,
  async ask({system,prompt}){
   if(model.busy++)model.overlapped=true;
   try{
    const data=JSON.parse(prompt.slice(prompt.indexOf('{'))),call={system,prompt,data};model.calls.push(call);
    if(model.gate)await model.gate;await new Promise(r=>setTimeout(r,2));
    const next=model.script.shift()??{new:[],updates:[]},out=typeof next==='function'?await next(data):next;
    return typeof out==='string'?out:JSON.stringify(out);
   }finally{model.busy-=1;}
  }};
 return model;
}
const chat=(store,feedId,name,chatMode='group')=>{store.upsertChatInfo({feedId,name,chatMode});return feedId;};
function setup(t){
 const {store}=tempStore(t),matters=new Matters(store),model=fakeModel(),queue=new ModelQueue(model);
 const bot={replies:[],async reply(msg,input){bot.replies.push({to:msg.messageId,input});return {messageId:`om_r${bot.replies.length}`};}};
 const conversation=new Conversation({store,matters,model:queue,bot,now:()=>T});
 // The people, bots and groups butler knows of, and three matters.
 const seen=[post(store,{mine:true,text:'我发的',at:T-7200e3})];
 for(const [sender,name,type] of [['meego','Meego 项目管理','bot'],['chiwei','赤尾','bot'],['tool','赤尾工具人','bot'],['u1','陈帆','user']])seen.push(post(store,{sender,name,type,text:`${name} 的消息`,at:T-3600e3}));
 matters.apply({processedIds:seen,outcome:'context'});
 const geo=chat(store,'oc_geo','GEO 小分队'),alarm=chat(store,'oc_alarm','GEO服务告警群'),topic=chat(store,'oc_topic','需求讨论','topic');
 const made=(title,urgency='normal')=>{const id=post(store,{text:title,at:T-1800e3});return matters.apply({created:[{title,who:'陈帆',ask:`处理${title}`,due:null,urgency,messageIds:[id]}],processedIds:[id],now:T-1700e3})[0];};
 const ids=[made('查看 Meego 状态变更通知','low'),made('给黄凯熙加权限','high'),made('评审接口方案')];
 let n=0;
 // The owner says text; answer is what the model makes of it. Returns the acknowledgement and the reply, as text.
 const say=async(text,answer)=>{
  if(answer!==undefined)model.script.push(answer);
  const msg={messageId:`om_in${++n}`,chatId:'oc_dm',chatType:'p2p',senderId:OWNER,content:text,createTime:T};
  await conversation.handle(msg);await conversation.idle();
  const mine=bot.replies.filter(r=>r.to===msg.messageId).map(r=>shown(r.input));
  return {ack:mine[0],reply:mine.slice(1).join('\n'),data:model.calls.at(-1)?.data,msg};
 };
 return {store,matters,model,queue,bot,conversation,say,ids,geo,alarm,topic};
}

test('the owner talks freely: the model picks the actions, butler carries them out and says what it did',async t=>{
 const {store,matters,model,say,ids:[meego,perm,review],geo,topic}=setup(t);
 let r=await say('把 Meego 项目管理加进忽略名单',{actions:[{do:'ignore',sender:'Meego 项目管理'}],reply:''});
 assert.match(r.ack,/收到/);
 const d=r.data;
 assert.equal(d.said,'把 Meego 项目管理加进忽略名单');assert.equal(d.me,'原智鸿');
 assert.ok(d.senders.some(s=>s.name==='Meego 项目管理'&&s.type==='bot'));
 assert.deepEqual(d.openMatters.map(m=>m.matter).sort(),[meego,perm,review].sort());
 assert.ok(d.groups.includes('GEO 小分队'));assert.deepEqual(d.watched,[]);assert.deepEqual(d.ignored,[]);
 assert.match(model.calls[0].system,/ignore/);assert.doesNotMatch(model.calls[0].system,/\n/,'the system prompt is one command-line argument');
 assert.doesNotMatch(model.calls[0].prompt,/oc_geo|meego\b/,'ids stay with butler');
 assert.deepEqual(matters.ignoredSenders().map(s=>[s.senderId,s.name]),[['meego','Meego 项目管理']]);
 assert.match(r.reply,/已加入忽略名单：Meego 项目管理/);

 r=await say('Meego 那个还是别忽略了',{actions:[{do:'unignore',sender:'Meego'}],reply:'好的。'});
 assert.deepEqual(r.data.ignored.map(s=>s.name),['Meego 项目管理']);
 assert.deepEqual(r.data.history.map(h=>h.said),['把 Meego 项目管理加进忽略名单'],'the model sees the conversation so far');
 assert.match(r.data.history[0].reply,/已加入忽略名单/);
 assert.deepEqual(matters.ignoredSenders(),[]);assert.match(r.reply,/已移出忽略名单：Meego 项目管理/);assert.match(r.reply,/好的。/);

 r=await say('关注一下 GEO 小分队',{actions:[{do:'watch',group:'GEO 小分队'}],reply:''});
 assert.deepEqual(store.watches().map(w=>w.feedId),[geo]);assert.match(r.reply,/已加入关注：GEO 小分队/);
 r=await say('需求讨论也关注',{actions:[{do:'watch',group:'需求讨论'}],reply:''});
 assert.ok(store.watchSince(topic));assert.match(r.reply,/话题群/,'the topic-group caveat, as on the command line');
 r=await say('GEO 小分队别关注了',{actions:[{do:'unwatch',group:'GEO 小分队'}],reply:''});
 assert.deepEqual(store.watches().map(w=>w.feedId),[topic]);assert.match(r.reply,/已移出关注：GEO 小分队/);

 r=await say(`#${meego} 不用管了`,{actions:[{do:'close',matter:meego,reason:'只是通知'}],reply:''});
 assert.equal(matters.matter(meego).status,'closed');assert.equal(matters.matter(meego).closedBy,'owner');assert.match(matters.matter(meego).reason,/只是通知/);
 assert.match(r.reply,new RegExp(`已关闭 #${meego} 查看 Meego 状态变更通知`));
 r=await say(`#${meego} 还是打开吧`,{actions:[{do:'reopen',matter:meego}],reply:''});
 assert.ok(r.data.closedMatters.some(m=>m.matter===meego),'the model sees what it could reopen');
 assert.equal(matters.matter(meego).status,'open');assert.equal(matters.matter(meego).reason,null);assert.match(r.reply,new RegExp(`已重新打开 #${meego}`));

 r=await say('现在有哪些事',{actions:[{do:'list'}],reply:'最急的是给黄凯熙加权限。'});
 assert.match(r.reply,/最急的是给黄凯熙加权限。/);
 for(const id of [meego,perm,review])assert.match(r.reply,new RegExp(`#${id} \\[`));
 assert.ok(r.reply.indexOf(`#${perm} [紧急]`)<r.reply.indexOf(`#${meego} [不急]`),'most urgent first');
 assert.ok(r.reply.includes(matters.matter(perm).link),'with butler\'s links');

 const before=JSON.stringify([matters.list({all:true}),matters.ignoredSenders(),store.watches()]);
 r=await say('今天最急的是什么？',{actions:[],reply:'最急的是给黄凯熙加权限，今天要处理。'});
 assert.equal(r.reply,'最急的是给黄凯熙加权限，今天要处理。','just an answer');
 assert.equal(JSON.stringify([matters.list({all:true}),matters.ignoredSenders(),store.watches()]),before,'and nothing changed');
});

test('a name that fits more than one sender or group lists the candidates and does nothing',async t=>{
 const {store,matters,say}=setup(t);
 let r=await say('忽略赤尾的机器人',{actions:[{do:'ignore',sender:'赤'}],reply:''});
 assert.deepEqual(matters.ignoredSenders(),[]);
 assert.match(r.reply,/对应多个发送方/);assert.match(r.reply,/赤尾工具人/);assert.match(r.reply,/赤尾（/);
 r=await say('关注 GEO 的群',{actions:[{do:'watch',group:'GEO'}],reply:''});
 assert.deepEqual(store.watches(),[]);assert.match(r.reply,/对应多个群/);assert.match(r.reply,/GEO 小分队/);assert.match(r.reply,/GEO服务告警群/);
 r=await say('忽略王五',{actions:[{do:'ignore',sender:'王五'}],reply:''});
 assert.match(r.reply,/没有找到发送方：王五/);
 r=await say('就忽略赤尾',{actions:[{do:'ignore',sender:'赤尾'}],reply:''});
 assert.deepEqual(matters.ignoredSenders().map(s=>s.name),['赤尾'],'an exact name is not ambiguous');
 r=await say('取消忽略那个机器人',{actions:[{do:'unignore',sender:'工具人'}],reply:''});
 assert.match(r.reply,/不在忽略名单上|没有找到/);assert.deepEqual(matters.ignoredSenders().map(s=>s.name),['赤尾']);
});

test('what the model asks for outside the fixed actions is not carried out',async t=>{
 const {store,matters,say,ids:[meego,perm,review]}=setup(t);
 const before=JSON.stringify([matters.ignoredSenders(),store.watches()]);
 const r=await say('帮我处理一下',{actions:[{do:'delete',matter:meego},{do:'send',to:'陈帆',text:'好的'},{do:'close'},{do:'ignore'},'close 1',{do:'close',matter:99},
  {do:'close',matter:`#${perm}`},{do:'reopen',matter:review}],reply:'已经处理好了，详情见 https://evil.example/a'});
 assert.equal(matters.matter(meego).status,'open','an unknown action does nothing');
 assert.equal(matters.matter(perm).status,'closed','a matter given as "#n" is fine');
 assert.equal(JSON.stringify([matters.ignoredSenders(),store.watches()]),before);
 assert.match(r.reply,/delete/);assert.match(r.reply,/send/);assert.match(r.reply,/没有执行/);
 assert.match(r.reply,/没有 #99/);assert.match(r.reply,new RegExp(`#${review} 没有结束`));
 assert.doesNotMatch(r.reply,/evil\.example/,'a link the model wrote is not passed on');
 assert.ok(store.errors().some(e=>e.source==='对话'&&/delete/.test(e.message)));
 const prose=await say('随便聊聊',"好的，我在。");
 assert.equal(prose.reply,'好的，我在。','an answer that is not JSON is shown as text, and nothing is done');
 assert.equal(matters.matter(meego).status,'open');
});

test('reading the model\'s turn',()=>{
 assert.deepEqual(readTurn('```json\n{"actions":[{"do":"close","matter":"#7","reason":"不用了"},{"do":"list"}],"reply":"好"}\n```'),
  {actions:[{do:'close',matter:7,reason:'不用了'},{do:'list'}],reply:'好',problems:[]});
 const r=readTurn(JSON.stringify({actions:[{do:'watch',group:'  GEO  小分队 '},{do:'shell',command:'rm -rf /'},{do:'reopen',matter:'x'},null],reply:42}));
 assert.deepEqual(r.actions,[{do:'watch',group:'GEO 小分队'}]);assert.equal(r.reply,'');assert.equal(r.problems.length,3);
 assert.equal(readTurn(JSON.stringify({actions:Array.from({length:30},()=>({do:'list'}))})).actions.length,20,'a bounded number of actions per turn');
 assert.deepEqual(readTurn('只是一句话 www.example.com'),{actions:[],reply:'只是一句话 [链接]',problems:[]},'prose is an answer');
});

test('receipt is acknowledged at once, and a turn waits only for the model run under way, ahead of the next batch',async t=>{
 const {store,matters,model,queue,bot,conversation}=setup(t);
 const processor=new Processor({store,matters,model:queue,options:{maxMessages:1}});
 for(let i=0;i<2;i++)post(store,{text:`批次消息${i}`,at:T+i});
 let open;model.gate=new Promise(r=>{open=r;});
 const round=processor.runOnce();
 await new Promise(r=>setTimeout(r,20));assert.equal(model.calls.length,1,'the first batch is with the model');
 model.script.push({new:[],updates:[]},{actions:[],reply:'在的。'});
 const msg={messageId:'om_wait',chatId:'oc_dm',chatType:'p2p',senderId:OWNER,content:'在吗',createTime:T};
 await conversation.handle(msg);
 assert.equal(bot.replies.length,1,'acknowledged while the model is busy');
 assert.match(shown(bot.replies[0].input),/整理/,'saying what it waits for');
 model.gate=undefined;open();
 await round;await conversation.idle();
 // The round ends with its review of the open matters (there has been none in this store).
 assert.deepEqual(model.calls.map(c=>c.data.said!==undefined?'turn':c.data.matters?'review':'batch'),['batch','turn','batch','review'],'the turn goes before the next batch');
 assert.equal(model.overlapped,false,'one model run at a time');
 assert.match(shown(bot.replies.at(-1).input),/在的。/);
});

test('a failed model run is reported, and a message Feishu delivers twice is handled once',async t=>{
 const {model,bot,conversation,say}=setup(t);
 const r=await say('关掉 #1',()=>{throw Error('herdr --machine cpu1-butler：ssh: connect to host port 22: Connection refused');});
 assert.match(r.reply,/没有处理成/);assert.match(r.reply,/Connection refused/);
 const calls=model.calls.length,replies=bot.replies.length;
 await conversation.handle(r.msg);await conversation.idle();
 assert.equal(model.calls.length,calls);assert.equal(bot.replies.length,replies);
 const empty=await say('',undefined);
 assert.match(empty.ack,/文字/,'nothing to read: no model run');assert.equal(model.calls.length,calls);
});
