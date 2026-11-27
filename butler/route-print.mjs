// What the route commands print (see cli.mjs route): plain text an agent or a person reads, one fact per line.
import { PAGE_SIZE, TEXT_CHARS, oneLine, clip, shortId } from './route-tools.mjs';

const EXCHANGE_CHARS = 100;
const REPLY_CHARS = 200;
const KIND_WORDS = { group: '群', direct: '私聊', topic: '话题群' };
const DRAFT_STATES = {
  delivered: '已发出',
  awaiting: '等确认',
  sending: '正在发',
  failed: '发送失败',
  rejected: '没有发',
};
const NOTE_STATES = { dry: '干跑', pending: '等着交', given: '已交给 Bridge', dropped: 'Bridge 没收下' };
export const MODE_WORDS = { 'dry-run': '干跑', on: '交给 Bridge', preview: '预览' };
const WINDOW_STATES = { open: '还没分派完', done: '分派完了', skipped: '跳过了' };

const localTime = (ms) => new Date(ms).toLocaleString('sv-SE');
const fullTime = (ms) => localTime(ms).slice(0, 16);
const shortTime = (ms) => localTime(ms).slice(5, 16);
const indented = (text, by = '  ') => String(text).replaceAll('\n', `\n${by}`);

// "2026-11-27 10:00 到 10:10", or with the date of the end when it is another day.
export function spanText(window, joiner = ' 到 ') {
  const from = fullTime(window.from.at);
  const until = fullTime(window.until);
  const sameDay = from.slice(0, 10) === until.slice(0, 10);
  return `${from}${joiner}${sameDay ? until.slice(11) : until}`;
}

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

function windowLine(window) {
  const mode = window.mode === 'preview' ? '' : `（${MODE_WORDS[window.mode]}）`;
  const tried = window.attempts ? `，失败过 ${window.attempts} 次` : '';
  const error = window.error && window.state !== 'done' ? `：${clip(oneLine(window.error), REPLY_CHARS)}` : '';
  return `第 ${window.id} 段  ${spanText(window)}  ${WINDOW_STATES[window.state]}${mode}${tried}${error}`;
}

function noteLines(note) {
  const error = note.error ? `（${note.error}）` : '';
  const heading = `话题 ${shortId(note.topicId)}「${note.topicTitle}」  ${NOTE_STATES[note.status]}  ${note.messageIds.length} 条消息${error}`;
  return [`  ${heading}`, `    ${indented(note.text, '    ')}`];
}

function windowLines(window) {
  const lines = [windowLine(window)];
  if (window.state === 'done' && !window.notes.length) lines.push('  没有转给任何话题');
  for (const note of window.notes) lines.push(...noteLines(note));
  if (window.reply) lines.push(`  Agent 最后说：${clip(oneLine(window.reply), REPLY_CHARS)}`);
  return lines;
}

// A note of the router before windows.
function earlierLines(note) {
  const error = note.error ? `（${note.error}）` : '';
  const heading = `${shortTime(note.at)}  ${NOTE_STATES[note.status] ?? note.status}  话题「${note.topicTitle}」  ${note.messageIds.length} 条消息${error}`;
  return [heading, `  ${indented(note.text)}`];
}

export function formatLog({ windows, previews, earlier }) {
  const sections = [];
  if (windows.length) sections.push(['定时分派', windows.flatMap(windowLines)]);
  if (previews.length) sections.push(['预览', previews.flatMap(windowLines)]);
  if (earlier.length) sections.push(['分段以前的转交', earlier.flatMap(earlierLines)]);
  if (!sections.length) return '这段时间没有分派过（加工端的 BUTLER_ROUTING 是 dry-run 或 on 时才分派）';
  return sections.map(([title, lines]) => [`== ${title} ==`, ...lines].join('\n')).join('\n\n');
}

export function formatPreview(result) {
  if (result.skipped) return `${result.skipped}，没有启动分派 Agent`;
  const { window, messages, topics, notes } = result;
  const lines = [
    `预览第 ${window.id} 段（${spanText(window)} 收下的消息）：新消息 ${messages} 条，进行中的话题 ${topics} 个；写了 ${notes.length} 份摘要，只记下，没有交给 Bridge`,
  ];
  for (const note of notes) {
    const heading = `== 话题 ${shortId(note.topicId)}「${note.topicTitle}」：${note.messageIds.length} 条消息 ==`;
    lines.push('', heading, note.text);
  }
  if (result.error) lines.push('', `没有分派完：${result.error}`);
  else if (window.reply) lines.push('', `Agent 最后说：${window.reply}`);
  return lines.join('\n');
}
