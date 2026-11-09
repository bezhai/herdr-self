import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invalid,local,name} from './machine-tools.ts';
import {repoKey,repoName} from './projects.ts';
import type {Git} from './machine-tools.ts';
import type {Ran,WorkspaceProject,ClientApi,Methods} from './link.ts';
// The directories and repositories of projects on a machine (the errors that Bridge words itself end up in the console, so they name
// neither a path nor a worktree): prepareWorkspace, removeWorkspace and describeRepos (see ClientApi in
// link.ts). The control plane never names a path (except an adopted directory, which it only passes back); Bridge's own directories are
// under ~/.local/share/herdr-bridge, where the skill store is:
//   repos/<host>__<path>        the one clone per repository on this machine, whose worktrees the isolated topics work in
//   topics/<topic id>/<name>    the worktree of a repository for a topic of an isolated project (<name> is the repository's name);
//                               topics/<topic id> is also the empty directory of an isolated project without repositories
//   projects/<project id>/...   the directory of a shared project: a checkout of each repository, or nothing for a project without any
// A project with one repository starts its agent in that repository's worktree or checkout, one with several in the directory above them.
// It uses only Node's built-in modules, like the client.

const dataRoot=()=>path.join(os.homedir(),'.local','share','herdr-bridge');
const exists=(p:string)=>fs.promises.stat(p).then(()=>true,()=>false);
const isEmpty=async(dir:string)=>(await fs.promises.readdir(dir)).length===0;
// A clone or a worktree is a directory with .git (a file in a worktree).
const checkedOut=(dir:string)=>exists(path.join(dir,'.git'));
const failure=(what:string,r:Ran)=>Error(`${what}失败：${(r.stderr||r.stdout).trim().slice(-300)||`退出码 ${r.code}`}`);
// The URL of a repository, which Git takes as a place and never as an option, and whose host and path name the clone.
function repoUrl(v:unknown){
 if(typeof v!=='string'||!v||v.startsWith('-')||/[\s\0]/.test(v))throw invalid('repos');
 try{repoKey(v);}catch{throw invalid('repos');}
 return v;
}
// A name that is one path segment below a directory.
const segment=(v:string,what:string)=>{if(!/^[\w.-]+$/.test(v)||/^\.+$/.test(v))throw invalid(`${what}：${v}`);return v;};
// The project of a request, once checked, with each repository's clone and name: the name is the last part of its path, and a repository whose
// name an earlier one has already gets -2, -3, … after it.
type Repo={url:string,clone:string,name:string};
function projectOf(v:WorkspaceProject){
 if(!v||typeof v!=='object'||!Array.isArray(v.repos))throw invalid('project');
 if(!['isolated','shared'].includes(v.workMode))throw invalid('workMode');
 const taken=new Set<string>(),repos:Repo[]=v.repos.map(u=>{
  const url=repoUrl(u),base=segment(repoName(url),'repos');let n=base;for(let i=2;taken.has(n);i++)n=`${base}-${i}`;taken.add(n);
  return {url,clone:path.join(dataRoot(),'repos',repoKey(url).replaceAll('/','__')),name:n};
 });
 return {id:name(v.id,'project'),workMode:v.workMode,repos,...v.adoptedDir!==undefined&&{adoptedDir:local(v.adoptedDir,'adoptedDir')}};
}
// A branch that Git takes as the name of a branch and never as an option.
async function branchName(git:Git,v:unknown){
 if(typeof v!=='string'||!v||v.startsWith('-'))throw invalid('branch');
 const r=await git(os.tmpdir(),['check-ref-format','--branch',v]);if(r.code!==0)throw invalid(`branch：${v}`);
 return v;
}
// Steps on one repository or one directory run one after the other, so that topics that start at once do not clone it twice or fight over
// its worktrees.
const queues=new Map<string,Promise<unknown>>();
function serial<T>(key:string,step:()=>Promise<T>){
 const done=(queues.get(key)??Promise.resolve()).then(step,step),tail=done.then(()=>{},()=>{}).then(()=>{if(queues.get(key)===tail)queues.delete(key);});
 queues.set(key,tail);return done;
}
// Clones url to target, through a directory beside it that a clone cut short leaves behind and the next one removes, so that target is
// a whole clone or nothing.
async function clone(git:Git,url:string,target:string,timeoutMs?:number){
 const partial=target+'.cloning';await fs.promises.rm(partial,{recursive:true,force:true});await fs.promises.mkdir(path.dirname(target),{recursive:true});
 const r=await git(path.dirname(target),['clone','--',url,partial],timeoutMs);if(r.code!==0){await fs.promises.rm(partial,{recursive:true,force:true});throw failure(`git clone ${url} `,r);}
 await fs.promises.rename(partial,target);
}
const fetch=async(git:Git,dir:string,timeoutMs?:number)=>{const r=await git(dir,['fetch','--prune','origin'],timeoutMs);if(r.code!==0)throw failure('git fetch ',r);};
// The managed clone of a repository, made when it is missing.
async function ensureClone(git:Git,repo:Repo,timeoutMs?:number){if(!await checkedOut(repo.clone))await clone(git,repo.url,repo.clone,timeoutMs);}
// The default branch of origin in a clone, as origin/<branch>: what the clone was made at, else what origin says now.
async function defaultBranch(git:Git,dir:string,timeoutMs?:number){
 const read=()=>git(dir,['symbolic-ref','--short','refs/remotes/origin/HEAD'],timeoutMs);
 let r=await read();if(r.code!==0){await git(dir,['remote','set-head','origin','--auto'],timeoutMs);r=await read();}
 if(r.code!==0)throw Error('origin 没有默认分支，仓库里还没有提交？');
 return r.stdout.trim();
}
const hasRef=async(git:Git,dir:string,ref:string)=>(await git(dir,['show-ref','--verify','--quiet',ref])).code===0;
// The worktree of branch at target in clone: the branch as it is when this clone has it, else tracking the branch of origin when origin has it,
// else a new branch from the default branch of origin, which does not track it.
async function addWorktree(git:Git,dir:string,target:string,branch:string,timeoutMs?:number){
 await fs.promises.mkdir(path.dirname(target),{recursive:true});
 if(await exists(target)){if(!await isEmpty(target))throw Error('话题的目录已存在，里面有别的内容');await fs.promises.rmdir(target);}
 await git(dir,['worktree','prune']);
 let args:string[];
 if(await hasRef(git,dir,'refs/heads/'+branch))args=['worktree','add',target,branch];
 else if(await hasRef(git,dir,'refs/remotes/origin/'+branch))args=['worktree','add','--track','-b',branch,target,'origin/'+branch];
 else args=['worktree','add','--no-track','-b',branch,target,await defaultBranch(git,dir,timeoutMs)];
 const r=await git(dir,args,timeoutMs);if(r.code!==0)throw failure(`为分支 ${branch} 创建话题目录`,r);
}
// The directory in which a shared project works, and the checkout of each of its repositories in it, cloned when missing and otherwise
// fetched when it can be, never changed.
async function shared(git:Git,dir:string,repos:Repo[],timeoutMs?:number){
 await fs.promises.mkdir(dir,{recursive:true});
 await serial(dir,async()=>{
  for(const r of repos){
   const target=path.join(dir,r.name);
   if(await checkedOut(target))await fetch(git,target,timeoutMs).catch(()=>{});
   else if(await exists(target)&&!await isEmpty(target))throw Error(`项目的目录里已有 ${r.name}，不是 Git 仓库，没有往里面 clone`);
   else{await fs.promises.rm(target,{recursive:true,force:true});await clone(git,r.url,target,timeoutMs);}
  }
 });
}
// Whether branch of clone has no commit of its own: nothing beyond the default branch of origin. A clone that cannot tell has.
async function pristine(git:Git,dir:string,branch:string){
 try{const n=await git(dir,['rev-list','--count',`${await defaultBranch(git,dir)}..refs/heads/${branch}`]);return n.code===0&&n.stdout.trim()==='0';}catch{return false;}
}
// The README of the repository in dir, up to what a prompt may hold.
const readmeLimit=4000;
async function readme(dir:string){
 const names=(await fs.promises.readdir(dir)).filter(n=>/^readme(\.\w+)?$/i.test(n)).sort((a,b)=>Number(/\.md$/i.test(b))-Number(/\.md$/i.test(a)));
 return names.length?(await fs.promises.readFile(path.join(dir,names[0]),'utf8')).slice(0,readmeLimit):null;
}
// The three methods, with git (see gitRunner).
export function workspaceMethods(git:Git):Pick<Methods<ClientApi>,'prepareWorkspace'|'removeWorkspace'|'describeRepos'>{
 return {
  // See ClientApi in link.ts. The directory of an isolated topic with repositories is the worktree of its only repository, else the
  // directory of the topic with a worktree per repository.
  async prepareWorkspace({project:given,topicId,branch:wanted,timeoutMs}){
   const project=projectOf(given),id=name(topicId,'topicId');
   if(project.adoptedDir||project.workMode==='shared'){
    const dir=project.adoptedDir??path.join(dataRoot(),'projects',project.id);await shared(git,dir,project.repos,timeoutMs);
    return {dir:!project.adoptedDir&&project.repos.length===1?path.join(dir,project.repos[0].name):dir};
   }
   const dir=path.join(dataRoot(),'topics',id);
   if(!project.repos.length){await fs.promises.mkdir(dir,{recursive:true});return {dir};}
   const branch=await branchName(git,wanted);
   for(const r of project.repos){
    const target=path.join(dir,r.name);
    await serial(r.clone,async()=>{
     await ensureClone(git,r,timeoutMs);if(await checkedOut(target))return;
     await fetch(git,r.clone,timeoutMs);await addWorktree(git,r.clone,target,branch,timeoutMs);
    });
   }
   return {dir:project.repos.length===1?path.join(dir,project.repos[0].name):dir};
  },
  // See ClientApi in link.ts. The worktrees go with the directory of the topic, also when they have changes that are not committed: the work
  // that is worth keeping is on the branch.
  async removeWorkspace({project:given,topicId,branch:wanted,timeoutMs}){
   const project=projectOf(given),id=name(topicId,'topicId');
   if(project.adoptedDir||project.workMode==='shared')return {branchKept:false};
   const dir=path.join(dataRoot(),'topics',id),branch=wanted===undefined?undefined:await branchName(git,wanted);let kept=false;
   for(const r of project.repos){
    await serial(r.clone,async()=>{
     if(!await checkedOut(r.clone))return;
     const target=path.join(dir,r.name);
     if(await exists(target))await git(r.clone,['worktree','remove','--force',target],timeoutMs);
     await git(r.clone,['worktree','prune'],timeoutMs);
     if(branch===undefined||!await hasRef(git,r.clone,'refs/heads/'+branch))return;
     if(!await pristine(git,r.clone,branch)||(await git(r.clone,['branch','-D',branch],timeoutMs)).code!==0)kept=true;
    });
   }
   await fs.promises.rm(dir,{recursive:true,force:true});return {branchKept:kept};
  },
  // See ClientApi in link.ts. A repository that cannot be cloned or has no README is left out, as long as another gives the model something to read.
  async describeRepos({repos,timeoutMs}){
   if(!Array.isArray(repos)||!repos.length)throw invalid('repos');
   const found:{name:string,text:string}[]=[];let failed:Error|undefined;
   for(const url of repos.map(repoUrl)){
    const repo:Repo={url,clone:path.join(dataRoot(),'repos',repoKey(url).replaceAll('/','__')),name:segment(repoName(url),'repos')};
    try{await serial(repo.clone,()=>ensureClone(git,repo,timeoutMs));const text=await readme(repo.clone);if(text)found.push({name:repo.name,text});}catch(e){failed??=e;}
   }
   if(!found.length)throw failed??Error('这些仓库里都没有 README');
   return {readmes:found};
  },
 };
}
