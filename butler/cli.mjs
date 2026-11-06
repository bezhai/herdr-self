#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// butler's command line: runs the collector and the processor (with the bot, the grading and the daily read), and is
// how the agent I talk to butler through (see cards.mjs AGENT_GROUP) works butler, over ssh: it shows the status, what
// was collected, a chat's messages, the matters made of it, the daily read's topics, 关于TA and my notes; sets chat
// levels and has the model grade chats; closes and reopens matters; keeps my notes, my corrections of the daily read
// and the ignored-sender list; and creates and updates the bot's Feishu app. Every
// command that reads prints the store's records as JSON with --json, and every one that writes prints what it changed,
// before and after, in words or with --json as JSON: the agent reads the one and tells me the other.
import {parseArgs} from 'node:util';
import {loadConfig,saveConfig,requireToken,requireModel,storeFile} from './config.mjs';
import {OpenLark} from './open-lark.mjs';
import {CATEGORIES,LEVELS,LEVEL_NAMES} from './rules.mjs';
import {Matters} from './matters.mjs';
import {Processor,DEFAULTS as PROCESSOR} from './processor.mjs';
import {HerdrModel} from './herdr-model.mjs';
import {Grader} from './grader.mjs';
import {Reader,dayOf,startOf,nextDay} from './reading.mjs';
import {Topics} from './topics.mjs';
import {find} from './lookup.mjs';
import {Digests,digestStatus,endReason} from './digest.mjs';
import {levelName,LEVEL_EFFECT,isCorrection,LevelCards} from './levels.mjs';

// node:sqlite is still flagged experimental and warns on load; that warning says nothing to a butler user. Installed
// before the store is imported (hence the dynamic imports); every other warning is printed as usual.
process.removeAllListeners('warning');
process.on('warning',w=>{if(!(w.name==='ExperimentalWarning'&&/SQLite/.test(w.message)))console.error(`${w.name}: ${w.message}`);});
const {Store}=await import('./store.mjs');
const {Collector,DEFAULTS}=await import('./collector.mjs');
// The Feishu SDK takes most of the command line's start-up time; only the commands that use it load it.
const feishu=async()=>({...await import('./bot.mjs'),...await import('./bot-app.mjs')});

const HELP=`用法：butler [--config 配置文件] <命令> [选项]

读的命令加 --json 时输出存储里的记录（JSON）；写的命令打印改了什么（原来 → 现在），加 --json 时输出每个改动的
before 和 after（没有时是 null）。时间写 ISO 时间（只写日期时是那天 0 点）或 30m、2h、7d 这样的相对时间（多久以前）；
日期写 2026-11-06 这样的本地日期。

  run                              运行收集器（常驻，作为用户服务运行）
  status [--json]                  收集器状态：推送、对账、open-lark 同步、各类消息数量，加工端、分级、每日读取和机器人，最近的错误
  list [--category 类别] [--since 时间] [--until 时间] [--limit 条数] [--json]
                                   按类别和时间列出收到的消息，新的在前，正文只显示一行
                                   类别：${CATEGORIES.join(' ')}
  messages <聊天名或 id> [--day 日期] [--since 时间] [--until 时间] [--search 文字] [--limit 条数] [--json]
                                   一个聊天的原始消息，从早到晚，正文完整，每条带链接：--day 是一整天，--search 只列正文里
                                   有这段文字的，多于 --limit 条（默认 100）时列最近的那些。还没有话题的消息（今天的、
                                   不读的聊天的）用它读；忽略名单上的发送方的消息也列出
  topics [<聊天名或 id>] [--day 日期] [--since 时间] [--until 时间] [--search 文字] [--picked | --not-picked] [--limit 条数] [--json]
                                   每日读取拆出的话题，新的日子在前：编号、日子、聊天、标题、要点、工作还是兴趣、挑没挑和
                                   理由、消息数、第一条消息的链接，有纠正时带上最新的一条。--since 和 --until 选那段时间里的
                                   日子，--search 找标题、要点和消息里的文字，--picked 只列挑出的、--not-picked 只列没挑的
                                   （纠正过的按我的纠正），默认最多 50 个。每天早上读完前一天才有话题，只读每日和即时的聊天
  corrections [list] [--json]      我对每日读取挑没挑的纠正：编号、哪个话题（或哪个聊天哪一天）、我说的、我的原话
  corrections pick <话题编号> <我的原话> [--json]
                                   这个话题该挑，按我的原话记下；模型挑没挑照旧留着，纠正另外记
  corrections unpick <话题编号> <我的原话> [--json]
                                   这个话题不该挑
  corrections missed <聊天名或 id> <日期> <我的原话> [--json]
                                   这个聊天这一天有该挑的事，却没有拆成话题（先用 topics 看没挑的话题里有没有它）
  corrections remove <编号> [--json]  删掉一条纠正（我说错了或者记错了时），话题回到上一条纠正或模型的判断
  groups [--search 文字] [--json]   列出我所在的群（级别、名称、人数、最近活跃）
  level [list] [--json]            有级别的聊天：级别、谁定的、从什么时候开始、理由
  level set <级别> <聊天名或 id>... [--reason 文字] [--json]
                                   由我定聊天的级别，模型不改我定的：instant 即时（全部消息交给模型，每天也读一遍）、
                                   daily 每日（存下，每天读一遍、挑出话题）、store 只存不看、ignore 忽略（不存）；
                                   和我有关的消息不看级别，照旧收、照旧交给模型；--reason 是我的理由，和级别一起记下
  level clear <聊天名或 id>... [--json]
                                   取消我定的级别，回到模型的判断，还没有判断时私聊按即时、群按只存不看
  level history [--since 时间] [--json]
                                   级别的改动：什么时候、哪个聊天、原来和现在的级别、谁改的、理由；默认最近 7 天
  level grade [<聊天名或 id>...] [--json]
                                   让模型现在给这些聊天分级；不写聊天时是最近 7 天有消息、级别不是我定的全部聊天。
                                   加工端也会自己分级：新的活跃聊天、每周一次、说明变了以后，以及即时的聊天消息突然变多时
  process [--once]                 运行加工端（常驻）：每 10 分钟把新消息交给模型整理成事项，每天根据我发的消息
                                   写一次「关于TA」，每 3 小时把未结束的事项交给模型整理一遍，在另一条模型通道上
                                   给活跃的聊天分级，每天早上 6 点把前一天每日和即时的聊天读一遍、拆成话题存下；
                                   配置了机器人时也运行机器人：定时汇总、分级的卡片；--once 只运行一轮（处理完积压，
                                   到了时间也写「关于TA」、整理事项）就退出，不运行机器人，不分级，不读
  matters [list] [--all] [--json]  未结束的事项，紧急的在前；--all 连同已结束的
  matters close <编号> [--reason 文字] [--json]
                                   由我关掉一个未结束的事项，和卡片上的「完成」一样记为我关掉的；--reason 是我的理由，
                                   写「不归我」时和卡片上的「不归我」一样，模型以后判断哪些事归我时会参考
  matters reopen <编号> [--json]    重新打开一个结束了的事项
  notes [list] [--json]            我的说明：我的原话，写「关于TA」、整理事项和给聊天分级时都带上，以说明为准
  notes add <文字> [--json]         按我的原话记下一条说明（比如「审批不归我管」）；同样的话记过时不再记
  notes remove <编号> [--json]      删掉一条说明
  profile [--json]                 「关于TA」（管家归纳的我的工作和兴趣）和我的说明
  ignore [list] [--json]           忽略名单：这些发送方的消息不交给模型
  ignore add <发送方名称或 id>... [--json]
                                   加入忽略名单
  ignore remove <发送方名称或 id>... [--json]
                                   移出忽略名单
  bot create [--name 名称]          通过飞书的官方流程创建管家机器人的应用，凭证写进配置文件
  bot update                       通过飞书的官方流程给已经配置的应用加上它还没有的权限和回调（卡片上的按钮要用的回调）

配置文件默认是 ~/.config/butler/butler.env（也可用 BUTLER_CONFIG 指定），说明见 butler/README.md。`;

