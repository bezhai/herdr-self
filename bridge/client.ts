import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {link,protocol,closeCodes} from './link.ts';
import {methods,loginEnvironment,stripped} from './machine.ts';
import type {ClientApi,ControlApi,Methods,Peer} from './link.ts';
import type {ScheduleOps} from './agent-schedules.ts';
import type {SkillReads} from './skills.ts';
import type {MessageOps} from './messages.ts';
import type {OpenLark} from './open-lark.ts';
// The Bridge client of a machine (bin/bridge-client.ts runs it, one per machine, as a user service). It dials the control plane at
// the url of its config with the machine's token and stays connected over one WebSocket (see link.ts and clients.ts), does on this
// machine what the control plane asks of it with a fixed set of methods (see machine.ts), and passes the requests of bridge-schedule,
// bridge-skill and bridge-message on this machine on to the control plane (see serve). It uses only Node's built-in modules, Node's own
// WebSocket among them, so a copy of the Bridge directory without node_modules runs it. It logs to stderr.

// The config file: BRIDGE_CLIENT_CONFIG, else herdr-bridge/client.json in the user's config directory.
export const configPath=(env=process.env)=>env.BRIDGE_CLIENT_CONFIG||path.join(env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'herdr-bridge','client.json');
// BRIDGE_URL: the console's public origin, http(s) without path, query or fragment; a trailing / is dropped. Unset means none. It is the
// origin that configText gives a client when the browser reached the console by another address.
export function consoleUrl(value:string|undefined){
 if(!value)return '';let u;try{u=new URL(value);}catch{}
 if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('BRIDGE_URL 应为 http(s) 地址，不带路径、查询参数和 #，例如 http://host:8080');
 return u.origin;
}
// The config file for a token, which the console shows once: the client endpoint of the control plane at origin, http(s)://host[:port].
export const configText=(origin:string,token:string)=>JSON.stringify({url:origin.replace(/^http/,'ws')+'/api/client',token},null,2)+'\n';
// The url, the token and the Herdr of the config file: herdr, the path of the Herdr program on this machine, absolute or with ~/ for the
// home directory, is ~/.local/bin/herdr unless the file names another. On the machine that runs open-lark, the owner's channel, openLark
// is where its agent server listens on this machine and its full token (see open-lark.ts). It holds tokens, so no one else may read it.
export type Config={url:string,token:string,herdr:string,openLark?:OpenLark};
export function readConfig(file:string):Config{
 let mode:number;try{mode=fs.statSync(file).mode;}catch(e){throw Error(`读不到配置文件 ${file}：${e.code||e.message}`);}
 if(mode&0o077)throw Error(`配置文件 ${file} 的权限是 ${(mode&0o777).toString(8)}，其他用户也能读到 token，改成 600：chmod 600 ${file}`);
 let c;try{c=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){throw Error(`配置文件 ${file} 不是有效的 JSON：${e.message}`);}
 const url=URL.parse(c?.url);
 if(!url||!['ws:','wss:'].includes(url.protocol)||url.hash)throw Error(`配置文件 ${file} 的 url 必须是 ws:// 或 wss:// 开头的控制面地址，例如 ws://<控制面地址>:8080/api/client`);
 if(typeof c.token!=='string'||!c.token)throw Error(`配置文件 ${file} 缺少 token`);
 const herdr=c.herdr??'~/.local/bin/herdr';if(typeof herdr!=='string'||!/^(~\/|\/)/.test(herdr))throw Error(`配置文件 ${file} 的 herdr 必须是 Herdr 程序的绝对路径或 ~/ 开头的路径`);
 return {url:url.href,token:c.token,herdr,...c.openLark!==undefined&&{openLark:openLark(file,c.openLark)}};
}
// openLark of config file: its token goes only to open-lark on this machine, so its url can name no other host.
function openLark(file:string,o:unknown):OpenLark{
 if(typeof o!=='object'||o===null||Array.isArray(o))throw Error(`配置文件 ${file} 的 openLark 必须是 {"url": …, "token": …}`);
 const {url,token}=o as {url?:unknown,token?:unknown},u=typeof url==='string'?URL.parse(url):null;
 if(!u||!['http:','https:'].includes(u.protocol)||!['127.0.0.1','[::1]','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)
  throw Error(`配置文件 ${file} 的 openLark.url 必须是本机上 open-lark 的 Agent 接口地址，http(s)，主机为 127.0.0.1、[::1] 或 localhost，不带路径、查询参数和 #，例如 http://127.0.0.1:8081`);
 if(typeof token!=='string'||!token)throw Error(`配置文件 ${file} 缺少 openLark.token（open-lark 的完整 token）`);
 return {url:u.origin,token};
}
// The Unix socket on which the client takes the requests of bridge-schedule, bridge-skill and bridge-message: BRIDGE_CLIENT_SOCKET, else
// herdr-bridge/client.sock in ~/.local/state. They all find it from the home directory alone, not from XDG_RUNTIME_DIR or XDG_STATE_HOME:
// the user service of the client and the panes of Herdr where agents run the commands may have different values of them, or only one of
// them may have one.
export const clientSocket=(env=process.env)=>env.BRIDGE_CLIENT_SOCKET||path.join(os.homedir(),'.local','state','herdr-bridge','client.sock');
// How long the client waits for the control plane to answer a request of a command; the command waits a little longer for the client.
export const forwardMs=60000;
const notConnected='本机的 Bridge 客户端没有连上控制面：请稍后重试，一直这样时请主人查看这台机器上客户端的日志';
// Takes the requests of bridge-schedule, bridge-skill and bridge-message on socket, which only this user may open, in a directory that it
// creates 0700: POST /schedules/<op>, /skills/<op> and /messages/<op> with a JSON body. While the client is connected (peer() returns the
// link of its connection, else null), each goes to the control plane as the request schedules, skills or messages {op, body}, which the
// control plane answers for the machine of that connection (see Clients); the client does not look into it, so what it may ask is up to
// the control plane, which answers only reads of skills that come this way. Answers 200 with the result, 400 with what the control plane
// refused or when it did not answer within forwardMs, 503 while the client is not connected. A socket already at that path is one that an
// earlier client left (see run). Resolves to the server once it listens.
export async function serve(socket:string,peer:()=>Peer<ControlApi>|null){
 const answer=(res:http.ServerResponse,code:number,data:unknown)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const server=http.createServer(async(req,res)=>{
  // A request that a server received has its url.
  const [,method,op]=req.method==='POST'&&/^\/(schedules|skills|messages)\/([a-z]+)$/.exec(new URL(req.url!,'http://localhost').pathname)||[];if(!op)return answer(res,404,{error:'接口不存在'});
  let s='',body;req.setEncoding('utf8');for await(const b of req)if(s.length<=100000)s+=b;
  if(s.length>100000)return answer(res,400,{error:'请求内容过大'});
  try{body=JSON.parse(s||'{}');}catch{return answer(res,400,{error:'请求内容不是 JSON'});}
  const p=peer();if(!p)return answer(res,503,{error:notConnected});
  // The pattern of the path lets only these three through.
  try{answer(res,200,await p.call(method as 'schedules'|'skills'|'messages',{op,body},{timeoutMs:forwardMs}));}
  catch(e){answer(res,400,{error:e.timedOut?`控制面 ${forwardMs/1000} 秒内没有回答`:String(e.message)});}
 });
 await fs.promises.mkdir(path.dirname(socket),{recursive:true,mode:0o700});await fs.promises.rm(socket,{force:true});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 fs.chmodSync(socket,0o600);return server;
}
// What the commands ask by path (see serve): the request and the answer of each operation of bridge-schedule and bridge-message and of each
// read of bridge-skill, as Bridge defines them.
type Requests={[K in keyof ScheduleOps as `/schedules/${K}`]:ScheduleOps[K]}&{[K in keyof SkillReads as `/skills/${K}`]:SkillReads[K]}&{[K in keyof MessageOps as `/messages/${K}`]:MessageOps[K]};
// Where a command writes: process.stdout and process.stderr, or what a test puts in their place.
export type Output={write(text:string):unknown};
// Sends the request of a command, path with body, to the client on socket (see serve), on a connection of its own, and resolves to Bridge's
// answer; rejects with what Bridge or the client refused, when no client listens there, or when the agent's sandbox forbids the connection
// (that of a Codex started without its network, see Topics). The client answers within forwardMs; this waits 5 seconds longer, for a client
// that does not answer at all.
export function send<P extends keyof Requests>(socket:string,path:P,body:Requests[P]['request']){
 return new Promise<Requests[P]['answer']>((resolve,reject)=>{
  const data=JSON.stringify(body);
  const req=http.request({socketPath:socket,agent:false,path,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)},timeout:forwardMs+5000},res=>{
   let s='';res.setEncoding('utf8');res.on('data',d=>{s+=d;});
   res.on('end',()=>{let r;try{r=JSON.parse(s);}catch{return reject(Error('本机的 Bridge 客户端的回答不是 JSON'));}if(res.statusCode!==200)return reject(Error(r.error||'本机的 Bridge 客户端回答 '+res.statusCode));resolve(r);});
  });
  req.on('timeout',()=>req.destroy(Error('本机的 Bridge 客户端没有回答')));
  req.on('error',(e:NodeJS.ErrnoException)=>reject(['ENOENT','ECONNREFUSED'].includes(e.code)?Error(`连不上本机的 Bridge 客户端（${socket}）：客户端没有运行，或者没有打开这个 socket`)
   :['EACCES','EPERM'].includes(e.code)?Error(`没有权限连接本机的 Bridge 客户端（${socket}）：如果命令运行在 Agent 的沙箱里，需要在沙箱外运行这条命令`):e));
  req.end(data);
 });
}
// Connects and stays connected until the process ends. After a connection ends or fails it dials again 1 s later, doubling the wait up
// to 30 s, and from 1 s again once a hello succeeds. It dials again after a refusal too (a wrong token or another protocol version), so
// it gets in by itself once the other side is fixed. A connection on which nothing arrives for three heartbeats, which the control plane
// names in its answer to the hello, is given up as dead. A client that another client of its machine replaced stops: two clients with
// one token would otherwise take the machine from each other again and again. It ends the process then with process.exit, which unlike closing
// the server of serve leaves its socket where it is: the client that replaced it may run on this machine and have put its own socket at
// that path already. methods are what the control plane may ask of the client (see link.ts). Returns a function that returns the link of
// the connection while one is in, else null (see serve).
export function run({url,token}:Pick<Config,'url'|'token'>,log:(s:string)=>void,methods:Methods<ClientApi>){
 let wait=1000,current:{ws:WebSocket,peer:Peer<ControlApi>}|null=null;
 const connect=()=>{
  const ws=new WebSocket(url,{headers:{authorization:'Bearer '+token}}),peer=link<ClientApi,ControlApi>(ws,methods);let opened=false,done=false,silence=0,timer:NodeJS.Timeout|undefined;
  const again=(what:string)=>{done=true;clearTimeout(timer);const s=wait;wait=Math.min(wait*2,30000);log(`${what}，${s/1000} 秒后重连`);setTimeout(connect,s);};
  const watch=()=>{if(!silence)return;clearTimeout(timer);timer=setTimeout(()=>{if(done)return;again(`控制面 ${silence/1000} 秒没有消息`);ws.close();},silence);};
  ws.addEventListener('message',watch);
  ws.addEventListener('open',async()=>{
   opened=true;
   try{const r=await peer.call('hello',{protocol,host:os.hostname()},{timeoutMs:10000});wait=1000;silence=3*r.heartbeatMs;watch();current={ws,peer};log(`已连接控制面，机器「${r.machine.name}」`);}
   catch{ws.close();}
  });
  ws.addEventListener('close',e=>{
   if(done)return;const what=opened?`与控制面的连接断开（${e.code}${e.reason?'：'+e.reason:''}）`:`没有连上控制面 ${url}`;
   if(e.code===closeCodes.replaced){done=true;clearTimeout(timer);log(what+'，不再重连');process.exit(0);}else again(what);
  });
 };
 connect();
 return ()=>current?.ws.readyState===WebSocket.OPEN?current.peer:null;
}
// Node 24 sends fetch and WebSocket through http_proxy and the like only when NODE_USE_ENV_PROXY=1 or --use-env-proxy turns that on.
// The client connects to the control plane directly (a machine's proxy is for the outside, and may not reach it), so it does not run
// with either.
function envProxy(env:NodeJS.ProcessEnv){return env.NODE_USE_ENV_PROXY==='1'?'NODE_USE_ENV_PROXY=1':[...process.execArgv,...(env.NODE_OPTIONS||'').split(/\s+/)].includes('--use-env-proxy')?'--use-env-proxy':'';}
// The commands of the methods run with the environment of the user's shell, which the client takes once, at its start (see
// loginEnvironment): a change of the shell's startup files reaches them once the client restarts. When the shell fails, they run with the
// client's own environment, where Herdr is still found at its path, but programs that only the shell's PATH has, such as git, may not be.
export async function main(env=process.env){
 const log=(s:string)=>console.error('bridge-client: '+s),proxy=envProxy(env);
 if(proxy){log(`客户端要直接连接控制面，不能经过代理：去掉 ${proxy} 再启动`);process.exitCode=1;return;}
 let config:Config;try{config=readConfig(configPath(env));}catch(e){log(e.message);process.exitCode=1;return;}
 let shellEnv:NodeJS.ProcessEnv;try{shellEnv=await loginEnvironment(env);}catch(e){log(`没能取得登录 shell 的环境，命令按客户端自己的环境运行：${e.message}`);shellEnv=stripped(env);}
 // Without its socket the client runs on, and only bridge-schedule, bridge-skill and bridge-message fail on this machine.
 const socket=clientSocket(env),peer=run(config,log,{ping:()=>({}),...methods({herdr:config.herdr,env:shellEnv,openLark:config.openLark})});
 serve(socket,peer).catch(e=>log(`没能打开 bridge-schedule、bridge-skill 和 bridge-message 用的 socket ${socket}：${e.message}`));
}
