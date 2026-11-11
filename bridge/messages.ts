import type {Store,Call} from './core.ts';
import type {App,Machine,Topic,Source,Draft,Mention} from './state.ts';
import type {Topics} from './topics.ts';
import type {Platforms} from './platform.ts';
import type {Click} from './request-cards.ts';
import type {CardActionResponse} from '@larksuite/channel';
// bridge-message on the control plane (see message-command.ts). The agent of a topic brings a Feishu message into its topic (attach): Bridge
// reads it by its id through the owner's channel and posts a source card, so that where it came from is what Feishu says, not what the
// agent tells. It drafts messages to send as the owner: a reply that quotes a source of the topic in its chat (reply), or a message to a
// chat (send). A draft goes out through the owner's channel, open-lark on the machine that runs it (see open-lark.ts), only when someone on
// the app's allowlist clicks send on its card in the topic's thread: what goes out in the owner's name is theirs to decide, and a click
// reaches Bridge from Feishu, past the agent. The requests come through the client of the agent's machine like those of bridge-schedule,
// and the topic is that of the agent's pane (see Topics.caller). Every message sent, and every send that failed, is logged as 消息.

const ops=['attach','reply','send'] as const;
type Op=typeof ops[number];
// A request of bridge-message as the client of the agent's machine passes it on: the agent's pane and session, whatever the op; attach and
// reply name a message by its open-lark id (messageId; that of reply is a source of the topic), send a chat (chatId), and reply and send
// carry the text, with @<name> in it for each of mentions.
export type MessageRequest={pane?:string,session?:string,messageId?:string,chatId?:string,text?:string,mentions?:Mention[]};
// What each op resolves to, for bridge-message to print (see message-command.ts): the source it added, or the draft whose card it posted.
export type Answers={attach:{source:Source},reply:{draft:Draft},send:{draft:Draft}};
export type MessageOps={[K in Op]:{request:MessageRequest,answer:Answers[K]}};
// topics are those of the bindings (see topics.ts); app(id) returns an app or throws; owner() is the machine whose client reaches open-lark,
// or null when none is set or it is gone; call reaches the client of a machine (see Clients.call); reply(app,chatId,rootId,{card}) posts a
// card into the thread of a topic and resolves to its message id, and updateCard(app,messageId,card) replaces it; now() is the clock.
type Deps={topics:Pick<Topics,'caller'|'queue'>,app:(id:string)=>App,owner:()=>Machine|null,call:Call,reply:Platforms['reply'],updateCard:Platforms['updateCard'],now?:()=>number};
// The deps stay in deps: reply and call are also names of ops and of the method that dispatches them.
export class Messages{
 declare store:Store;declare deps:Required<Deps>;
 constructor(store:Store,{now=Date.now,...deps}:Deps){this.store=store;this.deps={...deps,now};}
 // Request op of the agent in pane pane of Herdr session session (default) on machine m, the machine whose client passed the request on:
 // op is one of ops, done for the agent's topic. Resolves to what the agent reads, and rejects with what to tell it.
 async call(m:Machine,op:string,request:unknown):Promise<Answers[Op]>{throw Error('not implemented');}
 // Brings message messageId into topic t: reads it through the owner's channel, keeps it among the sources of t and posts its source card.
 async attach(t:Topic,request:MessageRequest):Promise<Answers['attach']>{throw Error('not implemented');}
 // Drafts a reply to source messageId of topic t, in the chat of the source, and posts its card.
 async reply(t:Topic,request:MessageRequest):Promise<Answers['reply']>{throw Error('not implemented');}
 // Drafts a message to chat chatId, which it reads through the owner's channel, and posts its card.
 async send(t:Topic,request:MessageRequest):Promise<Answers['send']>{throw Error('not implemented');}
 // A click on a draft card from someone on the app's allowlist (see Platforms.cardAction), answered at once: send, edit, drop or cancel
 // (see draftCard in outbound-cards.ts).
 click(a:App,evt:Click):CardActionResponse{throw Error('not implemented');}
}
