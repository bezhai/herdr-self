import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post,sleep} from './helpers.mjs';
import {shown,componentsOf} from './fake-channel.mjs';
import {Matters} from '../matters.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {cards,heading,MAX_COMPONENTS} from '../cards.mjs';
import {digestOf,digestCard,matterBlock,Digests,CARD_BYTES} from '../digest.mjs';

process.env.TZ='Asia/Shanghai';
const at=(day,hm)=>Date.parse(`2026-10-${day}T${hm}:00+08:00`),fri=hm=>at(23,hm);

// A matter as the processor would have made it at time t from one message of chat, a minute older.
function made(store,matters,{title,urgency='normal',who='陈帆',ask=`处理：${title}`,due=null,t,chat='g1'}){
 const id=post(store,{chat,text:title,at:t-60e3});
 return matters.apply({created:[{title,who,ask,due,urgency,messageIds:[id]}],processedIds:[id],now:t})[0];
}
const endByModel=(matters,id,reason,t)=>matters.apply({updated:[{matterId:id,messageIds:[],changes:{},close:reason}],now:t});
const size=card=>Buffer.byteLength(JSON.stringify(JSON.stringify(card)));
const count=card=>[...componentsOf(card)].length;
// A matter's block, read back: its tags (label:color), the texts of its main column and where its 打开 link leads.
function readBlock(b){
 assert.equal(b.tag,'column_set');
 const md=b.columns.flatMap(c=>c.elements).filter(e=>e.tag==='markdown'),main=b.columns.find(c=>c.width==='weighted');
 const tags=md.find(e=>e.content.startsWith('<text_tag')),open=md.find(e=>e.content.startsWith('[打开]('));
 return {tags:tags?[...tags.content.matchAll(/<text_tag color='(\w+)'>([^<]+)<\/text_tag>/g)].map(m=>`${m[2]}:${m[1]}`):[],
  title:main.elements[0].text,meta:main.elements[1].text,ask:main.elements[2]?.text,url:open&&/^\[打开\]\((.+)\)$/.exec(open.content)[1]};
}
const blocksOf=card=>card.body.elements.filter(e=>e.tag==='column_set').map(readBlock);
const idOf=b=>Number(/^#(\d+) /.exec(b.meta.content)[1]);
const panelOf=card=>card.body.elements.find(e=>e.tag==='collapsible_panel');
const textOf=x=>[...componentsOf(x)].filter(c=>c.tag==='plain_text').map(c=>c.content).join('\n');

test('the todo card: every open matter in one block, urgent first and then by when it started, with its tags, title, facts, ask and a link to its message',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const old=made(store,matters,{title:'老事项',t:fri('09:00')}),older=made(store,matters,{title:'更老的紧急事项',urgency:'high',t:fri('08:50')});
 const last=fri('09:30');
 const low=made(store,matters,{title:'知道就行的事',urgency:'low',t:fri('09:40')});
 const high=made(store,matters,{title:'今天要批的权限',urgency:'high',who:'黄凯熙',ask:'给黄凯熙加权限',due:'2026-10-23 18:00',t:fri('09:50'),chat:'g2'});
 const d=digestOf(matters,last);
 assert.deepEqual(d.open.map(m=>m.id),[older,high,old,low],'urgency first, then by when it started');
 assert.deepEqual(d.fresh.map(m=>m.id),[high,low],'opened since the last digest');
 assert.deepEqual(d.ended,[]);
 const card=digestCard({at:fri('10:00'),...d});
 assert.equal(card.schema,'2.0');
 assert.equal(card.config.update_multi,true,'Feishu updates a sent card only when it says so, before and after');
 assert.equal(card.config.summary.content,'2 件紧急 · 共 4 件待办','what the chat list and notifications show');
 assert.deepEqual(card.header,{title:{tag:'plain_text',content:'管家待办'},subtitle:{tag:'plain_text',content:'更新于 10:00'},template:'red'},'red: something urgent is open');
 const blocks=blocksOf(card);
 assert.deepEqual(blocks.map(idOf),[older,high,old,low]);
 assert.deepEqual(blocks[1],{tags:['紧急:red','新:blue'],title:{tag:'plain_text',content:'今天要批的权限',text_size:'heading'},
  meta:{tag:'plain_text',content:`#${high} · 黄凯熙 · 大群 · 10-23 09:49 起 · 期限 2026-10-23 18:00`,text_size:'notation',text_color:'grey'},
  ask:{tag:'plain_text',content:'给黄凯熙加权限'},url:matters.matter(high).link});
 assert.deepEqual(blocks.map(b=>b.tags),[['紧急:red'],['紧急:red','新:blue'],['一般:orange'],['不急:neutral','新:blue']],'新: opened since the last digest');
 assert.equal(blocks[2].meta.content,`#${old} · 陈帆 · 项目群 · 10-23 08:59 起`,'no due date, none shown');
 assert.ok(!card.body.elements.some(e=>e.tag==='hr'),'no rule between the matters');
 assert.equal(panelOf(card),undefined,'nothing ended: no panel');
 assert.equal(card.body.elements.filter(e=>e.tag!=='column_set').length,0,'all of them listed: nothing else');
 assert.equal(digestCard({at:fri('10:00'),...digestOf(matters,undefined)}).body.elements.filter(e=>e.tag==='column_set').map(readBlock).filter(b=>b.tags.includes('新:blue')).length,4,
  'with no digest before, everything open is new');
});

