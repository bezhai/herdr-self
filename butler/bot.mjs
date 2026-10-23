// The bot: butler's own Feishu app, on the SDK's long connection (a WebSocket the SDK keeps up and reconnects), held
// by the processor's process. Only the owner can talk to it: the SDK takes direct messages only from the owner's
// open_id, and the bot checks again that a message is the owner's and in the direct chat before handing it on (the
// app has no scope for group messages anyway). It writes to the owner's direct chat by that open_id.
import {createLarkChannel} from '@larksuite/channel';

export const DOMAINS={feishu:'https://open.feishu.cn',lark:'https://open.larksuite.com'};
const quiet={debug(){},info(){},warn(){},error(){}};
const message=e=>e?.message??String(e);

export class Bot{
 #channel;#state='idle';#stopped=false;#wake;
 // Gets every message of the owner's, in the direct chat.
 onMessage=()=>{};
 // owner: the owner's open_id for this app; the connection's state goes to the store (meta bot) for status.
 constructor({store,appId,appSecret,domain='feishu',owner,channelFactory=createLarkChannel,log=()=>{},retryMinMs=10_000,retryMaxMs=300_000}){
  Object.assign(this,{store,appId,appSecret,domain,owner,channelFactory,log,retryMinMs,retryMaxMs});
 }
 get connected(){return this.#state==='connected';}
 // Connects, trying again with growing pauses until it does or stop() is called; resolves then.
 async start(){
  this.#stopped=false;
  for(let wait=this.retryMinMs;!this.#stopped;wait=Math.min(2*wait,this.retryMaxMs)){
   this.#set('connecting');
   const channel=this.#open();
   try{await channel.connect();}
   catch(e){
    // SDK 0.7.1: disconnect() does nothing before the handshake, so the pending socket is closed here (as in the bridge).
    channel.rawWsClient?.close({force:true});
    if(this.#stopped)return;
    this.#set('error',{error:message(e)});this.store.addError('机器人',`连接飞书失败，${Math.round(wait/1000)} 秒后重试：${message(e)}`);
    await new Promise(r=>{const t=setTimeout(r,wait);this.#wake=()=>{clearTimeout(t);r();};});continue;
   }
   if(this.#stopped){await this.#dispose(channel);return;}
   this.#channel=channel;this.#set('connected',{connectedAt:Date.now()});this.log('管家机器人已连上飞书');return;
  }
 }
 async stop(){
  this.#stopped=true;this.#wake?.();
  const channel=this.#channel;this.#channel=undefined;
  if(channel)await this.#dispose(channel).catch(()=>{});
  this.#set('stopped');
 }
 // A message to the owner's direct chat.
 toOwner(input){return this.#ready().send(this.owner,input);}
 // A reply to a message of the owner's.
 reply(msg,input){return this.#ready().send(msg.chatId,input,{replyTo:msg.messageId});}

 #ready(){if(!this.#channel)throw Error('机器人没有连上飞书');return this.#channel;}
 #set(state,extra={}){
  this.#state=state;
  this.store.setMeta('bot',{state,since:Date.now(),appId:this.appId,connectedAt:this.store.meta('bot')?.connectedAt,...extra});
 }
 async #dispose(channel){channel.rawWsClient?.close({force:true});await channel.disconnect();}
 #open(){
  const channel=this.channelFactory({appId:this.appId,appSecret:this.appSecret,domain:DOMAINS[this.domain],source:'herdr-butler',
   httpTimeoutMs:10_000,connectTimeoutMs:15_000,resolveSenderNames:false,resolveChatMode:false,
   policy:{requireMention:true,respondToMentionAll:false,dmMode:'allowlist',dmAllowlist:[this.owner]},
   // Each message on its own, at once: the conversation acknowledges it and queues the turn itself.
   safety:{chatQueue:{enabled:true,mergeWhileBusy:false},batch:{text:{delayMs:0},media:{delayMs:0}}},
   // A send whose result is unknown is not repeated.
   outbound:{retry:{maxAttempts:1}},logger:quiet});
  const current=()=>this.#channel===channel;
  channel.on('message',msg=>{
   if(!current()||msg.chatType!=='p2p'||!msg.senderId||msg.senderId!==this.owner)return;
   return this.onMessage(msg);
  });
  channel.on('reconnecting',()=>{if(current())this.#set('reconnecting');});
  channel.on('reconnected',()=>{if(current())this.#set('connected',{connectedAt:Date.now()});});
  channel.on('error',e=>{if(current())this.store.addError('机器人',`飞书连接异常：${message(e)}`);});
  return channel;
 }
}
