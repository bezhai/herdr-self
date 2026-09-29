import fs from 'node:fs';import path from 'node:path';
import {createLarkChannel} from '@larksuite/channel';
import {text,uuid,hostPath} from './core.mjs';
const domains={feishu:'https://open.feishu.cn',lark:'https://open.larksuite.com',bytedance:'https://fsopen.bytedance.net'},avatarLimit=1024*1024;
// Raster types only: an SVG can carry script and avatars are served from the console's own origin.
const avatarTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
// SDK event IDs can be identical when a message mentions two apps. Keep their caches separate.
export function channelCache(){const entries=new Map();return {
 async get(key,options={}){const k=JSON.stringify([options.namespace||'',String(key)]),entry=entries.get(k);if(!entry)return;if(entry.expires<=Date.now()){entries.delete(k);return;}return entry.value;},
 async set(key,value,expire=Infinity,options={}){const k=JSON.stringify([options.namespace||'',String(key)]);entries.delete(k);entries.set(k,{value,expires:expire});while(entries.size>10000)entries.delete(entries.keys().next().value);return true;},
};}
export function normalizeApp(b,old={}){
 const appId=text(b.appId,100);if(!/^cli_[a-zA-Z0-9]+$/.test(appId))throw Error('App ID 应以 cli_ 开头');
 const allowedUsers=Array.isArray(b.allowedUsers)?[...new Set(b.allowedUsers)]:[];
 if(allowedUsers.some(x=>typeof x!=='string'||!/^ou_[a-zA-Z0-9]+$/.test(x)))throw Error('允许操作的用户请填写 open_id（ou_…）');
 const secret=b.appSecret?text(b.appSecret,400):old.appId===appId?old.appSecret:'';
 if(!secret)throw Error('请填写 App Secret');
 return {id:old.id||uuid(),name:text(b.name,60),appId,appSecret:secret,domain:['feishu','lark','bytedance'].includes(b.domain)?b.domain:'feishu',allowedUsers,enabled:false,verifiedAt:null};
}
// A binding routes one chat of an app; every topic in that chat gets its own agent session in Herdr (see topics.mjs).
// chat is the pending chat that asked for it (see pending-chats.mjs): app and chat never come from the client, and a direct chat needs no mention.
export function normalizeBinding(b,chat,bindings){
 if(!['claude','codex'].includes(b.kind))throw Error('Agent 类型无效');
 if(bindings.some(x=>x.appId===chat.appId&&x.chatId===chat.chatId))throw Error('该聊天已有绑定，请先移除旧绑定');
 return {id:uuid(),name:text(b.name,60),appId:chat.appId,machineId:b.machineId,chatId:chat.chatId,cwd:hostPath(b.cwd,'工作目录'),kind:b.kind,requireMention:chat.chatType==='group'&&b.requireMention!==false,enabled:true};
}
// Bridge takes text, and rich text without resources, from a person. Mentions are left to routing and topic handling.
export function routable(msg){return msg.senderType==='user'&&['text','post'].includes(msg.rawContentType)&&Boolean(msg.senderId)&&!msg.resources?.length;}
export class Platforms{
 // onMessage(app,binding,msg) receives every allowed message of a bound chat; onUnbound(app,msg) the ones that ask for a binding.
 // fetch downloads bot avatars.
 constructor(store,{onMessage,onUnbound,channelFactory=createLarkChannel,fetch=globalThis.fetch}){this.store=store;this.onMessage=onMessage;this.onUnbound=onUnbound;this.channelFactory=channelFactory;this.fetch=fetch;this.runtime=new Map();}
 app(id){const a=this.store.data.apps.find(x=>x.id===id);if(!a)throw Error('应用不存在');return a;}
 status(a){const r=this.runtime.get(a.id);return {...a,appSecret:undefined,hasSecret:!!a.appSecret,connection:a.enabled?(r?.state==='error'?'error':r?.channel.getConnectionStatus()?.state||r?.state||'connecting'):'disabled',error:r?.error||''};}
 channel(a){
  const existing=this.runtime.get(a.id);if(existing)return existing.channel;
  const rt={state:'idle',error:'',stopped:false};
  const channel=this.channelFactory({appId:a.appId,appSecret:a.appSecret,domain:domains[a.domain],source:'herdr-bridge',cache:channelCache(),
   httpTimeoutMs:10000,connectTimeoutMs:15000,resolveSenderNames:false,resolveChatMode:false,
   // Mention requirements differ per binding. Bridge checks group senders as well as DM senders.
   policy:{requireMention:false,respondToMentionAll:false,dmMode:'allowlist',dmAllowlist:a.allowedUsers},
   // Handle each platform message on its own: no merging while busy and no batching delay.
   safety:{chatQueue:{enabled:true,mergeWhileBusy:false},batch:{text:{delayMs:0},media:{delayMs:0}}},
   // A send whose result is unknown is never repeated.
   outbound:{retry:{maxAttempts:1}},
   logger:{debug(){},info(){},warn(){},error(){}},
  });
  rt.channel=channel;this.runtime.set(a.id,rt);
  const current=()=>this.runtime.get(a.id)===rt&&!rt.stopped;
  channel.on('message',msg=>{if(current())this.receive(a,msg);});
  channel.on('error',()=>{if(current()){rt.error='飞书连接异常';this.store.log('平台连接',a.name+' 连接异常','error');}});
  channel.on('reconnecting',()=>{if(current()){rt.state='reconnecting';this.store.log('平台连接',a.name+' 正在重连');}});
  channel.on('reconnected',()=>{if(current()){rt.state='connected';rt.error='';this.store.log('平台连接',a.name+' 已连接');}});
  return channel;
 }
 async verify(a){await this.syncBot(a,this.channel(a));a.verifiedAt=Date.now();this.store.save();return {verified:true,name:a.name};}
 // Feishu is the source of the app name and the bot's open_id. A failed avatar download is only logged and keeps the previous avatar.
 async syncBot(a,channel){
  const d=await channel.rawClient.request({url:'/open-apis/bot/v3/info',method:'GET'});
  const bot=d.bot||d.data?.bot;if((d.code!==undefined&&d.code!==0)||!bot?.open_id)throw Error('应用凭证验证失败');
  a.name=bot.app_name?String(bot.app_name).slice(0,60):a.name;a.botOpenId=bot.open_id;this.store.save();
  try{await this.saveAvatar(a,bot.avatar_url);}catch(e){this.store.log('应用信息',`${a.name}：头像未更新，${e.message}`,'error');}
 }
 // Only an https PNG, JPEG, GIF or WebP image of at most 1 MB is stored, as avatars/<app id> in the state directory.
 async saveAvatar(a,url){
  if(!url)return;if(new URL(url).protocol!=='https:')throw Error('头像地址不是 https');
  const r=await this.fetch(url,{signal:AbortSignal.timeout(10000)});
  if(r.url&&new URL(r.url).protocol!=='https:')throw Error('头像地址不是 https');if(!r.ok)throw Error('头像下载失败，HTTP '+r.status);
  const type=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();if(!avatarTypes.has(type))throw Error('头像不是 PNG、JPEG、GIF 或 WebP 图片');
  const chunks=[];let size=0;for await(const chunk of r.body||[]){size+=chunk.length;if(size>avatarLimit)throw Error('头像超过 1 MB');chunks.push(chunk);}
  // The app may have been removed while downloading.
  if(!this.store.data.apps.includes(a))return;
  const file=this.avatarFile(a.id);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',Buffer.concat(chunks),{mode:0o600});fs.renameSync(file+'.tmp',file);
  a.avatar={type,updatedAt:Date.now()};this.store.save();
 }
 avatarFile(id){return path.join(this.store.dir,'avatars',id);}
 // The stored avatar of an app as {type,body}, or null.
 async avatar(id){const a=this.store.data.apps.find(x=>x.id===id);if(!a?.avatar)return null;try{return {type:a.avatar.type,body:await fs.promises.readFile(this.avatarFile(a.id))};}catch{return null;}}
 async remove(id){const a=this.app(id);await this.stop(a.id);this.store.data.apps=this.store.data.apps.filter(x=>x!==a);this.store.save();fs.rmSync(this.avatarFile(a.id),{force:true});}
 async dispose(channel){
  // SDK 0.7.1 disconnect() returns early before the handshake; also close that pending socket.
  channel.rawWsClient?.close({force:true});await channel.disconnect();
 }
 async stop(id){const rt=this.runtime.get(id);if(!rt)return;rt.stopped=true;this.runtime.delete(id);try{await this.dispose(rt.channel);}catch{}}
 async start(a){
  if(!a.allowedUsers.length)throw Error('启用前至少指定一位允许操作的飞书用户');
  const channel=this.channel(a),rt=this.runtime.get(a.id);
  if(rt.state==='connected')return;if(rt.connecting)return rt.connecting;
  rt.state='connecting';rt.error='';
  rt.connecting=(async()=>{try{
   await channel.connect();
   if(rt.stopped||this.runtime.get(a.id)!==rt){await this.dispose(channel);throw Error('连接已停用');}
   a.verifiedAt=Date.now();rt.state='connected';this.store.save();this.store.log('平台连接',a.name+' 已连接');
  }catch(e){
   await this.dispose(channel).catch(()=>{});
   if(this.runtime.get(a.id)===rt){rt.state='error';rt.error='飞书连接失败，请检查应用配置';}
   throw Error('飞书连接失败，请检查应用配置');
  }finally{rt.connecting=null;}
  // The connection stands even when the bot profile cannot be read.
  await this.syncBot(a,channel).catch(e=>this.store.log('应用信息',`${a.name}：未能读取机器人信息，${e.message}`,'error'));
  })();return rt.connecting;
 }
 receive(a,msg){if(!a.enabled||!a.allowedUsers.includes(msg.senderId)||!routable(msg))return;
  const content=msg.content?.trim();if(!content||content.length>16000)return;
  const b=this.store.data.bindings.find(x=>x.appId===a.id&&x.chatId===msg.chatId);
  if(b){if(b.enabled)this.onMessage(a,b,msg);}
  // A chat without a binding asks for one: a direct chat with any message, a group only by mentioning the bot.
  else if(msg.chatType==='p2p'||msg.mentionedBot)this.onUnbound(a,msg);
 }
 // A reply inside the topic thread; replying in thread is what turns a plain group message into a topic.
 async reply(a,chatId,rootId,text){
  const channel=this.runtime.get(a.id)?.channel;if(!channel||channel.getConnectionStatus()?.state!=='connected')throw Error('飞书未连接');
  await channel.send(chatId,{text},{replyTo:rootId,replyInThread:true});
 }
}
