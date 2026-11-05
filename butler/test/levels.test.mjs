import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post,waitFor} from './helpers.mjs';
import {fakeChannel,shown,componentsOf,OWNER} from './fake-channel.mjs';
import {MAX_COMPONENTS,CARD_BYTES} from '../cards.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {Matters} from '../matters.mjs';
import {Digests} from '../digest.mjs';
import {Bot} from '../bot.mjs';
import {Grader} from '../grader.mjs';
import {Processor} from '../processor.mjs';
import {levelListCards,weekCards,LevelCards} from '../levels.mjs';

process.env.TZ='Asia/Shanghai';
// 2026-10-19 and 10-26 are Mondays: the week of the weekly card is from 10-19 10:00 up to 10-26 10:00.
const at=(day,hm)=>Date.parse(`2026-10-${day}T${hm}:00+08:00`),FROM=at(19,'10:00'),TO=at(26,'10:00');
const size=card=>Buffer.byteLength(JSON.stringify(JSON.stringify(card)));
const count=card=>[...componentsOf(card)].length;
const textOf=x=>[...componentsOf(x)].filter(c=>c.tag==='plain_text').map(c=>c.content).join('\n');
const panelsOf=card=>card.body.elements.filter(e=>e.tag==='collapsible_panel');
const chat=(store,feedId,name,chatMode='group')=>{store.upsertChatInfo({feedId,name,chatMode});return feedId;};
// What a card shows only butler's own markdown and links: none from the model or the chats.
function plainOnly(cards){
 for(const c of componentsOf(cards)){
  assert.notEqual(c.tag,'lark_md');
  if(c.tag==='markdown')assert.match(c.content,/^\*\*[^*[\]<]+\*\*$/,`butler's own markdown only: ${c.content}`);
 }
 assert.doesNotMatch(JSON.stringify(cards),/"(?:default_url|url)"/,'no links');
}

test('the level list: a collapsed panel per level, instant first, each chat a line with its name and reason, mine marked; the active chats not graded yet last',t=>{
 const {store}=tempStore(t);
 chat(store,'oc_geo','GEO 小分队');store.setLevel('oc_geo','instant',{by:'owner',reason:'我在跟这个项目',now:at(20,'09:00')});
 chat(store,'oc_bits','Bits','direct');store.setLevel('oc_bits','instant',{by:'owner',now:at(20,'09:00')});
 chat(store,'oc_dev','开发进展群');store.setLevel('oc_dev','daily',{by:'model',reason:'项目讨论，和TA的工作有关',now:at(21,'09:00')});
 chat(store,'oc_ai','AI 工具交流群');store.setLevel('oc_ai','store',{by:'model',reason:'**闲聊** [点这里](https://evil.example/x) <at id=all></at>',now:at(21,'09:00')});
 store.setLevel('oc_push','ignore',{by:'model',reason:'刷屏的通知',now:at(21,'09:00')});// seen only through push: no name yet
 post(store,{chat:'oc_new',text:'新群的第一条消息',at:at(26,'09:00'),categories:['stored']});
 const cards=levelListCards(store,{at:at(26,'10:00')});
 assert.equal(cards.length,1);const [card]=cards;
 assert.equal(card.schema,'2.0');assert.equal(card.header.title.content,'聊天的分级');
 assert.equal(card.config.summary.content,'即时 2 · 每日 1 · 只存不看 1 · 忽略 1 · 还没有分级 1');
 const panels=panelsOf(card);
 assert.deepEqual(panels.map(p=>[p.header.title.content,p.expanded]),[['即时 2 个',false],['每日 1 个',false],['只存不看 1 个',false],['忽略 1 个',false],['还没有分级 1 个',false]]);
 assert.deepEqual(panels.map(p=>textOf(p.elements)),['GEO 小分队（你定的） — 我在跟这个项目\nBits（你定的）','开发进展群 — 项目讨论，和TA的工作有关',
  'AI 工具交流群 — **闲聊** [点这里](https://evil.example/x) <at id=all></at>','（名称未知的聊天） — 刷屏的通知','oc_new（按只存不看）']);
 assert.match(shown({card}),/在私聊里说「把 xx 改成每日」/,'how to change one');
 plainOnly(cards);
});

