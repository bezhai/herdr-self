#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// butler's command line: runs the collector and the processor (with the bot), shows their status, what they collected,
// the matters made of it and 关于TA, keeps the watched-group and ignored-sender lists, and creates the bot's Feishu
// app.
import {parseArgs} from 'node:util';
import {loadConfig,saveConfig,requireToken,requireModel,storeFile} from './config.mjs';
import {OpenLark} from './open-lark.mjs';
import {CATEGORIES} from './rules.mjs';
import {Matters} from './matters.mjs';
import {Processor,DEFAULTS as PROCESSOR} from './processor.mjs';
import {HerdrModel} from './herdr-model.mjs';
import {ModelQueue} from './model-queue.mjs';
import {find} from './lookup.mjs';
import {Conversation} from './conversation.mjs';
import {Digests,digestStatus,endReason} from './digest.mjs';

// node:sqlite is still flagged experimental and warns on load; that warning says nothing to a butler user. Installed
// before the store is imported (hence the dynamic imports); every other warning is printed as usual.
process.removeAllListeners('warning');
process.on('warning',w=>{if(!(w.name==='ExperimentalWarning'&&/SQLite/.test(w.message)))console.error(`${w.name}: ${w.message}`);});
const {Store}=await import('./store.mjs');
const {Collector,DEFAULTS}=await import('./collector.mjs');
// The Feishu SDK takes most of the command line's start-up time; only the commands that use it load it.
const feishu=async()=>({...await import('./bot.mjs'),...await import('./bot-app.mjs')});

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
  process [--once]                 运行加工端（常驻）：每 10 分钟把新消息交给模型整理成事项，每天根据我发的消息
                                   写一次「关于TA」，每 3 小时把未结束的事项交给模型整理一遍；配置了机器人时也
                                   运行机器人：定时汇总、私聊对话；--once 只运行一轮（处理完积压，到了时间也写
                                   「关于TA」、整理事项）就退出，不运行机器人
  matters [--all] [--json]         未结束的事项，紧急的在前；--all 连同已结束的
  profile [--json]                 「关于TA」（管家归纳的我的工作：哪些事归我）和我在私聊里让管家记下的说明
  ignore list                      忽略名单：这些发送方的消息不交给模型
  ignore add <发送方名称或 id>...    加入忽略名单
  ignore remove <发送方名称或 id>... 移出忽略名单
  bot create [--name 名称]          通过飞书的官方流程创建管家机器人的应用，凭证写进配置文件

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
 const v=s.review;
 lines.push(`整理：${v.at?`上次 ${time(v.at)}（${v.reviewed} 个未结束的事项，关掉 ${v.closed} 个）`:'还没有整理过'}${v.failedAt?`；${time(v.failedAt)} 没有完成，下一轮再试：${v.error}`
  :v.at?`，下一次在 ${time(v.at+v.everyMs)} 之后`:'，加工端的下一轮就整理'}`);
 const a=s.profile;
 lines.push(`关于TA：${a.at?`写于 ${time(a.at)}（${a.text.length} 字，${about(a)}）`:'还没有写过'}${a.failedAt?`；${time(a.failedAt)} 没有写成，下一轮再试：${a.error}`
  :a.at?`，下一次在 ${time(a.at+a.everyMs)} 之后，说明有变化时也重写`:'，加工端的下一轮就写'}`);
 const b=s.bot,processing=p.heartbeatAt&&!p.stoppedAt&&Date.now()-p.heartbeatAt<3*PROCESSOR.heartbeatMs;
 lines.push(!b.configured?'机器人：没有配置（butler bot create 创建它的飞书应用）':!processing?'机器人：未运行（加工端未运行）'
  :b.state==='connected'?`机器人：已连接（连接于 ${time(b.connectedAt)}）`:b.state==='reconnecting'?`机器人：正在重连（上次连接于 ${time(b.connectedAt)}）`
  :b.state==='error'?`机器人：连接失败，正在重试（${b.error}）`:b.state==='connecting'?'机器人：正在连接':`机器人：${b.state??'未知'}`);
 const d=s.digest;
 lines.push(`汇总：${d.at?`上次 ${time(d.at)}，共发出 ${d.sent} 份`:'还没有发过'}${d.failedAt?`；${time(d.failedAt)} 发送失败`:''}；下一份：${d.next
  ?`${time(d.next)}（新事项 ${d.fresh} 个，结束 ${d.ended} 个）`:'暂无（上次以来没有新的或结束的事项）'}`);
 lines.push(`存储：${s.file}（${size(s.sizeBytes)}）`);
 lines.push(s.errors.length?'最近的错误：':'最近的错误：无');
 for(const err of s.errors)lines.push(`  ${time(err.at)}  ${err.source}：${err.message}`);
 console.log(lines.join('\n'));
}

