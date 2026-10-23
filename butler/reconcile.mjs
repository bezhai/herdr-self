// Reconciliation: what makes butler complete. Events are only a wake-up (no cursor, no replay, nothing for what
// open-lark writes during gap repair, backfill or background thread syncs), so each cycle reads open-lark's store:
// - conversation lists, newest first down to a horizon, to find chats whose entry changed; those chats are read by
//   position from where butler stopped (all of them, since a reply to me in any group counts and Lark keeps no
//   history of replies to look up), and watched groups on every cycle. Topic groups are not read by position: open-lark
//   cannot be trusted with their message window (see syncChat), and what concerns me there is in topics I took part
//   in or @s me, which the next two cover;
// - the thread feed, for threads I took part in whose reply count changed;
// - the @me history search over a time window, for mentions in chats whose entry did not change;
// and fetches replies of threads whose root showed a grown reply count.
import {isHealthy} from './open-lark.mjs';

const PAGE=100;
// Positions read again before a cursor. A normal group's thread replies have position <= 0 and are mixed into a page
// by time from its first row on, so the first row must be no later than the last one read before.
const OVERLAP=3;
const MAX_THREAD_PAGES=5,MAX_LIST_PAGES=50,MAX_SEARCH_PAGES=40,MAX_PENDING_ATTEMPTS=20;
const message=e=>e?.message??String(e);

export class Reconciler{
 constructor({store,openLark,recorder,collectedSince,options}){Object.assign(this,{store,openLark,recorder,collectedSince,options});}