test('a long level list goes on over several cards, each within Feishu\'s limits, every chat once',t=>{
 const {store}=tempStore(t);
 for(let i=0;i<300;i++){const id=chat(store,`oc_${i}`,`很长的群名${i}`.repeat(3));store.setLevel(id,i%10?'store':'daily',{by:'model',reason:`理由${i}`.padEnd(i%10?200:10,'长'),now:at(21,'09:00')});}
 const cards=levelListCards(store,{at:at(26,'10:00')});
 assert.ok(cards.length>1);
 for(const c of cards){assert.ok(size(c)<=CARD_BYTES,`${size(c)} bytes`);assert.ok(count(c)<=MAX_COMPONENTS,`${count(c)} components`);}
 const lines=cards.flatMap(c=>panelsOf(c).flatMap(p=>textOf(p.elements).split('\n')));
 assert.equal(lines.length,300);assert.equal(new Set(lines).size,300);
 const titles=cards.flatMap(c=>panelsOf(c).map(p=>p.header.title.content));
 assert.equal(titles[0],'每日 30 个');assert.match(titles[1],/^只存不看 270 个（1\/\d+）$/,'a level too long for one card goes on in numbered parts');
 assert.match(cards[1].header.title.content,/^聊天的分级（2\/\d+）$/);
});

// The week of 10-19: what the model changed, what it graded for the first time, and what I did.
function week(store){
 const a=chat(store,'oc_a','开发进展群'),b=chat(store,'oc_b','新来的群'),c=chat(store,'oc_c','来回变的群'),d=chat(store,'oc_d','被我改了的群'),e=chat(store,'oc_e','我早就定了的群');
 const f=chat(store,'oc_f','首次分级就在列表里的群','direct');
 store.setLevel(a,'daily',{by:'model',reason:'项目讨论',now:at(12,'09:00')});store.setLevel(a,'instant',{by:'model',reason:'常有要TA回复的问题',now:at(20,'09:00')});
 store.setLevel(b,'store',{by:'model',reason:'和TA的工作无关的闲聊',now:at(22,'09:00')});
 store.setLevel(c,'store',{by:'model',reason:'闲聊',now:at(12,'09:00')});store.setLevel(c,'daily',{by:'model',reason:'有讨论',now:at(20,'09:00')});store.setLevel(c,'store',{by:'model',reason:'又是闲聊',now:at(23,'09:00')});
 store.setLevel(d,'store',{by:'model',reason:'通知',now:at(12,'09:00')});store.setLevel(d,'ignore',{by:'model',reason:'只有通知',now:at(21,'09:00')});
 store.setLevel(d,'daily',{by:'owner',now:at(21,'12:00')});
 store.setLevel(e,'instant',{by:'owner',now:at(12,'09:00')});store.setLevel(e,'instant',{by:'owner',reason:'确认一下',now:at(22,'09:00')});
 store.setLevel(f,'store',{by:'model',reason:'机器人通知',now:at(19,'11:00')});
 store.setLevel(b,'store',{by:'owner',now:at(24,'09:00')});// confirms the model's: no correction
 return {a,b,c,d,e,f};
}
// A row of the weekly card, read back: the chat's name, the grey line, and the ⋯ with its options and what it sends back.
function readRow(r){
 assert.equal(r.tag,'column_set');
 const [main,side]=r.columns,[name,facts]=main.elements.map(e=>e.text),[more]=side.elements;
 assert.equal(more.tag,'overflow');
 return {name:name.content,facts:facts.content,grey:[facts.text_size,facts.text_color],options:more.options.map(o=>[o.text.content,o.value]),value:more.behaviors.find(b=>b.type==='callback').value};
}
const rowsOf=card=>card.body.elements.filter(e=>e.tag==='column_set').map(readRow);

