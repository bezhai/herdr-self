import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post} from './helpers.mjs';
import {OWNER,shown} from './fake-channel.mjs';
import {Matters} from '../matters.mjs';
import {Processor} from '../processor.mjs';
import {ModelQueue} from '../model-queue.mjs';
import {Conversation,readTurn} from '../conversation.mjs';
import {PROFILE} from '../prompt.mjs';

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
// A fake grader: each pass is what result makes of the chats asked for (feed ids, or undefined for every active chat).
function fakeGrader(){
 return {calls:[],result:undefined,async grade(ids){this.calls.push(ids);await new Promise(r=>setTimeout(r,5));return this.result?.(ids)??{runs:1,chats:ids?.length??0,graded:[],left:[]};}};
}
function setup(t){
 const {store}=tempStore(t),matters=new Matters(store),model=fakeModel(),queue=new ModelQueue(model),grader=fakeGrader();
 const bot={replies:[],async reply(msg,input){bot.replies.push({to:msg.messageId,input});return {messageId:`om_r${bot.replies.length}`};}};
 const changes=[],conversation=new Conversation({store,matters,model:queue,bot,grader,now:()=>T,onMattersChanged:()=>changes.push(T)});
 // The people, bots and groups butler knows of, and three matters.
 const seen=[post(store,{mine:true,text:'我发的',at:T-7200e3})];
 for(const [sender,name,type] of [['meego','Meego 项目管理','bot'],['chiwei','赤尾','bot'],['tool','赤尾工具人','bot'],['u1','陈帆','user']])seen.push(post(store,{sender,name,type,text:`${name} 的消息`,at:T-3600e3}));
 matters.apply({processedIds:seen,outcome:'context'});
 // Three groups with messages this week, so that the model is shown them.
 for(const id of ['oc_geo','oc_alarm','oc_topic'])post(store,{chat:id,text:'群里的讨论',at:T-86400e3,categories:['stored']});
 const geo=chat(store,'oc_geo','GEO 小分队'),alarm=chat(store,'oc_alarm','GEO服务告警群'),topic=chat(store,'oc_topic','需求讨论','topic');
 const made=(title,urgency='normal')=>{const id=post(store,{text:title,at:T-1800e3});return matters.apply({created:[{title,who:'陈帆',ask:`处理${title}`,due:null,urgency,messageIds:[id]}],processedIds:[id],now:T-1700e3})[0];};
 const ids=[made('查看 Meego 状态变更通知','low'),made('给黄凯熙加权限','high'),made('评审接口方案')];
 let n=0;
 // The owner says text; answer is what the model makes of it. Returns the acknowledgement and the reply, as text, and
 // the reply's cards.
 const say=async(text,answer)=>{
  if(answer!==undefined)model.script.push(answer);
  const msg={messageId:`om_in${++n}`,chatId:'oc_dm',chatType:'p2p',senderId:OWNER,content:text,createTime:T};
  await conversation.handle(msg);await conversation.idle();
  const replies=bot.replies.filter(r=>r.to===msg.messageId),mine=replies.map(r=>shown(r.input));
  return {ack:mine[0],reply:mine.slice(1).join('\n'),texts:mine.slice(1),cards:replies.slice(1).map(r=>r.input.card),data:model.calls.at(-1)?.data,msg};
 };
 return {store,matters,model,queue,bot,grader,conversation,say,ids,geo,alarm,topic,changes};
}

