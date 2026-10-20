// The branch and the directory of a task that starts in a new Git worktree, for Bridge's /wt topics (see worktrees.mjs) and the
// worktree-task plugin of this repository (plugins/worktree-task), which imports this file from the checkout. Only Node built-ins: the
// plugin has no dependencies, and Bridge is deployed as a directory of its own.
import crypto from 'node:crypto';import path from 'node:path';
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
// The branch that the answer r ({code, stdout, stderr}) of `claude -p --model haiku` to namingPrompt names: {branch}, or {reason} when
// claude exited with an error or named none that fits. A call that cannot run or does not answer in time is the caller's to tell.
export function branchOf(r){
 if(r.code!==0)return {reason:`claude 退出码 ${r.code}：${r.stderr.trim().slice(-300)}`};
 const branch=parseBranch(r.stdout);
 return branch&&validBranch(branch)?{branch}:{reason:`输出里没有可用的 BRANCH= 行：${r.stdout.trim().slice(0,300)}`};
}
// The fallback when naming fails, in the form of the names Herdr generates itself (generated_branch_slug in src/worktree.rs), which a
// worktree beside the repository cannot use: its path has to be known before Herdr picks the name.
const adjectives=['brave','calm','clear','green','lucky','quiet','rapid','silver'],nouns=['river','cloud','field','forest','harbor','meadow','stone','valley'];
export const randomBranch=()=>`worktree/${adjectives[crypto.randomInt(8)]}-${nouns[crypto.randomInt(8)]}-${crypto.randomBytes(2).toString('hex')}`;
// What the agent of an existing branch gets when the task names no description.
export const continueBranch=branch=>`Continue work on branch ${branch}`;
// Worktrees of a repository live beside it: /src/genvi gets /src/genvi-worktrees/feat-x for branch feat/x. Paths are those of the machine
// that holds the repository, which is Linux or macOS.
export const worktreePath=(mainRoot,branch)=>path.posix.join(path.posix.dirname(mainRoot),`${path.posix.basename(mainRoot)}-worktrees`,branch.replaceAll('/','-'));
// The functions below run git through git(cwd, args, {timeoutMs}), which runs git in directory cwd without ever prompting for credentials
// and resolves to {code, stdout, stderr}; it rejects, or resolves with a code other than 0, when git cannot run or finish in time.
// The checkout that dir is in. Herdr creates worktrees from the main checkout only (linked_worktree_source), so mainRoot is the main
// checkout also when dir is in a linked worktree; base is then that worktree's HEAD, which the new branch starts from. Elsewhere base is
// undefined and Herdr uses HEAD of the main checkout, which is the HEAD of dir.
export async function repoOf(git,dir){
 const r=await git(dir,['rev-parse','--path-format=absolute','--git-dir','--git-common-dir']);
 if(r.code!==0)throw Error(`${dir} 不在 Git 仓库中`);
 const [gitDir,commonDir]=r.stdout.trim().split('\n');
 if(path.posix.basename(commonDir)!=='.git')throw Error(`不支持这种仓库布局（${commonDir}）：主 checkout 需要有 .git 目录`);
 const mainRoot=path.posix.dirname(commonDir),linked=gitDir!==commonDir;if(!linked)return {mainRoot,linked};
 const head=await git(dir,['rev-parse','--verify','HEAD']);if(head.code!==0)throw Error(`${dir} 的 HEAD 还没有提交`);
 return {mainRoot,linked,base:head.stdout.trim()};
}
export async function validRefName(git,mainRoot,branch){return (await git(mainRoot,['check-ref-format','--branch',branch])).code===0;}
// Makes sure branch is a local branch where it can be. One that exists locally is used as it is ('local'). Otherwise origin's branch of
// that name, fetched now, becomes a local branch that tracks it ('tracking'), since Herdr only checks out local branches and would
// start a new one from the base instead. 'none' means neither has it. A fetch that fails (no origin, no network, no such branch) only
// means there is nothing to track.
export async function localBranch(git,mainRoot,branch){
 if((await git(mainRoot,['show-ref','--verify','--quiet',`refs/heads/${branch}`])).code===0)return 'local';
 await git(mainRoot,['fetch','--quiet','origin',`+refs/heads/${branch}:refs/remotes/origin/${branch}`],{timeoutMs:60000});
 if((await git(mainRoot,['show-ref','--verify','--quiet',`refs/remotes/origin/${branch}`])).code!==0)return 'none';
 const r=await git(mainRoot,['branch','--track',branch,`origin/${branch}`]);
 if(r.code!==0)throw Error(`创建跟踪 origin/${branch} 的本地分支失败：${r.stderr.trim()}`);
 return 'tracking';
}
