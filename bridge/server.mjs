import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {Store,normalizeMachine,herdr,publicText} from './core.mjs';
import {Platforms,normalizeApp} from './platform.mjs';
import {PendingChats,consoleUrl} from './pending-chats.mjs';
import {Registrations} from './registration.mjs';
import {Topics} from './topics.mjs';
import {staticFile,sendStatic} from './web-assets.mjs';
const bridgeUrl=consoleUrl(process.env.BRIDGE_URL),root=path.dirname(fileURLToPath(import.meta.url)),dir=process.env.BRIDGE_STATE||path.join(root,'state'),store=new Store(dir),live=new Map(),refreshes=new Map();
const keyfile=path.join(dir,'access-key');if(!fs.existsSync(keyfile))fs.writeFileSync(keyfile,crypto.randomBytes(24).toString('base64url'),{mode:0o600});const key=fs.readFileSync(keyfile,'utf8').trim(),auth=new Map(),attempts=new Map();
if(!store.data.machines.length&&!fs.existsSync(path.join(dir,'initialized'))){store.data.machines.push(normalizeMachine({name:'本机',type:'local',session:'default',enabled:true}));store.save();fs.writeFileSync(path.join(dir,'initialized'),'1');}
function machine(id){const m=store.data.machines.find(x=>x.id===id);if(!m)throw Error('机器连接不存在');return m;}
async function refresh(m){if(refreshes.has(m.id))return refreshes.get(m.id);const p=(async()=>{const previous=live.get(m.id);live.set(m.id,{...previous,state:previous?.state==='connected'?'connected':'connecting'});try{
 const [agentResult,paneResult]=await Promise.all([herdr(m,['agent','list']),herdr(m,['pane','list'])]);
 const agents=agentResult.agents||[];live.set(m.id,{state:'connected',checkedAt:Date.now(),agents,panes:paneResult.panes||[]});if(previous?.state!=='connected')store.log('机器连接',m.name+' 已连接');
 // Topic agents' new replies go back to Feishu; this does not wait for them and never throws.
 topics.sync(m,agents);
 }catch(e){live.set(m.id,{state:'error',checkedAt:Date.now(),error:publicText(e.message),agents:[],panes:[]});if(previous?.error!==e.message)store.log('机器连接',m.name+'：'+e.message,'error');}finally{refreshes.delete(m.id);}})();refreshes.set(m.id,p);return p;}
