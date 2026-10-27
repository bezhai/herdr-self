// The review: all open matters go back to the model, each with its latest messages and the latest messages of its
// chats, mine included, and with 关于TA and my notes (see profile.mjs), so that a matter nobody mentions again still
// ends, and one that never was a matter by the bar (see prompt.mjs), or is not mine to do, goes. The model closes the
// matters that need no more of me, each with its reason, and may adjust the others; it never makes one. Whether a
// matter is done, outdated, superseded, not mine or below the bar is all the model's call: this only gathers what it
// is shown, splits the matters into parts that fit one prompt and applies the answers, one model run per part. When
// reviews happen is the processor's (see processor.mjs).
import {composeReview,readReview} from './prompt.mjs';

// options: maxPromptBytes, textChars, matterMessages, contextMessages (see processor.mjs DEFAULTS); now: the clock;
// stopped: whether to start no further part; about: 关于TA and my notes, the same for every part (see prompt.mjs
// aboutMe). Resolves with the runs, the matters reviewed and closed, and whether every open matter was reviewed; a
// part that fails is recorded as a failed run and rejects, the parts before it staying applied.
export async function review({store,matters,model,options,now=Date.now,stopped=()=>false,about}){
 // Matters of one chat follow one another, so that a part holds them side by side (one may supersede another).
 let rest=[...Map.groupBy(matters.list(),m=>m.chatIds[0]).values()].flat(),runs=0,reviewed=0,closed=0;
 while(rest.length){
  if(stopped())return {runs,reviewed,closed,complete:false};
  const part=compose(rest,{matters,options,now,about});
  runs+=1;closed+=await run(part,{store,matters,model,now});
  reviewed+=part.matters.length;rest=rest.slice(part.matters.length);
 }
 return {runs,reviewed,closed,complete:true};
}

// What the model is shown of these matters: the latest matterMessages of each, and the latest contextMessages of
// each of their chats, mine among them (my reply there may show that a matter was dealt with), oldest first.
function shown(list,{matters,options,now}){
 const out=new Map(),add=r=>{if(r)out.set(r.id,r);};
 for(const m of list)for(const id of m.messageIds.slice(-options.matterMessages))add(matters.visible(id));
 for(const chat of new Set(list.flatMap(m=>m.chatIds)))for(const r of matters.before(chat,now()+1,options.contextMessages))add(r);
 return [...out.values()].sort((a,b)=>a.createdAt-b.createdAt);
}
// The next part: the matters from the front of rest that fit maxPromptBytes, halving until they do; one matter alone
// that does not fit keeps the newer half of its messages, down to none.
function compose(rest,{matters,options,now,about}){
 let list=rest,messages=shown(list,{matters,options,now});
 for(;;){
  const composed=composeReview({now:now(),me:matters.me(),matters:list,messages,textChars:options.textChars,about});
  if(Buffer.byteLength(composed.prompt)<=options.maxPromptBytes||list.length===1&&!messages.length)return {matters:list,...composed};
  if(list.length>1){list=list.slice(0,Math.ceil(list.length/2));messages=shown(list,{matters,options,now});}
  else messages=messages.slice(Math.ceil(messages.length/2));
 }
}
// One part through the model, recorded in model_runs like a batch; resolves with how many matters it closed.
function run({matters:list,system,prompt,refs},{store,matters,model,now}){
 return matters.recordRun({model,kind:'review',messages:0,matters:list.length,system,prompt,now},(output,runId)=>{
  const reply=readReview(output,{refs,matterIds:new Set(list.map(m=>m.id))});
  matters.apply({runId,updated:reply.updated,now:now()});
  for(const p of reply.problems)store.addError('加工',`整理事项时模型回复里没有采纳的部分：${p}`);
  return reply.updated.filter(u=>u.close).length;
 });
}
