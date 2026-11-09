import fs from 'node:fs';
import path from 'node:path';
import {clientSocket,send} from './client.mjs';
// bridge-skill, the command line through which agents on a machine find and read the skills of the platform (see Skills), and through
// which the owner manages them. Reads go to the Bridge client of the machine it runs on (see client.mjs), which passes them on to the
// control plane like the requests of bridge-schedule: any agent of the machine may run them, and the control plane answers nothing else
// that comes that way (see Skills.answer). Management goes to the console's API with its access key (BRIDGE_URL and BRIDGE_ACCESS_KEY), as
// the console's own requests do, from wherever the owner runs it. It runs on Node alone, like the client. Reads print text for the agent,
// or with --json Bridge's answer.
// Its help is complete on its own: the entry skill that tells agents about the platform leaves the details of the command to it.
export const usage=`用法：
  bridge-skill list [--json]
  bridge-skill search <词>... [--json]
  bridge-skill read <名称> [--json]
  bridge-skill import <目录>
  bridge-skill export <名称> [<目录>]
  bridge-skill everywhere <名称> on|off
  bridge-skill remove <名称>

查找、阅读和管理 Bridge 平台上的 skill。平台上的 skill 由主人在 Bridge 管理台的 Skills 页或者用这个命令维护：标为「所有项目都带」的，
Bridge 在开话题时放进 Agent 的工作目录，Agent 启动时就能看到；其他的不放，Agent 需要时用这个命令查找和阅读。

读（list、search、read）只连本机的 Bridge 客户端，由客户端转给 Bridge，不需要密钥，这台机器上的 Agent 都可以运行。
管理（import、export、everywhere、remove）直接连 Bridge 的管理台，要设置两个环境变量：
  BRIDGE_URL         管理台的地址，例如 http://<控制面>:8080。
  BRIDGE_ACCESS_KEY  管理台的访问密钥，在控制面状态目录的 access-key 文件里。
平台上的 skill 会进入之后所有 Agent 的工作目录或上下文，由主人管理：Agent 只在主人明确要求时运行管理操作。

操作：
  list        平台上所有的 skill：名称、是否所有项目都带、描述。所有项目都带的已经在 Agent 的工作目录里，不用再 read。
  search      名称、描述或 SKILL.md 正文里包含所有这些词的 skill，不分大小写，名称或描述里包含的排在前面。
  read        输出一个 skill 的 SKILL.md 全文。skill 带有其他文件（脚本、参考文档等）时，客户端先把它们放进这台机器的
              ~/.local/share/herdr-bridge/skills/<名称> 目录，命令在正文前写出这个目录和文件列表；SKILL.md 里提到的相对路径都相对
              这个目录。
  import      把一个目录导入为 skill，名称取目录名。目录里要有 SKILL.md，开头是 frontmatter：以 --- 开始和结束，写着 name（和目录名
              一致，只用小写字母、数字和单个连字符）和 description（什么时候该用它）。目录里只能有普通文件和子目录，软链接会被拒绝；
              文件合计超过上限时 Bridge 拒绝。已有同名 skill 时整个替换它的文件，是否所有项目都带不变。
  export      把一个 skill 的文件写到 <目录>/<名称>，不给目录时写到当前目录；<目录>/<名称> 已经存在时拒绝，不覆盖。
  everywhere  on：设为所有项目都带，之后新开的话题，Bridge 都会把它放进 Agent 的工作目录；off：取消，之后新开话题时 Bridge 把它
              从工作目录里移走。已经开着的话题不受影响。
  remove      删除一个 skill。它所有项目都带时，之后新开话题时 Bridge 也把它从工作目录里移走。

选项：
  --json      list、search 和 read 输出 Bridge 返回的 JSON，而不是给人读的文字。
  -h, --help  显示这段说明。

退出码：0 成功；1 Bridge 拒绝了请求或者连不上，原因在标准错误里；2 用法错误。

出错时：
  连不上本机的 Bridge 客户端、本机的 Bridge 客户端没有连上控制面：这台机器的客户端没有运行或者没有连上 Bridge。告诉主人，不要反复重试。
  没有权限连接本机的 Bridge 客户端，或者 Operation not permitted：命令在 Agent 的沙箱里被拦住了，按所在工具的方式申请在沙箱外运行这一条命令。
  skill 不存在：名称写错了，用 list 或 search 找到准确的名称。
  管理 skill 要设置 BRIDGE_URL…、请先登录、连不上控制面：管理操作缺少或者写错了 BRIDGE_URL 和 BRIDGE_ACCESS_KEY，或者控制面没有运行。
  不允许的 Host：控制面只接受用它的主机名、localhost、127.0.0.1 和它的 BRIDGE_HOSTS 里的名字访问，BRIDGE_URL 换成其中一个。
  其他拒绝（skill 名称无效、SKILL.md 缺少 frontmatter 等）：按原因改正后再试。
`;
const reads=['list','search','read'],ops=[...reads,'import','export','everywhere','remove'];
const usageError=message=>Object.assign(Error(message),{usage:true});
// The operation of args with the arguments it takes, and --json; anything else is a usage error.
export function parse(args){
 const out={args:[],json:false};let op;
 for(const a of args){
  if(a==='--json')out.json=true;else if(a==='--help'||a==='-h')out.help=true;else if(/^-./.test(a))throw usageError('未知的参数：'+a);
  else if(op==null)op=a;else out.args.push(a);
 }
 if(out.help)return out;
 if(!ops.includes(op))throw usageError(op?'未知的操作：'+op:'缺少操作');
 const [first,second]=out.args,most={list:0,search:Infinity,read:1,import:1,export:2,everywhere:2,remove:1}[op];
 if(op==='search'&&first==null)throw usageError('缺少要搜索的词');
 if(op==='import'&&first==null)throw usageError('缺少 skill 的目录');
 if(!['list','search','import'].includes(op)&&first==null)throw usageError('缺少 skill 的名称');
 if(out.args.length>most)throw usageError('多余的参数：'+out.args.slice(most).join(' '));
 if(op==='everywhere'&&!['on','off'].includes(second))throw usageError('everywhere 要写 on 或 off');
 if(out.json&&!reads.includes(op))throw usageError('--json 只用于 list、search 和 read');
 return {op,...out};
}
const entry=s=>[s.name+(s.everywhere?' · 所有项目都带':''),'  '+s.description.replace(/\s+/g,' ').trim()];
// Bridge's answer r to read op with args as text for the agent.
export function format(op,r,args){
 switch(op){
  case 'list':return !r.skills.length?'平台上还没有 skill。':[`平台上有 ${r.skills.length} 个 skill：`,...r.skills.flatMap(entry)].join('\n');
  case 'search':return !r.skills.length?`没有匹配「${args.join(' ')}」的 skill。`:[`匹配「${args.join(' ')}」的 skill 有 ${r.skills.length} 个：`,...r.skills.flatMap(entry)].join('\n');
  default:return (r.path?[`${r.name} 带有其他文件，在这台机器的 ${r.path} 里：`,...r.files.map(f=>'  '+f),'SKILL.md 里提到的相对路径都相对这个目录。','',''].join('\n'):'')+r.text;
 }
}
// The console's API at BRIDGE_URL with the access key BRIDGE_ACCESS_KEY: api(p, body) sends body to /api/<p>, or reads it without one, and
// resolves to the answer; it rejects with what the control plane refused or when it cannot be reached.
function consoleApi(env){
 const url=env.BRIDGE_URL?.replace(/\/+$/,''),key=env.BRIDGE_ACCESS_KEY;
 if(!url||!key)throw Error('管理 skill 要设置 BRIDGE_URL（管理台的地址，例如 http://<控制面>:8080）和 BRIDGE_ACCESS_KEY（管理台的访问密钥）');
 return async(p,body)=>{
  let res;try{res=await fetch(`${url}/api/${p}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key,...body&&{'content-type':'application/json'}},body:body&&JSON.stringify(body)});}
  catch(e){throw Error(`连不上控制面 ${url}：${e.cause?.code||e.cause?.message||e.message}`);}
  let r;try{r=await res.json();}catch{throw Error(`控制面的回答不是 JSON（HTTP ${res.status}）`);}
  if(!res.ok)throw Error(r.error||'控制面回答 '+res.status);return r;
 };
}
// The files under directory dir as the platform takes them, {relative path: base64}; only regular files and directories.
async function filesOf(dir){
 if(!(await fs.promises.stat(dir).catch(()=>null))?.isDirectory())throw Error('不是目录：'+dir);
 const files={},walk=async rel=>{
  for(const e of await fs.promises.readdir(path.join(dir,rel),{withFileTypes:true})){
   const p=rel?rel+'/'+e.name:e.name;
   if(e.isDirectory())await walk(p);else if(e.isFile())files[p]=(await fs.promises.readFile(path.join(dir,p))).toString('base64');else throw Error('只能导入普通文件和目录：'+p);
  }
 };
 await walk('');return files;
}
// Management op with args through the console's API (see consoleApi); resolves to what it prints.
async function manage(op,[first,second],env){
 const api=consoleApi(env);
 switch(op){
  case 'import':{const name=path.basename(path.resolve(first)),files=await filesOf(first);await api('skills/import',{name,files});return `已导入 skill ${name}，共 ${Object.keys(files).length} 个文件。`;}
  case 'export':{
   // The skill is read before anything is written, and the directory of its name is created on its own, so a place that exists stays as it is.
   const {files}=await api('skills/read?name='+encodeURIComponent(first)),target=path.join(path.resolve(second??'.'),first);
   await fs.promises.mkdir(path.dirname(target),{recursive:true});await fs.promises.mkdir(target).catch(e=>{throw e.code==='EEXIST'?Error(target+' 已经存在'):e;});
   for(const [p,b] of Object.entries(files)){await fs.promises.mkdir(path.dirname(path.join(target,p)),{recursive:true});await fs.promises.writeFile(path.join(target,p),Buffer.from(b,'base64'));}
   return `已导出到 ${target}。`;
  }
  case 'everywhere':await api('skills/everywhere',{name:first,everywhere:second==='on'});
   return second==='on'?`${first} 已设为所有项目都带：之后新开的话题，Bridge 都会把它放进 Agent 的工作目录。`:`${first} 已取消所有项目都带：之后新开话题时，Bridge 会把它从 Agent 的工作目录里移走。`;
  default:await api('skills/remove',{name:first});return `已删除 skill ${first}。`;
 }
}
// Runs bridge-skill with argv in env, and resolves to its exit status: 0, 1 when Bridge refused or cannot be reached, 2 for a usage error.
export async function main(argv,{env=process.env,stdout=process.stdout,stderr=process.stderr}={}){
 try{
  const {op,args,json,help}=parse(argv);
  if(help){stdout.write(usage);return 0;}
  let text;
  if(reads.includes(op)){const r=await send(clientSocket(env),'/skills/'+op,op==='list'?{}:op==='search'?{query:args.join(' ')}:{name:args[0]});text=json?JSON.stringify(r,null,2):format(op,r,args);}
  else text=await manage(op,args,env);
  stdout.write(text.endsWith('\n')?text:text+'\n');return 0;
 }catch(e){stderr.write(`bridge-skill: ${e.message}\n${e.usage?usage:''}`);return e.usage?2:1;}
}
