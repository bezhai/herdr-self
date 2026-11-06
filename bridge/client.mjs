import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {link,protocol,closeCodes} from './link.mjs';
// The Bridge client of a machine (bin/bridge-client.mjs runs it, one per machine, as a user service). It dials the control plane at
// the url of its config with the machine's token and stays connected over one WebSocket (see link.mjs and clients.mjs). It uses only
// Node's built-in modules, Node's own WebSocket among them, so a copy of the Bridge directory without node_modules runs it. It logs to
// stderr.

// The config file: BRIDGE_CLIENT_CONFIG, else herdr-bridge/client.json in the user's config directory.
export const configPath=(env=process.env)=>env.BRIDGE_CLIENT_CONFIG||path.join(env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'herdr-bridge','client.json');
// The config file for a token, which the console shows once: the client endpoint of the control plane at origin, http(s)://host[:port].
export const configText=(origin,token)=>JSON.stringify({url:origin.replace(/^http/,'ws')+'/api/client',token},null,2)+'\n';
// The url and the token of the config file. It holds the token, so no one else may read it.
export function readConfig(file){
 let mode;try{mode=fs.statSync(file).mode;}catch(e){throw Error(`读不到配置文件 ${file}：${e.code||e.message}`);}
 if(mode&0o077)throw Error(`配置文件 ${file} 的权限是 ${(mode&0o777).toString(8)}，其他用户也能读到 token，改成 600：chmod 600 ${file}`);
 let c;try{c=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){throw Error(`配置文件 ${file} 不是有效的 JSON：${e.message}`);}
 const url=URL.parse(c?.url);
 if(!url||!['ws:','wss:'].includes(url.protocol)||url.hash)throw Error(`配置文件 ${file} 的 url 必须是 ws:// 或 wss:// 开头的控制面地址，例如 ws://<控制面地址>:8080/api/client`);
 if(typeof c.token!=='string'||!c.token)throw Error(`配置文件 ${file} 缺少 token`);
 return {url:url.href,token:c.token};
}
// What the client does for the control plane: a fixed set, with no operation that runs any command.
const methods={ping:()=>({})};
// Connects and stays connected until the process ends. After a connection ends or fails it dials again 1 s later, doubling the wait up
// to 30 s, and from 1 s again once a hello succeeds. It dials again after a refusal too (a wrong token or another protocol version), so
// it gets in by itself once the other side is fixed. A connection on which nothing arrives for three heartbeats, which the control plane
// names in its answer to the hello, is given up as dead. A client that another client of its machine replaced stops: two clients with
// one token would otherwise take the machine from each other again and again.
export function run({url,token},log){
 let wait=1000;
 const connect=()=>{
  const ws=new WebSocket(url,{headers:{authorization:'Bearer '+token}}),peer=link(ws,methods);let opened=false,done=false,silence=0,timer;
  const again=what=>{done=true;clearTimeout(timer);const s=wait;wait=Math.min(wait*2,30000);log(`${what}，${s/1000} 秒后重连`);setTimeout(connect,s);};
  const watch=()=>{if(!silence)return;clearTimeout(timer);timer=setTimeout(()=>{if(done)return;again(`控制面 ${silence/1000} 秒没有消息`);ws.close();},silence);};
  ws.addEventListener('message',watch);
  ws.addEventListener('open',async()=>{
   opened=true;
   try{const r=await peer.call('hello',{protocol,host:os.hostname()},{timeoutMs:10000});wait=1000;silence=3*r.heartbeatMs;watch();log(`已连接控制面，机器「${r.machine.name}」`);}
   catch{ws.close();}
  });
  ws.addEventListener('close',e=>{
   if(done)return;const what=opened?`与控制面的连接断开（${e.code}${e.reason?'：'+e.reason:''}）`:`没有连上控制面 ${url}`;
   if(e.code===closeCodes.replaced){done=true;clearTimeout(timer);log(what+'，不再重连');}else again(what);
  });
 };
 connect();
}
// Node 24 sends fetch and WebSocket through http_proxy and the like only when NODE_USE_ENV_PROXY=1 or --use-env-proxy turns that on.
// The client connects to the control plane directly (a machine's proxy is for the outside, and may not reach it), so it does not run
// with either.
function envProxy(env){return env.NODE_USE_ENV_PROXY==='1'?'NODE_USE_ENV_PROXY=1':[...process.execArgv,...(env.NODE_OPTIONS||'').split(/\s+/)].includes('--use-env-proxy')?'--use-env-proxy':'';}
export function main(env=process.env){
 const log=s=>console.error('bridge-client: '+s),proxy=envProxy(env);
 if(proxy){log(`客户端要直接连接控制面，不能经过代理：去掉 ${proxy} 再启动`);process.exitCode=1;return;}
 let config;try{config=readConfig(configPath(env));}catch(e){log(e.message);process.exitCode=1;return;}
 run(config,log);
}
