import {uuid,publicText} from './core.mjs';
import {title,check,answered,pending,answerOf,answerArgs,settled,expired,failed} from './request-cards.mjs';
import {permissionMode} from './platform.mjs';
// One Feishu topic = one Herdr agent session in its own tab of the binding's workspace. Everything goes through the Herdr CLI.
const workspaceLabel=b=>'飞书 · '+b.name;
// Arguments that Herdr passes on to the agent it starts, after --: a Claude binding's permission mode.
const agentArgs=b=>b.kind==='claude'?['--','--permission-mode',permissionMode(b)]:[];
const brief=e=>publicText(e.message).split('\n')[0].slice(0,200);
// Set in every topic pane: the agent's permission and question hooks then wait for an answer from Feishu (see cards).
const remoteAnswers=['--env','HERDR_REMOTE_ANSWERS=1'];
// Marks a message from the moment a topic accepts it until the agent's turn for it ends.
const reaction='OneSecond';
// Reactions of prompted messages whose turn has ended: the agent is idle or done and has changed state since the prompt.
const ended=(t,agent)=>['idle','done'].includes(agent?.agent_status)?(t.reactions||[]).filter(r=>r.stateSeq!=null&&agent.state_change_seq>r.stateSeq):[];
// Ids of the requests an agent of the list waits on (missing in Herdr versions without requests).
const requestIds=agent=>agent?.request_ids||[];
const toast=(type,content)=>({toast:{type,content}});
// Keyed queues: tasks with the same key run one after another; a failed task does not block the next one.
function enqueue(queues,key,task){
 const run=(queues.get(key)||Promise.resolve()).then(task),tail=run.catch(()=>{});
 queues.set(key,tail);tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});return run;
}
export class Topics{
 // herdr(m,args,{timeoutMs}) runs a Herdr CLI command; makeDirectory(m,path) creates a directory and its parents on machine m;
 // machine(id) and app(id) return a machine or an app, or throw; reply(app,chatId,rootId,{text}|{markdown}|{card}) answers in the topic
 // thread and resolves to the message id; updateCard(app,messageId,card) replaces a card sent that way;
 // react(app,messageId,emojiType) resolves to a reaction id for unreact(app,messageId,reactionId).
 constructor(store,{herdr,makeDirectory,machine,app,reply,updateCard,react,unreact}){
  this.store=store;this.herdr=herdr;this.makeDirectory=makeDirectory;this.machine=machine;this.app=app;this.reply=reply;this.updateCard=updateCard;this.react=react;this.unreact=unreact;this.topicQueues=new Map();this.workspaceQueues=new Map();
  // In memory: the clicks being answered as '<topic id> <request id>' → the promise of their answer; per topic the state_change_seq of
  // a blocked agent without requests in the latest list; and a counter that numbers card drawings.
  this.answering=new Map();this.blockedSeen=new Map();this.renders=0;
  // A start interrupted by a restart cannot be resumed; the next message in the topic retries it.
  const interrupted=store.data.topics.filter(t=>t.state==='starting');
  for(const t of interrupted)Object.assign(t,{state:'failed',error:'Bridge 重启时 Agent 启动未完成'});
  if(interrupted.length)store.save();
 }
 // A routed message. Never rejects: failures end up as topic states, notices in the thread or error logs.
 async handle(a,b,msg){
  const rootId=msg.rootId||msg.messageId;let t=this.store.data.topics.find(x=>x.bindingId===b.id&&x.rootId===rootId);
  if(!msg.messageId||t?.messageIds.includes(msg.messageId))return;
  const text=msg.content.trim();
  if(!t){
   if(b.requireMention&&!msg.mentionedBot)return;
   // Recorded before the first await, so messages arriving meanwhile join this topic instead of opening another tab.
   const id=uuid();
   t={id,bindingId:b.id,appId:a.id,chatId:b.chatId,rootId,machineId:b.machineId,workspaceId:'',tabId:'',paneId:'',agentName:'feishu-'+id.slice(0,8),
    title:[...text.replace(/\s+/g,' ')].slice(0,24).join(''),state:'starting',error:'',messageIds:[],replySeq:0,reactions:[],cards:[],createdAt:Date.now()};
   this.store.data.topics.push(t);
  }
  // At most once: the id is on disk before Herdr is called, and a message seen before is dropped.
  t.messageIds=[...t.messageIds,msg.messageId].slice(-50);this.store.save();
  // Not behind the topic queue, where an earlier message may be starting the agent for a minute.
  const reacted=this.addReaction(a,t,msg.messageId);
  await enqueue(this.topicQueues,t.id,async()=>{
   let agent;try{agent=await this.forward(a,b,t,text);}
   // Settled in the queue, so a later message that closes the topic finds this record. A prompted message keeps its reaction
   // until its turn ends (see sync); any other message loses it now.
   finally{const r=await reacted;if(agent&&r){r.stateSeq=agent.state_change_seq;this.store.save();}else await this.dropReaction(t,r);}
  }).catch(e=>this.store.log('消息投递',`${a.name} → ${b.name}：${brief(e)}`,'error'));
 }
 // Sends the message to the topic's agent, opening the topic first when it is new or failed. Resolves to the prompted agent,
 // or to nothing when the message was not prompted.
 async forward(a,b,t,text){
  if(t.state==='closed')return;
  if(t.state==='ready'){
   const {agents}=await this.herdr(this.target(t),['agent','list']);
   if(!agents.some(x=>x.pane_id===t.paneId&&x.name===t.agentName)){
    this.update(t,{state:'closed'});await this.notify(a,t,'该话题的会话已结束，请发起新话题');
    // A reaction still being added is removed when its message settles, unprompted.
    for(const r of t.reactions||[])await this.dropReaction(t,r);
    for(const c of this.gone(t,[]))await this.dropCard(a,t,c);return;
   }
  }else if(!await this.open(a,b,t))return;
  let r;try{r=await this.herdr(this.target(t),['agent','prompt',t.paneId,text]);}
  catch(e){if(e.code!=='agent_blocked')throw e;await this.notify(a,t,'Agent 正在等待确认，请到 Herdr 中处理后重发这条消息');return this.noticed(t);}
  this.store.log('消息投递',`${a.name} → ${b.name}：已发送到 ${t.agentName}`);return r.agent;
 }
 // The notice of a prompt that met a blocked agent covers the blocked episode the agent is in, so sync does not post its own for it.
 // The prompt error carries no state_change_seq; it is read from a new list.
 async noticed(t){
  try{const {agents}=await this.herdr(this.target(t),['agent','list']),agent=agents.find(x=>x.pane_id===t.paneId&&x.name===t.agentName);if(agent?.agent_status==='blocked')this.update(t,{blockedSeq:agent.state_change_seq});}
  catch(e){this.store.log('话题通知',`${t.agentName}：${brief(e)}`,'error');}
 }
 // Opens a tab for the topic and starts its agent. Returns false when that failed; the topic is then failed and notified.
 async open(a,b,t){
  this.update(t,{state:'starting',error:''});let m;
  try{
   m=this.target(t);
   Object.assign(t,await enqueue(this.workspaceQueues,b.id,()=>this.openTab(m,b,t)));this.store.save();
   try{await this.herdr(m,['agent','start',t.agentName,'--kind',b.kind,'--pane',t.paneId,'--timeout','60000',...agentArgs(b)],{timeoutMs:70000});}
   // The agent exists but waits for a confirmation such as a trust prompt; prompts then report agent_blocked.
   catch(e){if(e.code!=='agent_not_ready')throw e;}
  }catch(e){
   this.update(t,{state:'failed',error:brief(e)});this.store.log('话题会话',`${b.name}：启动失败，${t.error}`,'error');
   // Details can hold local paths and raw Herdr errors; they stay in the topic and the log.
   await this.notify(a,t,'启动失败，请在 Bridge 管理台查看原因');return false;
  }
  this.update(t,{state:'ready'});this.store.log('话题会话',`${b.name}：已在 ${m.name} 启动 ${t.agentName}`);return true;
 }
 // The binding's workspace is created on first use and again after it was closed in Herdr; its root tab serves the topic that created it.
 // Herdr reuses workspace ids after a server restart, so the stored id counts only while the workspace still carries the binding's label.
 // Runs in the binding's queue so that topics opened together create the workspace once.
 async openTab(m,b,t){
  // Herdr falls back to the home directory for a --cwd that does not exist. Created for every tab: it may have been removed since the workspace was.
  await this.makeDirectory(m,b.cwd);
  const {workspaces}=await this.herdr(m,['workspace','list']);
  if(workspaces.some(w=>w.workspace_id===b.workspaceId&&w.label===workspaceLabel(b))){
   const r=await this.herdr(m,['tab','create','--workspace',b.workspaceId,'--cwd',{path:b.cwd},'--label',t.title,...remoteAnswers,'--no-focus']);
   return {workspaceId:b.workspaceId,tabId:r.tab.tab_id,paneId:r.root_pane.pane_id};
  }
  const r=await this.herdr(m,['workspace','create','--cwd',{path:b.cwd},'--label',workspaceLabel(b),...remoteAnswers,'--no-focus']);
  await this.herdr(m,['tab','rename',r.tab.tab_id,t.title]);
  b.workspaceId=r.workspace.workspace_id;return {workspaceId:b.workspaceId,tabId:r.tab.tab_id,paneId:r.root_pane.pane_id};
 }
 // Takes an agent list of machine m after each refresh. The agent of a ready topic reports reply_seq, the seq of its latest reply
 // (missing in Herdr versions without replies), state_change_seq, which grows with every status change, and request_ids. In the topic's
 // queue, so that they never overlap with prompts: new replies are fetched and then the reactions of ended turns removed (a failed fetch
 // keeps the reactions for the next list); the cards follow the requests (see cards); and a blocked agent gets its notice (see blocked).
 // Never rejects; resolves when the work it queued is done.
 sync(m,agents){
  return Promise.all(this.store.data.topics.filter(t=>t.machineId===m.id&&t.state==='ready').map(t=>{
   const agent=agents.find(x=>x.pane_id===t.paneId&&x.name===t.agentName),seq=agent?.reply_seq,fetch=seq!=null&&seq!==(t.replySeq||0);
   const ids=requestIds(agent),cards=this.gone(t,ids).length>0||this.fresh(t,ids).length>0,blocked=this.blocked(t,agent,ids);
   if(!fetch&&!ended(t,agent).length&&!cards&&blocked==null)return;
   return enqueue(this.topicQueues,t.id,async()=>{
    try{if(fetch)await this.pull(m,t,seq);for(const r of ended(t,agent))await this.dropReaction(t,r);}
    catch(e){this.store.log('回复转发',`${t.agentName}：${brief(e)}`,'error');}
    if(cards)await this.cards(m,t,ids);
    if(blocked!=null&&t.state==='ready'&&t.blockedSeq!==blocked){this.update(t,{blockedSeq:blocked});await this.notify(this.app(t.appId),t,'Agent 正在等待终端里的操作，请到 Herdr 中处理');}
   }).catch(e=>this.store.log('话题通知',`${t.agentName}：${brief(e)}`,'error'));
  }));
 }
 // A blocked agent without requests waits on something that Feishu cannot answer, such as a Codex question or a trust prompt. Resolves to
 // the state_change_seq of such a blocked episode once two lists in a row report it and no notice covers it yet, else to nothing.
 blocked(t,agent,ids){
  const seq=agent?.agent_status==='blocked'&&!ids.length?agent.state_change_seq:undefined,previous=this.blockedSeen.get(t.id);
  if(seq==null){this.blockedSeen.delete(t.id);return;}
  this.blockedSeen.set(t.id,seq);return previous===seq&&t.blockedSeq!==seq?seq:undefined;
 }
 // Records of requests that are no longer in ids, except those being answered from Feishu (see click); and ids without a record.
 gone(t,ids){return (t.cards||[]).filter(c=>!ids.includes(c.requestId)&&!this.answering.has(t.id+' '+c.requestId));}
 fresh(t,ids){return ids.filter(id=>!(t.cards||[]).some(c=>c.requestId===id));}
 // Brings the cards of topic t in line with ids, the requests its agent waits on in the list: the card of a request that is gone shows
 // 已失效, and a new request gets a card in the thread. Only requests of the list get one: an older list that is queued after this one then
 // cannot find a card of a request it has not seen. Never rejects.
 async cards(m,t,ids){
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
 async dropCard(a,t,c,card=expired(c.title)){
  this.update(t,{cards:(t.cards||[]).filter(x=>x!==c)});
  try{await this.updateCard(a,c.messageId,card);}catch(e){this.store.log('请求卡片',`${t.agentName}：请求 #${c.requestId} 的卡片未能更新，${brief(e)}`,'error');}
 }
 // A click on a request card by someone on the app's allowlist (see Platforms), which waits for the returned callback response: Feishu
 // gives it a few seconds, and Herdr over SSH can take longer. The answer goes to Herdr afterwards and outside the topic queue, where a
 // message may be starting the agent for a minute; the card then shows how it ended.
 click(a,evt){
  const v=evt.action?.value||{},t=this.store.data.topics.find(x=>x.appId===a.id&&x.cards?.some(c=>c.messageId===evt.messageId)),c=t?.cards.find(x=>x.messageId===evt.messageId&&x.requestId===v.request);
  if(!c)return toast('info','这个请求已结束');
  const key=t.id+' '+c.requestId;if(this.answering.has(key))return toast('info','正在提交，请稍候');
  const complete=v.decision!=null||answered(v.questions,evt.action.formValue);
  this.answering.set(key,this.settle(a,t,c,evt,complete).finally(()=>this.answering.delete(key)));
  return t.state!=='ready'?toast('info','这个请求已结束'):complete?toast('info','正在提交'):toast('warning','请回答所有问题');
 }
 // Answers record c from a click, or draws its card again when a question is left unanswered. The request is read from Herdr first:
 // the card must still show it, and the record keeps only its title. Never rejects.
 async settle(a,t,c,{operator,action},complete){
  try{
   if(t.state!=='ready')return await this.dropCard(a,t,c);
   const m=this.target(t),{requests}=await this.herdr(m,['agent','requests',t.paneId]),r=requests.find(x=>x.id===c.requestId);
   if(!r||check(r)!==action.value.check)return await this.dropCard(a,t,c);
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
 // Sends the agent's replies after t.replySeq, up to seq from the agent list, into the thread.
 async pull(m,t,seq){
  const last=t.replySeq||0,b=this.store.data.bindings.find(x=>x.id===t.bindingId);
  // Checked again in the queue: an earlier sync of the same list may have sent them, a message may have closed the topic or the binding is gone.
  if(!b||t.state!=='ready'||seq===last)return;
  // A seq below the stored one means Herdr restarted or handed off and counts from 1 again: take its replies up to seq.
  const a=this.app(t.appId),reset=seq<last,{replies}=await this.herdr(m,['agent','replies',t.paneId,...reset?[]:['--after',String(last)]]);
  for(const r of replies)if(!reset||r.seq<=seq){
   // At most once, like messages: the seq is on disk before the send, and a failed send is not repeated.
   this.update(t,{replySeq:r.seq});
   try{await this.reply(a,t.chatId,t.rootId,{markdown:r.truncated?r.text+'\n\n（回复过长，已截断，完整内容请在 Herdr 中查看）':r.text});this.store.log('回复转发',`${b.name}：已转发 ${t.agentName} 的回复`);}
   catch(e){this.store.log('回复转发',`${b.name}：${t.agentName} 的回复未发出，${brief(e)}`,'error');}
  }
 }
 // Resolves to the record kept in t.reactions, or to null when Feishu refused the reaction; delivery goes on either way.
 async addReaction(a,t,messageId){
  try{const r={messageId,reactionId:await this.react(a,messageId,reaction),stateSeq:null};this.update(t,{reactions:[...t.reactions||[],r]});return r;}
  catch(e){this.store.log('消息表情',`${t.agentName}：未能贴上表情，${brief(e)}`,'error');return null;}
 }
 // At most once: the record is dropped before Feishu is called, and a failed removal is only logged.
 async dropReaction(t,r){
  if(!t.reactions?.includes(r))return;this.update(t,{reactions:t.reactions.filter(x=>x!==r)});
  try{await this.unreact(this.app(t.appId),r.messageId,r.reactionId);}catch(e){this.store.log('消息表情',`${t.agentName}：未能取消表情，${brief(e)}`,'error');}
 }
 target(t){const m=this.machine(t.machineId);if(!m.enabled)throw Error('机器连接已停用');return m;}
 update(t,fields){Object.assign(t,fields);this.store.save();}
 async notify(a,t,text){try{await this.reply(a,t.chatId,t.rootId,{text});}catch(e){this.store.log('话题通知',`${a.name}：${brief(e)}`,'error');}}
}
