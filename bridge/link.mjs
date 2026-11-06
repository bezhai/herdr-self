// The one WebSocket between the control plane and the client of a machine (see clients.mjs and client.mjs) carries requests both ways,
// several at a time, each a JSON text frame. A request is {id, method, params}; its answer has the same id and {result} or
// {error:{message, code}}. Each side numbers its own requests, so a frame with a method is a request of the other side and one without
// is the answer to a request of this side. It uses only addEventListener, send and readyState, which Node's WebSocket on the client and
// the ws package on the control plane both have, and imports nothing: the client runs without node_modules.

// The version of what the two sides send each other. The control plane refuses a client of another version (see Clients.hello). 2: the
// client passes the requests of bridge-schedule on (schedules), which a client of 1 has no socket for.
export const protocol=2;
// Close codes with which the control plane refuses or ends a client connection; a short reason goes with each, and the client logs both.
export const closeCodes={token:4001,version:4002,host:4003,replaced:4004,hello:4005};
const open=1;
// Links socket, whose requests go to methods: an object of async functions of the params that resolve to the result. A request for any
// other method is refused with the code unknown_method. call sends a request and resolves to its result; it rejects with the other side's
// error and its code, after timeoutMs (the error has timedOut), and when the connection closes before the answer or was not open.
export function link(socket,methods){
 const pending=new Map();let next=0;
 const send=frame=>{try{socket.send(JSON.stringify(frame));}catch{}};
 socket.addEventListener('message',async e=>{
  let f;try{f=JSON.parse(String(e.data));}catch{return;}
  if(typeof f?.method!=='string'){const p=pending.get(f?.id);if(p){pending.delete(f.id);clearTimeout(p.timer);if(f.error)p.reject(Object.assign(Error(f.error.message),{code:f.error.code}));else p.resolve(f.result);}return;}
  try{
   if(!Object.hasOwn(methods,f.method))throw Object.assign(Error('不支持的操作：'+f.method),{code:'unknown_method'});
   send({id:f.id,result:await methods[f.method](f.params??{})});
  }catch(err){send({id:f.id,error:{message:String(err?.message??err),...(err?.code&&{code:err.code})}});}
 });
 socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('连接已断开'));}pending.clear();});
 return {call(method,params={},{timeoutMs=12000}={}){
  if(socket.readyState!==open)return Promise.reject(Error('连接已断开'));
  return new Promise((resolve,reject)=>{
   const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('请求超时：'+method),{timedOut:true}));},timeoutMs);
   pending.set(id,{resolve,reject,timer});send({id,method,params});
  });
 }};
}
