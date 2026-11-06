import crypto from 'node:crypto';
import {WebSocketServer} from 'ws';
import {link,protocol,closeCodes} from './link.mjs';
// The clients of the machines (see client.mjs). Each dials the console's port at /api/client with its machine's token in an
// Authorization header and stays connected over one WebSocket (see link.mjs). A token is shown once, when the console generates it; the
// machine keeps only its SHA-256 (tokenHash), and a new token drops the connection that used the old one. A connection gets in after a
// hello with the client's protocol version; one of another version is refused, and the machine shows why until a client gets in. A
// machine has one client at a time: a newer one that gets in replaces the older, which then stops (see client.mjs), so a restarted
// client takes over at once instead of after the old connection times out. Whatever the control plane refuses or ends, it does with a
// close code and a short reason (see closeCodes) that the client logs, never with a plain HTTP error that it could not see.
const digest=token=>crypto.createHash('sha256').update(String(token)).digest();
const same=(a,b)=>a.length===b.length&&crypto.timingSafeEqual(a,b);
export class Clients{
 // allowedHost(req): whether the Host of the request is one the console answers to. Every heartbeatMs the control plane pings each
 // client, which must answer within the next heartbeatMs; a connection must say hello within helloMs.
 constructor(store,{allowedHost=()=>true,heartbeatMs=15000,helloMs=10000}={}){
  Object.assign(this,{store,allowedHost,heartbeatMs,helloMs});this.live=new Map();this.refusals=new Map();this.server=new WebSocketServer({noServer:true});
  this.timer=setInterval(()=>{for(const c of this.live.values())c.peer.call('ping',{},{timeoutMs:heartbeatMs}).catch(e=>{if(e.timedOut)c.ws.terminate();});},heartbeatMs);
 }
 // Makes a new token for machine m and returns it, keeping only its hash; the client that used the old one is dropped.
 issue(m){
  const token=crypto.randomBytes(32).toString('base64url');m.tokenHash=digest(token).toString('hex');this.store.save();
  this.drop(m.id,'token 已重新生成');this.refusals.delete(m.id);this.store.log('机器连接',m.name+'：生成了新的客户端 token，旧 token 已失效');return token;
 }
 machineOf(token){const d=digest(token);return this.store.data.machines.find(m=>m.tokenHash&&same(Buffer.from(m.tokenHash,'hex'),d));}
 // online with the host the client runs on and since when; else refused with why its last hello failed; else offline.
 status(id){const c=this.live.get(id);if(c)return {state:'online',host:c.host,since:c.since};const error=this.refusals.get(id);return error?{state:'refused',error}:{state:'offline'};}
 // The http server's upgrade event: only /api/client becomes a WebSocket. Neither the socket of an upgrade request nor a WebSocket of
 // the ws package has a listener for its error event, which would then end the process: a peer that resets the connection or sends a
 // frame no client may send is only disconnected, and ws closes the WebSocket itself.
 upgrade(req,socket,head){
  if(new URL(req.url,'http://localhost').pathname!=='/api/client'){socket.on('error',()=>{});socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  this.server.handleUpgrade(req,socket,head,ws=>{
   ws.on('error',()=>{});
   if(!this.allowedHost(req))return ws.close(closeCodes.host,'不允许的 Host');
   const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
   if(!this.machineOf(token))return ws.close(closeCodes.token,'token 无效');
   const timer=setTimeout(()=>ws.close(closeCodes.hello,'没有及时完成握手'),this.helloMs),peer=link(ws,{hello:params=>{clearTimeout(timer);return this.hello(token,ws,peer,params);}});
   ws.on('close',()=>{clearTimeout(timer);for(const [id,c] of this.live)if(c.ws===ws){this.live.delete(id);this.store.log('机器连接',c.name+' 的客户端已断开');}});
  });
 }
 // The token is looked up again: a new token, or the machine's removal, may have come since the upgrade.
 hello(token,ws,peer,{protocol:version,host}){
  const m=this.machineOf(token);if(!m){ws.close(closeCodes.token,'token 无效');throw Error('token 无效');}
  if([...this.live.values()].some(c=>c.ws===ws))throw Error('已经完成握手');
  if(version!==protocol){
   const reason=`版本不一致：控制面协议 ${protocol}，客户端协议 ${Number.isSafeInteger(version)?version:'未知'}`;
   if(this.refusals.get(m.id)!==reason)this.store.log('机器连接',`${m.name}：客户端被拒绝，${reason}`,'error');
   this.refusals.set(m.id,reason);ws.close(closeCodes.version,reason);throw Error(reason);
  }
  const old=this.live.get(m.id),c={ws,peer,name:m.name,host:typeof host==='string'?host.slice(0,100):'',since:Date.now()};
  this.live.set(m.id,c);this.refusals.delete(m.id);old?.ws.close(closeCodes.replaced,'这台机器的另一个客户端已连接');
  this.store.log('机器连接',`${m.name} 的客户端已连接（${c.host}）${old?'，替换了之前的连接':''}`);
  return {machine:{id:m.id,name:m.name},heartbeatMs:this.heartbeatMs};
 }
 drop(id,reason){this.live.get(id)?.ws.close(closeCodes.token,reason);}
 // Drops the client of a machine that is being removed.
 remove(id){this.drop(id,'机器已移除');this.refusals.delete(id);}
 close(){clearInterval(this.timer);for(const c of this.live.values())c.ws.close(1001,'控制面正在停止');}
}