test('the matters that ended since the last digest are in a collapsed panel, title and reason in grey: those butler ended first, the latest first, at most ten',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const open=made(store,matters,{title:'还开着的事',t:fri('08:00')});
 const ended=[made(store,matters,{title:'已经解决的事',t:fri('09:00')}),made(store,matters,{title:'过时的事',t:fri('09:05')})];
 const mine=made(store,matters,{title:'我在私聊里关掉的',t:fri('09:10')});
 endByModel(matters,ended[0],'对方说已经解决了',fri('09:40'));endByModel(matters,ended[1],'被新的消息取代',fri('09:45'));matters.close(mine,'不用管',fri('09:50'));
 const card=digestCard({at:fri('10:00'),...digestOf(matters,fri('09:30'))}),panel=panelOf(card);
 assert.deepEqual(blocksOf(card).map(idOf),[open]);
 assert.equal(panel.expanded,false,'collapsed');assert.deepEqual(panel.header.title,{tag:'plain_text',content:'上次汇总以来结束了 3 件'});
 assert.deepEqual(panel.elements.map(e=>[e.tag,e.text.text_color]),[['div','grey']]);
 assert.equal(textOf(panel.elements),[`#${ended[1]} 过时的事 — 被新的消息取代`,`#${ended[0]} 已经解决的事 — 对方说已经解决了`,`#${mine} 我在私聊里关掉的 — 在私聊里关掉：不用管`].join('\n'));
 assert.equal(card.header.template,'blue','nothing urgent');assert.equal(card.config.summary.content,'共 1 件待办');
 let n=0;const make=k=>[...Array(k)].map(()=>made(store,matters,{title:`事项${++n}`,t:fri('10:00')+n*60e3}));
 const byModel=make(12),closedByMe=make(2);
 byModel.forEach((id,i)=>endByModel(matters,id,`原因${i}`,fri('11:00')+i*60e3));closedByMe.forEach((id,i)=>matters.close(id,undefined,fri('11:30')+i*60e3));
 const lines=textOf(panelOf(digestCard({at:fri('12:00'),...digestOf(matters,fri('10:30'))})).elements).split('\n');
 assert.deepEqual(lines,[...[...byModel].reverse().slice(0,10).map(id=>`#${id} ${matters.matter(id).title} — ${matters.matter(id).reason}`),'另有 4 件也结束了，没有列出']);
});

