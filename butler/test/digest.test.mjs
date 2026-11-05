import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post,sleep} from './helpers.mjs';
import {shown,componentsOf} from './fake-channel.mjs';
import {Matters} from '../matters.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {cards,heading,MAX_COMPONENTS} from '../cards.mjs';
import {todoOf,digestCard,matterRow,Digests,CARD_BYTES} from '../digest.mjs';

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
// A matter's row, read back: the color of its dot, its title and facts, where clicking them leads, and its buttons: 完成
// and ⋯ (its options, each with its value or link, and what it sends back).
function readRow(r){
 assert.equal(r.tag,'column_set');
 const [left,main,right]=r.columns,box=main.elements[0].tag==='interactive_container'?main.elements[0]:undefined;
 const [title,facts]=(box?box.elements:main.elements).map(e=>e.text),[done,more]=right.elements;
 assert.equal(done.tag,'button');assert.equal(more.tag,'overflow');
 return {dot:/^<font color='(\w+)'>●<\/font>$/.exec(left.elements[0].content)[1],title,facts,url:box?.behaviors.find(b=>b.type==='open_url').default_url,
  done:{text:done.text.content,value:done.behaviors.find(b=>b.type==='callback').value},
  more:{options:more.options.map(o=>[o.text.content,o.value??o.multi_url.url]),value:more.behaviors.find(b=>b.type==='callback').value}};
}
const rowsOf=card=>card.body.elements.filter(e=>e.tag==='column_set').map(readRow);
const idOf=r=>r.done.value.matter;
const panelOf=card=>card.body.elements.find(e=>e.tag==='collapsible_panel');
const textOf=x=>[...componentsOf(x)].filter(c=>c.tag==='plain_text').map(c=>c.content).join('\n');
const digestAt=(matters,when,sentAt)=>digestCard({at:when,sentAt,...todoOf(matters,when)});

test('the todo card: a row for every open matter, urgent first and then by when it started: a dot in its urgency\'s color, the title, who, where and when, which open its message, and 完成 and ⋯',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const old=made(store,matters,{title:'老事项',t:at(22,'16:00')}),older=made(store,matters,{title:'更老的紧急事项',urgency:'high',t:at(22,'15:00')});
 const low=made(store,matters,{title:'知道就行的事',urgency:'low',t:fri('09:40')});
 const high=made(store,matters,{title:'今天要批的权限',urgency:'high',who:'黄凯熙',ask:'给他在平台上加权限',due:'2026-10-23 18:00',t:fri('09:50'),chat:'g2'});
 const card=digestAt(matters,fri('10:00'));
 assert.equal(card.schema,'2.0');
 assert.equal(card.config.update_multi,true,'Feishu updates a sent card only when it says so, before and after');
 assert.equal(card.config.summary.content,'2 件紧急 · 共 4 件待办','what the chat list and notifications show');
 assert.deepEqual(card.header,{title:{tag:'plain_text',content:'管家待办'},subtitle:{tag:'plain_text',content:'更新于 10:00'},
  text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:'2 件紧急'},color:'red'}],template:'red'},'the urgent ones counted on the right, red');
 const rows=rowsOf(card);
 assert.deepEqual(rows.map(idOf),[older,high,old,low]);
 assert.deepEqual(rows.map(r=>r.dot),['red','red','orange','grey']);
 const link=matters.matter(high).link;
 assert.deepEqual(rows[1],{dot:'red',title:{tag:'plain_text',content:'今天要批的权限'},
  facts:{tag:'plain_text',content:'黄凯熙 · 大群 · 期限 10-23 18:00',text_size:'notation',text_color:'grey'},url:link,
  done:{text:'完成',value:{act:'done',matter:high}},more:{options:[['不归我','not_mine'],['打开原消息',link]],value:{matter:high}}});
 assert.equal(rows[2].facts.content,'陈帆 · 项目群 · 10-22 15:59','no due date: when it started, with the date on another day');
 assert.equal(rows[3].facts.content,'陈帆 · 项目群 · 今天 09:39');
 const text=textOf(card);
 assert.doesNotMatch(text,/给他在平台上加权限/,'no ask line');assert.doesNotMatch(text,/#\d/,'no numbers');
 assert.ok(!card.body.elements.some(e=>e.tag==='hr'||e.tag==='collapsible_panel'),'nothing ended: no panel');
 const calm=digestCard({at:fri('10:00'),open:[matters.matter(old)],ended:[]});
 assert.deepEqual(calm.header,{title:{tag:'plain_text',content:'管家待办'},subtitle:{tag:'plain_text',content:'更新于 10:00'},template:'blue'},'nothing urgent: no count, not red');
});

