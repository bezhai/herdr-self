import {randomUUID} from 'node:crypto';
import {TaskStore} from './task-store.ts';
import type {Task,Input,Output,Delivery,DeliveryState,Target,Outcome,TaskState,TaskView,JournalRecord,Sink,Policy,Handler} from './task-types.ts';
// The task core: a task turns inputs into outputs that get consumed, for a goal. It keeps tasks, inputs, outputs, deliveries and a journal in
// one SQLite database and guarantees the rules around them (journal, policy, idempotent delivery, ended tasks, observers). It knows nothing
// of any real system: sinks and the policy are injected, content is opaque, and no part of it is wired into the rest of Bridge.

// What the core needs from outside: the sinks by name, the policy, and the clock (so tests control time).
export type Options={sinks:Record<string,Sink>,policy:Policy,now:()=>number};
// An error with a code, as the rest of Bridge does.
const fail=(code:string,message:string)=>Object.assign(Error(message),{code});
// The message of anything thrown, for a delivery's error.
const text=(e:unknown)=>e instanceof Error?e.message:String(e);
// Whether two contents are equal as JSON.
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
// A registered observer: its handler and whether a drain of the journal is running for it.
type Observer={name:string,handler:Handler,running:Promise<void>|null};

// The task core over one database.
export class Tasks{
 #store:TaskStore;#options:Options;#observers=new Map<string,Observer>();
 // Open the database at path (':memory:' for tests) and fail the deliveries that a crash left sending.
 constructor(path:string,options:Options){
  this.#store=new TaskStore(path);this.#options=options;
  this.#store.tx(()=>{for(const d of this.#store.inState('sending')){d.state='failed';d.error='interrupted';this.#store.saveDelivery(d);this.#log(d.task,'delivery.failed',{delivery:d.id,error:'interrupted'});}});
 }
 // The injected clock.
 #now(){return this.#options.now();}
 // Append a journal record of a task at the current time.
 #log(task:string,type:string,data:Record<string,unknown>){this.#store.append(task,this.#now(),type,data);}
 // Run fn in one transaction, then let observers see what it appended.
 #tx<T>(fn:()=>T):T{const r=this.#store.tx(fn);this.#wake();return r;}
 // The task with this id, or not_found.
 #task(id:string):Task{const t=this.#store.task(id);if(!t)throw fail('not_found','没有这个任务：'+id);return t;}
 // The task with this id when it is open, or ended.
 #open(id:string):Task{const t=this.#task(id);if(t.state!=='open')throw fail('ended','任务已结束：'+id);return t;}
 // The delivery with this id, or not_found.
 #delivery(id:string):Delivery{const d=this.#store.delivery(id);if(!d)throw fail('not_found','没有这个交付：'+id);return d;}
 // Insert an input and journal it; callers hold the transaction.
 #putInput(task:string,body:unknown,ref:string|null,delivery:string|null):Input{
  const i:Input={id:randomUUID(),task,body,ref,delivery,at:this.#now()};
  this.#store.addInput(i);this.#log(task,'input.added',{input:i.id,ref,delivery});return i;
 }