test('the owner talks freely: the model picks the actions, butler carries them out and says what it did',async t=>{
 const {store,matters,model,say,ids:[meego,perm,review],geo,alarm,topic,changes}=setup(t);
 let r=await say('把 Meego 项目管理加进忽略名单',{actions:[{do:'ignore',sender:'Meego 项目管理'}],reply:''});
 assert.match(r.ack,/收到/);
 const d=r.data;
 assert.equal(d.said,'把 Meego 项目管理加进忽略名单');assert.equal(d.me,'原智鸿');
 assert.ok(d.senders.some(s=>s.name==='Meego 项目管理'&&s.type==='bot'));
 assert.deepEqual(d.openMatters.map(m=>m.matter).sort(),[meego,perm,review].sort());
 assert.ok(d.chats.some(c=>c.name==='GEO 小分队'&&c.kind==='group'&&c.level===null));assert.deepEqual(d.ignored,[]);
 assert.match(model.calls[0].system,/ignore/);assert.doesNotMatch(model.calls[0].system,/\n/,'the system prompt is one command-line argument');
 assert.doesNotMatch(model.calls[0].prompt,/oc_geo|meego\b/,'ids stay with butler');
 assert.deepEqual(matters.ignoredSenders().map(s=>[s.senderId,s.name]),[['meego','Meego 项目管理']]);
 assert.match(r.reply,/已加入忽略名单：Meego 项目管理/);

 r=await say('Meego 那个还是别忽略了',{actions:[{do:'unignore',sender:'Meego'}],reply:'好的。'});
 assert.deepEqual(r.data.ignored.map(s=>s.name),['Meego 项目管理']);
 assert.deepEqual(r.data.history.map(h=>h.said),['把 Meego 项目管理加进忽略名单'],'the model sees the conversation so far');
 assert.match(r.data.history[0].reply,/已加入忽略名单/);
 assert.deepEqual(matters.ignoredSenders(),[]);assert.match(r.reply,/已移出忽略名单：Meego 项目管理/);assert.match(r.reply,/好的。/);

 // A level I set is mine, for a chat of any kind; clearing it brings the model's back. Each reply says what the chat
 // was and what it is.
 r=await say('GEO 小分队要即时看',{actions:[{do:'level',chat:'GEO 小分队',level:'instant'}],reply:''});
 assert.deepEqual(store.levels().map(l=>[l.feedId,l.level,l.by,l.since]),[[geo,'instant','owner',T]]);
 assert.match(r.reply,/已把 GEO 小分队 定为即时：未分级（按只存不看） → 即时（你定的），从 2026-10-23 15:00 起它的全部消息交给模型/,'what it was and what it is');
 r=await say('需求讨论也即时',{actions:[{do:'level',chat:'需求讨论',level:'instant'}],reply:''});
 assert.equal(store.instantSince(topic),T);assert.match(r.reply,/话题群/,'the topic-group caveat, as on the command line');
 assert.deepEqual(model.calls.at(-1).data.chats.filter(c=>c.level).map(c=>[c.name,c.level,c.by]),[['GEO 小分队','instant','TA']],'the model sees the levels and who set them');
 r=await say('还是即时看 GEO 小分队',{actions:[{do:'level',chat:'GEO 小分队',level:'instant'}],reply:''});assert.match(r.reply,/GEO 小分队 已经是你定的即时/);
 store.setLevel(alarm,'store',{by:'model',reason:'告警通知',now:T-3600e3});
 r=await say('告警群改成每日，我要看告警',{actions:[{do:'level',chat:'GEO服务告警群',level:'daily',reason:'我要看告警'}],reply:''});
 assert.match(r.reply,/已把 GEO服务告警群 定为每日：只存不看 → 每日（你定的）/);
 assert.deepEqual([store.level(alarm).reason,store.level(alarm).modelLevel],['我要看告警','store'],'my reason, the model\'s level beside it');
 r=await say('GEO 小分队不用即时了',{actions:[{do:'unlevel',chat:'GEO 小分队'}],reply:''});
 assert.match(r.reply,/已取消你给 GEO 小分队 定的级别：即时（你定的） → 未分级（按只存不看）/);
 r=await say('告警群还是按模型的来',{actions:[{do:'unlevel',chat:'告警群'}],reply:''});
 assert.match(r.reply,/已取消你给 GEO服务告警群 定的级别：每日（你定的） → 只存不看/,'only my levels can be cleared, so a part of the name will do');
 assert.deepEqual(store.levels().map(l=>[l.feedId,l.by]),[[topic,'owner'],[alarm,'model']]);
 // A direct chat: without a level it is instant until the model grades it. Undoing goes by what the reply said.
 store.upsertChatInfo({feedId:'oc_bits',name:'Bits',chatMode:'direct'});
 r=await say('Bits 只存不看',{actions:[{do:'level',chat:'Bits',level:'store'}],reply:''});assert.match(r.reply,/已把 Bits 定为只存不看：未分级（按即时） → 只存不看（你定的）/);
 r=await say('撤销刚才的',{actions:[{do:'unlevel',chat:'Bits'}],reply:''});assert.match(r.reply,/已取消你给 Bits 定的级别：只存不看（你定的） → 未分级（按即时）/);
 assert.match(r.data.history.at(-1).reply,/未分级（按即时） → 只存不看（你定的）/,'the model sees what the chat was, to undo it');
 assert.deepEqual(store.levelChanges(T).filter(c=>c.feedId==='oc_bits').map(c=>[c.before?.level,c.after?.level]),[[undefined,'store'],['store',undefined]],'on record');

 r=await say(`#${meego} 不用管了`,{actions:[{do:'close',matter:meego,reason:'只是通知'}],reply:''});
 assert.equal(matters.matter(meego).status,'closed');assert.equal(matters.matter(meego).closedBy,'owner');assert.match(matters.matter(meego).reason,/只是通知/);
 assert.match(r.reply,new RegExp(`已关闭 #${meego} 查看 Meego 状态变更通知`));
 assert.equal(changes.length,1,'whoever shows the matters is told');
 r=await say(`#${meego} 还是打开吧`,{actions:[{do:'reopen',matter:meego}],reply:''});
 assert.ok(r.data.closedMatters.some(m=>m.matter===meego),'the model sees what it could reopen');
 assert.equal(matters.matter(meego).status,'open');assert.equal(matters.matter(meego).reason,null);assert.match(r.reply,new RegExp(`已重新打开 #${meego}`));
 assert.equal(changes.length,2);

 r=await say('现在有哪些事',{actions:[{do:'list'}],reply:'最急的是给黄凯熙加权限。'});
 assert.match(r.reply,/最急的是给黄凯熙加权限。/);
 assert.equal(r.cards.flatMap(c=>c.body.elements).filter(e=>e.tag==='column_set').length,3,'every open matter in the block a digest shows it in');
 const titles=r.cards.flatMap(c=>c.body.elements).filter(e=>e.tag==='column_set').map(e=>shown({card:e.columns[1]}).split('\n')[0]);
 assert.deepEqual(titles,['给黄凯熙加权限','评审接口方案','查看 Meego 状态变更通知'],'most urgent first');
 assert.ok(r.cards.some(c=>JSON.stringify(c).includes(JSON.stringify(matters.matter(perm).link))),'with butler\'s links');
 assert.match(shown({card:r.cards[0]}),/^最急的是给黄凯熙加权限。$/,'the reply in a card of its own');
 const rows=r.cards.slice(1).flatMap(c=>c.body.elements).filter(e=>e.tag==='column_set');
 assert.deepEqual(rows.map(e=>e.columns[2].elements[0].behaviors[0].value),[perm,review,meego].map(matter=>({act:'done',matter,card:'list',ids:[perm,review,meego],t:T})),
  'then the list, whose buttons say which matters its card shows');

 const before=JSON.stringify([matters.list({all:true}),matters.ignoredSenders(),store.levels()]);
 r=await say('今天最急的是什么？',{actions:[],reply:'最急的是给黄凯熙加权限，今天要处理。'});
 assert.equal(r.reply,'最急的是给黄凯熙加权限，今天要处理。','just an answer');
 assert.equal(JSON.stringify([matters.list({all:true}),matters.ignoredSenders(),store.levels()]),before,'and nothing changed');
 assert.equal(changes.length,2,'listing and answering change no matter');
});

