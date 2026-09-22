import {createLarkChannel} from '@larksuite/channel';
import {text,uuid,publicText} from './core.mjs';
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
export function selectBinding(bindings,appId,msg){
 if(msg.senderType!=='user'||!['text','post'].includes(msg.rawContentType)||!msg.senderId||msg.resources?.length)return null;
 return bindings.find(b=>b.enabled&&b.appId===appId&&b.chatId===msg.chatId&&(!b.rootId||b.rootId===(msg.rootId||msg.messageId))&&(!b.requireMention||msg.mentionedBot))||null;
}
export class Platforms{
 constructor(store,bridge,{channelFactory=createLarkChannel}={}){this.store=store;this.bridge=bridge;this.channelFactory=channelFactory;this.runtime=new Map();this.busy=false;}
 app(id){const a=this.store.data.apps.find(x=>x.id===id);if(!a)throw Error('应用不存在');return a;}
 status(a){const r=this.runtime.get(a.id);return {...a,appSecret:undefined,hasSecret:!!a.appSecret,connection:a.enabled?(r?.state==='error'?'error':r?.channel.getConnectionStatus()?.state||r?.state||'connecting'):'disabled',error:r?.error||''};}
 channel(a){
  const existing=this.runtime.get(a.id);if(existing)return existing.channel;
  const rt={state:'idle',error:'',stopped:false};
  const channel=this.channelFactory({appId:a.appId,appSecret:a.appSecret,domain:domains[a.domain],source:'herdr-bridge',cache:channelCache(),
   httpTimeoutMs:10000,connectTimeoutMs:15000,resolveSenderNames:false,resolveChatMode:false,
   // Mention requirements differ per binding. Bridge checks group senders as well as DM senders.
   policy:{requireMention:false,respondToMentionAll:false,dmMode:'allowlist',dmAllowlist:a.allowedUsers},
   // Keep one platform message per durable job; approvals have an independent SDK queue.
   safety:{chatQueue:{enabled:true,mergeWhileBusy:false,cardActions:'separate'},batch:{text:{delayMs:0},media:{delayMs:0}}},
   // Persistent outbox owns uncertainty: an unconfirmed delivery must not be replayed.
   outbound:{retry:{maxAttempts:1},textChunkLimit:8000},
   logger:{debug(){},info(){},warn(){},error(){}},
  });
  rt.channel=channel;this.runtime.set(a.id,rt);
  const current=()=>this.runtime.get(a.id)===rt&&!rt.stopped;
  channel.on('message',msg=>{if(current())this.receive(a,msg);});
  channel.on('cardAction',async event=>{try{if(!current())throw Error('连接已停用');return await this.approval(a,event);}catch(e){return {toast:{type:'error',content:publicText(e.message).slice(0,100)}};}});
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
 receive(a,msg){const who=msg.senderId;if(!a.enabled||!a.allowedUsers.includes(who))return;
 const b=selectBinding(this.store.data.bindings,a.id,msg);if(!b)return;
 const mid=msg.messageId;if(!mid||this.store.data.inbox.some(x=>x.appId===a.id&&x.messageId===mid))return;
 const content=msg.content?.trim();if(!content||content.length>16000)return;
 this.store.data.inbox.push({id:uuid(),appId:a.id,bindingId:b.id,target:{machineId:b.machineId,adapterId:b.adapterId,nativeId:b.nativeId,paneId:b.paneId},messageId:mid,chatId:msg.chatId,replyInThread:b.replyInThread,who,text:content,createdAt:Date.now(),status:'queued'});this.store.save();this.store.log('收到消息',a.name+' → '+b.name+'，已排队');
 }
 async approval(a,e){const v=e.action?.value,who=e.operator?.openId;if(!a.enabled||!a.allowedUsers.includes(who))throw Error('无操作权限');const inbox=this.store.data.inbox.find(x=>x.id===v?.runId&&x.appId===a.id);if(!inbox||inbox.status!=='running')throw Error('该轮任务已结束或不存在');if(!['allow','deny'].includes(v.behavior))throw Error('无效审批');
 const b=this.store.data.bindings.find(x=>x.id===inbox.bindingId&&x.enabled);if(!b)throw Error('连接已解除');
 await this.bridge.sendTarget(inbox.target,{kind:'permission',request_id:v.requestId,behavior:v.behavior});return {toast:{type:'success',content:'已提交响应，等待 Agent 处理'}};
 }
 async deliverOnce(a,key,run,content,type='text'){
  let out=this.store.data.outbox.find(x=>x.key===key);if(out)return out.status==='sent';
  out={key,status:'sending',at:Date.now(),appId:a.id};this.store.data.outbox.push(out);this.store.save();
  try{const channel=this.runtime.get(a.id)?.channel;if(!channel||channel.getConnectionStatus()?.state!=='connected')throw Error('飞书未连接');const result=await channel.send(run.chatId,type==='interactive'?{card:content}:content.text.split('\n').some(line=>line.length>7500)?{text:content.text}:{markdown:content.text},{replyTo:run.messageId,replyInThread:run.replyInThread});out.messageId=result.messageId;out.chunkIds=result.chunkIds;out.status='sent';this.store.log('已投递',a.name+' · '+(type==='text'?'回复':'审批卡片'));return true;}catch(e){out.status='unknown';out.error=e.code==='send_timeout'?'发送超时，结果待核查':'发送结果未确认';this.store.log('投递待核查',a.name+'：'+out.error,'error');return false;}finally{this.store.save();}
 }
 async tick(){if(this.busy)return;this.busy=true;try{
 for(const job of this.store.data.inbox.filter(x=>['queued','running'].includes(x.status))){
  const a=this.store.data.apps.find(a=>a.id===job.appId&&a.enabled);const binding=this.store.data.bindings.find(b=>b.id===job.bindingId&&b.enabled);if(!a||!binding||!a.allowedUsers.includes(job.who))continue;
  try{
   const snap=await this.bridge.snapshotTarget(job.target);
   if(job.status==='queued'){
    if(snap.status!=='ready')continue;
    if(!a.enabled||!a.allowedUsers.includes(job.who)||!this.store.data.apps.includes(a)||!this.store.data.bindings.some(b=>b.id===job.bindingId&&b.enabled))continue;
    // Persist uncertainty before submission; a crash must never replay a possibly executed prompt.
    job.status='dispatching';this.store.save();await this.bridge.sendTarget(job.target,{kind:'message',chat_id:job.id,text:job.text});job.status='running';job.startedAt=Date.now();this.store.save();continue;
   }
   if(!a.enabled||!this.store.data.apps.includes(a)||!this.store.data.bindings.some(b=>b.id===job.bindingId&&b.enabled))continue;
   const reply=snap.events.find(e=>e.kind==='reply'&&e.data.chat_id===job.id);
   if(reply){const ok=await this.deliverOnce(a,job.id+':reply',job,{text:publicText(reply.data.text)});job.status=ok?'completed':'delivery_unknown';this.store.save();continue;}
   for(const p of snap.permissions.filter(x=>x.status==='pending')){
    await this.deliverOnce(a,job.id+':approval:'+p.request_id,job,{config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'Claude 需要审批'},template:'orange'},elements:[{tag:'div',text:{tag:'plain_text',content:publicText(p.tool_name+'\n'+p.input_preview).slice(0,2000)}},{tag:'action',actions:['allow','deny'].map(behavior=>({tag:'button',text:{tag:'plain_text',content:behavior==='allow'?'允许这一次':'拒绝'},type:behavior==='allow'?'primary':'default',value:{runId:job.id,requestId:p.request_id,behavior}}))}]},'interactive');
   }
   if(snap.status==='ready'&&snap.events.some(e=>e.kind==='hook'&&e.data.hook_event_name==='Stop'&&e.at>job.startedAt)){
    job.status='no_reply';this.store.log('需要关注','任务结束但未收到 Channel reply，请在原生会话查看','error');this.store.save();
   }
  }catch(e){if(job.status==='dispatching')job.status='delivery_unknown';if(!job.lastError||job.lastError!==e.message){job.lastError=e.message;this.store.log('路由等待',e.message,'error');this.store.save();}}
 }
 }finally{this.busy=false;}}
}
