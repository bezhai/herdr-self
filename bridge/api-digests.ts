import { publicText, oneOf } from './core.ts';
import { clip } from './request-cards.ts';
import { sinkName } from './messages.ts';
import { threadSinkName } from './thread-sink.ts';
import type { Store } from './core.ts';
import type { Topic } from './state.ts';
import type { Topics } from './topics.ts';
import type { Tasks } from './task-core.ts';
import type { Delivery, DeliveryState, Input, TaskView } from './task-types.ts';
import type { OwnerMessage } from './link.ts';
import type { Address, Body, Receipt } from './outbound-cards.ts';

// How butler hands a live topic's agent the owner's Feishu messages that concern its work. Butler reads the live topics
// (GET /api/topics/context, one of them with ?topicId=), decides which messages matter to which topic, and hands a topic a
// short digest (POST /api/topics/digest). Bridge decides nothing here: it keeps the digest from interrupting the agent and
// frames it as other people's words (see Topics.hold and Topics.give).

// The refusals of this API and their HTTP statuses.
const statuses = { invalid_request: 400, unknown_topic: 404, topic_not_live: 409 };
type Refusal = keyof typeof statuses;
const refusals = Object.keys(statuses) as Refusal[];
type Answer = { status: number; body: object };

function refused(code: Refusal, message: string) {
  return Object.assign(Error(message), { code });
}

// A digest is a few lines about a few messages; those that wait together must still fit one prompt (see Topics.hold).
const keyLimit = 200;
const textLimit = 2000;

// How much of a topic's work each form shows. The list is for telling which topics a message may concern; one topic is
// read to tell what it is doing now, so it shows a longer stretch of its conversation. The caller reads the rest in Feishu.
type Limits = { exchanges: number; exchangeChars: number; touched: number; touchedChars: number };
const listLimits: Limits = { exchanges: 6, exchangeChars: 300, touched: 10, touchedChars: 200 };
const oneTopicLimits: Limits = { exchanges: 20, exchangeChars: 2000, touched: 20, touchedChars: 500 };

// Refs of a task's inputs: a message of the owner in the topic's thread (see Topics.record), and a message the agent
// brought in as a source (see Messages.attach).
const threadRef = 'feishu:';
const sourceRef = 'open-lark:';

type Exchange = { from: 'owner' | 'agent'; at: number; text: string };
type Source = {
  messageId: string;
  chatId: string;
  chatName: string;
  sender: string;
  at: number;
  text: string;
  inThread?: boolean;
};
type Draft = {
  chatId: string;
  chatName: string;
  replyTo?: string;
  thread?: boolean;
  state: DeliveryState;
  at: number;
  text: string;
  sent?: { messageId: string; threadRoot?: string; attachments?: string[] };
};
// What the caller reads of a live topic: what it is about (title, and the goal of its task, or the title when it has
// none), its chat (Feishu's open chat id and the binding's name), how many digests wait for its agent, and of its task
// the latest exchanges in the thread, the messages it brought in and the messages it drafted as the owner, with the
// open-lark ids the caller needs to tie Feishu messages to them.
export type TopicContext = {
  id: string;
  title: string;
  goal: string;
  chatId: string;
  chatName: string;
  createdAt: number;
  adopted: boolean;
  pending: number;
  exchanges: Exchange[];
  sources: Source[];
  drafts: Draft[];
};
// What the caller gets for a digest: whether this request held it, and how many digests wait for the agent.
export type Held = { topicId: string; key: string; created: boolean; pending: number };

type Deps = { topics: Pick<Topics, 'hold'>; tasks: Pick<Tasks, 'get'> };

export class ApiDigests {
  declare store: Store;
  declare topics: Deps['topics'];
  declare tasks: Deps['tasks'];
  constructor(store: Store, { topics, tasks }: Deps) {
    this.store = store;
    this.topics = topics;
    this.tasks = tasks;
  }

  // GET /api/topics/context: every live topic, in the order of the state.
  context(): { topics: TopicContext[] } {
    const live = this.store.data.topics.filter((topic) => topic.state === 'ready');
    return { topics: live.map((topic) => this.contextOf(topic, listLimits)) };
  }

  // GET /api/topics/context?topicId=: one live topic with a longer stretch of its conversation, or a refusal.
  topic(topicId: unknown): Answer {
    return answered(() => {
      const topic = this.liveTopic(topicId);
      return { topic: this.contextOf(topic, oneTopicLimits) };
    });
  }

  // POST /api/topics/digest: 200 with what give returns, or a refusal.
  answer(request: Record<string, unknown>): Answer {
    return answered(() => this.give(request));
  }

