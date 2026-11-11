import {invalid,string} from './machine-tools.ts';
import type {Methods,ClientApi} from './link.ts';
// The owner's channel: open-lark, a Feishu web client logged in as the owner, which runs on one machine and listens there only. The client
// of that machine reads chats and messages and sends messages through open-lark's agent API (/agent/v1) as the owner, for the control
// plane (see ClientApi in link.ts, where the methods and their error codes are). The full token of open-lark, which can do whatever the
// owner can in Feishu, is in that client's config file only (see readConfig in client.ts): it never travels, never reaches the control
// plane, and is in the environment of no program that the client runs. Ids are open-lark's, not the open platform's ids of the bot. It
// uses only Node's built-in modules, like the client.

// openLark of the config of a client (see readConfig): url, the origin of open-lark's agent server on this machine, such as
// http://127.0.0.1:8081, and token, its full token.
export type OpenLark={url:string,token:string};
type OwnerMethods=Pick<Methods<ClientApi>,'openLarkMessage'|'openLarkChat'|'openLarkReply'|'openLarkSend'>;
// The part of open-lark's stored message that the owner's channel reads. Other parts keep their text; files name themselves in text.
type Part={kind:string,text?:string};
// The fields of open-lark's message, conversation and current-account responses used here.
type Item={id:string,feedId:string,senderId:string,senderName:string,createdAt:string,parts:Part[],textPreview?:string};
type Conversation={feedId:string,name:string,chatMode:'direct'|'group'|'topic'};
type Me={userId:string,displayName:string};
// A send is acknowledged by its real message id. Current open-lark has no timestamp here; accept its ISO createdAt or sentAt when it has one.
type SendAnswer={messageId:string,createdAt?:string,sentAt?:string};
// The outgoing fields as the ClientApi receives them, before mentions take open-lark's userId spelling.
type Outgoing={clientId:string,text:string,mentions:{id:string,name:string}[]};
// An error whose code crosses the client link, with no response body or credential copied into it.
const coded=(code:string,message:string)=>Object.assign(Error(message),{code});
// A connection failure and a timeout deliberately look alike to the caller: after either, a send may or may not have gone out.
const unreachable=()=>coded('channel_unreachable','open-lark 没有响应');
// The chat as the control plane displays and stores it: direct is p2p; both ordinary groups and topic groups are group.
const ownerChat=(c:Conversation)=>({chatId:c.feedId,chatName:c.name,chatType:(c.chatMode==='direct'?'p2p':'group') as 'p2p'|'group'});
// Validate and convert a send before /me is read, so a malformed call cannot result in any request to open-lark.
function outgoing(p:Outgoing){
 const clientId=string(p.clientId,'clientId'),text=string(p.text,'text');
 if(!text.trim())throw invalid('text 不能为空');if(text.trim().length>100000)throw invalid('text 不能超过 100000 字');
 if(!Array.isArray(p.mentions)||p.mentions.length>100)throw invalid('mentions 必须是最多 100 项的数组');
 const mentions=p.mentions.map(m=>{
  if(!m||typeof m!=='object')throw invalid('mentions 的每一项都必须是 {id,name}');
  const id=string((m as {id?:unknown}).id,'mention.id'),name=string((m as {name?:unknown}).name,'mention.name');
  if(id.trim().length>128)throw invalid('mention.id 不能超过 128 字');if(!name.trim()||name.trim().length>256)throw invalid('mention.name');
  if(!text.includes('@'+name))throw invalid(`正文里没有 @${name}`);return {userId:id,name};
 });
 return {clientId,text,mentions};
}
// One agent API request. GET has no body; a POST body, including an empty link request, is JSON. The abort covers headers and the JSON body.
async function request<T>(config:OpenLark,method:'GET'|'POST',path:string,body:object|undefined,timeoutMs=12000):Promise<T>{
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw invalid('timeoutMs');
 const signal=AbortSignal.timeout(timeoutMs);let r:Response;
 try{
  r=await fetch(`${config.url}/agent/v1${path}`,{method,headers:{authorization:`Bearer ${config.token}`,...body!==undefined&&{'content-type':'application/json'}},...body!==undefined&&{body:JSON.stringify(body)},signal});
 }catch{throw unreachable();}
 let data:any;
 try{data=await r.json();}catch{
  if(signal.aborted)throw unreachable();
  throw coded('channel_refused',r.ok?'open-lark 返回了无法解析的响应':`open-lark 返回 HTTP ${r.status}`);
 }
 if(!r.ok){
  const e=data?.error,message=e&&typeof e.code==='string'&&typeof e.message==='string'?`${e.code}：${e.message}`:`open-lark 返回 HTTP ${r.status}`;
  throw coded('channel_refused',message);
 }
 return data as T;
}
// The methods of the owner's channel with open-lark at config, or, without one, methods that all reject with code channel_unconfigured.
export function openLarkMethods(config:OpenLark|undefined):OwnerMethods{
 if(!config){
  const missing=async()=>{throw coded('channel_unconfigured','这台机器的 Bridge 客户端没有配置 open-lark');};
  return {openLarkMessage:missing,openLarkChat:missing,openLarkReply:missing,openLarkSend:missing};
 }
 // Cache only a successful current-account lookup per client. A failed lookup is retried; a later account switch is stopped by expectedSenderId.
 let account:Promise<Me>|undefined;
 const me=(timeoutMs?:number)=>{
  account??=request<Me>(config,'GET','/me',undefined,timeoutMs).catch(e=>{account=undefined;throw e;});return account;
 };
 // Send or directly quote-reply as the account just read. Use its acknowledged timestamp when supplied, otherwise the response-arrival time.
 const deliver=async(path:string,p:Outgoing,timeoutMs:number|undefined,reply:boolean)=>{
  const {text,mentions,clientId}=outgoing(p),owner=await me(timeoutMs);
  const result=await request<SendAnswer>(config,'POST',path,{text,mentions,clientId,expectedSenderId:owner.userId,...reply&&{replyMode:'direct'}},timeoutMs);
  const stamp=result.createdAt??result.sentAt;return {messageId:result.messageId,at:stamp?Date.parse(stamp):Date.now(),owner:owner.displayName};
 };
 return {
  async openLarkMessage({messageId,timeoutMs}){
   const id=encodeURIComponent(string(messageId,'messageId')),item=await request<{item:Item}>(config,'GET',`/messages/${id}`,undefined,timeoutMs).then(r=>r.item);
   const chat=ownerChat(await request<Conversation>(config,'GET',`/conversations/${encodeURIComponent(item.feedId)}`,undefined,timeoutMs));
   // A permalink is useful but incidental: neither a refusal nor an unreachable link endpoint may hide a message already read.
   const link=await request<{url:string}>(config,'POST',`/messages/${id}/link`,{},timeoutMs).then(r=>r.url).catch(()=>undefined);
   const text=item.parts.map(p=>p.kind==='image'?'[图片]':p.kind==='file'?`[文件] ${p.text??''}`:p.text??'').join('')||item.textPreview||'';
   return {...chat,messageId:item.id,sender:{id:item.senderId,name:item.senderName},at:Date.parse(item.createdAt),text,...link?{link}:{}};
  },
  async openLarkChat({chatId,timeoutMs}){
   const id=encodeURIComponent(string(chatId,'chatId'));return ownerChat(await request<Conversation>(config,'GET',`/conversations/${id}`,undefined,timeoutMs));
  },
  async openLarkReply({messageId,timeoutMs,...params}){
   const id=encodeURIComponent(string(messageId,'messageId'));return deliver(`/messages/${id}/replies`,params,timeoutMs,true);
  },
  async openLarkSend({chatId,timeoutMs,...params}){
   const id=encodeURIComponent(string(chatId,'chatId'));return deliver(`/conversations/${id}/messages`,params,timeoutMs,false);
  },
 };
}
