// The todo card: the digest, one card in my direct chat with the bot, 管家待办, and the sender that checks every
// minute whether one is due (see schedule.mjs), sends it, and keeps the latest one current in place. A digest lists
// the open matters, the most urgent first, one row each; the matters that ended today are folded away in a panel, with
// the reason. Matters I closed myself are listed among the ended ones after those butler ended, but are no reason to
// send a digest: I know of them already. A row's buttons close its matter, as done or as not mine (see Digests.click).
import {decide,nextDigest} from './schedule.mjs';
import {plain,dot,lines,panel,fits,AGENT_GROUP} from './cards.mjs';
import {NOT_MINE} from './matters.mjs';
export {CARD_BYTES} from './cards.mjs';

export const URGENCY={high:'紧急',normal:'一般',low:'不急'};
const DOT={high:'red',normal:'orange',low:'grey'},RANK={high:0,normal:1,low:2};
const time=ms=>new Date(ms).toLocaleString('sv-SE').slice(5,16),day=ms=>new Date(ms).toDateString();
const midnight=ms=>new Date(ms).setHours(0,0,0,0);
export const endReason=m=>m.closedBy==='owner'?`你关掉的${m.reason?`：${m.reason}`:''}`:m.reason??'';
// Feishu updates a message only within 14 days of sending it; an hour less leaves room for the clocks.
const UPDATABLE_MS=14*86400e3-3600e3;
// What a click on a row's buttons does: the reason the matter is closed with, and the toast that says so.
const ACTS={done:{reason:'完成',toast:'已完成'},not_mine:{reason:NOT_MINE,toast:'已标记为不归你，之后判断时会参考'}};

// Open matters in the order a digest lists them: the most urgent first, and within one urgency the one that started
// first.
export const ordered=list=>[...list].sort((a,b)=>(RANK[a.urgency]??1)-(RANK[b.urgency]??1)||a.since-b.since||a.id-b.id);
// What a digest card made at at shows: every open matter, and the matters that ended since midnight.
export const todoOf=(matters,at)=>({open:ordered(matters.list()),ended:matters.closedSince(midnight(at))});
// How much news there is since the digest sent at since (none sent yet when it is undefined): the open matters opened
// after it, and the matters butler ended after it. It decides whether a digest goes out.
function news(matters,since){
 return {fresh:matters.list().filter(m=>since===undefined||m.openedAt>since).length,ended:matters.closedSince(since).filter(m=>m.closedBy!=='owner').length};
}

// One open matter in a row, as a card made at at shows it: a dot in its urgency's color, its title and, in grey, who
// asks, in which chats and the due date or else when it started, which open its first message when clicked; then
// 完成, and ⋯ with 不归我 and 打开原消息. The buttons send back their action, the matter, what on says of their card
// (which card it is, see Digests.click) and when the card was made: the SDK drops a click it has seen on a message for
// 12 hours, by its value, so a card made again has buttons of its own.
export function matterRow(m,{at,on={}}){
 const when=day(m.since)===day(at)?`今天 ${time(m.since).slice(6)}`:time(m.since);
 // A date the model wrote as YYYY-MM-DD (see prompt.mjs) goes without the year when it is this one.
 const year=`${new Date(at).getFullYear()}-`,due=m.due?.startsWith(year)?m.due.slice(year.length):m.due;
 const text=[plain(m.title),plain([m.who,m.chats.join('、'),due?`期限 ${due}`:when].filter(Boolean).join(' · '),{text_size:'notation',text_color:'grey'})];
 const option=(content,more)=>({text:{tag:'plain_text',content},...more}),value={matter:m.id,...on,t:at};
 return {tag:'column_set',horizontal_spacing:'8px',columns:[
  {tag:'column',width:'auto',elements:[dot(DOT[m.urgency]??DOT.normal)]},
  {tag:'column',width:'weighted',weight:1,vertical_spacing:'4px',
   elements:m.link?[{tag:'interactive_container',padding:'0px',vertical_spacing:'4px',behaviors:[{type:'open_url',default_url:m.link}],elements:text}]:text},
  {tag:'column',width:'auto',direction:'horizontal',horizontal_spacing:'4px',elements:[
   {tag:'button',type:'default',size:'small',text:{tag:'plain_text',content:'完成'},behaviors:[{type:'callback',value:{act:'done',...value}}]},
   {tag:'overflow',options:[option('不归我',{value:'not_mine'}),...m.link?[option('打开原消息',{multi_url:{url:m.link}})]:[]],
    behaviors:[{type:'callback',value}]}]}]};
}
// The open matters a digest does not list, counted by urgency in one line.
const counted=rest=>`另有 ${rest.length} 件没有列出（${[...Map.groupBy(rest,m=>m.urgency)].map(([u,ms])=>`${ms.length} 件${URGENCY[u]??u}`).join('、')}），到 ${AGENT_GROUP}里问管家可以看全部`;
// The ended matters a digest lists: those butler ended before those I closed myself, which I know of already; the
// latest to end first.
const OPEN_LISTED=10,ENDED_LISTED=10;
const listedEnded=ended=>[...ended].sort((a,b)=>(a.closedBy==='owner')-(b.closedBy==='owner')||b.closedAt-a.closedAt||b.id-a.id).slice(0,ENDED_LISTED);
function endedPanel(ended){
 const listed=listedEnded(ended),reason=m=>endReason(m);
 return panel(`今天结束了 ${ended.length} 件`,lines([...listed.map(m=>`${m.title}${reason(m)?` — ${reason(m)}`:''}`),
  ...ended.length>listed.length?[`另有 ${ended.length-listed.length} 件也结束了，没有列出`]:[]],{text_color:'grey'}));
}

