// One model run at a time for the whole process: the processor's batches and the owner's conversation turns share the
// model machine. A turn goes ahead of the batches waiting, behind the turns already waiting; it never interrupts a run
// under way, so it waits for one batch at most. The processor asks the queue as it would ask the model.
export class ModelQueue{
 #waiting=[];#running;
 constructor(model){this.model=model;}
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
