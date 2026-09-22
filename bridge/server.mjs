import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {Store,normalizeMachine,herdr,helper,installHelper,targetAgent,text,uuid,publicText} from './core.mjs';
import {Platforms,normalizeApp} from './platform.mjs';
import {Registrations} from './registration.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),dir=process.env.BRIDGE_STATE||path.join(root,'state'),store=new Store(dir),live=new Map(),refreshes=new Map(),locks=new Set();
const keyfile=path.join(dir,'access-key');if(!fs.existsSync(keyfile))fs.writeFileSync(keyfile,crypto.randomBytes(24).toString('base64url'),{mode:0o600});const key=fs.readFileSync(keyfile,'utf8').trim(),auth=new Map(),attempts=new Map();
if(!store.data.machines.length&&!fs.existsSync(path.join(dir,'initialized'))){store.data.machines.push(normalizeMachine({name:'本机',type:'local',session:'default',enabled:true}));store.save();fs.writeFileSync(path.join(dir,'initialized'),'1');}
for(const job of store.data.inbox)if(job.status==='dispatching')job.status='delivery_unknown';for(const o of store.data.outbox)if(o.status==='sending')o.status='unknown';store.save();
function machine(id){const m=store.data.machines.find(x=>x.id===id);if(!m)throw Error('机器连接不存在');return m;}
async function refresh(m){if(refreshes.has(m.id))return refreshes.get(m.id);const p=(async()=>{const previous=live.get(m.id);live.set(m.id,{...previous,state:previous?.state==='connected'?'connected':'connecting'});try{
 const [agentResult,paneResult]=await Promise.all([herdr(m,'agent','list'),herdr(m,'pane','list')]);let adapters=[],adapterInstalled=true;try{adapters=await helper(m,'inventory');}catch{adapterInstalled=false;}
 const agents=agentResult.agents||[];adapters=adapters.filter(a=>a.runtime===m.session&&targetAgent(m,agents,a));
 live.set(m.id,{state:'connected',checkedAt:Date.now(),agents,panes:paneResult.panes||[],adapters,adapterInstalled});if(previous?.state!=='connected')store.log('机器连接',m.name+' 已连接');
 }catch(e){live.set(m.id,{state:'error',checkedAt:Date.now(),error:publicText(e.message),agents:[],panes:[],adapters:[]});if(previous?.error!==e.message)store.log('机器连接',m.name+'：'+e.message,'error');}finally{refreshes.delete(m.id);}})();refreshes.set(m.id,p);return p;}
async function snapshotTarget(t){const m=machine(t.machineId);if(!m.enabled)throw Error('机器连接已停用');const result=await herdr(m,'agent','list');const snap=await helper(m,'snapshot',t.adapterId);
 if(snap.runtime!==m.session||snap.nativeId!==t.nativeId||snap.paneId!==t.paneId||!snap.online||!targetAgent(m,result.agents||[],snap))throw Error('Agent 会话已退出或身份已变化，请重新绑定');return snap;}
