import {uuid,publicText,enqueue} from './core.ts';
import {title,check,answered,pending,answerOf,answerArgs,settled,expired,failed} from './request-cards.ts';
import {picker,adoptedPicker,intro,nameOf,stillChosen,chosen} from './adoption.ts';
import {notice,replyCards} from './message-cards.ts';
import {supported} from './platform.ts';
import {permissionMode} from './agent-configs.ts';
import {attachmentsOf,promptOf,fileName,titleOf,limits,label,reason} from './attachments.ts';
import {slash} from './commands.ts';
import {createCot,updateCot,completeCot,runStarted,runFinished,runError,status,steps} from './cot.ts';
import {attachmentFolder} from './machine.ts';
import {nameTask} from './routing.ts';
import {startCard} from './topic-cards.ts';
import {workspaceOf,hasBranch,sweepable,unused,freeBranch} from './workspaces.ts';
import {randomBranch} from './worktree-branch.mjs';
import type {NormalizedMessage,ResourceDescriptor} from '@larksuite/channel';
import type {Store,Agent,Snapshot,Herdr,Operations} from './core.ts';
import type {App,Binding,Machine,Topic,Reaction,RequestCard,Kind,Project,AgentConfig} from './state.ts';
import type {Platforms} from './platform.ts';
import type {Click,HerdrRequest,Answer} from './request-cards.ts';
import type {Choice,Offered,Group} from './adoption.ts';
import type {Reply} from './message-cards.ts';
import type {Event} from './cot.ts';
import type {Named} from './routing.ts';
// One Feishu topic = one Herdr agent session: one that the topic starts in its own tab of the binding's workspace, or one that already
// runs in any pane of any machine and that the topic adopted (/adopt). Everything goes through the Herdr CLI, besides what the project's
// workspace, the launch of an agent, attachments and Bridge's skills need on the machine; all of it through the client of the machine
// (see operations in core.ts).
const workspaceLabel=(b:Binding)=>'飞书 · '+b.name;
// How long preparing a workspace (a clone and a fetch) and a launch may take.
const workspaceTimeoutMs=600000,launchTimeoutMs=60000,shellWaitMs=10000,shellPollMs=250;
const brief=(e:Error)=>publicText(e.message).split('\n')[0].slice(0,200);
// What a topic says when the client of its machine is offline (see Clients.call): the error names the machine, and after says what that
// meant for the message.
const offline=(e:Error,after:string)=>`${brief(e)}。${after}`;
// While Herdr's remote answers setting is on for the agent of a pane, the permission and question hooks of Claude and Codex wait for an
// answer from Feishu (see cards); Antigravity has no such hooks, its approvals and questions get the blocked notice (see blocked). Bridge
// turns the setting on before a topic is ready and off when it lets go of an agent that keeps running. Herdr clears it when the agent
// exits, is released or changes to another agent, so a ready topic is linked to the agent of its pane for as long as the agent reports it.
const linked=(t:Topic,agents:Agent[])=>agents.find(x=>x.pane_id===t.paneId&&x.remote_answers===true);
const remoteAnswers=(pane:string,on:boolean)=>['pane','remote-answers',pane,on?'on':'off'];
const endedNotice='该话题的会话已结束，请发起新话题',continuable='该话题的会话已结束，在话题里回复即可接着做',adoptedGone='被接管的 Agent 已退出、已更换或所在 pane 已关闭，话题已结束接管',unchosen='请选择要接管的 Agent';
const unsupportedNotice='暂不支持这类消息，目前只能转发文字、图片和文件';
// Where the images and files of a topic go, under the working directory of its agent (see attach).
const attachmentRoot=(cwd:string)=>cwd.replace(/\/+$/,'')+'/'+attachmentFolder;
// Marks a message from the moment a topic accepts it until the agent's turn for it ends, unless a COT takes its place (see openCot).
const reaction='OneSecond';
// Whether the turn that a prompt with state_change_seq seq started has ended: the agent is idle or done and has changed state since.
const turnEnded=(seq:number|null|undefined,agent:Agent)=>['idle','done'].includes(agent?.agent_status)&&seq!=null&&agent.state_change_seq>seq;
// Reactions of prompted messages whose turn has ended.
const ended=(t:Topic,agent:Agent)=>(t.reactions||[]).filter(r=>turnEnded(r.stateSeq,agent));
// Ids of the requests an agent of the list waits on (missing in Herdr versions without requests).
const requestIds=(agent:Agent|undefined)=>agent?.request_ids||[];
// Whether agent waits for a confirmation: on a request card, or blocked on something that gets the blocked notice (see blocked).
const waits=(agent:Agent)=>agent.agent_status==='blocked'||requestIds(agent).length>0;
// Whether the open COT of topic t has news in agent of a list: tool calls after the seq it shows (tool_call_seq is missing in Herdr versions
// without tool call records), a change between running and waiting for a confirmation, or the end of its turn.
const news=(t:Topic,agent:Agent)=>!!t.cot&&(agent.tool_call_seq!=null&&agent.tool_call_seq!==(t.cot.toolSeq||0)||waits(agent)!==Boolean(t.cot.waiting)||turnEnded(t.cot.stateSeq,agent));
// The AG-UI run of the open COT of topic t.
const run=(t:Topic)=>({threadId:t.rootId,runId:t.cot!.origin});
const toast=(type:string,content:string)=>({toast:{type,content}});
// A message that the agent of a topic gets: a person's (see Platforms.receive) or the task of a schedule's run (see schedules.ts).
export type Message=Pick<NormalizedMessage,'messageId'|'content'>&{resources?:ResourceDescriptor[]};
// A message of a person in a bound chat, as Topics reads it; a missing mention or root counts as none.
export type Inbound=Message&Pick<NormalizedMessage,'rawContentType'>&Partial<Pick<NormalizedMessage,'rootId'|'mentionedBot'>>;
type Deps=Pick<Operations,'storeFile'|'removeDirectory'|'askCheapModel'|'prepareWorkspace'|'removeWorkspace'|'prepareLaunch'>&Pick<Platforms,'reply'|'updateCard'|'react'|'unreact'|'request'|'download'>&{
 herdr:Herdr,placeSkills:(m:Machine,cwd:string,kind:Kind,skills:string[])=>Promise<string[]>,machine:(id:string)=>Machine,app:(id:string)=>App,now?:()=>number,pause?:(ms:number)=>Promise<void>};