class UsageError extends Error{}
const time=ms=>ms?new Date(ms).toLocaleString('sv-SE'):'—';
const ago=ms=>{const s=Math.round((Date.now()-ms)/1000);return s<60?`${s} 秒前`:s<3600?`${Math.round(s/60)} 分钟前`:`${Math.round(s/3600)} 小时前`;};
const size=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.ceil(n/1024)} KB`;
const json=v=>console.log(JSON.stringify(v,null,1));
// My own words, a reason or a note, as the agent passes them on: one line, never empty, and short enough to go into
// every prompt they are shown in. Cut, they would no longer be what I said, so a longer one is refused.
const WORDS=200;
function words(value,what){
 const text=String(value??'').replace(/\s+/g,' ').trim(),n=[...text].length;
 if(!n)throw new UsageError(`${what}不能是空的`);
 if(n>WORDS)throw new UsageError(`${what}最长 ${WORDS} 字，这次有 ${n} 字`);
 return text;
}
// A matter's or a note's number as I write it: 12 or #12.
function number(value,what){
 const m=/^#?(\d+)$/.exec(String(value??'').trim());
 if(!m)throw new UsageError(`${what}要写编号，比如 12 或 #12${value===undefined?'':`，不是 ${value}`}`);
 return Number(m[1]);
}

// A day as I write it, 2026-11-06, a local one (see reading.mjs dayOf).
function day(value,what){
 if(!/^\d{4}-\d\d-\d\d$/.test(value??'')||dayOf(startOf(value))!==value)throw new UsageError(`${what}要写 2026-11-06 这样的日期${value===undefined?'':`，不是 ${value}`}`);
 return value;
}
// A time as I write it: an ISO time, a date alone, which is that day's local midnight (Date.parse would take UTC's), or
// how long ago, 30m, 2h, 7d.
function parseTime(value,flag){
 if(value===undefined)return undefined;
 const m=/^(\d+)([mhd])$/.exec(value);
 if(m)return Date.now()-Number(m[1])*{m:60e3,h:3600e3,d:86400e3}[m[2]];
 if(/^\d{4}-\d\d-\d\d$/.test(value))return startOf(day(value,`${flag} `));
 const t=Date.parse(value);if(Number.isNaN(t))throw new UsageError(`${flag} 的时间格式不对：${value}`);return t;
}
// The span a read command looks at, since up to until (ms, either open): a whole day with --day, else --since and
// --until.
function span(values){
 if(values.day===undefined)return {since:parseTime(values.since,'--since'),until:parseTime(values.until,'--until')};
 if(values.since!==undefined||values.until!==undefined)throw new UsageError('--day 是一整天，不能和 --since、--until 一起用');
 const d=day(values.day,'--day ');return {since:startOf(d),until:startOf(nextDay(d))};
}
function limitOf(value,fallback){
 const n=value===undefined?fallback:Number(value);if(!Number.isInteger(n)||n<1)throw new UsageError('--limit 要是正整数');
 return n;
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
 const l=s.levels;
 lines.push(`聊天级别：${LEVELS.map(x=>`${LEVEL_NAMES[x]} ${l[x]} 个`).join('、')}（我定的 ${l.owner} 个），没有级别的私聊按即时、群按只存不看；已记下读取位置的聊天 ${s.chatsRead} 个`);
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
 const g=s.grading;
 lines.push(`分级：${g.at?`上次 ${time(g.at)}（${g.chats} 个聊天，分了 ${g.graded} 个${g.error?`，没有分完：${g.error}`:''}）`:'还没有分过'}；${
  g.due?`现在有 ${g.due} 个聊天等着分级${g.next>Date.now()?`，${time(g.next)} 之后再分`:''}`
  :g.sampledAt===undefined?`还没有只存不看的消息，收下全部消息满 ${g.sampleDays} 天以后开始分级`
  :g.sampledAt>Date.now()?`收下全部消息满 ${g.sampleDays} 天（${time(g.sampledAt)}）以后开始分级`
  :g.next?`下一次在 ${time(g.next)} 之后`:'没有要分级的活跃聊天'}；模型定了级别的聊天 ${g.byModel} 个`);
 lines.push(`每日读取：${reading(s.reading)}`);
 const d=s.digest;
 lines.push(`汇总：${d.at?`上次 ${time(d.at)}，共发出 ${d.sent} 份`:'还没有发过'}${d.failedAt?`；${time(d.failedAt)} 发送失败`:''}；下一份：${d.next
  ?`${time(d.next)}（新事项 ${d.fresh} 个，结束 ${d.ended} 个）`:'暂无（上次以来没有新的或结束的事项）'}`);
 lines.push(`存储：${s.file}（${size(s.sizeBytes)}）`);
 lines.push(s.errors.length?'最近的错误：':'最近的错误：无');
 for(const err of s.errors)lines.push(`  ${time(err.at)}  ${err.source}：${err.message}`);
 console.log(lines.join('\n'));
}

