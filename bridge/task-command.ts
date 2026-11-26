import {clientSocket,send} from './client.ts';
import type {Output} from './client.ts';
import type {TaskOps,TaskRequest} from './agent-tasks.ts';
// bridge-task, the command line through which the agent of a Feishu topic ends the task of its topic. Like bridge-message (see
// message-command.ts), it sends each request to the Bridge client of the machine it runs on, which passes it on to the control plane, with the
// agent's pane (HERDR_PANE_ID) and Herdr session (HERDR_SESSION); it runs on Node alone, like the client, and prints text for the agent, or
// with --json Bridge's answer. Its help is complete on its own: the skill that tells agents when to end a task leaves the details to it.
export const usage=`用法：
  bridge-task end (--achieved | --dropped) --reason <原因>

由 Bridge 开的飞书话题里的 Agent 运行，结束这个话题的任务。命令只连本机的 Bridge 客户端，由客户端转给 Bridge。

操作：
  end  结束任务。--achieved 表示目标达成，而且产出的东西已经交付；--dropped 表示放弃，例如主人说不用做了。
       任务不是马上结束，而是在当前这一轮结束时结束：命令之后你照常写最后一条回复，它会发到话题里，之后任务才结束，话题里会出现
       「任务已完成」或「任务已放弃」的提示。结束之后主人再写一条消息，任务会重新打开。

选项：
  --achieved       任务完成。有草稿还在等主人确认时不能用。
  --dropped        任务放弃。--achieved 和 --dropped 必须给一个，只能给一个。
  --reason <原因>  必填，一两句话：完成时写结果，放弃时写原因。会原样显示在话题的提示里。
  --json           输出 Bridge 返回的 JSON，而不是给 Agent 读的文字。
  --pane <pane>    Agent 所在的 Herdr pane，默认取 HERDR_PANE_ID。
  --session <名称> Agent 所在的 Herdr session，默认取 HERDR_SESSION，都没有时是 default。
  -h, --help       显示这段说明。
  选项可以写成 --reason '原因' 或 --reason='原因'；选项后面的值原样使用，以 -- 开头也一样。

退出码：0 成功；1 Bridge 拒绝了请求或者连不上，原因在标准错误里；2 用法错误，同时打印这段用法。

出错时：
  连不上本机的 Bridge 客户端、本机的 Bridge 客户端没有连上控制面：这台机器的客户端没有运行或者没有连上 Bridge。告诉主人，不要反复重试。
  没有权限连接本机的 Bridge 客户端，或者 Operation not permitted：命令在 Agent 的沙箱里被拦住了，按所在工具的方式申请在沙箱外运行这一条命令。
  这个 pane 里的 Agent 不属于任何进行中的飞书话题：不是在 Bridge 的飞书话题里运行的，没有任务要结束，跳过即可，不用告诉主人；不要换 pane 或 session 绕过。
  还有草稿在等主人确认：草稿处理完之前不能以完成结束。等主人处理，或者主人说不要了就用 --dropped。
  任务已经结束：不用再结束。
  其他拒绝：按 Bridge 输出的原因改正后再试；原因保持不变时不要反复提交。
`;
type Parsed=TaskRequest&{op?:string,achieved:boolean,dropped:boolean,json:boolean,help?:boolean};
const usageError=(message:string)=>Object.assign(Error(message),{usage:true});
// The operation and options of args: an option takes the next argument, or what follows its =, whatever it looks like.
function parse(args:string[]):Parsed{
 const out:Parsed={achieved:false,dropped:false,json:false},positional:string[]=[];
 for(let i=0;i<args.length;i++){
  const a=args[i],eq=a.startsWith('--')?a.indexOf('='):-1,flag=eq>0?a.slice(0,eq):a;
  if(a==='--json'){out.json=true;continue;}
  if(a==='--achieved'||a==='--dropped'){out[a.slice(2) as 'achieved'|'dropped']=true;continue;}
  if(a==='--help'||a==='-h'){out.help=true;continue;}
  if(['--reason','--pane','--session'].includes(flag)){
   const value=eq>0?a.slice(eq+1):args[++i];if(value==null)throw usageError(flag+' 缺少值');
   out[flag.slice(2) as 'reason'|'pane'|'session']=value;continue;
  }
  if(a.startsWith('--'))throw usageError('未知的参数：'+a);
  positional.push(a);
 }
 if(positional.length>1)throw usageError('多余的参数：'+positional.slice(1).join(' '));
 return {...positional[0]!=null&&{op:positional[0]},...out};
}
// Runs bridge-task with argv, printing to stdout and stderr; resolves to the exit code. It reaches the client at clientSocket(env).
export async function main(argv:string[],{env=process.env,stdout=process.stdout,stderr=process.stderr}:{env?:NodeJS.ProcessEnv,stdout?:Output,stderr?:Output}={}):Promise<number>{
 try{
  const o=parse(argv);
  if(o.help){stdout.write(usage);return 0;}
  if(o.op!=='end')throw usageError(o.op?'未知的操作：'+o.op:'缺少操作');
  if(o.achieved&&o.dropped)throw usageError('--achieved 和 --dropped 只能给一个');
  if(!o.achieved&&!o.dropped)throw usageError('end 要给出 --achieved 或 --dropped');
  if(o.reason===undefined)throw usageError('end 需要 --reason');
  if(!o.reason.trim())throw usageError('--reason 不能为空');
  const pane=o.pane??env.HERDR_PANE_ID,session=o.session??env.HERDR_SESSION;
  const body:TaskOps['end']['request']={outcome:o.achieved?'achieved':'dropped',reason:o.reason,...pane&&{pane},...session&&{session}};
  const r=await send(clientSocket(env),'/tasks/end',body);
  stdout.write((o.json?JSON.stringify(r,null,2):`任务会在当前这一轮结束时结束（${r.outcome==='achieved'?'已完成':'已放弃'}）：${r.reason}`)+'\n');return 0;
 }catch(e){stderr.write(`bridge-task: ${e.message}\n${e.usage?usage:''}`);return e.usage?2:1;}
}
