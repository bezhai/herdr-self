#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// butler's command line: runs the collector and the processor, shows their status, what they collected and the
// matters made of it, and keeps the watched-group and ignored-sender lists.
import {parseArgs} from 'node:util';
import {loadConfig,requireToken,requireModel,storeFile} from './config.mjs';
import {OpenLark} from './open-lark.mjs';
import {CATEGORIES} from './rules.mjs';
import {Matters} from './matters.mjs';
import {Processor} from './processor.mjs';
import {HerdrModel} from './herdr-model.mjs';

// node:sqlite is still flagged experimental and warns on load; that warning says nothing to a butler user. Installed
// before the store is imported (hence the dynamic imports); every other warning is printed as usual.
process.removeAllListeners('warning');
process.on('warning',w=>{if(!(w.name==='ExperimentalWarning'&&/SQLite/.test(w.message)))console.error(`${w.name}: ${w.message}`);});
const {Store}=await import('./store.mjs');
const {Collector,DEFAULTS}=await import('./collector.mjs');

const HELP=`用法：butler [--config 配置文件] <命令>

  run                              运行收集器（常驻，作为用户服务运行）
  status [--json]                  收集器状态：推送、对账、open-lark 同步、各类消息数量、最近的错误
  list [--category 类别] [--since 时间] [--until 时间] [--limit 条数] [--json]
                                   按类别和时间列出收到的消息，新的在前
                                   类别：${CATEGORIES.join(' ')}；时间：ISO 时间，或 30m、2h、7d 这样的相对时间
  groups [--search 文字] [--json]   列出我所在的群（名称、人数、最近活跃），★ 是关注的群
  watch list                       关注群名单
  watch add <群名或 id>...          加入关注名单，从加入时开始收集这个群的全部消息
  watch remove <群名或 id>...       移出关注名单
  process [--once]                 运行加工端（常驻）：每 10 分钟把新消息交给模型整理成事项；--once 处理完积压就退出
  matters [--all] [--json]         未结束的事项，紧急的在前；--all 连同已结束的
  ignore list                      忽略名单：这些发送方的消息不交给模型
  ignore add <发送方名称或 id>...    加入忽略名单
  ignore remove <发送方名称或 id>... 移出忽略名单

配置文件默认是 ~/.config/butler/butler.env（也可用 BUTLER_CONFIG 指定），说明见 butler/README.md。`;

