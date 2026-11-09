import {namingPrompt,branchRules,branchOf} from './worktree-branch.mjs';
import {withoutAttachments} from './attachments.ts';
import type {Operations} from './core.ts';
import type {Machine,Project} from './state.ts';
// What the cheap model decides when a topic starts: the branch of its worktrees and, in a direct chat, the project (see Topics.route). One
// call does both; with the project fixed it only names the branch, with the prompt that the worktree-task plugin uses.
const timeoutMs=30000;
const oneLine=(s:string,max:number)=>s.replace(/\s+/g,' ').trim().slice(0,max);
const routingPrompt=(task:string,projects:Pick<Project,'name'|'description'>[])=>`You are a task routing tool. Given a requirement and a list of projects, pick the project the requirement belongs to and name a git branch for it.

Output EXACTLY two lines in this format, nothing else:
PROJECT=<exact project name from the list, or NONE>
BRANCH=type/short-kebab-name

Use NONE when no project clearly fits the requirement.

${branchRules}
- NO explanation, NO markdown, ONLY the PROJECT= and BRANCH= lines

Projects:
${projects.map(p=>`- ${oneLine(p.name,100)}${p.description?': '+oneLine(p.description,200):''}`).join('\n')}

Requirement:
${task}`;
// What the model made of the task: the project it picked (none when it said NONE, named an unknown project or failed), and the branch it
// named, or else why there is none (the caller falls back to a random name).
export type Named={project?:Project,branch?:string,reason?:string};
// Asks the cheap model on machine m, from the home directory there, about task (a message as a person wrote it, whose attachments count for
// nothing). With projects it picks one of them by name and names the branch; with null it only names the branch. Never rejects.
export async function nameTask(askCheapModel:Operations['askCheapModel'],m:Machine,task:string,projects:Project[]|null):Promise<Named>{
 const text=withoutAttachments(task).trim();if(!text)return {reason:'任务描述里没有文字'};
 let r;try{r=await askCheapModel(m,'~/',projects?routingPrompt(text,projects):namingPrompt(text),{timeoutMs});}
 catch(e){return {reason:e.timedOut?`${timeoutMs/1000} 秒内没有返回`:`无法运行 claude：${e.message}`};}
 const named=branchOf(r);if(!projects||r.code!==0)return named;
 const picked=/^PROJECT=(.*)$/m.exec(r.stdout)?.[1].trim(),project=projects.find(p=>p.name===picked);
 return {...project&&{project},...named};
}