 // Open a task with a goal and optional first inputs.
 create(goal:string,inputs:{body:unknown,ref?:string}[]=[]):Task{
  if(typeof goal!=='string'||!goal.trim())throw fail('bad_input','goal 不能为空');
  return this.#tx(()=>{
   const t:Task={id:randomUUID(),goal,state:'open',pendingEnd:null,createdAt:this.#now()};
   this.#store.addTask(t);this.#log(t.id,'task.created',{goal});
   for(const i of inputs)this.#addInput(t.id,i.body,i.ref);
   return t;
  });
 }
 // Change the goal; the old and the new text are journaled.
 setGoal(id:string,goal:string):Task{
  if(typeof goal!=='string'||!goal.trim())throw fail('bad_input','goal 不能为空');
  return this.#tx(()=>{const t=this.#task(id);this.#log(id,'goal.changed',{from:t.goal,to:goal});t.goal=goal;this.#store.saveTask(t);return t;});
 }
 // Add an input unless its ref is already one of the task, in which case that one is returned.
 #addInput(task:string,body:unknown,ref?:string):Input{
  if(ref!==undefined){const old=this.#store.inputByRef(task,ref);if(old)return old;}
  return this.#putInput(task,body,ref??null,null);
 }
 // Add an input, also to an ended task. A ref that is already an input of the task returns that input and changes nothing.
 addInput(id:string,body:unknown,ref?:string):Input{return this.#tx(()=>{this.#task(id);return this.#addInput(id,body,ref);});}
 // Record an output the task produced.
 addOutput(id:string,body:unknown):Output{
  return this.#tx(()=>{this.#open(id);const o:Output={id:randomUUID(),task:id,body,at:this.#now()};this.#store.addOutput(o);this.#log(id,'output.added',{output:o.id});return o;});
 }

 // Write a delivery in its new state in one transaction. A task target is delivered at once, adding the input in the same transaction.
 #enter(d:Delivery,state:DeliveryState,data:Record<string,unknown>={}):Delivery{
  return this.#tx(()=>{
   d.state=state==='sending'&&'task' in d.target?'delivered':state;
   this.#store.saveDelivery(d);
   this.#log(d.task,'delivery.'+d.state,{delivery:d.id,output:d.output,target:d.target,...data,...d.state==='delivered'&&{receipt:d.receipt},...d.state==='failed'&&{error:d.error}});
   if('task' in d.target&&d.state==='delivered'){this.#task(d.target.task);this.#putInput(d.target.task,d.body,null,d.id);}
   return d;
  });
 }
 // Send a delivery that is now sending to its sink and record how it ended.
 async #transmit(d:Delivery):Promise<Delivery>{
  if(d.state!=='sending')return d;
  const target=d.target as {sink:string,to:unknown},sink=this.#options.sinks[target.sink];
  try{if(!sink)throw fail('unknown_sink','没有这个 sink：'+target.sink);d.receipt=await sink.send(target.to,d.body,d.key);d.error=null;return this.#enter(d,'delivered');}
  catch(e){d.receipt=null;d.error=text(e);return this.#enter(d,'failed');}
 }
 // Apply the policy to a delivery and move it to the matching state (sending runs the sink).
 async #route(d:Delivery,task:Task,output:Output):Promise<Delivery>{
  const v=this.#options.policy.deliver(task,output,d.target);
  const state:DeliveryState=v==='deny'?'rejected':v==='approve'?'awaiting':'sending';
  return this.#transmit(this.#enter(d,state,{policy:v}));
 }
 // Hand an output to a target. The same output and target while an earlier delivery is awaiting, sending or delivered returns that one.
 async deliver(outputId:string,target:Target):Promise<Delivery>{
  const output=this.#store.output(outputId);if(!output)throw fail('not_found','没有这个输出：'+outputId);
  const task=this.#open(output.task);
  if('sink' in target){if(!this.#options.sinks[target.sink])throw fail('unknown_sink','没有这个 sink：'+target.sink);}
  else this.#task(target.task);
  const live=this.#store.deliveriesOf(outputId,target).find(x=>x.state==='awaiting'||x.state==='sending'||x.state==='delivered');
  if(live)return live;
  const d:Delivery={id:randomUUID(),task:task.id,output:outputId,target,body:output.body,key:randomUUID(),state:'awaiting',receipt:null,error:null,createdAt:this.#now()};
  return this.#route(d,task,output);
 }
 // Settle a delivery that awaits approval. A body that differs from the current one replaces it under a new key.
 async decide(deliveryId:string,approve:boolean,body?:unknown,note?:string):Promise<Delivery>{
  const d=this.#delivery(deliveryId);this.#open(d.task);
  if(d.state!=='awaiting')throw fail('bad_state','这个交付不在等待批准：'+d.state);
  const data={decision:approve?'approved':'rejected',...note!==undefined&&{note}};
  if(!approve)return this.#enter(d,'rejected',data);
  if(body!==undefined&&!same(body,d.body)){d.body=body;d.key=randomUUID();}
  return this.#transmit(this.#enter(d,'sending',data));
 }
 // Take back a delivery that awaits approval, for the task that made it: it ends rejected, as a rejecting decision leaves it, so that there
 // is one state of an output that was not handed over, and the journal records the decision as withdrawn.
 withdraw(deliveryId:string,note?:string):Delivery{
  const d=this.#delivery(deliveryId);this.#open(d.task);
  if(d.state!=='awaiting')throw fail('bad_state','这个交付不在等待批准：'+d.state);
  return this.#enter(d,'rejected',{decision:'withdrawn',...note!==undefined&&{note}});
 }
 // Try a failed delivery again with its key, through the policy.
 async retry(deliveryId:string):Promise<Delivery>{
  const d=this.#delivery(deliveryId),task=this.#open(d.task);
  if(d.state!=='failed')throw fail('bad_state','只有失败的交付能重试：'+d.state);
  return this.#route(d,task,this.#store.output(d.output)!);
 }

 // Throw pending when an output of the task is still on its way.
 #settledOrThrow(id:string){if(this.#store.deliveries(id).some(d=>d.state==='awaiting'||d.state==='sending'))throw fail('pending','还有交付没有完成');}
 // End a task inside the caller's transaction: achieved needs no unsettled delivery, dropped rejects the awaiting ones.
 #finish(t:Task,outcome:Outcome,reason:string,data:Record<string,unknown>={}){
  if(outcome==='achieved')this.#settledOrThrow(t.id);
  if(outcome==='dropped')for(const d of this.#store.deliveries(t.id))if(d.state==='awaiting'){d.state='rejected';this.#store.saveDelivery(d);this.#log(t.id,'delivery.rejected',{delivery:d.id,output:d.output,target:d.target,reason:'dropped'});}
  t.state=outcome;t.pendingEnd=null;this.#store.saveTask(t);this.#log(t.id,'task.ended',{outcome,reason,...data});
 }
 // End a task as achieved or dropped, through the policy: allow ends it, approve keeps it open with a pending end, deny refuses.
 end(id:string,outcome:Outcome,reason:string):Task{
  const denied=this.#store.tx(()=>{
   const t=this.#open(id);if(t.pendingEnd)throw fail('bad_state','已有等待批准的结束');
   if(outcome==='achieved')this.#settledOrThrow(id);
   const v=this.#options.policy.end(t,outcome,reason);
   if(v==='deny'){this.#log(id,'end.denied',{outcome,reason});return true;}
   if(v==='approve'){t.pendingEnd={outcome,reason};this.#store.saveTask(t);this.#log(id,'end.requested',{outcome,reason});}else this.#finish(t,outcome,reason);
   return false;
  });
  this.#wake();
  if(denied)throw fail('denied','策略不允许结束这个任务');
  return this.#task(id);
 }
 // Settle an end that awaits approval; approving ends the task as requested, rejecting keeps it open.
 decideEnd(id:string,approve:boolean,note?:string):Task{
  return this.#tx(()=>{
   const t=this.#open(id),p=t.pendingEnd;if(!p)throw fail('bad_state','没有等待批准的结束');
   const data={decision:approve?'approved':'rejected',...note!==undefined&&{note}};
   if(approve)this.#finish(t,p.outcome,p.reason,data);
   else{t.pendingEnd=null;this.#store.saveTask(t);this.#log(id,'end.rejected',{...p,...data});}
   return t;
  });
 }
 // Reopen an ended task.
 reopen(id:string,reason:string):Task{
  return this.#tx(()=>{
   const t=this.#task(id);if(t.state==='open')throw fail('bad_state','任务没有结束');
   t.state='open';this.#store.saveTask(t);this.#log(id,'task.reopened',{reason});return t;
  });
 }

 // One task with its inputs, outputs and deliveries.
 get(id:string):TaskView{return {...this.#task(id),inputs:this.#store.inputs(id),outputs:this.#store.outputs(id),deliveries:this.#store.deliveries(id)};}
 // The journal of a task, optionally only the records after a seq.
 journal(id:string,after=0):JournalRecord[]{this.#task(id);return this.#store.journal(id,after);}
 // The tasks, optionally of one state.
 list(state?:TaskState):Task[]{return this.#store.tasks(state);}

 // Register a named observer. It gets every record after its persisted cursor (a new name: after the latest), one at a time and in order;
 // a handler that throws gets the same record again on the next append or observe. Returns a function that stops it.
 observe(name:string,handler:Handler):()=>void{
  if(this.#store.cursor(name)===undefined)this.#store.setCursor(name,this.#store.lastSeq());
  const o:Observer={name,handler,running:null};this.#observers.set(name,o);this.#pump(o);
  return ()=>{if(this.#observers.get(name)===o)this.#observers.delete(name);};
 }
 // Let every observer look for new records.
 #wake(){for(const o of this.#observers.values())this.#pump(o);}
 // Start draining the journal for an observer unless a drain is running.
 #pump(o:Observer){if(!o.running)o.running=this.#drain(o);}
 // Hand records to one observer until none are left or the handler throws; it first yields once so that #pump has stored the promise that its finally clears, and running is cleared synchronously on the way out.
 async #drain(o:Observer):Promise<void>{
  await Promise.resolve();
  try{
   while(this.#observers.get(o.name)===o){
    const r=this.#store.next(this.#store.cursor(o.name)!);if(!r)return;
    try{await o.handler(r);}catch{return;}
    if(this.#observers.get(o.name)===o)this.#store.setCursor(o.name,r.seq);
   }
  }finally{o.running=null;}
 }
 // Resolve when every observer has caught up with the journal or stopped on a throwing handler.
 async settled():Promise<void>{while(true){const run=[...this.#observers.values()].map(o=>o.running).filter(Boolean);if(!run.length)return;await Promise.all(run);}}
 // Wait for observers to settle, then close the database.
 async close():Promise<void>{await this.settled();this.#observers.clear();this.#store.close();}
}
