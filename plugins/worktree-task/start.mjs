import fs from 'node:fs';import path from 'node:path';
import {herdr} from './herdr.mjs';
import {repoOf,worktreePath,validRefName,localBranch} from './repo.mjs';
import {nameBranch,randomBranch,agentName} from './naming.mjs';
// herdr agent prompt takes the description as one command-line argument, which Linux caps at 128 KiB.
export const MAX_DESCRIPTION_BYTES=128000;
// The flags that start each agent without permission prompts, as wt did; config.bypassPermissions turns them off.
const bypassFlags={claude:['--dangerously-skip-permissions'],codex:['--dangerously-bypass-approvals-and-sandbox']};
// Added to Herdr's own --timeout of a call that waits, before the call counts as hung.
const margin=30000;
// Best effort: Herdr shows no toast when toasts are off, busy or rate limited, or no client is attached. The terminal or the popup log
// has the details either way.
export async function notifyUser(title,body){try{await herdr(['notification','show',title,'--body',body.slice(0,240)],{timeoutMs:15000});}catch{}}
const failure=(what,e)=>Error(e.code?`${what}（${e.code}：${e.message}）`:`${what}：${e.message}`);
// Starts the agent of kind in a new worktree of the repository of dir and prompts it with description. branch is an existing branch to
// use, or undefined to have one named after the description. say prints progress. A failure rejects with an Error whose created lists
// what exists by then, which stays in place: nothing is rolled back.
export async function startTask(task,say){
 const created=[];
 try{return await steps(task,say,created);}catch(e){throw Object.assign(e,{created});}
}
async function steps({dir,description,branch:given,kind,config,notify},say,created){
 const bytes=Buffer.byteLength(description);
 if(bytes>MAX_DESCRIPTION_BYTES)throw Error(`任务描述有 ${bytes} 字节，超过 ${MAX_DESCRIPTION_BYTES} 字节，herdr agent prompt 的命令行参数放不下`);
 const repo=await repoOf(dir);
 if(repo.linked)say(`从 linked worktree 发起：新分支基于它的 HEAD ${repo.base.slice(0,12)}，worktree 仍建在 ${path.basename(repo.mainRoot)}-worktrees/ 下`);
 let branch=given;
 if(given){if(!await validRefName(repo.mainRoot,given))throw Error(`分支名无效：${given}`);say(`分支：${given}`);}
 else{
  say('正在用 Claude haiku 起分支名…');
  const named=await nameBranch(description,{cwd:repo.mainRoot,timeoutMs:config.namingTimeoutMs});
  branch=named.branch??randomBranch();say(named.branch?`分支：${branch}`:`起名失败（${named.reason}），改用随机分支名 ${branch}`);
 }
 const target=worktreePath(repo.mainRoot,branch);
 if(fs.existsSync(target))throw Error(`目录已存在：${target}，不会覆盖它；换一个分支，或者先处理这个目录`);
 const local=await localBranch(repo.mainRoot,branch);
 if(given&&local==='none')throw Error(`本地和 origin 都没有分支 ${branch}`);
 if(local==='tracking'){created.push(`本地分支 ${branch}（跟踪 origin/${branch}）`);say(`已从 origin/${branch} 建立本地跟踪分支 ${branch}`);}
 say(`正在创建 worktree：${target}`);
 let made;
 try{made=await herdr(['worktree','create','--cwd',repo.mainRoot,'--branch',branch,'--path',target,...(repo.base?['--base',repo.base]:[]),'--focus']);}
 catch(e){if(fs.existsSync(target))created.push(`worktree ${target}（分支 ${branch}），herdr 没有为它打开 workspace`);throw failure('创建 worktree 失败',e);}
 created.push(`worktree ${target}（分支 ${branch}）`);
 const workspace=made?.workspace?.workspace_id,pane=made?.root_pane?.pane_id;
 if(!workspace||!pane)throw Error('herdr worktree create 的返回里没有 workspace 或 root_pane');
 created.push(`workspace ${workspace}，pane ${pane}`);
 let agents;try{agents=await herdr(['agent','list'],{timeoutMs:15000});}catch(e){throw failure('读取 agent 列表失败',e);}
 const name=agentName(branch,new Set((agents?.agents||[]).map(a=>a.name).filter(Boolean))),flags=config.bypassPermissions?bypassFlags[kind]:[];
 say(`正在 pane ${pane} 启动 ${kind}（agent ${name}）…`);
 try{await herdr(['agent','start',name,'--kind',kind,'--pane',pane,'--timeout',String(config.agentStartTimeoutMs),...(flags.length?['--',...flags]:[])],{timeoutMs:config.agentStartTimeoutMs+margin});}
 catch(e){
  if(e.code!=='agent_not_ready')throw failure(`在 pane ${pane} 启动 ${kind} 失败`,e);
  // The agent is up but shows something that needs a person, such as the folder trust question of Codex. Herdr reports it as blocked;
  // keys are left to the person, the task only waits.
  const seconds=config.readyTimeoutMs/1000;
  say(`${kind} 停在启动对话框，需要你到 pane ${pane} 处理；最多等 ${seconds} 秒，不会代为按键`);
  if(notify)await notifyUser(`${kind} 等你处理启动对话框`,`pane ${pane}（${branch}），处理后任务描述会自动发送`);
  try{await herdr(['agent','wait',name,'--until','idle','--until','done','--timeout',String(config.readyTimeoutMs)],{timeoutMs:config.readyTimeoutMs+margin});}
  catch(w){created.push(`agent ${name}（${kind}，停在 pane ${pane} 的启动对话框）`);throw failure(`${kind} 在 ${seconds} 秒内没有就绪，仍停在 pane ${pane}，任务描述没有发送`,w);}
 }
 created.push(`agent ${name}（${kind}，pane ${pane}）`);
 try{await herdr(['agent','prompt',name,description],{timeoutMs:60000});}catch(e){throw failure('发送任务描述失败',e);}
 say(`完成：${kind}（agent ${name}）在 workspace ${workspace} 的 pane ${pane} 收到了任务描述；worktree ${target}，分支 ${branch}`);
 return {branch,worktree:target,workspace,pane,agent:name};
}