test('nothing open: a blue card that says so; the update time carries the date once the day has changed',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const id=made(store,matters,{title:'办完的事',urgency:'high',t:fri('09:00')});endByModel(matters,id,'办完了',fri('09:30'));
 const card=digestCard({at:fri('10:00'),...digestOf(matters,fri('09:10'))});
 assert.equal(card.header.template,'blue');assert.equal(card.config.summary.content,'现在没有待办');
 assert.deepEqual(card.body.elements[0],{tag:'div',text:{tag:'plain_text',content:'现在没有要你处理的事。'}});
 assert.ok(panelOf(card),'what ended is still listed');
 assert.equal(digestCard({at:at(24,'09:05'),sentAt:fri('20:00'),...digestOf(matters,fri('09:10'))}).header.subtitle.content,'更新于 10-24 09:05','a card sent the day before');
 assert.equal(digestCard({at:fri('20:30'),sentAt:fri('20:00'),...digestOf(matters,fri('09:10'))}).header.subtitle.content,'更新于 20:30');
});

test('text from the model, the chats and the people is shown as plain text: markdown carries only butler\'s tags, headings and links',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const id=made(store,matters,{title:'**加急** [点这里](https://evil.example/x) <text_tag color=\'red\'>假</text_tag>',who:'<at id=all></at>',ask:'看 `代码` 和 # 标题',
  due:'<font color=red>今天</font>',t:fri('09:00'),chat:'[链接](https://x.example)'});
 const gone=made(store,matters,{title:'[也是链接](https://evil.example/y)',t:fri('09:01')});endByModel(matters,gone,'**理由** <at id=all></at>',fri('09:30'));
 const all=[digestCard({at:fri('10:00'),...digestOf(matters,undefined)}),cards([heading('没结束的事项（1）'),...matters.list().map(m=>matterBlock(m))],{summary:'管家的回复'})];
 // A parenthesis in butler's link (here from the odd chat id) would end the markdown link, so it is escaped.
 const safe=matters.matter(id).link.replaceAll('(','%28').replaceAll(')','%29');
 for(const c of componentsOf(all)){
  assert.notEqual(c.tag,'lark_md');
  if(c.tag==='markdown')assert.ok(/^(?:(?:<text_tag color='(?:red|orange|neutral|blue)'>(?:紧急|一般|不急|新)<\/text_tag> ?)+|\*\*[^*[\]<]+\*\*)$/.test(c.content)||c.content===`[打开](${safe})`,
   `butler's own markdown only: ${c.content}`);
 }
 const text=all.map(card=>shown({card})).join('\n');
 for(const s of ['**加急** [点这里](https://evil.example/x)','<at id=all></at>','看 `代码` 和 # 标题','<font color=red>今天</font>','[链接](https://x.example)','**理由** <at id=all></at>'])
  assert.ok(text.includes(s),`still there, as text: ${s}`);
});

test('a digest is one card that always fits: at most fifteen open matters and fewer when they are long, the rest counted by urgency',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 for(let i=0;i<40;i++)made(store,matters,{title:`事项${i}`,ask:i%2?'短':'很长的说明'.repeat(40),urgency:['high','normal','low'][i%3],t:fri('09:00')+i*1000});
 const ended=[];for(let i=0;i<30;i++){const id=made(store,matters,{title:`结束的${i}`,t:fri('08:00')+i*1000});endByModel(matters,id,'理由'.repeat(50),fri('09:30'));ended.push(id);}
 const card=digestCard({at:fri('10:00'),...digestOf(matters,undefined)}),blocks=blocksOf(card);
 assert.ok(size(card)<=CARD_BYTES,`${size(card)} bytes`);assert.ok(count(card)<=MAX_COMPONENTS,`${count(card)} components`);
 assert.equal(blocks.length,15);
 const rest=card.body.elements.find(e=>e.tag==='div');
 assert.deepEqual(rest.text,{tag:'plain_text',content:'另有 25 件没有列出（12 件一般、13 件不急），在私聊里说「现在有哪些事」可以看全部',text_size:'notation',text_color:'grey'});
 assert.ok(card.body.elements.indexOf(rest)>card.body.elements.findLastIndex(e=>e.tag==='column_set'),'after the listed ones');
 assert.match(textOf(panelOf(card).elements),/另有 20 件也结束了，没有列出$/);
 const long=new Matters(tempStore(t).store),s2=long.store;
 for(let i=0;i<20;i++)made(s2,long,{title:`很长的标题${i}`.repeat(6),ask:'长'.repeat(400),who:'人'.repeat(60),due:'期'.repeat(40),urgency:'high',t:fri('09:00')+i*1000});
 const big=digestCard({at:fri('10:00'),...digestOf(long,undefined)}),listed=blocksOf(big).length;
 assert.ok(size(big)<=CARD_BYTES,`${size(big)} bytes`);assert.ok(listed<15&&listed>5,`${listed} listed`);
 assert.match(textOf(big),new RegExp(`另有 ${20-listed} 件没有列出（${20-listed} 件紧急）`));
});