class UsageError extends Error{}
const time=ms=>ms?new Date(ms).toLocaleString('sv-SE'):'—';
const ago=ms=>{const s=Math.round((Date.now()-ms)/1000);return s<60?`${s} 秒前`:s<3600?`${Math.round(s/60)} 分钟前`:`${Math.round(s/3600)} 小时前`;};
const size=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.ceil(n/1024)} KB`;

function parseTime(value,flag){
 if(value===undefined)return undefined;
 const m=/^(\d+)([mhd])$/.exec(value);
 if(m)return Date.now()-Number(m[1])*{m:60e3,h:3600e3,d:86400e3}[m[2]];
 const t=Date.parse(value);if(Number.isNaN(t))throw new UsageError(`${flag} 的时间格式不对：${value}`);return t;
}

function printStatus(s){
 const beat=s.collector.heartbeatAt,running=beat&&!s.collector.stoppedAt&&Date.now()-beat<3*DEFAULTS.heartbeatMs;
 const lines=[];
 lines.push(running?`收集器：运行中（心跳 ${ago(beat)}，pid ${s.collector.pid}，启动于 ${time(s.collector.startedAt)}）`
  :`收集器：未运行（最后心跳 ${time(beat)}${s.collector.stoppedAt?`，停止于 ${time(s.collector.stoppedAt)}`:''}）`);
 const e=s.events;
 lines.push(!running?`推送：未知（收集器未运行；最近一次收到推送 ${time(e.lastEventAt)}）`
  :e.connected?`推送：已连接（连接于 ${time(e.connectedAt)}，最近一次收到推送 ${time(e.lastEventAt)}）`
  :`推送：未连接（${e.disconnectedAt?`断开于 ${time(e.disconnectedAt)}`:'尚未连上'}${e.lastError?`，${e.lastError}`:''}）`);
 const r=s.reconcile;
 lines.push(`对账：最近完成 ${time(r.lastFinishedAt)}${r.lastReasons?`（原因 ${r.lastReasons.join('、')}，${r.chats??0} 个聊天，${r.threads??0} 个话题，${r.lastErrors??0} 个错误）`:''}，最近成功 ${time(r.lastSuccessAt)}`);
 lines.push(`open-lark 同步：${s.sync.state?`${s.sync.state} / ${s.sync.mode}（检查于 ${time(s.sync.checkedAt)}）`:'未知'}${s.sync.state&&!(s.sync.state==='live'&&s.sync.mode==='frontier')?'，不健康：对账的水位暂停推进':''}`);
 lines.push(`@我补扫：已扫到 ${time(s.mentionsSweptUntil&&s.mentionsSweptUntil*1000)}；话题列表检查于 ${time(s.threadFeedScannedAt)}；从 ${time(s.collectedSince)} 开始收集`);
 lines.push(`消息：共 ${s.counts.total} 条 · ${CATEGORIES.map(c=>`${c} ${s.counts[c]}`).join(' · ')}；待补取的 @我 ${s.pendingMentions} 条，待取回复的话题 ${s.staleThreads} 个`);
 lines.push(`关注群：${s.watched} 个；已记下读取位置的聊天 ${s.chatsRead} 个`);
 const p=s.processing;
 lines.push(`加工：最近一轮 ${time(p.lastRoundAt)}，最近成功 ${time(p.lastSuccessAt)}${p.stoppedAt?`，已停止于 ${time(p.stoppedAt)}`:''}；待加工 ${p.pending} 条，跳过 ${p.skipped} 条（模型单独处理它们几次都给不出可用的回答），未结束的事项 ${p.openMatters} 个`);
 lines.push(`存储：${s.file}（${size(s.sizeBytes)}）`);
 lines.push(s.errors.length?'最近的错误：':'最近的错误：无');
 for(const err of s.errors)lines.push(`  ${time(err.at)}  ${err.source}：${err.message}`);
 console.log(lines.join('\n'));
}

function printRecords(records){
 if(!records.length){console.log('没有符合条件的消息');return;}
 for(const r of records){
  const flags=[r.isRecalled&&'已撤回',r.isEdited&&'已编辑',r.unreadable&&'内容不可读',r.mentionsAll&&'@所有人',r.isMine&&'我发的'].filter(Boolean);
  const text=r.text.replace(/\s+/g,' ').slice(0,200);
  console.log(`${time(r.createdAt)}  [${r.categories.join(',')}]  ${r.chatName||r.chatId} · ${r.senderName??r.senderId}：${text}${flags.length?`（${flags.join('，')}）`:''}\n  ${r.link}`);
 }
}

// Every group I am in, from open-lark's conversation list, into the store's chat table.
async function refreshGroups(store,openLark){
 let cursor;
 for(let n=0;n<50;n++){
  const page=await openLark.conversations({scope:'group',limit:100,cursor});
  for(const c of page.items??[])if(c.isGroup&&(c.feedType===undefined||c.feedType===1))store.upsertChatInfo(c);
  if(!page.hasMore||!page.nextCursor)break;cursor=page.nextCursor;
 }
}
// Items named by an exact id or name, else by a part of the name. key: the id field.
function matches(items,query,key='feedId'){
 const exact=items.filter(i=>i[key]===query||i.name===query);if(exact.length)return exact;
 const q=query.toLowerCase();return items.filter(i=>(i.name??'').toLowerCase().includes(q));
}
const GROUPS={key:'feedId',noun:'群',missing:'butler groups 可以列出我所在的群',line:g=>`  ${g.name}（${g.memberCount??'?'} 人）  ${g.feedId}`};
const SENDERS={key:'senderId',noun:'发送方',missing:'只能忽略存储里发过消息的发送方',line:s=>`  ${s.name}（${s.type??'?'}，${s.messages??'?'} 条消息）  ${s.senderId}`};
function pick(items,query,{key,noun,missing,line}=GROUPS){
 const found=matches(items,query,key);
 if(found.length===1)return found[0];
 if(!found.length)throw new UsageError(`没有找到${noun}：${query}（${missing}）`);
 throw new UsageError(`“${query}”对应多个${noun}，请用完整名称或 id：\n${found.map(line).join('\n')}`);
}

const URGENCY={high:'紧急',normal:'一般',low:'不急'};
function printMatters(list,all){
 if(!list.length){console.log(all?'还没有事项':'没有未结束的事项');return;}
 for(const m of list){
  const state=m.status==='open'?'未结束':`已结束：${m.reason}（${time(m.closedAt)}）`;
  console.log(`#${m.id} [${URGENCY[m.urgency]??m.urgency}] ${m.title}\n  ${m.who}：${m.ask}${m.due?`（期限：${m.due}）`:''}\n  ${state} · ${m.messageIds.length} 条消息 · ${m.chats.join('、')} · ${time(m.since)} 起\n  ${m.link??''}`);
 }
}

