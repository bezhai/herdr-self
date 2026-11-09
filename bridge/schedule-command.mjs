import http from 'node:http';
import {clientSocket,forwardMs} from './client.mjs';
import {when} from './cron.mjs';
import {clip} from './request-cards.mjs';
// bridge-schedule, the command line through which the agent of a Feishu topic manages the schedules of the topic's binding (see
// AgentSchedules). It sends each request to the Bridge client of the machine it runs on (see client.mjs), which passes it on to the control
// plane over its connection; the control plane takes the machine from that connection, so the command names none. It runs on Node alone,
// like the client. The agent is its pane (HERDR_PANE_ID, which Herdr puts into the environment of a pane) in its Herdr session
// (HERDR_SESSION, which Herdr sets in the panes of a session other than default). Reads print text for the agent, or with --json Bridge's
// answer.
// Its help is complete on its own: the skill that tells agents when to use it leaves the details of the command to it.
export const usage=`用法：
  bridge-schedule add --cron <cron 表达式> --mode new|into --task <任务文字> [--tz <IANA 时区>]
  bridge-schedule list
  bridge-schedule runs <ID>
  bridge-schedule update <ID> [--cron <cron 表达式>] [--tz <IANA 时区>] [--task <任务文字>]
  bridge-schedule pause <ID>
  bridge-schedule resume <ID>
  bridge-schedule remove <ID>

由 Bridge 开的飞书话题里的 Agent 运行，管理这个话题所在绑定上的定时任务。命令只连本机的 Bridge 客户端，由客户端转给 Bridge。

操作：
  add      提交一个新的定时任务。不直接生效：Bridge 在这个话题里发一张确认卡片，写明时间、接下来 5 次运行、任务文字和模式，
           主人点「确认」才生效，点「取消」或者 30 分钟内没有点就作废。命令输出卡片已发出和它的过期时间。
  list     这个绑定上的定时任务：ID 的前 8 位、模式、时间的文字描述、时区和表达式、是否暂停、下一次运行、任务文字的开头。
  runs     一个定时任务最近 20 次运行：计划时间，运行了的写第几次（晚了一分钟以上时写补跑时间），跳过、错过和失败的写原因。
  update   修改时间、时区或任务文字，至少给一项；和 add 一样要主人在确认卡片上点「确认」。模式不能改，要换模式就 remove 后重新 add。
  pause    暂停，立即生效。暂停期间的时间恢复后不补跑。
  resume   恢复，立即生效，下一次运行从恢复的时刻算起。
  remove   删除，立即生效。它开过的话题保留。
  一个话题同时只能有一张等待确认的卡片：有卡片在等时，新的 add 和 update 被拒绝，命令写明那张卡片几点过期。

选项：
  --cron <表达式>   5 个字段：分（0-59） 时（0-23） 日（1-31） 月（1-12） 星期（0-7，0 和 7 都是星期日）。每个字段是逗号分隔的 *、
                    数字或范围 a-b，都可以带步长 /n，n/步长 表示从 n 到这个字段的最大值；月份和星期也可以写英文的三个字母（jan、mon）。
                    日和星期都不以 * 开头时满足其一就运行。不支持秒、@daily 这类写法和 ? L W #。时间是 --tz 时区里的墙上时间：
                    夏令时跳过的时间那天不运行，重复的时间只运行一次。
  --tz <时区>       IANA 时区名，例如 Asia/Shanghai、America/New_York。add 不给时取这台机器的时区。
  --mode new|into   new：每次运行在群里发一条消息、开一个新话题，交给一个新的 Agent 从头做，它不知道这次对话；Bridge 只保留最近
                    3 次运行的话题，更早的关闭（最近 24 小时内有人说过话的除外）。into：每次运行把任务发进这个话题，交给这里的 Agent，
                    像主人发了一条消息；这个话题结束后定时任务自动暂停。到点时上一次还没做完（Agent 在工作或等待确认）就跳过这一次。
  --task <文字>     到点时发给 Agent 的消息，去掉首尾空白后不能为空，太长时 Bridge 拒绝。多行文字用 --task "$(cat <<'EOF'
                    …
                    EOF
                    )" 传。
  <ID>              定时任务的 ID，可以只写开头几位，例如卡片和 list 里的 8 位；有几个定时任务以它开头时要写完整。
  --json            输出 Bridge 返回的 JSON，而不是给人读的文字。
  --pane <pane>     Agent 所在的 Herdr pane，默认取 HERDR_PANE_ID。
  --session <名称>  Agent 所在的 Herdr session，默认取 HERDR_SESSION，都没有时是 default。
  -h, --help        显示这段说明。
  选项可以写成 --cron '0 9 * * *' 或 --cron='0 9 * * *'；选项后面的值原样使用，以 -- 开头也一样。

退出码：0 成功；1 Bridge 拒绝了请求或者连不上，原因在标准错误里；2 用法错误。

出错时：
  连不上本机的 Bridge 客户端、本机的 Bridge 客户端没有连上控制面：这台机器的客户端没有运行或者没有连上 Bridge。告诉主人，不要反复重试。
  没有权限连接本机的 Bridge 客户端，或者 Operation not permitted：命令在 Agent 的沙箱里被拦住了，按所在工具的方式申请在沙箱外运行这一条命令。
  这个 pane 里的 Agent 不属于任何进行中的飞书话题：不是在 Bridge 的飞书话题里运行的。告诉主人。
  其他拒绝（表达式写错、时区不对、定时任务不存在等）：按原因改正后再试。
`;
const ops=['add','list','runs','update','pause','resume','remove'];
const options={'--cron':'cron','--tz':'timeZone','--task':'task','--mode':'mode','--pane':'pane','--session':'session'};
const usageError=message=>Object.assign(Error(message),{usage:true});
// The operation, the id and the options of args: an option takes the next argument, or what follows its =, whatever it looks like.
export function parse(args){
 const out={json:false},positional=[];
 for(let i=0;i<args.length;i++){
  const a=args[i],eq=a.startsWith('--')?a.indexOf('='):-1,flag=eq>0?a.slice(0,eq):a;
  if(a==='--json'){out.json=true;continue;}
  if(a==='--help'||a==='-h'){out.help=true;continue;}
  if(Object.hasOwn(options,flag)){const value=eq>0?a.slice(eq+1):args[++i];if(value==null)throw usageError(flag+' 缺少值');out[options[flag]]=value;continue;}
  if(a.startsWith('--'))throw usageError('未知的参数：'+a);
  positional.push(a);
 }
 if(positional.length>2)throw usageError('多余的参数：'+positional.slice(2).join(' '));
 const [op,id]=positional;return {...op!=null&&{op},...id!=null&&{id},...out};
}
// Sends request op with body to the client on socket, on a connection of its own, and resolves to Bridge's answer; rejects with what Bridge
// or the client refused, when no client listens there, or when the agent's sandbox forbids the connection (that of a Codex started without
// its network, see Topics). The client answers within forwardMs; this waits 5 seconds longer, for a client that does not answer at all.
export function send(socket,op,body){
 return new Promise((resolve,reject)=>{
  const data=JSON.stringify(body);
  const req=http.request({socketPath:socket,agent:false,path:'/schedules/'+op,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)},timeout:forwardMs+5000},res=>{
   let s='';res.setEncoding('utf8');res.on('data',d=>{s+=d;});
   res.on('end',()=>{let r;try{r=JSON.parse(s);}catch{return reject(Error('本机的 Bridge 客户端的回答不是 JSON'));}if(res.statusCode!==200)return reject(Error(r.error||'本机的 Bridge 客户端回答 '+res.statusCode));resolve(r);});
  });
  req.on('timeout',()=>req.destroy(Error('本机的 Bridge 客户端没有回答')));
  req.on('error',e=>reject(['ENOENT','ECONNREFUSED'].includes(e.code)?Error(`连不上本机的 Bridge 客户端（${socket}）：客户端没有运行，或者没有打开这个 socket`)
   :['EACCES','EPERM'].includes(e.code)?Error(`没有权限连接本机的 Bridge 客户端（${socket}）：如果命令运行在 Agent 的沙箱里，需要在沙箱外运行这条命令`):e));
  req.end(data);
 });
}
const at=(ms,timeZone)=>when(ms,timeZone,{weekday:true});
const short=id=>id.slice(0,8);
const where=s=>s.mode==='new'?'每次开新话题':s.here?'发进这个话题':`发进话题「${s.topicTitle??'已删除的话题'}」`;
const nextRun=s=>s.next==null?'不会再运行':at(s.next,s.timeZone);
const outcomes={started:'已运行',skipped:'跳过',missed:'错过',failed:'失败'};
// Run r of schedule s in one line: when it was due (and the last time missed with it), what happened, which run, and when it ran late.
function run(s,r){
 const due=at(r.due,s.timeZone)+(r.last?' 至 '+at(r.last,s.timeZone):''),n=r.n?` · 第 ${r.n} 次`:'';
 if(r.outcome==='started')return `${due} · 已运行${n}${r.at-r.due>60000?' · 补跑于 '+at(r.at,s.timeZone):''}`;
 return `${due} · ${outcomes[r.outcome]??r.outcome}：${r.reason}${n}`;
}
function proposed(p){
 const what=p.kind==='add'?'确认卡片':`修改定时任务 ${short(p.scheduleId)} 的确认卡片`,next=p.next.length?'下次运行 '+at(p.next[0],p.timeZone):'之后不会再运行';
 return `已在这个话题里发了${what}：${p.phrase}（${p.timeZone}），${next}。主人在卡片上点「确认」后才生效；到 ${at(p.expiresAt,p.timeZone)} 还没有确认就作废。`;
}
// Bridge's answer r to op as text for the agent.
export function format(op,r){
 const s=r.schedule;
 switch(op){
  case 'list':return !r.schedules.length?`绑定「${r.binding.name}」上没有定时任务。`:[`绑定「${r.binding.name}」上有 ${r.schedules.length} 个定时任务：`,...r.schedules.flatMap(x=>[
   `${short(x.id)} · ${where(x)} · ${x.phrase}（${x.timeZone}，cron：${x.cron}）${x.paused?' · 已暂停':''}`,...x.paused?[]:['  下次运行：'+nextRun(x)],'  任务：'+clip(x.task.replace(/\s+/g,' ').trim(),200)])].join('\n');
  case 'runs':return !r.runs.length?`定时任务 ${short(s.id)} 还没有运行记录。`:[`定时任务 ${short(s.id)}（${s.phrase}，${s.timeZone}）最近 ${r.runs.length} 次运行：`,...r.runs.map(x=>run(s,x))].join('\n');
  case 'pause':return `已暂停定时任务 ${short(s.id)}（${s.phrase}）。恢复之前不会运行，暂停期间的时间恢复后也不补跑。`;
  case 'resume':return `已恢复定时任务 ${short(s.id)}，下次运行：${nextRun(s)}。`;
  case 'remove':return `已删除定时任务 ${short(s.id)}（${s.phrase}）。它开过的话题保留。`;
  default:return proposed(r.proposal);
 }
}
// Runs bridge-schedule with argv in env, and resolves to its exit status: 0, 1 when Bridge refused or cannot be reached, 2 for a usage
// error. timeZone is that of a new schedule without --tz: the machine's.
export async function main(argv,{env=process.env,stdout=process.stdout,stderr=process.stderr,timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone}={}){
 try{
  const o=parse(argv);
  if(o.help){stdout.write(usage);return 0;}
  if(!ops.includes(o.op))throw usageError(o.op?'未知的操作：'+o.op:'缺少操作');
  const {op,json,help,...fields}=o,pane=fields.pane??env.HERDR_PANE_ID,session=fields.session??env.HERDR_SESSION;
  const body={...fields,...pane&&{pane},...session&&{session},...op==='add'&&{timeZone:fields.timeZone??timeZone}};
  const r=await send(clientSocket(env),op,body);
  stdout.write((json?JSON.stringify(r,null,2):format(op,r))+'\n');return 0;
 }catch(e){stderr.write(`bridge-schedule: ${e.message}\n${e.usage?usage:''}`);return e.usage?2:1;}
}
