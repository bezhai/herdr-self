import crypto from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {WebSocketServer} from 'ws';
import type {WebSocket} from 'ws';
import {link,protocol,closeCodes} from './link.ts';
import type {ClientApi,ControlApi,Peer} from './link.ts';
import type {Store} from './core.ts';
import type {Machine} from './state.ts';
// The clients of the machines (see client.ts). Each dials the console's port at /api/client with its machine's token in an
// Authorization header and stays connected over one WebSocket (see link.ts). A token is shown once, when the console generates it; the
// machine keeps only its SHA-256 (tokenHash), and a new token drops the connection that used the old one. A connection gets in after a
// hello with the client's protocol version; one of another version is refused, and the machine shows why until a client gets in. A
// machine has one client at a time: a newer one that gets in replaces the older, which then stops (see client.ts), so a restarted
// client takes over at once instead of after the old connection times out. Whatever the control plane refuses or ends, it does with a
// close code and a short reason (see closeCodes) that the client logs, never with a plain HTTP error that it could not see. What a client
// asks of the control plane (see methods) is for the machine of its connection: the token proves the machine, and nothing the client
// sends can name another. What the control plane does on a machine goes to the client of that machine (see call).
const digest=(token:string)=>crypto.createHash('sha256').update(String(token)).digest();
const same=(a:Buffer,b:Buffer)=>a.length===b.length&&crypto.timingSafeEqual(a,b);
const offline=(m:Machine)=>Object.assign(Error(`机器 ${m.name} 离线：它的 Bridge 客户端没有连上`),{code:'client_offline'});
// What a client may ask of the control plane besides its hello, as functions of the machine of its connection and the params.
export type Asked={[K in Exclude<keyof ControlApi,'hello'>]?:(m:Machine,params:ControlApi[K]['params'])=>ControlApi[K]['result']|Promise<ControlApi[K]['result']>};
type Options={allowedHost?:(req:IncomingMessage)=>boolean,methods?:Asked,joined?:(m:Machine)=>void,heartbeatMs?:number,helloMs?:number,graceMs?:number};
// The client of a machine that is in, on WebSocket ws.
type Live={ws:WebSocket,peer:Peer<ClientApi>,name:string,host:string,since:number};
// The connection of a machine's client as the console shows it (see status).
export type ClientStatus={state:'online',host:string,since:number}|{state:'refused',error:string}|{state:'offline'};
export class Clients{
 declare store:Store;declare allowedHost:NonNullable<Options['allowedHost']>;declare methods:Asked;declare joined:NonNullable<Options['joined']>;
 declare heartbeatMs:number;declare helloMs:number;declare graceMs:number;declare live:Map<string,Live>;declare refusals:Map<string,string>;
 declare server:WebSocketServer;declare timer:NodeJS.Timeout;
 // allowedHost(req): whether the Host of the request is one the console answers to. methods: what a client may ask of the control
 // plane once it said hello, by name (see link.ts): functions of the machine of its connection, as the state has it then, and the params.
 // Every heartbeatMs the control plane pings each client, which must answer within the next heartbeatMs; a connection must say hello within
 // helloMs. joined(m) is called with the machine of each client that got in. A request of call waits graceMs longer than its timeout.
 constructor(store:Store,{allowedHost=()=>true,methods={},joined=()=>{},heartbeatMs=15000,helloMs=10000,graceMs=5000}:Options={}){
  Object.assign(this,{store,allowedHost,methods,joined,heartbeatMs,helloMs,graceMs});this.live=new Map();this.refusals=new Map();this.server=new WebSocketServer({noServer:true});
  this.timer=setInterval(()=>{for(const c of this.live.values())c.peer.call('ping',{},{timeoutMs:heartbeatMs}).catch(e=>{if(e.timedOut)c.ws.terminate();});},heartbeatMs);
 }
 // Makes a new token for machine m and returns it, keeping only its hash; the client that used the old one is dropped.
 issue(m:Machine){
  const token=crypto.randomBytes(32).toString('base64url');m.tokenHash=digest(token).toString('hex');this.store.save();
  this.drop(m.id,'token 已重新生成');this.refusals.delete(m.id);this.store.log('机器连接',m.name+'：生成了新的客户端 token，旧 token 已失效');return token;
 }
 machineOf(token:string){const d=digest(token);return this.store.data.machines.find(m=>m.tokenHash&&same(Buffer.from(m.tokenHash,'hex'),d));}
 // Sends the request method with params to the client of machine m and resolves to its answer (see machine.ts). params get timeoutMs,
 // which the client gives what it runs for the request, and the request waits graceMs longer for the answer. Rejects at once with the code
 // client_offline while no client of m is in, with the error of the client and its code, and when the connection ends before the answer.
 // A request that ran out of time, on either side, rejects with timedOut.
 call<K extends keyof ClientApi>(m:Machine,method:K,params:ClientApi[K]['params'],{timeoutMs=12000}={}):Promise<ClientApi[K]['result']>{
  const c=this.live.get(m.id);if(!c)return Promise.reject(offline(m));
  return c.peer.call(method,{...params,timeoutMs},{timeoutMs:timeoutMs+this.graceMs}).catch(e=>{throw e.code==='timed_out'?Object.assign(e,{timedOut:true}):e;});
 }
 online(id:string){return this.live.has(id);}
 // online with the host the client runs on and since when; else refused with why its last hello failed; else offline.
 status(id:string):ClientStatus{const c=this.live.get(id);if(c)return {state:'online',host:c.host,since:c.since};const error=this.refusals.get(id);return error?{state:'refused',error}:{state:'offline'};}
 // The http server's upgrade event: only /api/client becomes a WebSocket. Neither the socket of an upgrade request nor a WebSocket of
 // the ws package has a listener for its error event, which would then end the process: a peer that resets the connection or sends a
 // frame no client may send is only disconnected, and ws closes the WebSocket itself.
 upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){
  // A request that a server received has its url.
  if(new URL(req.url!,'http://localhost').pathname!=='/api/client'){socket.on('error',()=>{});socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  this.server.handleUpgrade(req,socket,head,ws=>{
   ws.on('error',()=>{});
   if(!this.allowedHost(req))return ws.close(closeCodes.host,'不允许的 Host');
   const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
   if(!this.machineOf(token))return ws.close(closeCodes.token,'token 无效');
   const asked=Object.fromEntries(Object.entries(this.methods).map(([name,f])=>[name,(params:ControlApi[keyof Asked]['params'])=>f(this.machineOn(ws),params)]));
   const timer=setTimeout(()=>ws.close(closeCodes.hello,'没有及时完成握手'),this.helloMs),peer:Peer<ClientApi>=link<ControlApi,ClientApi>(ws,{...asked,hello:params=>{clearTimeout(timer);return this.hello(token,ws,peer,params);}});
   ws.on('close',()=>{clearTimeout(timer);const id=this.idOn(ws);if(id==null)return;this.store.log('机器连接',this.live.get(id)!.name+' 的客户端已断开');this.live.delete(id);});
  });
 }
 // The token is looked up again: a new token, or the machine's removal, may have come since the upgrade.
 hello(token:string,ws:WebSocket,peer:Peer<ClientApi>,{protocol:version,host}:ControlApi['hello']['params']){
  const m=this.machineOf(token);if(!m){ws.close(closeCodes.token,'token 无效');throw Error('token 无效');}
  if(this.idOn(ws)!=null)throw Error('已经完成握手');
  if(version!==protocol){
   const reason=`版本不一致：控制面协议 ${protocol}，客户端协议 ${Number.isSafeInteger(version)?version:'未知'}`;
   if(this.refusals.get(m.id)!==reason)this.store.log('机器连接',`${m.name}：客户端被拒绝，${reason}`,'error');
   this.refusals.set(m.id,reason);ws.close(closeCodes.version,reason);throw Error(reason);
  }
  const old=this.live.get(m.id),c:Live={ws,peer,name:m.name,host:typeof host==='string'?host.slice(0,100):'',since:Date.now()};
  this.live.set(m.id,c);this.refusals.delete(m.id);old?.ws.close(closeCodes.replaced,'这台机器的另一个客户端已连接');
  this.store.log('机器连接',`${m.name} 的客户端已连接（${c.host}）${old?'，替换了之前的连接':''}`);this.joined(m);
  return {machine:{id:m.id,name:m.name},heartbeatMs:this.heartbeatMs};
 }
 // The id of the machine whose client is in on ws, if any.
 idOn(ws:WebSocket){for(const [id,c] of this.live)if(c.ws===ws)return id;}
 // The machine of the client on ws; throws before its hello, and once the machine is removed.
 machineOn(ws:WebSocket){
  const id=this.idOn(ws);if(id==null)throw Error('客户端还没有完成握手');
  const m=this.store.data.machines.find(x=>x.id===id);if(!m)throw Error('机器连接不存在');return m;
 }
 drop(id:string,reason:string){this.live.get(id)?.ws.close(closeCodes.token,reason);}
 // Drops the client of a machine that is being removed.
 remove(id:string){this.drop(id,'机器已移除');this.refusals.delete(id);}
 close(){clearInterval(this.timer);for(const c of this.live.values())c.ws.close(1001,'控制面正在停止');}
}
