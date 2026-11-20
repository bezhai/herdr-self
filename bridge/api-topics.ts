import {enqueue,publicText,oneOf} from './core.ts';
import {normalizeBinding,addBinding,chatLabel,promptLimit} from './platform.ts';
import {notice} from './message-cards.ts';
import {clip} from './request-cards.ts';
import {titleOf} from './attachments.ts';
import type {Store} from './core.ts';
import type {App,Topic} from './state.ts';
import type {Topics} from './topics.ts';
import type {Platforms} from './platform.ts';
// Topics that a trusted caller opens in a chat through POST /api/topics/open, such as butler starting the work of a group that the
// owner joined. The bot posts the root message 开工：<title> into the chat and the topic opens under it with the prompt as its first
// message (see Topics.begin), as the run of a schedule does. A chat without a binding gets one first, with the project and the agent
// configuration that the caller chose and the chat's name, like one made from the binding card; a bound chat keeps its own. Bridge
// decides nothing here: what to start and where is the caller's, who holds more context than Bridge has.
// The codes of a refusal, which the caller reacts to, with the HTTP status of each. Only bot_cannot_post may pass by itself: the bot is
// not in the chat yet, or its app is not connected, so the caller may send the same request again a little later.
const statuses={invalid_request:400,unknown_project:404,unknown_agent_config:404,bot_cannot_post:409};
type Refusal=keyof typeof statuses;
const refusals=Object.keys(statuses) as Refusal[];
// An error that refuses a request with code, as answer reads it; the bindings' own checks refuse with the same codes (see defaults in
// platform.ts).
const refused=(code:Refusal,message:string)=>Object.assign(Error(message),{code});
const invalid=(message:string)=>refused('invalid_request',message);
// The longest key and title; a longer title is cut, since it only names the topic.
const keyLimit=200,titleLimit=60;
// The first line of what failed, for a log line and the refusal.
const brief=(e:Error)=>publicText(e.message).split('\n')[0].slice(0,200);
// v, a field of the request that is a text when given: undefined when it is absent or null.
function optional(name:string,v:unknown){if(v==null)return undefined;if(typeof v!=='string')throw invalid(name+' 应为文字');return v;}
// A request once checked: the chat, the prompt trimmed, the title of the topic, and the key, project and agent configuration when given.
type Checked={chatId:string,prompt:string,title:string,key?:string,projectId?:string,agentConfigId?:string};
// What the caller gets for topic t: the topic, its binding, the root message, and whether this request opened it.
export type Opened={topicId:string,bindingId:string,rootMessageId:string,created:boolean};
const opened=(t:Topic,created:boolean):Opened=>({topicId:t.id,bindingId:t.bindingId,rootMessageId:t.rootId,created});
type Deps={topics:Pick<Topics,'begin'>,send:Platforms['send'],chatName:Platforms['chatName']};
export class ApiTopics{
 declare store:Store;declare topics:Deps['topics'];declare send:Deps['send'];declare chatName:Deps['chatName'];declare queues:Map<string,Promise<unknown>>;
 // topics are the topics of the bindings (see topics.ts); send(app,chatId,{card}) posts a message of the bot into a chat outside any
 // thread and resolves to its id; chatName(app,chatId) resolves to the name of a group in Feishu.
 constructor(store:Store,{topics,send,chatName}:Deps){this.store=store;this.topics=topics;this.send=send;this.chatName=chatName;this.queues=new Map();}
 // The answer of POST /api/topics/open: 200 with what open resolves to, or the status of a refusal with {error, code}. Any other failure
 // rejects, for the server to answer like every other.
 async answer(request:Record<string,unknown>){
  try{return {status:200,body:await this.open(request)};}
  catch(e){const code:unknown=e.code;if(!oneOf(refusals,code))throw e;return {status:statuses[code],body:{error:publicText(e.message).slice(0,1200),code}};}
 }
 // Opens a topic in chat chatId of an app with prompt as its first message (see the README for the fields of request). Resolves to
 // {topicId, bindingId, rootMessageId, created}, without waiting for the agent, whose start the topic reports in its thread. A request
 // with the key of an earlier one that opened a topic resolves to the result of that one, with created false, and opens nothing. Rejects
 // with the code invalid_request, unknown_project, unknown_agent_config or bot_cannot_post (see statuses); a request that is refused
 // leaves nothing behind.
 async open(request:Record<string,unknown>):Promise<Opened>{
  const r=this.check(request),a=this.appOf(request.appId);
  // One request after the other: one with the key of a request still under way, or for a chat that one is binding, finds what that one made.
  return enqueue(this.queues,'open',()=>this.start(a,r));
 }
 // The fields of request, checked before anything goes to Feishu: chatId is an open chat id, prompt a text of at most promptLimit characters,
 // and title, key, projectId and agentConfigId are texts when given. A title is cut to 60 characters, and without one the topic is named
 // like one that a message opens (see titleOf). Throws with the code invalid_request.
 check(request:Record<string,unknown>):Checked{
  const {chatId,prompt}=request;
  if(typeof chatId!=='string'||!/^oc_[a-zA-Z0-9]+$/.test(chatId))throw invalid('chatId 应为聊天的 open chat id（oc_…）');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.trim().length>promptLimit)throw invalid(`prompt 为空或超过 ${promptLimit} 个字符`);
  const title=optional('title',request.title)?.replace(/\s+/g,' ').trim(),key=optional('key',request.key);
  if(key!=null&&(!key||key.length>keyLimit))throw invalid(`key 应为 1 到 ${keyLimit} 个字符`);
  const projectId=optional('projectId',request.projectId),agentConfigId=optional('agentConfigId',request.agentConfigId);
  return {chatId,prompt:prompt.trim(),title:title?clip(title,titleLimit):titleOf({content:prompt}),key,projectId,agentConfigId};
 }
 // The app that the request names by Bridge's id of the app or by its App ID, or without a name the only app there is.
 appOf(appId:unknown){
  const {apps}=this.store.data,id=optional('appId',appId);
  if(id==null){if(apps.length===1)return apps[0];throw invalid(apps.length?'Bridge 有多个应用，需要用 appId 指明':'Bridge 还没有应用');}
  const a=apps.find(x=>x.id===id||x.appId===id);if(!a)throw invalid('应用不存在：'+id);
  return a;
 }
 // In the queue: the request that r checked, of app a. The binding that a chat without one gets is checked before the root message is posted
 // and stored after it, so that a request that the bot cannot post leaves nothing; a chat that got a binding meanwhile keeps that one.
 async start(a:App,r:Checked):Promise<Opened>{
  const repeated=r.key!=null&&this.store.data.topics.find(t=>t.openKey===r.key);
  if(repeated)return opened(repeated,false);
  const chat={appId:a.id,chatId:r.chatId,chatType:'group'} as const,fields=(name:string)=>({name,defaultProjectId:r.projectId,defaultAgentConfigId:r.agentConfigId});
  const bound=()=>this.store.data.bindings.find(x=>x.appId===a.id&&x.chatId===r.chatId);
  let b=bound();
  if(!b){
   if(!r.projectId||!r.agentConfigId)throw invalid('这个聊天还没有会话绑定，需要 projectId 和 agentConfigId');
   normalizeBinding(fields(chatLabel('group')),chat,this.store.data);
  }
  let root:string;
  try{root=await this.send(a,r.chatId,{card:notice('开工：'+r.title)});}
  catch(e){
   this.store.log('开话题',`${a.name}：未能在聊天 ${r.chatId} 里发出话题的根消息，${brief(e)}`,'error');
   throw refused('bot_cannot_post','机器人未能在这个聊天里发消息：'+brief(e));
  }
  if(!b){const name=await this.name(a,r.chatId);b=bound()??addBinding(this.store,fields(name),chat);}
  const {topic}=this.topics.begin(a,b,root,{title:r.title,msg:{messageId:root,content:r.prompt},fields:{...r.key!=null&&{openKey:r.key}}});
  this.store.log('开话题',`${b.name}：经接口开了话题「${r.title}」`);
  return opened(topic,true);
 }
 // The name that a binding of group chatId gets: its name in Feishu, which the bot reads now that it can post there, else 群聊 with a log
 // line, as for a binding made from the card.
 async name(a:App,chatId:string){
  try{return chatLabel('group',await this.chatName(a,chatId));}
  catch(e){this.store.log('会话绑定',`${a.name}：未能读取群名称，${e.message}`,'error');return chatLabel('group');}
 }
}