async function sendTarget(t,command){if(locks.has(t.machineId+':'+t.adapterId))throw Error('会话操作处理中');const k=t.machineId+':'+t.adapterId;locks.add(k);try{const s=await snapshotTarget(t);if(command.kind==='message'&&s.status!=='ready')throw Error('Agent 尚未就绪');if(command.kind==='permission'&&!s.permissions.some(p=>p.request_id===command.request_id&&p.status==='pending'))throw Error('审批已提交或失效');return await helper(machine(t.machineId),'send',t.adapterId,{...command,nativeId:t.nativeId});}finally{locks.delete(k);}}
const platforms=new Platforms(store,{snapshotTarget,sendTarget}),registrations=new Registrations(store,{connect:async a=>{
 if(!a.allowedUsers.length)return false;
 if(!a.enabled||platforms.status(a).connection!=='connected'){await platforms.start(a);a.enabled=true;store.save();}
 for(let i=0;i<20;i++){if(platforms.status(a).connection==='connected')return true;await new Promise(r=>setTimeout(r,750));}
 throw Error('connection_timeout');
}});
function state(){return {host:os.hostname(),version:'0.1.0',registration:registrations.status(),machines:store.data.machines.map(m=>({...m,...(m.enabled?live.get(m.id):{state:'disabled',agents:[],panes:[],adapters:[]}),adapters:(m.enabled?live.get(m.id)?.adapters||[]:[]).map(({events,...a})=>a)})),apps:store.data.apps.map(a=>platforms.status(a)),bindings:store.data.bindings,logs:store.data.logs.slice(-60),deliveries:store.data.inbox.slice(-30).map(({text,...j})=>j)};}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function authorized(req){if(equal(req.headers.authorization?.replace(/^Bearer /,''),key))return true;return (auth.get(req.headers.cookie?.match(/(?:^|; )bridge_session=([^;]+)/)?.[1])||0)>Date.now();}
function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const b of req){s+=b;if(s.length>100000)throw Error('请求内容过大');}return JSON.parse(s||'{}');}
const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/connect':['connect.html','text/html'],'/connect.js':['connect.js','text/javascript']};
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
 const p=new URL(req.url,'http://localhost').pathname,host=req.headers.host?.split(':')[0];if(!['localhost','127.0.0.1',os.hostname(),...(process.env.BRIDGE_HOSTS||'').split(',')].includes(host))return json(res,403,{error:'不允许的 Host'});
 if(req.method==='GET'&&assets[p]){const [file,type]=assets[p];res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-cache'});return fs.createReadStream(path.join(root,'public',file)).pipe(res);}
 if(p==='/health')return json(res,200,{ok:true,service:'herdr-bridge'});
 if(req.method==='POST'&&!req.headers.authorization&&req.headers.origin!=='http://'+req.headers.host&&req.headers.origin!=='https://'+req.headers.host)return json(res,403,{error:'跨站请求已拒绝'});
 if(p==='/api/login'&&req.method==='POST'){const ip=req.socket.remoteAddress,now=Date.now();let a=attempts.get(ip);if(!a||now-a.at>60000)a={at:now,n:0};attempts.set(ip,a);if(++a.n>20)return json(res,429,{error:'请稍后重试'});const b=await body(req);if(!equal(b.key,key))return json(res,401,{error:'访问密钥不正确'});const id=crypto.randomBytes(32).toString('hex');auth.set(id,now+12*3600000);res.setHeader('Set-Cookie',`bridge_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return json(res,200,{ok:true});}
 if(!authorized(req))return json(res,401,{error:'请先登录'});
 if(p==='/api/state'&&req.method==='GET')return json(res,200,state());
 if(req.method!=='POST')return json(res,404,{error:'接口不存在'});const b=await body(req);let result={ok:true};
 if(p==='/api/logout'){auth.delete(req.headers.cookie?.match(/(?:^|; )bridge_session=([^;]+)/)?.[1]);res.setHeader('Set-Cookie','bridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');}
 else if(p==='/api/machines/save'){const m=normalizeMachine(b);if(b.id){const old=machine(b.id);if(old.enabled)throw Error('请先断开机器再编辑');Object.assign(old,m);}else store.data.machines.push(m);store.save();if(m.enabled)await refresh(m);result={id:m.id};}
 else if(p==='/api/machines/connect'){const m=machine(b.id);m.enabled=true;store.save();await refresh(m);result=live.get(m.id);}
 else if(p==='/api/machines/disconnect'){const m=machine(b.id);m.enabled=false;store.save();store.log('机器连接',m.name+' 已断开桥接，Herdr 任务继续运行');}
 else if(p==='/api/machines/remove'){if(store.data.bindings.some(x=>x.machineId===b.id))throw Error('请先移除该机器的会话绑定');machine(b.id);store.data.machines=store.data.machines.filter(x=>x.id!==b.id);live.delete(b.id);store.save();}
 else if(p==='/api/machines/install'){const m=machine(b.id);result=await installHelper(m,fs.readFileSync(path.join(root,'remote.py'),'utf8'));store.log('适配器',m.name+' 已安装 Claude 启动适配器');await refresh(m);}
 else if(p==='/api/apps/registration/start'){result=registrations.start(b);}
 else if(p==='/api/apps/registration/cancel'){result=registrations.cancel(b.id);}
 else if(p==='/api/apps/save'){const old=b.id?platforms.app(b.id):undefined;if(old?.enabled)throw Error('请先停用应用再编辑');if(old&&old.appId!==b.appId&&(store.data.bindings.some(x=>x.appId===old.id)||store.data.inbox.some(x=>x.appId===old.id&&['queued','running','dispatching'].includes(x.status))))throw Error('现有应用还有绑定或任务，请另建应用');const a=normalizeApp(b,old);if(store.data.apps.some(x=>x.id!==a.id&&x.appId===a.appId))throw Error('该应用已添加');if(old)Object.assign(old,a);else store.data.apps.push(a);await platforms.stop(a.id);store.save();result={id:a.id};}
 else if(p==='/api/apps/test'){result=await platforms.verify(platforms.app(b.id));store.log('凭证验证',platforms.app(b.id).name+' 验证通过');}
 else if(p==='/api/apps/toggle'){const a=platforms.app(b.id);if(b.enabled){await platforms.start(a);a.enabled=true;}else{a.enabled=false;await platforms.stop(a.id);}store.save();}
 else if(p==='/api/apps/remove'){if(store.data.bindings.some(x=>x.appId===b.id))throw Error('请先移除该应用的会话绑定');await platforms.stop(b.id);store.data.apps=store.data.apps.filter(x=>x.id!==b.id);store.save();}
 else if(p==='/api/bindings/save'){
  const a=platforms.app(b.appId),m=machine(b.machineId);await refresh(m);const adapter=live.get(m.id)?.adapters.find(x=>x.id===b.adapterId);if(!adapter?.nativeId)throw Error('请选择已接入且在线的 Claude 会话');
  const chatId=text(b.chatId,100);if(!/^oc_[a-zA-Z0-9]+$/.test(chatId))throw Error('Chat ID 应以 oc_ 开头');const rootId=b.rootId?text(b.rootId,100):'';if(rootId&&!/^om_[a-zA-Z0-9]+$/.test(rootId))throw Error('话题根消息 ID 应以 om_ 开头');
  if(store.data.bindings.some(x=>x.appId===a.id&&x.chatId===chatId&&(!x.rootId||!rootId||x.rootId===rootId)))throw Error('该聊天或话题已有重叠路由，请先移除旧绑定');
  store.data.bindings.push({id:uuid(),name:text(b.name,60),appId:a.id,machineId:m.id,adapterId:adapter.id,nativeId:adapter.nativeId,paneId:adapter.paneId,chatId,rootId,requireMention:b.requireMention!==false,replyInThread:b.replyInThread!==false,enabled:true});store.save();store.log('会话绑定',b.name+' → '+m.name+' / '+adapter.paneId);
 }
 else if(p==='/api/bindings/remove'){store.data.bindings=store.data.bindings.filter(x=>x.id!==b.id);store.save();}
 else if(p==='/api/adapters/inspect'){const m=machine(b.machineId);const s=await helper(m,'snapshot',text(b.adapterId,36));const redact=v=>typeof v==='string'?publicText(v):Array.isArray(v)?v.map(redact):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,redact(x)])):v;result=redact(s);}
 else if(p==='/api/adapters/message'){result=await sendTarget(b.target,{kind:'message',chat_id:text(b.id,80),text:text(b.text,16000)});}
 else if(p==='/api/adapters/permission'){if(!['allow','deny'].includes(b.behavior))throw Error('审批操作无效');result=await sendTarget(b.target,{kind:'permission',request_id:text(b.requestId,80),behavior:b.behavior});}
 else return json(res,404,{error:'接口不存在'});
 return json(res,200,result);
 }catch(e){json(res,400,{error:publicText(e.message).slice(0,1200)});}});
const poll=setInterval(()=>{for(const m of store.data.machines)if(m.enabled)refresh(m);platforms.tick().catch(()=>{});},5000);
for(const m of store.data.machines)if(m.enabled)refresh(m);for(const a of store.data.apps)if(a.enabled)platforms.start(a).catch(e=>store.log('平台连接',a.name+'：'+e.message,'error'));
server.listen(Number(process.env.PORT||8080),process.env.BIND||'0.0.0.0',()=>console.log('herdr-bridge listening on '+(process.env.PORT||8080)));
process.on('SIGTERM',()=>{clearInterval(poll);registrations.stop();for(const a of store.data.apps)platforms.stop(a.id);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();});
