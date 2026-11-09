// The one WebSocket between the control plane and the client of a machine (see clients.ts and client.ts) carries requests both ways,
// several at a time, each a JSON text frame. A request is {id, method, params}; its answer has the same id and {result} or
// {error:{message, code}}. Each side numbers its own requests, so a frame with a method is a request of the other side and one without
// is the answer to a request of this side. It uses only addEventListener, send and readyState, which Node's WebSocket on the client and
// the ws package on the control plane both have, and imports nothing: the client runs without node_modules.

// The version of what the two sides send each other. The control plane refuses a client of another version (see Clients.hello). 2: the
// client passes the requests of bridge-schedule on (schedules), which a client of 1 has no socket for. 3: the control plane does everything
// it does on a machine through its client (see machine.ts), whose methods a client of 2 lacks. 4: placeSkills takes the skills of the
// platform one by one, keeps each in the store on its own and takes away those no longer loaded by default, where a client of 3 takes
// one bundle with one digest; the client passes the reads of bridge-skill on (skills) and puts a skill read into its store (stockSkill).
export const protocol=4;
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
// What the control plane asks of the client of a machine (see machine.ts). A request carries timeoutMs, the most that a command it runs
// may take (see Clients.call), except the heartbeat's ping.
type Timed<P>=P&{timeoutMs?:number};
export type ClientApi={
 ping:{params:{},result:{}},
 herdr:{params:Timed<{session:string,args:readonly HerdrArg[]}>,result:Ran},
 mkdir:{params:Timed<{path:string}>,result:{}},
 storeFile:{params:Timed<{root:string,dir:string,name:string,body:string}>,result:string},
 removeDirectory:{params:Timed<{path:string}>,result:{}},
 git:{params:Timed<{cwd:string,args:string[]}>,result:Ran},
 exists:{params:Timed<{path:string}>,result:boolean},
 nameBranch:{params:Timed<{cwd:string,prompt:string}>,result:Ran},
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
