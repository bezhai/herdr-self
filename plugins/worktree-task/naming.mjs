import {run} from './herdr.mjs';
import {namingPrompt,branchOf} from '../../bridge/worktree-branch.mjs';
// Asks Claude haiku for a branch name for desc and resolves to {branch}, or to {reason} when there is none in time. claude runs without
// the HERDR_* variables: its Herdr hook reports to the pane in HERDR_PANE_ID, which is the pane that started the task.
export async function nameBranch(desc,{cwd,timeoutMs}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')));let r;
 try{r=await run('claude',['-p','--model','haiku'],{cwd,env,input:namingPrompt(desc),timeoutMs});}catch(e){return {reason:`无法运行 claude：${e.message}`};}
 if(r.timedOut)return {reason:`${timeoutMs/1000} 秒内没有返回`};
 return branchOf(r);
}
// A Herdr agent name for the agent of branch that is not in taken: 1-32 of a-z, 0-9, - and _, starting with a letter. feat/add-login
// gives feat-add-login, then feat-add-login-2, -3 and so on; a branch without a letter to start with gives task.
export function agentName(branch,taken){
 const base=branch.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/-{2,}/g,'-').replace(/^[^a-z]+/,'').replace(/-+$/,'')||'task';
 const fit=(suffix='')=>base.slice(0,32-suffix.length).replace(/-+$/,'')+suffix;
 let name=fit();for(let i=2;taken.has(name);i++)name=fit(`-${i}`);return name;
}
