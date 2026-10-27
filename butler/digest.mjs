// The digest: what it reports and how it reads, and the sender that checks every minute whether one is due (see
// schedule.mjs) and sends it to my direct chat with the bot. A digest has three parts: the matters new since the last
// digest in full, most urgent first, each with its number and a link to its first message; of the others still open
// the urgent ones, one line each, and how many the rest are by urgency; and of the matters that ended since the last
// digest at most five with the reason, and how many more did. Matters I closed myself in the conversation are listed
// among the ended ones after those butler ended, but are no reason to send a digest: I know of them already.
import {decide,nextDigest} from './schedule.mjs';
import {plain,heading,link,rule,lines,cards} from './cards.mjs';
export {CARD_BYTES} from './cards.mjs';

export const URGENCY={high:'紧急',normal:'一般',low:'不急'};
const time=ms=>new Date(ms).toLocaleString('sv-SE').slice(5,16);
export const endReason=m=>m.closedBy==='owner'?`在私聊里关掉${m.reason?`：${m.reason}`:''}`:m.reason??'';

// What a digest after the one sent at since reports; since undefined: there has been none, so everything open is new.
export function digestOf(matters,since){
 const open=matters.list(),fresh=open.filter(m=>since===undefined||m.openedAt>since);
 return {fresh,open:open.filter(m=>!fresh.includes(m)),ended:matters.closedSince(since)};
}
// How much of it is news: what decides whether a digest goes out.
const news=d=>({fresh:d.fresh.length,ended:d.ended.filter(m=>m.closedBy!=='owner').length});

const label=m=>`#${m.id} [${URGENCY[m.urgency]??m.urgency}] ${m.title}`;
// Matters in full, each followed by its link: the new part of a digest, and the list the conversation shows.
export function matterElements(list){
 return list.flatMap(m=>[plain([label(m),`${m.who}：${m.ask}`,...m.due?[`期限：${m.due}`]:[],`${m.chats.join('、')} · ${time(m.since)} 起`].join('\n')),
  ...m.link?[link('打开原消息',m.link)]:[]]);
}
export const briefElements=list=>lines(list.map(label));
// The open matters a digest does not list, counted by urgency in one line.
const counted=list=>`另有 ${[...Map.groupBy(list,m=>m.urgency)].map(([u,ms])=>`${ms.length} 个${URGENCY[u]??u}`).join('、')}的没有列出，在私聊里说「现在有哪些事」可以看全部`;
// The ended matters a digest lists: those butler ended before those I closed myself, which I know of already; the
// latest to end first.
const ENDED_LISTED=5;
const listedEnded=ended=>[...ended].sort((a,b)=>(a.closedBy==='owner')-(b.closedBy==='owner')||b.closedAt-a.closedAt||b.id-a.id).slice(0,ENDED_LISTED);

export function digestCards({at,fresh,open,ended}){
 const parts=[];
 if(fresh.length)parts.push([heading(`新事项（${fresh.length}）`),...matterElements(fresh)]);
 const urgent=open.filter(m=>m.urgency==='high'),rest=open.filter(m=>m.urgency!=='high'),listed=listedEnded(ended);
 if(open.length)parts.push([heading(`仍未结束（${open.length}）`),...briefElements(urgent),...rest.length?[plain(counted(rest))]:[]]);
 if(ended.length)parts.push([heading(`上次以来结束（${ended.length}）`),...lines([...listed.map(m=>`#${m.id} ${m.title}\n  ${endReason(m)}`),
  ...ended.length>listed.length?[`另有 ${ended.length-listed.length} 个也结束了，没有列出`]:[]])]);
 return cards(parts.flatMap((p,i)=>i?[rule(),...p]:p),{title:`管家汇总 · ${time(at)}`,
  summary:`新事项 ${fresh.length} 个 · 仍未结束 ${open.length} 个 · 已结束 ${ended.length} 个`});
}

// The digest state in the store (meta digest: {at, slot, sent, failedAt}) with what the next digest would report
// and when it would go out. The command line's status reads it from another process.
export function digestStatus({store,matters,schedule,now=Date.now()}){
 const last=store.meta('digest')??{},n=news(digestOf(matters,last.at));
 return {...last,...n,next:nextDigest({now,last,...n,schedule})};
}

export class Digests{
 #timer;#busy;
 // bot: {connected, toOwner(input)}; now: the clock; retryMs: how long after a failed send to try again.
 constructor({store,matters,bot,schedule,now=Date.now,retryMs=300_000,everyMs=60_000}){
  Object.assign(this,{store,matters,bot,schedule,now,retryMs,everyMs});
 }
 start(){this.#timer=setInterval(()=>this.tick(),this.everyMs);this.tick();}
 async stop(){clearInterval(this.#timer);await this.#busy;}
 status(){return digestStatus({store:this.store,matters:this.matters,schedule:this.schedule,now:this.now()});}
 // Sends the digest if one is due. Ticks never overlap: a call during one joins it.
 tick(){this.#busy??=this.#tick().finally(()=>{this.#busy=undefined;});return this.#busy;}
 async #tick(){
  // Offline, nothing is due yet: a slot stays open until the bot is back, within its hour.
  if(!this.bot.connected)return;
  const now=this.now(),last=this.store.meta('digest')??{};
  if(now-last.failedAt<this.retryMs)return;
  const d=digestOf(this.matters,last.at),r=decide({now,last,...news(d),schedule:this.schedule});
  if(!r.send){if(r.slot!==undefined)this.store.setMeta('digest',{...last,slot:r.slot});return;}
  try{for(const card of digestCards({at:now,...d}))await this.bot.toOwner({card});}
  catch(e){
   this.store.addError('汇总',`汇总没有发出去，${Math.round(this.retryMs/60e3)} 分钟后再试：${e?.message??e}`);
   this.store.setMeta('digest',{...last,failedAt:now});return;
  }
  const {failedAt,...rest}=last;
  this.store.setMeta('digest',{...rest,at:now,...r.slot!==undefined&&{slot:r.slot},sent:(last.sent??0)+1});
 }
}
