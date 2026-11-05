// The processor: every few minutes it hands the messages that came in since to the model, one batch at a time, and
// applies what the model makes of them (new matters, messages attached to open ones, matters that have ended). My own
// reactions the collector saw on messages processed before go in the same batches, in time order (see #pending). It
// assembles context and checks the answer; what is a matter, what belongs to it, how urgent it is and whether it has
// ended is the model's call. Messages that could not be processed stay pending and go again on the next round, with
// one exception: a message the model cannot handle by itself (see #round) is skipped after a few tries. Something of
// mine that could end an open matter (my message or reaction in its chat) does not wait for the next round: it starts
// one within seconds (see checkOwner). Once a day, and whenever my notes change, a round's batches are followed by a
// new 关于TA (see profile.mjs and #profile), and every few hours, or when 关于TA or my notes have changed, a round ends
// with a review of all open matters (see review.mjs and #review). Batches and reviews are told 关于TA and my notes.
// Whoever shows the matters is told when a batch or a review has changed them (onMattersChanged).
import {composePrompt,readReply} from './prompt.mjs';
import {review} from './review.mjs';
import {writeProfile} from './profile.mjs';

// contextMessages and matterMessages: how many of a chat's and of a matter's latest messages come along, in a batch
// for the chats of its messages and the open matters there, in a review for every open matter and its chats.
// ownerMessages: how many of my latest messages, and messages I reacted to, in such a matter's chats since it started
// come along too, so that my answer shows even when the chat has moved on past its latest messages.
// profileMessages: how many of my latest messages 关于TA is written from at most, more than fit one prompt (the
// newest that fit go). ownerCheckMs: how often to look for something of mine that could end an open matter.
export const DEFAULTS={everyMs:600_000,ownerCheckMs:15_000,heartbeatMs:60_000,maxMessages:40,maxPromptBytes:80_000,contextMessages:8,matterMessages:3,ownerMessages:5,textChars:1500,skipAfter:3,
 reviewEveryMs:10_800_000,profileEveryMs:86_400_000,profileMessages:1000};