// What 关于TA was written from.
const about=p=>`根据 ${p.messages} 条我发的消息和 ${p.notes?.length??0} 条说明`;
function printProfile(profile,notes){
 console.log(profile?.at?`关于TA（写于 ${time(profile.at)}，${about(profile)}）：\n${profile.text}`:'还没有写过「关于TA」：加工端运行时会根据我发过的消息写出来');
 console.log(notes.length?`\n说明（${notes.length} 条，在私聊里对管家说可以增删）：\n${notes.map(n=>`#${n.id} ${n.text}（${time(n.at)}）`).join('\n')}`
  :'\n还没有说明。在私聊里告诉管家哪些事不归我管（比如「审批不归我管」），它会记成说明');
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
const GROUPS={key:'feedId',noun:'群',missing:'butler groups 可以列出我所在的群',line:g=>`  ${g.name}（${g.memberCount??'?'} 人）  ${g.feedId}`};
const SENDERS={key:'senderId',noun:'发送方',missing:'只能忽略存储里发过消息的发送方',line:s=>`  ${s.name}（${s.type??'?'}，${s.messages??'?'} 条消息）  ${s.senderId}`};
function pick(items,query,{key,noun,missing,line}=GROUPS){
 const found=find(items,query,key);
 if(found.length===1)return found[0];
 if(!found.length)throw new UsageError(`没有找到${noun}：${query}（${missing}）`);
 throw new UsageError(`“${query}”对应多个${noun}，请用完整名称或 id：\n${found.map(line).join('\n')}`);
}

const URGENCY={high:'紧急',normal:'一般',low:'不急'};
function printMatters(list,all){
 if(!list.length){console.log(all?'还没有事项':'没有未结束的事项');return;}
 for(const m of list){
  const state=m.status==='open'?'未结束':`已结束：${endReason(m)}（${time(m.closedAt)}）`;
  console.log(`#${m.id} [${URGENCY[m.urgency]??m.urgency}] ${m.title}\n  ${m.who}：${m.ask}${m.due?`（期限：${m.due}）`:''}\n  ${state} · ${m.messageIds.length} 条消息 · ${m.chats.join('、')} · ${time(m.since)} 起\n  ${m.link??''}`);
 }
}

async function main(argv){
 process.umask(0o077);
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{config:{type:'string'},json:{type:'boolean'},once:{type:'boolean'},all:{type:'boolean'},category:{type:'string'},
  since:{type:'string'},until:{type:'string'},limit:{type:'string'},search:{type:'string'},name:{type:'string'},help:{type:'boolean',short:'h'}}});
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
 if(command==='bot')return botCommand(config,rest,values);
 const store=new Store(storeFile(config),{linkBase:config.linkBase}),matters=new Matters(store);
 try{
  switch(command){
   case 'status':{
    const s={...store.status(),processing:{...store.meta('processor'),pending:matters.pendingCount(),skipped:matters.skippedCount(),openMatters:matters.list().length},
     review:{...store.meta('review'),everyMs:config.reviewEveryMs??PROCESSOR.reviewEveryMs},profile:{...store.meta('profile'),everyMs:config.profileEveryMs??PROCESSOR.profileEveryMs},
     bot:{configured:Boolean(config.bot),...store.meta('bot')},digest:digestStatus({store,matters,schedule:config.schedule})};
    if(values.json)console.log(JSON.stringify(s,null,1));else printStatus(s);return 0;
   }
   case 'matters':{const list=matters.list({all:values.all});if(values.json)console.log(JSON.stringify(list,null,1));else printMatters(list,values.all);return 0;}
   case 'profile':{
    const profile=store.meta('profile')??null,notes=matters.notes();
    if(values.json)console.log(JSON.stringify({profile,notes},null,1));else printProfile(profile,notes);return 0;
   }
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
    const watched=new Set(store.watches().map(w=>w.feedId)),groups=values.search?find(store.groups(),values.search,'feedId'):store.groups();
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
     if(queries.some(q=>find(store.groups(),q,'feedId').length!==1))await refreshGroups(store,openLark());
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

// The processor, as a service or (once) for one round: the backlog, and 关于TA and the review of the open matters when
// they are due, as a round of the service would. As a service it also runs the bot, when one is configured: digests
// and the conversation, whose turns share the model with the batches and reviews (see model-queue.mjs).
async function processCommand(config,once){
 const machine=requireModel(config),store=new Store(storeFile(config),{linkBase:config.linkBase,log:m=>console.error(m)}),matters=new Matters(store);
 const model=new ModelQueue(new HerdrModel({machine,cwd:config.modelCwd,command:[config.herdr],log:m=>console.error(m)}));
 const options={...config.reviewEveryMs&&{reviewEveryMs:config.reviewEveryMs},...config.profileEveryMs&&{profileEveryMs:config.profileEveryMs}};
 const processor=new Processor({store,matters,model,options,log:m=>console.log(m)});
 if(once){
  try{
   await processor.start({periodic:false});const r=await processor.runOnce();await processor.stop();
   const p=r.profile,profiled=!p?'':p.error?`「关于TA」没有写成：${p.error}；`:`写了「关于TA」（${p.text.length} 字）；`;
   const v=r.review,reviewed=!v?'':v.error?`整理没有完成：${v.error}；`:`整理了 ${v.reviewed} 个未结束的事项，关掉 ${v.closed} 个；`;
   console.log(`加工完成：模型运行 ${r.runs} 次，失败 ${r.failures} 次；${profiled}${reviewed}待加工 ${matters.pendingCount()} 条，未结束的事项 ${matters.list().length} 个`);
   return r.failures||p?.error||v?.error?1:0;
  }finally{store.close();}
 }
 let bot,digests,conversation;
 if(config.bot){
  const {Bot}=await feishu();
  bot=new Bot({store,...config.bot,log:m=>console.log(m)});
  conversation=new Conversation({store,matters,model,bot});digests=new Digests({store,matters,bot,schedule:config.schedule});
  bot.onMessage=msg=>conversation.handle(msg);
 }
 // The model run under way (a batch or a turn) is waited for, bounded; a turn cut off here goes unanswered.
 const stop=async()=>{
  await Promise.race([Promise.all([processor.stop(),digests?.stop(),conversation?.idle()]),new Promise(r=>setTimeout(r,20_000))]);
  await Promise.race([bot?.stop(),new Promise(r=>setTimeout(r,5000))]);process.exit(0);
 };
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 console.log(`butler 加工端启动：模型在 herdr 机器 ${machine}，存储 ${store.file}`);
 await processor.start();
 if(bot){
  console.log(`管家机器人（${config.bot.appId}）正在连接飞书`);
  bot.start().catch(e=>store.addError('机器人',`机器人停了：${e?.message??e}`));digests.start();
 }else console.log('没有配置管家机器人（butler bot create），只做加工，不发汇总');
 return undefined;
}

// bot create: the bot's Feishu app, through Feishu's official flow; the credentials and the owner (whoever creates
// it) go into the config file.
async function botCommand(config,[action],values){
 if(action!=='create')throw new UsageError(action?`bot 没有这个操作：${action}`:'用法：butler bot create [--name 名称]');
 if(config.bot)throw new UsageError(`机器人已经配置（应用 ${config.bot.appId}）。要换一个，先从 ${config.file} 删掉 BUTLER_BOT_ 开头的几行`);
 const controller=new AbortController(),abort=()=>controller.abort();process.on('SIGINT',abort);
 try{
  const {createApp}=await feishu();
  const app=await createApp({name:values.name,signal:controller.signal,onLink:(url,expiresIn)=>console.log(
   `用飞书扫码或在浏览器里打开下面的链接，在飞书的页面上确认创建应用和它的权限（${Math.round(expiresIn/60)} 分钟内有效）：\n\n${url}\n\n等待确认……（Ctrl-C 放弃）`)});
  saveConfig(config.file,{BUTLER_BOT_APP_ID:app.appId,BUTLER_BOT_APP_SECRET:app.appSecret,BUTLER_BOT_OWNER:app.owner,BUTLER_BOT_DOMAIN:app.domain});
  console.log(`已创建应用 ${app.appId}，只听创建它的人（${app.owner}）的话；凭证已写进 ${config.file}。重启加工端（systemctl --user restart butler-processor）后机器人上线。`);
  return 0;
 }catch(e){
  if(controller.signal.aborted)throw new UsageError('已放弃创建。如果已经在飞书确认过，这个应用已经建好，可以在飞书开放平台删掉它，再重新创建');
  throw e;
 }finally{process.off('SIGINT',abort);}
}

main(process.argv.slice(2)).then(code=>{if(code!==undefined)process.exitCode=code;},e=>{
 console.error(e instanceof UsageError||e?.message?.startsWith('配置文件')?e.message:`butler：${e?.message??e}`);process.exitCode=1;
});
