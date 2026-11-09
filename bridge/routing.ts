import {namingPrompt,branchRules,branchFromText} from './worktree-branch.mjs';
import {withoutAttachments} from './attachments.ts';
import type {AskModel} from './model.ts';
import type {Project} from './state.ts';
// What the cheap model decides when a topic starts: the branch of its worktrees and, in a direct chat, the project (see Topics.route). One
// call does both; with the project fixed it only names the branch, with the prompt that the worktree-task plugin uses.
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
// Asks the model about task (a message as a person wrote it, whose attachments count for nothing). With projects it picks one of them by
// name and names the branch; with null it only names the branch. Never rejects.
export async function nameTask(askModel:AskModel,task:string,projects:Project[]|null):Promise<Named>{
 const text=withoutAttachments(task).trim();if(!text)return {reason:'任务描述里没有文字'};
 let answer;try{answer=await askModel(projects?routingPrompt(text,projects):namingPrompt(text));}
 catch(e){return {reason:e.message};}
 const named=branchFromText(answer);if(!projects)return named;
 const picked=/^PROJECT=(.*)$/m.exec(answer)?.[1].trim(),project=projects.find(p=>p.name===picked);
 return {...project&&{project},...named};
}