// The digest card, as of at, with what todoOf reports: for a digest sent at sentAt (at itself for a new one). The
// header counts the urgent matters on its right, and is red while there are any; the update time carries the date
// once it is no longer the day it was sent. At most ten open matters are listed, fewer when that is what fits one card.
export function digestCard({at,sentAt=at,open,ended}){
 const high=open.filter(m=>m.urgency==='high').length;
 const make=n=>({schema:'2.0',
  config:{update_multi:true,summary:{content:open.length?`${high?`${high} 件紧急 · `:''}共 ${open.length} 件待办`:'现在没有待办'}},
  header:{title:{tag:'plain_text',content:'管家待办'},subtitle:{tag:'plain_text',content:`更新于 ${day(at)===day(sentAt)?time(at).slice(6):time(at)}`},
   ...high&&{text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:`${high} 件紧急`},color:'red'}]},template:high?'red':'blue'},
  body:{vertical_spacing:'16px',elements:[
   ...open.length?open.slice(0,n).map(m=>matterRow(m,{at,on:{card:'digest'}})):[plain('现在没有要你处理的事。')],
   ...open.length>n?[plain(counted(open.slice(n)),{text_size:'notation',text_color:'grey'})]:[],
   ...ended.length?[{tag:'hr'},endedPanel(ended)]:[]]}});
 for(let n=Math.min(open.length,OPEN_LISTED);;n--){const card=make(n);if(n===0||fits(card))return card;}
}
// What an earlier digest turns into once a newer one is sent, so that it shows no todos that are out of date.
export const supersededCard=()=>({schema:'2.0',config:{update_multi:true,summary:{content:'这份待办已经过时'}},
 header:{title:{tag:'plain_text',content:'管家待办（已过时）'},template:'grey'},body:{elements:[plain('有一份更新的待办在下面，这份不再更新。')]}});

// The digest state in the store (meta digest: {at, slot, sent, failedAt, messageId}: when the latest digest went out,
// the last slot handled, how many have gone out, when a send last failed and the latest digest's message) with what
// the next digest would report and when it would go out. The command line's status reads it from another process.
export function digestStatus({store,matters,schedule,now=Date.now()}){
 const last=store.meta('digest')??{},n=news(matters,last.at);
 return {...last,...n,next:nextDigest({now,last,...n,schedule})};
}

