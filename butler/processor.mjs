// The processor: every few minutes it hands the messages that came in since to the model, one batch at a time, and
// applies what the model makes of them (new matters, messages attached to open ones, matters that have ended). It
// assembles context and checks the answer; what is a matter, what belongs to it, how urgent it is and whether it has
// ended is the model's call. Messages that could not be processed stay pending and go again on the next round, with
// one exception: a message the model cannot handle by itself (see #round) is skipped after a few tries. Once a day,
// and whenever my notes change, a round's batches are followed by a new 关于TA (see profile.mjs and #profile), and
// every few hours, or when 关于TA or my notes have changed, a round ends with a review of all open matters (see
// review.mjs and #review). Batches and reviews are told 关于TA and my notes.
import {composePrompt,readReply} from './prompt.mjs';
import {review} from './review.mjs';
import {writeProfile} from './profile.mjs';

// contextMessages and matterMessages: how many of a chat's and of a matter's latest messages come along, in a batch
// for the chats of its messages and the open matters there, in a review for every open matter and its chats.
// profileMessages: how many of my latest messages 关于TA is written from at most, more than fit one prompt (the
// newest that fit go).
export const DEFAULTS={everyMs:600_000,heartbeatMs:60_000,maxMessages:40,maxPromptBytes:80_000,contextMessages:8,matterMessages:3,textChars:1500,skipAfter:3,
 reviewEveryMs:10_800_000,profileEveryMs:86_400_000,profileMessages:1000};