test('a row shows a due date in its own words, drops this year from a date, and has no links when its matter has no message',()=>{
 const m={id:7,title:'交周报',who:'陈帆',chats:['项目群','大群'],urgency:'normal',since:fri('09:00'),due:'下周一',link:undefined};
 const row=readRow(matterRow(m,{at:fri('10:00')}));
 assert.equal(row.facts.content,'陈帆 · 项目群、大群 · 期限 下周一');
 assert.equal(row.url,undefined,'nothing to open');assert.deepEqual(row.more.options,[['不归我','not_mine']]);
 assert.equal(readRow(matterRow({...m,due:'2027-01-05'},{at:fri('10:00')})).facts.content,'陈帆 · 项目群、大群 · 期限 2027-01-05','another year stays');
 assert.equal(readRow(matterRow({...m,due:'2026-11-06'},{at:fri('10:00')})).facts.content,'陈帆 · 项目群、大群 · 期限 11-06');
});

test('the matters that ended today are in a collapsed panel below a rule, title and reason in grey: those butler ended first, the latest first, at most ten',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const open=made(store,matters,{title:'还开着的事',t:fri('08:00')});
 const yesterday=made(store,matters,{title:'昨天结束的事',t:at(22,'09:00')});endByModel(matters,yesterday,'昨天办完了',at(22,'23:00'));
 const early=made(store,matters,{title:'一早结束的事',t:at(22,'09:00')});endByModel(matters,early,'半夜有人回了',fri('00:30'));
 const ended=[made(store,matters,{title:'已经解决的事',t:fri('09:00')}),made(store,matters,{title:'过时的事',t:fri('09:05')})];
 const mine=made(store,matters,{title:'我自己关掉的',t:fri('09:10')});
 endByModel(matters,ended[0],'对方说已经解决了',fri('09:40'));endByModel(matters,ended[1],'被新的消息取代',fri('09:45'));matters.close(mine,'不用管',fri('09:50'));
 const card=digestAt(matters,fri('10:00')),panel=panelOf(card),i=card.body.elements.indexOf(panel);
 assert.deepEqual(rowsOf(card).map(idOf),[open]);
 assert.equal(card.body.elements[i-1].tag,'hr','a rule above it');
 assert.equal(panel.expanded,false,'collapsed');assert.deepEqual(panel.header.title,{tag:'plain_text',content:'今天结束了 4 件'});
 assert.deepEqual([panel.header.icon.token,panel.header.icon_position,panel.header.icon_expanded_angle],['right-small-ccm_outlined','left',90],'▸ before the title, ▾ when open');
 assert.deepEqual(panel.elements.map(e=>[e.tag,e.text.text_color]),[['div','grey']]);
 assert.equal(textOf(panel.elements),['过时的事 — 被新的消息取代','已经解决的事 — 对方说已经解决了','一早结束的事 — 半夜有人回了','我自己关掉的 — 你关掉的：不用管'].join('\n'),
  'since midnight, whenever the last digest went out; not yesterday\'s');
 assert.equal(card.header.template,'blue','nothing urgent');assert.equal(card.config.summary.content,'共 1 件待办');
 let n=0;const make=k=>[...Array(k)].map(()=>made(store,matters,{title:`事项${++n}`,t:fri('10:00')+n*60e3}));
 const byModel=make(12),closedByMe=make(2);
 byModel.forEach((id,i)=>endByModel(matters,id,`原因${i}`,fri('11:00')+i*60e3));closedByMe.forEach((id,i)=>matters.close(id,undefined,fri('11:30')+i*60e3));
 const lines=textOf(panelOf(digestAt(matters,fri('12:00'))).elements).split('\n');
 assert.deepEqual(lines,[...[...byModel].reverse().slice(0,10).map(id=>`${matters.matter(id).title} — ${matters.matter(id).reason}`),'另有 8 件也结束了，没有列出']);
});

