import path from 'node:path';
import {run} from './herdr.mjs';
const git=(cwd,args,options)=>run('git',['-C',cwd,...args],options);
// The checkout that dir is in. Herdr creates worktrees from the main checkout only (linked_worktree_source), so mainRoot is the main
// checkout also when dir is in a linked worktree; base is then that worktree's HEAD, which the new branch starts from. Elsewhere base is
// undefined and Herdr uses HEAD of the main checkout.
export async function repoOf(dir){
 const r=await git(dir,['rev-parse','--path-format=absolute','--git-dir','--git-common-dir']);
 if(r.code!==0)throw Error(`${dir} 不在 Git 仓库中`);
 const [gitDir,commonDir]=r.stdout.trim().split('\n');
 if(path.basename(commonDir)!=='.git')throw Error(`不支持这种仓库布局（${commonDir}）：主 checkout 需要有 .git 目录`);
 const mainRoot=path.dirname(commonDir),linked=gitDir!==commonDir;if(!linked)return {mainRoot,linked};
 const head=await git(dir,['rev-parse','--verify','HEAD']);if(head.code!==0)throw Error(`${dir} 的 HEAD 还没有提交`);
 return {mainRoot,linked,base:head.stdout.trim()};
}
// Worktrees of a repository live beside it: /src/genvi gets /src/genvi-worktrees/feat-x for branch feat/x.
export const worktreePath=(mainRoot,branch)=>path.join(path.dirname(mainRoot),`${path.basename(mainRoot)}-worktrees`,branch.replaceAll('/','-'));
export async function validRefName(mainRoot,branch){return (await git(mainRoot,['check-ref-format','--branch',branch])).code===0;}
// Makes sure branch is a local branch where it can be. One that exists locally is used as it is ('local'). Otherwise origin's branch of
// that name, fetched now, becomes a local branch that tracks it ('tracking'), since Herdr only checks out local branches and would
// start a new one from the base instead. 'none' means neither has it. A fetch that fails (no origin, no network, no such branch) only
// means there is nothing to track.
export async function localBranch(mainRoot,branch){
 if((await git(mainRoot,['show-ref','--verify','--quiet',`refs/heads/${branch}`])).code===0)return 'local';
 await git(mainRoot,['fetch','--quiet','origin',`+refs/heads/${branch}:refs/remotes/origin/${branch}`],{timeoutMs:60000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if((await git(mainRoot,['show-ref','--verify','--quiet',`refs/remotes/origin/${branch}`])).code!==0)return 'none';
 const r=await git(mainRoot,['branch','--track',branch,`origin/${branch}`]);
 if(r.code!==0)throw Error(`创建跟踪 origin/${branch} 的本地分支失败：${r.stderr.trim()}`);
 return 'tracking';
}
