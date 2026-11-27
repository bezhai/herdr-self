// The routing agent's tools, which butler's command line runs for it (see cli.mjs route): the listing of a window's new
// messages, the live topics and one topic's recent conversation, and the note that hands a topic what it needs to know.
// The agent copies ids from what these show, so the note checks every id it is given and refuses with a reason the agent
// can act on.
import { BridgeError } from './bridge-client.mjs';

// A refusal of a tool: its message says what to do instead.
export class Refusal extends Error {}

// A listed message is one line; the agent reads the whole text with ol when it needs it.
export const TEXT_CHARS = 300;
const BRIEF_CHARS = 40;
// A note is a few lines; with its message ids it stays within what Bridge takes (2000 characters).
const NOTE_CHARS = 1000;
const NOTE_MESSAGES = 30;
const SHORT_ID = 8;
const RECENT_NOTES = 5;
// Bridge refuses these for good: an invalid request, an unknown topic, a topic no longer live.
const FINAL_STATUSES = [400, 404, 409];

export const oneLine = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
export const clip = (text, chars) => {
  const characters = [...text];
  if (characters.length <= chars) return text;
  return `${characters.slice(0, chars - 1).join('')}…`;
};
export const shortId = (id) => id.slice(0, SHORT_ID);

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

  // A window's new messages as the listing shows them, oldest first. The listing is read a page at a time (see pageOf
  // in route-print.mjs), as a page is what fits in one output.
  listing(windowId) {
    const window = this.#window(windowId);
    const messages = this.windows.messages(window).map((record) => this.#listed(record));
    return { window, messages };
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
    const ids = this.#idsInWindow(window, messageIds);
    const body = checkedText(text);
    const target = await this.#liveTopic(topic);
    const notedBefore = () =>
      new Refusal(`第 ${window.id} 段已经给话题 ${shortId(target.id)} 转过一份了，每段时间每个话题只转一份`);
    if (this.windows.noteFor(window.id, target.id)) throw notedBefore();
    const kept = this.windows.addNote({
      window,
      topicId: target.id,
      topicTitle: target.title,
      messageIds: ids,
      text: `${body}\n涉及的消息：${ids.join('、')}`,
      status: window.mode === 'on' ? 'pending' : 'dry',
    });
    // Another note for the topic got in between the check and this one.
    if (!kept) throw notedBefore();
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

  // The message ids of a note, every one of them listed in the window.
  #idsInWindow(window, messageIds) {
    const ids = idsOf(messageIds);
    if (!ids.length) throw new Refusal('至少写一条消息 id：摘要说的是这一段里的哪几条消息');
    if (ids.length > NOTE_MESSAGES)
      throw new Refusal(`一份摘要最多写 ${NOTE_MESSAGES} 条消息，这次有 ${ids.length} 条：只写这个话题要知道的`);
    const listed = new Set(this.windows.messages(window).map((record) => record.id));
    const outside = ids.find((id) => !listed.has(id));
    if (outside)
      throw new Refusal(
        `消息 ${outside} 不在第 ${window.id} 段里：只能写 butler route messages ${window.id} 列出的消息 id`,
      );
    return ids;
  }
}
