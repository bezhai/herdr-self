import {text,uuid,oneOf} from './core.ts';
import type {Store} from './core.ts';
import type {Machine,Project,State,WorkMode} from './state.ts';
// Projects (see Project in state.ts): the repositories, skills and work mode that a topic works with, apart from the chat it comes from and
// the agent that runs it.
const workModes:WorkMode[]=['isolated','shared'];
const descriptionLimit=500,repoLimit=20;
// A remote repository: an http, https, ssh or git URL, or the scp form user@host:path. Nothing that git takes as an option, a helper
// (ext::) or a local path.
const remote=/^(?:(?:https?|ssh|git):\/\/[^\s/@]+(?:@[^\s/]+)?(?:\/[^\s]*)?|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+)$/;
function repoUrl(v:unknown){if(typeof v!=='string'||v.length>300||!remote.test(v.trim())||/^\w+:\/\/[^/]*$/.test(v.trim()))throw Error('仓库地址无效');return v.trim();}
// The host and the path of a repository URL, lower-cased host first, without user, port, trailing slashes and .git: what two URLs of one
// repository share, whether ssh or https.
export function repoKey(url:string){
 const m=/^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+(?=\/))?[:/](.*)$/.exec(url.trim())!;
 return m[1].toLowerCase()+'/'+m[2].replace(/\/+$/,'').replace(/\.git$/,'');
}
// The name of a repository: the last part of its path.
export const repoName=(url:string)=>repoKey(url).split('/').at(-1)!;
// base, or base 2, base 3, … when the names taken have it.
export function uniqueName(base:string,taken:Iterable<string>){
 const names=new Set(taken);let name=base;for(let n=2;names.has(name);n++)name=`${base} ${n}`;return name;
}
function description(v:unknown){
 if(v==null)return '';if(typeof v!=='string'||v.trim().length>descriptionLimit)throw Error('描述过长');return v.trim();
}
function repoList(v:unknown){
 if(v==null)return [];if(!Array.isArray(v)||v.length>repoLimit)throw Error('仓库地址无效');
 const urls=v.map(repoUrl);return urls.filter((url,i)=>urls.findIndex(x=>repoKey(x)===repoKey(url))===i);
}
function skillList(v:unknown,known:Pick<State,'skills'>['skills']){
 if(v==null)return [];if(!Array.isArray(v))throw Error('skill 不存在：'+String(v));
 const names=[...new Set<unknown>(v)];for(const s of names)if(typeof s!=='string'||!known.some(x=>x.name===s))throw Error('skill 不存在：'+String(s));
 return names as string[];
}
// The project that b describes, once checked: a new one, or old changed. Repositories come as a list of URLs without duplicates (by
// repoKey) and skills as names of the platform. A project that adopted a directory (migrated) keeps it, unless the change gives it
// repositories or isolated topics, which a directory of its own cannot serve: Bridge manages its directories from then on, and the old
// directory is left on the machine as it is.
export function normalizeProject(b:{name?:unknown,description?:unknown,repos?:unknown,skills?:unknown,workMode?:unknown,[field:string]:unknown},data:Pick<State,'projects'|'skills'>,old?:Project):Project{
 const name=text(b.name,60);if(data.projects.some(p=>p.id!==old?.id&&p.name===name))throw Error('已有同名的项目');
 const repos=repoList(b.repos),mode=b.workMode===undefined?old?.workMode??'isolated':b.workMode;if(!oneOf(workModes,mode))throw Error('话题目录无效');
 const adopted=old?.adopted&&!repos.length&&mode==='shared'?old.adopted:undefined;
 return {id:old?.id||uuid(),name,description:description(b.description),repos,skills:skillList(b.skills,data.skills),workMode:mode,...adopted&&{adopted}};
}
// Creates the project that b describes, or changes the one that b.id names (see normalizeProject), and saves it. Resolves to the project.
export function saveProject(store:Store,b:Parameters<typeof normalizeProject>[0]){
 const old=b.id===undefined?undefined:store.data.projects.find(p=>p.id===b.id);if(b.id!==undefined&&!old)throw Error('项目不存在');
 const project=normalizeProject(b,store.data,old);
 if(old){delete old.adopted;Object.assign(old,project);}else store.data.projects.push(project);
 store.save();return old??project;
}
// Removes a project, unless a binding has it as its default or a topic of it is starting or running: those still need it.
export function removeProject(store:Store,id:unknown){
 const project=store.data.projects.find(p=>p.id===id);if(!project)throw Error('项目不存在');
 if(store.data.bindings.some(b=>b.defaultProjectId===project.id))throw Error('请先修改使用该项目的会话绑定');
 if(store.data.topics.some(t=>t.projectId===project.id&&['starting','ready'].includes(t.state)))throw Error('该项目还有进行中的话题');
 store.data.projects=store.data.projects.filter(p=>p!==project);store.save();
}
// Fills the empty description of a project that has repositories with one sentence about them, which the cheap model writes on a machine
// from their READMEs, describe(m,repos): the first of the online machines. It is for the background, after a save: it keeps what a person
// wrote or changed meanwhile, and a machine that cannot answer is only logged. Never rejects.
export async function fillDescription(store:Store,p:Project,online:()=>Machine[],describe:(m:Machine,repos:string[])=>Promise<{description:string}>){
 const [m]=online(),repos=[...p.repos];if(p.description||!repos.length||!m)return;
 let answer;try{answer=await describe(m,repos);}catch(e){store.log('项目',`${p.name}：未能从仓库生成描述，${e.message}`,'error');return;}
 const description=answer.description.trim().slice(0,descriptionLimit);
 if(!description||p.description||!store.data.projects.includes(p)||p.repos.join('\n')!==repos.join('\n'))return;
 p.description=description;store.save();
}
