import {notice} from './message-cards.ts';
import type {NormalizedMessage} from '@larksuite/channel';
import type {Store} from './core.ts';
import type {App} from './state.ts';
// A chat that writes to an app before it has a binding is told so once within the lifetime. The binding itself is made in the chat, not
// in the console.
const lifetime=30*60000;
const chatLabel=(type:string)=>type==='p2p'?'私聊':'群聊';
// BRIDGE_URL: the console's public origin, http(s) without path, query or fragment; a trailing / is dropped. Unset means none.
export function consoleUrl(value:string|undefined){
 if(!value)return '';let u;try{u=new URL(value);}catch{}
 if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('BRIDGE_URL 应为 http(s) 地址，不带路径、查询参数和 #，例如 http://host:8080');
 return u.origin;
}
type Deps={reply:(app:App,chatId:string,rootId:string,content:{card:object})=>Promise<string>,now?:()=>number};
export class PendingChats{
 declare store:Store;declare reply:Deps['reply'];declare now:()=>number;declare told:Map<string,number>;
 // reply(app,chatId,rootId,{card}) answers in the thread of a message with a card. Records stay in memory only: a restart forgets them.
 constructor(store:Store,{reply,now=Date.now}:Deps){this.store=store;this.reply=reply;this.now=now;this.told=new Map();}
 // A message from a chat without a binding. Only the first one within the lifetime is answered.
 async open(a:App,msg:NormalizedMessage){
  const now=this.now();for(const [key,expires] of this.told)if(expires<=now)this.told.delete(key);
  const key=JSON.stringify([a.id,msg.chatId]);if(this.told.has(key))return;
  this.told.set(key,now+lifetime);this.store.log('会话绑定',`${a.name}：${chatLabel(msg.chatType)} ${msg.chatId} 尚未绑定`);
  try{await this.reply(a,msg.chatId,msg.messageId,{card:notice('这个聊天还没有绑定 Bridge。')});}catch(e){this.store.log('会话绑定',`${a.name}：绑定提示未发出，${e.message}`,'error');}
 }
}