// The daily read (see reading.mjs): the last day read to the end, what comes next, and the days passed over.
function reading(rd){
 const last=rd.last,given=last?.failed??[];
 return [last?`上次读完 ${last.day}（${time(last.at)}，${last.chats} 个聊天，挑出 ${last.picked} 个话题、没挑 ${last.notPicked} 个，${last.flagged} 条消息交给批次${
   given.length?`，${given.length} 个聊天读不成、放弃了：${given.map(f=>f.name??f.feedId).join('、')}`:''}）`:'还没有读完过一天',
  rd.failedAt?`读 ${rd.failedDay} 没有完成：${rd.error}，${time(rd.retryAt)} 之后再试`:rd.from===undefined?'还没有开始收下全部消息，开始以后第一个完整的一天过完再读'
   :rd.due.length?`现在要读 ${rd.due.join('、')}`:`下一次读 ${rd.upcoming}，在 ${time(rd.next)} 之后`,
  ...rd.skipped?.length?[`停机期间没读的 ${rd.skipped.join('、')} 不补读了`]:[]].join('；');
}
// What 关于TA was written from.
const about=p=>`根据 ${p.messages} 条我发的消息和 ${p.notes?.length??0} 条说明`;
function printNotes(notes){
 console.log(notes.length?`说明（${notes.length} 条，butler notes add 和 notes remove 增删）：\n${notes.map(n=>`#${n.id} ${n.text}（${time(n.at)}）`).join('\n')}`
  :'还没有说明。哪些事归不归我管（比如「审批不归我管」），用 butler notes add 按我的原话记下');
}
function printProfile(profile,notes){
 console.log(profile?.at?`关于TA（写于 ${time(profile.at)}，${about(profile)}）：\n${profile.text}\n`:'还没有写过「关于TA」：加工端运行时会根据我发过的消息写出来\n');
 printNotes(notes);
}
// What a note does once it is added or removed: the processor and grading find it in the store.
const NOTE_EFFECT='加工端下一轮会按说明重写「关于TA」，再把未结束的事项整理一遍；说明一小时内不再变时，分级的模型重新给聊天分级';

// What a message's text does not say: recalled, edited, unreadable, @all, mine.
function marks(r){
 const flags=[r.isRecalled&&'已撤回',r.isEdited&&'已编辑',r.unreadable&&'内容不可读',r.mentionsAll&&'@所有人',r.isMine&&'我发的'].filter(Boolean);
 return flags.length?`（${flags.join('，')}）`:'';
}
function printRecords(records){
 if(!records.length){console.log('没有符合条件的消息');return;}
 for(const r of records)console.log(`${time(r.createdAt)}  [${r.categories.join(',')}]  ${r.chatName||r.chatId} · ${r.senderName??r.senderId}：${r.text.replace(/\s+/g,' ').slice(0,200)}${marks(r)}\n  ${r.link}`);
}
// A chat's messages (see Matters.chatMessages), to be read as the conversation they are: whole, oldest first.
function printMessages(chat,{since,until,search},total,records){
 const bounds=[since!==undefined&&`${time(since)} 起`,until!==undefined&&`${time(until)} 前`].filter(Boolean);
 const head=`${chat.name||chat.feedId}${bounds.length?`（${bounds.join('，')}）`:''}${search?`含「${search}」的`:'的'}消息`;
 if(!total){console.log(`${head}：没有`);return;}
 console.log(`${head}：共 ${total} 条${total>records.length?`，下面是最近的 ${records.length} 条`:''}，从早到晚：`);
 for(const r of records)console.log(`${time(r.createdAt)}  ${r.senderName??r.senderId}：${r.text.replace(/\s+/g,' ').trim()}${marks(r)}\n  ${r.link}`);
}