const topics=new Topics(store,{herdr,machine,app:id=>platforms.app(id),reply:(...args)=>platforms.reply(...args),react:(...args)=>platforms.react(...args),unreact:(...args)=>platforms.unreact(...args)}),pending=new PendingChats(store,{reply:(...args)=>platforms.reply(...args),onBound:(...args)=>topics.handle(...args),app:id=>platforms.app(id),machine,bridgeUrl});
const platforms=new Platforms(store,{onMessage:(...args)=>topics.handle(...args),onUnbound:(...args)=>pending.open(...args)}),registrations=new Registrations(store,{connect:async a=>{
 if(!a.allowedUsers.length)return false;
 if(!a.enabled||platforms.status(a).connection!=='connected'){await platforms.start(a);a.enabled=true;store.save();}
 for(let i=0;i<20;i++){if(platforms.status(a).connection==='connected')return true;await new Promise(r=>setTimeout(r,750));}
 throw Error('connection_timeout');
}});
function state(){return {host:os.hostname(),version:'0.1.0',registration:registrations.status(),machines:store.data.machines.map(m=>({...m,...(m.enabled?live.get(m.id):{state:'disabled',agents:[],panes:[]})})),apps:store.data.apps.map(a=>platforms.status(a)),bindings:store.data.bindings,pendingChats:pending.list(),topics:store.data.topics.map(({messageIds,reactions,...t})=>t),logs:store.data.logs.slice(-60)};}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function authorized(req){if(equal(req.headers.authorization?.replace(/^Bearer /,''),key))return true;return (auth.get(req.headers.cookie?.match(/(?:^|; )bridge_session=([^;]+)/)?.[1])||0)>Date.now();}
function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const b of req){s+=b;if(s.length>100000)throw Error('请求内容过大');}return JSON.parse(s||'{}');}
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
 const url=new URL(req.url,'http://localhost'),p=url.pathname,host=req.headers.host?.split(':')[0];if(!['localhost','127.0.0.1',os.hostname(),...(process.env.BRIDGE_HOSTS||'').split(',')].includes(host))return json(res,403,{error:'不允许的 Host'});
 const asset=req.method==='GET'&&staticFile(p);if(asset)return sendStatic(res,asset);
 if(p==='/health')return json(res,200,{ok:true,service:'herdr-bridge'});
 if(req.method==='POST'&&!req.headers.authorization&&req.headers.origin!=='http://'+req.headers.host&&req.headers.origin!=='https://'+req.headers.host)return json(res,403,{error:'跨站请求已拒绝'});
 if(p==='/api/login'&&req.method==='POST'){const ip=req.socket.remoteAddress,now=Date.now();let a=attempts.get(ip);if(!a||now-a.at>60000)a={at:now,n:0};attempts.set(ip,a);if(++a.n>20)return json(res,429,{error:'请稍后重试'});const b=await body(req);if(!equal(b.key,key))return json(res,401,{error:'访问密钥不正确'});const id=crypto.randomBytes(32).toString('hex');auth.set(id,now+12*3600000);res.setHeader('Set-Cookie',`bridge_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return json(res,200,{ok:true});}
 if(!authorized(req))return json(res,401,{error:'请先登录'});
 if(p==='/api/state'&&req.method==='GET')return json(res,200,state());
 if(p==='/api/apps/avatar'&&req.method==='GET'){const avatar=await platforms.avatar(url.searchParams.get('id'));if(!avatar)return json(res,404,{error:'没有头像'});res.writeHead(200,{'Content-Type':avatar.type,'Cache-Control':'private, max-age=300'});return res.end(avatar.body);}
 if(req.method!=='POST')return json(res,404,{error:'接口不存在'});const b=await body(req);let result={ok:true};
 if(p==='/api/logout'){auth.delete(req.headers.cookie?.match(/(?:^|; )bridge_session=([^;]+)/)?.[1]);res.setHeader('Set-Cookie','bridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');}
 else if(p==='/api/machines/save'){const m=normalizeMachine(b);if(b.id){const old=machine(b.id);if(old.enabled)throw Error('请先断开机器再编辑');Object.assign(old,m);}else store.data.machines.push(m);store.save();if(m.enabled)await refresh(m);result={id:m.id};}
 else if(p==='/api/machines/connect'){const m=machine(b.id);m.enabled=true;store.save();await refresh(m);result=live.get(m.id);}
 else if(p==='/api/machines/disconnect'){const m=machine(b.id);m.enabled=false;store.save();store.log('机器连接',m.name+' 已断开桥接，Herdr 任务继续运行');}
 else if(p==='/api/machines/remove'){if(store.data.bindings.some(x=>x.machineId===b.id))throw Error('请先移除该机器的会话绑定');machine(b.id);store.data.machines=store.data.machines.filter(x=>x.id!==b.id);live.delete(b.id);store.save();}
 else if(p==='/api/apps/registration/start'){result=registrations.start(b);}
 else if(p==='/api/apps/registration/cancel'){result=registrations.cancel(b.id);}
 else if(p==='/api/apps/save'){const old=b.id?platforms.app(b.id):undefined;if(old?.enabled)throw Error('请先停用应用再编辑');if(old&&old.appId!==b.appId&&store.data.bindings.some(x=>x.appId===old.id))throw Error('现有应用还有绑定，请另建应用');const a=normalizeApp(b,old);if(store.data.apps.some(x=>x.id!==a.id&&x.appId===a.appId))throw Error('该应用已添加');if(old)Object.assign(old,a);else store.data.apps.push(a);await platforms.stop(a.id);store.save();result={id:a.id};}
 else if(p==='/api/apps/test'){result=await platforms.verify(platforms.app(b.id));store.log('凭证验证',platforms.app(b.id).name+' 验证通过');}
 else if(p==='/api/apps/toggle'){const a=platforms.app(b.id);if(b.enabled){await platforms.start(a);a.enabled=true;}else{a.enabled=false;await platforms.stop(a.id);}store.save();}
 else if(p==='/api/apps/remove'){if(store.data.bindings.some(x=>x.appId===b.id))throw Error('请先移除该应用的会话绑定');await platforms.remove(b.id);}
 else if(p==='/api/bindings/save'){result={id:pending.bind(b).id};}
 else if(p==='/api/bindings/remove'){store.data.bindings=store.data.bindings.filter(x=>x.id!==b.id);store.data.topics=store.data.topics.filter(x=>x.bindingId!==b.id);store.save();}
 else return json(res,404,{error:'接口不存在'});
 return json(res,200,result);
 }catch(e){json(res,400,{error:publicText(e.message).slice(0,1200)});}});
const poll=setInterval(()=>{for(const m of store.data.machines)if(m.enabled)refresh(m);},5000);
for(const m of store.data.machines)if(m.enabled)refresh(m);for(const a of store.data.apps)if(a.enabled)platforms.start(a).catch(e=>store.log('平台连接',a.name+'：'+e.message,'error'));
server.listen(Number(process.env.PORT||8080),process.env.BIND||'0.0.0.0',()=>console.log('herdr-bridge listening on '+(process.env.PORT||8080)));
process.on('SIGTERM',()=>{clearInterval(poll);registrations.stop();for(const a of store.data.apps)platforms.stop(a.id);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();});
