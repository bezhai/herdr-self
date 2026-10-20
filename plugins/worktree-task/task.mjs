// The task script: starts a Claude or Codex task in a new worktree of the repository of the current directory. The popup of the plugin
// and the wt shell function both run it; `node task.mjs --help` lists the options.
import fs from 'node:fs';import path from 'node:path';
import {configDir,loadConfig} from './config.mjs';import {startTask,notifyUser} from './start.mjs';import {continueBranch} from '../../bridge/worktree-branch.mjs';
const usage=`用法：node task.mjs [--codex] [-b <分支>] [--notify] [--] <描述… | 文件 [补充说明…] | - [补充说明…]>
  描述可以是几个参数（用空格连起来）、一个文件，或者 -（从标准输入读）；文件和 - 后面的参数作为 Additional context 附在后面。
  -b, --branch <分支>  用本地或 origin 上已有的分支，不再起名；不给描述时让 Agent 继续这个分支上的工作
  --codex              启动 Codex，默认是 Claude
  --notify             Agent 停在启动对话框和失败时另发 herdr 通知（弹窗用）`;
class UsageError extends Error{}
// Options come first, as in wt: the first argument that is not an option starts the description, so a description may contain dashes.
function parseArgs(argv){
 const o={kind:'claude',branch:undefined,notify:false,help:false};let i=0;
 for(;i<argv.length;i++){
  const a=argv[i];
  if(a==='--'){i++;break;}
  if(a==='--codex')o.kind='codex';
  else if(a==='--notify')o.notify=true;
  else if(a==='-h'||a==='--help')o.help=true;
  else if(a==='-b'||a==='--branch'){if(!argv[i+1])throw new UsageError(`${a} 需要一个分支名`);o.branch=argv[++i];}
  else if(a.startsWith('--branch=')){o.branch=a.slice(9);if(!o.branch)throw new UsageError('--branch= 需要一个分支名');}
  else if(a.startsWith('-')&&a!=='-')throw new UsageError(`未知选项 ${a}`);
  else break;
 }
 return {...o,rest:argv.slice(i)};
}
const isFile=p=>{try{return fs.statSync(p).isFile();}catch{return false;}};
// The description in rest: the text of a file or of stdin (-), with the arguments after it as additional context, or else the
// arguments themselves. Trailing whitespace goes; newlines and indentation reach the agent as they are. Without one, -b asks the agent
// to continue on that branch.
function readDescription(rest,{cwd,branch}){
 const [first,...after]=rest;let text,extra=[];
 if(first==='-'){text=fs.readFileSync(0,'utf8');extra=after;}
 else if(first!==undefined&&isFile(path.resolve(cwd,first))){text=fs.readFileSync(path.resolve(cwd,first),'utf8');extra=after;}
 else text=rest.join(' ');
 text=text.trimEnd();
 if(extra.length)text=`${text?text+'\n\n':''}Additional context: ${extra.join(' ')}`;
 return text||(branch?continueBranch(branch):'');
}
async function main(){
 let o;try{o=parseArgs(process.argv.slice(2));}catch(e){if(!(e instanceof UsageError))throw e;console.error(`${e.message}\n${usage}`);process.exit(2);}
 if(o.help){console.log(usage);return;}
 const description=readDescription(o.rest,{cwd:process.cwd(),branch:o.branch});
 if(!description){console.error(`缺少任务描述\n${usage}`);process.exit(2);}
 const say=m=>console.log(`[wt] ${m}`);
 try{await startTask({dir:process.cwd(),description,branch:o.branch,kind:o.kind,config:loadConfig(await configDir()),notify:o.notify},say);}
 catch(e){
  const created=e.created||[];
  console.error(`[wt] 失败：${e.message}`);
  console.error(created.length?['[wt] 已经创建、保持原样（没有回滚）的有：',...created.map(c=>`[wt]   - ${c}`)].join('\n'):'[wt] 没有创建任何东西。');
  if(o.notify)await notifyUser('开任务失败',e.message);
  process.exitCode=1;
 }
}
await main();
