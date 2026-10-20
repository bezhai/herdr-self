import crypto from 'node:crypto';
import {run} from './herdr.mjs';
const types=['feat','fix','refactor','docs','test','chore','perf','style'];
// The prompt of the wt shell function, which the user's branch names come from.
export const namingPrompt=desc=>`You are a git branch naming tool. Given a requirement, classify it and output a branch name.

Output EXACTLY one line in this format, nothing else:
BRANCH=type/short-kebab-name

Types: ${types.join(', ')}
Rules:
- Use lowercase kebab-case for description part
- Max 50 chars total
- Be specific but concise
- NO explanation, NO markdown, ONLY the BRANCH= line

Requirement:
${desc}`;
export const parseBranch=out=>/BRANCH=(\S+)/.exec(out)?.[1];
// A type prefix and a lowercase kebab-case slug. The prompt asks for 50 characters; a few more are still a usable name.
export const validBranch=b=>b.length<=64&&new RegExp(`^(${types.join('|')})/[a-z0-9]+(-[a-z0-9]+)*$`).test(b);
// Asks Claude haiku for a branch name for desc and resolves to {branch}, or to {reason} when there is none in time. claude runs without
// the HERDR_* variables: its Herdr hook reports to the pane in HERDR_PANE_ID, which is the pane that started the task.
export async function nameBranch(desc,{cwd,timeoutMs}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')));let r;
 try{r=await run('claude',['-p','--model','haiku'],{cwd,env,input:namingPrompt(desc),timeoutMs});}catch(e){return {reason:`无法运行 claude：${e.message}`};}
 if(r.timedOut)return {reason:`${timeoutMs/1000} 秒内没有返回`};
 if(r.code!==0)return {reason:`claude 退出码 ${r.code}：${r.stderr.trim().slice(-300)}`};
 const branch=parseBranch(r.stdout);
 return branch&&validBranch(branch)?{branch}:{reason:`输出里没有可用的 BRANCH= 行：${r.stdout.trim().slice(0,300)}`};
}
// The fallback when naming fails, in the form of the names Herdr generates itself (generated_branch_slug in src/worktree.rs), which a
// worktree beside the repository cannot use: its path has to be known before Herdr picks the name.
const adjectives=['brave','calm','clear','green','lucky','quiet','rapid','silver'],nouns=['river','cloud','field','forest','harbor','meadow','stone','valley'];
export const randomBranch=()=>`worktree/${adjectives[crypto.randomInt(8)]}-${nouns[crypto.randomInt(8)]}-${crypto.randomBytes(2).toString('hex')}`;
// A Herdr agent name for the agent of branch that is not in taken: 1-32 of a-z, 0-9, - and _, starting with a letter. feat/add-login
// gives feat-add-login, then feat-add-login-2, -3 and so on; a branch without a letter to start with gives task.
export function agentName(branch,taken){
 const base=branch.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/-{2,}/g,'-').replace(/^[^a-z]+/,'').replace(/-+$/,'')||'task';
 const fit=(suffix='')=>base.slice(0,32-suffix.length).replace(/-+$/,'')+suffix;
 let name=fit();for(let i=2;taken.has(name);i++)name=fit(`-${i}`);return name;
}
