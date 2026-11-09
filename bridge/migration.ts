import path from 'node:path';
import {uuid} from './core.ts';
import {configName,permissionMode} from './agent-configs.ts';
import {repoKey,repoName,uniqueName} from './projects.ts';
import type {Store} from './core.ts';
import type {AgentConfig,Binding,Kind,Machine,PermissionMode,Project} from './state.ts';
// The migration of a state file from before projects and agent configurations (see Binding, Project and AgentConfig in state.ts). It runs
// in two steps: migrateBindings when the control plane loads the state, and convertAdopted for each machine once its client is connected,
// since only the client can tell what a directory is.

// A binding as an old state file has it: the chat, and with it the machine, the directory, the kind of agent and, for Claude, the permission
// mode that its topics start with, and the Herdr workspace of its topics.
type OldBinding={id:string,name:string,appId:string,machineId:string,chatId:string,cwd:string,kind:Kind,permissionMode?:PermissionMode,requireMention:boolean,enabled:boolean,workspaceId?:string};
const isOld=(b:object):b is OldBinding=>'cwd' in b||'kind' in b||'machineId' in b;
// The old file does not say whether a chat is a direct chat. A mention is required only in groups, so a binding that requires it is a group;
// one that does not is a group too, unless it was named a private chat, which is what the console called the binding of a direct chat.
const chatTypeOf=(b:OldBinding)=>b.requireMention||!b.name.includes('私聊')?'group':'p2p';
// A directory without the slashes at its end, which two bindings may or may not have written.
const trimmed=(dir:string)=>dir.length>1?dir.replace(/\/+$/,'')||'/':dir;
// Migrates the bindings of store that have the old fields, in one save and with a log line for the whole state and one for each project:
// - A directory of a machine becomes a shared project that adopts it, named after the last part of the directory (the machine's name for
//   a root directory); equal names get a number. Bindings of one machine and directory share a project. A direct chat gets no default
//   project, but its directory is in the pool like the others.
// - A machine, kind and permission mode (Claude only, default for a binding without one) become an agent configuration, named after the
//   machine and the kind, with the permission mode added where configurations would otherwise have the same name.
// - The binding keeps its id, its name and its chat; the topics and schedules that refer to it keep working. Its topics get the project and
//   the configuration of their binding and the directory the binding had, which they keep until they end; topics that adopted an agent
//   and those that wait for one to adopt have none.
// A state without such bindings is left as it is.
export function migrateBindings(store:Store){
 const {data}=store,old=data.bindings.filter(isOld);if(!old.length)return;
 const machineName=(id:string)=>data.machines.find(m=>m.id===id)?.name??'已删除的机器';
 const projects=new Map<string,Project>(),configs=new Map<string,AgentConfig>(),uses=new Map<Project,number>(),modes=new Map<AgentConfig,PermissionMode|undefined>();
 const projectOf=(b:OldBinding)=>{
  const dir=trimmed(b.cwd),key=b.machineId+' '+dir;let p=projects.get(key);
  if(!p){
   const name=uniqueName(path.posix.basename(dir)||machineName(b.machineId),data.projects.map(x=>x.name));
   p={id:uuid(),name,description:'',repos:[],skills:[],workMode:'shared',adopted:{machineId:b.machineId,dir}};projects.set(key,p);data.projects.push(p);
  }
  uses.set(p,(uses.get(p)??0)+1);return p;
 };
 const configOf=(b:OldBinding)=>{
  const mode=b.kind==='claude'?permissionMode(b):undefined,key=[b.machineId,b.kind,mode].join(' ');let c=configs.get(key);
  if(!c){c={id:uuid(),name:'',machineId:b.machineId,kind:b.kind,...mode&&{permissionMode:mode}};configs.set(key,c);modes.set(c,mode);}
  return c;
 };
 const migrated=new Map<string,{project:Project,config:AgentConfig,cwd:string}>();
 data.bindings=data.bindings.map(b=>{
  if(!isOld(b))return b;
  const project=projectOf(b),config=configOf(b),chatType=chatTypeOf(b);migrated.set(b.id,{project,config,cwd:b.cwd});
  return {id:b.id,name:b.name,appId:b.appId,chatId:b.chatId,chatType,requireMention:b.requireMention,enabled:b.enabled,...chatType==='group'&&{defaultProjectId:project.id},defaultAgentConfigId:config.id,
   ...b.workspaceId&&{workspaces:{[b.machineId]:b.workspaceId}}} satisfies Binding;
 });
 // Configurations of one machine and kind differ in the permission mode alone, which then tells their names apart.
 for(const c of configs.values()){
  const base=configName({name:machineName(c.machineId)},c.kind),same=[...configs.values()].filter(x=>x.machineId===c.machineId&&x.kind===c.kind).length>1;
  c.name=uniqueName(same?`${base} · ${modes.get(c)}`:base,[...data.agentConfigs.map(x=>x.name),...[...configs.values()].map(x=>x.name)]);
 }
 data.agentConfigs.push(...configs.values());
 for(const t of data.topics){
  const m=migrated.get(t.bindingId);if(!m||t.adopted||t.state==='choosing')continue;
  Object.assign(t,{projectId:m.project.id,agentConfigId:m.config.id,cwd:t.cwd??m.cwd});
 }
 store.log('数据迁移',`${old.length} 个会话绑定已迁移为 ${projects.size} 个项目和 ${configs.size} 个 Agent 配置`);
 for(const p of projects.values())store.log('数据迁移',`项目「${p.name}」沿用 ${machineName(p.adopted!.machineId)} 上的 ${p.adopted!.dir}，被 ${uses.get(p)} 个会话绑定使用`);
}
// The name that migrateBindings gave a project, which a person may have changed since: the last part of its directory, with a number.
const given=(p:Project)=>new RegExp(`^${path.posix.basename(p.adopted!.dir).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}( \\d+)?$`).test(p.name);
// Asks the client of machine m about the directory that each project adopted there and that nobody asked about yet, one project after the
// other, with inspect(m,dir), which resolves to {origin} (see inspectDirectory in link.ts). A directory that is the root of a repository
// with an origin turns its project into an isolated project of that repository: it loses the directory, is named after the repository if
// it still has the name it was given, and goes into a repository project that has that repository alone already, which then has its
// bindings and topics; a topic keeps the directory it started in. Any other directory is marked as asked, once. A project that was removed
// or changed while the client answered stays as it is, and a directory the client cannot be asked about is asked again next time. Never
// rejects.
export async function convertAdopted(store:Store,m:Machine,inspect:(m:Machine,dir:string)=>Promise<{origin:string|null}>){
 const {data}=store;
 for(const p of data.projects.filter(x=>x.adopted?.machineId===m.id&&!x.adopted.inspected)){
  const dir=p.adopted!.dir;let origin;
  try{({origin}=await inspect(m,dir));}
  catch(e){store.log('数据迁移',`项目「${p.name}」的目录没能检查：${e.message}`,'error');continue;}
  if(!data.projects.includes(p)||p.adopted?.dir!==dir||p.adopted.inspected)continue;
  if(!origin){p.adopted.inspected=true;store.save();continue;}
  const same=data.projects.find(q=>q!==p&&!q.adopted&&q.workMode==='isolated'&&q.repos.length===1&&repoKey(q.repos[0])===repoKey(origin));
  if(same){
   for(const b of data.bindings)if(b.defaultProjectId===p.id)b.defaultProjectId=same.id;
   for(const t of data.topics)if(t.projectId===p.id)t.projectId=same.id;
   same.skills=[...new Set([...same.skills,...p.skills])];data.projects=data.projects.filter(x=>x!==p);
   store.log('数据迁移',`项目「${p.name}」的仓库与项目「${same.name}」相同，已合并到它`);store.save();continue;
  }
  const renamed=given(p)?uniqueName(repoName(origin),data.projects.filter(x=>x!==p).map(x=>x.name)):p.name,was=p.name;
  Object.assign(p,{name:renamed,repos:[origin],workMode:'isolated'});delete p.adopted;
  store.log('数据迁移',`项目「${was}」改为仓库 ${origin} 的项目${renamed!==was?`，改名为「${renamed}」`:''}`);store.save();
 }
}
