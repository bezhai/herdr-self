import {oneOf,isRecord} from './core.ts';
import type {Store} from './core.ts';
import type {App,Machine,Topic} from './state.ts';
import type {Topics} from './topics.ts';
import type {Tasks} from './task-core.ts';
import type {Outcome} from './task-types.ts';
// The task of a topic as its agent ends it with bridge-task (see task-command.ts). The agent is known as it is to bridge-schedule and
// bridge-message: by the machine whose client passed its request on and by its pane (see Topics.caller). Only the agent can tell that the
// goal of the task is met, so it ends the task itself; the end is not applied here but recorded on the topic, because the agent usually
// writes a last reply after running the command, and that reply is an output of the task, which the core refuses once the task has ended.
// Topics.sync applies the end when the agent's turn has ended and its replies have gone out.
// What bridge-task sends through the client of its machine: how the task ends, why, and the agent's pane and session.
export type TaskRequest={outcome?:string,reason?:string,pane?:string,session?:string};
// What end resolves to, for bridge-task to print: the task, and how and why it is going to end.
export type EndAnswer={task:string,outcome:Outcome,reason:string};
const outcomes:readonly Outcome[]=['achieved','dropped'];
const ops=['end'] as const;
export type TaskOps={end:{request:TaskRequest,answer:EndAnswer}};
type Deps={topics:Pick<Topics,'queue'|'alive'|'caller'|'task'|'update'>,tasks:Pick<Tasks,'get'>,app:(id:string)=>App};
export class AgentTasks{
 declare store:Store;declare deps:Deps;
 // topics resolve the caller and keep its end request; tasks is the task core; app(id) returns an app or throws.
 constructor(store:Store,deps:Deps){this.store=store;this.deps=deps;}
 // Request op of the agent in pane pane of Herdr session session (default) on machine m, the machine whose client passed the request on.
 // Resolves to what the agent reads, and rejects with what to tell it.
 async call(m:Machine,op:string,request:unknown):Promise<EndAnswer>{
  if(!oneOf(ops,op))throw Error('未知的操作：'+op);
  if(!isRecord(request))throw Error('请求内容无效');
  const {outcome,reason}=request;
  if(!oneOf(outcomes,outcome))throw Error('结果无效，应为 achieved（已完成）或 dropped（已放弃）');
  if(typeof reason!=='string'||!reason.trim())throw Error('需要说明原因：用一两句话写结果，或者为什么放弃');
  const t=await this.deps.topics.caller(m,request,'bridge-task');
  return this.deps.topics.queue(t,()=>this.end(t,outcome,reason.trim()));
 }
 // In the queue of topic t: records the end on the topic, with the state_change_seq of the agent that asks, whose turn it ends with. The latest
 // request of a turn wins. A task that has ended cannot end again, and an achieved task has no draft waiting for the owner or still being sent.
 async end(t:Topic,outcome:Outcome,reason:string):Promise<EndAnswer>{
  const task=this.deps.topics.task(t),view=this.deps.tasks.get(task);
  if(view.state!=='open')throw Error('任务已经结束，不用再结束');
  if(outcome==='achieved'&&view.deliveries.some(d=>d.state==='awaiting'||d.state==='sending'))throw Error('还有草稿在等主人确认：等主人处理完再以 achieved 结束，或者主人说不要了就用 dropped');
  const agent=await this.deps.topics.alive(this.deps.app(t.appId),t);
  this.deps.topics.update(t,{endRequest:{outcome,reason,stateSeq:agent?.state_change_seq??null}});
  return {task,outcome,reason};
 }
}
