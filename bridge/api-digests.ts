import { publicText, oneOf } from './core.ts';
import { clip } from './request-cards.ts';
import { sinkName } from './messages.ts';
import { threadSinkName } from './thread-sink.ts';
import type { Store } from './core.ts';
import type { Topic } from './state.ts';
import type { Topics } from './topics.ts';
import type { Tasks } from './task-core.ts';
import type { DeliveryState } from './task-types.ts';
import type { OwnerMessage, Sent } from './link.ts';
import type { Address, Body } from './outbound-cards.ts';
// How a trusted caller, butler, hands the agents of ready topics what their work needs to know of the owner's new Feishu messages. It reads
// what each ready topic is about and which of the owner's messages and chats it touched (GET /api/topics/context), decides which messages
// concern which topic, and hands a topic a short digest of them (POST /api/topics/digest), which its agent gets once it is free (see
// Topics.hold). Bridge decides nothing here: which messages matter to which topic is the caller's, who reads all of them; Bridge only keeps
// the digest from interrupting the agent and frames it as what it is.

// The codes of a refusal of a digest, with the HTTP status of each (see answer).
const statuses = { invalid_request: 400, unknown_topic: 404, topic_not_live: 409 };
type Refusal = keyof typeof statuses;
const refusals = Object.keys(statuses) as Refusal[];
const refused = (code: Refusal, message: string) => Object.assign(Error(message), { code });
const invalid = (message: string) => refused('invalid_request', message);
// The longest key and digest: a digest is a few lines on a few messages, and those that wait together stay within a prompt (see Topics.hold).
const keyLimit = 200,
  textLimit = 2000;
// How much of a topic's work the context shows: the latest exchanges of the owner and the agent, and the latest sources and drafts, each text
// cut. Enough to tell what the topic is about and which messages and chats it touched; the caller reads the rest in Feishu.
const exchangeCount = 6,
  exchangeChars = 300,
  touchedCount = 10,
  touchedChars = 200;
// The prefixes of the refs of a task's inputs: a message in the topic's thread (see Topics.record) and a message the agent brought in (see
// Messages.attach).
const threadRef = 'feishu:',
  sourceRef = 'open-lark:';
