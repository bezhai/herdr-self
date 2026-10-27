import test from 'node:test';
import assert from 'node:assert/strict';
import {tempStore,post} from './helpers.mjs';
import {shown} from './fake-channel.mjs';
import {Matters} from '../matters.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {digestOf,digestCards,matterElements,Digests,CARD_BYTES} from '../digest.mjs';

process.env.TZ='Asia/Shanghai';
const at=(day,hm)=>Date.parse(`2026-10-${day}T${hm}:00+08:00`),fri=hm=>at(23,hm);

// A matter as the processor would have made it at time t from one message of chat.
function made(store,matters,{title,urgency='normal',who='陈帆',ask=`处理：${title}`,due=null,t,chat='g1'}){
 const id=post(store,{chat,text:title,at:t-60e3});
 return matters.apply({created:[{title,who,ask,due,urgency,messageIds:[id]}],processedIds:[id],now:t})[0];
}
const endByModel=(matters,id,reason,t)=>matters.apply({updated:[{matterId:id,messageIds:[],changes:{},close:reason}],now:t});
const size=card=>Buffer.byteLength(JSON.stringify(JSON.stringify(card)));
const elements=cards=>cards.flatMap(c=>c.body.elements);

test('a digest has three parts: new matters by urgency in full with their links, the urgent ones still open briefly and the others counted, and those ended with the reason',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const old=made(store,matters,{title:'老事项',t:fri('09:00')}),older=made(store,matters,{title:'更老的紧急事项',urgency:'high',t:fri('08:50')});
 const ended=made(store,matters,{title:'已经解决的事',t:fri('09:10')});
 const last=fri('09:30');
 const low=made(store,matters,{title:'知道就行的事',urgency:'low',t:fri('09:40')});
 const high=made(store,matters,{title:'今天要批的权限',urgency:'high',who:'黄凯熙',ask:'给黄凯熙加权限',due:'2026-10-23 18:00',t:fri('09:50'),chat:'g2'});
 endByModel(matters,ended,'对方说已经解决了',fri('09:45'));
 const mine=made(store,matters,{title:'我在私聊里关掉的',t:fri('09:52')});matters.close(mine,'不用管',fri('09:58'));
 const d=digestOf(matters,last);
 assert.deepEqual(d.fresh.map(m=>m.id),[high,low],'new since the last digest, most urgent first');
 assert.deepEqual(d.open.map(m=>m.id),[older,old],'still open from before');
 assert.deepEqual(d.ended.map(m=>m.id),[ended,mine],'ended since the last digest');
 const cards=digestCards({at:fri('10:00'),...d});
 assert.equal(cards.length,1);
 const text=shown({card:cards[0]});
 assert.match(cards[0].header.title.content,/汇总.*10-23 10:00/);
 assert.equal(cards[0].config.summary.content,'新事项 2 个 · 仍未结束 2 个 · 已结束 2 个');
 const pos=s=>{const i=text.indexOf(s);assert.ok(i>=0,`in the digest: ${s}`);return i;};
 assert.ok(pos(`#${high} [紧急] 今天要批的权限`)<pos(`#${low} [不急] 知道就行的事`),'by urgency');
 pos('黄凯熙：给黄凯熙加权限');pos('2026-10-23 18:00');pos('大群');
 assert.ok(pos(`#${low}`)<pos(`#${older} [紧急] 更老的紧急事项`),'the new part comes first, then the urgent ones still open');
 assert.doesNotMatch(text,/处理：更老的紧急事项/,'still open ones are listed briefly');
 assert.ok(!text.includes(`#${old} `)&&pos(`#${older}`)<pos('另有 1 个一般的没有列出'),'the others still open are only counted');
 assert.ok(pos('另有 1 个一般的')<pos(`#${ended} 已经解决的事`)&&pos(`#${ended}`)<pos(`#${mine} 我在私聊里关掉的`));pos('对方说已经解决了');pos('不用管');
 assert.doesNotMatch(text,/也结束了/,'every ended one is listed');
 const links=elements(cards).filter(e=>e.tag==='markdown'&&e.content.includes('http'));
 assert.deepEqual(links.map(e=>e.content),[high,low].map(id=>`[打开原消息](${matters.matter(id).link})`),'a link per new matter, made by butler');
});

