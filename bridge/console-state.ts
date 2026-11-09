import type {Machine,Binding,Topic,Skill,Log} from './state.ts';
import type {Agent} from './core.ts';
import type {ClientStatus} from './clients.ts';
import type {Platforms} from './platform.ts';
import type {Registrations} from './registration.ts';
import type {PendingChats} from './pending-chats.ts';
// What the console reads from /api/state (see state in server.ts, and web/src). Types only: the server builds it and the console reads it,
// both with these types.

// The Herdr status of a machine (see herdrStatus in server.ts): the agents and panes that the latest poll through its client found, which a
// first poll that is still connecting does not have yet.
export type HerdrStatus={state:'disabled'|'offline'|'connecting'|'connected'|'error',checkedAt?:number,error?:string,agents?:Agent[],panes?:object[]};
// A machine without the hash of its token, with whether it has one, and the status of its client and of its Herdr.
export type ConsoleMachine=Omit<Machine,'tokenHash'>&{hasToken:boolean,client:ClientStatus}&HerdrStatus;
// A topic without what only Bridge reads: the messages, reactions, cards, COT and proposal, and the card of its worktree.
export type ConsoleTopic=Omit<Topic,'messageIds'|'reactions'|'cards'|'cot'|'proposal'|'worktree'>&{worktree?:Omit<NonNullable<Topic['worktree']>,'card'>};
export type ConsoleState={host:string,version:string,registration:ReturnType<Registrations['status']>,machines:ConsoleMachine[],apps:ReturnType<Platforms['status']>[],
 bindings:Binding[],pendingChats:ReturnType<PendingChats['list']>,skills:Skill[],topics:ConsoleTopic[],logs:Log[]};