test('nothing open: one short line; the update time carries the date once the day has changed',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const id=made(store,matters,{title:'办完的事',urgency:'high',t:fri('09:00')});endByModel(matters,id,'办完了',fri('09:30'));
 const card=digestAt(matters,fri('10:00'));
 assert.equal(card.header.template,'blue');assert.equal(card.header.text_tag_list,undefined);assert.equal(card.config.summary.content,'现在没有待办');
 assert.deepEqual(card.body.elements[0],{tag:'div',text:{tag:'plain_text',content:'现在没有要你处理的事。'}});
 assert.ok(panelOf(card),'what ended today is still listed');
 assert.equal(digestAt(matters,at(24,'09:05'),fri('20:00')).header.subtitle.content,'更新于 10-24 09:05','a card sent the day before');
 assert.equal(digestAt(matters,fri('20:30'),fri('20:00')).header.subtitle.content,'更新于 20:30');
});

test('text from the model, the chats and the people is shown as plain text: markdown carries only butler\'s dots and headings, links only butler\'s',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const id=made(store,matters,{title:'**加急** [点这里](https://evil.example/x) <text_tag color=\'red\'>假</text_tag>',who:'<at id=all></at>',ask:'看 `代码` 和 # 标题',
  due:'<font color=red>今天</font>',t:fri('09:00'),chat:'[链接](https://x.example)'});
 const gone=made(store,matters,{title:'[也是链接](https://evil.example/y)',t:fri('09:01')});endByModel(matters,gone,'**理由** <at id=all></at>',fri('09:30'));
 const all=[digestAt(matters,fri('10:00')),cards([heading('没结束的事项（1）'),...matters.list().map(m=>matterRow(m,{at:fri('10:00')}))],{summary:'管家的回复'})];
 const link=matters.matter(id).link;
 for(const c of componentsOf(all)){
  assert.notEqual(c.tag,'lark_md');
  if(c.tag==='markdown')assert.match(c.content,/^(?:<font color='(?:red|orange|grey)'>●<\/font>|\*\*[^*[\]<]+\*\*)$/,`butler's own markdown only: ${c.content}`);
 }
 const urls=JSON.stringify(all).match(/"(?:default_url|url)":"[^"]*"/g);
 assert.deepEqual([...new Set(urls)],[`"default_url":"${link}"`,`"url":"${link}"`],'the only links: butler\'s, to the matter\'s message');
 const text=all.map(card=>shown({card})).join('\n');
 for(const s of ['**加急** [点这里](https://evil.example/x)','<at id=all></at>','<font color=red>今天</font>','[链接](https://x.example)','**理由** <at id=all></at>'])
  assert.ok(text.includes(s),`still there, as text: ${s}`);
});