test('the weekly card: what the model changed and graded for the first time, each with a ⋯ to set my level; my corrections and the latest exam',t=>{
 const {store}=tempStore(t),{a,b,d,f}=week(store);
 const exams=[{at:at(27,'09:00'),total:12,correct:12,wrong:[]},{at:at(25,'09:00'),total:10,correct:8,wrong:[]}];
 const cards=weekCards(store,{from:FROM,to:TO,at:TO,listed:at(19,'12:00'),exams:()=>exams});
 assert.equal(cards.length,1);const [card]=cards;
 assert.equal(card.config.update_multi,true,'it is made again in place when I choose a level');
 assert.equal(card.header.title.content,'分级变化（10-19 至 10-26）');assert.equal(card.config.summary.content,'模型改了 2 个聊天的级别，第一次分了 1 个');
 const rows=rowsOf(card);
 assert.deepEqual(rows.map(r=>[r.name,r.facts]),[['开发进展群','每日 → 即时 · 常有要TA回复的问题'],['被我改了的群','只存不看 → 忽略 · 你已定为每日 · 只有通知'],
  ['新来的群','未分级（按只存不看） → 只存不看 · 你已定为只存不看 · 和TA的工作无关的闲聊']],
  'changes first, then the chats graded for the first time; a level that came back where it began is no change; the one first graded before the level list went out is in that list');
 assert.deepEqual(rows[0].grey,['notation','grey']);
 assert.deepEqual(rows[0].options,[['即时（现在）','instant'],['每日','daily'],['只存不看','store'],['忽略','ignore']],'four levels, the one it has marked');
 assert.deepEqual(rows[1].options.map(o=>o[0]),['即时','每日（现在）','只存不看','忽略']);
 assert.deepEqual(rows[0].value,{act:'level',chat:a,card:'week',from:FROM,to:TO,listed:at(19,'12:00'),ids:[a,d,b],t:TO},'which chat, which card and when it was made');
 const text=shown({card});
 assert.match(text,/这一周模型改了 2 个聊天的级别，第一次分了 1 个；你纠正了 1 次分级；上次重做纠正题（10-25）做对了 8\/10（80%）/,
  'a correction is a level of mine that changed the chat\'s; the exam is the latest before the card\'s week ended');
 assert.match(text,/⋯/);plainOnly(cards);
 assert.doesNotMatch(text,/首次分级就在列表里的群/);assert.ok(f);
 assert.doesNotMatch(shown({card:weekCards(store,{from:FROM,to:TO,at:TO,exams:()=>[]})[0]}),/重做纠正题/,'no exam yet: nothing said of one');
 assert.match(shown({card:weekCards(store,{from:FROM,to:TO,at:TO,exams:()=>[]})[0]}),/首次分级就在列表里的群/,'no level list sent: every chat graded for the first time');
 assert.deepEqual(weekCards(store,{from:TO,to:TO+7*86400e3,at:TO+7*86400e3,exams:()=>exams}),[],'nothing changed: no card');
});

test('a week of many changes comes in cards of up to twelve rows, at most 36 in all, each within Feishu\'s limits',t=>{
 const {store}=tempStore(t);
 for(let i=0;i<50;i++){const id=chat(store,`oc_${i}`,`很长的群名${i}`.repeat(6));store.setLevel(id,'daily',{by:'model',reason:`理由${i}`.padEnd(200,'长'),now:at(20,'09:00')+i});}
 const cards=weekCards(store,{from:FROM,to:TO,at:TO,exams:()=>[]});
 assert.deepEqual(cards.map(c=>rowsOf(c).length),[12,12,12]);
 for(const c of cards){assert.ok(size(c)<=CARD_BYTES,`${size(c)} bytes`);assert.ok(count(c)<=MAX_COMPONENTS,`${count(c)} components`);}
 for(const c of cards)assert.deepEqual(rowsOf(c).map(r=>r.value.ids),rowsOf(c).map(()=>rowsOf(c).map(r=>r.value.chat)),'each card\'s buttons name its own chats');
 assert.match(shown({card:cards[0]}),/第一次分了 50 个/);assert.match(shown({card:cards[0]}),/只列出了 36 个，其余的在私聊里说「列出分级」可以看到/);
});

