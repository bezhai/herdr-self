import type {Machine,Binding,Project,AgentConfig,Topic,Skill,Log} from './state.ts';
import type {Agent} from './core.ts';
import type {ClientStatus} from './clients.ts';
import type {Platforms} from './platform.ts';
import type {Registrations} from './registration.ts';
// What the console reads from /api/state (see state in server.ts, and web/src). Types only: the server builds it and the console reads it,
// both with these types.

// The Herdr status of a machine (see herdrStatus in server.ts): the agents and panes that the latest poll through its client found. Every
// status has both lists, empty where no poll has found any yet (while connecting) or where there is nothing to poll (disabled, offline).
export type HerdrStatus={state:'disabled'|'offline'|'connecting'|'connected'|'error',checkedAt?:number,error?:string,agents:Agent[],panes:object[]};
// A machine without the hash of its token, with whether it has one, and the status of its client and of its Herdr.
export type ConsoleMachine=Omit<Machine,'tokenHash'>&{hasToken:boolean,client:ClientStatus}&HerdrStatus;
// A topic without what only Bridge reads: the messages, reactions, cards, COT and proposal, and the message that opened it.
export type ConsoleTopic=Omit<Topic,'messageIds'|'reactions'|'cards'|'cot'|'proposal'|'task'>;
// A binding without the Herdr workspaces of its topics, which only Bridge reads.
export type ConsoleBinding=Omit<Binding,'workspaces'>;
// A project tells whether it adopted a directory (a migrated project), never which: the machines decide where a project's files are.
export type ConsoleProject=Omit<Project,'adopted'>&{adopted:boolean};
export type ConsoleState={host:string,version:string,registration:ReturnType<Registrations['status']>,machines:ConsoleMachine[],apps:ReturnType<Platforms['status']>[],
 projects:ConsoleProject[],agentConfigs:AgentConfig[],bindings:ConsoleBinding[],skills:Skill[],topics:ConsoleTopic[],logs:Log[]};
