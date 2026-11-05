// The digest: one card in my direct chat with the bot, 管家待办, and the sender that checks every minute whether one is
// due (see schedule.mjs), sends it, and keeps the latest one current in place. A digest lists the open matters, the
// most urgent first, one compact block each, marking those new since the digest before it; the matters that ended
// since then are folded away in a panel, with the reason. Matters I closed myself in the conversation are listed among
// the ended ones after those butler ended, but are no reason to send a digest: I know of them already.
import {decide,nextDigest} from './schedule.mjs';
import {plain,link,lines,tags,fits} from './cards.mjs';
export {CARD_BYTES} from './cards.mjs';

export const URGENCY={high:'紧急',normal:'一般',low:'不急'};
const TAG_COLOR={high:'red',normal:'orange',low:'neutral'},RANK={high:0,normal:1,low:2};
const time=ms=>new Date(ms).toLocaleString('sv-SE').slice(5,16),day=ms=>new Date(ms).toDateString();
export const endReason=m=>m.closedBy==='owner'?`在私聊里关掉${m.reason?`：${m.reason}`:''}`:m.reason??'';
// Feishu updates a message only within 14 days of sending it; an hour less leaves room for the clocks.
const UPDATABLE_MS=14*86400e3-3600e3;

// Open matters in the order a digest lists them: the most urgent first, and within one urgency the one that started
// first.
export const ordered=list=>[...list].sort((a,b)=>(RANK[a.urgency]??1)-(RANK[b.urgency]??1)||a.since-b.since||a.id-b.id);
// What a digest after the one sent at since reports: every open matter, those of them opened after since (all, when
// since is undefined: there has been none), and the matters that ended after since.
export function digestOf(matters,since){
 const open=ordered(matters.list());
 return {open,fresh:open.filter(m=>since===undefined||m.openedAt>since),ended:matters.closedSince(since)};
}
// How much of it is news: what decides whether a digest goes out.
const news=d=>({fresh:d.fresh.length,ended:d.ended.filter(m=>m.closedBy!=='owner').length});

// One open matter: its urgency (and 新 when it is fresh) as tags, its title, a grey line of facts (its number, which
// the conversation goes by, who, where, since when, the due date), what it asks of me, and a link to its first
// message. The digest's blocks and the conversation's list of matters.
export function matterBlock(m,{fresh=false}={}){
 const labels=[...URGENCY[m.urgency]?[[URGENCY[m.urgency],TAG_COLOR[m.urgency]]]:[],...fresh?[['新','blue']]:[]];
 const facts=[`#${m.id}`,m.who,m.chats.join('、'),`${time(m.since)} 起`,...m.due?[`期限 ${m.due}`]:[]].filter(Boolean).join(' · ');
 return {tag:'column_set',columns:[
  ...labels.length?[{tag:'column',width:'auto',elements:[tags(labels)]}]:[],
  {tag:'column',width:'weighted',weight:1,vertical_spacing:'4px',
   elements:[plain(m.title,{text_size:'heading'}),plain(facts,{text_size:'notation',text_color:'grey'}),...m.ask?[plain(m.ask)]:[]]},
  ...m.link?[{tag:'column',width:'auto',elements:[link('打开',m.link)]}]:[]]};
}
// The open matters a digest does not list, counted by urgency in one line.
const counted=rest=>`另有 ${rest.length} 件没有列出（${[...Map.groupBy(rest,m=>m.urgency)].map(([u,ms])=>`${ms.length} 件${URGENCY[u]??u}`).join('、')}），在私聊里说「现在有哪些事」可以看全部`;
// The ended matters a digest lists: those butler ended before those I closed myself, which I know of already; the
// latest to end first.
const OPEN_LISTED=15,ENDED_LISTED=10;
const listedEnded=ended=>[...ended].sort((a,b)=>(a.closedBy==='owner')-(b.closedBy==='owner')||b.closedAt-a.closedAt||b.id-a.id).slice(0,ENDED_LISTED);
function endedPanel(ended){
 const listed=listedEnded(ended),reason=m=>endReason(m);
 return {tag:'collapsible_panel',expanded:false,
  header:{title:{tag:'plain_text',content:`上次汇总以来结束了 ${ended.length} 件`},icon:{tag:'standard_icon',token:'down-small-ccm_outlined',size:'16px 16px'},
   icon_position:'right',icon_expanded_angle:-180},
  border:{color:'grey',corner_radius:'5px'},
  elements:lines([...listed.map(m=>`#${m.id} ${m.title}${reason(m)?` — ${reason(m)}`:''}`),...ended.length>listed.length?[`另有 ${ended.length-listed.length} 件也结束了，没有列出`]:[]],
   {text_color:'grey'})};
}

