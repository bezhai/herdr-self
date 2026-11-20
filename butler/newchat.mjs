// Starting work when I join a requirement group. A group butler has never seen before (a group chat that is not in its chat
// table when the processor looks) is judged once by the model, from everything that can be read about it (see
// newchat-material.mjs) and from Bridge's projects and agent configs. A positive verdict, that it is a requirement group in
// which I do the work, becomes one card in my direct chat with the bot, with the model's reason, the project and agent
// config it chose and the first prompt (see newchat-cards.mjs). My click on 开工 adds Bridge's bot to the group as me
// through open-lark, the one write butler makes there, and has Bridge open a topic in it with that prompt; 不用 does
// nothing. What a requirement group is, whether I am the one who works on it, and what the first prompt says are all the
// model's call (see prompt.mjs newChatSystemPrompt): this gathers, asks, checks the answer and applies it.
// "Never seen" is the chat table, not what a message says: a chat that exists when this first runs is recorded as seen and
// never judged, and a long dormant group that wakes up later counts as new, which the model sees from the date of its first
// message. A group is judged once: a verdict, positive or not, is final; a judgment that fails, or that would lack a Meego
// work item it links to, is tried again on the next rounds, a few times.
import {gatherMaterial,bytedcliMeego} from './newchat-material.mjs';
import {composeNewChat,readNewChat} from './prompt.mjs';
import {proposalCard,startingCard,startedCard,failedCard,ignoredCard} from './newchat-cards.mjs';

const SCHEMA=`
CREATE TABLE IF NOT EXISTS new_chats(
 feed_id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
 judged_at INTEGER, run_id INTEGER, output TEXT, verdict TEXT, card_message_id TEXT, chosen TEXT, chosen_at INTEGER, bot_added_at INTEGER, result TEXT);
`;
// A group's status: seeded (there when butler first ran, never judged), new (to judge), no (judged, not for me), ask (judged
// positive: its card goes to me, and waits for my click), starting (开工 clicked, under way), started, ignored (不用),
// given_up (the judgment failed skipAfter times).
const message=e=>e?.message??String(e);
const one=(list,id)=>list.find(x=>x.id===id);

