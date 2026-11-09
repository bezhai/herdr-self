// The one WebSocket between the control plane and the client of a machine (see clients.ts and client.ts) carries requests both ways,
// several at a time, each a JSON text frame. A request is {id, method, params}; its answer has the same id and {result} or
// {error:{message, code}}. Each side numbers its own requests, so a frame with a method is a request of the other side and one without
// is the answer to a request of this side. It uses only addEventListener, send and readyState, which Node's WebSocket on the client and
// the ws package on the control plane both have, and imports only types: the client runs without node_modules.

import type {Kind,PermissionMode,WorkMode} from './state.ts';
// The version of what the two sides send each other. The control plane refuses a client of another version (see Clients.hello). 2: the
// client passes the requests of bridge-schedule on (schedules), which a client of 1 has no socket for. 3: the control plane does everything
// it does on a machine through its client (see machine.ts), whose methods a client of 2 lacks. 4: placeSkills takes the skills of the
// platform one by one, keeps each in the store on its own and takes away those no longer loaded by default, where a client of 3 takes
// one bundle with one digest; the client passes the reads of bridge-skill on (skills) and puts a skill read into its store (stockSkill). 5: the
// client prepares the workspace of a topic, launches agents and inspects directories for projects (see ClientApi), and nameBranch is
// askCheapModel. 6: the control plane asks the model itself, so askCheapModel is gone, and describeRepos returns the READMEs instead of a description.
export const protocol=6;
// Close codes with which the control plane refuses or ends a client connection; a short reason goes with each, and the client logs both.
export const closeCodes={token:4001,version:4002,host:4003,replaced:4004,hello:4005};
// What one side may ask of the other: the params of each method and what it resolves to. A side's methods (see link) are async functions
// of the params.
export type Api={[method:string]:{params:object,result:unknown}};
export type Methods<A extends Api>={[K in keyof A]:(params:A[K]['params'])=>A[K]['result']|Promise<A[K]['result']>};
// What a command on a machine resolves to whatever its exit status; code is null when a signal ended it.
export type Ran={code:number|null,stdout:string,stderr:string};
// An argument of the Herdr CLI: a string passed as it is, or {path} for a path of the machine.
export type HerdrArg=string|{path:string};
// A skill as it goes to a machine: its name, the digest of its files and the files, {relative path: base64}.
export type SkillFiles={name:string,digest:string,files:Record<string,string>};
// A project as the client needs it to prepare or remove the workspace of a topic: its id, the URLs of its repositories (none for a project
// without any), how its topics share their directory, and the directory that the project adopted on this machine, if it did.
export type WorkspaceProject={id:string,repos:string[],workMode:WorkMode,adoptedDir?:string};
// What the control plane asks of the client of a machine (see machine.ts). A request carries timeoutMs, the most that a command it runs
// may take (see Clients.call), except the heartbeat's ping.
type Timed<P>=P&{timeoutMs?:number};
export type ClientApi={
 ping:{params:{},result:{}},
 herdr:{params:Timed<{session:string,args:readonly HerdrArg[]}>,result:Ran},
 storeFile:{params:Timed<{root:string,dir:string,name:string,body:string}>,result:string},
 removeDirectory:{params:Timed<{path:string}>,result:{}},
 inspectDirectory:{params:Timed<{path:string}>,result:{origin:string|null}},
 // inspectDirectory: the origin URL of the repository whose root path is, null when path is no root or the repository has no origin.
 // The following four are the machine side of projects, where the paths on the machine are the client's business and the control plane never
 // builds one. They take long (a clone, a fetch, a model), so callers give them a timeoutMs of minutes.
 // prepareWorkspace: the directory in which the agent of topic topicId starts, once it exists. A project with an adoptedDir works in that
 // directory as it is, whatever its repos and work mode. Otherwise, shared: the project's fixed directory, with each repo checked out in it,
 // cloned when missing; isolated: a directory of this topic, with a worktree of each repo in it on branch (the branch is given for a project with
 // repos), made from origin: it fetches, checks out the existing branch or else creates it from the default branch of origin. A project without
 // repos gets an empty directory, fixed when shared and of this topic when isolated. It can be called again for a topic that has its
 // workspace, as the way to restore one whose worktrees were removed: what exists stays, what is missing is recreated from the branch.
 // dir is the worktree or checkout itself for a project of one repo (not adopted), else the directory that holds them; a shared project
 // fetches the checkouts it has and never changes them, and an adoptedDir is dir itself, in which only the missing repos are cloned.
 // removeWorkspace: removes what prepareWorkspace made for the topic (its directory and the worktrees in it), never the fixed directory of a
 // shared project or an adoptedDir. It deletes branch in each repo when the branch has no commit of its own (nothing beyond the default
 // branch) and keeps it otherwise; branchKept tells whether it kept the branch in any repo. Called again for a workspace that is gone, it
 // succeeds.
 // prepareLaunch: the setup that an agent of kind needs on this machine before it starts in dir: its trust of the directory (for Claude, the
 // trust of the main checkout of the repository that holds dir is registered, and a worktree follows its main checkout), and for Claude with
 // allowedCommands, the hook that lets only those commands through. It resolves to the extra arguments of the agent command (those after
 // the -- of `herdr agent start`) for model, permissionMode and the trust of Codex and Antigravity. Calling it again is fine.
 // describeRepos: the README of each repository, cloned when missing, up to 4000 characters, for the control plane to describe the project
 // from; a repository that cannot be cloned or has no README is left out, and it fails only when none is left.
 prepareWorkspace:{params:Timed<{project:WorkspaceProject,topicId:string,branch?:string}>,result:{dir:string}},
 removeWorkspace:{params:Timed<{project:WorkspaceProject,topicId:string,branch?:string}>,result:{branchKept:boolean}},
 prepareLaunch:{params:Timed<{kind:Kind,model?:string,permissionMode?:PermissionMode,allowedCommands?:string[],dir:string}>,result:{args:string[]}},
 describeRepos:{params:Timed<{repos:string[]}>,result:{readmes:{name:string,text:string}[]}},
 placeSkills:{params:Timed<{store:string,skills:SkillFiles[],dir:string,as:'link'|'copy',cwd:string}>,result:string[]},
 stockSkill:{params:Timed<{store:string,skill:SkillFiles}>,result:string},
};
// What the client of a machine asks of the control plane (see Clients): the hello with which its connection gets in, and the requests of
// bridge-schedule and bridge-skill, which the client passes on without looking into them (see serve in client.ts).
export type ControlApi={
 hello:{params:{protocol:number,host:string},result:{machine:{id:string,name:string},heartbeatMs:number}},
 schedules:{params:{op:string,body:unknown},result:unknown},
 skills:{params:{op:string,body:unknown},result:unknown},
};
// The other side of a link (see link).
export type Peer<Theirs extends Api>={call<K extends keyof Theirs&string>(method:K,params:Theirs[K]['params'],options?:{timeoutMs?:number}):Promise<Theirs[K]['result']>};
// What link needs of a WebSocket.
type Socket={addEventListener(type:'message',listener:(e:{data:unknown})=>void):void,addEventListener(type:'close',listener:()=>void):void,send(data:string):void,readyState:number};
const open=1;
// Links socket, whose requests go to methods: an object of async functions of the params that resolve to the result. A request for any
// other method is refused with the code unknown_method. call sends a request and resolves to its result; it rejects with the other side's
// error and its code, after timeoutMs (the error has timedOut), and when the connection closes before the answer or was not open.
// Mine are the methods of this side, Theirs those of the other.
export function link<Mine extends Api,Theirs extends Api>(socket:Socket,methods:Partial<Methods<Mine>>):Peer<Theirs>{
 // A result is the other side's JSON, received as it is.
 const pending=new Map<number,{resolve:(result:any)=>void,reject:(e:Error)=>void,timer:NodeJS.Timeout}>();let next=0;
 const send=(frame:object)=>{try{socket.send(JSON.stringify(frame));}catch{}};
 socket.addEventListener('message',async e=>{
  let f;try{f=JSON.parse(String(e.data));}catch{return;}
  if(typeof f?.method!=='string'){const p=pending.get(f?.id);if(p){pending.delete(f.id);clearTimeout(p.timer);if(f.error)p.reject(Object.assign(Error(f.error.message),{code:f.error.code}));else p.resolve(f.result);}return;}
  try{
   if(!Object.hasOwn(methods,f.method))throw Object.assign(Error('不支持的操作：'+f.method),{code:'unknown_method'});
   send({id:f.id,result:await methods[f.method]!(f.params??{})});
  }catch(err){send({id:f.id,error:{message:String(err?.message??err),...(err?.code&&{code:err.code})}});}
 });
 socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('连接已断开'));}pending.clear();});
 return {call(method,params,{timeoutMs=12000}={}){
  if(socket.readyState!==open)return Promise.reject(Error('连接已断开'));
  return new Promise((resolve,reject)=>{
   const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('请求超时：'+method),{timedOut:true}));},timeoutMs);
   pending.set(id,{resolve,reject,timer});send({id,method,params});
  });
 }};
}
