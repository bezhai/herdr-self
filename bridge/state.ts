import type {Cot} from './cot.ts';
// What Bridge keeps in its state file, collection by collection (see Store in core.ts). Types only: every module that reads or writes a
// collection takes its shape from here.

// A machine of Bridge (see normalizeMachine in core.ts). tokenHash is the SHA-256 of its client's token (see Clients.issue).
export type Machine={id:string,name:string,session:string,enabled:boolean,tokenHash?:string};
// A Feishu app (see normalizeApp in platform.ts). Feishu names the app and its bot (see Platforms.syncBot), whose avatar is stored beside
// the state file; createdVia marks an app that the registration flow added (see Registrations).
export type App={id:string,name:string,appId:string,appSecret:string,domain:'feishu'|'lark'|'bytedance',allowedUsers:string[],enabled:boolean,verifiedAt:number|null,
 botOpenId?:string,avatar?:{type:string,updatedAt:number},createdVia?:'registration'};
// The agent kinds that a binding starts in its topics, and the permission modes of a Claude binding (see platform.ts).
export type Kind='claude'|'codex'|'agy';
export type PermissionMode='default'|'auto';
// How the topics of a project share its directory: each in a directory of its own, or all in one.
export type WorkMode='isolated'|'shared';
// A project (see projects.ts): a name, a description, the URLs of its git repositories (none or more), the names of the skills of the platform
// that its topics get besides those loaded by default, and how its topics share their directory. The machines hold its repositories and
// directories, which the client decides (see prepareWorkspace in link.ts), never the user. A project that a migrated binding became adopts
// that binding's directory on one machine: its topics work in it as before, until inspected tells that the control plane asked the machine
// whether it is the root of a repository, and either made the project a repository project, which has no adopted directory, or left it.
// A project with an adopted directory is shared and has no repos.
export type Project={id:string,name:string,description:string,repos:string[],skills:string[],workMode:WorkMode,adopted?:{machineId:string,dir:string,inspected?:true}};
// An agent configuration (see agent-configs.ts): the kind of agent, its model and, for Claude, its permission mode and the commands it may
// run, on one machine. The machine is what selects the model environment. A Claude configuration always has a permission mode.
export type AgentConfig={id:string,name:string,machineId:string,kind:Kind,model?:string,permissionMode?:PermissionMode,allowedCommands?:string[]};
// A binding of one chat of an app (see normalizeBinding in platform.ts): what the topics of the chat default to. name is the chat's name in
// Feishu, which Bridge keeps current. A group has a default project and every topic of its chat works on it; a direct chat has none and
// each of its topics gets the project that fits its task. defaultAgentConfigId is the configuration that runs the topics. workspaces holds,
// per machine id, the Herdr workspace that the topics of the chat opened tabs in on that machine, once there is one (see Topics.openTab):
// a fact of that machine's Herdr, checked against the workspace's label before it is used, so that losing it only costs a new workspace.
// It belongs to the binding, not to a project or a configuration, because the workspace groups the topics of one chat, which can run on
// several machines.
export type Binding={id:string,name:string,appId:string,chatId:string,chatType:'p2p'|'group',requireMention:boolean,enabled:boolean,defaultProjectId?:string,defaultAgentConfigId:string,
 workspaces?:Record<string,string>};
// A topic of a binding (see topics.ts). An adopted topic waits for an agent to adopt while choosing. A topic that a schedule opened is scheduled by run n of schedule id; a topic of an agent that submitted a schedule holds its
// proposal until the card is clicked or expires (see AgentSchedules). A topic that Bridge started has the project and the agent configuration
// it started with, the branch of its worktrees (a project with repos that is isolated) and the directory its agent started in, which is what
// a reply needs to restore its workspace; an adopted topic has none of them.
export type Topic={id:string,bindingId:string,appId:string,chatId:string,rootId:string,machineId:string,workspaceId:string,tabId:string,paneId:string,agentName:string,title:string,
 state:'starting'|'ready'|'failed'|'closed'|'choosing',error:string,messageIds:string[],replySeq:number,reactions:Reaction[],cards:RequestCard[],createdAt:number,
 adopted?:{picker?:string,kind?:string,session?:string},projectId?:string,agentConfigId?:string,branch?:string,cwd?:string,scheduled?:{id:string,n:number,messageAt?:number},cot?:TopicCot,proposal?:Proposal,attachmentDir?:string,blockedSeq?:number};
// A message of a person that the topic marked, with the state_change_seq of the prompt once it was prompted (see Topics.addReaction).
export type Reaction={messageId:string,reactionId:string,stateSeq:number|null};
// The card of a request the agent waits on (see Topics.cards).
export type RequestCard={requestId:number,messageId:string,title:string};
// The open COT of a topic, with what it shows (see Topics.openCot).
export type TopicCot=Cot&{origin:string,stateSeq:number,toolSeq:number,waiting:boolean};
// A schedule that the agent of a topic submitted, or a change to schedule scheduleId, which had the time and the task of before, waiting for
// its card to be clicked (see AgentSchedules.propose).
export type Proposal={id:string,messageId:string,expiresAt:number}&Submission;
export type Submission={kind:'add',fields:ScheduleFields,scheduleId?:undefined,before?:undefined}
 |{kind:'update',scheduleId:string,before:{cron:string,timeZone:string,task:string},fields:ScheduleFields};
export type ScheduleFields={mode:Mode,topicId?:string,cron:string,timeZone:string,task:string};
// The modes of a schedule (see schedules.ts).
export type Mode='new'|'into';
// A schedule of a binding (see Schedules.add).
export type Schedule={id:string,bindingId:string,mode:Mode,topicId?:string,cron:string,timeZone:string,task:string,paused:boolean,createdBy:{topicId?:string,openId?:string},
 createdAt:number,handledUntil:number,count:number,runs:Run[]};
export type Run={due:number,at:number,outcome:'started'|'skipped'|'missed'|'failed',n?:number,topicId?:string,reason?:string,last?:number};
// The index entry of a skill of the platform (see skills.ts).
export type Skill={name:string,description:string,preload:boolean,digest:string};
export type Log={at:number,kind:string,message:string,level:'info'|'error'};
// lastAgentConfigId is the configuration that the latest binding was created with, which the next binding card offers first.
export type State={machines:Machine[],apps:App[],projects:Project[],agentConfigs:AgentConfig[],bindings:Binding[],topics:Topic[],schedules:Schedule[],skills:Skill[],logs:Log[],
 lastAgentConfigId?:string};
