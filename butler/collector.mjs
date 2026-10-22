// The long-running collector: checks open-lark offers what butler needs, records pushed messages at once, and runs
// reconciliation one cycle at a time on startup, whenever the event socket (re)connects, when open-lark's sync returns
// to live, and periodically.
import {OpenLark,REQUIRED_ROUTES,isHealthy} from './open-lark.mjs';
import {EventStream} from './events.mjs';
import {Recorder} from './recorder.mjs';
import {Reconciler} from './reconcile.mjs';

export const DEFAULTS={cycleMs:60_000,threadFeedEveryMs:600_000,mentionsEveryMs:600_000,slackMs:900_000,mentionOverlapMs:600_000,
 reconnectMinMs:1000,reconnectMaxMs:30_000,connectTimeoutMs:30_000,startupRetryMs:60_000,heartbeatMs:5000,requestGapMs:100,threadFetchDelayMs:1000,
 maxChatsPerCycle:50,chatPages:5,readAttempts:5,maxThreadsPerCycle:30,threadAttempts:10};
const message=e=>e?.message??String(e);

export class Collector{
 #tail=Promise.resolve();#queued;#timers=[];#wake;#followUp;#work={threads:new Set(),chats:new Set()};
 // log: where connection changes go (the service's journal); errors go to the store, which logs them too.
 constructor({store,url,token,options={},log=()=>{}}){
  this.store=store;this.options={...DEFAULTS,...options};this.connected=false;this.stopped=true;this.log=log;
  this.openLark=new OpenLark({url,token,gapMs:this.options.requestGapMs});
  this.events=new EventStream({url:this.openLark.eventsUrl,token,minDelayMs:this.options.reconnectMinMs,maxDelayMs:this.options.reconnectMaxMs,connectTimeoutMs:this.options.connectTimeoutMs,
   onEvent:e=>this.#onEvent(e),onOpen:()=>this.#onOpen(),onClose:c=>this.#onClose(c)});
  this.eventState={connected:false};
 }
 // Resolves once open-lark has passed the startup checks and collection runs; until then it retries them.
 async start(){
  this.stopped=false;this.startedAt=Date.now();this.flushStatus();
  while(!this.stopped){
   try{await this.#check();break;}
   catch(e){this.store.addError('启动',message(e));await new Promise(r=>{this.#wake=r;setTimeout(r,this.options.startupRetryMs);});}
  }
  if(this.stopped)return;
  let collectedSince=this.store.meta('collectedSince');
  if(collectedSince===undefined){collectedSince=Date.now();this.store.setMeta('collectedSince',collectedSince);}
  this.recorder=new Recorder(this.store,{me:this.me,collectedSince});
  this.reconciler=new Reconciler({store:this.store,openLark:this.openLark,recorder:this.recorder,collectedSince,options:this.options});
  this.reconcile('startup');this.events.start();
  this.#timers.push(setInterval(()=>this.reconcile('periodic'),this.options.cycleMs),setInterval(()=>this.flushStatus(),this.options.heartbeatMs));
 }
 async #check(){
  const routes=new Set((await this.openLark.routes()).map(r=>`${r.method} ${r.path}`)),missing=REQUIRED_ROUTES.filter(r=>!routes.has(r));
  if(missing.length)throw Error(`open-lark 缺少所需路由：${missing.join('、')}`);
  const me=await this.openLark.me();if(!me?.userId)throw Error('open-lark 还没有同步出当前账号');
  this.me=me.userId;
 }
 async stop(){
  if(this.stopped&&!this.#timers.length)return;
  this.stopped=true;this.#wake?.();for(const t of this.#timers)clearInterval(t);this.#timers=[];clearTimeout(this.#followUp);
  this.events.stop();this.connected=false;this.eventState.connected=false;
  await this.idle();this.flushStatus({stoppedAt:Date.now()});
 }
 // Queues a reconciliation cycle; triggers that arrive while one is waiting to run join it.
 reconcile(reason){
  if(this.#queued){this.#queued.reasons.push(reason);return this.#queued.done;}
  const entry={reasons:[reason]};
  entry.done=this.#tail.then(async()=>{
   if(this.#queued===entry)this.#queued=undefined;
   if(this.stopped||!this.reconciler)return undefined;
   try{return await this.reconciler.cycle(entry.reasons);}catch(e){this.store.addError('对账',message(e));return undefined;}
  });
  this.#queued=entry;this.#tail=entry.done;return entry.done;
 }
 #serial(fn){const done=this.#tail.then(()=>this.stopped?undefined:fn()).catch(e=>this.store.addError('推送',message(e)));this.#tail=done;return done;}
 async idle(){let t;do{t=this.#tail;await t;}while(t!==this.#tail);}
 flushStatus(extra={}){
  this.store.setMeta('collector',{pid:process.pid,startedAt:this.startedAt,heartbeatAt:Date.now(),...extra});
  this.store.setMeta('events',{...this.eventState,connected:this.connected});
 }

 #onOpen(){
  this.connected=true;this.eventState={...this.eventState,connected:true,connectedAt:Date.now(),lastError:undefined};this.flushStatus();this.log('推送已连接');
  // After the socket is up, so that nothing falls between what reconciliation reads and the first event.
  this.reconcile('events-connected');
 }
 #onClose({opened}){
  const was=this.connected;this.connected=false;
  this.eventState={...this.eventState,connected:false,...(was?{disconnectedAt:Date.now()}:{}),...(opened?{}:{lastError:'推送连接失败：检查 token 和 open-lark 是否在运行'})};
  if(this.stopped)return;
  this.flushStatus();if(was)this.log('推送断开，稍后重连');
 }
 #onEvent(e){
  this.eventState.lastEventAt=Date.now();
  if(!this.recorder||this.stopped)return;
  switch(e.type){
   case 'message.upserted':
    // open-lark finished hydrating a chat in the background: messages were written without events.
    if(e.messageId==='sync:complete'){this.store.markDirty(e.feedId);return;}
    if(e.message)this.#record([e.message]);else this.#fetch(e.messageId);
    return;
   case 'message.recalled':
    // The flag at once; then the record follows open-lark's view of the recalled message (content only if it kept it).
    if(!this.store.hasMessage(e.messageId))return;
    this.store.markRecalled(e.messageId);this.#fetch(e.messageId);return;
   case 'sync.upstream':{
    const was=this.store.meta('sync');this.store.setMeta('sync',{state:e.state,mode:e.mode,checkedAt:Date.now()});
    if(isHealthy(e)&&!isHealthy(was))this.reconcile('sync-live');
    return;
   }
   default:return;
  }
 }
 #fetch(id){this.openLark.message(id).then(v=>{if(!this.stopped)this.#record([v]);},err=>{if(!this.stopped&&err.status!==404)this.store.addError('推送',`${id}：${message(err)}`);});}
 #record(views){
  let created;try{created=this.recorder.record(views);}catch(e){this.store.addError('推送',message(e));return;}
  // Work these messages created (a thread newly marked for fetching, a chat butler cannot name yet) is done shortly, in
  // turn with cycles. Work left over from before, such as a thread whose fetch failed, waits for the cycles: every
  // event would otherwise retry it, and each retry can make open-lark call Lark.
  for(const id of created.staleThreads)this.#work.threads.add(id);
  for(const id of created.newChats)this.#work.chats.add(id);
  if(this.#followUp||!(this.#work.threads.size||this.#work.chats.size))return;
  this.#followUp=setTimeout(()=>{
   this.#followUp=undefined;const threads=[...this.#work.threads],chats=[...this.#work.chats];this.#work.threads.clear();this.#work.chats.clear();
   this.#serial(async()=>{await this.reconciler.fetchThreads(threads);await this.reconciler.fillChatInfo(chats);});
  },this.options.threadFetchDelayMs);
 }
}
