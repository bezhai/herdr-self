import {repoOf,validRefName,localBranch,worktreePath,namingPrompt,branchOf,randomBranch,continueBranch} from './worktree-branch.mjs';
import {publicText} from './core.mjs';
import {slash} from './commands.mjs';
import {withoutAttachments} from './attachments.mjs';
import {card,plain,by} from './request-cards.mjs';
import {home} from './adoption.mjs';
// /wt topics (see Topics): a root message `/wt <description>` or `/wt -b <branch> [description]` opens a topic whose agent works in a new
// Git worktree of the repository of the binding's directory, beside that repository on the binding's machine. The worktree stays when the
// topic ends; the card of a topic without an agent offers removing it. Everything runs on that machine: git, test and claude through exec
// (see core.mjs), the rest through the Herdr CLI. The branch and the path come from worktree-branch.mjs, which the wt plugin shares.
export const usage=`用法：${slash.wt} <任务描述>，或 ${slash.wt} -b <已有分支> [任务描述]`;
export const notRetried=`这个 worktree 话题没有启动成功，请重新发送 ${slash.wt} 开新话题`;
// The request of a root message whose text is a /wt command: {branch, description, prompt}. branch is the one after -b, or undefined;
// description the text after the command and its option as the person wrote it, with the markup of its attachments; prompt what the agent
// gets, the description or else the request to continue on the branch. {usage:true} for the command with neither, or with -b and no
// branch; null for any other text.
export function wtRequest(text){
 const m=new RegExp(`^${slash.wt}(?=\\s|$)\\s*([\\s\\S]*)$`).exec(text);if(!m)return null;
 let rest=m[1],branch;
 const b=/^-b(?=\s|$)\s*(\S*)\s*/.exec(rest);
 if(b){if(!b[1])return {usage:true};branch=b[1];rest=rest.slice(b[0].length);}
 const description=rest.trim();if(!description&&!branch)return {usage:true};
 return {branch,description,prompt:description||continueBranch(branch)};
}
// How long the naming may take before the branch is random, and how long Herdr may take to check out or remove a worktree.
const namingTimeoutMs=30000,createTimeoutMs=120000,removeTimeoutMs=60000;
// git on machine m (see worktree-branch.mjs). It never prompts, and it speaks English, whose messages removeWorktree recognizes.
const gitOn=(exec,m)=>(cwd,args,options)=>exec(m,['env','GIT_TERMINAL_PROMPT=0','LC_ALL=C','git','-C',{path:cwd},...args],options);
const exists=async(exec,m,p)=>(await exec(m,['test','-e',{path:p}])).code===0;
// A failed step, with Herdr's error code where it has one.
const failure=(what,e)=>Error(e.code?`${what}（${e.code}：${e.message}）`:`${what}：${e.message}`);
const reasonOf=e=>publicText(typeof e.code==='string'?`${e.message}（${e.code}）`:e.message).slice(0,1000);
// Asks Claude haiku on machine m, in the main checkout root, for a branch name for description, with the prompt of the wt plugin. claude
// runs through the user's shell, like any SSH command, so that it is found where the user installed it, also on the machine of Bridge
// itself (see remoteInvocation), and without the HERDR_* variables (see exec): its Herdr hook would report to the pane in HERDR_PANE_ID.
// Resolves to {branch} or {reason}.
async function nameBranch(exec,m,root,description){
 const text=withoutAttachments(description).trim();if(!text)return {reason:'任务描述里没有文字'};
 let r;try{r=await exec(m,['sh','-c','cd -- "$1" && exec claude -p --model haiku','sh',root],{input:namingPrompt(text),timeoutMs:namingTimeoutMs,shell:true});}
 catch(e){return {reason:e.timedOut?`${namingTimeoutMs/1000} 秒内没有返回`:`无法运行 claude：${e.message}`};}
 return branchOf(r);
}
// Creates on machine m the worktree of request r ({branch, description}, see wtRequest) for the repository of directory cwd, with the
// steps of the wt plugin: from the main checkout, at the HEAD of cwd, on the branch of -b or one named after the description, and the
// workspace that Herdr opens for it in the repository's group, without changing focus. save(worktree) gets {branch, path, root}, root
// being the main checkout, once they are known and before the worktree is created. Resolves to {worktree, workspaceId, tabId, paneId,
// notes, created}: notes for the first reply, such as why the branch is random, and created what exists now. A failure rejects with an
// Error whose created lists what exists by then, which stays in place, and whose kept tells that the worktree exists.
export async function createWorktree(m,cwd,{branch:given,description},{exec,herdr,save}){
 const created=[],notes=[],git=gitOn(exec,m);let kept=false;
 try{
  const repo=await repoOf(git,cwd);
  if(repo.linked)notes.push(`绑定目录在 linked worktree 里，新分支基于它的 HEAD ${repo.base.slice(0,12)}`);
  let branch=given;
  if(given){if(!await validRefName(git,repo.mainRoot,given))throw Error(`分支名无效：${given}`);}
  else{const named=await nameBranch(exec,m,repo.mainRoot,description);branch=named.branch??randomBranch();if(!named.branch)notes.push(`起名失败（${named.reason}），改用随机分支名`);}
  const target=worktreePath(repo.mainRoot,branch);
  if(await exists(exec,m,target))throw Error(`目录已存在：${target}，不会覆盖它；换一个分支，或者先处理这个目录`);
  const local=await localBranch(git,repo.mainRoot,branch);
  if(given&&local==='none')throw Error(`本地和 origin 都没有分支 ${branch}`);
  if(local==='tracking'){created.push(`本地分支 ${branch}（跟踪 origin/${branch}）`);notes.push(`已从 origin/${branch} 建立跟踪它的本地分支`);}
  const worktree={branch,path:target,root:repo.mainRoot};save(worktree);
  let made;
  try{made=await herdr(m,['worktree','create','--cwd',repo.mainRoot,'--branch',branch,'--path',target,...repo.base?['--base',repo.base]:[],'--no-focus'],{timeoutMs:createTimeoutMs});}
  catch(e){if(await exists(exec,m,target).catch(()=>false)){kept=true;created.push(`worktree ${target}（分支 ${branch}），Herdr 没有为它打开 workspace`);}throw failure('创建 worktree 失败',e);}
  kept=true;created.push(`worktree ${target}（分支 ${branch}）`);
  const workspaceId=made?.workspace?.workspace_id,paneId=made?.root_pane?.pane_id;
  if(!workspaceId||!paneId)throw Error('herdr worktree create 的返回里没有 workspace 或 root_pane');
  created.push(`workspace ${workspaceId}，pane ${paneId}`);
  return {worktree,workspaceId,tabId:made.tab?.tab_id||'',paneId,notes,created};
 }catch(e){throw Object.assign(e,{created,kept});}
}
// The first reply of a /wt topic on machine m, once createWorktree made its worktree.
export const worktreeIntro=(m,{worktree,notes})=>[`已在 ${m.name} 新建 worktree`,`分支：${worktree.branch}`,`路径：${home(worktree.path)}`,...notes].join('\n');
// What a /wt topic whose start failed with error e says: the reason, then what exists, which stays in place.
export const failedText=(e,created)=>`启动失败：${reasonOf(e)}\n${created.length?['已经创建、保持原样（没有回滚）的有：',...created.map(c=>'- '+c)].join('\n'):'没有创建任何东西'}`;
// Removes worktree w ({path, root}) of a topic on machine m and keeps its branch, unless the worktree has changes that are not committed.
// Resolves to {gone} when it is not there any more, which counts as removed, to {dirty}, the lines of git status, when it refuses, and to
// {removed}. Herdr removes a worktree that it has open, which also closes its workspace; git removes any other. Herdr reuses workspace
// ids, so the workspace is the one that Herdr lists for the path now, not the one the topic recorded.
export async function removeWorktree(m,w,{exec,herdr}){
 if(!await exists(exec,m,w.path))return {gone:true};
 const git=gitOn(exec,m),status=await git(w.path,['-c','core.quotePath=false','status','--porcelain','--untracked-files=all']);
 if(status.code!==0)throw Error(`git status 失败：${(status.stderr||status.stdout).trim()}`);
 const dirty=status.stdout.split('\n').filter(Boolean);if(dirty.length)return {dirty};
 const {worktrees=[]}=await herdr(m,['worktree','list','--cwd',w.root]),open=worktrees.find(x=>x.path===w.path)?.open_workspace_id;
 if(open){
  try{await herdr(m,['worktree','remove','--workspace',open],{timeoutMs:removeTimeoutMs});}
  catch(e){if(e.code==='dirty_worktree_requires_force')return {dirty:[]};throw failure('herdr worktree remove 失败',e);}
  return {removed:true};
 }
 const r=await git(w.root,['worktree','remove',w.path],{timeoutMs:removeTimeoutMs});
 if(r.code===0)return {removed:true};
 if(/contains modified or untracked files/.test(r.stderr))return {dirty:[]};
 throw Error(`git worktree remove 失败：${r.stderr.trim()||`退出码 ${r.code}`}`);
}
// What a click that removed nothing says: the changes that are not committed, at most 10 lines of git status with file names as they
// are, or why it failed.
export const dirtyText=lines=>['worktree 里有未提交的改动，没有删除'+(lines.length?'：':''),...lines.slice(0,10),...lines.length>10?['…']:[]].join('\n');
export const removalFailed=e=>`删除失败：${reasonOf(e)}`;
const hint='worktree 已保留。删除时如有未提交的改动会拒绝，分支始终保留';
// The card of a /wt topic without an agent, which offers removing its worktree w ({branch, path}). heading and text say what happened
// (the topic ended, or its start failed and what exists), then come the branch and the path, and the 删除 worktree button after a hint,
// or after outcome.text when a click removed nothing; once a click removed it, outcome.removed and the person who clicked (outcome.openId)
// take the button's place. Every drawing needs its own render number (see pending in request-cards.mjs): the channel drops a click that
// repeats the card, person and button value of an earlier one, and the button of a refused click is clicked again.
export function removalCard({heading,text},w,render,outcome){
 const body=[plain(text),plain(`分支：${w.branch}\n路径：${home(w.path)}`)];
 if(outcome?.removed)return card(heading,'green',[...body,by(outcome.removed,outcome.openId)]);
 return card(heading,outcome?'orange':'grey',[...body,plain(outcome?.text||hint),{tag:'button',text:{tag:'plain_text',content:'删除 worktree'},type:'danger',behaviors:[{type:'callback',value:{worktree:'remove',render}}]}]);
}