// The digest card, as of at: a digest sent at sentAt (at itself for a new one) with what digestOf reports. The header
// is red while something urgent is open; the update time carries the date once it is no longer the day it was sent.
// At most fifteen open matters are listed, fewer when that is what fits one card.
export function digestCard({at,sentAt=at,open,fresh,ended}){
 const isNew=new Set(fresh.map(m=>m.id)),high=open.filter(m=>m.urgency==='high').length;
 const make=n=>({schema:'2.0',
  config:{update_multi:true,summary:{content:open.length?`${high?`${high} 件紧急 · `:''}共 ${open.length} 件待办`:'现在没有待办'}},
  header:{title:{tag:'plain_text',content:'管家待办'},subtitle:{tag:'plain_text',content:`更新于 ${day(at)===day(sentAt)?time(at).slice(6):time(at)}`},template:high?'red':'blue'},
  body:{vertical_spacing:'12px',elements:[
   ...open.length?open.slice(0,n).map(m=>matterBlock(m,{fresh:isNew.has(m.id)})):[plain('现在没有要你处理的事。')],
   ...open.length>n?[plain(counted(open.slice(n)),{text_size:'notation',text_color:'grey'})]:[],
   ...ended.length?[endedPanel(ended)]:[]]}});
 for(let n=Math.min(open.length,OPEN_LISTED);;n--){const card=make(n);if(n===0||fits(card))return card;}
}
// What an earlier digest turns into once a newer one is sent, so that it shows no todos that are out of date.
export const supersededCard=()=>({schema:'2.0',config:{update_multi:true,summary:{content:'这份待办已经过时'}},
 header:{title:{tag:'plain_text',content:'管家待办（已过时）'},template:'grey'},body:{elements:[plain('有一份更新的待办在下面，这份不再更新。')]}});

// The digest state in the store (meta digest: {at, slot, sent, failedAt, messageId, previousAt}: when the latest digest
// went out, the last slot handled, how many have gone out, when a send last failed, the latest digest's message and
// when the digest before it went out) with what the next digest would report and when it would go out. The command
// line's status reads it from another process.
export function digestStatus({store,matters,schedule,now=Date.now()}){
 const last=store.meta('digest')??{},n=news(digestOf(matters,last.at));
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
  const d=digestOf(this.matters,last.at),r=decide({now,last,...news(d),schedule:this.schedule});
  if(!r.send){if(r.slot!==undefined)this.store.setMeta('digest',{...last,slot:r.slot});return;}
  let sent;
  try{sent=await this.bot.toOwner({card:digestCard({at:now,...d})});}
  catch(e){
   this.store.addError('汇总',`汇总没有发出去，${Math.round(this.retryMs/60e3)} 分钟后再试：${e?.message??e}`);
   this.store.setMeta('digest',{...last,failedAt:now});return;
  }
  const {failedAt,messageId,previousAt,...rest}=last;
  this.store.setMeta('digest',{...rest,at:now,...r.slot!==undefined&&{slot:r.slot},sent:(last.sent??0)+1,messageId:sent?.messageId,previousAt:last.at});
  if(messageId&&now-last.at<UPDATABLE_MS)await this.#update(messageId,supersededCard(),'上一份汇总');
 }
 async #refresh(){
  const last=this.store.meta('digest')??{},now=this.now();
  if(this.#stopped||!this.bot.connected||!last.messageId||!(now-last.at<UPDATABLE_MS))return;
  await this.#update(last.messageId,digestCard({at:now,sentAt:last.at,...digestOf(this.matters,last.previousAt)}),'汇总');
 }
 async #update(messageId,card,what){
  try{await this.bot.updateCard(messageId,card);}catch(e){this.store.addError('汇总',`${what}的卡片没有更新：${e?.message??e}`);}
 }
}