// The daily read's topics (see topics.mjs) and my corrections of its picks.
const AREA={work:'工作',interest:'兴趣',other:'其他'};
const SAID={pick:'该挑',unpick:'不该挑',missed:'漏挑'};
// Where a topic's pick stands: as my latest correction says, else as the model picked.
const judged=t=>t.correction?`我说${SAID[t.correction.kind]}（纠正 #${t.correction.id}）`:t.picked?'模型挑出':'模型没挑';
// A topic by its number and title; where a topic or a correction is: its chat and day.
const topicName=t=>`话题 #${t.id} ${t.title}`,place=t=>`${t.chatName??t.chatId} ${t.day}`;
function printTopics(list,total){
 if(!list.length){console.log('没有符合条件的话题。话题在每天早上读完前一天以后才有，只读每日和即时级别的聊天；今天的消息和不读的聊天，用 butler messages 读原始消息');return;}
 for(const t of list){
  const k=t.correction;
  console.log(`#${t.id} ${t.day} ${t.chatName??t.chatId}：${t.title}（${t.picked?'挑出':'没挑'} · ${AREA[t.area]??t.area}）\n  ${t.summary}\n  理由：${t.reason??'—'} · ${t.messageIds.length} 条消息${
   k?`\n  我的纠正 #${k.id}（${time(k.at)}）：${SAID[k.kind]}：${k.words}`:''}\n  ${t.link??''}`);
 }
 if(total>list.length)console.log(`共 ${total} 个话题，只列出了 ${list.length} 个：缩小范围，或者用 --limit 列出更多`);
}
// A correction: what it is about, what I said and my words.
const described=k=>`${k.topic?`${topicName(k.topic)}（${place(k.topic)}，${k.topic.picked?'模型挑出':'模型没挑'}）`:`${place(k)} `}${SAID[k.kind]}：${k.words}`;
function printCorrections(list){
 if(!list.length){console.log('还没有纠正。我说话题挑错了、漏挑了时，用 butler corrections pick、unpick 或 missed 按我的原话记下');return;}
 for(const k of list)console.log(`#${k.id} ${described(k)}（${time(k.at)}）`);
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
const CHATS={...GROUPS,noun:'聊天',line:c=>`  ${c.name||'（无名）'}（${c.chatMode==='direct'?'私聊':`${c.memberCount??'?'} 人`}）  ${c.feedId}`};
// A chat's level as the command line shows it: set by me, not by you (see levels.mjs levelName).
const levelOf=(l,chatMode)=>levelName(l,chatMode,'我');
// A chat as the JSON of a write names it.
const chatOf=c=>({feedId:c.feedId,name:c.name||null,chatMode:c.chatMode??null});
const SENDERS={key:'senderId',noun:'发送方',missing:'只能忽略存储里发过消息的发送方',line:s=>`  ${s.name}（${s.type??'?'}，${s.messages??'?'} 条消息）  ${s.senderId}`};
function pick(items,query,{key,noun,missing,line}=GROUPS){
 const found=find(items,query,key);
 if(found.length===1)return found[0];
 if(!found.length)throw new UsageError(`没有找到${noun}：${query}（${missing}）`);
 throw new UsageError(`“${query}”对应多个${noun}，请用完整名称或 id：\n${found.map(line).join('\n')}`);
}

// The model as herdr reaches it on the model machine (see herdr-model.mjs).
const herdrModel=config=>new HerdrModel({machine:requireModel(config),cwd:config.modelCwd,name:config.modelName,effort:config.modelEffort,command:[config.herdr],log:m=>console.error(m)});

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
  since:{type:'string'},until:{type:'string'},day:{type:'string'},limit:{type:'string'},search:{type:'string'},picked:{type:'boolean'},'not-picked':{type:'boolean'},
  name:{type:'string'},reason:{type:'string'},help:{type:'boolean',short:'h'}}});
 const [command,...rest]=positionals;
 if(values.help||!command){console.log(HELP);return 0;}
 // A reason given where none is kept would be lost without a word.
 if(values.reason!==undefined&&!(command==='level'&&rest[0]==='set'||command==='matters'&&rest[0]==='close'))throw new UsageError('--reason 只用于 level set 和 matters close');
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
    const grader=new Grader({store,matters});s.grading={...grader.status(),sampleDays:grader.options.sampleMs/86400e3};
    s.reading=new Reader({store,matters,topics:new Topics(store)}).status();
    if(values.json)console.log(JSON.stringify(s,null,1));else printStatus(s);return 0;
   }
   case 'matters':{
    const [action,arg]=rest;
    if(action==='list'||action===undefined){const list=matters.list({all:values.all});if(values.json)json(list);else printMatters(list,values.all);return 0;}
    if(action!=='close'&&action!=='reopen')throw new UsageError(`matters 没有这个操作：${action}`);
    // As the card's 完成 and 不归我 close it (see digest.mjs): closed by me, with my reason if I give one.
    const id=number(arg,`matters ${action} `),before=matters.matter(id),reason=values.reason===undefined?undefined:words(values.reason,'--reason ');
    if(!before)throw new UsageError(`没有 #${id} 这个事项（butler matters --all 列出全部事项）`);
    const changed=action==='close'?matters.close(id,reason):matters.reopen(id),after=matters.matter(id);
    // The latest digest is the processor's process's to update: it learns of the change from the mark.
    if(changed)matters.markChanged();
    if(values.json){json({before,after});return 0;}
    const what=`#${id} ${before.title}`;
    console.log(action==='close'?changed?`${what}：未结束 → 已结束：${endReason(after)}`:`${what}：已经结束了（${endReason(before)}），没有改动`
     :changed?`${what}：已结束：${endReason(before)} → 未结束`:`${what}：没有结束，没有改动`);
    return 0;
   }
   // My notes, my own words (see matters.mjs). What one does, the processor and grading take from the store: 关于TA is
   // written again and the open matters reviewed on the next round, and the chats graded again once the notes stand.
   case 'notes':{
    const [action,...args]=rest;
    if(action==='list'||action===undefined){const list=matters.notes();if(values.json)json(list);else printNotes(list);return 0;}
    if(action==='add'){
     const text=words(args.join(' '),'说明'),same=matters.notes().find(n=>n.text===text);
     if(same){if(values.json)json({before:same,after:same});else console.log(`已经有这条说明 #${same.id}：${same.text}，没有改动`);return 0;}
     const id=matters.addNote(text),after=matters.notes().find(n=>n.id===id);
     if(values.json)json({before:null,after});else console.log(`已记下说明 #${id}：${text}。${NOTE_EFFECT}`);
     return 0;
    }
    if(action==='remove'){
     const id=number(args[0],'notes remove '),before=matters.removeNote(id);
     if(!before)throw new UsageError(`没有说明 #${id}（butler notes 列出说明）`);
     if(values.json)json({before,after:null});else console.log(`已删除说明 #${id}：${before.text}。${NOTE_EFFECT}`);
     return 0;
    }
    throw new UsageError(`notes 没有这个操作：${action}`);
   }
   case 'profile':{
    const profile=store.meta('profile')??null,notes=matters.notes();
    if(values.json)json({profile,notes});else printProfile(profile,notes);return 0;
   }
   case 'ignore':{
    const [action,...queries]=rest,ignored=id=>matters.ignoredSenders().find(s=>s.senderId===id)??null;
    if(action==='list'||action===undefined){
     const list=matters.ignoredSenders();
     if(values.json){json(list);return 0;}
     if(!list.length)console.log('忽略名单是空的（butler ignore add <发送方名称或 id>）');
     for(const s of list)console.log(`${s.name||'（无名）'}  ${s.senderId}  从 ${time(s.since)} 起忽略`);
     return 0;
    }
    if(!queries.length)throw new UsageError(`ignore ${action} 需要发送方名称或 id`);
    // Each sender as the write names it, with its entry on the list (see Matters.ignoredSenders) before and after.
    const out=[],say=(s,before,after,text)=>{out.push({senderId:s.senderId,name:s.name,before,after});if(!values.json)console.log(`${s.name||'（无名）'}（${s.senderId}）：${text}`);};
    if(action==='add'){
     for(const s of queries.map(q=>pick(matters.senders(),q,SENDERS))){
      const before=ignored(s.senderId);
      if(before){say(s,before,before,'已经在忽略名单上，没有改动');continue;}
      matters.ignore(s.senderId,s.name);say(s,null,ignored(s.senderId),'没有忽略 → 忽略，之后它的消息不再交给模型');
     }
    }else if(action==='remove'){
     for(const s of queries.map(q=>pick(matters.ignoredSenders(),q,{...SENDERS,missing:'butler ignore list 列出忽略名单'}))){
      matters.unignore(s.senderId);say(s,s,null,'忽略 → 没有忽略，之后的新消息照常交给模型');
     }
    }else throw new UsageError(`ignore 没有这个操作：${action}`);
    if(values.json)json(out);
    return 0;
   }
   case 'list':{
    if(values.category&&!CATEGORIES.includes(values.category))throw new UsageError(`没有这个类别：${values.category}（可选 ${CATEGORIES.join(' ')}）`);
    const records=store.list({category:values.category,since:parseTime(values.since,'--since'),until:parseTime(values.until,'--until'),limit:limitOf(values.limit,50)});
    if(values.json)console.log(JSON.stringify(records,null,1));else printRecords(records);return 0;
   }
   // A chat's own messages, whole, as they were said: what has no topics (today's, a chat that is not read), or what a
   // topic leaves out. Not list: that is the newest first, by category, a line each.
   case 'messages':{
    if(rest[0]===undefined)throw new UsageError('messages 需要聊天名或 id');if(rest.length>1)throw new UsageError('messages 只能写一个聊天');
    const chat=pick(store.chats(),rest[0],CHATS),{since,until}=span(values),search=values.search||undefined;
    const {total,records}=matters.chatMessages(chat.feedId,{since,until,search,limit:limitOf(values.limit,100)});
    if(values.json)json(records);else printMessages(chat,{since,until,search},total,records);return 0;
   }
   // The daily read's topics: the days a span takes in are those that start before it ends and end after it starts.
   case 'topics':{
    if(rest.length>1)throw new UsageError('topics 只能写一个聊天');
    if(values.picked&&values['not-picked'])throw new UsageError('--picked 和 --not-picked 只能用一个');
    const topics=new Topics(store),chat=rest[0]===undefined?undefined:pick(store.chats(),rest[0],CHATS),{since,until}=span(values);
    const filter={feedId:chat?.feedId,from:since===undefined?undefined:dayOf(since),to:until===undefined?undefined:dayOf(until-1),
     picked:values.picked?true:values['not-picked']?false:undefined,search:values.search||undefined};
    const list=topics.list(filter,limitOf(values.limit,50));
    if(values.json)json(list);else printTopics(list,topics.count(filter));return 0;
   }
   // My corrections of the daily read's picks, in my own words (see Topics corrections). On a topic: before and after
   // are the topic, whose latest correction is what I say of it; on a missed topic, and removed, the correction.
   case 'corrections':{
    const [action,...args]=rest,topics=new Topics(store);
    if(action==='list'||action===undefined){const list=topics.corrections();if(values.json)json(list);else printCorrections(list);return 0;}
    if(action==='pick'||action==='unpick'){
     const id=number(args[0],`corrections ${action} 的话题`),before=topics.topic(id);
     if(!before)throw new UsageError(`没有 #${id} 这个话题（butler topics 列出话题）`);
     const text=words(args.slice(1).join(' '),'我的原话'),k=before.correction,what=`${topicName(before)}（${place(before)}）`;
     // Already as I say: in a correction in the same words, or, with none, as the model picked it.
     if(k?k.kind===action&&k.words===text:before.picked===(action==='pick')){
      if(values.json)json({before,after:before});
      else console.log(k?`${what}：已经记过同样的纠正 #${k.id}，没有改动`:`${what}：模型${before.picked?'已经挑出了它':'本来就没挑它'}，不用纠正，没有改动`);
      return 0;
     }
     topics.addCorrection({kind:action,topicId:id,words:text});const after=topics.topic(id);
     if(values.json)json({before,after});else console.log(`${what}：${judged(before)} → ${judged(after)}：${text}`);
     return 0;
    }
    if(action==='missed'){
     const [query,date,...said]=args;if(query===undefined)throw new UsageError('corrections missed 需要聊天名或 id、日期和我的原话');
     const chat=pick(store.chats(),query,CHATS),d=day(date,'corrections missed 的日期'),text=words(said.join(' '),'我的原话'),name=chat.name||chat.feedId;
     if(d>=dayOf(Date.now()))throw new UsageError(`${d} 还没有读：每天早上才读前一天，今天的话题明天才有`);
     const same=topics.corrections().find(k=>k.kind==='missed'&&k.chatId===chat.feedId&&k.day===d&&k.words===text);
     if(same){if(values.json)json({before:same,after:same});else console.log(`${name} ${d}：已经记过同样的纠正 #${same.id}，没有改动`);return 0;}
     // Recorded all the same: what I said is still what I want picked.
     const warning=topics.reading(d,chat.feedId)?undefined:`注意：每日读取没有读过 ${name} 在 ${d} 的消息（只读那天结束时级别是每日或即时的聊天），纠正照样记下；要它以后每天被读，用 butler level set daily ${name}`;
     const id=topics.addCorrection({kind:'missed',feedId:chat.feedId,day:d,words:text}),after=topics.correction(id);
     if(values.json){json({before:null,after,...warning&&{warning}});return 0;}
     console.log(`${name} ${d}：记下漏挑（纠正 #${id}）：${text}`);if(warning)console.log(warning);
     return 0;
    }
    if(action==='remove'){
     const id=number(args[0],'corrections remove '),before=topics.removeCorrection(id);
     if(!before)throw new UsageError(`没有纠正 #${id}（butler corrections 列出纠正）`);
     if(values.json)json({before,after:null});else console.log(`已删除纠正 #${id}：${described(before)}${before.topic?`；这个话题现在：${judged(topics.topic(before.topicId))}`:''}`);
     return 0;
    }
    throw new UsageError(`corrections 没有这个操作：${action}`);
   }
   case 'groups':{
    await refreshGroups(store,openLark());
    const levels=new Map(store.levels().map(l=>[l.feedId,l])),groups=values.search?find(store.groups(),values.search,'feedId'):store.groups();
    if(values.json){console.log(JSON.stringify(groups.map(g=>({...g,level:levels.get(g.feedId)??null})),null,1));return 0;}
    for(const g of groups)console.log(`${levelOf(levels.get(g.feedId),g.chatMode)}  ${g.name}  ${g.memberCount??'?'} 人  最近活跃 ${time(g.lastActiveAt)}${g.chatMode==='topic'?'  话题群':''}  ${g.feedId}`);
    return 0;
   }
   case 'level':{
    const [action,...args]=rest;
    if(action==='list'||action===undefined){
     const list=store.levels();if(values.json){json(list);return 0;}
     if(!list.length)console.log('还没有聊天有级别（butler level set <级别> <聊天名或 id>）；没有级别的私聊按即时：全部消息交给模型，群按只存不看：存下，不交给模型');
     for(const l of list)console.log(`${levelOf(l)}  ${l.name||'（无名）'}  从 ${time(l.since)} 起${l.reason?`  理由：${l.reason}`:''}${l.by==='owner'&&l.modelLevel?`  模型的判断：${LEVEL_NAMES[l.modelLevel]}`:''}  ${l.feedId}`);
     return 0;
    }
    if(action==='set'){
     const [level,...queries]=args;
     if(!LEVELS.includes(level))throw new UsageError(`level set 的第一个参数是级别：${LEVELS.join(' ')}${level?`，没有 ${level}`:''}`);
     if(!queries.length)throw new UsageError('level set 需要聊天名或 id');
     const reason=values.reason===undefined?undefined:words(values.reason,'--reason ');
     // The store knows the chats seen so far, direct ones too; a group it cannot resolve uniquely is looked up in open-lark.
     if(queries.some(q=>find(store.chats(),q,'feedId').length!==1))await refreshGroups(store,openLark());
     const out=[];
     for(const c of queries.map(q=>pick(store.chats(),q,CHATS))){
      const name=c.name||c.feedId,was=store.level(c.feedId);
      // Mine already, and no new reason: nothing changes, and the reason I gave before stays.
      if(was?.by==='owner'&&was.level===level&&(reason===undefined||reason===was.reason)){
       out.push({...chatOf(c),before:was,after:was});if(!values.json)console.log(`${name}：已经是我定的${LEVEL_NAMES[level]}，没有改动`);continue;
      }
      const {before,after}=store.setLevel(c.feedId,level,{by:'owner',reason:reason??null});
      const warning=level==='instant'&&c.chatMode==='topic'?`注意：${name} 是话题群。butler 不按位置读话题群（open-lark 给话题群的消息窗口不可靠），这个群只能收到推送来的消息，收集器停机或断线期间的消息补不上；其中我参与的话题和 @我 的消息不受影响。`:undefined;
      out.push({...chatOf(c),before:before??null,after,...warning&&{warning}});
      if(values.json)continue;
      console.log(`${name}：${levelOf(before,c.chatMode)} → ${levelOf(after,c.chatMode)}${after.reason?`，理由：${after.reason}`:''}，从 ${time(after.since)} 起${LEVEL_EFFECT[level]}；和我有关的消息照旧收、照旧交给模型`);
      if(warning)console.log(warning);
     }
     if(values.json)json(out);
     return 0;
    }
    // What changed, the latest first: every change of a level, mine and the model's (see Store.levelChanges).
    if(action==='history'){
     const since=parseTime(values.since,'--since')??Date.now()-7*86400e3,list=store.levelChanges(since);
     if(values.json){json([...list].reverse().map(c=>({...c,before:c.before??null,after:c.after??null,correction:isCorrection(c)})));return 0;}
     if(!list.length){console.log('这段时间没有级别的改动');return 0;}
     for(const c of [...list].reverse())console.log(`${time(c.at)}  ${c.name||c.feedId}：${levelOf(c.before,c.chatMode)} → ${levelOf(c.after,c.chatMode)}  ${c.by==='owner'?'我改的':'模型改的'}${c.reason?`  理由：${c.reason}`:''}  ${c.feedId}`);
     const mine=list.filter(c=>c.by==='owner');
     console.log(`${values.since?`从 ${time(since)} 起`:'最近 7 天'}共 ${list.length} 次改动：我改了 ${mine.length} 次（其中纠正 ${mine.filter(isCorrection).length} 次），模型改了 ${list.length-mine.length} 次`);
     return 0;
    }
    if(action==='clear'){
     if(!args.length)throw new UsageError('level clear 需要聊天名或 id');
     const mine=store.levels().filter(l=>l.by==='owner').map(l=>({...l,name:l.name??''})),out=[];
     for(const c of args.map(q=>pick(mine,q,{...CHATS,missing:'只能取消我定的级别，butler level list 列出它们'}))){
      const {before,after}=store.clearLevel(c.feedId);out.push({...chatOf(c),before,after:after??null});
      if(!values.json)console.log(`${c.name||c.feedId}：${levelOf(before,c.chatMode)} → ${levelOf(after,c.chatMode)}`);
     }
     if(values.json)json(out);
     return 0;
    }
    // The model grades now, here, through herdr, as the processor's grading does in the background; a level I set is
    // not the model's to judge.
    if(action==='grade'){
     const chats=args.map(q=>pick(store.chats(),q,CHATS));
     for(const c of chats){const l=store.level(c.feedId);if(l?.by==='owner')throw new UsageError(`${c.name||c.feedId} 的级别是我定的（${LEVEL_NAMES[l.level]}），模型不改我定的级别；要让模型判断，先 butler level clear ${c.name||c.feedId}`);}
     const r=await new Grader({store,matters,model:herdrModel(config)}).grade(args.length?chats.map(c=>c.feedId):undefined);
     const named=id=>store.chat(id)?.name||id;
     if(values.json){
      json({chats:r.chats,runs:r.runs,graded:r.graded.map(g=>({feedId:g.feedId,name:g.name??null,before:g.before??null,after:g.after})),
       left:r.left.map(feedId=>({feedId,name:store.chat(feedId)?.name??null})),...r.error&&{error:r.error}});
      return r.left.length?1:0;
     }
     if(!r.chats){console.log('没有要分级的聊天：最近 7 天有消息、级别不是我定的聊天一个都没有');return 0;}
     for(const {feedId,before,after} of r.graded){const mode=store.chat(feedId)?.chatMode;console.log(`${named(feedId)}：${levelOf(before,mode)} → ${levelOf(after,mode)}：${after.modelReason}`);}
     if(r.left.length)console.log(`没有分级：${r.left.map(named).join('、')}（${r.error??'模型的回复里没有它们，或者给的级别、理由不能用，见 butler status 里的错误'}）`);
     console.log(`分了 ${r.chats} 个聊天里的 ${r.graded.length} 个，模型运行 ${r.runs} 次`);
     return r.left.length?1:0;
    }
    throw new UsageError(`level 没有这个操作：${action}`);
   }
   default:throw new UsageError(`没有这个命令：${command}\n\n${HELP}`);
  }
 }finally{store.close();}
}

