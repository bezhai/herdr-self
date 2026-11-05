// One model run at a time per queue. The processor's process has two: the batches, reviews, 关于TA and the owner's
// conversation turns share one, and grading (see grader.mjs) has the other, so that a grading pass of many runs holds
// none of them up; a run of each may go on at once, each a claude of its own on the model machine. On the first queue a
// turn goes ahead of the batches waiting, behind the turns already waiting; it never interrupts a run under way, so it
// waits for one batch at most. The processor and the grader ask a queue as they would ask the model.
export class ModelQueue{
 #waiting=[];#running;
 constructor(model){this.model=model;}
 // The name of the model it asks, for the run records (see Matters.recordRun).
 get name(){return this.model.name;}
 ask(input){return this.run(model=>model.ask(input));}
 cleanup(){return this.model.cleanup?.();}
 // fn(model) runs when its turn comes, holding the model until it settles. first: ahead of the batches; what: what
 // it is, for state().
 run(fn,{first=false,what='batch'}={}){
  return new Promise((resolve,reject)=>{
   const job={fn,first,what,resolve,reject},i=first?this.#waiting.findIndex(j=>!j.first):-1;
   if(i<0)this.#waiting.push(job);else this.#waiting.splice(i,0,job);
   this.#next();
  });
 }
 state(){return {running:this.#running?.what,waiting:this.#waiting.length};}
 #next(){
  if(this.#running||!this.#waiting.length)return;
  const job=this.#running=this.#waiting.shift();
  Promise.resolve().then(()=>job.fn(this.model)).then(job.resolve,job.reject).finally(()=>{this.#running=undefined;this.#next();});
 }
}