test('the conversation\'s list of every open matter uses the same blocks, split into cards that each fit',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const ids=[];for(let i=0;i<60;i++)ids.push(made(store,matters,{title:`事项${i}`,ask:'很长的说明'.repeat(30),t:fri('09:00')+i*1000}));
 const split=cards([heading('没结束的事项（60）'),...matters.list().map(m=>matterBlock(m))],{summary:'管家的回复'});
 assert.ok(split.length>1);
 for(const c of split){assert.ok(size(c)<=CARD_BYTES,`${size(c)} bytes`);assert.ok(count(c)<=MAX_COMPONENTS,`${count(c)} components`);}
 assert.deepEqual(split.flatMap(blocksOf).map(idOf).sort((a,b)=>a-b),ids,'each once');
 assert.deepEqual(readBlock(matterBlock(matters.matter(ids[0]))).tags,['一般:orange'],'no 新 outside a digest');
});

// A bot that records what it sends to the owner and the cards it updates, in one log, and can be made to fail, to go
// offline, or to hold a send until gate resolves.
function fakeBot(){
 return {connected:true,fail:0,failUpdate:0,gate:undefined,sent:[],updated:[],log:[],
  async toOwner(input){
   if(this.gate)await this.gate;
   if(this.fail>0){this.fail-=1;throw Error('飞书接口错误 99991663：token invalid');}
   this.sent.push(input);const messageId=`om${this.sent.length}`;this.log.push(`send ${messageId}`);return {messageId};
  },
  async updateCard(messageId,card){
   if(this.failUpdate>0){this.failUpdate-=1;throw Error('飞书接口错误 230020：This operation triggers the frequency limit.');}
   this.updated.push({messageId,card});this.log.push(`update ${messageId}`);
  }};
}
function setup(t,{schedule=DEFAULT_SCHEDULE,start,refreshDelayMs=10}={}){
 const {store}=tempStore(t),matters=new Matters(store),bot=fakeBot(),clock={t:start};
 const digests=new Digests({store,matters,bot,schedule,now:()=>clock.t,retryMs:300e3,refreshDelayMs});
 t.after(()=>digests.stop());
 return {store,matters,bot,clock,digests,made:o=>made(store,matters,o),
  async tickAt(when){clock.t=when;const before=bot.sent.length;await digests.tick();return bot.sent.slice(before).map(shown).join('\n');}};
}
const lastCard=bot=>bot.sent.at(-1).card;