// The processor, as a service or (once) for one round: the backlog, and 关于TA and the review of the open matters when
// they are due, as a round of the service would. As a service it also grades the chats and reads the day before, each
// on a timer of its own, and runs the bot, when one is configured: digests and the level cards.
async function processCommand(config,once){
 const model=herdrModel(config),store=new Store(storeFile(config),{linkBase:config.linkBase,log:m=>console.error(m)}),matters=new Matters(store);
 const options={...config.reviewEveryMs&&{reviewEveryMs:config.reviewEveryMs},...config.profileEveryMs&&{profileEveryMs:config.profileEveryMs}};
 // The latest digest follows the matters: whatever a batch, a review or the command line changes refreshes it. What the
 // model newly inferred about me when it wrote 关于TA goes to me (see levels.mjs).
 let bot,digests,levels;
 const processor=new Processor({store,matters,model,options,log:m=>console.log(m),onMattersChanged:()=>digests?.refresh(),onProfile:p=>levels?.inferred(p)});
 if(once){
  try{
   await processor.start({periodic:false});const r=await processor.runOnce();await processor.stop();
   const p=r.profile,profiled=!p?'':p.error?`「关于TA」没有写成：${p.error}；`:`写了「关于TA」（${p.text.length} 字）；`;
   const v=r.review,reviewed=!v?'':v.error?`整理没有完成：${v.error}；`:`整理了 ${v.reviewed} 个未结束的事项，关掉 ${v.closed} 个；`;
   console.log(`加工完成：模型运行 ${r.runs} 次，失败 ${r.failures} 次；${profiled}${reviewed}待加工 ${matters.pendingCount()} 条，未结束的事项 ${matters.list().length} 个`);
   return r.failures||p?.error||v?.error?1:0;
  }finally{store.close();}
 }
 // Grading and the daily read run beside the batches, the reviews and 关于TA, never behind them: a pass or a read of
 // many runs holds none of them up, and up to three claudes may run at once, each in a herdr workspace of its own.
 // After the first pass that graded chats, the level list goes to me.
 const grader=new Grader({store,matters,model,log:m=>console.log(m),onPass:p=>levels?.passed(p)});
 const reader=new Reader({store,matters,topics:new Topics(store),model,log:m=>console.log(m)});
 if(config.bot){
  const {Bot}=await feishu();
  bot=new Bot({store,...config.bot,log:m=>console.log(m)});
  digests=new Digests({store,matters,bot,schedule:config.schedule});
  levels=new LevelCards({store,bot,schedule:config.schedule,exams:n=>matters.exams(n)});
  // A choice on a weekly card's ⋯ is the level cards'; any other click, the digests'.
  bot.onCardAction=evt=>levels.click(evt)??digests.click(evt);
 }
 // The model runs under way (a batch, a grading and a read) are waited for, bounded; a grading cut off is done again,
 // and a read goes on from where it stopped.
 const stop=async()=>{
  await Promise.race([Promise.all([processor.stop(),grader.stop(),reader.stop(),digests?.stop(),levels?.stop()]),new Promise(r=>setTimeout(r,20_000))]);
  await Promise.race([bot?.stop(),new Promise(r=>setTimeout(r,5000))]);process.exit(0);
 };
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 console.log(`butler 加工端启动：模型在 herdr 机器 ${model.machine}，存储 ${store.file}`);
 // The processor's start closes the workspaces a crashed process left on the model machine, grading's and the read's
 // too (they have one label); these start after it, so that none of their own is closed.
 await processor.start();grader.start();reader.start();
 if(bot){
  console.log(`管家机器人（${config.bot.appId}）正在连接飞书`);
  bot.start().catch(e=>store.addError('机器人',`机器人停了：${e?.message??e}`));digests.start();levels.start();
 }else console.log('没有配置管家机器人（butler bot create），只做加工，不发汇总');
 return undefined;
}