test('a long digest lists only the urgent matters still open and counts the others, and at most five that ended: those butler ended first, the latest first',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 let n=0;const make=(urgency,k)=>[...Array(k)].map(()=>made(store,matters,{title:`事项${++n}`,urgency,t:fri('08:00')+n*60e3}));
 const high=make('high',3),normal=make('normal',4),low=make('low',2),byModel=make('normal',6),mine=make('low',2);
 byModel.forEach((id,i)=>endByModel(matters,id,`原因${i}`,fri('09:40')+i*60e3));
 mine.forEach((id,i)=>matters.close(id,undefined,fri('09:50')+i*60e3));
 const cards=digestCards({at:fri('10:00'),...digestOf(matters,fri('09:30'))}),text=shown({card:cards[0]});
 assert.equal(cards.length,1);
 assert.equal(cards[0].config.summary.content,'新事项 0 个 · 仍未结束 9 个 · 已结束 8 个','the summary counts them all');
 const pos=s=>{const i=text.indexOf(s);assert.ok(i>=0,`in the digest: ${s}`);return i;};
 for(const id of high)assert.ok(pos('仍未结束（9）')<pos(`#${id} [紧急]`));
 for(const id of [...normal,...low])assert.ok(!text.includes(`#${id} `),`#${id} is only counted`);
 assert.ok(pos(`#${high.at(-1)}`)<pos('另有 4 个一般、2 个不急的没有列出'));pos('现在有哪些事');
 // The latest five butler ended, the latest first; the two I closed myself even later are left out.
 [...byModel].reverse().slice(0,5).reduce((p,id)=>{const i=pos(`#${id} `);assert.ok(p<i,`#${id} in order`);return i;},pos('上次以来结束（8）'));
 for(const id of [byModel[0],...mine])assert.ok(!text.includes(`#${id} `),`#${id} is only counted`);
 assert.ok(pos(`#${byModel[1]} `)<pos('另有 3 个也结束了，没有列出'));
 const digest=(fresh,open)=>shown({card:digestCards({at:fri('10:00'),fresh:fresh.map(id=>matters.matter(id)),open:open.map(id=>matters.matter(id)),ended:[]})[0]});
 assert.match(digest([],low),/\*\*仍未结束（2）\*\*\n另有 2 个不急的没有列出[^\n]*$/,'no urgent ones: the part has just the count, of the urgencies there are');
 assert.doesNotMatch(digest([],high),/另有/,'only urgent ones: nothing to count');
 assert.doesNotMatch(digest(high,[]),/仍未结束/,'nothing else open: no part');
});

test('text from the model and the chats is shown as plain text: only butler writes markdown, and only links come from butler',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const id=made(store,matters,{title:'**加急** [点这里](https://evil.example/x)',who:'<at id=all></at>',ask:'看 `代码` 和 # 标题',t:fri('09:00'),chat:'[链接](https://x.example)'});
 const cards=[...digestCards({at:fri('10:00'),...digestOf(matters,undefined)}),{body:{elements:matterElements(matters.list())}}];
 for(const e of elements(cards)){
  if(e.tag==='div'){assert.equal(e.text.tag,'plain_text');continue;}
  if(e.tag!=='markdown')continue;
  // A parenthesis in butler's link (here from the odd chat id) would end the markdown link, so it is escaped.
  const safe=matters.matter(id).link.replaceAll('(','%28').replaceAll(')','%29');
  assert.ok(/^\*\*[^*\[\]]+\*\*$/.test(e.content)||e.content===`[打开原消息](${safe})`,`butler's own markdown only: ${e.content}`);
 }
 assert.ok(elements(cards).some(e=>e.tag==='div'&&e.text.content.includes('**加急** [点这里](https://evil.example/x)')),'the text itself is still there, as text');
});

test('a big digest is split into cards that each fit in one Feishu message, numbered on',t=>{
 const {store}=tempStore(t),matters=new Matters(store);
 const ids=[];for(let i=0;i<60;i++)ids.push(made(store,matters,{title:`事项${i}`,ask:'很长的说明'.repeat(80),urgency:['high','normal','low'][i%3],t:fri('09:00')+i*1000}));
 const cards=digestCards({at:fri('10:00'),...digestOf(matters,undefined)});
 assert.ok(cards.length>1);
 for(const c of cards){assert.ok(size(c)<=CARD_BYTES,`${size(c)} bytes`);assert.ok(c.body.elements.length<=100);}
 assert.deepEqual(cards.map(c=>c.header.title.content.match(/（(\d+)\/(\d+)）/).slice(1).map(Number)),cards.map((c,i)=>[i+1,cards.length]));
 const text=cards.map(c=>shown({card:c})).join('\n');
 for(const id of ids)assert.equal(text.split(`#${id} [`).length-1,1,`#${id} once`);
});

