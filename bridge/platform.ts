import fs from 'node:fs';import path from 'node:path';
import {createLarkChannel} from '@larksuite/channel';
import type {LarkChannel,LarkChannelOptions,NormalizedMessage,CardActionEvent,CardActionResponse} from '@larksuite/channel';
import {text,uuid,hostPath,oneOf} from './core.ts';
import type {Store} from './core.ts';
import {registerCommands} from './commands.ts';
import type {App,Binding,Kind,PermissionMode} from './state.ts';
import type {Click} from './request-cards.ts';
import type {Attachment} from './attachments.ts';
const domains:Record<App['domain'],string>={feishu:'https://open.feishu.cn',lark:'https://open.larksuite.com',bytedance:'https://fsopen.bytedance.net'},avatarLimit=1024*1024;
// Feishu codes of a call that the app has no scope for.
const missingScope=[99991672,99991640];
// An OpenAPI call that the SDK does not cover, through the raw client of channel. Resolves to the data of a response with code 0, or to the
// body of one without that envelope; rejects with Feishu's code otherwise, also for an HTTP error status, which the client throws with the
// body attached.
export type OpenApiOptions=Parameters<LarkChannel['rawClient']['request']>[0];
// Feishu's data, as it arrives.
export type OpenApi=(options:OpenApiOptions)=>Promise<any>;
export async function openApi(channel:LarkChannel,options:OpenApiOptions){
 let d;try{d=await channel.rawClient.request(options);}catch(e){if(e.response?.data?.code==null)throw e;d=e.response.data;}
 if(d?.code!=null&&d.code!==0)throw Object.assign(Error(`飞书接口错误 ${d.code}：${d.msg||''}`),{code:d.code});
 return d?.data??d;
}
// Raster types only: an SVG can carry script and avatars are served from the console's own origin.
const avatarTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
// SDK event IDs can be identical when a message mentions two apps. Keep their caches separate.
export function channelCache():NonNullable<LarkChannelOptions['cache']>{const entries=new Map<string,{value:unknown,expires:number}>();return {
 async get(key,options={}){const k=JSON.stringify([options.namespace||'',String(key)]),entry=entries.get(k);if(!entry)return;if(entry.expires<=Date.now()){entries.delete(k);return;}return entry.value;},
 async set(key,value,expire=Infinity,options={}){const k=JSON.stringify([options.namespace||'',String(key)]);entries.delete(k);entries.set(k,{value,expires:expire});while(entries.size>10000)entries.delete(entries.keys().next().value!);return true;},
};}
export function normalizeApp(b:{name?:unknown,appId?:unknown,appSecret?:unknown,domain?:unknown,allowedUsers?:unknown,[field:string]:unknown},old:Partial<App>={}):App{
 const appId=text(b.appId,100);if(!/^cli_[a-zA-Z0-9]+$/.test(appId))throw Error('App ID 应以 cli_ 开头');
 const allowedUsers=Array.isArray(b.allowedUsers)?[...new Set(b.allowedUsers)]:[];
 if(allowedUsers.some(x=>typeof x!=='string'||!/^ou_[a-zA-Z0-9]+$/.test(x)))throw Error('允许操作的用户请填写 open_id（ou_…）');
 const secret=b.appSecret?text(b.appSecret,400):old.appId===appId?old.appSecret:'';
 if(!secret)throw Error('请填写 App Secret');
 return {id:old.id||uuid(),name:text(b.name,60),appId,appSecret:secret,domain:oneOf(['feishu','lark','bytedance'],b.domain)?b.domain:'feishu',allowedUsers,enabled:false,verifiedAt:null};
}
// Claude permission modes a binding starts its topic agents with: default sends the confirmations Claude asks for to Feishu as cards,
// auto lets Claude decide and rarely asks. Codex and Antigravity (agy) bindings have none.
const permissionModes:PermissionMode[]=['default','auto'];
function claudeMode(v:unknown){if(!oneOf(permissionModes,v))throw Error('权限模式无效');return v;}
// The permission mode of a Claude binding; one saved before bindings had a mode has none and uses default.
export const permissionMode=<T>(b:{permissionMode?:T})=>b.permissionMode||'default';
// Herdr agent kinds a binding can start in its topics.
const agentKinds:Kind[]=['claude','codex','agy'];
// A binding routes one chat of an app; every topic in that chat gets its own agent session in Herdr (see topics.ts).
// chat is the pending chat that asked for it (see pending-chats.ts): app and chat never come from the client, and a direct chat needs no mention.
export function normalizeBinding(b:{name?:unknown,machineId:string,cwd?:unknown,kind?:unknown,permissionMode?:unknown,requireMention?:unknown,[field:string]:unknown},
 chat:{appId:string,chatId:string,chatType:'p2p'|'group'},bindings:Pick<Binding,'appId'|'chatId'>[]):Binding{
 if(!oneOf(agentKinds,b.kind))throw Error('Agent 类型无效');
 if(bindings.some(x=>x.appId===chat.appId&&x.chatId===chat.chatId))throw Error('该聊天已有绑定，请先移除旧绑定');
 return {id:uuid(),name:text(b.name,60),appId:chat.appId,machineId:b.machineId,chatId:chat.chatId,cwd:hostPath(b.cwd,'工作目录'),kind:b.kind,...b.kind==='claude'&&{permissionMode:claudeMode(permissionMode(b))},requireMention:chat.chatType==='group'&&b.requireMention!==false,enabled:true};
}
// Topics already open keep the mode their agent started with; the next topics start with the new one.
export function setPermissionMode(binding:Binding,mode:unknown){if(binding.kind!=='claude')throw Error('只有 Claude 绑定可以设置权限模式');binding.permissionMode=claudeMode(mode);}
// Bridge takes every message of a person. Mentions are left to routing and topic handling.
export const routable=(msg:Pick<NormalizedMessage,'senderType'|'senderId'>)=>msg.senderType==='user'&&Boolean(msg.senderId);
// The kinds of messages whose content Bridge can hand to an agent: text, and rich text with its images and files, an image and a file (see
// attachments.ts). Bridge gets nothing out of the others, such as stickers, merged forwards and cards.
export const supported=(msg:Pick<NormalizedMessage,'rawContentType'>)=>['text','post','image','file'].includes(msg.rawContentType);
// A message that Bridge can prompt an agent with: of a supported kind, with content of at most 16000 characters.
export function forwardable(msg:Pick<NormalizedMessage,'rawContentType'|'content'>){const content=msg.content?.trim();return supported(msg)&&Boolean(content)&&content.length<=16000;}
// A failed download of a message resource: Feishu answers with a JSON body, which a stream response carries as a stream. Keeps Feishu's
// code like openApi; any other failure stays as it is.
async function resourceError(e:Error&{response?:{data?:any}}){
 const body=e.response?.data;if(typeof body?.[Symbol.asyncIterator]!=='function')return e;
 let text='';try{for await(const chunk of body){text+=chunk;if(text.length>4096)break;}const {code,msg}=JSON.parse(text);if(code)return Object.assign(Error(`飞书接口错误 ${code}：${msg||''}`),{code});}catch{}
 return e;
}
const tooLarge=()=>Object.assign(Error('超过下载上限'),{code:'too_large'});
// The connection of an app (see Platforms.channel).
type Runtime={state:'idle'|'connecting'|'connected'|'reconnecting'|'error',error:string,stopped:boolean,channel:LarkChannel,connecting?:Promise<void>|null};
type Deps={onMessage:(app:App,binding:Binding,msg:NormalizedMessage)=>unknown,onUnbound:(app:App,msg:NormalizedMessage)=>unknown,
 onCardAction:(app:App,evt:Click)=>CardActionResponse|Promise<CardActionResponse>,channelFactory?:(options:LarkChannelOptions)=>LarkChannel,fetch?:typeof globalThis.fetch};