export class Topics{
 declare store:Store;declare herdr:Herdr;declare machine:Deps['machine'];declare app:Deps['app'];declare reply:Deps['reply'];
 declare updateCard:Deps['updateCard'];declare react:Deps['react'];declare unreact:Deps['unreact'];declare request:Deps['request'];declare download:Deps['download'];
 declare storeFile:Deps['storeFile'];declare removeDirectory:Deps['removeDirectory'];declare askCheapModel:Deps['askCheapModel'];declare prepareWorkspace:Deps['prepareWorkspace'];declare removeWorkspace:Deps['removeWorkspace'];declare prepareLaunch:Deps['prepareLaunch'];
 declare placeSkills:Deps['placeSkills'];declare now:()=>number;declare pause:(ms:number)=>Promise<void>;declare topicQueues:Map<string,Promise<unknown>>;declare workspaceQueues:Map<string,Promise<unknown>>;
 declare answering:Map<string,Promise<unknown>>;declare blockedSeen:Map<string,number>;declare renders:number;declare drawings:number;declare claims:Set<string>;
 // On machine m, through its client (see operations in core.ts): herdr(m,args,{timeoutMs}) runs a Herdr CLI command; storeFile(m,root,dir,name,body)
 // writes a file and resolves to its absolute path, and removeDirectory(m,dir) removes such a directory; askCheapModel(m,cwd,prompt,{timeoutMs})
 // asks the cheap model (see routing.ts); prepareWorkspace, removeWorkspace and prepareLaunch take the params of their ClientApi entry (see
 // link.ts). Each rejects with the code client_offline while the client of m is offline. placeSkills(m,cwd,kind,skills)
 // places the skills loaded by default and those of a project, named in skills, where an agent of binding kind kind reads them in directory cwd on machine m, takes away those
 // that Bridge placed there before and that are no longer wanted, and resolves to the paths of same-name skills of others (see Skills.place). machine(id) and app(id) return a machine or an app, or throw; reply(app,chatId,rootId,{card})
 // answers in the topic thread with a card and resolves to the message id; updateCard(app,messageId,card) replaces a card sent that way;
 // react(app,messageId,emojiType) resolves to a reaction id for unreact(app,messageId,reactionId); request(app,options) calls a Feishu OpenAPI
 // that the SDK lacks, such as the COT calls, and resolves to its data. download(app,messageId,resource,limit) resolves to {body, type} of
 // a resource of a received message, or rejects with code too_large past limit bytes. now() is the clock.
 constructor(store:Store,{herdr,storeFile,removeDirectory,askCheapModel,prepareWorkspace,removeWorkspace,prepareLaunch,placeSkills,machine,app,reply,updateCard,react,unreact,request,download,now=Date.now,pause=ms=>new Promise<void>(resolve=>setTimeout(resolve,ms))}:Deps){
  this.store=store;this.herdr=herdr;this.machine=machine;this.app=app;this.reply=reply;this.updateCard=updateCard;this.react=react;this.unreact=unreact;this.request=request;
  this.download=download;this.storeFile=storeFile;this.removeDirectory=removeDirectory;this.askCheapModel=askCheapModel;this.prepareWorkspace=prepareWorkspace;this.removeWorkspace=removeWorkspace;this.prepareLaunch=prepareLaunch;this.placeSkills=placeSkills;this.now=now;this.pause=pause;this.topicQueues=new Map();this.workspaceQueues=new Map();
  // In memory: the clicks being handled as '<topic id> <request id>' or '<topic id> adopt' → the promise of their handling; per topic the
  // state_change_seq of a blocked agent without requests in the latest list; a counter that numbers card drawings and one for those of the first cards of topics; and the panes being
  // adopted as '<machine id> <pane id>' (see held).
  this.answering=new Map();this.blockedSeen=new Map();this.renders=0;this.drawings=0;this.claims=new Set();
  // A start interrupted by a restart cannot be resumed; the next message in the topic retries it.
  const interrupted=store.data.topics.filter(t=>t.state==='starting');
  // It ended now, so that the sweep removes the workspace it may have prepared (see sweepable).
  for(const t of interrupted)Object.assign(t,{state:'failed',error:'Bridge 重启时 Agent 启动未完成',endedAt:this.now()});
  if(interrupted.length)store.save();
 }
 // A routed message. Never rejects: failures end up as topic states, notices in the thread or error logs.
 async handle(a:App,b:Binding,msg:Inbound){
  // A binding that requires the mention drops every message without it, in a topic thread and its commands too, as if it never came.
  if(b.requireMention&&!msg.mentionedBot)return;
  if(!supported(msg))return this.unsupported(a,b,msg);
  const rootId=msg.rootId||msg.messageId,t=this.store.data.topics.find(x=>x.bindingId===b.id&&x.rootId===rootId);
  if(!msg.messageId||t?.messageIds.includes(msg.messageId))return;
  const text=msg.content.trim();
  if(!t){
   // A root message has no root id; in a thread the command is a message to the agent like any other.
   if(!msg.rootId&&text===slash.adopt)return this.offer(a,b,msg);
   if(!msg.rootId&&text===slash.stop)return this.stopChat(a,b,msg);
   return this.begin(a,b,rootId,{title:titleOf(msg),msg,reaction:msg.messageId}).delivered;
  }
  // At most once: the id is on disk before Herdr is called, and a message seen before is dropped. A topic that a schedule opened keeps the
  // time of the latest message of a person, who may still be talking to its agent (see schedules.ts).
  t.messageIds=[...t.messageIds,msg.messageId].slice(-50);if(t.scheduled)t.scheduled.messageAt=this.now();this.store.save();
  if(t.adopted&&t.state==='ready'&&text===slash.release)return enqueue(this.topicQueues,t.id,()=>this.release(a,b,t)).catch(e=>this.store.log('话题接管',`${b.name}：${brief(e)}`,'error'));
  if(t.state==='ready'&&text===slash.stop)return enqueue(this.topicQueues,t.id,()=>this.stop(a,t));
  // The commands mean nothing to a topic whose agent is gone, which any other message starts again (see continuable).
  if(t.state==='closed'&&[slash.stop,slash.release].includes(text))return;
  return this.deliver(a,b,t,msg,{reaction:msg.messageId});
 }
 // Opens a topic of binding b whose root is message rootId and gives its agent message msg (see deliver): the one way into a new topic, for
 // a person's message and for a schedule's run alike (see schedules.ts). The record is on disk before the first await, so messages arriving
 // meanwhile join this topic instead of opening another tab; it holds the id of msg, which is not handled again, and fields, such as the
 // schedule run that opened it. Returns {topic, delivered}: the record, and what deliver resolves to.
 begin(a:App,b:Binding,rootId:string,{title,msg,reaction,fields}:{title:string,msg:Message,reaction?:string,fields?:Pick<Topic,'scheduled'>}){
  const id=uuid(),config=this.store.data.agentConfigs.find(c=>c.id===b.defaultAgentConfigId);
  const t:Topic={id,bindingId:b.id,appId:a.id,chatId:b.chatId,rootId,machineId:config?.machineId??'',...b.defaultProjectId&&{projectId:b.defaultProjectId},agentConfigId:b.defaultAgentConfigId,workspaceId:'',tabId:'',paneId:'',agentName:'feishu-'+id.slice(0,8),
   title,state:'starting',error:'',messageIds:[msg.messageId],replySeq:0,reactions:[],cards:[],task:{messageId:msg.messageId,content:msg.content,...msg.resources&&{resources:msg.resources}},...fields,createdAt:this.now()};
  this.store.data.topics.push(t);this.store.save();
  return {topic:t,delivered:this.deliver(a,b,t,msg,{reaction})};
 }
 // Gives message msg ({messageId, content, resources?}) to the agent of topic t in the topic's queue (see prompt). reaction is the id of the
 // message of a person that marks it, added right away: not behind the queue, where an earlier message may be starting the agent for a
 // minute. A message that did not reach the agent since the client of its machine is offline gets a notice that says so. Resolves to the
 // prompted agent, or to nothing. Never rejects.
 deliver(a:App,b:Binding,t:Topic,msg:Message,{reaction}:{reaction?:string}={}){
  const reacted=reaction&&this.addReaction(a,t,reaction);
  return enqueue(this.topicQueues,t.id,()=>this.promptOrNotify(a,b,t,msg,reacted));
 }
 // prompt for a message that deliver or restart gives, in the queue of topic t: a failure is logged, and a client that is offline gets a
 // notice that says so. Resolves to the prompted agent, or to nothing. Never rejects.
 async promptOrNotify(a:App,b:Binding,t:Topic,msg:Message,reacted?:Promise<Reaction|null>|''){
  try{return await this.prompt(a,b,t,msg,{reacted});}
  catch(e){
   this.store.log('消息投递',`${a.name} → ${b.name}：${brief(e)}`,'error');
   if(e.code==='client_offline')await this.notify(a,t,offline(e,'这条消息没有发给 Agent，请稍后重发'));
  }
 }
 // Runs task in the queue of topic t, after what is queued there, and resolves or rejects like it.
 queue<T>(t:Topic,task:()=>T|Promise<T>){return enqueue(this.topicQueues,t.id,task);}
 // In the queue of topic t: sends message msg to its agent (see forward), opening the topic first when it is new or failed, and opens the
 // COT of the turn under msg. A message with reacted, the promise of its reaction record (see addReaction), keeps its reaction until its turn
 // ends (see sync) or its COT takes its place, when it was prompted; any other message loses it now. Resolves to the prompted agent, or to
 // nothing; rejects when Herdr fails.
 async prompt(a:App,b:Binding,t:Topic,msg:Message,{reacted}:{reacted?:Promise<Reaction|null>|''}={}){
  let agent;
  // Settled in the queue, so a later message that closes the topic finds this record.
  try{agent=await this.forward(a,b,t,msg);}
  finally{const r=await reacted;if(agent&&r){r.stateSeq=agent.state_change_seq;this.store.save();}else await this.dropReaction(t,r);}
  if(agent)await this.openCot(a,t,msg.messageId,agent);
  return agent;
 }
 // A prompted message gets a COT in the thread, unless the topic has one open: messages prompted meanwhile keep their reactions. Its record
 // holds the COT, the message it answers, the prompt's state_change_seq that tells when the turn ends (see turnEnded), the seq of the latest
 // tool call it shows, from those after the prompt, and whether it shows the agent waiting for a confirmation. The COT takes the place of
 // the message's reaction; one that cannot be created leaves the reaction. Never rejects.
 async openCot(a:App,t:Topic,origin:string,agent:Agent){
  if(t.cot||t.state!=='ready')return;
  let cot;try{cot=await createCot(o=>this.request(a,o),t.chatId,origin);}
  catch(e){this.store.log('执行过程',`${t.agentName}：未能创建 COT，${brief(e)}`,'error');return;}
  this.update(t,{cot:{...cot,origin,stateSeq:agent.state_change_seq,toolSeq:agent.tool_call_seq??0,waiting:false}});
  const r=t.reactions?.find(x=>x.messageId===origin);if(r)await this.dropReaction(t,r);
  await this.showCot(t,t.cot!,[runStarted(run(t))]);
 }
 // Brings the open COT of topic t in line with agent of the list of machine m: once the agent runs again after waiting for a confirmation,
 // a line that says so; its new tool calls as steps; once it waits, a line that says so after the steps that led there; and once its turn
 // has ended, RUN_FINISHED and completion. Tool calls after the stored seq are fetched like replies (see pull), and one that cannot be
 // fetched is fetched again with the next list; the seq is on disk before the update, which is not repeated. Never rejects.
 async advance(m:Machine,t:Topic,agent:Agent){
  const cot=t.cot;if(t.state!=='ready'||!cot)return;
  let walked:Event[]=[];
  try{
   const seq=agent.tool_call_seq,last=cot.toolSeq||0;
   if(seq!=null&&seq!==last){
    // A seq below the stored one means Herdr restarted or handed off and counts from 1 again: take its tool calls up to seq.
    const reset=seq<last,{tool_calls}=await this.herdr(m,['agent','tool-calls',t.paneId,...reset?[]:['--after',String(last)]]),calls=tool_calls.filter(c=>!reset||c.seq<=seq);
    walked=steps(calls);cot.toolSeq=calls.at(-1)?.seq??seq;
   }
  }catch(e){this.store.log('执行过程',`${t.agentName}：未能读取工具调用，${brief(e)}`,'error');}
  const waiting=waits(agent),finished=turnEnded(cot.stateSeq,agent);
  const line=!finished&&waiting!==Boolean(cot.waiting)?status('status-'+agent.state_change_seq,waiting?'等待确认':'继续运行'):[];
  cot.waiting=waiting;this.store.save();
  const events=waiting?[...walked,...line]:[...line,...walked];
  if(finished)return this.closeCot(t,[...events,runFinished(run(t),'done')],'done');
  if(events.length)await this.showCot(t,cot,events);
 }
 // Sends events to COT cot of topic t. Never rejects: a failure is only logged.
 async showCot(t:Topic,cot:NonNullable<Topic['cot']>,events:Event[]){
  try{await updateCot(o=>this.request(this.app(t.appId),o),cot,events);}catch(e){this.store.log('执行过程',`${t.agentName}：COT 未能更新，${brief(e)}`,'error');}
 }
 // Ends the open COT of topic t with its last events and reason done or error; it is completed even when the events fail. At most once: the
 // record is dropped before Feishu is called, and failures are only logged. Never rejects.
 async closeCot(t:Topic,events:Event[],reason:'done'|'error'){
  const cot=t.cot;if(!cot)return;delete t.cot;this.store.save();
  await this.showCot(t,cot,events);
  try{await completeCot(o=>this.request(this.app(t.appId),o),cot,reason);}catch(e){this.store.log('执行过程',`${t.agentName}：COT 未能完成，${brief(e)}`,'error');}
 }
 // A message of a kind that Bridge cannot forward gets a notice in its thread, which opens no topic. Never rejects.
 async unsupported(a:App,b:Binding,msg:Inbound){
  try{await this.reply(a,b.chatId,msg.rootId||msg.messageId,{card:notice(unsupportedNotice)});}catch(e){this.store.log('话题通知',`${b.name}：${brief(e)}`,'error');}
 }
 // Sends message msg to the topic's agent, opening the topic first when it is new or failed, or when it ended and Bridge started it: a
 // reply continues the topic in its project, on its branch and with its agent configuration, and its workspace is prepared again, which
 // restores one that the sweep removed (see sweep). A topic still waiting for an agent to adopt, and an adopted one that ended, prompt nothing. The images and files of the message are written under the agent's working directory first (see attach): the topic's
 // own for a topic that Bridge opened in a tab, and for an adopted one what Herdr reports for the agent, where the agent runs before where
 // its shell is. Resolves to the prompted agent, or to nothing when the message was not prompted.
 async forward(a:App,b:Binding,t:Topic,msg:Message){
  if(t.state==='closed'&&!this.continuable(t))return;
  if(t.state==='choosing'){await this.notify(a,t,'请先在上面的卡片中选择要接管的 Agent');return;}
  let agent;
  if(t.state==='ready'){agent=await this.alive(a,t);if(!agent&&!this.continuable(t))return;}
  if(!agent&&!await this.open(a,b,t))return;
  // An adopted topic that gets here is ready, with its agent.
  const text=await this.attach(a,t,msg,t.adopted?agent!.foreground_cwd||agent!.cwd:t.cwd);
  let r;try{r=await this.herdr(this.target(t),['agent','prompt',t.paneId,text]);}
  catch(e){if(e.code!=='agent_blocked')throw e;await this.notify(a,t,'Agent 正在等待确认，请到 Herdr 中处理后重发这条消息');return this.noticed(t);}
  this.store.log('消息投递',`${a.name} → ${b.name}：已发送到 ${t.agentName}`);return r.agent;
 }
 // Resolves to the prompt of message msg in topic t: each image and file of the message is downloaded and written, before the prompt, as
 // <cwd>/.herdr-bridge/<topic id>/<file name> on the topic's machine, and the prompt names it by its absolute path (see promptOf). The topic
 // records the directory for its clean-up (see clean). One that cannot be downloaded or written is named as failed, and the topic gets one
 // notice that lists them; the details are only logged. Never rejects.
 async attach(a:App,t:Topic,msg:Message,cwd:string|undefined){
  const list=attachmentsOf(msg);
  for(const x of list){
   let stage='下载';
   try{
    const m=this.target(t);if(!cwd){stage='写入';throw Error('Agent 的工作目录未知');}
    const {body,type}=await this.download(a,msg.messageId,x,limits[x.type]);stage='写入';
    const file=await this.storeFile(m,attachmentRoot(cwd),t.id,fileName(msg.messageId,x,type),body),dir=file.slice(0,file.lastIndexOf('/'));
    if(t.attachmentDir!==dir)this.update(t,{attachmentDir:dir});x.path=file;
   }catch(e){x.reason=reason(x,stage,e);this.store.log('附件',`${t.agentName}：${label(x)} ${x.reason}，${brief(e)}`,'error');}
  }
  const failed=list.filter(x=>x.reason);
  if(failed.length)await this.notify(a,t,'未能把附件交给 Agent：'+failed.map(x=>`${label(x)} ${x.reason}`).join('，'));
  return promptOf(msg,list);
 }
 // Removes the directory of topic t's attachments on its machine. Never rejects: a failure is only logged, and the record stays for another
 // try when the binding is removed.
 async clean(t:Topic){
  const dir=t.attachmentDir;if(!dir)return;
  try{await this.removeDirectory(this.target(t),dir);if(t.attachmentDir===dir){delete t.attachmentDir;this.store.save();}}
  catch(e){this.store.log('附件',`${t.agentName}：未能删除附件目录，${brief(e)}`,'error');}
 }
 // The notice of a prompt that met a blocked agent covers the blocked episode the agent is in, so sync does not post its own for it.
 // The prompt error carries no state_change_seq; it is read from a new list.
 async noticed(t:Topic){
  try{const {agents}=await this.herdr(this.target(t),['agent','list']),agent=linked(t,agents);if(agent?.agent_status==='blocked')this.update(t,{blockedSeq:agent.state_change_seq});}
  catch(e){this.store.log('话题通知',`${t.agentName}：${brief(e)}`,'error');}
 }
 // Reads the agent list of the topic's machine and ends a ready topic whose agent is no longer linked to it. Resolves to the linked agent,
 // or to nothing when the topic ended or was no longer ready.
 async alive(a:App,t:Topic){
  if(t.state!=='ready')return;
  const {agents}=await this.herdr(this.target(t),['agent','list']),agent=linked(t,agents);
  if(!agent&&t.state==='ready')await this.end(a,t,t.adopted?adoptedGone:t.routed?continuable:endedNotice);
  return agent;
 }
 // Ends a ready topic with a notice; its open COT shows the run failed, its reactions are removed, its cards show 已失效 and the directory of
 // its attachments is removed. A reaction still being added is removed when its message settles, unprompted.
 async end(a:App,t:Topic,text:string){
  this.update(t,{state:'closed',endedAt:this.now()});
  await this.notify(a,t,text);
  await this.wrapUp(a,t,'话题已结束');
 }
 // What a topic leaves behind when its agent is gone, ended or replaced: its open COT shows the run failed with reason, its reactions are
 // removed, its request cards show 已失效 and the directory of its attachments is removed.
 async wrapUp(a:App,t:Topic,reason:string){
  if(t.cot)await this.closeCot(t,[runError(reason)],'error');
  for(const r of t.reactions||[])await this.dropReaction(t,r);
  for(const c of this.gone(t,[]))await this.dropCard(a,t,c);
  await this.clean(t);
 }
 // Ends ready topic t with text and closes the pane of its agent, which takes its tab along when it is the tab's only pane and the
 // workspace when that is its last tab. The pane is closed only while the agent is linked to the topic: once the agent is gone Herdr may
 // have given its pane id to another pane, which is not Bridge's to close, and the topic just ends (see alive). A pane that cannot be closed
 // leaves the topic as it was, for another try. In the topic's queue. Never rejects.
 retire(t:Topic,text:string){
  return enqueue(this.topicQueues,t.id,async()=>{
   if(t.state!=='ready')return;let a:App;
   try{a=this.app(t.appId);if(!await this.alive(a,t))return;await this.herdr(this.target(t),['pane','close',t.paneId]);}
   catch(e){this.store.log('话题会话',`${t.agentName}：未能关闭 pane，${brief(e)}`,'error');return;}
   this.store.log('话题会话',`${t.agentName}：已关闭 pane ${t.paneId}`);await this.end(a,t,text);
  });
 }
 // Whether topic t, which ended, starts again with the next message: Bridge started it, with a workspace of its project.
 continuable(t:Topic){return t.state==='closed'&&Boolean(t.routed)&&!t.adopted;}
 // Removes the workspace of the topics that ended or failed more than 7 days ago (see sweepable), once each, in their queues; the next
 // message of such a topic prepares it again. A removal that fails, such as one on a machine whose client is offline, is logged and tried
 // again by the next sweep; a topic whose project is gone has nothing to remove it by and counts as swept. Never rejects; resolves when
 // all are done.
 sweep(){
  return Promise.all(this.store.data.topics.filter(t=>sweepable(t,this.now())).map(t=>enqueue(this.topicQueues,t.id,async()=>{
   // Checked again in the queue: a message may have started the topic again meanwhile.
   if(!sweepable(t,this.now()))return;
   try{await this.removeWorkspaceOf(t);this.update(t,{swept:true});this.store.log('话题清理',`${t.agentName}：已删除工作目录`);}
   catch(e){
    if(e.code==='project_gone')this.update(t,{swept:true});
    this.store.log('话题清理',`${t.agentName}：未能删除工作目录，${brief(e)}`,'error');
   }
  })));
 }
 // Starts the agent of topic t: decides its project and branch (see route), prepares the workspace on the machine, places Bridge's skills in
 // it, prepares the launch, opens a tab there and starts the agent, and shows the card with the settings it started with (see showCard).
 // Returns false when that failed; the topic is then failed and notified, and the card is there to start it again with other settings.
 async open(a:App,b:Binding,t:Topic){
  this.update(t,{state:'starting',error:''});delete t.endedAt;delete t.swept;let m:Machine;
  try{
   const config=this.agentConfig(t);m=this.target(t);
   await this.route(m,b,t);if(t.routed)await this.showCard(a,t);
   const dir=await this.workspace(m,t);
   Object.assign(t,await enqueue(this.workspaceQueues,b.id,()=>this.openTab(m,b,t,dir)));this.store.save();
   await this.place(m,b,config.kind,dir,this.projectOf(t)?.skills??[]);
   const args=await this.launchArguments(m,config,dir);
   try{await this.startAgent(m,t,config.kind,args);}
   // The agent exists but waits for a confirmation such as a trust prompt; prompts then report agent_blocked.
   catch(e){if(e.code!=='agent_not_ready')throw e;}
   // Before the topic is ready, which links it to its agent only while the setting is on.
   await this.herdr(m,remoteAnswers(t.paneId,true));
  }catch(e){
   this.update(t,{state:'failed',error:brief(e),endedAt:this.now()});this.store.log('话题会话',`${b.name}：启动失败，${t.error}`,'error');
   // Details can hold local paths and raw Herdr errors; they stay in the topic and the log, unless the client of the machine is offline,
   // which the person can wait out.
   await this.notify(a,t,e.code==='client_offline'?offline(e,'话题没有启动，请稍后重发消息'):'启动失败，请在 Bridge 管理台查看原因');
   return false;
  }
  this.update(t,{state:'ready'});this.store.log('话题会话',`${b.name}：已在 ${m.name} 启动 ${t.agentName}`);return true;
 }
 // The agent configuration that topic t starts with.
 agentConfig(t:Topic){
  const config=this.store.data.agentConfigs.find(c=>c.id===t.agentConfigId);if(!config)throw Error('Agent 配置不存在');return config;
 }
 // The project of topic t, or nothing for a topic that found none.
 projectOf(t:Topic){return this.store.data.projects.find(p=>p.id===t.projectId);}
 // Decides, once, the project of topic t and the branch of its worktrees; the topic is routed then, and a start that failed later does not
 // decide again. The project of a group is the binding's, and one call of the cheap model names the branch when its worktrees have one; in a
 // direct chat the same call also picks the project of all projects by the task, and a topic whose call picks none works in an empty
 // directory. A branch that the topic has already is kept (see restart), and a model that fails or names none gives a random branch; one that another topic has gets a number (see freeBranch), which is decided
 // in the same step that records it, so that topics named at once do not take the same one.
 // A topic of before the projects has a directory and is never routed. Fails when the project of the topic is gone.
 async route(m:Machine,b:Binding,t:Topic){
  // Also for a topic that is routed: one that ended in a project deleted since must not start in the empty directory of a topic without one.
  if(t.projectId&&!this.projectOf(t))throw Error('项目不存在');
  if(t.routed||t.cwd)return;
  const projects=this.store.data.projects,direct=!t.projectId;let project=this.projectOf(t);
  const asking=direct?projects.length>0:hasBranch(project)&&!t.branch;let named:Named={};
  if(asking){named=await nameTask(this.askCheapModel,m,t.task!.content,direct?projects:null);if(direct)project=named.project;}
  const branch=hasBranch(project)?t.branch??freeBranch(named.branch??randomBranch('topic'),t,this.store.data.topics):undefined;
  if(asking&&named.reason)this.store.log('话题会话',`${b.name}：${direct&&!project?'没有选出项目':'起名失败'}（${named.reason}），${branch&&!named.branch?'改用随机分支名':'没有用上模型的结果'}`);
  if(!branch)delete t.branch;
  this.update(t,{routed:true,...project&&{projectId:project.id},...branch&&{branch}});
 }
 // Starts agent kind in the pane of topic t on machine m with args. The shell of a pane that was just opened may still be starting, and
 // Herdr refuses a pane whose shell is busy (agent_pane_busy), so that is tried again for up to shellWaitMs before it counts.
 async startAgent(m:Machine,t:Topic,kind:Kind,args:string[]){
  for(let waited=0;;waited+=shellPollMs){
   try{await this.herdr(m,['agent','start',t.agentName,'--kind',kind,'--pane',t.paneId,'--timeout','60000',...args],{timeoutMs:70000});return;}
   catch(e){if(e.code!=='agent_pane_busy'||waited>=shellWaitMs)throw e;}
   await this.pause(shellPollMs);
  }
 }
 // Prepares the workspace of topic t on machine m and resolves to the directory its agent starts in, which the topic records. A topic of
 // before the projects has its directory already.
 async workspace(m:Machine,t:Topic){
  if(!t.routed)return t.cwd!;
  const {dir}=await this.prepareWorkspace(m,{project:workspaceOf(this.projectOf(t),m.id),topicId:t.id,...t.branch&&{branch:t.branch}},{timeoutMs:workspaceTimeoutMs});
  this.update(t,{cwd:dir});return dir;
 }
 // What follows the -- of `agent start` for configuration config in directory dir: all of it comes from the client of the machine, which also
 // prepares what it needs there, such as the trust of the directory (see prepareLaunch in link.ts).
 async launchArguments(m:Machine,config:AgentConfig,dir:string){
  const {args}=await this.prepareLaunch(m,{kind:config.kind,...config.model&&{model:config.model},...config.kind==='claude'&&{permissionMode:permissionMode(config)},
   ...config.allowedCommands&&{allowedCommands:config.allowedCommands},dir},{timeoutMs:launchTimeoutMs});
  return ['--',...args];
 }
 // Shows the first card of topic t, which the first start posts into the thread and every start after it draws again (see startCard): the
 // project, the branch, the agent configuration, and the dropdowns that offer the other projects and configurations. Never rejects: a card
 // that cannot be sent is logged, and the topic starts without it.
 async showCard(a:App,t:Topic){
  const project=this.projectOf(t),config=this.agentConfig(t),choice=({id,name}:{id:string,name:string})=>({id,name});
  const card=startCard({project:project?.name??null,...t.branch&&{branch:t.branch},config:config.name,
   projects:this.store.data.projects.filter(p=>p!==project).map(choice),configs:this.store.data.agentConfigs.filter(c=>c!==config).map(choice)},++this.drawings);
  try{
   if(t.startCard)await this.updateCard(a,t.startCard,card);
   else this.update(t,{startCard:await this.reply(a,t.chatId,t.rootId,{card})});
  }catch(e){this.store.log('话题通知',`${a.name}：话题的第一张卡片未发出，${brief(e)}`,'error');}
 }
 // Places the skills loaded by default and those of the project, named in skills, for the agent of kind kind in its working directory cwd on
 // machine m, which exists by then, right before the agent starts and loads them (see Skills.place). Same-name skills of others are left
 // alone and logged. Never rejects: a failure is only logged, and the agent starts without the skills.
 async place(m:Machine,b:Binding,kind:Kind,cwd:string,skills:string[]){
  try{for(const p of await this.placeSkills(m,cwd,kind,skills))this.store.log('skill',`${b.name}：${p} 已有同名 skill，不是 Bridge 放的，没有改动`);}
  catch(e){this.store.log('skill',`${b.name}：未能在 ${cwd} 放置 skill，${brief(e)}`,'error');}
 }
 // The binding's workspace on machine m is created on first use and again after it was closed in Herdr; its root tab serves the topic that
 // created it. Herdr reuses workspace ids after a server restart, so the stored id counts only while the workspace still carries the
 // binding's label. The tab starts in directory dir, which exists: Herdr would fall back to the home directory otherwise. Runs in the binding's queue so that topics opened together create the workspace once.
 async openTab(m:Machine,b:Binding,t:Topic,dir:string){
  const {workspaces}=await this.herdr(m,['workspace','list']),known=b.workspaces?.[m.id];
  if(known&&workspaces.some(w=>w.workspace_id===known&&w.label===workspaceLabel(b))){
   const r=await this.herdr(m,['tab','create','--workspace',known,'--cwd',{path:dir},'--label',t.title,'--no-focus']);
   return {workspaceId:known,tabId:r.tab.tab_id,paneId:r.root_pane.pane_id};
  }
  const r=await this.herdr(m,['workspace','create','--cwd',{path:dir},'--label',workspaceLabel(b),'--no-focus']);
  await this.herdr(m,['tab','rename',r.tab.tab_id,t.title]);
  b.workspaces={...b.workspaces,[m.id]:r.workspace.workspace_id};return {workspaceId:r.workspace.workspace_id,tabId:r.tab.tab_id,paneId:r.root_pane.pane_id};
 }
 // Takes an agent list of machine m after each refresh. The linked agent of a ready topic reports reply_seq, the seq of its latest reply
 // (missing in Herdr versions without replies), state_change_seq, which grows with every status change, and request_ids. In the topic's
 // queue, so that they never overlap with prompts: new replies are fetched and then the reactions of ended turns removed (a failed fetch
 // keeps the reactions for the next list); the cards follow the requests (see cards); a blocked agent gets its notice (see blocked); and
 // last, so that it never holds back any of these, the open COT follows the agent (see advance). A topic without its linked agent in the
 // list waits on no request, and ends when a list read in its queue confirms that the agent is gone: this list may have been read before
 // the topic turned remote answers on. Never rejects; resolves when the work it queued is done.
 sync(m:Machine,agents:Agent[]){
  return Promise.all(this.store.data.topics.filter(t=>t.machineId===m.id&&t.state==='ready').map(t=>{
   const agent=linked(t,agents),seq=agent?.reply_seq,fetch=seq!=null&&seq!==(t.replySeq||0);
   const ids=requestIds(agent),cards=this.gone(t,ids).length>0||this.fresh(t,ids).length>0,blocked=this.blocked(t,agent,ids),cot=agent&&news(t,agent);
   if(agent&&!fetch&&!ended(t,agent).length&&!cards&&blocked==null&&!cot)return;
   return enqueue(this.topicQueues,t.id,async()=>{
    if(!agent){if(cards)await this.cards(m,t,ids);await this.alive(this.app(t.appId),t);return;}
    try{if(fetch)await this.pull(m,t,seq);for(const r of ended(t,agent))await this.dropReaction(t,r);}
    catch(e){this.store.log('回复转发',`${t.agentName}：${brief(e)}`,'error');}
    if(cards)await this.cards(m,t,ids);
    if(blocked!=null&&t.state==='ready'&&t.blockedSeq!==blocked){this.update(t,{blockedSeq:blocked});await this.notify(this.app(t.appId),t,'Agent 正在等待终端里的操作，请到 Herdr 中处理');}
    if(cot)await this.advance(m,t,agent);
   }).catch(e=>this.store.log('话题通知',`${t.agentName}：${brief(e)}`,'error'));
  }));
 }
 // A blocked agent without requests waits on something that Feishu cannot answer, such as a Codex question, any Antigravity approval or
 // question, or a trust prompt. Resolves to the state_change_seq of such a blocked episode once two lists in a row report it and no
 // notice covers it yet, else to nothing.
 blocked(t:Topic,agent:Agent|undefined,ids:number[]){
  const seq=agent?.agent_status==='blocked'&&!ids.length?agent.state_change_seq:undefined,previous=this.blockedSeen.get(t.id);
  if(seq==null){this.blockedSeen.delete(t.id);return;}
  this.blockedSeen.set(t.id,seq);return previous===seq&&t.blockedSeq!==seq?seq:undefined;
 }
 // Records of requests that are no longer in ids, except those being answered from Feishu (see click); and ids without a record.
 gone(t:Topic,ids:number[]){return (t.cards||[]).filter(c=>!ids.includes(c.requestId)&&!this.answering.has(t.id+' '+c.requestId));}
 fresh(t:Topic,ids:number[]){return ids.filter(id=>!(t.cards||[]).some(c=>c.requestId===id));}
 // Brings the cards of topic t in line with ids, the requests its agent waits on in the list: the card of a request that is gone shows
 // 已失效, and a new request gets a card in the thread. Only requests of the list get one: an older list that is queued after this one then
 // cannot find a card of a request it has not seen. Never rejects.
 async cards(m:Machine,t:Topic,ids:number[]){
  try{
   if(t.state!=='ready')return;
   const a=this.app(t.appId);for(const c of this.gone(t,ids))await this.dropCard(a,t,c);
   if(!this.fresh(t,ids).length)return;
   const {requests}=await this.herdr(m,['agent','requests',t.paneId]);
   for(const r of requests)if(this.fresh(t,ids).includes(r.id)){
    // At least once: the record is saved only after Feishu took the card, and a failed send is tried again with the next list.
    // A missing card could keep the agent waiting for hours; a second one costs little.
    try{const messageId=await this.reply(a,t.chatId,t.rootId,{card:pending(r,++this.renders)});this.update(t,{cards:[...t.cards||[],{requestId:r.id,messageId,title:title(r)}]});this.store.log('请求卡片',`${t.agentName}：已发送请求 #${r.id} 的卡片`);}
    catch(e){this.store.log('请求卡片',`${t.agentName}：请求 #${r.id} 的卡片未发出，${brief(e)}`,'error');}
   }
  }catch(e){this.store.log('请求卡片',`${t.agentName}：${brief(e)}`,'error');}
 }
 // Drops record c and shows its last card: 已失效 unless given another. At most once, like reactions: the record is dropped before
 // Feishu is called, and a failed update is only logged.
 async dropCard(a:App,t:Topic,c:RequestCard,card:object=expired(c.title)){
  this.update(t,{cards:(t.cards||[]).filter(x=>x!==c)});
  try{await this.updateCard(a,c.messageId,card);}catch(e){this.store.log('请求卡片',`${t.agentName}：请求 #${c.requestId} 的卡片未能更新，${brief(e)}`,'error');}
 }
 // A choice in a dropdown of the first card of a topic by someone on the app's allowlist (see click). The topic starts again afterwards in
 // its queue, and the thread then says so.
 change(a:App,evt:Click){
  const t=this.store.data.topics.find(x=>x.appId===a.id&&x.startCard===evt.messageId),b=t&&this.store.data.bindings.find(x=>x.id===t.bindingId);
  if(!t||!b)return toast('info','这张卡片已失效');
  const id=evt.action.option;let change:Parameters<Topics['restart']>[3],said:string;
  if(evt.action.value!.restart==='project'){
   const p=this.store.data.projects.find(x=>x.id===id);if(!p)return toast('warning','所选的项目已不存在');
   if(p.id===t.projectId)return toast('info','话题已经在使用这个设置');change={projectId:p.id};said=`已换成项目 ${p.name}，话题重新开始。`;
  }else{
   const c=this.store.data.agentConfigs.find(x=>x.id===id);if(!c)return toast('warning','所选的 Agent 配置已不存在');
   if(c.id===t.agentConfigId)return toast('info','话题已经在使用这个设置');change={agentConfigId:c.id};said=`已换成 Agent 配置 ${c.name}，话题重新开始。`;
  }
  const key=t.id+' restart';if(this.answering.has(key))return toast('info','正在重新开始，请稍候');
  this.answering.set(key,enqueue(this.topicQueues,t.id,()=>this.restart(a,b,t,change,said)).finally(()=>this.answering.delete(key)));
  return toast('info','正在重新开始话题');
 }
 // Starts topic t again under another project or agent configuration (change), in its queue: the agent ends if it still runs, the workspace
 // of the old settings is removed (the branch stays where it has commits), and the task of the topic goes through the way a new topic starts,
 // with the branch the topic has, so that the cheap model is not asked again. said is the notice that follows once the agent is up. An agent that cannot be closed leaves the topic as it was; a workspace that cannot be removed is only logged. Never rejects.
 async restart(a:App,b:Binding,t:Topic,change:{projectId:string}|{agentConfigId:string},said:string){
  try{
   const m=this.target(t);
   if(t.state==='ready'){const {agents}=await this.herdr(m,['agent','list']);if(linked(t,agents))await this.herdr(m,['pane','close',t.paneId]);}
  }catch(e){this.store.log('话题会话',`${t.agentName}：未能结束 Agent，${brief(e)}`,'error');return this.notify(a,t,'未能结束当前的 Agent，话题保持原样，请稍后重试');}
  this.update(t,{state:'starting',error:''});this.blockedSeen.delete(t.id);
  await this.wrapUp(a,t,'话题已重新开始');
  try{await this.removeWorkspaceOf(t);}catch(e){this.store.log('话题会话',`${t.agentName}：未能删除工作目录，${brief(e)}`,'error');}
  delete t.cwd;
  if('projectId' in change){delete t.routed;Object.assign(t,change);}
  else Object.assign(t,change,{machineId:this.store.data.agentConfigs.find(c=>c.id===change.agentConfigId)!.machineId});
  this.update(t,{workspaceId:'',tabId:'',paneId:'',replySeq:0});
  const task=t.task!,reacted=t.scheduled?undefined:this.addReaction(a,t,task.messageId);
  await this.promptOrNotify(a,b,t,task,reacted);
  if(t.state==='ready')await this.notify(a,t,said);
 }
 // Removes the workspace that topic t was prepared, on its machine, with the branch it keeps where it has commits (see removeWorkspace in
 // link.ts). Nothing was prepared for a topic that is not routed. Rejects when the client fails or the project is gone, which the caller logs.
 async removeWorkspaceOf(t:Topic){
  if(!t.routed)return;
  const m=this.target(t),project=this.projectOf(t);
  if(t.projectId&&!project)throw Object.assign(Error('项目已删除'),{code:'project_gone'});
  await this.removeWorkspace(m,{project:workspaceOf(project,m.id),topicId:t.id,...t.branch&&{branch:t.branch}},{timeoutMs:workspaceTimeoutMs});
 }
 // A click on a request card by someone on the app's allowlist (see Platforms), which waits for the returned callback response: Feishu
 // gives it a few seconds, and Herdr on another machine can take longer. The answer goes to Herdr afterwards and outside the topic queue, where a
 // message may be starting the agent for a minute; the card then shows how it ended.
 click(a:App,evt:Click){
  if(evt.action?.value?.adopt)return this.choose(a,evt);
  if(evt.action?.value?.restart)return this.change(a,evt);
  const v=evt.action?.value||{},t=this.store.data.topics.find(x=>x.appId===a.id&&x.cards?.some(c=>c.messageId===evt.messageId)),c=t?.cards.find(x=>x.messageId===evt.messageId&&x.requestId===v.request);
  if(!t||!c)return toast('info','这个请求已结束');
  const key=t.id+' '+c.requestId;if(this.answering.has(key))return toast('info','正在提交，请稍候');
  const complete=v.decision!=null||answered(v.questions,evt.action.formValue);
  this.answering.set(key,this.settle(a,t,c,evt,complete).finally(()=>this.answering.delete(key)));
  return t.state!=='ready'?toast('info','这个请求已结束'):complete?toast('info','正在提交'):toast('warning','请回答所有问题');
 }
 // Answers record c from a click, or draws its card again when a question is left unanswered. The request is read from Herdr first:
 // the card must still show it, and the record keeps only its title. Never rejects.
 async settle(a:App,t:Topic,c:RequestCard,{operator,action}:Click,complete:boolean){
  try{
   if(t.state!=='ready')return await this.dropCard(a,t,c);
   const m=this.target(t),{requests}=await this.herdr(m,['agent','requests',t.paneId]),r=requests.find(x=>x.id===c.requestId);
   if(!r||check(r)!==action.value!.check)return await this.dropCard(a,t,c);
   const answer=complete&&answerOf(r,action);
   if(!answer)return await this.updateCard(a,c.messageId,pending(r,++this.renders,action.formValue));
   try{await this.herdr(m,['agent','answer',t.paneId,String(r.id),...answerArgs(answer)]);}
   catch(e){if(e.code==='request_not_found')return await this.dropCard(a,t,c);throw e;}
   this.store.log('请求卡片',`${t.agentName}：请求 #${r.id} 已在飞书中回答`);await this.dropCard(a,t,c,settled(r,answer,operator.openId));
  }catch(e){
   // Whether Herdr took the answer is unknown. Without its record, the next list sends a new card if the request still waits.
   this.store.log('请求卡片',`${t.agentName}：请求 #${c.requestId} 未能回答，${brief(e)}`,'error');
   if(t.cards?.includes(c))await this.dropCard(a,t,c,failed(c.title));
  }
 }
 // /adopt: the command message opens a topic that waits for an agent to adopt (state choosing), and the bot answers in its thread with the
 // picker of the agents on every connected machine that no topic holds. adopted marks such a topic: it holds the picker's message id, and
 // once an agent is adopted also the agent's kind and its session where the agent reports one. Never rejects.
 offer(a:App,b:Binding,msg:Inbound){
  const t:Topic={id:uuid(),bindingId:b.id,appId:a.id,chatId:b.chatId,rootId:msg.messageId,machineId:'',workspaceId:'',tabId:'',paneId:'',agentName:'',title:'接管 Agent',
   state:'choosing',error:'',messageIds:[msg.messageId],replySeq:0,reactions:[],cards:[],adopted:{},createdAt:this.now()};
  this.store.data.topics.push(t);this.store.save();
  return enqueue(this.topicQueues,t.id,async()=>{
   const card=picker(await this.candidates(),++this.renders);
   try{this.update(t,{adopted:{picker:await this.reply(a,t.chatId,t.rootId,{card})}});this.store.log('话题接管',`${b.name}：已发送可接管的 Agent 列表`);}
   // Without a picker nothing can be adopted: the topic ends, and later messages in its thread are dropped like in any closed topic.
   catch(e){this.update(t,{state:'closed'});this.store.log('话题接管',`${b.name}：可接管的 Agent 列表未发出，${brief(e)}`,'error');}
  }).catch(e=>this.store.log('话题接管',`${b.name}：${brief(e)}`,'error'));
 }
 // The agents a topic can adopt, per connected machine in store order: {machine, failed, agents:[{agent, name}]}, where name is what
 // the person calls the agent (see nameOf). One snapshot per machine carries the agents together with the pane, tab and workspace labels
 // that name them. A machine whose snapshot fails is failed. Never rejects.
 candidates():Promise<Group[]>{
  return Promise.all(this.store.data.machines.filter(m=>m.enabled).map(async machine=>{
   let snapshot;try{({snapshot}=await this.herdr(machine,['api','snapshot']));}
   catch(e){this.store.log('话题接管',`${machine.name}：${brief(e)}`,'error');return {machine,failed:true,agents:[]};}
   const s=this.free(machine,snapshot);return {machine,failed:false,agents:s.agents.map(x=>({agent:x,name:nameOf(s,x)}))};
  }));
 }
 // Snapshot s of machine m with only the agents that a topic can adopt: those with an agent kind, in a pane that no topic holds.
 free(m:Machine,s:Snapshot){return {...s,agents:s.agents.filter((x):x is Offered=>Boolean(x.agent)&&!this.held(m.id,x.pane_id))};}
 // The latest reply of agent x from the list of machine m, or null.
 async latest(m:Machine,x:Agent){if(x.reply_seq==null)return null;const {replies}=await this.herdr(m,['agent','replies',x.pane_id,'--after',String(x.reply_seq-1)]);return replies.at(-1)||null;}
 // Whether a topic holds pane p of machine m: a topic starting or ready in it, or a selection that is adopting it.
 held(m:string,p:string){return this.claims.has(m+' '+p)||this.store.data.topics.some(t=>['starting','ready'].includes(t.state)&&t.machineId===m&&t.paneId===p);}
 // A submission of a picker by someone on the app's allowlist (see click). The chosen agent is adopted afterwards in the topic's queue;
 // a submission without a choice draws the picker again, so that the next one is not dropped as a repeat.
 choose(a:App,evt:Click){
  const t=this.store.data.topics.find(x=>x.appId===a.id&&x.adopted?.picker===evt.messageId);
  if(!t)return toast('info',`这张卡片已失效，请重新发送 ${slash.adopt}`);
  if(t.state!=='choosing')return toast('info','这个话题已接管 Agent，不能再选择');
  const key=t.id+' adopt';if(this.answering.has(key))return toast('info','正在接管，请稍候');
  const v=chosen(evt.action.formValue);
  this.answering.set(key,enqueue(this.topicQueues,t.id,()=>this.adopt(a,t,v,evt.operator)).finally(()=>this.answering.delete(key)));
  return v?toast('info','正在接管'):toast('warning',unchosen);
 }
 // Adopts agent v that the person operator chose on a picker when its pane still runs that agent and no topic holds it: remote answers
 // are turned on, then the topic is linked and ready under the agent's name, and the intro with the agent's latest reply goes into the
 // thread. The pane stays where it is. Otherwise, also without a choice, the picker is drawn again with the reason. Never rejects.
 async adopt(a:App,t:Topic,v:Choice|null,operator:Click['operator']){
  const b=this.store.data.bindings.find(x=>x.id===t.bindingId),name=b?.name||a.name;let claim;
  try{
   if(t.state!=='choosing')return;
   if(!v)return await this.redraw(a,t,unchosen);
   const m=this.store.data.machines.find(x=>x.id===v.machine);
   if(!m?.enabled)return await this.redraw(a,t,'所选的机器已断开，请重新选择');
   const {snapshot}=await this.herdr(m,['api','snapshot']),x=snapshot.agents.find(y=>y.pane_id===v.pane);
   if(!x||!stillChosen(v,x))return await this.redraw(a,t,'所选的 Agent 已退出或已变化，请重新选择');
   if(this.held(m.id,x.pane_id))return await this.redraw(a,t,'所选的 Agent 已被其他话题接管，请重新选择');
   const called=nameOf(this.free(m,snapshot),x);
   // Held from here until the ready topic holds it, so that another selection cannot take it while Herdr is called.
   claim=m.id+' '+x.pane_id;this.claims.add(claim);
   await this.herdr(m,remoteAnswers(x.pane_id,true));
   let latest=null;try{latest=await this.latest(m,x);}catch(e){this.store.log('话题接管',`${name}：未能读取最近一条回复，${brief(e)}`,'error');}
   // The reply shown in the intro is not forwarded again.
   this.update(t,{machineId:m.id,workspaceId:x.workspace_id||'',tabId:x.tab_id||'',paneId:x.pane_id,agentName:called,title:'接管 · '+called,state:'ready',
    replySeq:latest?.seq??x.reply_seq??0,adopted:{picker:t.adopted!.picker,kind:x.agent,...x.agent_session&&{session:x.agent_session.value}}});
   this.store.log('话题接管',`${name}：已接管 ${m.name} 上的 ${t.agentName}`);
   await this.notify(a,t,intro(m,x,called,latest));
   if(latest)try{await this.post(a,t,latest);}catch(e){this.store.log('话题通知',`${a.name}：${brief(e)}`,'error');}
   try{await this.updateCard(a,t.adopted!.picker!,adoptedPicker(m,x,called,operator.openId));}catch(e){this.store.log('话题接管',`${name}：接管卡片未能更新，${brief(e)}`,'error');}
  }catch(e){
   this.store.log('话题接管',`${name}：接管失败，${brief(e)}`,'error');
   if(t.state==='choosing')await this.redraw(a,t,'接管失败，请稍后重试');
  }finally{if(claim)this.claims.delete(claim);}
 }
 // Draws the picker of topic t again, led by notice. Never rejects.
 async redraw(a:App,t:Topic,notice:string){
  // The picker was posted: a click on it got here.
  try{await this.updateCard(a,t.adopted!.picker!,picker(await this.candidates(),++this.renders,notice));}
  catch(e){this.store.log('话题接管',`${a.name}：接管卡片未能更新，${brief(e)}`,'error');}
 }
 // /stop in ready topic t: Esc to its agent, which interrupts the turn of Claude, Codex and Antigravity like pressing it in the terminal, and
 // the open COT shows the run interrupted; without one a notice says that the turn stops. Esc goes only to an agent that works or waits for
 // a confirmation: at an idle prompt it can open a menu of the agent (Claude's rewind). Never rejects.
 async stop(a:App,t:Topic){
  try{
   const agent=await this.alive(a,t);if(!agent)return;
   if(!['working','blocked'].includes(agent.agent_status))return await this.notify(a,t,'Agent 当前没有在运行的一轮');
   await this.herdr(this.target(t),['agent','send-keys',t.paneId,'esc']);
  }catch(e){this.store.log('话题停止',`${t.agentName}：未能停止，${brief(e)}`,'error');return await this.notify(a,t,'未能停止 Agent，请稍后重试');}
  this.store.log('话题停止',`${t.agentName}：已发送停止`);
  if(t.cot)await this.closeCot(t,[runFinished(run(t),'interrupted')],'error');else await this.notify(a,t,'已停止 Agent 当前这一轮');
 }
 // /stop as a root message of binding b, which the stop button of a COT sends in a direct chat: it stops the one ready topic of the chat
 // whose COT is open; with none or several the bot asks in the message's thread for /stop in the topic. It never opens a topic. Never rejects.
 async stopChat(a:App,b:Binding,msg:Inbound){
  const open=this.store.data.topics.filter(t=>t.bindingId===b.id&&t.state==='ready'&&t.cot);
  if(open.length===1)return enqueue(this.topicQueues,open[0].id,()=>this.stop(a,open[0]));
  try{await this.reply(a,b.chatId,msg.messageId,{card:notice(`请在要停止的话题里发送 ${slash.stop}`)});}catch(e){this.store.log('话题停止',`${b.name}：${brief(e)}`,'error');}
 }
 // /release in an adopted topic: remote answers are turned off and the topic ends; the agent keeps running in its pane. When they cannot
 // be turned off, the topic stays linked unless its agent turns out to be gone already.
 async release(a:App,b:Binding,t:Topic){
  if(t.state!=='ready')return;
  try{await this.herdr(this.target(t),remoteAnswers(t.paneId,false));}
  catch(e){
   this.store.log('话题接管',`${b.name}：未能结束接管，${brief(e)}`,'error');
   if(await this.alive(a,t).catch(()=>true))await this.notify(a,t,'未能结束接管，请稍后重试');return;
  }
  this.store.log('话题接管',`${b.name}：已结束接管 ${this.machine(t.machineId).name} 上的 ${t.agentName}`);
  await this.end(a,t,'已结束接管。Agent 仍在终端的 pane 里运行，话题里的消息不再发给它');
 }
 // Drops the topics of a removed binding. Their agents keep running; those of ready topics stop waiting for Feishu's answers, and their open
 // COT shows the run failed. The directories of their attachments are removed, also those that an ended topic failed to remove, and so are
 // the workspaces of the topics that ended or failed, which no record would remove after this (see removeWorkspaceOf); the workspace of a
 // ready topic stays, as its agent still works in it. Never rejects; resolves once Herdr and Feishu were told.
 unbind(bindingId:string){
  const dropped=this.store.data.topics.filter(t=>t.bindingId===bindingId);
  this.store.data.topics=this.store.data.topics.filter(t=>t.bindingId!==bindingId);this.store.save();
  return Promise.all(dropped.map(async t=>{
   if(unused(t))await enqueue(this.topicQueues,t.id,async()=>{
    try{await this.removeWorkspaceOf(t);this.store.log('话题清理',`${t.agentName}：已删除工作目录`);}
    catch(e){this.store.log('话题清理',`${t.agentName}：未能删除工作目录，${brief(e)}`,'error');}
   });
   if(t.state==='ready'){
    try{await this.herdr(this.target(t),remoteAnswers(t.paneId,false));}
    catch(e){this.store.log('话题会话',`${t.agentName}：未能关闭外部回答，${brief(e)}`,'error');}
    if(t.cot)await this.closeCot(t,[runError('话题已结束')],'error');
   }
   await this.clean(t);
  }));
 }
 // Sends the agent's replies after t.replySeq, up to seq from the agent list, into the thread.
 async pull(m:Machine,t:Topic,seq:number){
  const last=t.replySeq||0,b=this.store.data.bindings.find(x=>x.id===t.bindingId);
  // Checked again in the queue: an earlier sync of the same list may have sent them, a message may have closed the topic or the binding is gone.
  if(!b||t.state!=='ready'||seq===last)return;
  // A seq below the stored one means Herdr restarted or handed off and counts from 1 again: take its replies up to seq.
  const a=this.app(t.appId),reset=seq<last,{replies}=await this.herdr(m,['agent','replies',t.paneId,...reset?[]:['--after',String(last)]]);
  for(const r of replies)if(!reset||r.seq<=seq){
   // At most once, like messages: the seq is on disk before the send, and a failed card is not sent again (see post).
   this.update(t,{replySeq:r.seq});
   try{await this.post(a,t,r);this.store.log('回复转发',`${b.name}：已转发 ${t.agentName} 的回复`);}
   catch(e){this.store.log('回复转发',`${b.name}：${t.agentName} 的回复${e.sent?`只发出了前 ${e.sent} 张卡片`:'未发出'}，${brief(e)}`,'error');}
  }
 }
 // Posts reply r of the agent into the thread as its cards, in order. The first card that fails ends the reply: the cards after it are
 // dropped rather than posted after a gap, and most failures (Feishu not connected) would meet them too. Rejects with the error of that
 // card, its sent property counting the cards that went out before it.
 async post(a:App,t:Topic,r:Reply){
  const cards=replyCards(r);
  for(const [i,card] of cards.entries())try{await this.reply(a,t.chatId,t.rootId,{card});}catch(e){throw Object.assign(e,{sent:i});}
 }
 // Resolves to the record kept in t.reactions, or to null when Feishu refused the reaction; delivery goes on either way.
 async addReaction(a:App,t:Topic,messageId:string){
  try{const r:Reaction={messageId,reactionId:await this.react(a,messageId,reaction),stateSeq:null};this.update(t,{reactions:[...t.reactions||[],r]});return r;}
  catch(e){this.store.log('消息表情',`${t.agentName}：未能贴上表情，${brief(e)}`,'error');return null;}
 }
 // At most once: the record is dropped before Feishu is called, and a failed removal is only logged.
 async dropReaction(t:Topic,r?:Reaction|null|''){
  if(!r||!t.reactions?.includes(r))return;this.update(t,{reactions:t.reactions.filter(x=>x!==r)});
  try{await this.unreact(this.app(t.appId),r.messageId,r.reactionId);}catch(e){this.store.log('消息表情',`${t.agentName}：未能取消表情，${brief(e)}`,'error');}
 }
 target(t:Topic){const m=this.machine(t.machineId);if(!m.enabled)throw Error('机器连接已停用');return m;}
 update(t:Topic,fields:Partial<Topic>){Object.assign(t,fields);this.store.save();}
 async notify(a:App,t:Topic,text:string){try{await this.reply(a,t.chatId,t.rootId,{card:notice(text)});}catch(e){this.store.log('话题通知',`${a.name}：${brief(e)}`,'error');}}
}
