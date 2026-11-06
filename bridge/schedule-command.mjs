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
export const usage=`用法：
  bridge-schedule add --cron <cron 表达式> --mode new|into --task <任务文字> [--tz <IANA 时区>]
  bridge-schedule list
  bridge-schedule runs <ID>
  bridge-schedule update <ID> [--cron <cron 表达式>] [--tz <IANA 时区>] [--task <任务文字>]
  bridge-schedule pause <ID>
  bridge-schedule resume <ID>
  bridge-schedule remove <ID>
add 和 update 在这个话题里发确认卡片，主人点「确认」后才生效；其他操作立即生效。
--mode new 每次运行开一个新话题，into 每次运行发进这个话题。--tz 默认取这台机器的时区。
ID 可以只写开头几位（例如卡片上的 8 位）。--json 输出 Bridge 的原始结果。
--pane <pane> 和 --session <Herdr session> 默认取 HERDR_PANE_ID 和 HERDR_SESSION。
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