// A bot that records what it sends to the owner, and can be made to fail or to go offline.
function fakeBot(){
 return {connected:true,fail:0,sent:[],async toOwner(input){if(this.fail>0){this.fail-=1;throw Error('飞书接口错误 99991663：token invalid');}this.sent.push(input);return {messageId:`om${this.sent.length}`};}};
}
function setup(t,{exams=()=>[]}={}){
 let cards;t.after(()=>cards.stop());
 const {store}=tempStore(t),bot=fakeBot(),clock={t:at(26,'09:00')};
 cards=new LevelCards({store,bot,schedule:DEFAULT_SCHEDULE,exams,now:()=>clock.t,retryMs:300e3});
 return {store,bot,clock,cards,async tickAt(when){clock.t=when;const before=bot.sent.length;await cards.tick();return bot.sent.slice(before).map(shown).join('\n');}};
}

test('the weekly card goes out once a week at the first slot of Monday, only when the model changed something, and again after a failed send',async t=>{
 const {store,bot,tickAt}=setup(t);
 week(store);
 assert.equal(await tickAt(at(26,'09:59')),'','not before the slot');
 bot.connected=false;assert.equal(await tickAt(at(26,'10:00')),'','offline: it waits');
 bot.connected=true;bot.fail=1;
 assert.equal(await tickAt(at(26,'10:01')),'');assert.ok(store.errors().some(e=>e.source==='分级'&&/token invalid/.test(e.message)));
 assert.equal(await tickAt(at(26,'10:03')),'','not again right away');
 assert.match(await tickAt(at(26,'10:06')),/分级变化（10-19 至 10-26）/);
 assert.equal(bot.sent[0].card.config.update_multi,true);
 assert.equal(await tickAt(at(27,'10:00')),'','once a week');
 assert.equal(await tickAt(at(30,'10:00')),'');
 assert.equal(await tickAt(at(26,'10:00')+7*86400e3),'','a week without changes: no card');
 store.setLevel(chat(store,'oc_z','又一个新群'),'daily',{by:'model',reason:'讨论',now:at(26,'10:00')+8*86400e3});
 assert.match(await tickAt(at(26,'10:00')+14*86400e3),/又一个新群/);
});

test('after the first scheduled grading pass that graded chats the level list goes out once, as soon as the bot is connected; a pass I asked for before it does not count',async t=>{
 const {store,bot,cards,clock}=setup(t);clock.t=at(23,'09:00');
 store.setLevel(chat(store,'oc_dev','开发进展群'),'daily',{by:'model',reason:'项目讨论',now:at(23,'08:00')});
 await cards.passed({at:at(23,'08:00'),by:'request',changed:[],graded:1,failed:0});
 assert.equal(bot.sent.length,0,'one or two chats I had graded are no level list');assert.equal(store.meta('levelCards')?.listDue,undefined,'nor is the list due');
 assert.equal(store.meta('levelCards')?.listAt,undefined);
 bot.connected=false;
 await cards.passed({at:at(23,'08:30'),by:'schedule',changed:[],graded:1,failed:0});assert.equal(bot.sent.length,0);
 bot.connected=true;clock.t=at(23,'09:01');await cards.tick();
 assert.equal(bot.sent.length,1);assert.match(shown(bot.sent[0]),/聊天的分级/);assert.match(shown(bot.sent[0]),/开发进展群 — 项目讨论/);
 assert.equal(store.meta('levelCards').listAt,at(23,'09:01'));
 await cards.passed({at:at(23,'10:00'),by:'schedule',changed:[],graded:3,failed:0});await cards.tick();
 assert.equal(bot.sent.length,1,'only after the first');
});