async function main(argv){
 process.umask(0o077);
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{config:{type:'string'},json:{type:'boolean'},once:{type:'boolean'},all:{type:'boolean'},category:{type:'string'},
  since:{type:'string'},until:{type:'string'},limit:{type:'string'},search:{type:'string'},help:{type:'boolean',short:'h'}}});
 const [command,...rest]=positionals;
 if(values.help||!command){console.log(HELP);return 0;}
 const config=loadConfig(values.config);
 const openLark=()=>new OpenLark({url:config.openLarkUrl,token:requireToken(config),gapMs:0});
 if(command==='run'){
  const token=requireToken(config),store=new Store(storeFile(config),{linkBase:config.linkBase,log:m=>console.error(m)});
  const collector=new Collector({store,url:config.openLarkUrl,token,log:m=>console.log(m)});
  // Every write is one SQLite transaction and cursors only move after their messages are stored, so a cycle cut off
  // here is simply done again; waiting for it is a courtesy, bounded.
  const stop=async()=>{await Promise.race([collector.stop(),new Promise(r=>setTimeout(r,5000))]);process.exit(0);};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  console.log(`butler 收集器启动：open-lark ${config.openLarkUrl}，存储 ${store.file}`);
  await collector.start();console.log('butler 收集器已开始收集');
  return undefined;
 }
 if(command==='process')return processCommand(config,values.once);
 const store=new Store(storeFile(config),{linkBase:config.linkBase}),matters=new Matters(store);
 try{
  switch(command){
   case 'status':{
    const s={...store.status(),processing:{...store.meta('processor'),pending:matters.pendingCount(),skipped:matters.skippedCount(),openMatters:matters.list().length}};
    if(values.json)console.log(JSON.stringify(s,null,1));else printStatus(s);return 0;
   }
   case 'matters':{const list=matters.list({all:values.all});if(values.json)console.log(JSON.stringify(list,null,1));else printMatters(list,values.all);return 0;}
   case 'ignore':{
    const [action,...queries]=rest;
    if(action==='list'||action===undefined){
     const list=matters.ignoredSenders();if(!list.length)console.log('忽略名单是空的（butler ignore add <发送方名称或 id>）');
     for(const s of list)console.log(`${s.name||'（无名）'}  ${s.senderId}  从 ${time(s.since)} 起忽略`);
     return 0;
    }
    if(!queries.length)throw new UsageError(`ignore ${action} 需要发送方名称或 id`);
    if(action==='add'){
     const picked=queries.map(q=>pick(matters.senders(),q,SENDERS));
     for(const s of picked){matters.ignore(s.senderId,s.name);console.log(`已忽略：${s.name}（${s.senderId}），之后它的消息不再交给模型`);}
     return 0;
    }
    if(action==='remove'){
     const picked=queries.map(q=>pick(matters.ignoredSenders(),q,{...SENDERS,missing:'butler ignore list 列出忽略名单'}));
     for(const s of picked){matters.unignore(s.senderId);console.log(`已移出忽略名单：${s.name||s.senderId}，之后的新消息照常交给模型`);}
     return 0;
    }
    throw new UsageError(`ignore 没有这个操作：${action}`);
   }
   case 'list':{
    if(values.category&&!CATEGORIES.includes(values.category))throw new UsageError(`没有这个类别：${values.category}（可选 ${CATEGORIES.join(' ')}）`);
    const limit=values.limit===undefined?50:Number(values.limit);if(!Number.isInteger(limit)||limit<1)throw new UsageError('--limit 要是正整数');
    const records=store.list({category:values.category,since:parseTime(values.since,'--since'),until:parseTime(values.until,'--until'),limit});
    if(values.json)console.log(JSON.stringify(records,null,1));else printRecords(records);return 0;
   }
   case 'groups':{
    await refreshGroups(store,openLark());
    const watched=new Set(store.watches().map(w=>w.feedId)),groups=values.search?matches(store.groups(),values.search):store.groups();
    if(values.json){console.log(JSON.stringify(groups.map(g=>({...g,watched:watched.has(g.feedId)})),null,1));return 0;}
    for(const g of groups)console.log(`${watched.has(g.feedId)?'★':' '} ${g.name}  ${g.memberCount??'?'} 人  最近活跃 ${time(g.lastActiveAt)}${g.chatMode==='topic'?'  话题群':''}  ${g.feedId}`);
    return 0;
   }
   case 'watch':{
    const [action,...queries]=rest;
    if(action==='list'||action===undefined){
     const list=store.watches();if(!list.length)console.log('关注名单是空的（butler watch add <群名或 id>）');
     for(const w of list)console.log(`${w.name??w.feedId}  ${w.memberCount??'?'} 人  从 ${time(w.since)} 开始收集  ${w.feedId}`);
     return 0;
    }
    if(!queries.length)throw new UsageError(`watch ${action} 需要群名或 id`);
    if(action==='add'){
     // The store knows the groups seen so far; anything it cannot resolve uniquely is looked up in open-lark.
     if(queries.some(q=>matches(store.groups(),q).length!==1))await refreshGroups(store,openLark());
     const picked=queries.map(q=>pick(store.groups(),q)),since=Date.now();
     for(const g of picked){
      store.watch(g.feedId,since);console.log(`已加入关注：${g.name}（${g.feedId}），从 ${time(store.watchSince(g.feedId))} 开始收集`);
      if(g.chatMode==='topic')console.log(`注意：${g.name} 是话题群。butler 不按位置读话题群（open-lark 给话题群的消息窗口不可靠），这个群只能收到推送来的消息，收集器停机或断线期间的消息补不上；其中我参与的话题和 @我 的消息不受影响。`);
     }
     return 0;
    }
    if(action==='remove'){
     const watched=store.watches().map(w=>({...w,name:w.name??''})),picked=queries.map(q=>pick(watched,q));
     for(const g of picked){store.unwatch(g.feedId);console.log(`已移出关注：${g.name||g.feedId}`);}
     return 0;
    }
    throw new UsageError(`watch 没有这个操作：${action}`);
   }
   default:throw new UsageError(`没有这个命令：${command}\n\n${HELP}`);
  }
 }finally{store.close();}
}

