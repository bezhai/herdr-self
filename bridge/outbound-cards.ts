import { plain, submitForm } from './request-cards.ts';
import { untitled } from './message-cards.ts';
import type { ButtonValue } from './request-cards.ts';
import type { Mention, OwnerChat } from './state.ts';
import type { OwnerMessage, Sent, DocGrant } from './link.ts';
import type { Delivery } from './task-types.ts';
import type { Progress } from './outbox.ts';
// Feishu cards (JSON 2.0) of the owner's channel in the thread of a topic (see Messages), which the bot posts without a header like the other
// status cards of Bridge (see message-cards.ts): the card of a message that the agent brought in, and the card of a message that it drafted
// to send as the owner. They name people and chats by their names only, never 他 or 她. A time shows as HH:mm on the day of now, else as
// M月D日 HH:mm, in the time zone of the process. Message bodies from Feishu or the agent are shown as plain text, never as markdown; a draft
// title uses the card's markdown only for bold, with its chat name escaped. bridge-message imports this module too (see sourceLine and
// oversized), so it loads only Node's built-in modules and the modules above.

// A plain-text block with a documented JSON 2.0 text style, used here for grey notes.
const styled = (content: string, style: object) => ({ tag: 'div', text: { tag: 'plain_text', content, ...style } });
// Secondary text is small and grey.
const grey = (content: string) => styled(content, { text_size: 'notation', text_color: 'grey' });
// Markdown punctuation in a chat name stays literal inside the fixed bold markers of a title.
const escapeMarkdown = (content: string) => content.replace(/[\\`*_{}\[\]()#+\-.!|<>~]/g, '\\$&');
// A draft's destination is a bold title line, not the card's header.
const heading = (content: string) => ({ tag: 'markdown', content: `**${escapeMarkdown(content)}**` });
// A draft body keeps its exact text in a grey block, a column_set of one column, because JSON 2.0 has no quote container.
const quote = (content: string) => ({
  tag: 'column_set',
  background_style: 'grey',
  columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [plain(content)] }],
});
// A button that reports its action and this drawing's render number.
const click = (content: string, type: string, value: ButtonValue) => ({
  tag: 'button',
  text: { tag: 'plain_text', content },
  type,
  behaviors: [{ type: 'callback', value }],
});
// An action in the row under a pending draft.
const column = (content: string, type: string, value: ButtonValue) => ({
  tag: 'column',
  width: 'auto',
  elements: [click(content, type, value)],
});
// Where a message that the owner sends goes: a chat, the message it replies to when it quotes one (the id open-lark gave it), and thread, true
// when that message is inside a thread, where the reply goes too.
export type Address = OwnerChat & { replyTo?: string; thread?: boolean };
// An image or a file that goes out after the text of a message, as the draft keeps it: kind, its name in the chat, its size in bytes, and id,
// under which the outbox keeps its bytes (see outbox.ts) and with which open-lark sends it.
export type Attachment = { kind: 'image' | 'file'; name: string; size: number; id: string };
// The role on a doc that a chat gets: view or edit.
export type DocRole = 'view' | 'edit';
// What a message that the owner sends says: its text, which holds @<name> for each of the mentions, the images and files that go out after
// it in their order, and docAccess, the role on the docs that it links which its chat gets once it is sent.
export type Body = { text: string; mentions: Mention[]; attachments?: Attachment[]; docAccess?: DocRole };
// What went out for a body (the receipt of its delivery): the text, the open-lark message id of each attachment in its order (null when
// open-lark did not name it), and for docAccess, what became of each doc, or docsError when they could not be opened at all.
export type Receipt = Sent & { attachments?: (string | null)[]; docs?: DocGrant[]; docsError?: string };
// The most a draft may carry, in bytes: each image or file, all of them together, and an image, which open-lark takes as base64 of at most
// 10 MiB characters.
export const draftLimits = { each: 20 * 1024 * 1024, draft: 50 * 1024 * 1024, image: 7.5 * 1024 * 1024 };
// Why images and files of these kinds, names and sizes cannot go with one draft, or undefined when they can. bridge-message asks this before it
// reads the files, and Bridge again for what it received.
export function oversized(list: { kind: string; name: string; size: number }[]): string | undefined {
  for (const a of list) {
    if (a.size > draftLimits.each) return `${a.name} 超过每个附件 20 MB 的上限`;
    if (a.kind === 'image' && a.size > draftLimits.image)
      return `图片 ${a.name} 超过 7.5 MB：open-lark 发不了这么大的图片，改用 --file 发送`;
  }
  if (list.reduce((n, a) => n + a.size, 0) > draftLimits.draft) return '附件加起来超过每份草稿 50 MB 的上限';
}
// The links in text, whose docs a doc access opens, without the punctuation that ends a sentence after them.
export const links = (text: string) =>
  [...text.matchAll(/https?:\/\/[^\s<>"'（）()「」【】，。；！？、]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
// A size in bytes as the owner reads it: 900 B, 120 KB, 3.2 MB.
const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const roleNames = { view: '查看', edit: '编辑' };
const kindNames = { image: '图片', file: '文件' };
// What a draft carries besides its text, as plain blocks: its attachments with their sizes, and the docs whose access opens once it is sent.
function carried({ text, attachments = [], docAccess }: Body): object[] {
  const found = links(text);
  return [
    ...(attachments.length
      ? [
          plain(
            ['正文之后发送：', ...attachments.map((a) => `${kindNames[a.kind]} ${a.name} · ${bytes(a.size)}`)].join(
              '\n',
            ),
          ),
        ]
      : []),
    ...(docAccess
      ? [
          plain(
            [
              `发出后给这个聊天开放文档的${roleNames[docAccess]}权限：`,
              ...(found.length ? found : ['正文里没有链接']),
            ].join('\n'),
          ),
        ]
      : []),
  ];
}
// What became of the doc access of a sent body: how many docs got the role and which did not and why, or why none could.
function opened(role: DocRole, { docs = [], docsError }: Receipt): string {
  if (docsError) return '文档权限没有开放：' + docsError;
  if (!docs.length) return '没有找到可以开放权限的文档';
  const granted = docs.filter((d) => d.granted).length;
  return [
    ...(granted ? [`已给这个聊天开放 ${granted} 个文档的${roleNames[role]}权限`] : []),
    ...docs.filter((d) => !d.granted).map((d) => `没有开放：${d.title || d.url}：${d.reason}`),
  ].join('\n');
}
// The local wall time of at, with its month and day when now falls on another local day.
function time(at: number, now: number) {
  const date = new Date(at),
    current = new Date(now),
    clock = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  const same =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  return same ? clock : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}
// Where source s came from, in one line: <sender> · <the chat's name, or 私聊 for a direct chat> · <time>, such as 孙栎倩 · 私聊 · 12:45 or
// 陈帆 · GEO 小分队 · 10:49. The source card shows it, and bridge-message prints it.
export function sourceLine(s: Pick<OwnerMessage, 'sender' | 'chatName' | 'chatType' | 'at'>, now: number): string {
  return `${s.sender.name} · ${s.chatType === 'p2p' ? '私聊' : s.chatName} · ${time(s.at, now)}`;
}
// The card of message m that an agent brought into its topic: sourceLine in grey, what m says, and 查看原消息 linking to m.link when there is one.
export function sourceCard(m: OwnerMessage, now: number): object {
  const line = sourceLine(m, now);
  return untitled(
    line,
    [
      grey(line),
      plain(m.text),
      ...(m.link
        ? [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '查看原消息' },
              type: 'default',
              behaviors: [{ type: 'open_url', default_url: m.link }],
            },
          ]
        : []),
    ],
    m.link ? { update_multi: true } : undefined,
  );
}
// How the card of a draft shows it: as its delivery's state has it (pending while awaiting or failed, sent, dropped when the owner did not send
// it, withdrawn when the agent took it back), or editing while the owner changes its text.
export type DraftView = 'pending' | 'sent' | 'dropped' | 'withdrawn' | 'editing';
// The card of delivery d, a message for the owner's channel, as view, where quoted is the message that a reply quotes. pending: where it goes and
// as whom (with 发在话题里 for a reply into a thread), the text, what it carries besides (see carried), 发送, 修改 and 不发, and
// 发送失败：<failure> above the text when the last attempt failed (failure, else the delivery's error). progress is what of its send went out
// (see Outbox): once the text did, 修改 is gone, and dropped says what went out. editing: a form whose input, named text, holds the text,
// with 发送, which submits it, and 取消. sent, dropped and withdrawn keep the text but have no buttons; sent says what became of the doc access. Every button carries {draft:<its action>,deliveryId:d.id,render}: every drawing of a card that can be clicked needs its own render
// number (see pending in request-cards.ts).
export function draftCard(
  d: Delivery,
  view: DraftView,
  {
    render,
    now,
    quoted,
    failure = d.error ?? undefined,
    progress,
  }: { render: number; now: number; quoted?: OwnerMessage; failure?: string; progress?: Progress },
): object {
  const to = (d.target as { to: Address }).to,
    body = d.body as Body,
    { text } = body,
    deliveryId = d.id;
  const title = to.chatType === 'p2p' ? `回复 ${to.chatName}` : `发到 ${to.chatName}`;
  const destination = to.chatType === 'p2p' ? `发到你和 ${to.chatName} 的私聊，以你的身份发送` : '以你的身份发送';
  const about =
    destination +
    (quoted ? `，引用 ${quoted.sender.name} ${time(quoted.at, now)} 的消息` : '') +
    (to.thread ? '，发在话题里' : '');
  const send: ButtonValue = { draft: 'send', deliveryId, render };
  if (view === 'editing') {
    const form = submitForm(
      'draft',
      [{ tag: 'input', name: 'text', input_type: 'multiline_text', width: 'fill', default_value: text }],
      '发送',
      send,
    );
    form.elements.push(click('取消', 'default', { draft: 'cancel', deliveryId, render }));
    return untitled(title, [heading(title), grey(about), ...carried(body), form], { update_multi: true });
  }
  const elements: object[] = [
    heading(title),
    grey(about),
    ...(view === 'pending' && failure ? [plain('发送失败：' + failure)] : []),
    quote(text),
    ...carried(body),
  ];
  const went = progress?.text ? Object.keys(progress.attachments).length : undefined;
  if (view === 'pending')
    elements.push({
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: [
        column('发送', 'primary', send),
        ...(went === undefined ? [column('修改', 'default', { draft: 'edit', deliveryId, render })] : []),
        column('不发', 'default', { draft: 'drop', deliveryId, render }),
      ],
    });
  if (view === 'sent') {
    const receipt = d.receipt as Receipt;
    elements.push(plain(`已发送给 ${to.chatName} · ${time(receipt.at, now)}`));
    if (body.docAccess) elements.push(plain(opened(body.docAccess, receipt)));
  }
  if (view === 'dropped')
    elements.push(plain(went === undefined ? '未发送' : `已发出正文${went ? `和 ${went} 个附件` : ''}，其余未发送`));
  if (view === 'withdrawn') elements.push(plain('Agent 已撤回'));
  return untitled(title, elements, { update_multi: true });
}