test('a name that fits more than one sender or chat lists the candidates and does nothing',async t=>{
 const {store,matters,grader,say}=setup(t);
 let r=await say('忽略赤尾的机器人',{actions:[{do:'ignore',sender:'赤'}],reply:''});
 assert.deepEqual(matters.ignoredSenders(),[]);
 assert.match(r.reply,/对应多个发送方/);assert.match(r.reply,/赤尾工具人/);assert.match(r.reply,/赤尾（/);
 r=await say('GEO 的群即时看',{actions:[{do:'level',chat:'GEO',level:'instant'}],reply:''});
 assert.deepEqual(store.levels(),[]);assert.match(r.reply,/对应多个聊天/);assert.match(r.reply,/· GEO 小分队（群）/);assert.match(r.reply,/GEO服务告警群/);
 r=await say('重新判断 GEO 的群',{actions:[{do:'grade',chat:'GEO'}],reply:''});
 assert.match(r.reply,/对应多个聊天/);assert.deepEqual(grader.calls,[],'no pass for a guess');
 r=await say('值班群改成忽略',{actions:[{do:'level',chat:'值班群',level:'ignore'}],reply:''});assert.match(r.reply,/没有找到聊天：值班群/);
 r=await say('忽略王五',{actions:[{do:'ignore',sender:'王五'}],reply:''});
 assert.match(r.reply,/没有找到发送方：王五/);
 r=await say('就忽略赤尾',{actions:[{do:'ignore',sender:'赤尾'}],reply:''});
 assert.deepEqual(matters.ignoredSenders().map(s=>s.name),['赤尾'],'an exact name is not ambiguous');
 r=await say('取消忽略那个机器人',{actions:[{do:'unignore',sender:'工具人'}],reply:''});
 assert.match(r.reply,/不在忽略名单上|没有找到/);assert.deepEqual(matters.ignoredSenders().map(s=>s.name),['赤尾']);
});