  // Hands digest text to the agent of a topic under key (see Topics.hold). A key the topic accepted before changes
  // nothing and is no refusal, even once the topic has ended, so that asking again is safe.
  give(request: Record<string, unknown>): Held {
    const { topicId, key, text } = request;
    checkTopicId(topicId);
    if (typeof key !== 'string' || !key || key.length > keyLimit)
      throw refused('invalid_request', `key 应为 1 到 ${keyLimit} 个字符`);
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed || trimmed.length > textLimit) throw refused('invalid_request', `text 为空或超过 ${textLimit} 个字符`);
    const topic = this.knownTopic(topicId);
    if (topic.digests?.keys.includes(key))
      return { topicId, key, created: false, pending: topic.digests.pending.length };
    checkLive(topic);
    return { topicId, key, ...this.topics.hold(topic, { key, text: trimmed }) };
  }

  knownTopic(topicId: string) {
    const topic = this.store.data.topics.find((candidate) => candidate.id === topicId);
    if (!topic) throw refused('unknown_topic', '话题不存在');
    return topic;
  }

  liveTopic(topicId: unknown) {
    checkTopicId(topicId);
    const topic = this.knownTopic(topicId);
    checkLive(topic);
    return topic;
  }

  // Reads the topic's task without making one for a topic that has none.
  contextOf(topic: Topic, limits: Limits): TopicContext {
    const binding = this.store.data.bindings.find((candidate) => candidate.id === topic.bindingId);
    const task = topic.taskId ? this.tasks.get(topic.taskId) : undefined;
    return {
      id: topic.id,
      title: topic.title,
      goal: task?.goal ?? topic.title,
      chatId: topic.chatId,
      chatName: binding?.name ?? '',
      createdAt: topic.createdAt,
      adopted: Boolean(topic.adopted),
      pending: topic.digests?.pending.length ?? 0,
      exchanges: task ? exchangesOf(task, limits) : [],
      sources: task ? sourcesOf(task, limits) : [],
      drafts: task ? draftsOf(task, limits) : [],
    };
  }
}

// Runs a request; a refusal becomes its status with {error, code}, and any other failure is the server's to answer.
function answered(handle: () => object): Answer {
  try {
    return { status: 200, body: handle() };
  } catch (error) {
    const code: unknown = error.code;
    if (!oneOf(refusals, code)) throw error;
    return { status: statuses[code], body: { error: publicText(error.message).slice(0, 1200), code } };
  }
}

function checkTopicId(topicId: unknown): asserts topicId is string {
  if (typeof topicId !== 'string' || !topicId) throw refused('invalid_request', 'topicId 应为话题的 ID');
}

// A topic that is not ready has no agent session (gone, starting, or not adopted yet) and would never get a digest.
function checkLive(topic: Topic) {
  if (topic.state !== 'ready') throw refused('topic_not_live', '话题当前没有运行中的 Agent 会话');
}

const textOf = (body: unknown) => (body as { text?: string }).text ?? '';

// What the owner wrote in the topic's thread and what the agent replied there, oldest first.
function exchangesOf(task: TaskView, limits: Limits): Exchange[] {
  const repliedOutputs = new Set(task.deliveries.filter((d) => sinkOf(d) === threadSinkName).map((d) => d.output));
  const fromOwner = task.inputs
    .filter((input) => input.ref?.startsWith(threadRef))
    .map((input): Exchange => ({ from: 'owner', at: input.at, text: textOf(input.body) }));
  const fromAgent = task.outputs
    .filter((output) => repliedOutputs.has(output.id))
    .map((output): Exchange => ({ from: 'agent', at: output.at, text: textOf(output.body) }));
  return [...fromOwner, ...fromAgent]
    .sort((a, b) => a.at - b.at)
    .slice(-limits.exchanges)
    .map((exchange) => ({ ...exchange, text: clip(exchange.text, limits.exchangeChars) }));
}

function sourcesOf(task: TaskView, limits: Limits): Source[] {
  return task.inputs
    .filter((input) => input.ref?.startsWith(sourceRef))
    .slice(-limits.touched)
    .map((input) => sourceOf(input, limits));
}

function sourceOf(input: Input, limits: Limits): Source {
  const message = input.body as OwnerMessage;
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatName: message.chatName,
    sender: message.sender?.name ?? '',
    at: message.at,
    text: clip(message.text ?? '', limits.touchedChars),
    ...(message.inThread && { inThread: true }),
  };
}

// The messages the agent drafted as the owner, sent or not.
function draftsOf(task: TaskView, limits: Limits): Draft[] {
  return task.deliveries
    .filter((delivery) => sinkOf(delivery) === sinkName)
    .slice(-limits.touched)
    .map((delivery) => draftOf(delivery, limits));
}

function draftOf(delivery: Delivery, limits: Limits): Draft {
  const to = (delivery.target as { to: Address }).to;
  const draft: Draft = {
    chatId: to.chatId,
    chatName: to.chatName,
    ...(to.replyTo && { replyTo: to.replyTo }),
    ...(to.thread && { thread: true }),
    state: delivery.state,
    at: delivery.createdAt,
    text: clip((delivery.body as Body).text ?? '', limits.touchedChars),
  };
  if (delivery.state === 'delivered') draft.sent = sentOf(delivery.receipt as Receipt);
  return draft;
}

// The open-lark ids of what went out: the message, the root of its thread, and the messages of its images.
function sentOf(receipt: Receipt): NonNullable<Draft['sent']> {
  const attachments = receipt.attachments?.filter((id): id is string => Boolean(id)) ?? [];
  return {
    messageId: receipt.messageId,
    ...(receipt.threadRoot && { threadRoot: receipt.threadRoot }),
    ...(attachments.length && { attachments }),
  };
}

function sinkOf(delivery: Delivery) {
  return 'sink' in delivery.target ? delivery.target.sink : undefined;
}