test('the digest goes out hourly in working time with what changed, and not at all when nothing did',async t=>{
 const {store,matters,bot,tickAt,digests,made}=setup(t);
 const a=made({title:'早上的事',urgency:'low',t:fri('09:00')}),b=made({title:'早上的急事',urgency:'high',t:fri('09:30')});
 let out=await tickAt(fri('10:00'));
 assert.equal(bot.sent.length,1,'one card');assert.ok(out.indexOf('早上的急事')<out.indexOf('早上的事'));
 assert.deepEqual(store.meta('digest'),{at:fri('10:00'),slot:fri('10:00'),sent:1,messageId:'om1'},'with the message, to update it later');
 const c=made({title:'十点半的事',t:fri('10:30')});
 assert.equal(await tickAt(fri('10:31')),'','one digest per hour');
 out=await tickAt(fri('11:00'));
 assert.deepEqual(blocksOf(lastCard(bot)).map(x=>[idOf(x),x.tags.includes('新:blue')]),[[b,false],[c,true],[a,false]],'all that is open, what came since marked new');
 assert.deepEqual(store.meta('digest'),{at:fri('11:00'),slot:fri('11:00'),sent:2,messageId:'om2',previousAt:fri('10:00')});
 assert.equal(await tickAt(fri('12:00')),'','nothing new and nothing ended: no digest');
 assert.equal(store.meta('digest').at,fri('11:00'));
 endByModel(matters,a,'对方说不用了',fri('12:10'));matters.close(b,undefined,fri('12:20'));
 out=await tickAt(fri('13:00'));
 assert.match(textOf(panelOf(lastCard(bot))),/早上的事 — 对方说不用了/);assert.match(textOf(panelOf(lastCard(bot))),/早上的急事 — 在私聊里关掉/);
 assert.deepEqual(blocksOf(lastCard(bot)).map(x=>[idOf(x),x.tags.includes('新:blue')]),[[c,false]]);
 matters.close(c,'处理完了',fri('13:20'));
 assert.equal(await tickAt(fri('14:00')),'','closing a matter in the conversation alone is no reason for a digest');
 assert.equal(digests.status().next,undefined);
});

test('outside working time a digest waits for three new matters and two hours since the last one',async t=>{
 const {tickAt,digests,made}=setup(t);
 made({title:'下班前的事',t:fri('19:30')});
 assert.notEqual(await tickAt(fri('20:00')),'');
 for(const [i,hm] of [[1,'20:10'],[2,'20:20'],[3,'21:00']])made({title:`晚上的事${i}`,t:fri(hm)});
 assert.equal(await tickAt(fri('21:30')),'','three new, but too soon');
 assert.equal(digests.status().next,fri('22:00'));
 const out=await tickAt(fri('22:00'));
 for(let i=1;i<=3;i++)assert.match(out,new RegExp(`晚上的事${i}`));
 made({title:'半夜的事',t:fri('23:00')});
 assert.equal(await tickAt(at(24,'12:00')),'','one new matter waits');
 assert.equal(digests.status().next,at(26,'10:00'),'until Monday morning');
 assert.match(await tickAt(at(26,'10:00')),/半夜的事/);
});

test('a digest that could not be sent is tried again a few minutes later, and none goes out while the bot is offline',async t=>{
 const {store,bot,tickAt,made}=setup(t);
 made({title:'要汇总的事',t:fri('09:00')});
 bot.connected=false;
 assert.equal(await tickAt(fri('10:00')),'');assert.equal(store.meta('digest'),undefined,'offline: the slot stays open');
 bot.connected=true;bot.fail=1;
 assert.equal(await tickAt(fri('10:01')),'');
 assert.ok(store.errors().some(e=>e.source==='汇总'&&/token invalid/.test(e.message)));
 assert.equal(await tickAt(fri('10:03')),'','not again right away');
 assert.match(await tickAt(fri('10:06')),/要汇总的事/);
 assert.equal(store.meta('digest').at,fri('10:06'));
});

test('a new digest turns the one before it into a short note that points below, so no older card shows todos that are out of date',async t=>{
 const {store,bot,tickAt,made}=setup(t);
 made({title:'第一件',t:fri('09:00')});await tickAt(fri('10:00'));
 made({title:'第二件',t:fri('10:10')});await tickAt(fri('11:00'));
 assert.deepEqual(bot.log,['send om1','send om2','update om1'],'after the new one is out');
 const note=bot.updated[0].card;
 assert.equal(note.config.update_multi,true);assert.equal(note.header.template,'grey');
 assert.ok(![...componentsOf(note)].some(c=>c.tag==='column_set'),'no todos left in it');
 assert.match(shown({card:note}),/下面/);assert.match(note.config.summary.content,/过时/);
 bot.failUpdate=1;made({title:'第三件',t:fri('11:10')});await tickAt(fri('12:00'));
 assert.equal(store.meta('digest').messageId,'om3','the new digest counts even when the note could not be written');
 assert.ok(store.errors().some(e=>e.source==='汇总'&&/230020/.test(e.message)));
 // Feishu updates a message for 14 days after it was sent: an older one is left as it is.
 made({title:'很久以后的事',t:at(26,'09:00')+14*86400e3});const before=bot.log.length;await tickAt(at(26,'10:00')+14*86400e3);
 assert.deepEqual(bot.log.slice(before),['send om4']);
});