// What the caller reads of a ready topic: its id, title and the goal of its task (the title for a topic without a task), the chat of the topic
// (Feishu's open chat id and the binding's name), when it began, whether it adopted an agent, how many digests wait for its agent, and of its
// task the latest exchanges (what the owner wrote in the thread and what the agent replied), the messages it brought in as sources and the
// messages it drafted as the owner, with the open-lark ids of their chats and of what went out.
export type TopicContext = {
  id: string;
  title: string;
  goal: string;
  chatId: string;
  chatName: string;
  createdAt: number;
  adopted: boolean;
  pending: number;
  exchanges: { from: 'owner' | 'agent'; at: number; text: string }[];
  sources: {
    messageId: string;
    chatId: string;
    chatName: string;
    sender: string;
    at: number;
    text: string;
    inThread?: boolean;
  }[];
  drafts: {
    chatId: string;
    chatName: string;
    replyTo?: string;
    thread?: boolean;
    state: DeliveryState;
    at: number;
    text: string;
    sent?: { messageId: string; threadRoot?: string; attachments?: string[] };
  }[];
};
// What the caller gets for a digest: the topic and the key, whether this request held it, and how many digests wait for the agent.
export type Held = { topicId: string; key: string; created: boolean; pending: number };
type Deps = { topics: Pick<Topics, 'hold'>; tasks: Pick<Tasks, 'get'> };
export class ApiDigests {
  declare store: Store;
  declare topics: Deps['topics'];
  declare tasks: Deps['tasks'];
  // topics are the topics of the bindings (see topics.ts); tasks is the task core, which the context only reads.
  constructor(store: Store, { topics, tasks }: Deps) {
    this.store = store;
    this.topics = topics;
    this.tasks = tasks;
  }
  // The answer of GET /api/topics/context: the context of every ready topic, in the order of the state.
  context(): { topics: TopicContext[] } {
    return { topics: this.store.data.topics.filter((t) => t.state === 'ready').map((t) => this.of(t)) };
  }
  // The context of ready topic t, read from its task without making one for a topic that has none.
  of(t: Topic): TopicContext {
    const b = this.store.data.bindings.find((x) => x.id === t.bindingId),
      task = t.taskId ? this.tasks.get(t.taskId) : undefined;
    const base = {
      id: t.id,
      title: t.title,
      goal: task?.goal ?? t.title,
      chatId: t.chatId,
      chatName: b?.name ?? '',
      createdAt: t.createdAt,
      adopted: Boolean(t.adopted),
      pending: t.digests?.pending.length ?? 0,
    };
    if (!task) return { ...base, exchanges: [], sources: [], drafts: [] };
    const replies = new Set(
      task.deliveries.filter((d) => 'sink' in d.target && d.target.sink === threadSinkName).map((d) => d.output),
    );
    const exchanges = [
      ...task.inputs
        .filter((i) => i.ref?.startsWith(threadRef))
        .map((i) => ({ from: 'owner' as const, at: i.at, text: (i.body as { text?: string }).text ?? '' })),
      ...task.outputs
        .filter((o) => replies.has(o.id))
        .map((o) => ({ from: 'agent' as const, at: o.at, text: (o.body as { text?: string }).text ?? '' })),
    ]
      .sort((x, y) => x.at - y.at)
      .slice(-exchangeCount)
      .map((e) => ({ ...e, text: clip(e.text, exchangeChars) }));
    const sources = task.inputs
      .filter((i) => i.ref?.startsWith(sourceRef))
      .slice(-touchedCount)
      .map((i) => {
        const m = i.body as OwnerMessage;
        return {
          messageId: m.messageId,
          chatId: m.chatId,
          chatName: m.chatName,
          sender: m.sender?.name ?? '',
          at: m.at,
          text: clip(m.text ?? '', touchedChars),
          ...(m.inThread && { inThread: true }),
        };
      });
    const drafts = task.deliveries
      .filter((d) => 'sink' in d.target && d.target.sink === sinkName)
      .slice(-touchedCount)
      .map((d) => {
        const to = (d.target as { to: Address }).to,
          receipt = d.state === 'delivered' ? (d.receipt as Sent & { attachments?: (string | null)[] }) : undefined,
          attachments = receipt?.attachments?.filter((x): x is string => Boolean(x));
        return {
          chatId: to.chatId,
          chatName: to.chatName,
          ...(to.replyTo && { replyTo: to.replyTo }),
          ...(to.thread && { thread: true }),
          state: d.state,
          at: d.createdAt,
          text: clip((d.body as Body).text ?? '', touchedChars),
          ...(receipt && {
            sent: {
              messageId: receipt.messageId,
              ...(receipt.threadRoot && { threadRoot: receipt.threadRoot }),
              ...(attachments?.length && { attachments }),
            },
          }),
        };
      });
    return { ...base, exchanges, sources, drafts };
  }
  // The answer of POST /api/topics/digest: 200 with what give returns, or the status of a refusal with {error, code}. Any other failure
  // throws, for the server to answer like every other.
  answer(request: Record<string, unknown>) {
    try {
      return { status: 200, body: this.give(request) };
    } catch (e) {
      const code: unknown = e.code;
      if (!oneOf(refusals, code)) throw e;
      return { status: statuses[code], body: { error: publicText(e.message).slice(0, 1200), code } };
    }
  }
  // Hands digest text to the agent of topic topicId under key (see Topics.hold): request is {topicId, key, text}, text trimmed. A key that
  // the topic accepted before returns created false and changes nothing, also once the topic is no longer live. Throws with the code
  // invalid_request, unknown_topic, or topic_not_live for a topic that is not ready (its agent is gone, starting or not adopted yet), which
  // would never get the digest.
  give(request: Record<string, unknown>): Held {
    const { topicId, key, text } = request;
    if (typeof topicId !== 'string' || !topicId) throw invalid('topicId 应为话题的 ID');
    if (typeof key !== 'string' || !key || key.length > keyLimit) throw invalid(`key 应为 1 到 ${keyLimit} 个字符`);
    if (typeof text !== 'string' || !text.trim() || text.trim().length > textLimit)
      throw invalid(`text 为空或超过 ${textLimit} 个字符`);
    const t = this.store.data.topics.find((x) => x.id === topicId);
    if (!t) throw refused('unknown_topic', '话题不存在');
    if (t.digests?.keys.includes(key)) return { topicId, key, created: false, pending: t.digests.pending.length };
    if (t.state !== 'ready') throw refused('topic_not_live', '话题当前没有运行中的 Agent 会话');
    return { topicId, key, ...this.topics.hold(t, { key, text: text.trim() }) };
  }
}
