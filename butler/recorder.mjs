// Records message views, from events and from reconciliation alike, into the store: decides their categories, keeps one
// record per message, and notes the threads whose replies butler collects and when those replies need fetching.
import {categoriesOf,chatKindOf,recordOf,threadRootOf} from './rules.mjs';

export class Recorder{
 constructor(store,{me,collectedSince}){this.store=store;this.me=me;this.collectedSince=collectedSince;}
 // Oldest first, so that my taking part in a thread is known before the replies that follow it. Local placeholders of
 // my own sends (localState pending or failed) are skipped: the server message replaces them. Returns how many were
 // stored and the work these messages created: threads newly marked for fetching, and chats butler had no message of
 // and cannot name yet.
 record(views){
  const list=views.filter(v=>v?.id&&v.feedId&&Number.isFinite(Date.parse(v.createdAt))&&(v.localState??'synced')==='synced')
   .sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id));
  const work={stored:0,staleThreads:new Set(),newChats:new Set()};
  for(const v of list)this.#one(v,work);
  return {stored:work.stored,staleThreads:[...work.staleThreads],newChats:[...work.newChats]};
 }
 #one(v,work){
  const {store}=this,t=Date.parse(v.createdAt),root=threadRootOf(v),chat=store.chat(v.feedId);
  const chatKind=chatKindOf(v,chat?.chatMode),watchSince=store.watchSince(v.feedId);
  if(root&&v.isMine&&store.participate(root,v.feedId,t)&&store.markThreadStale(root,v.feedId))work.staleThreads.add(root);
  const thread=root?store.thread(root):undefined;
  if(v.threadMessageType==='root'&&this.#followRoot(v,thread,chatKind,watchSince))work.staleThreads.add(v.id);
  const categories=categoriesOf(v,{me:this.me,collectedSince:this.collectedSince,chatKind,watchSince,participatedSince:thread?.participatedSince,
   parentIsMine:Boolean(v.parentId)&&store.isMine(v.parentId)});
  if(!categories.length&&!store.hasMessage(v.id))return;
  if(chat?.name==null&&!store.hasMessagesIn(v.feedId))work.newChats.add(v.feedId);
  store.upsertMessage(recordOf(v,chatKind),categories);work.stored+=1;
 }
 // Replies of a root are collected in a direct chat, a watched group and a thread I took part in. A reply count that is
 // new or has grown means replies to fetch: open-lark's background thread sync stores replies without events and only
 // sends the root again. Returns whether that is new work (see Store.markThreadStale).
 #followRoot(v,thread,chatKind,watchSince){
  if(thread?.participatedSince===undefined&&chatKind!=='direct'&&watchSince===undefined)return false;
  const count=v.threadReplyCount??0,fresh=count>(thread?.replyCount??0)&&this.store.markThreadStale(v.id,v.feedId,count);
  this.store.setRootPosition(v.id,v.position);
  return fresh;
 }
}
