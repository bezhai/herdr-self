import {uuid,publicText} from './core.mjs';
// One Feishu topic = one Herdr agent session in its own tab of the binding's workspace. Everything goes through the Herdr CLI.
const workspaceLabel=b=>'飞书 · '+b.name;
const brief=e=>publicText(e.message).split('\n')[0].slice(0,200);
// Keyed queues: tasks with the same key run one after another; a failed task does not block the next one.
function enqueue(queues,key,task){
 const run=(queues.get(key)||Promise.resolve()).then(task),tail=run.catch(()=>{});
 queues.set(key,tail);tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});return run;
}
export class Topics{
 // herdr(m,args,{timeoutMs}) runs a Herdr CLI command; machine(id) returns a machine; reply(app,chatId,rootId,text) answers in the topic thread.
 constructor(store,{herdr,machine,reply}){
  this.store=store;this.herdr=herdr;this.machine=machine;this.reply=reply;this.topicQueues=new Map();this.workspaceQueues=new Map();
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
    title:[...text.replace(/\s+/g,' ')].slice(0,24).join(''),state:'starting',error:'',messageIds:[],createdAt:Date.now()};
   this.store.data.topics.push(t);
  }
  // At most once: the id is on disk before Herdr is called, and a message seen before is dropped.
  t.messageIds=[...t.messageIds,msg.messageId].slice(-50);this.store.save();
  await enqueue(this.topicQueues,t.id,()=>this.forward(a,b,t,text)).catch(e=>this.store.log('消息投递',`${a.name} → ${b.name}：${brief(e)}`,'error'));
 }
 // Sends the message to the topic's agent, opening the topic first when it is new or failed.
 async forward(a,b,t,text){
  if(t.state==='closed')return;
  if(t.state==='ready'){
   const {agents}=await this.herdr(this.target(t),['agent','list']);
   if(!agents.some(x=>x.pane_id===t.paneId&&x.name===t.agentName)){this.update(t,{state:'closed'});return this.notify(a,t,'该话题的会话已结束，请发起新话题');}
  }else if(!await this.open(a,b,t))return;
  try{await this.herdr(this.target(t),['agent','prompt',t.paneId,text]);}
  catch(e){if(e.code!=='agent_blocked')throw e;return this.notify(a,t,'Agent 正在等待确认，请到 Herdr 中处理后重发这条消息');}
  this.store.log('消息投递',`${a.name} → ${b.name}：已发送到 ${t.agentName}`);
 }
 // Opens a tab for the topic and starts its agent. Returns false when that failed; the topic is then failed and notified.
 async open(a,b,t){
  this.update(t,{state:'starting',error:''});let m;
  try{
   m=this.target(t);
   Object.assign(t,await enqueue(this.workspaceQueues,b.id,()=>this.openTab(m,b,t)));this.store.save();
   try{await this.herdr(m,['agent','start',t.agentName,'--kind',b.kind,'--pane',t.paneId,'--timeout','60000'],{timeoutMs:70000});}
   // The agent exists but waits for a confirmation such as a trust prompt; prompts then report agent_blocked.
   catch(e){if(e.code!=='agent_not_ready')throw e;}
  }catch(e){
   this.update(t,{state:'failed',error:brief(e)});this.store.log('话题会话',`${b.name}：启动失败，${t.error}`,'error');
   // Details can hold local paths and raw Herdr errors; they stay in the topic and the log.
   await this.notify(a,t,'启动失败，请在 Bridge 管理台查看原因');return false;
  }
  this.update(t,{state:'ready'});this.store.log('话题会话',`${b.name}：已在 ${m.name} 启动 ${t.agentName}`);
  await this.notify(a,t,`已在 ${m.name} 的 Herdr 中启动 ${b.kind}：${workspaceLabel(b)} / ${t.title}`);return true;
 }
 // The binding's workspace is created on first use and again after it was closed in Herdr; its root tab serves the topic that created it.
 // Herdr reuses workspace ids after a server restart, so the stored id counts only while the workspace still carries the binding's label.
 // Runs in the binding's queue so that topics opened together create the workspace once.
 async openTab(m,b,t){
  const {workspaces}=await this.herdr(m,['workspace','list']);
  if(workspaces.some(w=>w.workspace_id===b.workspaceId&&w.label===workspaceLabel(b))){
   const r=await this.herdr(m,['tab','create','--workspace',b.workspaceId,'--cwd',{path:b.cwd},'--label',t.title,'--no-focus']);
   return {workspaceId:b.workspaceId,tabId:r.tab.tab_id,paneId:r.root_pane.pane_id};
  }
  const r=await this.herdr(m,['workspace','create','--cwd',{path:b.cwd},'--label',workspaceLabel(b),'--no-focus']);
  await this.herdr(m,['tab','rename',r.tab.tab_id,t.title]);
  b.workspaceId=r.workspace.workspace_id;return {workspaceId:b.workspaceId,tabId:r.tab.tab_id,paneId:r.root_pane.pane_id};
 }
 target(t){const m=this.machine(t.machineId);if(!m.enabled)throw Error('机器连接已停用');return m;}
 update(t,fields){Object.assign(t,fields);this.store.save();}
 async notify(a,t,text){try{await this.reply(a,t.chatId,t.rootId,text);}catch(e){this.store.log('话题通知',`${a.name}：${brief(e)}`,'error');}}
}