export class Platforms{
 declare store:Store;declare onMessage:Deps['onMessage'];declare onUnbound:Deps['onUnbound'];declare onCardAction:Deps['onCardAction'];
 declare channelFactory:NonNullable<Deps['channelFactory']>;declare fetch:typeof globalThis.fetch;declare runtime:Map<string,Runtime>;
 // onMessage(app,binding,msg) receives every allowed message of a bound chat; onUnbound(app,msg) the ones that ask for a binding;
 // onCardAction(app,evt) every card click of a person on the allowlist and returns the callback response. fetch downloads bot avatars.
 constructor(store:Store,{onMessage,onUnbound,onCardAction,channelFactory=createLarkChannel,fetch=globalThis.fetch}:Deps){this.store=store;this.onMessage=onMessage;this.onUnbound=onUnbound;this.onCardAction=onCardAction;this.channelFactory=channelFactory;this.fetch=fetch;this.runtime=new Map();}
 app(id:string){const a=this.store.data.apps.find(x=>x.id===id);if(!a)throw Error('应用不存在');return a;}
 status(a:App){const r=this.runtime.get(a.id);return {...a,appSecret:undefined,hasSecret:!!a.appSecret,connection:a.enabled?(r?.state==='error'?'error':r?.channel.getConnectionStatus()?.state||r?.state||'connecting'):'disabled',error:r?.error||''};}
 channel(a:App){
  const existing=this.runtime.get(a.id);if(existing)return existing.channel;
  const channel=this.channelFactory({appId:a.appId,appSecret:a.appSecret,domain:domains[a.domain],source:'herdr-bridge',cache:channelCache(),
   httpTimeoutMs:10000,connectTimeoutMs:15000,resolveSenderNames:false,resolveChatMode:false,
   // Mention requirements differ per binding. Bridge checks group senders as well as DM senders.
   policy:{requireMention:false,respondToMentionAll:false,dmMode:'allowlist',dmAllowlist:a.allowedUsers},
   // Handle each platform message on its own: no merging while busy and no batching delay. Card clicks take a queue of their own, so
   // that a click never waits behind the chat's messages.
   safety:{chatQueue:{enabled:true,mergeWhileBusy:false,cardActions:'separate'},batch:{text:{delayMs:0},media:{delayMs:0}}},
   // A send whose result is unknown is never repeated.
   outbound:{retry:{maxAttempts:1}},
   logger:{trace(){},debug(){},info(){},warn(){},error(){}},
  });
  const rt:Runtime={state:'idle',error:'',stopped:false,channel};this.runtime.set(a.id,rt);
  const current=()=>this.runtime.get(a.id)===rt&&!rt.stopped;
  channel.on('message',msg=>{if(current())this.receive(a,msg);});
  channel.on('cardAction',evt=>current()?this.cardAction(a,evt):undefined);
  channel.on('error',()=>{if(current()){rt.error='飞书连接异常';this.store.log('平台连接',a.name+' 连接异常','error');}});
  channel.on('reconnecting',()=>{if(current()){rt.state='reconnecting';this.store.log('平台连接',a.name+' 正在重连');}});
  channel.on('reconnected',()=>{if(current()){rt.state='connected';rt.error='';this.store.log('平台连接',a.name+' 已连接');}});
  return channel;
 }
 async verify(a:App){await this.syncBot(a,this.channel(a));a.verifiedAt=Date.now();this.store.save();return {verified:true,name:a.name};}
 // Feishu is the source of the app name and the bot's open_id. A failed avatar download is only logged and keeps the previous avatar.
 async syncBot(a:App,channel:LarkChannel){
  const d=await channel.rawClient.request({url:'/open-apis/bot/v3/info',method:'GET'});
  const bot=d.bot||d.data?.bot;if((d.code!==undefined&&d.code!==0)||!bot?.open_id)throw Error('应用凭证验证失败');
  a.name=bot.app_name?String(bot.app_name).slice(0,60):a.name;a.botOpenId=bot.open_id;this.store.save();
  try{await this.saveAvatar(a,bot.avatar_url);}catch(e){this.store.log('应用信息',`${a.name}：头像未更新，${e.message}`,'error');}
 }
 // Only an https PNG, JPEG, GIF or WebP image of at most 1 MB is stored, as avatars/<app id> in the state directory.
 async saveAvatar(a:App,url?:string){
  if(!url)return;if(new URL(url).protocol!=='https:')throw Error('头像地址不是 https');
  const r=await this.fetch(url,{signal:AbortSignal.timeout(10000)});
  if(r.url&&new URL(r.url).protocol!=='https:')throw Error('头像地址不是 https');if(!r.ok)throw Error('头像下载失败，HTTP '+r.status);
  const type=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();if(!avatarTypes.has(type))throw Error('头像不是 PNG、JPEG、GIF 或 WebP 图片');
  const chunks:Uint8Array[]=[];let size=0;for await(const chunk of r.body||[]){size+=chunk.length;if(size>avatarLimit)throw Error('头像超过 1 MB');chunks.push(chunk);}
  // The app may have been removed while downloading.
  if(!this.store.data.apps.includes(a))return;
  const file=this.avatarFile(a.id);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',Buffer.concat(chunks),{mode:0o600});fs.renameSync(file+'.tmp',file);
  a.avatar={type,updatedAt:Date.now()};this.store.save();
 }
 avatarFile(id:string){return path.join(this.store.dir,'avatars',id);}
 // The stored avatar of an app as {type,body}, or null.
 async avatar(id:string|null){const a=this.store.data.apps.find(x=>x.id===id);if(!a?.avatar)return null;try{return {type:a.avatar.type,body:await fs.promises.readFile(this.avatarFile(a.id))};}catch{return null;}}
 async remove(id:string){const a=this.app(id);await this.stop(a.id);this.store.data.apps=this.store.data.apps.filter(x=>x!==a);this.store.save();fs.rmSync(this.avatarFile(a.id),{force:true});}
 async dispose(channel:LarkChannel){
  // SDK 0.7.1 disconnect() returns early before the handshake; also close that pending socket.
  channel.rawWsClient?.close({force:true});await channel.disconnect();
 }
 async stop(id:string){const rt=this.runtime.get(id);if(!rt)return;rt.stopped=true;this.runtime.delete(id);try{await this.dispose(rt.channel);}catch{}}
 async start(a:App){
  if(!a.allowedUsers.length)throw Error('启用前至少指定一位允许操作的飞书用户');
  // channel(a) keeps the runtime of the app.
  const channel=this.channel(a),rt=this.runtime.get(a.id)!;
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
  await this.syncCommands(a,channel);
  })();return rt.connecting;
 }
 // Offers the bridge's commands in the slash command panel of the app on every connection. Never rejects: without the scopes, or when
 // Feishu refuses, one line is logged and the commands still work when typed.
 async syncCommands(a:App,channel:LarkChannel){
  try{const changed=await registerCommands(o=>openApi(channel,o));if(changed.length)this.store.log('斜杠命令',`${a.name}：已注册斜杠命令 ${changed.map(c=>'/'+c).join('、')}`);}
  catch(e){this.store.log('斜杠命令',`${a.name}：未能注册斜杠命令，${missingScope.includes(e.code)?'应用缺少权限 application:app_slash_command:read / write；命令仍可手动输入':e.message}`,'error');}
 }
 receive(a:App,msg:NormalizedMessage){if(!a.enabled||!a.allowedUsers.includes(msg.senderId)||!routable(msg))return;
  const b=this.store.data.bindings.find(x=>x.appId===a.id&&x.chatId===msg.chatId);
  // A bound chat takes what an agent can be prompted with, and the kinds that Bridge cannot forward, which get a notice (see Topics.handle).
  if(b){if(b.enabled&&(forwardable(msg)||!supported(msg)))this.onMessage(a,b,msg);}
  // A chat without a binding asks for one, whatever the message holds: a direct chat with any message, a group only by mentioning the bot.
  else if(msg.chatType==='p2p'||msg.mentionedBot)this.onUnbound(a,msg);
 }
 // Like messages, a card click counts only from someone on the allowlist; anyone else in the chat can click too.
 // The value of the button is the one that Bridge drew (see ButtonValue), which Feishu returns as it is.
 cardAction(a:App,evt:CardActionEvent){if(!a.enabled||!a.allowedUsers.includes(evt.operator?.openId))return {toast:{type:'error',content:'你不在这个应用的允许名单中，不能处理这个请求'}};return this.onCardAction(a,evt as Click);}
 // A reply inside the topic thread; replying in thread is what turns a plain group message into a topic. content is {card} with a card
 // JSON, which goes out as one message whatever its size; resolves to the id of the message sent.
 async reply(a:App,chatId:string,rootId:string,content:{card:object}){return (await this.connected(a).send(chatId,content,{replyTo:rootId,replyInThread:true})).messageId;}
 // A message of the bot in the chat itself, outside any thread, which can be the root of a topic (see schedules.ts). content is {card} like
 // for reply; resolves to the id of the message sent.
 async send(a:App,chatId:string,content:{card:object}){return (await this.connected(a).send(chatId,content)).messageId;}
 // Replaces the whole content of a card the bot sent.
 async updateCard(a:App,messageId:string,card:object){await this.connected(a).updateCard(messageId,card);}
 // The bot's emoji reaction on a message. Resolves to the reaction id, which is the only way to remove it again.
 async react(a:App,messageId:string,emojiType:string){return this.connected(a).addReaction(messageId,emojiType);}
 async unreact(a:App,messageId:string,reactionId:string){await this.connected(a).removeReaction(messageId,reactionId);}
 // An OpenAPI call that the SDK does not cover, such as the COT calls (see openApi).
 async request(a:App,options:OpenApiOptions){return openApi(this.connected(a),options);}
 // Resource r ({type, fileKey}, type image or file) of message messageId, received by app a, as {body, type}, type its content type without
 // parameters. A body over limit bytes is refused with code too_large: by the length the response announces before any of the body is read,
 // and by what arrives when it announces none or too little. Feishu's own failures keep their code (see resourceError).
 async download(a:App,messageId:string,r:Pick<Attachment,'type'|'fileKey'|'fileName'>,limit:number){
  let response;try{response=await this.connected(a).rawClient.im.v1.messageResource.get({path:{message_id:messageId,file_key:r.fileKey},params:{type:r.type}});}catch(e){throw await resourceError(e);}
  const header=(name:string)=>response.headers?.[name]??response.headers?.[name.replace(/(^|-)./g,c=>c.toUpperCase())];
  const stream=response.getReadableStream();if(Number(header('content-length'))>limit){stream.destroy();throw tooLarge();}
  const chunks:Buffer[]=[];let size=0;for await(const chunk of stream){size+=chunk.length;if(size>limit){stream.destroy();throw tooLarge();}chunks.push(chunk);}
  return {body:Buffer.concat(chunks),type:String(header('content-type')||'').split(';')[0].trim().toLowerCase()};
 }
 connected(a:App){const channel=this.runtime.get(a.id)?.channel;if(!channel||channel.getConnectionStatus()?.state!=='connected')throw Error('飞书未连接');return channel;}
}