export class Digests{
 #timer;#ticking;#queue=Promise.resolve();#refreshing;#refreshTimer;#wake;#stopped=false;
 // bot: {connected, toOwner(input) → {messageId}, updateCard(messageId, card)}; now: the clock; retryMs: how long
 // after a failed send to try again; refreshDelayMs: how long refresh() gathers calls before it updates the card.
 constructor({store,matters,bot,schedule,now=Date.now,retryMs=300_000,everyMs=60_000,refreshDelayMs=3000}){
  Object.assign(this,{store,matters,bot,schedule,now,retryMs,everyMs,refreshDelayMs});
 }
 start(){this.#stopped=false;this.#timer=setInterval(()=>this.tick(),this.everyMs);this.tick();}
 async stop(){
  this.#stopped=true;clearInterval(this.#timer);clearTimeout(this.#refreshTimer);this.#wake?.();
  await this.#queue;
 }
 status(){return digestStatus({store:this.store,matters:this.matters,schedule:this.schedule,now:this.now()});}
 // Sends the digest if one is due. Ticks never overlap: a call during one joins it.
 tick(){this.#ticking??=this.#exclusive(()=>this.#tick()).finally(()=>{this.#ticking=undefined;});return this.#ticking;}
 // Brings the latest digest's card up to date with the matters as they are now, in place: called whenever they
 // change. Calls within refreshDelayMs of the first make one update. Resolves once it is done; never rejects: a
 // failure is recorded. Nothing happens while the bot is offline, before the first digest butler kept the message of,
 // or 14 days after it was sent, when Feishu no longer takes updates.
 refresh(){
  if(this.#stopped)return Promise.resolve();
  this.#refreshing??=new Promise(resolve=>{this.#wake=resolve;this.#refreshTimer=setTimeout(resolve,this.refreshDelayMs);})
   .then(()=>{this.#refreshing=undefined;this.#wake=undefined;return this.#exclusive(()=>this.#refresh());});
  return this.#refreshing;
 }
 // Sends and updates one at a time, so an update never races a send.
 #exclusive(fn){const run=this.#queue.then(fn);this.#queue=run.catch(()=>{});return run;}
 async #tick(){
  // Offline, nothing is due yet: a slot stays open until the bot is back, within its hour.
  if(this.#stopped||!this.bot.connected)return;
  const now=this.now(),last=this.store.meta('digest')??{};
  if(now-last.failedAt<this.retryMs)return;
  const r=decide({now,last,...news(this.matters,last.at),schedule:this.schedule});
  if(!r.send){if(r.slot!==undefined)this.store.setMeta('digest',{...last,slot:r.slot});return;}
  let sent;
  try{sent=await this.bot.toOwner({card:digestCard({at:now,...todoOf(this.matters,now)})});}
  catch(e){
   this.store.addError('汇总',`汇总没有发出去，${Math.round(this.retryMs/60e3)} 分钟后再试：${e?.message??e}`);
   this.store.setMeta('digest',{...last,failedAt:now});return;
  }
  // previousAt: when the digest before it went out, which earlier versions kept.
  const {failedAt,messageId,previousAt,...rest}=last;
  this.store.setMeta('digest',{...rest,at:now,...r.slot!==undefined&&{slot:r.slot},sent:(last.sent??0)+1,messageId:sent?.messageId});
  if(messageId&&now-last.at<UPDATABLE_MS)await this.#update(messageId,supersededCard(),'上一份汇总');
 }
 async #refresh(){
  const last=this.store.meta('digest')??{},now=this.now();
  if(this.#stopped||!this.bot.connected||!last.messageId||!(now-last.at<UPDATABLE_MS))return;
  await this.#update(last.messageId,digestCard({at:now,sentAt:last.at,...todoOf(this.matters,now)}),'汇总');
 }
 // A click on a row's button (a CardActionEvent of the SDK; the bot hands on only mine, see bot.mjs): 完成 closes the
 // matter as mine, as matters close on the command line does, and 不归我 closes it with that reason, which the model is
 // then shown as not mine (see Matters.notMine). Feishu wants an answer within 3 seconds: a toast, and the clicked card
 // made again as things are now, so that it changes at once; the latest digest follows (refresh). A matter that has
 // ended or is unknown changes nothing, and its card is made again all the same. Returns undefined, no answer, for a
 // click that is no action: 打开原消息 opens its link by itself.
 click({messageId,action}){
  const v=action?.value,name=action?.tag==='overflow'?action.option:v?.act,act=Object.hasOwn(ACTS,String(name))?ACTS[name]:undefined;
  if(!act||!v||typeof v!=='object')return undefined;
  const m=this.matters.matter(Number(v.matter)),now=this.now();
  let toast;
  if(!m)toast={type:'info',content:'没有这件事了'};
  else if(m.status!=='open')toast={type:'info',content:'这件事已经结束了'};
  else{this.matters.close(m.id,act.reason,now);this.refresh();toast={type:'success',content:act.toast};}
  const card=this.#clicked(messageId,v,now);
  return {toast,...card&&{card:{type:'raw',data:card}}};
 }
 // The digest a click came from, made again at now: the latest as it is now, an older one superseded. A click from a
 // card of another kind gets its toast alone.
 #clicked(messageId,v,now){
  if(v.card!=='digest')return undefined;
  const last=this.store.meta('digest')??{};
  return messageId===last.messageId?digestCard({at:now,sentAt:last.at,...todoOf(this.matters,now)}):supersededCard();
 }
 async #update(messageId,card,what){
  try{await this.bot.updateCard(messageId,card);}catch(e){this.store.addError('汇总',`${what}的卡片没有更新：${e?.message??e}`);}
 }
}