test('what the model newly inferred about me goes to me with how to correct it; nothing when it inferred nothing new',async t=>{
 const {store,bot,cards}=setup(t);
 await cards.inferred({text:'【工作】角色：后端',added:[],at:at(23,'09:00')});
 assert.equal(bot.sent.length,0);
 await cards.inferred({text:'【工作】……',added:['负责 GEO 洞察的后端','对 AI 编程工具感兴趣 https://evil.example/x'],at:at(23,'09:00')});
 assert.equal(bot.sent.length,1);
 const text=shown(bot.sent[0]);
 assert.match(text,/负责 GEO 洞察的后端/);assert.match(text,/对 AI 编程工具感兴趣 https:\/\/evil\.example\/x/,'as text');assert.match(text,/在私聊里/);
 plainOnly([bot.sent[0].card]);
 bot.fail=1;await cards.inferred({text:'x',added:['新的推断'],at:at(23,'10:00')});
 assert.ok(store.errors().some(e=>e.source==='分级'&&/关于TA/.test(e.message)&&/token invalid/.test(e.message)),'a failed send is on record, never thrown');
});

// A choice on a row's ⋯, as the bot hands it on.
const choose=(cards,row,option,messageId='om1')=>cards.click({messageId,chatId:'oc_dm',operator:{openId:OWNER},action:{tag:'overflow',value:row.value,option}});

test('choosing a level on the weekly card sets it as mine, on record like any change of mine, and the card is made again in place',async t=>{
 const {store,cards,clock}=setup(t),{a,d}=week(store);
 const card=weekCards(store,{from:FROM,to:TO,at:TO,listed:at(19,'12:00'),exams:()=>[]})[0];
 clock.t=at(26,'11:00');
 const r=choose(cards,rowsOf(card)[0],'store');
 assert.deepEqual(r.toast,{type:'success',content:'开发进展群：即时 → 只存不看（你定的）'});
 assert.deepEqual([store.level(a).level,store.level(a).by,store.level(a).modelLevel],['store','owner','instant']);
 assert.deepEqual(store.levelChanges(at(26,'11:00')).map(c=>[c.feedId,c.by,c.before.level,c.after.level]),[[a,'owner','instant','store']]);
 assert.equal(r.card.type,'raw');
 const again=rowsOf(r.card.data);
 assert.deepEqual(again.map(x=>x.name),['开发进展群','被我改了的群','新来的群'],'the same chats');
 assert.equal(again[0].facts,'每日 → 即时 · 你已定为只存不看 · 常有要TA回复的问题');assert.deepEqual(again[0].options.map(o=>o[0]),['即时','每日','只存不看（现在）','忽略']);
 assert.notDeepEqual(again[0].value.t,rowsOf(card)[0].value.t,'new buttons: the SDK drops the same click on the same message for 12 hours');
 assert.match(shown({card:r.card.data}),/你纠正了 1 次分级/,'the week\'s count stays the week\'s');
 const same=choose(cards,again[1],'daily');
 assert.deepEqual(same.toast,{type:'info',content:'被我改了的群 已经是你定的每日'});assert.equal(store.level(d).since,at(21,'12:00'));
 for(const action of [{tag:'overflow',value:again[0].value,option:'watched'},{tag:'overflow',value:again[0].value},{tag:'button',value:{act:'done',matter:1,card:'digest',t:1}},
  {tag:'overflow',value:{...again[0].value,chat:'oc_somewhere_else'},option:'ignore'}])
  assert.equal(cards.click({messageId:'om1',chatId:'oc_dm',operator:{openId:OWNER},action}),undefined,`not a choice butler made: ${JSON.stringify(action).slice(0,80)}`);
});

