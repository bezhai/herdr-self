import {text,uuid,oneOf,isRecord} from './core.ts';
import {kinds} from './adoption.ts';
import type {Machine,AgentConfig,Kind,PermissionMode,State} from './state.ts';
// Agent configurations (see AgentConfig in state.ts): what a topic's agent runs as, on which machine. The machine selects the model
// environment, so the configuration, not the project, names it.
// The kinds of agent Herdr starts for a topic.
const agentKinds:Kind[]=['claude','codex','agy'];
// Claude permission modes: default sends the confirmations Claude asks for to Feishu as cards, auto lets Claude decide and rarely asks.
// Codex and Antigravity (agy) have none.
const permissionModes:PermissionMode[]=['default','auto'];
function claudeMode(v:unknown){if(!oneOf(permissionModes,v))throw Error('权限模式无效');return v;}
// The permission mode of a Claude configuration; one that a migrated binding had without a mode uses default.
export const permissionMode=<T>(c:{permissionMode?:T})=>c.permissionMode||'default';
// What the console and the cards call a configuration unless it is named: machine, kind and model, such as cpu1 · Claude · Seed.
export const configName=(m:Pick<Machine,'name'>,kind:Kind,model?:string)=>[m.name,kinds[kind],model].filter(Boolean).join(' · ');
// A model is named as the agent takes it on its command line, such as sonnet or gpt-5.1-codex, and never starts with a dash.
const modelName=/^[A-Za-z0-9][A-Za-z0-9._:\/[\]-]{0,99}$/;
// A command is one program name, such as butler: the commands that may run are those of this name followed by anything.
const commandName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const commandLimit=20;
function model(v:unknown){
 if(v==null||v==='')return undefined;if(typeof v!=='string'||!modelName.test(v.trim()))throw Error('模型名称无效');return v.trim();
}
function commands(v:unknown){
 if(v==null)return [];
 if(!Array.isArray(v)||v.length>commandLimit||v.some(x=>typeof x!=='string'||!commandName.test(x)))throw Error('可执行的命令无效');
 return [...new Set<string>(v)];
}
// The configuration that b describes, once checked: a new one, or old changed. A Claude configuration has a permission mode, default
// without one, and may restrict the commands its agent runs (the client enforces it, see prepareLaunch in link.ts); a mode that comes with
// another kind is dropped, commands are refused. The name defaults to configName and is unique.
export function normalizeAgentConfig(b:{name?:unknown,machineId?:unknown,kind?:unknown,model?:unknown,permissionMode?:unknown,allowedCommands?:unknown,[field:string]:unknown},
 data:Pick<State,'machines'|'agentConfigs'>,old?:AgentConfig):AgentConfig{
 const machine=data.machines.find(m=>m.id===b.machineId);if(!machine)throw Error('机器连接不存在');
 if(!oneOf(agentKinds,b.kind))throw Error('Agent 类型无效');
 const named=model(b.model);
 const allowed=commands(b.allowedCommands);if(allowed.length&&b.kind!=='claude')throw Error('只有 Claude 可以限制可执行的命令');
 const name=b.name==null||b.name===''?configName(machine,b.kind,named):text(b.name,60);
 if(data.agentConfigs.some(c=>c.id!==old?.id&&c.name===name))throw Error('已有同名的 Agent 配置');
 return {id:old?.id||uuid(),name,machineId:machine.id,kind:b.kind,...named&&{model:named},...b.kind==='claude'&&{permissionMode:claudeMode(b.permissionMode??'default')},...allowed.length&&{allowedCommands:allowed}};
}