export class NewChats{
 #work=new Set();
 // lark: the read-only open-lark client; adder: the client that may add a bot and nothing else; bridge: see
 // bridge-client.mjs; bot: {connected, toOwner(input), updateCard(messageId, card)}; model: {name, ask({system, prompt})};
 // botId: Bridge's bot as open-lark knows it; meego(url): see newchat-material.mjs. skipAfter: how many failed judgments
 // a group gets; perRound: how many groups one round judges at most.
 constructor({store,matters,lark,adder,bridge,bot,model,botId,meego=bytedcliMeego(),now=Date.now,skipAfter=5,perRound=10}){
  Object.assign(this,{store,matters,lark,adder,bridge,bot,model,botId,meego,now,skipAfter,perRound});
  this.db=store.db;
 }
 // The table is made when it is first used, so that the dry run, which keeps nothing, leaves the store as it was.
 #tableMade=false;
 #table(){if(!this.#tableMade){this.db.exec(SCHEMA);this.#tableMade=true;}}
 #all(sql,...p){return this.db.prepare(sql).all(...p);}
 #get(sql,...p){return this.db.prepare(sql).get(...p);}
 #run(sql,...p){return this.db.prepare(sql).run(...p);}
 static #row(r){
  return r&&{feedId:r.feed_id,firstSeenAt:r.first_seen_at,status:r.status,attempts:r.attempts,error:r.error??undefined,judgedAt:r.judged_at??undefined,runId:r.run_id??undefined,
   output:r.output??undefined,verdict:r.verdict?JSON.parse(r.verdict):undefined,reason:r.verdict?JSON.parse(r.verdict).reason:undefined,cardMessageId:r.card_message_id??undefined,
   chosen:r.chosen??undefined,chosenAt:r.chosen_at??undefined,botAddedAt:r.bot_added_at??undefined,result:r.result?JSON.parse(r.result):undefined};
 }
 // What butler holds of a group it has judged or is to judge.
 row(feedId){this.#table();return NewChats.#row(this.#get('SELECT * FROM new_chats WHERE feed_id=?',feedId));}
 #set(feedId,fields){
  const keys=Object.keys(fields);
  this.#run(`UPDATE new_chats SET ${keys.map(k=>`${k}=?`).join(',')} WHERE feed_id=?`,...keys.map(k=>fields[k]===undefined?null:fields[k]),feedId);
 }

 // One round of the processor's: the first time, every group butler knows is recorded as seen; after that, the groups
 // not seen before are judged (at most perRound) and the cards of positive verdicts go out, those a send failed for or the
 // bot being offline held back too. about: 关于TA, my notes and the matters I marked as not mine (see processor.mjs aboutOf).
 // Resolves with {seeded?, judged, sent}.
 async judgeNew({about}){
  this.#table();
  const now=this.now();
  if(this.store.meta('newChats')?.seededAt===undefined){
   const groups=this.store.groups();
   this.db.exec('BEGIN IMMEDIATE');
   try{for(const g of groups)this.#run("INSERT OR IGNORE INTO new_chats(feed_id,first_seen_at,status) VALUES(?,?,'seeded')",g.feedId,now);this.store.setMeta('newChats',{seededAt:now});this.db.exec('COMMIT');}
   catch(e){this.db.exec('ROLLBACK');throw e;}
   return {seeded:groups.length,judged:0,sent:0};
  }
  for(const g of this.store.groups())this.#run("INSERT OR IGNORE INTO new_chats(feed_id,first_seen_at,status) VALUES(?,?,'new')",g.feedId,now);
  let judged=0,state;
  for(const {feed_id:feedId} of this.#all("SELECT feed_id FROM new_chats WHERE status='new' ORDER BY first_seen_at,feed_id LIMIT ?",this.perRound)){
   try{
    state??=await this.bridge.state();
    const a=await this.#assess(feedId,state,about,true);
    this.#set(feedId,{status:a.verdict.requirement&&a.verdict.mine?'ask':'no',judged_at:this.now(),run_id:a.runId,output:a.output,verdict:JSON.stringify(a.verdict),error:null});
    for(const p of a.problems)this.store.addError('新群',`${a.verdict.chat.name}：模型回复里没有采纳的部分：${p}`);
    judged+=1;
   }catch(e){
    const attempts=this.#get('SELECT attempts FROM new_chats WHERE feed_id=?',feedId).attempts+1,given=attempts>=this.skipAfter;
    this.#set(feedId,{attempts,error:message(e),...given&&{status:'given_up'}});
    this.store.addError('新群',`没有判断完群 ${this.store.chat(feedId)?.name??feedId}${given?`，试了 ${attempts} 次，不再试`:'，下一轮再试'}：${message(e)}`);
   }
  }
  return {judged,sent:await this.#sendCards()};
 }

 // The judgment of one group without keeping anything (the command line's dry run): its material, the model's verdict
 // and the card it would get (none for a verdict that is not to start work). Reads open-lark and Bridge and asks the model; writes and sends nothing, and the model run
 // is not recorded.
 async judge(feedId,{about}){
  const a=await this.#assess(feedId,await this.bridge.state(),about,false);
  const {requirement,mine}=a.verdict;
  return {material:a.material,verdict:a.verdict,card:requirement&&mine?this.#proposal(a.verdict):undefined,output:a.output,system:a.system,prompt:a.prompt};
 }
 // Gathers the material of a group, asks the model and checks the answer. record: whether the run goes in model_runs.
 // The verdict as kept: the model's fields, and what the ids it chose (or the group's binding) are called in Bridge.
 async #assess(feedId,state,about,record){
  const material=await gatherMaterial({lark:this.lark,feedId,meego:this.meego});
  // A work item's roles say who does the requirement, the evidence the verdict turns on, and a verdict is final: one that
  // could not be read fails the judgment, to be tried again, instead of the model judging without it.
  const unread=material.meego.find(x=>x.error);
  if(unread)throw Error(`Meego 工作项 ${unread.url} 读不出：${unread.error}`);
  const binding=material.openChatId?state.bindings?.find(b=>b.chatId===material.openChatId):undefined;
  const named=(list,id)=>{const x=id&&one(list,id);return x?{id:x.id,name:x.name}:null;};
  const boundTo=binding&&{project:named(state.projects,binding.defaultProjectId),agent:named(state.agentConfigs,binding.defaultAgentConfigId)};
  const {system,prompt}=composeNewChat({now:this.now(),me:this.matters.me(),material,projects:state.projects,agentConfigs:state.agentConfigs,machines:state.machines,
   bound:boundTo&&{project:boundTo.project?.name,agentConfig:boundTo.agent?.name},about});
  const read=output=>readNewChat(output,{projectIds:new Set(state.projects.map(p=>p.id)),agentConfigIds:new Set(state.agentConfigs.map(a=>a.id))});
  let output,runId,reply;
  if(record){
   reply=await this.matters.recordRun({model:this.model,kind:'newchat',messages:material.messages.length,matters:0,system,prompt,now:this.now},(text,id)=>{output=text;runId=id;return read(text);});
  }else{output=await this.model.ask({system,prompt});reply=read(output);}
  const {problems,...fields}=reply;
  const verdict={...fields,chat:{name:material.name,feedId,openChatId:material.openChatId},bound:Boolean(binding),
   project:binding?boundTo.project:named(state.projects,fields.projectId),agent:binding?boundTo.agent:named(state.agentConfigs,fields.agentConfigId)};
  return {material,verdict,output,runId,problems,system,prompt};
 }
 // Whether the work can start: the group's binding has what it needs, or the model chose a project and an agent config
 // Bridge has.
 static #fit=v=>v.bound||Boolean(v.projectId&&v.agentConfigId);
 #proposal(v){
  const fit=NewChats.#fit(v);
  return proposalCard({chat:v.chat,verdict:v,project:fit?v.project?.name??'沿用群的绑定':undefined,agent:fit?v.agent?.name??'沿用群的绑定':undefined,at:this.now()});
 }

 // The card of every positive verdict that has none yet, while the bot is connected. A send that fails is recorded and
 // tried again next round. Resolves with how many went out.
 async #sendCards(){
  if(!this.bot.connected)return 0;
  let sent=0;
  for(const {feed_id:feedId} of this.#all("SELECT feed_id FROM new_chats WHERE status='ask' AND card_message_id IS NULL ORDER BY judged_at,feed_id")){
   const row=this.row(feedId);
   try{
    const {messageId}=await this.bot.toOwner({card:this.#proposal(row.verdict)});
    this.#set(feedId,{card_message_id:messageId});sent+=1;
   }catch(e){this.store.addError('新群',`群 ${row.verdict.chat.name} 的卡片没有发出去，下一轮再试：${message(e)}`);}
  }
  return sent;
 }

 // A click on a button of a proposal (a CardActionEvent; the bot hands on only mine, see bot.mjs): 不用 ignores the group;
 // 开工 starts the work, which takes longer than Feishu waits for an answer (3 seconds), so the card turns into a "working"
 // one at once and the result is put on it when the work is done (see settled). Returns undefined for a click that is not
 // one of these.
 click({action}={}){
  const v=action?.value;
  if(!v||typeof v!=='object'||v.act!=='newchat'||!['start','skip'].includes(v.do))return undefined;
  this.#table();
  const row=this.row(String(v.chat)),toast=(type,content)=>({type,content});
  if(!row?.verdict)return {toast:toast('info','没有这个群的记录了')};
  const {verdict}=row,at=this.now(),fit=NewChats.#fit(verdict),names={chat:verdict.chat,project:verdict.project?.name??'沿用群的绑定',agent:verdict.agent?.name??'沿用群的绑定'};
  const answer=(t,card)=>({toast:t,card:{type:'raw',data:card}});
  if(row.status==='started')return answer(toast('info','已经开工了'),startedCard(names));
  if(row.status==='ignored')return answer(toast('info','已经忽略了这个群'),ignoredCard(names));
  if(row.status==='starting')return answer(toast('info','正在开工，稍等'),startingCard(names));
  if(row.status!=='ask')return {toast:toast('info','这个群现在没有可点的卡片')};
  if(v.do==='skip'){
   this.#set(row.feedId,{status:'ignored',chosen:'skip',chosen_at:at});
   return answer(toast('info','已忽略'),ignoredCard(names));
  }
  if(!fit)return {toast:toast('info','没有合适的项目，开不了工')};
  this.#set(row.feedId,{status:'starting',chosen:'start',chosen_at:at});
  const work=this.#start(row.feedId).finally(()=>this.#work.delete(work));this.#work.add(work);
  return answer(toast('info','开工中……'),startingCard(names));
 }
 // Resolves once every start under way is done and its card is up to date.
 async settled(){await Promise.all([...this.#work]);}

 // The work of 开工: the bot joins the group as me (unless the group is bound in Bridge, which has its bot there, the bot
 // is in the group already, or an earlier try added it), then Bridge opens the topic. The card becomes 已开工, or
 // 开工失败 with the reason and 开工 kept for another try. Never rejects.
 async #start(feedId){
  const row=this.row(feedId),v=row.verdict,names={chat:v.chat,project:v.project?.name??'沿用群的绑定',agent:v.agent?.name??'沿用群的绑定'};
  let card;
  try{
   if(!v.chat.openChatId)throw Error('open-lark 没有给出这个群的 openChatId');
   if(!v.bound&&!row.botAddedAt){
    if(!await this.#botIn(feedId)){
     try{await this.adder.addBot(feedId,this.botId);}catch(e){throw Error(`没能把 Bridge 的机器人加进群：${message(e)}`);}
    }
    this.#set(feedId,{bot_added_at:this.now()});
   }
   const result=await this.bridge.openTopic({chatId:v.chat.openChatId,prompt:v.prompt,title:v.title,...!v.bound&&{projectId:v.projectId,agentConfigId:v.agentConfigId},key:`newchat:${feedId}`});
   this.#set(feedId,{status:'started',error:null,result:JSON.stringify(result)});
   card=startedCard(names);
  }catch(e){
   this.#set(feedId,{status:'ask',error:message(e)});
   this.store.addError('新群',`群 ${v.chat.name} 开工失败：${message(e)}`);
   card=failedCard({...names,verdict:v,reason:message(e),at:this.now()});
  }
  try{await this.bot.updateCard(row.cardMessageId,card);}
  catch(e){this.store.addError('新群',`群 ${v.chat.name} 的卡片没有更新：${message(e)}`);}
 }
 // Whether Bridge's bot is in the group already, by any of the ids open-lark lists for a bot; a group whose bots cannot be
 // read counts as without it.
 async #botIn(feedId){
  try{return ((await this.lark.bots(feedId)).items??[]).some(b=>Object.values(b).includes(this.botId));}catch{return false;}
 }
}