 // reasons: why this cycle runs. 'periodic' alone reads the thread feed and the @me history only when they are due;
 // any other reason (startup, events connected, sync back to live) reads them now.
 async cycle(reasons){
  const {store,options}=this,startedAt=Date.now(),errors=[],forced=reasons.some(r=>r!=='periodic');
  const due=(key,every)=>forced||!(Date.now()-(store.meta(key)??0)<every);
  const step=async(source,fn)=>{try{return await fn();}catch(e){errors.push(source);store.addError(source,message(e));return undefined;}};
  const previous=store.meta('reconcile')??{};
  store.setMeta('reconcile',{...previous,lastStartedAt:startedAt,lastReasons:reasons});
  const before=await step('同步状态',()=>this.checkSync());
  const finish=extra=>{
   const finishedAt=Date.now();
   store.setMeta('reconcile',{lastStartedAt:startedAt,lastFinishedAt:finishedAt,lastSuccessAt:errors.length?previous.lastSuccessAt:finishedAt,lastReasons:reasons,lastErrors:errors.length,...extra});
   return {errors,...extra};
  };
  // open-lark unreachable or broken: one error for the cycle rather than one per step.
  if(!before)return finish({chats:0,threads:0});
  const listed=await step('会话列表',()=>this.#scanConversations(this.#horizon('watermark.conversations')));
  const chats=await this.#syncChats(errors);
  let feedScanned;
  if(due('threadFeed.scannedAt',options.threadFeedEveryMs))feedScanned=await step('话题列表',()=>this.#scanThreadFeed(this.#horizon('watermark.threadFeed')));
  const threads=await this.fetchThreads(store.staleThreads(options.maxThreadsPerCycle),errors);
  if(due('mentions.sweptAt',options.mentionsEveryMs))await step('@我补扫',()=>this.#sweepMentions());
  await this.#retryPending(errors);
  // Last, so that chats first seen through threads or the @me history in this cycle are named in it too.
  await step('聊天信息',()=>this.fillChatInfo(store.chatsMissingInfo(20)));
  const after=await step('同步状态',()=>this.checkSync());
  // A watermark only moves when open-lark was live from start to end: while it polls or reconnects, chats change
  // with ranks older than this cycle, and the next healthy cycle has to list back to the last healthy point.
  if(isHealthy(before)&&isHealthy(after)){
   if(listed)store.setMeta('watermark.conversations',startedAt);
   if(feedScanned)store.setMeta('watermark.threadFeed',startedAt);
  }
  if(feedScanned)store.setMeta('threadFeed.scannedAt',startedAt);
  return finish({chats,threads});
 }
 #horizon(key){return (this.store.meta(key)??this.collectedSince)-this.options.slackMs;}
 async checkSync(){
  const s=await this.openLark.syncStatus();
  this.store.setMeta('sync',{state:s.state,mode:s.mode,checkedAt:Date.now()});return s;
 }

 // Lists p2p and group conversations (pinned first, then by rank, newest first) down to the horizon and marks the chats
 // whose entry (last message, rank, update time) differs from when butler last read them.
 async #scanConversations(horizon){
  for(const scope of ['p2p','group']){
   let cursor;
   for(let n=0;n<MAX_LIST_PAGES;n++){
    const page=await this.openLark.conversations({scope,limit:PAGE,cursor});let past=false;
    for(const c of page.items??[]){
     if(c.isDoc||(c.feedType!==undefined&&c.feedType!==1))continue;
     if(!c.onTopRankAt&&!(Date.parse(c.rankAt??'')>=horizon)){past=true;break;}
     this.store.upsertChatInfo(c);
     if(c.chatMode==='topic')continue;
     const signature=[c.preview?.messageId??'',c.rankAt??'',c.updatedAtMs??''].join('|');
     if(this.store.chat(c.feedId).signature!==signature)this.store.markDirty(c.feedId,signature);
    }
    if(past||!page.hasMore||!page.nextCursor)break;
    cursor=page.nextCursor;
   }
  }
  return true;
 }
 async #syncChats(errors){
  const ids=[...new Set([...this.store.dirtyChats(this.options.maxChatsPerCycle),...this.store.watches().map(w=>w.feedId)])];
  for(const feedId of ids){
   try{await this.syncChat(feedId);}
   catch(e){errors.push(feedId);this.store.addError(`聊天 ${this.store.chat(feedId)?.name||feedId}`,message(e));}
  }
  return ids.length;
 }
 // Reads one chat by position from its cursor, or the first time from its newest messages back to when collection
 // started, and records every message; the recorder keeps the ones that concern me. At most options.chatPages pages a
 // cycle: a long backlog goes on in the next cycle, so one chat cannot hold a cycle (a page can take open-lark seconds
 // when it has to fetch the positions from Lark).
 //
 // The chat is settled only when the read reached what its conversation entry showed (see #reached). open-lark bounds
 // every page by its stored last position of the chat, and that can lag or be 0: its feed refresh writes "0" when Lark's
 // chat card has no last_message_position (seen live for topic groups), and for topic groups storing messages does not
 // move it forward again. It then answers a tail read with the chat's position-0 message and no maxPosition, and a
 // forward read with an empty page and hasNewer:false. A read that fell short is retried by later cycles and given up
 // after options.readAttempts with one error, until the entry changes again. Topic groups are not read at all.
 async syncChat(feedId){
  let chat=this.store.chat(feedId);
  if(!chat?.chatMode){await this.fillChatInfo([feedId]);chat=this.store.chat(feedId);}
  if(chat?.chatMode==='topic'){if(chat.dirty)this.store.settleChat(feedId);return;}
  const name=chat?.name||feedId,lastTry=(chat?.readRetries??0)+1>=this.options.readAttempts;
  // A cursor is a positive position; anything else (0 from an earlier version) counts as never read.
  const read=chat?.cursor>0?await this.#readForward(feedId,chat.cursor,{name,lastTry}):await this.#readFromTail(feedId);
  if(read.state==='more')return;
  const target=chat?.pendingSignature?.split('|')[0]||undefined;
  if(read.state==='end'&&await this.#reached(chat,read,target)){this.store.settleChat(feedId);return;}
  if(!chat?.dirty)return;
  const tries=this.store.readRetry(feedId);
  if(tries<this.options.readAttempts)return;
  this.store.settleChat(feedId);
  this.store.addError(`聊天 ${name}`,read.state==='invalid'
   ?`open-lark 的尾页没有正的 maxPosition（它记的这个聊天的最后位置不对），读了 ${tries} 次，放弃到它下次有变化`
   :`按位置读到 ${read.cursor} 仍没读到会话列表显示的最后一条消息 ${target}，读了 ${tries} 次，放弃到它下次有变化`);
 }
 // Whether a read reached the chat's last message: it has a cursor, and the message the conversation entry shows is
 // among what it read or at or below the cursor. When the read did not show it, its position comes from butler's store
 // if butler holds it (a position does not change), else from GET /messages/:id; that GET reads open-lark's store but
 // checks the chat with Lark first (cached per chat for a minute).
 async #reached(chat,read,target){
  if(!(read.cursor>0))return false;
  if(!target||read.seen.has(target))return true;
  const stored=Number(this.store.position(chat.feedId,target));
  if(stored>0)return stored<=read.cursor||this.#heldUpTo(chat,read.cursor,stored);
  let view;
  try{view=await this.openLark.message(target);}catch(e){if(e.status===403||e.status===404)return false;throw e;}
  const position=Number(view.position);
  if(position>0){
   if(position<=read.cursor)return true;
   // Above the cursor the view itself stands for its position: open-lark builds it as it builds page rows
   // (viewsForRows), so recording it is the same as reading it on a page. Not an ephemeral message, which shares the
   // position of the one before it, nor a deleted one, which no page shows.
   if(view.isEphemeral||view.isDeleted)return false;
   this.recorder.record([view]);return this.#heldUpTo(chat,read.cursor,position,position-1);
  }
  // A normal group's thread reply has no position of its own: record it from here; the read counts if it had rows.
  this.recorder.record([view]);return read.rows>0;
 }
 // A read that ended at the cursor still reached a message above it when butler holds every position from just after
 // the cursor `through` the message's own, or the one before it when the message is the view just read by id. Live,
 // open-lark's window stayed one behind the newest message for cycles on end: in a direct chat with a bot, whose newest
 // message was pushed and stored, and in a group that is not watched, whose newest one did not concern me. Main-sequence
 // positions are dense, one message each besides ephemeral ones (see Store.holdsPositions), so nothing in the main
 // sequence is left unread; the cursor moves there. A longer range is complete mostly in a direct chat or a watched
 // group, where butler stores every message; other groups hold only what concerns me.
 #heldUpTo(chat,cursor,position,through=position){
  if(!this.store.holdsPositions(chat.feedId,cursor+1,through))return false;
  this.store.setCursor(chat.feedId,position);return true;
 }
 async #readFromTail(feedId){
  let page=await this.openLark.messages(feedId,{tail:true,limit:PAGE});
  const cursor=Number(page.maxPosition);
  // Without a positive maxPosition this is not the chat's tail: nothing is recorded and no cursor set.
  if(!(cursor>0))return {state:'invalid'};
  const views=[...page.items??[]];
  for(let n=1;n<this.options.chatPages&&page.hasOlder&&page.items?.length&&Date.parse(page.items[0].createdAt)>=this.collectedSince;n++){
   const min=Number(page.minPosition);
   page=await this.openLark.messages(feedId,{beforePosition:min+OVERLAP,limit:PAGE});views.push(...page.items??[]);
   if(!(Number(page.minPosition)<min))break;
  }
  this.recorder.record(views);this.store.setCursor(feedId,cursor);
  return {state:'end',cursor,rows:1,seen:new Set(views.map(v=>v.id))};
 }
 // state: 'end' (open-lark says there is nothing newer), 'more' (page budget used up) or 'gap'.
 async #readForward(feedId,cursor,{name,lastTry}){
  const seen=new Set();let after=Math.max(0,cursor-OVERLAP),rows=0;
  for(let n=0;n<this.options.chatPages;n++){
   const page=await this.openLark.messages(feedId,{afterPosition:after,limit:PAGE}),items=page.items??[],max=Number(page.maxPosition);
   this.recorder.record(items);for(const v of items)seen.add(v.id);
   if(page.syncState==='gap'){
    // open-lark could not fill this window from Lark: the cursor stays before it for later cycles; the last try moves past.
    if(!lastTry)return {state:'gap',cursor,rows,seen};
    this.store.addError(`聊天 ${name}`,`open-lark 报告位置 ${after+1} 之后的消息有缺口，读了 ${this.options.readAttempts} 次仍在，跳过`);
   }
   if(max>0){rows+=1;cursor=Math.max(cursor,max);this.store.setCursor(feedId,cursor);}
   if(!page.hasNewer||!page.nextNewerCursor)return {state:'end',cursor,rows,seen};
   after=Number(page.nextNewerCursor)-OVERLAP;
  }
  return {state:'more',cursor,rows,seen};
 }
 // Names and kinds of chats that records point at but no conversation list has shown yet.
 async fillChatInfo(feedIds){
  for(const feedId of feedIds){
   try{this.store.upsertChatInfo(await this.openLark.conversation(feedId));}
   catch(e){if(e.status!==403&&e.status!==404)throw e;this.store.upsertChatInfo({feedId,name:''});this.store.addError('聊天信息',`${feedId}：${message(e)}`);}
  }
 }

 // Threads in my feed (topics I started, replied in or follow), newest activity first down to the horizon. Any whose
 // reply count differs from what butler last saw is fetched; that is also how butler learns I took part in a thread
 // while it was down.
 async #scanThreadFeed(horizon){
  let cursor;
  for(let n=0;n<MAX_LIST_PAGES;n++){
   const page=await this.openLark.threadFeed({cursor,limit:50});let past=false;
   for(const item of page.items??[]){
    if(!(Date.parse(item.rankAt)>=horizon)){past=true;break;}
    this.recorder.record([item.root,item.lastReply].filter(Boolean));
    const known=this.store.thread(item.threadId);
    if(!known||item.replyCount>known.replyCount)this.store.markThreadStale(item.threadId,item.feedId,item.replyCount);
   }
   if(past||!page.hasMore||!page.nextCursor)break;
   cursor=page.nextCursor;
  }
  return true;
 }
 // Fetches the replies of these threads. A thread open-lark refuses (403, 404: I left the chat, the root is gone) is
 // settled with one error. Any other failure leaves it stale for the next cycles, which alone retry it; after
 // threadAttempts failures it is given up with one error. A reply count announced later than that is new work again.
 async fetchThreads(rootIds,errors=[]){
  for(const rootId of rootIds){
   try{await this.#fetchThread(rootId);}
   catch(e){
    if(e.status===403||e.status===404){this.store.settleThread(rootId,undefined,undefined);errors.push(rootId);this.store.addError(`话题 ${rootId}`,`读不到，不再重试：${message(e)}`);continue;}
    const attempts=this.store.failThread(rootId,message(e));
    if(attempts>=this.options.threadAttempts){this.store.settleThread(rootId,undefined,undefined);errors.push(rootId);this.store.addError(`话题 ${rootId}`,`取回复失败 ${attempts} 次，放弃：${message(e)}`);}
   }
  }
  return rootIds.length;
 }
 async #fetchThread(rootId){
  const known=this.store.thread(rootId);
  let page=await this.openLark.thread(rootId,{limit:PAGE});
  const root=page.items?.[0];
  if(!root||root.id!==rootId){this.store.settleThread(rootId,undefined,undefined);return;}
  const since=this.#followSince(known,root),items=[...page.items];
  // Older pages only while they can still hold replies after `since`; without one (is this my thread at all?) a few
  // pages back to find my own message in it.
  for(let n=1;n<MAX_THREAD_PAGES&&page.hasOlder&&page.nextOlderCursor;n++){
   const oldest=page.items[1];if(since!==undefined&&oldest&&Date.parse(oldest.createdAt)<since)break;
   page=await this.openLark.thread(rootId,{beforePosition:page.nextOlderCursor,limit:PAGE});items.push(...(page.items??[]).slice(1));
  }
  this.recorder.record(items);
  this.store.settleThread(rootId,root.threadReplyCount??0,root.position);
 }
 #followSince(thread,root){
  const direct=(this.store.chat(root.feedId)?.chatMode??(root.chatType===1?'direct':undefined))==='direct';
  const since=thread?.participatedSince??this.store.watchSince(root.feedId)??(direct?this.collectedSince:undefined);
  return since===undefined?undefined:Math.max(since,this.collectedSince);
 }

 // The @me history from where the last sweep ended (minus an overlap for Lark's search index lag) to now.
 async #sweepMentions(){
  const now=Date.now(),end=Math.floor(now/1000),swept=this.store.meta('mentions.sweptUntil');
  const start=swept!==undefined?swept-Math.floor(this.options.mentionOverlapMs/1000):Math.floor(this.collectedSince/1000);
  const hits=[];let cursor;
  for(let n=0;n<MAX_SEARCH_PAGES;n++){
   const page=await this.openLark.mentionHistory({startTime:start,endTime:end,cursor,limit:50});
   // A failed upstream search comes back as an empty page; it must not read as "nobody mentioned me".
   if(page.upstream?.failed)throw Error(`飞书的 @我 搜索失败${page.upstream.reason?`：${page.upstream.reason}`:''}`);
   hits.push(...(page.items??[]).filter(h=>h.type==='message'&&h.messageId&&h.feedId));
   cursor=page.nextCursor;if(!cursor)break;
  }
  for(const hit of hits)await this.#resolveMention(hit);
  if(cursor)throw Error(`@我 搜索结果超过 ${MAX_SEARCH_PAGES} 页，下次从同一时间继续`);
  this.store.setMeta('mentions.sweptUntil',end);this.store.setMeta('mentions.sweptAt',now);
 }
 // A search hit as a full message: by id from open-lark's store, or, when open-lark has not stored it yet, from the
 // page around its position (which makes open-lark fetch it from Lark); otherwise it waits in pending_mentions.
 async #resolveMention(hit){
  if(this.store.hasCategory(hit.messageId,'mention')){this.store.removePending(hit.messageId);return;}
  try{this.recorder.record([await this.openLark.message(hit.messageId)]);this.store.removePending(hit.messageId);return;}
  catch(e){
   if(e.status===403){this.store.removePending(hit.messageId);this.store.addError('@我补扫',`${hit.messageId}：${message(e)}`);return;}
   if(e.status===404&&Number(hit.position)>0){
    const page=await this.openLark.messages(hit.feedId,{aroundPosition:hit.position,limit:1}),view=page.items?.find(v=>v.id===hit.messageId);
    if(view){this.recorder.record([view]);this.store.removePending(hit.messageId);return;}
   }
   this.store.addPending(hit,message(e));
   if(e.status===undefined)throw e;
  }
 }
 async #retryPending(errors){
  for(const p of this.store.pendingMentions(20)){
   if(p.attempts>=MAX_PENDING_ATTEMPTS){this.store.removePending(p.messageId);this.store.addError('@我补扫',`放弃 ${p.messageId}：重试 ${p.attempts} 次仍读不到`);continue;}
   try{await this.#resolveMention(p);}catch(e){errors.push(p.messageId);this.store.addError('@我补扫',message(e));}
  }
 }
}