test('refresh() brings the latest digest up to date in place: one update for a burst of calls, with what is open and ended now and when',async t=>{
 const {store,matters,bot,clock,digests,tickAt,made}=setup(t);
 const a=made({title:'早上的事',t:fri('09:00')});await tickAt(fri('10:00'));
 const b=made({title:'十点的急事',urgency:'high',t:fri('10:05')});await tickAt(fri('11:00'));
 bot.log.length=0;bot.updated.length=0;
 const c=made({title:'十一点的事',t:fri('11:10')});endByModel(matters,a,'对方说不用了',fri('11:15'));
 clock.t=fri('11:20');
 await Promise.all([digests.refresh(),digests.refresh(),digests.refresh()]);
 assert.deepEqual(bot.log,['update om2'],'one update, of the latest digest');
 const card=bot.updated[0].card;
 assert.equal(card.header.subtitle.content,'更新于 11:20');assert.equal(card.config.update_multi,true);assert.equal(card.header.template,'red');
 assert.deepEqual(blocksOf(card).map(x=>[idOf(x),x.tags.includes('新:blue')]),[[b,true],[c,true]],'new: opened since the digest before it');
 assert.match(textOf(panelOf(card)),new RegExp(`#${a} 早上的事 — 对方说不用了`),'ended since the digest before it');
 assert.equal(store.meta('digest').messageId,'om2');
 matters.close(b,undefined,fri('11:25'));clock.t=fri('11:30');await digests.refresh();
 assert.deepEqual(bot.log,['update om2','update om2']);
 const later=bot.updated[1].card;
 assert.equal(later.header.template,'blue');assert.deepEqual(blocksOf(later).map(idOf),[c]);assert.match(textOf(panelOf(later)),/十点的急事 — 在私聊里关掉/);
});

test('refresh() does nothing without a digest or a connection, records a failure instead of throwing, and waits for a send under way',async t=>{
 const {store,bot,clock,digests,tickAt,made}=setup(t);
 made({title:'早上的事',t:fri('09:00')});clock.t=fri('09:30');
 await digests.refresh();assert.deepEqual(bot.log,[],'no digest yet');
 await tickAt(fri('10:00'));
 store.setMeta('digest',{...store.meta('digest'),messageId:undefined});await digests.refresh();
 assert.deepEqual(bot.log,['send om1'],'a digest sent before butler kept its message');
 store.setMeta('digest',{...store.meta('digest'),messageId:'om1'});
 bot.connected=false;await digests.refresh();assert.deepEqual(bot.log,['send om1'],'offline');
 bot.connected=true;bot.failUpdate=1;await digests.refresh();
 assert.ok(store.errors().some(e=>e.source==='汇总'&&/没有更新.*230020/.test(e.message)));
 let release;bot.gate=new Promise(r=>{release=r;});made({title:'十点半的事',t:fri('10:30')});
 const sending=tickAt(fri('11:00'));const refreshing=digests.refresh();
 await sleep(50);assert.deepEqual(bot.log,['send om1'],'the refresh waits while the digest is being sent');
 release();await Promise.all([sending,refreshing]);
 assert.deepEqual(bot.log,['send om1','send om2','update om1','update om2'],'then brings the new one up to date');
 clock.t=fri('11:00')+14*86400e3;await digests.refresh();
 assert.equal(bot.log.length,4,'Feishu no longer updates a message sent 14 days ago');
 await digests.stop();clock.t=fri('11:10');store.setMeta('digest',{...store.meta('digest'),at:fri('11:00')});await digests.refresh();
 assert.equal(bot.log.length,4,'stopped');
});