const message=e=>e?.message??String(e);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
// Whether what is done every everyMs is due: it has never been done (last has no at), or that long ago.
const due=(last,everyMs,now)=>!(now-last?.at<everyMs);
// What a profile or a review was made with, to tell when they are out of date: my notes by their numbers (see
// matters.mjs), and for a review the profile by when it was written.
const numbers=notes=>notes.map(n=>n.id),same=(a=[],b=[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);
// A batch holds messages (store records) and my reactions (see Matters.pendingReactions); a reaction is timed by when
// butler saw it.
const isReaction=x=>x.kind==='reaction',timeOf=x=>isReaction(x)?x.at:x.createdAt;

export class Processor{
 #limit;#cycle;#timers=[];#halting=false;#failed=false;
 // model: {ask({system,prompt}) → reply text, cleanup?()}; ask throws when there is no usable answer, with
 // answered: true when the model did answer (one too long, say). pid: this process (another one may hold the store).
 // now: the clock. onMattersChanged: called once a batch or a part of a review has made, changed or closed matters;
 // what it throws or rejects with is recorded and changes nothing else.
 constructor({store,matters,model,options={},log=()=>{},pid=process.pid,now=Date.now,onMattersChanged=()=>{}}){
  this.store=store;this.matters=matters;this.model=model;this.options={...DEFAULTS,...options};this.log=log;this.pid=pid;this.now=now;
  this.onMattersChanged=onMattersChanged;this.#limit=this.options.maxMessages;
 }

 // Claims the store (one processor at a time, so batches never overlap), closes what a crashed run left on the model
 // machine and, unless periodic is false, processes now and every everyMs.
 async start({periodic=true}={}){
  const other=this.store.meta('processor');
  if(other?.pid&&other.pid!==this.pid&&!other.stoppedAt&&this.now()-other.heartbeatAt<3*this.options.heartbeatMs&&alive(other.pid))
   throw Error(`另一个加工端已经在运行（pid ${other.pid}），同一个存储只能有一个`);
  this.#halting=false;this.startedAt=this.now();this.#beat({stoppedAt:undefined});
  this.#timers.push(setInterval(()=>this.#beat(),this.options.heartbeatMs));
  try{const n=await this.model.cleanup?.();if(n)this.log(`关闭了上次留在模型机器上的 ${n} 个工作区`);}catch(e){this.store.addError('加工',`清理模型机器上的工作区失败：${message(e)}`);}
  if(!periodic)return;
  this.#timers.push(setInterval(()=>this.runOnce(),this.options.everyMs));
  this.#timers.push(setInterval(()=>{try{this.checkOwner();}catch(e){this.store.addError('加工',`查看我有没有回应事项时出错：${message(e)}`);}},this.options.ownerCheckMs));
  this.runOnce();
 }
 // Waits for the model run under way, if any; no further batch starts.
 async stop(){
  if(this.#halting)return;
  this.#halting=true;for(const t of this.#timers)clearInterval(t);this.#timers=[];
  await this.#cycle;this.#beat({stoppedAt:this.now()});
 }
 #beat(extra={}){this.store.setMeta('processor',{...this.store.meta('processor'),pid:this.pid,startedAt:this.startedAt,heartbeatAt:this.now(),...extra});}

 // Processes pending messages until none are left or a run fails, then reviews the open matters if a review is due.
 // Rounds never overlap: a call during one joins it.
 runOnce(){
  this.#cycle??=this.#round().finally(()=>{this.#cycle=undefined;});
  return this.#cycle;
 }
 // Starts a round now when something of mine waits that could end an open matter (see Matters.ownerWaiting): my
 // answer closes a matter within seconds of it, not on the next cycle. Others' messages alone wait for the cycle. The
 // round is the usual one, taking along whatever else waits. Returns it, or undefined when none starts: none is
 // needed, one is running (it goes on to what waits), or the last round failed somewhere (a model run, 关于TA or the
 // review), when only the cycle tries again, as it would have anyway.
 checkOwner(){
  if(this.#cycle||this.#halting||this.#failed||!this.matters.ownerWaiting())return undefined;
  return this.runOnce();
 }
 // A failed run normally ends the round: the model, its machine or herdr is not there. One failure lets the round go
 // on: a message alone in its batch (failures halve the batch until it is) that got an answer, just not a usable one.
 // A gateway or API failure never looks like that: claude then runs its StopFailure hooks instead of Stop, so herdr
 // gets no reply at all. The message is set aside and the round goes on with the messages behind it; if that next
 // run succeeds, the model works and the failure is the message's own: it counts as a strike. If the next run fails
 // too, the model is at fault and nothing counts. A message with a strike always goes alone and is left out of the
 // others' context, and it stays aside for the rest of the round, so its tries are a round apart; after skipAfter
 // strikes it is skipped. It holds up the queue only until its first strike.
 async #round(){
  let runs=0,failures=0,failed=false;const aside=new Map(),counted=new Set();// aside: id → error, until a successful run counts it
  this.matters.skipIgnored();
  while(!this.#halting){
   const pending=this.#pending([...aside.keys(),...counted]);if(!pending.length)break;
   const open=this.matters.list();
   // What I did myself, my messages and my reactions, only adds context; with nothing open there is nothing it could end.
   if(!open.length&&pending.every(x=>isReaction(x)||x.isMine)){
    const messages=pending.filter(x=>!isReaction(x));
    this.matters.apply({processedIds:messages.map(m=>m.id),reactions:[...pending.filter(isReaction).map(x=>({...x,outcome:'context'})),...this.#covered(messages)],outcome:'context'});
    continue;
   }
   const struck=this.matters.struck(),i=pending.findIndex(x=>!isReaction(x)&&struck.has(x.id));
   const candidates=i===0?pending.slice(0,1):i>0?pending.slice(0,i):pending;
   runs+=1;const r=await this.#run(this.#compose(candidates,open,new Set([...struck,...aside.keys()])),open);
   if(r.ok){
    this.matters.clearStrikes(r.batch.filter(x=>!isReaction(x)).map(m=>m.id));
    for(const [id,error] of aside){this.#strike(id,error);counted.add(id);}
    aside.clear();continue;
   }
   failures+=1;
   if(r.answered&&r.batch.length===1&&!isReaction(r.batch[0])&&!aside.size){aside.set(r.batch[0].id,r.error);continue;}
   failed=true;break;
  }
  // A round that ended on a failure leaves the profile and the review for later: the model is not there.
  const go=()=>!this.#halting&&!failed;
  const profile=go()&&this.#profileDue()?await this.#profile():undefined;
  const result={runs,failures,profile,review:go()&&this.#reviewDue()?await this.#review():undefined};
  this.#failed=failures>0||Boolean(profile?.error||result.review?.error);
  this.#beat({lastRoundAt:this.now()});
  return result;
 }
 // What batches and reviews are told of me: 关于TA (the meta profile) and my notes.
 #about(){return {profile:this.store.meta('profile'),notes:this.matters.notes()};}
 // 关于TA, after a round's batches and before its review, which then judges by it. It is due when none has been
 // written (the first round after deployment writes it), once profileEveryMs have passed since the last one, and
 // when my notes are no longer those it was written with. One that fails is recorded and goes again on the next
 // round; it holds up no message, and the review goes on with what there is. The meta profile: {text, at, notes
 // (their numbers), messages (how many of mine it was written from)} of the last one written, and {failedAt, error}
 // of a failure since.
 #profileDue(){const p=this.store.meta('profile');return due(p,this.options.profileEveryMs,this.now())||!same(p?.notes,numbers(this.matters.notes()));}
 async #profile(){
  const last=this.store.meta('profile')??{},notes=this.matters.notes();
  try{
   const r=await writeProfile({matters:this.matters,model:this.model,options:this.options,notes,now:this.now});
   if(r)this.store.setMeta('profile',{text:r.text,at:this.now(),notes:numbers(notes),messages:r.messages});
   return r;
  }catch(e){
   this.store.addError('加工',`写「关于TA」没有完成，下一轮再试：${message(e)}`);
   this.store.setMeta('profile',{...last,failedAt:this.now(),error:message(e)});
   return {error:message(e)};
  }
 }
 // The review, after a round's batches and its profile, so that it sees what they made. It is due once
 // reviewEveryMs have passed since the last one done, at once when there has been none (the first round after
 // deployment reviews, and so does the first after a start when the last review is that old), and when 关于TA or
 // my notes are not those it judged by: a new profile, or a note added or removed, re-judges the open matters at
 // once. One that fails, or is cut short by a stop, is not done: the next round tries again, never this one. The meta
 // review: {at, reviewed, closed, profileAt, notes} of the last one done (profileAt and notes: what it judged by), and
 // {failedAt, error} of a failure since.
 #reviewDue(){
  const v=this.store.meta('review'),about=this.#about();
  return due(v,this.options.reviewEveryMs,this.now())||v?.profileAt!==about.profile?.at||!same(v?.notes,numbers(about.notes));
 }
 async #review(){
  const last=this.store.meta('review')??{},about=this.#about();
  try{
   const r=await review({store:this.store,matters:this.matters,model:this.model,options:this.options,now:this.now,stopped:()=>this.#halting,about,changed:()=>this.#changed()});
   if(r.complete)this.store.setMeta('review',{at:this.now(),reviewed:r.reviewed,closed:r.closed,profileAt:about.profile?.at,notes:numbers(about.notes)});
   return r;
  }catch(e){
   this.store.addError('加工',`整理事项没有完成，下一轮再试：${message(e)}`);
   this.store.setMeta('review',{...last,failedAt:this.now(),error:message(e)});
   return {error:message(e)};
  }
 }
 #changed(){
  const failed=e=>this.store.addError('加工',`事项有变化，但通知出错：${message(e)}`);
  try{Promise.resolve(this.onMattersChanged()).catch(failed);}catch(e){failed(e);}
 }
 #strike(id,error){
  if(this.matters.strike(id,error)<this.options.skipAfter)return;
  this.matters.apply({processedIds:[id],outcome:'failed'});
  const m=this.store.message(id),at=new Date(m.createdAt).toLocaleString('sv-SE').slice(0,16);
  this.store.addError('加工',`跳过消息 ${id}（${m.chatName??m.chatId} · ${m.senderName??m.senderId} · ${at}：${m.text.replace(/\s+/g,' ').slice(0,80)}）：模型单独处理它 ${this.options.skipAfter} 次都没有给出可用的回答，别的消息同时处理正常。最后一次：${error}`);
 }

 // Pending messages and my reactions that wait for the model, in one time order, up to the batch size. exclude:
 // messages to leave out.
 #pending(exclude){
  return [...this.matters.pending(this.#limit,exclude),...this.matters.pendingReactions(this.#limit)].sort((a,b)=>timeOf(a)-timeOf(b)).slice(0,this.#limit);
 }
 // My reactions on these messages that their records show (the collector writes a reaction of mine and the message's
 // updated_at together), so that they are processed with them; one it records later goes on its own.
 #covered(messages){
  const byId=new Map(messages.map(m=>[m.id,m]));
  return this.matters.reactionsOn([...byId.keys()]).filter(r=>r.at<=byId.get(r.messageId).updatedAt).map(r=>({...r,outcome:'covered'}));
 }
 // The batch and its prompt, and how each of my reactions it covers is processed (see Matters.apply). A prompt over
 // maxPromptBytes is retried with the older half of the batch and, down to one item, with the newer half of its
 // context. A reaction is shown when the message it is on is (its message may be one to exclude, or cut for size).
 // exclude: messages to keep out of the context.
 #compose(pending,open,exclude){
  let batch=pending,context=this.#context(batch,open,exclude);const about=this.#about(),me=this.matters.me(),meId=this.matters.meId();
  for(;;){
   const messages=batch.filter(x=>!isReaction(x)),reactions=batch.filter(isReaction),shown=new Set(context.map(r=>r.id));
   const actions=reactions.filter(x=>shown.has(x.messageId));
   const composed=composePrompt({now:this.now(),me,meId,batch:messages,reactions:actions,context,openMatters:open,textChars:this.options.textChars,about});
   if(Buffer.byteLength(composed.prompt)<=this.options.maxPromptBytes||batch.length===1&&!context.length)
    return {batch,...composed,reactions:[...actions.map(x=>({...x,outcome:'model'})),...reactions.filter(x=>!shown.has(x.messageId)).map(x=>({...x,outcome:'unshown'})),...this.#covered(messages)]};
   if(batch.length>1){batch=batch.slice(0,Math.ceil(batch.length/2));context=this.#context(batch,open,exclude);}
   else context=context.slice(Math.ceil(context.length/2));
  }
 }
 // What helps reading the batch: the latest earlier messages of each chat, the thread roots and the messages replied
 // to, the messages my reactions are on, and for the open matters in these chats their latest messages and what I did
 // there since they started (my messages, messages I reacted to), up to the newest of the batch. exclude: messages to
 // leave out.
 #context(batch,open,exclude){
  const messages=batch.filter(x=>!isReaction(x)),fresh=new Set(messages.map(m=>m.id)),out=new Map(),add=r=>{if(r&&!fresh.has(r.id)&&!exclude.has(r.id))out.set(r.id,r);};
  const chats=new Set(batch.map(x=>x.chatId)),until=Math.max(...batch.map(timeOf))+1;
  for(const chat of chats)for(const r of this.matters.before(chat,Math.min(...batch.filter(x=>x.chatId===chat).map(timeOf)),this.options.contextMessages))add(r);
  for(const m of messages){if(m.rootId&&m.rootId!==m.id)add(this.matters.visible(m.rootId));if(m.parentId)add(this.matters.visible(m.parentId));}
  for(const x of batch.filter(isReaction))add(this.matters.visible(x.messageId));
  for(const matter of open)if(matter.chatIds.some(c=>chats.has(c))){
   for(const id of matter.messageIds.slice(-this.options.matterMessages))add(this.matters.visible(id));
   for(const r of this.matters.responses(matter.chatIds,matter.since,until,this.options.ownerMessages))add(r);
  }
  return [...out.values()];
 }
 // One model run, recorded in model_runs. A failure keeps the batch pending and halves the next one: a batch too big
 // or too slow for the model gets through in smaller parts, and a success restores the size. answered: the model gave
 // an answer that could not be used (as opposed to giving none).
 async #run({batch,system,prompt,refs,reactions},open){
  let answered=false,changed=false;
  try{
   await this.matters.recordRun({model:this.model,kind:'batch',messages:batch.length,matters:open.length,system,prompt,now:this.now},(output,runId)=>{
    let reply;try{reply=readReply(output,{refs,matterIds:new Set(open.map(m=>m.id))});}catch(e){answered=true;throw e;}
    this.matters.apply({runId,created:reply.created,updated:reply.updated,processedIds:batch.filter(x=>!isReaction(x)).map(m=>m.id),reactions});
    changed=reply.created.length+reply.updated.length>0;
    for(const p of reply.problems)this.store.addError('加工',`模型回复里没有采纳的部分：${p}`);
   });
   this.#limit=this.options.maxMessages;this.#beat({lastSuccessAt:this.now()});
   if(changed)this.#changed();
   return {ok:true,batch};
  }catch(e){
   answered||=e?.answered===true;
   this.store.addError('加工',`${batch.length} 条消息这次没有加工成，下次再试：${message(e)}`);
   this.#limit=Math.max(1,Math.ceil(batch.length/2));
   return {ok:false,batch,answered,error:message(e)};
  }
 }
}
