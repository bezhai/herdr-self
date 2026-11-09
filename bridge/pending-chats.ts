import crypto from 'node:crypto';
import {normalizeBinding,forwardable} from './platform.ts';
import {notice,linkNotice} from './message-cards.ts';
import type {NormalizedMessage} from '@larksuite/channel';
import type {Store} from './core.ts';
import type {App,Binding,Machine} from './state.ts';
// A chat that writes to an app before it has a binding: it gets a link, and the binding saved through that link starts with its first message.
const lifetime=30*60000;
const chatLabel=(type:string)=>type==='p2p'?'私聊':'群聊';
// BRIDGE_URL: the console's public origin for binding links, http(s) without path, query or fragment; a trailing / is dropped. Unset means no link.
export function consoleUrl(value:string|undefined){
 if(!value)return '';let u;try{u=new URL(value);}catch{}
 if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('BRIDGE_URL 应为 http(s) 地址，不带路径、查询参数和 #，例如 http://host:8080');
 return u.origin;
}
// A chat without a binding that asked for one, with its first message, until the binding is saved or the link expires.
type Chat={token:string,appId:string,chatId:string,chatType:'p2p'|'group',message:NormalizedMessage,createdAt:number,expiresAt:number};
type Deps={reply:(app:App,chatId:string,rootId:string,content:{card:object})=>Promise<string>,onBound:(app:App,binding:Binding,msg:NormalizedMessage)=>unknown,
 app:(id:string)=>App,machine:(id:unknown)=>Machine,bridgeUrl?:string,now?:()=>number};
export class PendingChats{
 declare store:Store;declare reply:Deps['reply'];declare onBound:Deps['onBound'];declare app:Deps['app'];declare machine:Deps['machine'];declare bridgeUrl:string;
 declare now:()=>number;declare chats:Map<string,Chat>;
 // reply(app,chatId,rootId,{card}) answers in the thread of a message with a card; onBound(app,binding,msg) takes the first message of a newly bound chat;
 // app(id) and machine(id) return an app or a machine, or throw.
 // Records stay in memory only: the first message never reaches the disk or the browser, and a restart forgets every link.
 constructor(store:Store,{reply,onBound,app,machine,bridgeUrl='',now=Date.now}:Deps){this.store=store;this.reply=reply;this.onBound=onBound;this.app=app;this.machine=machine;this.bridgeUrl=bridgeUrl;this.now=now;this.chats=new Map();}
 // A message from a chat without a binding. Only the first one within the lifetime is kept and answered.
 async open(a:App,msg:NormalizedMessage){
  this.prune();const key=JSON.stringify([a.id,msg.chatId]);if(this.chats.has(key))return;
  const createdAt=this.now(),chat:Chat={token:crypto.randomBytes(16).toString('base64url'),appId:a.id,chatId:msg.chatId,chatType:msg.chatType==='p2p'?'p2p':'group',message:msg,createdAt,expiresAt:createdAt+lifetime};
  this.chats.set(key,chat);this.store.log('会话绑定',`${a.name}：${chatLabel(chat.chatType)} ${chat.chatId} 尚未绑定，回复绑定${this.bridgeUrl?'链接':'提示'}`);
  const card=this.bridgeUrl?linkNotice('这个聊天还没有连接到 Herdr，打开链接完成绑定：',`${this.bridgeUrl}/?bind=${chat.token}`):notice('这个聊天还没有连接到 Herdr，请在 Bridge 管理台「会话绑定」中完成绑定。');
  try{await this.reply(a,chat.chatId,msg.messageId,{card});}catch(e){this.store.log('会话绑定',`${a.name}：绑定提示未发出，${e.message}`,'error');}
 }
 // Live records without their messages.
 list(){this.prune();return [...this.chats.values()].map(({message,...chat})=>chat);}
 // Removes and returns the live record of a token, or null.
 take(token:string){this.prune();for(const [key,chat] of this.chats)if(chat.token===token){this.chats.delete(key);return chat;}return null;}
 prune(){const now=this.now();for(const [key,chat] of this.chats)if(chat.expiresAt<=now)this.chats.delete(key);}
 // Saves the binding asked for through b.token. App and chat come from the record, never from the client; an invalid form keeps the token.
 // The first message then opens the chat's first topic in the background, when an agent can be prompted with it: a message that only
 // mentions the bot, or of a kind that Bridge cannot forward, asked for the binding and opens nothing.
 bind(b:{token?:unknown,machineId?:unknown,[field:string]:unknown}){
  const chat=this.list().find(x=>x.token===b.token);if(!chat)throw Error('绑定链接已失效，请在飞书里重新发消息');
  // The record was just listed, and take finds it.
  const a=this.app(chat.appId),m=this.machine(b.machineId),binding=normalizeBinding({...b,machineId:m.id},chat,this.store.data.bindings),{message}=this.take(chat.token)!;
  this.store.data.bindings.push(binding);this.store.save();this.store.log('会话绑定',`${binding.name} → ${m.name} · ${binding.kind} · ${binding.cwd}`);
  if(forwardable(message))this.onBound(a,binding,message);return binding;
 }
}