test('a digest is one card that always fits: at most ten open matters and fewer when they are long, the rest counted by urgency',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 for(let i=0;i<40;i++)made(store,matters,{title:`事项${i}`,ask:i%2?'短':'很长的说明'.repeat(40),urgency:['high','normal','low'][i%3],t:fri('09:00')+i*1000});
 const ended=[];for(let i=0;i<30;i++){const id=made(store,matters,{title:`结束的${i}`,t:fri('08:00')+i*1000});endByModel(matters,id,'理由'.repeat(50),fri('09:30'));ended.push(id);}
 const card=digestAt(matters,fri('10:00')),rows=rowsOf(card);
 assert.ok(size(card)<=CARD_BYTES,`${size(card)} bytes`);assert.ok(count(card)<=MAX_COMPONENTS,`${count(card)} components`);
 assert.equal(rows.length,10);
 const rest=card.body.elements.find(e=>e.tag==='div');
 assert.deepEqual(rest.text,{tag:'plain_text',content:'另有 30 件没有列出（4 件紧急、13 件一般、13 件不急），在私聊里说「现在有哪些事」可以看全部',text_size:'notation',text_color:'grey'});
 assert.ok(card.body.elements.indexOf(rest)>card.body.elements.findLastIndex(e=>e.tag==='column_set'),'after the listed ones');
 assert.match(textOf(panelOf(card).elements),/另有 20 件也结束了，没有列出$/);
 const long=new Matters(tempStore(t).store),s2=long.store;
 for(let i=0;i<20;i++)made(s2,long,{title:`很长的标题${i}`.repeat(6),who:'人'.repeat(60),due:'期'.repeat(40),urgency:'high',t:fri('09:00')+i*1000,chat:`${'很长的群名'.repeat(20)}${i}`});
 // Each matter's message in many chats, all named at length.
 for(const m of long.list())for(let k=0;k<8;k++){const id=post(s2,{chat:`${'另一个很长的群名'.repeat(12)}${m.id}-${k}`,at:fri('09:30')});long.apply({updated:[{matterId:m.id,messageIds:[id],changes:{}}],processedIds:[id]});}
 const big=digestAt(long,fri('10:00')),listed=rowsOf(big).length;
 assert.ok(size(big)<=CARD_BYTES,`${size(big)} bytes`);assert.ok(count(big)<=MAX_COMPONENTS,`${count(big)} components`);assert.ok(listed<10&&listed>1,`${listed} listed`);
 assert.match(textOf(big),new RegExp(`另有 ${20-listed} 件没有列出（${20-listed} 件紧急）`));
});

test('the conversation\'s list of every open matter uses the same rows, split into cards that each fit',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const ids=[];for(let i=0;i<60;i++)ids.push(made(store,matters,{title:`事项${i}`,ask:'很长的说明'.repeat(30),t:fri('09:00')+i*1000}));
 const split=cards([heading('没结束的事项（60）'),...matters.list().map(m=>matterRow(m,{at:fri('10:00')}))],{summary:'管家的回复'});
 assert.ok(split.length>1);
 for(const c of split){assert.ok(size(c)<=CARD_BYTES,`${size(c)} bytes`);assert.ok(count(c)<=MAX_COMPONENTS,`${count(c)} components`);}
 assert.deepEqual(split.flatMap(rowsOf).map(idOf).sort((a,b)=>a-b),ids,'each once');
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
 assert.deepEqual(rowsOf(lastCard(bot)).map(idOf),[b,c,a],'all that is open');
 assert.deepEqual(store.meta('digest'),{at:fri('11:00'),slot:fri('11:00'),sent:2,messageId:'om2'});
 assert.equal(await tickAt(fri('12:00')),'','nothing new and nothing ended: no digest');
 assert.equal(store.meta('digest').at,fri('11:00'));
 endByModel(matters,a,'对方说不用了',fri('12:10'));matters.close(b,undefined,fri('12:20'));
 out=await tickAt(fri('13:00'));
 assert.match(textOf(panelOf(lastCard(bot))),/早上的事 — 对方说不用了/);assert.match(textOf(panelOf(lastCard(bot))),/早上的急事 — 你关掉的/);
 assert.deepEqual(rowsOf(lastCard(bot)).map(idOf),[c]);
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
 assert.deepEqual(rowsOf(card).map(idOf),[b,c],'what is open now');
 assert.equal(textOf(panelOf(card).elements),'早上的事 — 对方说不用了','what ended today');
 assert.equal(store.meta('digest').messageId,'om2');
 matters.close(b,undefined,fri('11:25'));clock.t=fri('11:30');await digests.refresh();
 assert.deepEqual(bot.log,['update om2','update om2']);
 const later=bot.updated[1].card;
 assert.equal(later.header.template,'blue');assert.deepEqual(rowsOf(later).map(idOf),[c]);assert.match(textOf(panelOf(later)),/十点的急事 — 你关掉的/);
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
