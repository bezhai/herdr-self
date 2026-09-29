import {createLarkChannel} from '@larksuite/channel';
import {text,uuid,hostPath} from './core.mjs';
const domains={feishu:'https://open.feishu.cn',lark:'https://open.larksuite.com',bytedance:'https://fsopen.bytedance.net'};
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
export function normalizeBinding(b,bindings){
 const chatId=text(b.chatId,100);if(!/^oc_[a-zA-Z0-9]+$/.test(chatId))throw Error('Chat ID 应以 oc_ 开头');
 if(!['claude','codex'].includes(b.kind))throw Error('Agent 类型无效');
 if(bindings.some(x=>x.appId===b.appId&&x.chatId===chatId))throw Error('该聊天已有绑定，请先移除旧绑定');
 return {id:uuid(),name:text(b.name,60),appId:b.appId,machineId:b.machineId,chatId,cwd:hostPath(b.cwd,'工作目录'),kind:b.kind,requireMention:b.requireMention!==false,enabled:true};
}
// Mentions are not checked here: requireMention only gates the message that opens a topic.
export function selectBinding(bindings,appId,msg){
 if(msg.senderType!=='user'||!['text','post'].includes(msg.rawContentType)||!msg.senderId||msg.resources?.length)return null;
 return bindings.find(b=>b.enabled&&b.appId===appId&&b.chatId===msg.chatId)||null;
}
export class Platforms{
 // onMessage(app,binding,msg) receives every allowed message that matches a binding.
 constructor(store,{onMessage,channelFactory=createLarkChannel}){this.store=store;this.onMessage=onMessage;this.channelFactory=channelFactory;this.runtime=new Map();}
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
 async verify(a){
  const d=await this.channel(a).rawClient.request({url:'/open-apis/bot/v3/info',method:'GET'});
  const bot=d.bot||d.data?.bot;if((d.code!==undefined&&d.code!==0)||!bot?.open_id)throw Error('应用凭证验证失败');
  a.botName=bot.app_name||a.name;a.botOpenId=bot.open_id;a.verifiedAt=Date.now();this.store.save();return {verified:true,botName:a.botName};
 }
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
   const bot=channel.getBotIdentity();a.botName=bot.name;a.botOpenId=bot.openId;a.verifiedAt=Date.now();rt.state='connected';this.store.save();this.store.log('平台连接',a.name+' 已连接');
  }catch(e){
   await this.dispose(channel).catch(()=>{});
   if(this.runtime.get(a.id)===rt){rt.state='error';rt.error='飞书连接失败，请检查应用配置';}
   throw Error('飞书连接失败，请检查应用配置');
  }finally{rt.connecting=null;}})();return rt.connecting;
 }
 receive(a,msg){if(!a.enabled||!a.allowedUsers.includes(msg.senderId))return;
  const b=selectBinding(this.store.data.bindings,a.id,msg);if(!b)return;
  const content=msg.content?.trim();if(!content||content.length>16000)return;
  this.onMessage(a,b,msg);
 }
 // A reply inside the topic thread; replying in thread is what turns a plain group message into a topic.
 async reply(a,chatId,rootId,text){
  const channel=this.runtime.get(a.id)?.channel;if(!channel||channel.getConnectionStatus()?.state!=='connected')throw Error('飞书未连接');
  await channel.send(chatId,{text},{replyTo:rootId,replyInThread:true});
 }
}