const message=e=>e?.message??String(e);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
// Whether what is done every everyMs is due: it has never been done (last has no at), or that long ago.
const due=(last,everyMs,now)=>!(now-last?.at<everyMs);
// What a profile or a review was made with, to tell when they are out of date: my notes by their numbers (see
// matters.mjs), and for a review the profile by when it was written.
const numbers=notes=>notes.map(n=>n.id),same=(a=[],b=[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);

export class Processor{
 #limit;#cycle;#timers=[];#halting=false;
 // model: {ask({system,prompt}) → reply text, cleanup?()}; ask throws when there is no usable answer, with
 // answered: true when the model did answer (one too long, say). pid: this process (another one may hold the store).
 // now: the clock.
 constructor({store,matters,model,options={},log=()=>{},pid=process.pid,now=Date.now}){
  this.store=store;this.matters=matters;this.model=model;this.options={...DEFAULTS,...options};this.log=log;this.pid=pid;this.now=now;
  this.#limit=this.options.maxMessages;
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
  if(periodic){this.#timers.push(setInterval(()=>this.runOnce(),this.options.everyMs));this.runOnce();}
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
   const pending=this.matters.pending(this.#limit,[...aside.keys(),...counted]);if(!pending.length)break;
   const open=this.matters.list();
   // My own messages only add context; with nothing open there is nothing they could end.
   if(!open.length&&pending.every(m=>m.isMine)){this.matters.apply({processedIds:pending.map(m=>m.id),outcome:'context'});continue;}
   const struck=this.matters.struck(),i=pending.findIndex(m=>struck.has(m.id));
   const candidates=i===0?pending.slice(0,1):i>0?pending.slice(0,i):pending;
   runs+=1;const r=await this.#run(this.#compose(candidates,open,new Set([...struck,...aside.keys()])),open);
   if(r.ok){
    this.matters.clearStrikes(r.batch.map(m=>m.id));
    for(const [id,error] of aside){this.#strike(id,error);counted.add(id);}
    aside.clear();continue;
   }
   failures+=1;
   if(r.answered&&r.batch.length===1&&!aside.size){aside.set(r.batch[0].id,r.error);continue;}
   failed=true;break;
  }
  // A round that ended on a failure leaves the profile and the review for later: the model is not there.
  const go=()=>!this.#halting&&!failed;
  const profile=go()&&this.#profileDue()?await this.#profile():undefined;
  const result={runs,failures,profile,review:go()&&this.#reviewDue()?await this.#review():undefined};
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
   const r=await review({store:this.store,matters:this.matters,model:this.model,options:this.options,now:this.now,stopped:()=>this.#halting,about});
   if(r.complete)this.store.setMeta('review',{at:this.now(),reviewed:r.reviewed,closed:r.closed,profileAt:about.profile?.at,notes:numbers(about.notes)});
   return r;
  }catch(e){
   this.store.addError('加工',`整理事项没有完成，下一轮再试：${message(e)}`);
   this.store.setMeta('review',{...last,failedAt:this.now(),error:message(e)});
   return {error:message(e)};
  }
 }
 #strike(id,error){
  if(this.matters.strike(id,error)<this.options.skipAfter)return;
  this.matters.apply({processedIds:[id],outcome:'failed'});
  const m=this.store.message(id),at=new Date(m.createdAt).toLocaleString('sv-SE').slice(0,16);
  this.store.addError('加工',`跳过消息 ${id}（${m.chatName??m.chatId} · ${m.senderName??m.senderId} · ${at}：${m.text.replace(/\s+/g,' ').slice(0,80)}）：模型单独处理它 ${this.options.skipAfter} 次都没有给出可用的回答，别的消息同时处理正常。最后一次：${error}`);
 }

 // The batch and its prompt. A prompt over maxPromptBytes is retried with the older half of the batch and, down to
 // one message, with the newer half of its context. exclude: messages to keep out of the context.
 #compose(pending,open,exclude){
  let batch=pending,context=this.#context(batch,open).filter(r=>!exclude.has(r.id));const about=this.#about();
  for(;;){
   const composed=composePrompt({now:this.now(),me:this.matters.me(),batch,context,openMatters:open,textChars:this.options.textChars,about});
   if(Buffer.byteLength(composed.prompt)<=this.options.maxPromptBytes||batch.length===1&&!context.length)return {batch,...composed};
   if(batch.length>1){batch=batch.slice(0,Math.ceil(batch.length/2));context=this.#context(batch,open).filter(r=>!exclude.has(r.id));}
   else context=context.slice(Math.ceil(context.length/2));
  }
 }
 // What helps reading the batch: the latest earlier messages of each chat, the thread roots and the messages replied
 // to, and the latest messages of the open matters in these chats.
 #context(batch,open){
  const fresh=new Set(batch.map(m=>m.id)),out=new Map(),add=r=>{if(r&&!fresh.has(r.id))out.set(r.id,r);};
  const chats=new Set(batch.map(m=>m.chatId));
  for(const chat of chats)for(const r of this.matters.before(chat,Math.min(...batch.filter(m=>m.chatId===chat).map(m=>m.createdAt)),this.options.contextMessages))add(r);
  for(const m of batch){if(m.rootId&&m.rootId!==m.id)add(this.matters.visible(m.rootId));if(m.parentId)add(this.matters.visible(m.parentId));}
  for(const matter of open)if(matter.chatIds.some(c=>chats.has(c)))for(const id of matter.messageIds.slice(-this.options.matterMessages))add(this.matters.visible(id));
  return [...out.values()];
 }
 // One model run, recorded in model_runs. A failure keeps the batch pending and halves the next one: a batch too big
 // or too slow for the model gets through in smaller parts, and a success restores the size. answered: the model gave
 // an answer that could not be used (as opposed to giving none).
 async #run({batch,system,prompt,refs},open){
  let answered=false;
  try{
   await this.matters.recordRun({model:this.model,kind:'batch',messages:batch.length,matters:open.length,system,prompt,now:this.now},(output,runId)=>{
    let reply;try{reply=readReply(output,{refs,matterIds:new Set(open.map(m=>m.id))});}catch(e){answered=true;throw e;}
    this.matters.apply({runId,created:reply.created,updated:reply.updated,processedIds:batch.map(m=>m.id)});
    for(const p of reply.problems)this.store.addError('加工',`模型回复里没有采纳的部分：${p}`);
   });
   this.#limit=this.options.maxMessages;this.#beat({lastSuccessAt:this.now()});
   return {ok:true,batch};
  }catch(e){
   answered||=e?.answered===true;
   this.store.addError('加工',`${batch.length} 条消息这次没有加工成，下次再试：${message(e)}`);
   this.#limit=Math.max(1,Math.ceil(batch.length/2));
   return {ok:false,batch,answered,error:message(e)};
  }
 }
}