// The processor, as a service or (once) for the backlog only.
async function processCommand(config,once){
 const machine=requireModel(config),store=new Store(storeFile(config),{linkBase:config.linkBase,log:m=>console.error(m)}),matters=new Matters(store);
 const model=new HerdrModel({machine,cwd:config.modelCwd,command:[config.herdr],log:m=>console.error(m)});
 const processor=new Processor({store,matters,model,log:m=>console.log(m)});
 if(once){
  try{
   await processor.start({periodic:false});const r=await processor.runOnce();await processor.stop();
   console.log(`加工完成：模型运行 ${r.runs} 次，失败 ${r.failures} 次；待加工 ${matters.pendingCount()} 条，未结束的事项 ${matters.list().length} 个`);
   return r.failures?1:0;
  }finally{store.close();}
 }
 const stop=async()=>{await Promise.race([processor.stop(),new Promise(r=>setTimeout(r,20_000))]);process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 console.log(`butler 加工端启动：模型在 herdr 机器 ${machine}，存储 ${store.file}`);
 await processor.start();return undefined;
}

main(process.argv.slice(2)).then(code=>{if(code!==undefined)process.exitCode=code;},e=>{
 console.error(e instanceof UsageError||e?.message?.startsWith('配置文件')?e.message:`butler：${e?.message??e}`);process.exitCode=1;
});
