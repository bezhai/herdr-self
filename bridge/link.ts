// The one WebSocket between the control plane and the client of a machine (see clients.ts and client.ts) carries requests both ways,
// several at a time, each a JSON text frame. A request is {id, method, params}; its answer has the same id and {result} or
// {error:{message, code}}. Each side numbers its own requests, so a frame with a method is a request of the other side and one without
// is the answer to a request of this side. It uses only addEventListener, send and readyState, which Node's WebSocket on the client and
// the ws package on the control plane both have, and imports only types: the client runs without node_modules.

import type {Kind,PermissionMode,WorkMode,OwnerChat,Mention} from './state.ts';
// The version of what the two sides send each other. The control plane refuses a client of another version (see Clients.hello). 2: the
// client passes the requests of bridge-schedule on (schedules), which a client of 1 has no socket for. 3: the control plane does everything
// it does on a machine through its client (see machine.ts), whose methods a client of 2 lacks. 4: placeSkills takes the skills of the
// platform one by one, keeps each in the store on its own and takes away those no longer loaded by default, where a client of 3 takes
// one bundle with one digest; the client passes the reads of bridge-skill on (skills) and puts a skill read into its store (stockSkill). 5: the
// client prepares the workspace of a topic, launches agents and inspects directories for projects (see ClientApi), and nameBranch is
// askCheapModel. 6: the control plane asks the model itself, so askCheapModel is gone, and describeRepos returns the READMEs instead of a description.
// 7: the control plane keeps the store of skills of every machine in line with the platform (compareSkills, stockSkill, pruneSkills), which a
// client of 6 cannot answer. 8: the client of the machine that runs open-lark reads chats and messages of Feishu and sends messages as the
// owner (openLarkMessage, openLarkChat, openLarkReply, openLarkSend), and every client passes the requests of bridge-message on (messages). 9: every client passes the requests of bridge-task on (tasks).
// 10: a client offers the local HTTP services of its config by name (its hello names them) and performs a request of one for an agent
// (callService), and every client passes the requests of bridge-call on (services). 11: prepareLaunch takes the session of a finished topic
// to resume (resume) and answers whether its arguments resume it (resumed), which a client of 10 would ignore and start a new session.
// 12: the owner's channel sends images and files (openLarkImage, openLarkFile) and opens docs to a chat (openLarkDocAccess), reads whether a
// message is inside a thread (inThread) and replies into it (thread, threadRoot), which a client of 11 lacks or ignores; the client passes on
// requests of bridge-message of up to 72 MiB, which carry the images and files of a draft.
export const protocol=12;
// The kinds of agent whose sessions prepareLaunch can resume (see ClientApi), and so the only ones whose sessions a topic records (see
// Topics.keepSession). Antigravity is not one: agy --conversation <id> takes an id, but one it lacks starts a new conversation with only a
// warning on the screen, and where a conversation ran is in the binary records of its database alone, so no client can tell that it ran in
// the directory of the topic (agy 1.5.15, 2026-11-23).
export const resumableKinds:readonly Kind[]=['claude','codex'];
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
// A skill as the control plane lists it to a machine to compare: its name and the digest of its files.
export type SkillDigest={name:string,digest:string};
// A project as the client needs it to prepare or remove the workspace of a topic: its id, the URLs of its repositories (none for a project
// without any), how its topics share their directory, and the directory that the project adopted on this machine, if it did.
export type WorkspaceProject={id:string,repos:string[],workMode:WorkMode,adoptedDir?:string};
// A Feishu message as open-lark, the owner's Feishu client, reads it (see open-lark.ts): a chat, an open-lark id, the sender, when it was sent (ms) and what it says as
// text, where what is not text is written as [图片] or [文件] <file name>, link, a link that opens it in Feishu, when open-lark gives one, and
// inThread, true for a reply inside a thread (in a topic group, inside a topic); the root of a thread is not inside it.
export type OwnerMessage=OwnerChat&{messageId:string,sender:{id:string,name:string},at:number,text:string,link?:string,inThread?:boolean};
// A message that went out as the owner: its open-lark id, when it was sent, in ms, owner, the name of the Feishu account it went out as, and
// threadRoot, the open-lark id of the root of the thread that a reply went into.
export type Sent={messageId:string,at:number,owner:string,threadRoot?:string};
// What became of the access asked for one doc that open-lark found in a sent message: its url and title, and granted, whether the chat has the
// role now (also when it had it before), else reason, why not.
export type DocGrant={url:string,title:string,granted:boolean,reason?:string};
// A request of an agent to a service of a machine (see services.ts): service, the name of the service; method; path, relative to the root of the
// service, with no query or fragment; query, its pairs; body, the JSON text of a POST, PUT or PATCH (the client sends {} when there is none); and
// headers, the request headers that the service lets an agent pass, by lower-case name. It carries no credential: the client of the machine that
// offers the service builds the request itself.
export type ServiceRequest={service:string,method:string,path:string,query?:[string,string][],body?:string,headers?:Record<string,string>};
// What the service answered: status, contentType, and the body, as text when it is text (encoding text) and else base64 of its bytes.
export type ServiceAnswer={status:number,contentType:string,encoding:'text'|'base64',body:string};
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
 // the -- of `herdr agent start`) for model, permissionMode and the trust of Codex and Antigravity. Calling it again is fine. resume is the id
 // of an agent session to resume: the arguments resume it, and resumed is true, when kind is one of resumableKinds and this machine has
 // that session as one that ran in dir; otherwise they are those without resume, and resumed is false.
 // describeRepos: the README of each repository, cloned when missing, up to 4000 characters, for the control plane to describe the project
 // from; a repository that cannot be cloned or has no README is left out, and it fails only when none is left.
 prepareWorkspace:{params:Timed<{project:WorkspaceProject,topicId:string,branch?:string}>,result:{dir:string}},
 removeWorkspace:{params:Timed<{project:WorkspaceProject,topicId:string,branch?:string}>,result:{branchKept:boolean}},
 prepareLaunch:{params:Timed<{kind:Kind,model?:string,permissionMode?:PermissionMode,allowedCommands?:string[],dir:string,resume?:string}>,result:{args:string[],resumed:boolean}},
 describeRepos:{params:Timed<{repos:string[]}>,result:{readmes:{name:string,text:string}[]}},
 placeSkills:{params:Timed<{store:string,skills:SkillFiles[],dir:string,as:'link'|'copy',cwd:string}>,result:string[]},
 stockSkill:{params:Timed<{store:string,skill:SkillFiles}>,result:string},
 // compareSkills: the names of those of skills that the store lacks or holds with another digest, from which the control plane sends those
 // with stockSkill, one at a time. pruneSkills: takes away the skills of the store that Bridge put there (those with its marker) and that
 // are not in names; it resolves to the names it took away. Together they keep the store in line with the platform (see Skills.sync).
 compareSkills:{params:Timed<{store:string,skills:SkillDigest[]}>,result:{stale:string[]}},
 pruneSkills:{params:Timed<{store:string,names:string[]}>,result:{removed:string[]}},
 // The owner's channel: open-lark, on the machine that runs it (see open-lark.ts), with its ids, which are not those of the open platform.
 // openLarkMessage reads message messageId, and openLarkChat chat chatId. openLarkReply sends a reply that quotes message messageId in its
 // chat, inside the thread of that message when thread is true, and openLarkSend a message to chat chatId: text as the owner, with @<name> in it for each of mentions, under clientId, a UUID with
 // which open-lark sends one message at most however often it is asked, keeping the text of the first request. They reject with code
 // channel_unconfigured on a machine whose client has no open-lark in its config, which is not one that is offline; channel_unreachable when
 // open-lark could not be reached or did not answer within timeoutMs, when a send may or may not have gone out; channel_refused when it
 // answered with an error, whose explanation is the message; invalid_params for params that are not as here.
 openLarkMessage:{params:Timed<{messageId:string}>,result:OwnerMessage},
 openLarkChat:{params:Timed<{chatId:string}>,result:OwnerChat},
 openLarkReply:{params:Timed<{messageId:string,clientId:string,text:string,mentions:Mention[],thread?:boolean}>,result:Sent},
 openLarkSend:{params:Timed<{chatId:string,clientId:string,text:string,mentions:Mention[]}>,result:Sent},
 // openLarkImage sends an image (data, base64 of at most 10 MiB characters, of type mimeType) and openLarkFile a file (data, base64) to chat
 // chatId as the owner, as a reply to message replyTo when given: an image goes where a text reply would go (inside the thread of replyTo
 // when thread is true), a file inside the thread whose root is threadRoot when given, else as a quote reply. clientId is a UUID; open-lark
 // sends an image of one clientId once, but a file again on every request. messageId is null when open-lark did not name the file's message.
 // openLarkDocAccess gives chat of message messageId, a message the owner sent, the role on each doc that open-lark finds in it, one doc
 // at a time, and resolves to what became of each (see DocGrant); it rejects only when it could not list them.
 openLarkImage:{params:Timed<{chatId:string,clientId:string,name:string,mimeType:string,data:string,replyTo?:string,thread?:boolean}>,result:{messageId:string}},
 openLarkFile:{params:Timed<{chatId:string,clientId:string,name:string,data:string,replyTo?:string,threadRoot?:string}>,result:{messageId:string|null}},
 openLarkDocAccess:{params:Timed<{messageId:string,role:'view'|'edit'}>,result:{docs:DocGrant[]}},
