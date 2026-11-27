// The routing agent's tools, which butler's command line runs for it (see cli.mjs route): the listing of a window's new
// messages, the live topics and one topic's recent conversation, and the note that hands a topic what it needs to know.
// The agent copies ids from what these show, so the note checks every id it is given and refuses with a reason the agent
// can act on.
import { BridgeError } from './bridge-client.mjs';

// A refusal of a tool: its message says what to do instead.
export class Refusal extends Error {}

const PAGE_SIZE = 50;
// A listed message is one line; the agent reads the whole text with ol when it needs it.
const TEXT_CHARS = 300;
const BRIEF_CHARS = 40;
const EXCHANGE_CHARS = 100;
// A note is a few lines; with its message ids it stays within what Bridge takes (2000 characters).
const NOTE_CHARS = 1000;
const NOTE_MESSAGES = 30;
const SHORT_ID = 8;
const RECENT_NOTES = 5;
// Bridge refuses these for good: an invalid request, an unknown topic, a topic no longer live.
const FINAL_STATUSES = [400, 404, 409];

const KIND_WORDS = { group: '群', direct: '私聊', topic: '话题群' };
const DRAFT_STATES = {
  delivered: '已发出',
  awaiting: '等确认',
  sending: '正在发',
  failed: '发送失败',
  rejected: '没有发',
};
const NOTE_STATES = { dry: '干跑', pending: '等着交', given: '已交给 Bridge', dropped: 'Bridge 没收下' };

const localTime = (ms) => new Date(ms).toLocaleString('sv-SE');
const fullTime = (ms) => localTime(ms).slice(0, 16);
const shortTime = (ms) => localTime(ms).slice(5, 16);
const oneLine = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (text, chars) => {
  const characters = [...text];
  if (characters.length <= chars) return text;
  return `${characters.slice(0, chars - 1).join('')}…`;
};
const indented = (text) => String(text).replaceAll('\n', '\n  ');
export const shortId = (id) => id.slice(0, SHORT_ID);

// "2026-11-27 10:00 到 10:10", or with the date of the end when it is another day.
export function spanText(window) {
  const from = fullTime(window.from.at);
  const until = fullTime(window.until);
  const sameDay = from.slice(0, 10) === until.slice(0, 10);
  return `${from} 到 ${sameDay ? until.slice(11) : until}`;
}

// The ids of a note as the agent writes them: separate arguments, or several in one, split by commas or spaces.
function idsOf(messageIds) {
  const ids = messageIds.flatMap((value) => String(value).split(/[\s,，、]+/)).filter(Boolean);
  return [...new Set(ids)];
}

function checkedText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Refusal('摘要是空的：写这几条消息对这个话题来说是什么事');
  const length = [...trimmed].length;
  if (length > NOTE_CHARS) throw new Refusal(`摘要最长 ${NOTE_CHARS} 字，这次有 ${length} 字：写短一点`);
  return trimmed;
}

// Hands a kept note to Bridge, which gives it to the topic's agent once the agent is free. One Bridge refuses for good is
// dropped; any other failure (Bridge unreachable or restarting) leaves it pending for the next round.
export async function handOver(windows, bridge, note) {
  try {
    await bridge.giveDigest({ topicId: note.topicId, key: note.key, text: note.text });
    return windows.setNoteStatus(note.id, { status: 'given' });
  } catch (e) {
    const final = e instanceof BridgeError && FINAL_STATUSES.includes(e.status);
    return windows.setNoteStatus(note.id, { status: final ? 'dropped' : 'pending', error: e.message });
  }
}

export class RouteTools {
  constructor({ store, windows, bridge }) {
    this.store = store;
    this.windows = windows;
    this.bridge = bridge;
  }