test('wired as in the service: only my choice on the weekly card changes a level; anyone else gets an error toast, and the todo buttons still work',async t=>{
 let bot;t.after(()=>bot.stop());// before the store closes: after-hooks run in order
 const {store}=tempStore(t),feishu=fakeChannel(),matters=new Matters(store),{a}=week(store);
 bot=new Bot({store,appId:'cli_a1b2c3d4e5f6',appSecret:'s',domain:'feishu',owner:OWNER,channelFactory:feishu.factory,retryMinMs:10,retryMaxMs:40});
 const levels=new LevelCards({store,bot,schedule:DEFAULT_SCHEDULE,now:()=>at(26,'11:00')}),digests=new Digests({store,matters,bot,schedule:DEFAULT_SCHEDULE,now:()=>at(26,'11:00')});
 bot.onCardAction=evt=>levels.click(evt)??digests.click(evt);
 await bot.start();await levels.tick();
 const [row]=rowsOf(feishu.sent[0].input.card);
 const other=await feishu.click({messageId:'om_out1',operator:{openId:'ou_someone_else000000000000000002'},action:{tag:'overflow',value:row.value,option:'ignore'}});
 assert.deepEqual(other,{toast:{type:'error',content:'只有管家的主人能操作这张卡片'}});assert.deepEqual([store.level(a).level,store.level(a).by],['instant','model']);
 const mine=await feishu.click({messageId:'om_out1',action:{tag:'overflow',value:row.value,option:'ignore'}});
 assert.equal(mine.toast.type,'success');assert.deepEqual([store.level(a).level,store.level(a).by],['ignore','owner']);
 const id=post(store,{text:'@原智鸿 看下'});matters.apply({created:[{title:'看一下',who:'陈帆',ask:'看',urgency:'normal',messageIds:[id]}],processedIds:[id]});
 const done=await feishu.click({messageId:'om_out9',action:{tag:'button',value:{act:'done',matter:1,card:'digest',t:1}}});
 assert.equal(done.toast.content,'已完成');assert.equal(matters.matter(1).status,'closed');
 await digests.stop();await levels.stop();
});

test('wired to the grader and the processor as in the service: the first scheduled pass that grades chats sends the level list, not a pass I asked for before it; a new 关于TA what it newly inferred',async t=>{
 let levels;t.after(()=>levels.stop());// before the store closes: after-hooks run in order
 const {store}=tempStore(t),matters=new Matters(store),bot=fakeBot(),now=at(23,'09:00');
 levels=new LevelCards({store,bot,schedule:DEFAULT_SCHEDULE,exams:n=>matters.exams(n),now:()=>now});
 const model=answer=>({async ask({prompt}){return JSON.stringify(answer(JSON.parse(prompt.slice(prompt.indexOf('{')))));}});
 // Butler has kept every message for three days: the chats are due for their first grading.
 for(const c of ['g1','g2'])post(store,{chat:c,text:'项目讨论',at:now-2*86400e3,seen:now-3*86400e3,categories:['stored']});
 const grader=new Grader({store,matters,model:model(d=>({chats:d.chats.map(c=>({chat:c.chat,level:'daily',reason:'项目讨论'}))})),now:()=>now,onPass:p=>levels.passed(p)});
 await grader.grade(['g1']);await levels.tick();
 assert.equal(bot.sent.length,0,'a pass I asked for');
 await grader.check();await levels.tick();
 assert.equal(bot.sent.length,1);assert.match(shown(bot.sent[0]),/聊天的分级/);assert.match(shown(bot.sent[0]),/项目群 — 项目讨论/);assert.match(shown(bot.sent[0]),/大群 — 项目讨论/);
 await grader.grade();await levels.tick();assert.equal(bot.sent.length,1,'only after the first');
 matters.addNote('审批不归我管',now);
 const processor=new Processor({store,matters,model:model(()=>({work:'角色：后端',interests:'',added:['TA是做后端的']})),now:()=>now,onProfile:p=>levels.inferred(p)});
 await processor.start({periodic:false});await processor.runOnce();await processor.stop();
 await waitFor(()=>bot.sent.length===2,{message:'the new inferences'});
 assert.match(shown(bot.sent[1]),/关于你的新推断/);assert.match(shown(bot.sent[1]),/TA是做后端的/);
});