test('what the model asks for outside the fixed actions is not carried out',async t=>{
 const {store,matters,say,ids:[meego,perm,review],changes}=setup(t);
 const before=JSON.stringify([matters.ignoredSenders(),store.levels()]);
 const r=await say('帮我处理一下',{actions:[{do:'delete',matter:meego},{do:'send',to:'陈帆',text:'好的'},{do:'close'},{do:'ignore'},'close 1',{do:'close',matter:99},
  {do:'close',matter:`#${perm}`},{do:'reopen',matter:review}],reply:'已经处理好了，详情见 https://evil.example/a'});
 assert.equal(matters.matter(meego).status,'open','an unknown action does nothing');
 assert.equal(matters.matter(perm).status,'closed','a matter given as "#n" is fine');
 assert.equal(changes.length,1,'told of the one matter closed, not of the reopen that did nothing');
 assert.equal(JSON.stringify([matters.ignoredSenders(),store.levels()]),before);
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
 const r=readTurn(JSON.stringify({actions:[{do:'level',chat:'  GEO  小分队 ',level:'daily',reason:' 我要看 https://x.example/a '},{do:'level',chat:'告警群',level:'watched'},
  {do:'level',level:'daily'},{do:'unlevel',chat:'告警群'},{do:'grade'},{do:'grade',chat:'告警群'},{do:'levels'},{do:'watch',group:'GEO'},{do:'shell',command:'rm -rf /'},{do:'reopen',matter:'x'},null],reply:42}));
 assert.deepEqual(r.actions,[{do:'level',chat:'GEO 小分队',level:'daily',reason:'我要看 [链接]'},{do:'unlevel',chat:'告警群'},{do:'grade'},{do:'grade',chat:'告警群'},{do:'levels'}],
  'grade without a chat is every chat');
 assert.equal(r.reply,'');
 assert.deepEqual(r.problems.slice(0,3),['level 给出的级别 watched 不认识，没有执行','level 没有给出聊天的名称，没有执行','管家没有「watch」这个动作，没有执行']);assert.equal(r.problems.length,6);
 assert.equal(readTurn(JSON.stringify({actions:Array.from({length:30},()=>({do:'list'}))})).actions.length,20,'a bounded number of actions per turn');
 assert.deepEqual(readTurn('只是一句话 www.example.com'),{actions:[],reply:'只是一句话 [链接]',problems:[]},'prose is an answer');
 assert.deepEqual(readTurn(JSON.stringify({actions:[{do:'note',text:'  审批  不归我管，见 https://x.example/z '},{do:'unnote',note:'#3'},{do:'note'},{do:'unnote',note:'x'}],reply:''})),
  {actions:[{do:'note',text:'审批 不归我管，见 [链接]'},{do:'unnote',note:3}],reply:'',problems:['note 没有给出说明的内容，没有执行','unnote 没有给出说明编号，没有执行']});
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
 // The round ends with 关于TA (this store has none, and my message to write it from) and its review of the open
 // matters (there has been none in this store).
 assert.deepEqual(model.calls.map(c=>c.data.said!==undefined?'turn':c.data.matters?'review':c.data.openMatters?'batch':'profile'),['batch','turn','batch','profile','review'],'the turn goes before the next batch');
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

test('the owner\'s corrections become notes in TA\'s own words, kept and removed by number; the model answers from 关于TA and the notes',async t=>{
 const {store,matters,model,say,ids:[meego]}=setup(t);
 store.setMeta('profile',{text:'角色：GEO 服务的后端\n通常不归TA：审批',at:T-3600e3,notes:[],messages:12});
 let r=await say('审批不归我管',{actions:[{do:'note',text:'审批不归我管'}],reply:''});
 assert.deepEqual([r.data.profile,r.data.notes],[{text:'角色：GEO 服务的后端\n通常不归TA：审批',written:'10-23 14:00'},[]]);
 const system=model.calls[0].system;
 assert.ok(system.includes(PROFILE),'关于TA described as the processor describes it');
 for(const p of [/note 把TA/,/unnote/,/关掉事项时说的理由只写进 close 的 reason，不要另记说明/,/值班群都不看/,/TA关心什么/])assert.match(system,p);
 assert.doesNotMatch(system,/\n/);assert.doesNotMatch(system,/[他她]/);
 const [note]=matters.notes();
 assert.equal(note.text,'审批不归我管');assert.match(r.reply,new RegExp(`已记下说明 #${note.id}：审批不归我管`));assert.match(r.reply,/关于TA/,'saying when it takes effect');
 assert.match(r.reply,/重新给聊天分级/,'chats are graded again by it too');
 r=await say('记一下，审批不归我管',{actions:[{do:'note',text:'审批不归我管'}],reply:''});
 assert.equal(matters.notes().length,1);assert.match(r.reply,/已经记过/);
 r=await say('你觉得我负责什么',{actions:[],reply:'按我的理解，你负责 GEO 服务的后端，审批不归你管。'});
 assert.deepEqual(r.data.notes,[{note:note.id,text:'审批不归我管',time:'10-23 15:00'}]);assert.equal(r.reply,'按我的理解，你负责 GEO 服务的后端，审批不归你管。');
 r=await say(`#${meego} 关掉吧，这种通知不用我管`,{actions:[{do:'close',matter:meego,reason:'这种通知不用我管'}],reply:''});
 assert.equal(matters.matter(meego).status,'closed');assert.equal(matters.notes().length,1,'a reason for closing a matter is no note');
 r=await say('删掉那条说明',{actions:[{do:'unnote',note:`#${note.id}`}],reply:''});
 assert.deepEqual(matters.notes(),[]);assert.match(r.reply,new RegExp(`已删除说明 #${note.id}：审批不归我管`));
 r=await say('删掉说明 9',{actions:[{do:'unnote',note:9}],reply:''});
 assert.match(r.reply,/没有说明 #9/);
 store.setMeta('profile',{failedAt:T,error:'x'});
 r=await say('你觉得我负责什么',{actions:[],reply:'还没有写出来。'});assert.equal(r.data.profile,null,'none written yet');
});

test('the owner asks the model to grade chats again: one pass for the chats named, or every active chat whose level TA did not set; the result follows when it is done',async t=>{
 const {store,grader,say,geo,alarm,topic}=setup(t);
 store.setLevel(alarm,'store',{by:'model',reason:'告警通知',now:T-86400e3});store.setLevel(topic,'instant',{by:'owner',now:T-86400e3});
 grader.result=ids=>({runs:1,chats:ids.length,graded:ids.map(feedId=>({feedId,...store.setLevel(feedId,'daily',{by:'model',reason:'有和TA有关的讨论',now:T})})),left:[]});
 let r=await say('重新判断一下 GEO 小分队和告警群',{actions:[{do:'grade',chat:'GEO 小分队'},{do:'grade',chat:'GEO服务告警群'}],reply:''});
 assert.deepEqual(grader.calls,[[geo,alarm]],'one pass for the chats named');
 assert.equal(r.texts.length,2,'the reply, then the result');
 assert.match(r.texts[0],/已让分级的模型重新判断 GEO 小分队、GEO服务告警群，分完后告诉你结果/);
 assert.match(r.texts[1],/^重新分级完成：分了 2 个聊天里的 2 个/);
 assert.match(r.texts[1],/GEO 小分队：未分级（按只存不看） → 每日：有和TA有关的讨论/);assert.match(r.texts[1],/GEO服务告警群：只存不看 → 每日：有和TA有关的讨论/);
 r=await say('需求讨论也重新判断',{actions:[{do:'grade',chat:'需求讨论'}],reply:''});
 assert.equal(grader.calls.length,1,'a level of mine is not the model\'s to judge');assert.match(r.reply,/需求讨论 的级别是你定的（即时），模型不改你定的级别/);
 grader.result=()=>({runs:3,chats:4,graded:[{feedId:geo,...store.setLevel(geo,'store',{by:'model',reason:'只是闲聊',now:T})},
  {feedId:alarm,...store.setLevel(alarm,'daily',{by:'model',reason:'还是有讨论',now:T})}],left:['oc_x','oc_y'],error:'模型的回复不是 JSON'});
 store.upsertChatInfo({feedId:'oc_x',name:'X 群',chatMode:'group'});
 r=await say('全部重新判断一遍',{actions:[{do:'grade'}],reply:''});
 assert.equal(grader.calls.length,2);assert.equal(grader.calls[1],undefined,'every active chat whose level TA did not set: the grader\'s call');
 assert.match(r.texts[0],/最近 7 天有消息、级别不是你定的全部聊天/);
 assert.match(r.texts[1],/GEO 小分队：每日 → 只存不看：只是闲聊/);assert.doesNotMatch(r.texts[1],/GEO服务告警群/,'every chat: only those whose level changed');
 assert.match(r.texts[1],/其余 1 个级别没变/);assert.match(r.texts[1],/没有分成：X 群、oc_y（模型的回复不是 JSON）/);
 grader.result=()=>{throw Error('herdr 连不上 cpu1');};
 r=await say('告警群再判断一次',{actions:[{do:'grade',chat:'告警群'}],reply:''});
 assert.match(r.texts[1],/重新分级没有完成：herdr 连不上 cpu1/);assert.ok(store.errors().some(e=>e.source==='对话'&&/herdr 连不上/.test(e.message)));
});

test('the owner asks for the levels: butler sends the level list, a panel per level with the reasons',async t=>{
 const {store,say,geo,topic}=setup(t);
 store.setLevel(geo,'daily',{by:'model',reason:'项目讨论，和TA的工作有关',now:T-3600e3});store.setLevel(topic,'instant',{by:'owner',now:T-3600e3});
 const r=await say('列一下分级',{actions:[{do:'levels'}],reply:''});
 assert.equal(r.cards.length,1);
 const text=shown({card:r.cards[0]});
 assert.match(text,/聊天的分级/);assert.match(text,/即时 1 个/);assert.match(text,/需求讨论（你定的）/);assert.match(text,/GEO 小分队 — 项目讨论，和TA的工作有关/);
 assert.match(text,/还没有分级 2 个/,'the active chats with no level yet');
});

test('the model sees the active chats and those whose level TA set, each with its level, who set it and the reason; reasons are cut short when the prompt would be too long',async t=>{
 const {store,model,say,geo,alarm}=setup(t);
 store.setLevel(geo,'daily',{by:'model',reason:'项目讨论，和TA的工作有关',now:T-3600e3});
 store.setLevel(alarm,'store',{by:'model',reason:'告警通知',now:T-3600e3});store.setLevel(alarm,'daily',{by:'owner',reason:'我要看告警',now:T-1800e3});
 store.upsertChatInfo({feedId:'oc_old',name:'很久没说话的群',chatMode:'group'});store.setLevel('oc_old','ignore',{by:'owner',now:T-30*86400e3});
 store.upsertChatInfo({feedId:'oc_quiet',name:'不活跃的群',chatMode:'group'});store.setLevel('oc_quiet','store',{by:'model',reason:'没人说话',now:T-30*86400e3});
 let r=await say('GEO 小分队为什么是每日',{actions:[],reply:'因为里面是项目讨论。'});
 const chats=r.data.chats,named=name=>chats.find(c=>c.name===name);
 assert.deepEqual(named('GEO 小分队'),{name:'GEO 小分队',kind:'group',level:'daily',by:'model',reason:'项目讨论，和TA的工作有关'});
 assert.deepEqual(named('GEO服务告警群'),{name:'GEO服务告警群',kind:'group',level:'daily',by:'TA',reason:'我要看告警',modelLevel:'store',modelReason:'告警通知'},'beside mine, the model\'s');
 assert.deepEqual(named('很久没说话的群'),{name:'很久没说话的群',kind:'group',level:'ignore',by:'TA'},'mine, whether or not the chat is active');
 assert.equal(named('不活跃的群'),undefined,'an inactive chat the model graded is left out');
 assert.deepEqual(named('需求讨论'),{name:'需求讨论',kind:'topic',level:null});
 assert.doesNotMatch(model.calls.at(-1).prompt,/oc_geo|oc_old/,'ids stay with butler');
 // Hundreds of active chats with long reasons: they are all shown, their reasons cut to what fits.
 for(let i=0;i<400;i++){post(store,{chat:`oc_${i}`,text:'消息',at:T-3600e3,categories:['stored']});chat(store,`oc_${i}`,`活跃的群${i}`);
  store.setLevel(`oc_${i}`,'store',{by:'model',reason:`理由${i}`.padEnd(200,'长'),now:T-3600e3});}
 r=await say('有哪些群是只存不看',{actions:[],reply:'很多。'});
 assert.ok(Buffer.byteLength(model.calls.at(-1).prompt)<=80_000,`${Buffer.byteLength(model.calls.at(-1).prompt)} bytes`);
 const shownChats=r.data.chats.filter(c=>c.name.startsWith('活跃的群'));
 assert.equal(shownChats.length,400);
 for(const c of shownChats)assert.match(c.reason,/^理由\d+长*…$/,'cut, with a mark');
 assert.equal(r.data.chats.find(c=>c.name==='GEO服务告警群').reason,'我要看告警','a short reason stays whole');
});
