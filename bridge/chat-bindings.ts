import {publicText} from './core.ts';
import {addBinding,chatLabel} from './platform.ts';
import {notice,untitled} from './message-cards.ts';
import {plain,option,select,submitForm} from './request-cards.ts';
import type {NormalizedMessage,CardActionResponse} from '@larksuite/channel';
import type {Store,Operations} from './core.ts';
import type {Platforms} from './platform.ts';
import type {App,Binding,AgentConfig,Project,State} from './state.ts';
import type {Click} from './request-cards.ts';
// A chat that writes to an app before it has a binding gets a card in the chat to make one, where Bridge cannot know the project and the
// agent configuration the person wants but can guess them: the project of a group by the cheap model from the group's name, the
// configuration as the one the latest binding used. Both are dropdowns, so a wrong guess costs one click, and 绑定 creates the binding and
// starts the message that asked for it as the first task. Only people on the app's allowlist write here or click (see Platforms.receive and
// Platforms.cardAction). What a card waits for is in memory: a restart forgets it, and the next message gets a new card.
const lifetime=30*60000,guessMs=20000;
const heading='这个聊天还没有绑定 Bridge。';
const toast=(type:string,content:string)=>({toast:{type,content}});
const oneLine=(s:string)=>s.replace(/\s+/g,' ').trim();
// The cheap model's prompt for the project of the group called group, among projects.
export const choosingPrompt=(group:string,projects:Pick<Project,'name'|'description'>[])=>`You match a chat group to the project it works on, from the group's name.

Projects, one per line as "name: description":
${projects.map(p=>`${oneLine(p.name)}: ${oneLine(p.description)||'-'}`).join('\n')}

Output EXACTLY one line: the name of the project the group belongs to, or NONE when no project clearly fits.
NO explanation, NO markdown.

Group name:
${oneLine(group)}`;
// The project that the first line of an answer names, with the quotes or the final period the model may add; none for any other answer.
const projectOf=(answer:string,projects:Project[])=>{const name=answer.trim().split('\n')[0].trim().replace(/^["'`]+|["'`.。]+$/g,'');return projects.find(p=>p.name===name);};
// The card: no title, like Bridge's other status cards, a dropdown per default with the guessed option chosen, and 绑定. A direct chat has no
// project. Every drawing needs its own render number (see pending in request-cards.ts): the channel drops a click that repeats the card,
// person and button value of an earlier one.
const bindCard=(data:Pick<State,'projects'|'agentConfigs'>,group:boolean,render:number,chosen:{project?:Project,config?:AgentConfig})=>untitled(heading,[plain(heading),submitForm('bind',[
 ...group?[select('project','项目',data.projects.map(p=>option(p.name,p.id)),chosen.project?.id)]:[],
 select('config','Agent 配置',data.agentConfigs.map(c=>option(c.name,c.id)),chosen.config?.id)],'绑定',{bind:true,render})]);
// A chat with a card: the app and the message that asked, the name its binding gets, the id of the card once it is sent, and the words of the
// reply once the card made the binding; lacking says it got the notice of what must exist first instead of a card.
type Waiting={app:string,msg:NormalizedMessage,name:string,expires:number,card?:string,bound?:string,lacking?:boolean};
type Deps=Pick<Platforms,'reply'|'updateCard'|'chatName'>&Pick<Operations,'askCheapModel'>&{handle:(a:App,b:Binding,msg:NormalizedMessage)=>unknown,now?:()=>number};
export class ChatBindings{
 declare store:Store;declare reply:Deps['reply'];declare updateCard:Deps['updateCard'];declare chatName:Deps['chatName'];declare askCheapModel:Deps['askCheapModel'];
 declare handle:Deps['handle'];declare now:()=>number;declare waiting:Map<string,Waiting>;declare renders:number;
 // reply(app,chatId,rootId,{card}) answers in the thread of a message with a card and resolves to the id of the card; updateCard(app,messageId,card)
 // replaces it; chatName(app,chatId) resolves to the name of a group in Feishu; askCheapModel(machine,cwd,prompt,{timeoutMs}) asks the cheap
 // model (see operations in core.ts); handle(app,binding,msg) takes a message of a bound chat, as Topics.handle does.
 constructor(store:Store,{reply,updateCard,chatName,askCheapModel,handle,now=Date.now}:Deps){
  this.store=store;this.reply=reply;this.updateCard=updateCard;this.chatName=chatName;this.askCheapModel=askCheapModel;this.handle=handle;this.now=now;this.waiting=new Map();this.renders=0;
 }
 // The projects and agent configurations that must exist before a chat (of a group or not) can be bound, by their names in the notice.
 missing(group:boolean){
  const {projects,agentConfigs}=this.store.data;
  return [...group&&!projects.length?['项目']:[],...agentConfigs.length?[]:['Agent 配置']];
 }
 // A message from a chat without a binding: it gets the card, or says what must exist first. Only the first message within the lifetime of
 // a card is answered, also while the card is being made; a chat told what is missing gets its card with the first message after that
 // exists, and a notice or card that could not be sent is tried again by the next message. Never rejects.
 async open(a:App,msg:NormalizedMessage){
  const now=this.now();for(const [key,w] of this.waiting)if(w.expires<=now)this.waiting.delete(key);
  const key=JSON.stringify([a.id,msg.chatId]),group=msg.chatType==='group';
  // A chat that was bound and lost its binding again is unbound like any other.
  const waiting=this.waiting.get(key);if(waiting&&!waiting.bound&&!(waiting.lacking&&!this.missing(group).length))return;
  const w:Waiting={app:a.id,msg,name:chatLabel(msg.chatType),expires:now+lifetime},{agentConfigs}=this.store.data;
  this.waiting.set(key,w);this.store.log('会话绑定',`${a.name}：${group?'群聊':'私聊'} ${msg.chatId} 尚未绑定`);
  try{
   const missing=this.missing(group);
   if(missing.length){await this.reply(a,msg.chatId,msg.messageId,{card:notice(`请先在 Bridge 管理台创建${missing.map(x=>`「${x}」`).join('和')}，再绑定这个聊天。`)});w.lacking=true;return;}
   const config=agentConfigs.find(c=>c.id===this.store.data.lastAgentConfigId)??agentConfigs[0];
   const project=group?await this.guess(a,w,config):undefined;
   w.card=await this.reply(a,msg.chatId,msg.messageId,{card:bindCard(this.store.data,group,++this.renders,{project,config})});
  }catch(e){this.waiting.delete(key);this.store.log('会话绑定',`${a.name}：绑定卡片未发出，${e.message}`,'error');}
 }
 // The project of the group of w by the cheap model, on the machine of config, from the group's name in Feishu; none when there is nothing
 // to go by, nothing fits or the model cannot answer, which only costs the person a click. The only project there is needs no guess.
 async guess(a:App,w:Waiting,config:AgentConfig){
  const {projects,machines}=this.store.data;
  let known=false;
  try{const name=await this.chatName(a,w.msg.chatId);if(name){w.name=chatLabel('group',name);known=true;}}
  catch(e){this.store.log('会话绑定',`${a.name}：未能读取群名称，${e.message}`,'error');}
  if(projects.length===1)return projects[0];
  const machine=machines.find(m=>m.id===config.machineId);if(!known||!machine?.enabled)return;
  try{
   const r=await this.askCheapModel(machine,'~/',choosingPrompt(w.name,projects),{timeoutMs:guessMs});
   if(r.code!==0)throw Error(`claude 退出码 ${r.code}：${r.stderr.trim().slice(-300)}`);
   return projectOf(r.stdout,projects);
  }catch(e){this.store.log('会话绑定',`${a.name}：未能猜出群的项目，${e.message}`,'error');}
 }
 // A click on 绑定 by someone on the app's allowlist. It answers at once: a binding is made here and then the rest follows (see finish).
 // Without a project (group) or a configuration the card is drawn again with the choices kept, so that the next click is not dropped as a
 // repeat of this one.
 click(a:App,evt:Click):CardActionResponse{
  const w=[...this.waiting.values()].find(x=>x.card===evt.messageId&&x.app===a.id);
  if(!w||w.expires<=this.now())return toast('info','这张卡片已失效，请重新发一条消息');
  if(w.bound)return toast('info',w.bound);
  const {msg}=w,group=msg.chatType==='group',{projects,agentConfigs}=this.store.data,form=evt.action.formValue;
  const project=group?projects.find(p=>p.id===form?.project):undefined,config=agentConfigs.find(c=>c.id===form?.config);
  const lacking=group&&!project?'请选择项目':!config?'请选择 Agent 配置':'';
  if(lacking){this.redraw(a,evt.messageId,group,{project,config});return toast('warning',lacking);}
  let binding:Binding;
  try{binding=addBinding(this.store,{name:w.name,defaultProjectId:project?.id,defaultAgentConfigId:config!.id},{appId:a.id,chatId:msg.chatId,chatType:msg.chatType});}
  catch(e){return toast('error',publicText(e.message).slice(0,200));}
  w.bound=`已绑定：${project?`项目 ${project.name}，`:''}Agent 配置 ${config!.name}。`;
  this.finish(a,w,binding,evt.messageId);return {};
 }
 // The card of the binding w made says so, and then the message that asked for it starts as the first task, through the entry of a bound
 // chat. When the card cannot be updated the words go into the thread of the message. Never rejects.
 async finish(a:App,w:Waiting,binding:Binding,cardId:string){
  try{await this.updateCard(a,cardId,notice(w.bound!));}
  catch{
   try{await this.reply(a,w.msg.chatId,w.msg.messageId,{card:notice(w.bound!)});}
   catch(e){this.store.log('会话绑定',`${a.name}：绑定结果未发出，${e.message}`,'error');}
  }
  try{await this.handle(a,binding,w.msg);}catch(e){this.store.log('会话绑定',`${a.name}：第一个任务未能开始，${e.message}`,'error');}
 }
 // Draws the card cardId again with the choices of a click that lacked one. Never rejects.
 async redraw(a:App,cardId:string,group:boolean,chosen:{project?:Project,config?:AgentConfig}){
  try{await this.updateCard(a,cardId,bindCard(this.store.data,group,++this.renders,chosen));}
  catch(e){this.store.log('会话绑定',`${a.name}：绑定卡片未能更新，${e.message}`,'error');}
 }
}