// callService makes one request of the service request.service of the client's config with that service's token, and resolves to its answer,
// also when the status is an error. It rejects with code service_unknown for a name that the config lacks; method_not_allowed and
// header_not_allowed for a method or header that the service's config does not allow; invalid_params for a request that is not as
// ServiceRequest, or whose path leaves the root of the service; service_unreachable when the service did not answer within timeoutMs;
// response_too_large for an answer over 20 MB. Their messages are for the agent and carry no token.
 callService:{params:Timed<ServiceRequest>,result:ServiceAnswer},
};
// What the client of a machine asks of the control plane (see Clients): the hello with which its connection gets in, and the requests of
// bridge-schedule, bridge-skill, bridge-message, bridge-task and bridge-call, which the client passes on without looking into them (see serve in client.ts).
// The hello names the services of the client's config (services; the names only).
export type ControlApi={
 hello:{params:{protocol:number,host:string,services:string[]},result:{machine:{id:string,name:string},heartbeatMs:number}},
 schedules:{params:{op:string,body:unknown},result:unknown},
 skills:{params:{op:string,body:unknown},result:unknown},
 messages:{params:{op:string,body:unknown},result:unknown},
 tasks:{params:{op:string,body:unknown},result:unknown},
 services:{params:{op:string,body:unknown},result:unknown},
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