  #window(windowId) {
    const window = this.windows.window(Number(windowId));
    if (!window) throw new Refusal(`没有第 ${windowId} 段：段号写交给你的那一段的编号`);
    return window;
  }

  // One page of a window's new messages, oldest first.
  messages(windowId, page = 1) {
    const window = this.#window(windowId);
    const all = this.windows.messages(window);
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (!Number.isInteger(page) || page < 1 || page > pages)
      throw new Refusal(`第 ${window.id} 段只有 ${pages} 页，页码写 1 到 ${pages}`);
    const onPage = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return { window, page, pages, total: all.length, messages: onPage.map((record) => this.#listed(record)) };
  }

  // What the listing shows of a message: enough to judge it, and its ids to read it and its thread with ol.
  #listed(record) {
    const inThread = record.threadRole === 'reply' && record.rootId;
    const repliesToRoot = inThread && record.parentId === record.rootId;
    return {
      id: record.id,
      chatId: record.chatId,
      chatName: record.chatName,
      chatKind: record.chatKind,
      sender: record.senderName ?? record.senderId,
      ...(record.isMine && { mine: true }),
      ...(record.senderType && record.senderType !== 'user' && { bot: true }),
      at: record.createdAt,
      text: clip(oneLine(record.text), TEXT_CHARS),
      ...(record.isRecalled && { recalled: true }),
      ...(record.parentId && !repliesToRoot && { replyTo: this.#brief(record.parentId) }),
      ...(inThread && { thread: this.#brief(record.rootId) }),
    };
  }

  #brief(id) {
    const record = this.store.message(id);
    if (!record) return { id };
    const sender = record.senderName ?? record.senderId;
    return { id, brief: clip(`${sender}：${oneLine(record.text)}`, BRIEF_CHARS) };
  }

  topics() {
    return this.bridge.topicContext();
  }

  // One live topic, by its id or a prefix that only it has, with what butler's windows gave it lately.
  async topic(prefix) {
    const found = await this.#liveTopic(prefix);
    let topic;
    try {
      topic = await this.bridge.topic(found.id);
    } catch (e) {
      if (e instanceof BridgeError && FINAL_STATUSES.includes(e.status))
        throw new Refusal(`话题 ${shortId(found.id)} 读不到了：${e.message}`);
      throw e;
    }
    return { topic, notes: this.windows.recentNotes(found.id, RECENT_NOTES) };
  }

  async #liveTopic(prefix) {
    const wanted = String(prefix ?? '').trim();
    if (!wanted) throw new Refusal('要写话题 id 或它的前几位（butler route topics 列出进行中的话题）');
    const live = await this.bridge.topicContext();
    const found = live.filter((topic) => topic.id.startsWith(wanted));
    if (found.length > 1)
      throw new Refusal(
        `有 ${found.length} 个话题的 id 以 ${wanted} 开头：${found.map((t) => shortId(t.id)).join('、')}，多写几位`,
      );
    if (!found.length)
      throw new Refusal(
        `没有 id 以 ${wanted} 开头的进行中的话题（话题可能已经结束；butler route topics 列出进行中的话题）`,
      );
    return found[0];
  }

  // Hands topic (an id or a unique prefix) a note about messageIds of window windowId. The window's mode decides what
  // happens to it: on hands it to Bridge, dry-run and preview only keep it.
  async note({ windowId, topic, messageIds, text }) {
    const window = this.#window(windowId);
    if (window.state !== 'open') throw new Refusal(`第 ${window.id} 段已经分派完了，不能再转`);
    const ids = idsOf(messageIds);
    if (!ids.length) throw new Refusal('至少写一条消息 id：摘要说的是这一段里的哪几条消息');
    if (ids.length > NOTE_MESSAGES)
      throw new Refusal(`一份摘要最多写 ${NOTE_MESSAGES} 条消息，这次有 ${ids.length} 条：只写这个话题要知道的`);
    const inWindow = new Set(this.windows.messages(window).map((record) => record.id));
    const outside = ids.find((id) => !inWindow.has(id));
    if (outside)
      throw new Refusal(
        `消息 ${outside} 不在第 ${window.id} 段里：只能写 butler route messages ${window.id} 列出的消息 id`,
      );
    const body = checkedText(text);
    const target = await this.#liveTopic(topic);
    const twice = new Refusal(
      `第 ${window.id} 段已经给话题 ${shortId(target.id)} 转过一份了，每段时间每个话题只转一份`,
    );
    if (this.windows.noteFor(window.id, target.id)) throw twice;
    const kept = this.windows.addNote({
      window,
      topicId: target.id,
      topicTitle: target.title,
      messageIds: ids,
      text: `${body}\n涉及的消息：${ids.join('、')}`,
      status: window.mode === 'on' ? 'pending' : 'dry',
    });
    if (!kept) throw twice;
    const note = window.mode === 'on' ? await handOver(this.windows, this.bridge, kept) : kept;
    if (note.status === 'dropped') throw new Refusal(`Bridge 没有收下：${note.error}`);
    return {
      window: window.id,
      mode: window.mode,
      topicId: note.topicId,
      title: note.topicTitle,
      status: note.status,
      text: note.text,
      messageIds: note.messageIds,
    };
  }
}

// ---- what the commands print

function messageLine(message) {
  const who = `${message.sender}${message.mine ? '（我）' : ''}${message.bot ? '（机器人）' : ''}`;
  const marks = [];
  if (message.recalled) marks.push('已撤回');
  if (message.replyTo) marks.push(`回复 ${message.replyTo.id}${briefText(message.replyTo)}`);
  if (message.thread) marks.push(`thread ${message.thread.id}${briefText(message.thread)}里`);
  const relation = marks.map((mark) => ` · ${mark}`).join('');
  return `${message.id}  ${shortTime(message.at)}  ${who}${relation}：${message.text}`;
}

const briefText = (reference) => (reference.brief ? `（${reference.brief}）` : '');

// Messages of one chat stay together, chats in the order of their first message.
function byChat(messages) {
  const chats = new Map();
  for (const message of messages) {
    if (!chats.has(message.chatId)) chats.set(message.chatId, []);
    chats.get(message.chatId).push(message);
  }
  return [...chats.values()];
}

export function formatMessages({ window, page, pages, total, messages }) {
  const lines = [
    `第 ${window.id} 段（${spanText(window)} 收下的消息）：新消息 ${total} 条，第 ${page}/${pages} 页。正文超过 ${TEXT_CHARS} 字的截断了，全文用 ol GET /messages/<消息 id> 读。`,
  ];
  for (const chat of byChat(messages)) {
    const { chatId, chatName, chatKind } = chat[0];
    lines.push('', `== ${chatName ?? chatId} · ${KIND_WORDS[chatKind] ?? '聊天'} · feedId ${chatId} ==`);
    for (const message of chat) lines.push(messageLine(message));
  }
  const after = total - page * PAGE_SIZE;
  if (after > 0) lines.push('', `还有 ${after} 条：butler route messages ${window.id} --page ${page + 1}`);
  return lines.join('\n');
}

const speaker = (exchange) => (exchange.from === 'owner' ? '主人' : 'Agent');

function topicHeading(topic) {
  const adopted = topic.adopted ? '（接管的 Agent）' : '';
  const waiting = topic.pending ? ` · 在等 Agent 空闲的转交 ${topic.pending} 份` : '';
  const lines = [
    `${shortId(topic.id)}  ${topic.title}${adopted}`,
    `群：${topic.chatName || topic.chatId} · ${shortTime(topic.createdAt)} 开始${waiting}`,
  ];
  if (topic.goal && topic.goal !== topic.title) lines.push(`目标：${topic.goal}`);
  return lines;
}

export function formatTopics(topics) {
  if (!topics.length) return '现在没有进行中的话题';
  const lines = [`进行中的话题 ${topics.length} 个（话题 id 写前几位就行，能认出是哪一个即可）：`];
  for (const topic of topics) {
    const [first, ...rest] = topicHeading(topic);
    const latest = (topic.exchanges ?? [])
      .slice(-2)
      .map((e) => `${shortTime(e.at)} ${speaker(e)}：${clip(oneLine(e.text), EXCHANGE_CHARS)}`);
    lines.push('', first, ...[...rest, ...latest].map((line) => `  ${line}`));
  }
  lines.push('', '读一个话题最近的对话：butler route topic <话题 id>');
  return lines.join('\n');
}

function sourceLine(source) {
  const where = source.inThread ? '，thread 里的回复' : '';
  return `${shortTime(source.at)} ${source.chatName} · ${source.sender}（消息 ${source.messageId}${where}）：${indented(source.text)}`;
}

function draftLine(draft) {
  const marks = [draft.chatName];
  if (draft.replyTo) marks.push(`回复 ${draft.replyTo}`);
  if (draft.thread) marks.push('thread');
  const sent = draft.sent ? `（消息 ${draft.sent.messageId}）` : '';
  marks.push(`${DRAFT_STATES[draft.state] ?? draft.state}${sent}`);
  return `${shortTime(draft.at)} ${marks.join(' · ')}：${indented(draft.text)}`;
}

function noteLine(note) {
  const when = note.windowId ? `第 ${note.windowId} 段` : shortTime(note.at);
  return `${when}（${NOTE_STATES[note.status] ?? note.status}）：${indented(note.text)}`;
}

export function formatTopic({ topic, notes }) {
  const sections = [
    ['最近的对话，从早到晚', topic.exchanges.map((e) => `${shortTime(e.at)} ${speaker(e)}：${indented(e.text)}`)],
    ['放进话题的飞书消息', topic.sources.map(sourceLine)],
    ['替主人起草的消息', topic.drafts.map(draftLine)],
    ['管家最近转给它的', notes.map(noteLine)],
  ];
  const lines = topicHeading(topic);
  for (const [title, entries] of sections) if (entries.length) lines.push('', `== ${title} ==`, ...entries);
  return lines.join('\n');
}

export function formatNote(result) {
  const where = `话题 ${shortId(result.topicId)}「${result.title}」`;
  const count = `${result.messageIds.length} 条消息`;
  if (result.mode === 'preview') return `已记下转给${where}的摘要（${count}）；这是预览，不交给 Bridge`;
  if (result.mode === 'dry-run') return `已记下转给${where}的摘要（${count}）；现在是干跑，不交给 Bridge`;
  if (result.status === 'pending') return `已记下转给${where}的摘要（${count}）；Bridge 暂时连不上，管家稍后再交`;
  return `已把摘要交给${where}（${count}），它的 Agent 空闲时会收到`;
}
