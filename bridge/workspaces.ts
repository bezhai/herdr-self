import type {Project,Topic} from './state.ts';
import type {WorkspaceProject} from './link.ts';
// The project of a topic that has none (a direct chat that found none) works in an empty directory of its own, as a project without
// repositories whose topics are isolated; none is no id of a real project, which are uuids.
const emptyProject:WorkspaceProject={id:'none',repos:[],workMode:'isolated'};
// project as the client of machine machineId needs it to prepare or remove a workspace (see ClientApi in link.ts): the directory that a
// project adopted counts only on the machine it adopted it on.
export const workspaceOf=(p:Project|undefined,machineId:string):WorkspaceProject=>
 !p?emptyProject:{id:p.id,repos:p.repos,workMode:p.workMode,...p.adopted?.machineId===machineId&&{adoptedDir:p.adopted.dir}};
// Whether the worktrees of project p have a branch of their own: it has repositories and gives each topic a directory.
export const hasBranch=(p:Project|undefined)=>Boolean(p?.repos.length&&p.workMode==='isolated');
// branch, or the first of branch-2, branch-3, … that no other topic of topics has. Git lets only one worktree have a branch, so a second
// topic on the name of a topic that still has its worktree could not start, and one on the name of a topic that was swept would take over
// the commits that the sweep kept.
export const freeBranch=(branch:string,t:Topic,topics:Topic[])=>{
 const taken=new Set(topics.filter(x=>x!==t).map(x=>x.branch));
 let free=branch;for(let n=2;taken.has(free);n++)free=`${branch}-${n}`;return free;
};
// How long a topic that ended or failed keeps its workspace (see Topics.sweep).
export const keepFor=7*24*3600000;
// Whether topic t has a workspace that nothing uses: it was prepared for the topic (not one of before the projects, nor an adopted one),
// the topic ended or failed, and the workspace is not removed yet.
export const unused=(t:Topic)=>Boolean(t.routed&&!t.adopted&&!t.swept&&['closed','failed'].includes(t.state));
// Whether the workspace of topic t is to be removed at time now: it is unused and the topic ended more than keepFor ago.
export const sweepable=(t:Topic,now:number)=>unused(t)&&t.endedAt!=null&&now-t.endedAt>keepFor;