// bot create: the bot's Feishu app, through Feishu's official flow; the credentials and the owner (whoever creates
// it) go into the config file. bot update: the configured app, and no other, gets what a new one would (the card
// callback, for one), through the same flow.
async function botCommand(config,[action],values){
 if(action!=='create'&&action!=='update')throw new UsageError(action?`bot 没有这个操作：${action}`:'用法：butler bot create [--name 名称] 或 butler bot update');
 if(action==='create'&&config.bot)throw new UsageError(`机器人已经配置（应用 ${config.bot.appId}）。要换一个，先从 ${config.file} 删掉 BUTLER_BOT_ 开头的几行`);
 if(action==='update'&&!config.bot)throw new UsageError(`${config.file} 里没有配置机器人，没有可以更新的应用；先用 butler bot create 创建`);
 const controller=new AbortController(),abort=()=>controller.abort();process.on('SIGINT',abort);
 const onLink=what=>(url,expiresIn)=>console.log(
  `用飞书扫码或在浏览器里打开下面的链接，在飞书的页面上确认${what}（${Math.round(expiresIn/60)} 分钟内有效）：\n\n${url}\n\n等待确认……（Ctrl-C 放弃）`);
 try{
  const {createApp,updateApp}=await feishu();
  if(action==='update'){
   const {appId,appSecret}=config.bot;
   const app=await updateApp({appId,signal:controller.signal,onLink:onLink(`给应用 ${appId} 加上卡片回调`)});
   // Should Feishu have issued a new secret, the bot needs it to connect.
   if(app.appSecret!==appSecret)saveConfig(config.file,{BUTLER_BOT_APP_SECRET:app.appSecret});
   console.log(`已在飞书确认更新应用 ${appId}${app.appSecret!==appSecret?`，飞书返回了新的 App Secret，已写进 ${config.file}`:''}。重启加工端（systemctl --user restart butler-processor）后，点卡片上的按钮试一下；还是提示应用没有配置回调时，按 README「给已有的应用加上卡片回调」在开发者后台把回调的订阅方式设成长连接。`);
   return 0;
  }
  const app=await createApp({name:values.name,signal:controller.signal,onLink:onLink('创建应用和它的权限')});
  saveConfig(config.file,{BUTLER_BOT_APP_ID:app.appId,BUTLER_BOT_APP_SECRET:app.appSecret,BUTLER_BOT_OWNER:app.owner,BUTLER_BOT_DOMAIN:app.domain});
  console.log(`已创建应用 ${app.appId}，只听创建它的人（${app.owner}）的话；凭证已写进 ${config.file}。重启加工端（systemctl --user restart butler-processor）后机器人上线。`);
  return 0;
 }catch(e){
  if(controller.signal.aborted)throw new UsageError(action==='update'?'已放弃更新，配置文件没有改动':'已放弃创建。如果已经在飞书确认过，这个应用已经建好，可以在飞书开放平台删掉它，再重新创建');
  throw e;
 }finally{process.off('SIGINT',abort);}
}

main(process.argv.slice(2)).then(code=>{if(code!==undefined)process.exitCode=code;},e=>{
 console.error(e instanceof UsageError||e?.message?.startsWith('配置文件')?e.message:`butler：${e?.message??e}`);process.exitCode=1;
});