// A bot that records what it sends to the owner, and can be made to fail or go offline.
function fakeBot(){return {connected:true,fail:0,sent:[],async toOwner(input){if(this.fail>0){this.fail-=1;throw Error('飞书接口错误 99991663：token invalid');}this.sent.push(input);return {messageId:`om${this.sent.length}`};}};}
function setup(t,{schedule=DEFAULT_SCHEDULE,start}={}){
 const {store}=tempStore(t),matters=new Matters(store),bot=fakeBot(),clock={t:start};
 const digests=new Digests({store,matters,bot,schedule,now:()=>clock.t,retryMs:300e3});
 return {store,matters,bot,clock,digests,sent:()=>bot.sent.map(shown).join('\n=====\n'),
  async tickAt(when){clock.t=when;const before=bot.sent.length;await digests.tick();return bot.sent.slice(before).map(shown).join('\n');}};
}

test('the digest goes out hourly in working time with what changed, and not at all when nothing did',async t=>{
 const {store,matters,tickAt,digests}=setup(t);
 const a=made(store,matters,{title:'早上的事',urgency:'low',t:fri('09:00')}),b=made(store,matters,{title:'早上的急事',urgency:'high',t:fri('09:30')});
 let out=await tickAt(fri('10:00'));
 assert.match(out,/新事项/);assert.ok(out.indexOf(`#${b}`)<out.indexOf(`#${a}`));
 assert.deepEqual(store.meta('digest'),{at:fri('10:00'),slot:fri('10:00'),sent:1});
 const c=made(store,matters,{title:'十点半的事',t:fri('10:30')});
 assert.equal(await tickAt(fri('10:31')),'','one digest per hour');
 out=await tickAt(fri('11:00'));
 assert.match(out,new RegExp(`#${c} \\[一般\\] 十点半的事`));assert.match(out,/仍未结束/);assert.doesNotMatch(out,/处理：早上的事/,'the earlier ones only briefly');
 assert.equal(await tickAt(fri('12:00')),'','nothing new and nothing ended: no digest');
 assert.equal(store.meta('digest').at,fri('11:00'));
 endByModel(matters,a,'对方说不用了',fri('12:10'));matters.close(b,undefined,fri('12:20'));
 out=await tickAt(fri('13:00'));
 assert.match(out,/结束/);assert.match(out,/对方说不用了/);assert.match(out,new RegExp(`#${b} 早上的急事`));assert.doesNotMatch(out,/新事项/);
 matters.close(c,'处理完了',fri('13:20'));
 assert.equal(await tickAt(fri('14:00')),'','closing a matter in the conversation alone is no reason for a digest');
 assert.equal(digests.status().next,undefined);
});

test('outside working time a digest waits for three new matters and two hours since the last one',async t=>{
 const {store,matters,tickAt,digests}=setup(t);
 made(store,matters,{title:'下班前的事',t:fri('19:30')});
 assert.notEqual(await tickAt(fri('20:00')),'');
 for(const [i,hm] of [[1,'20:10'],[2,'20:20'],[3,'21:00']])made(store,matters,{title:`晚上的事${i}`,t:fri(hm)});
 assert.equal(await tickAt(fri('21:30')),'','three new, but too soon');
 assert.equal(digests.status().next,fri('22:00'));
 const out=await tickAt(fri('22:00'));
 for(let i=1;i<=3;i++)assert.match(out,new RegExp(`晚上的事${i}`));
 made(store,matters,{title:'半夜的事',t:fri('23:00')});
 assert.equal(await tickAt(at(24,'12:00')),'','one new matter waits');
 assert.equal(digests.status().next,at(26,'10:00'),'until Monday morning');
 assert.match(await tickAt(at(26,'10:00')),/半夜的事/);
});

test('a digest that could not be sent is tried again a few minutes later, and none goes out while the bot is offline',async t=>{
 const {store,matters,bot,tickAt}=setup(t);
 made(store,matters,{title:'要汇总的事',t:fri('09:00')});
 bot.connected=false;
 assert.equal(await tickAt(fri('10:00')),'');assert.equal(store.meta('digest'),undefined,'offline: the slot stays open');
 bot.connected=true;bot.fail=1;
 assert.equal(await tickAt(fri('10:01')),'');
 assert.ok(store.errors().some(e=>e.source==='汇总'&&/token invalid/.test(e.message)));
 assert.equal(await tickAt(fri('10:03')),'','not again right away');
 assert.match(await tickAt(fri('10:06')),/要汇总的事/);
 assert.equal(store.meta('digest').at,fri('10:06'));
});
