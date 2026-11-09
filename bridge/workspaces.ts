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
// How long a topic that ended or failed keeps its workspace (see Topics.sweep).
export const keepFor=7*24*3600000;
// Whether the workspace of topic t is to be removed at time now: it was prepared for the topic (not one of before the projects, nor an
// adopted one), the topic ended or failed more than keepFor ago and the workspace is not removed yet.
export const sweepable=(t:Topic,now:number)=>Boolean(t.routed&&!t.adopted&&!t.swept&&t.endedAt!=null&&['closed','failed'].includes(t.state)&&now-t.endedAt>keepFor);
