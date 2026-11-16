import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import type {Task,Input,Output,Delivery,JournalRecord,TaskState} from './task-types.ts';
// The SQLite storage of the task core: tasks, inputs, outputs, deliveries, the journal and observer cursors. Content is stored as JSON text.
// It only reads and writes; every rule lives in task-core.ts. The path is given by the caller (':memory:' for tests).

// A row as node:sqlite returns it.
type Row=Record<string,any>;
// Content as JSON text (undefined stored as null).
const json=(v:unknown)=>JSON.stringify(v===undefined?null:v);
// The mappers from rows to the task types.
const task=(r:Row):Task=>({id:r.id,goal:r.goal,state:r.state,pendingEnd:r.pending_end===null?null:JSON.parse(r.pending_end),createdAt:r.created_at});
const input=(r:Row):Input=>({id:r.id,task:r.task,body:JSON.parse(r.body),ref:r.ref,delivery:r.delivery,at:r.at});
const output=(r:Row):Output=>({id:r.id,task:r.task,body:JSON.parse(r.body),at:r.at});
const delivery=(r:Row):Delivery=>({id:r.id,task:r.task,output:r.output,target:JSON.parse(r.target),body:JSON.parse(r.body),key:r.key,state:r.state,receipt:JSON.parse(r.receipt),error:r.error,createdAt:r.created_at});
const record=(r:Row):JournalRecord=>({seq:r.seq,task:r.task,at:r.at,type:r.type,data:JSON.parse(r.data)});
// The tables. Ordering of inputs, outputs and deliveries is their insertion order (rowid).
const schema=`
create table if not exists tasks(id text primary key,goal text not null,state text not null,pending_end text,created_at integer not null);
create table if not exists inputs(id text primary key,task text not null,body text not null,ref text,delivery text,at integer not null);
create unique index if not exists inputs_ref on inputs(task,ref) where ref is not null;
create table if not exists outputs(id text primary key,task text not null,body text not null,at integer not null);
create table if not exists deliveries(id text primary key,task text not null,output text not null,target text not null,body text not null,key text not null,state text not null,receipt text not null,error text,created_at integer not null);
create table if not exists journal(seq integer primary key autoincrement,task text not null,at integer not null,type text not null,data text not null);
create index if not exists journal_task on journal(task,seq);
create table if not exists cursors(name text primary key,seq integer not null);`;

// The database of the task core.
export class TaskStore{
 #db:DatabaseSync;
 constructor(path:string){this.#db=new DatabaseSync(path);this.#db.exec(schema);}
 // Run fn in one transaction: all its writes land together or not at all. Transactions do not nest.
 tx<T>(fn:()=>T):T{
  this.#db.exec('begin');
  try{const r=fn();this.#db.exec('commit');return r;}catch(e){this.#db.exec('rollback');throw e;}
 }
 #all(sql:string,...p:SQLInputValue[]):Row[]{return this.#db.prepare(sql).all(...p) as Row[];}
 #one(sql:string,...p:SQLInputValue[]):Row|undefined{return this.#db.prepare(sql).get(...p) as Row|undefined;}
 #run(sql:string,...p:SQLInputValue[]){this.#db.prepare(sql).run(...p);}
 // Insert a task.
 addTask(t:Task){this.#run('insert into tasks values(?,?,?,?,?)',t.id,t.goal,t.state,t.pendingEnd&&json(t.pendingEnd),t.createdAt);}
 // Read one task.
 task(id:string):Task|undefined{const r=this.#one('select * from tasks where id=?',id);return r&&task(r);}
 // List tasks in creation order, optionally of one state.
 tasks(state?:TaskState):Task[]{return (state?this.#all('select * from tasks where state=? order by rowid',state):this.#all('select * from tasks order by rowid')).map(task);}
 // Replace the mutable fields of a task.
 saveTask(t:Task){this.#run('update tasks set goal=?,state=?,pending_end=? where id=?',t.goal,t.state,t.pendingEnd&&json(t.pendingEnd),t.id);}
 // Insert an input.
 addInput(i:Input){this.#run('insert into inputs values(?,?,?,?,?,?)',i.id,i.task,json(i.body),i.ref,i.delivery,i.at);}
 // The input of a task with this ref, if any.
 inputByRef(taskId:string,ref:string):Input|undefined{const r=this.#one('select * from inputs where task=? and ref=?',taskId,ref);return r&&input(r);}
 // The inputs of a task.
 inputs(taskId:string):Input[]{return this.#all('select * from inputs where task=? order by rowid',taskId).map(input);}
 // Insert an output.
 addOutput(o:Output){this.#run('insert into outputs values(?,?,?,?)',o.id,o.task,json(o.body),o.at);}
 // Read one output.
 output(id:string):Output|undefined{const r=this.#one('select * from outputs where id=?',id);return r&&output(r);}
 // The outputs of a task.
 outputs(taskId:string):Output[]{return this.#all('select * from outputs where task=? order by rowid',taskId).map(output);}
 // Insert or replace a delivery.
 saveDelivery(d:Delivery){this.#run('insert or replace into deliveries values(?,?,?,?,?,?,?,?,?,?)',d.id,d.task,d.output,json(d.target),json(d.body),d.key,d.state,json(d.receipt),d.error,d.createdAt);}
 // Read one delivery.
 delivery(id:string):Delivery|undefined{const r=this.#one('select * from deliveries where id=?',id);return r&&delivery(r);}
 // The deliveries of a task.
 deliveries(taskId:string):Delivery[]{return this.#all('select * from deliveries where task=? order by rowid',taskId).map(delivery);}
 // The deliveries of one output to one target (target compared as JSON text).
 deliveriesOf(outputId:string,target:unknown):Delivery[]{return this.#all('select * from deliveries where output=? and target=? order by rowid',outputId,json(target)).map(delivery);}
 // Every delivery in a state, for crash recovery.
 inState(state:string):Delivery[]{return this.#all('select * from deliveries where state=? order by rowid',state).map(delivery);}
 // Append a journal record and return its seq.
 append(taskId:string,at:number,type:string,data:Record<string,unknown>):number{
  this.#run('insert into journal(task,at,type,data) values(?,?,?,?)',taskId,at,type,json(data));
  return Number((this.#one('select last_insert_rowid() as n') as Row).n);
 }
 // The journal of a task after a seq.
 journal(taskId:string,after=0):JournalRecord[]{return this.#all('select * from journal where task=? and seq>? order by seq',taskId,after).map(record);}
 // The seq of the latest record, 0 when empty.
 lastSeq():number{return Number((this.#one('select coalesce(max(seq),0) as n from journal') as Row).n);}
 // The cursor of an observer, if it has one.
 cursor(name:string):number|undefined{const r=this.#one('select seq from cursors where name=?',name);return r&&Number(r.seq);}
 // Set the cursor of an observer.
 setCursor(name:string,seq:number){this.#run('insert or replace into cursors values(?,?)',name,seq);}
 // The first record after a seq, for an observer.
 next(seq:number):JournalRecord|undefined{const r=this.#one('select * from journal where seq>? order by seq limit 1',seq);return r&&record(r);}
 // Close the database.
 close(){this.#db.close();}
}
