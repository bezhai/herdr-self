import { invalid, string } from './machine-tools.ts';
import type { Methods, ClientApi } from './link.ts';
// The owner's channel: open-lark, a Feishu web client logged in as the owner, which runs on one machine and listens there only. The client
// of that machine reads chats and messages, sends messages, images and files and opens docs to chats through open-lark's agent API (/agent/v1) as the owner, for the control
// plane (see ClientApi in link.ts, where the methods and their error codes are). The full token of open-lark, which can do whatever the
// owner can in Feishu, is in that client's config file only (see readConfig in client.ts): it never travels, never reaches the control
// plane, and is in the environment of no program that the client runs. Ids are open-lark's, not the open platform's ids of the bot. It
// uses only Node's built-in modules, like the client.

// openLark of the config of a client (see readConfig): url, the origin of open-lark's agent server on this machine, such as
// http://127.0.0.1:8081, and token, its full token.
export type OpenLark = { url: string; token: string };
type OwnerMethods = Pick<
  Methods<ClientApi>,
  | 'openLarkMessage'
  | 'openLarkChat'
  | 'openLarkReply'
  | 'openLarkSend'
  | 'openLarkImage'
  | 'openLarkFile'
  | 'openLarkDocAccess'
>;
// The part of open-lark's stored message that the owner's channel reads. Other parts keep their text; files name themselves in text.
type Part = { kind: string; text?: string };
// The fields of open-lark's message, conversation and current-account responses used here. threadMessageType is reply for a reply inside a
// thread (or a topic), root for the root of one, and none or missing otherwise.
type Item = {
  id: string;
  feedId: string;
  senderId: string;
  senderName: string;
  createdAt: string;
  parts: Part[];
  textPreview?: string;
  threadMessageType?: string;
};
type Conversation = { feedId: string; name: string; chatMode: 'direct' | 'group' | 'topic' };
type Me = { userId: string; displayName: string };
// A send is acknowledged by its real message id. Current open-lark has no timestamp here; accept its ISO createdAt or sentAt when it has one.
// A reply that went into a thread names the thread's root.
type SendAnswer = { messageId: string; createdAt?: string; sentAt?: string; threadRootMessageId?: string };
// A doc that open-lark lists for a message: the roles the owner may give the chat on it (options) and the one the chat has (granted).
type DocItem = { url: string; title: string; options: string[]; granted?: string };
// The roles of a doc as the owner reads them.
const roleNames = { view: '查看', edit: '编辑' } as const;
// The outgoing fields as the ClientApi receives them, before mentions take open-lark's userId spelling.
type Outgoing = { clientId: string; text: string; mentions: { id: string; name: string }[]; thread?: boolean };
// An error whose code crosses the client link, with no response body or credential copied into it.
const coded = (code: string, message: string) => Object.assign(Error(message), { code });
// A connection failure and a timeout deliberately look alike to the caller: after either, a send may or may not have gone out.
const unreachable = () => coded('channel_unreachable', 'open-lark 没有响应');
// The chat as the control plane displays and stores it: direct is p2p; both ordinary groups and topic groups are group.
const ownerChat = (c: Conversation) => ({
  chatId: c.feedId,
  chatName: c.name,
  chatType: (c.chatMode === 'direct' ? 'p2p' : 'group') as 'p2p' | 'group',
});
// Base64 of at most max characters, as open-lark's media routes take it.
function base64(v: unknown, what: string, max: number) {
  const s = string(v, what);
  if (s.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw invalid(what);
  return s;
}
// The base64 of the largest file that open-lark sends, 100 MiB.
const fileChars = 4 * Math.ceil((100 * 1024 * 1024) / 3);
// A file name as open-lark takes it: 1 to 255 characters.
function fileName(v: unknown) {
  const s = string(v, 'name');
  if (!s.trim() || s.length > 255) throw invalid('name');
  return s;
}
// Validate and convert a send before /me is read, so a malformed call cannot result in any request to open-lark.
function outgoing(p: Outgoing) {
  const clientId = string(p.clientId, 'clientId'),
    text = string(p.text, 'text');
  if (!text.trim()) throw invalid('text 不能为空');
  if (text.trim().length > 100000) throw invalid('text 不能超过 100000 字');
  if (!Array.isArray(p.mentions) || p.mentions.length > 100) throw invalid('mentions 必须是最多 100 项的数组');
  const mentions = p.mentions.map((m) => {
    if (!m || typeof m !== 'object') throw invalid('mentions 的每一项都必须是 {id,name}');
    const id = string((m as { id?: unknown }).id, 'mention.id'),
      name = string((m as { name?: unknown }).name, 'mention.name');
    if (id.trim().length > 128) throw invalid('mention.id 不能超过 128 字');
    if (!name.trim() || name.trim().length > 256) throw invalid('mention.name');
    if (!text.includes('@' + name)) throw invalid(`正文里没有 @${name}`);
    return { userId: id, name };
  });
  return { clientId, text, mentions };
}
// One agent API request. GET has no body; a POST body, including an empty link request, is JSON, except the bytes of a file, which go as
// they are. The abort covers headers and the JSON body.
async function request<T>(
  config: OpenLark,
  method: 'GET' | 'POST',
  path: string,
  body: object | Buffer | undefined,
  timeoutMs = 12000,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw invalid('timeoutMs');
  const signal = AbortSignal.timeout(timeoutMs),
    raw = Buffer.isBuffer(body);
  let r: Response;
  try {
    r = await fetch(`${config.url}/agent/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body !== undefined && { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
      },
      ...(body !== undefined && { body: raw ? new Uint8Array(body) : JSON.stringify(body) }),
      signal,
    });
  } catch {
    throw unreachable();
  }
  let data: any;
  try {
    data = await r.json();
  } catch {
    if (signal.aborted) throw unreachable();
    throw coded('channel_refused', r.ok ? 'open-lark 返回了无法解析的响应' : `open-lark 返回 HTTP ${r.status}`);
  }
  if (!r.ok) {
    const e = data?.error,
      message =
        e && typeof e.code === 'string' && typeof e.message === 'string'
          ? `${e.code}：${e.message}`
          : `open-lark 返回 HTTP ${r.status}`;
    throw coded('channel_refused', message);
  }
  return data as T;
}
// The methods of the owner's channel with open-lark at config, or, without one, methods that all reject with code channel_unconfigured.
export function openLarkMethods(config: OpenLark | undefined): OwnerMethods {
  if (!config) {
    const missing = async () => {
      throw coded('channel_unconfigured', '这台机器的 Bridge 客户端没有配置 open-lark');
    };
    return {
      openLarkMessage: missing,
      openLarkChat: missing,
      openLarkReply: missing,
      openLarkSend: missing,
      openLarkImage: missing,
      openLarkFile: missing,
      openLarkDocAccess: missing,
    };
  }
  // Cache only a successful current-account lookup per client. A failed lookup is retried; a later account switch is stopped by expectedSenderId.
  let account: Promise<Me> | undefined;
  const me = (timeoutMs?: number) => {
    account ??= request<Me>(config, 'GET', '/me', undefined, timeoutMs).catch((e) => {
      account = undefined;
      throw e;
    });
    return account;
  };
  // Send or quote-reply as the account just read. Use its acknowledged timestamp when supplied, otherwise the response-arrival time. A reply into
  // a thread asks for replyMode thread: for a reply inside a thread open-lark sends what it sends for direct (it quotes the message inside its
  // thread), but where it cannot find the thread's root, thread refuses with THREAD_ROOT_UNRESOLVED and direct quietly posts to the chat.
  const deliver = async (path: string, p: Outgoing, timeoutMs: number | undefined, reply: boolean) => {
    const { text, mentions, clientId } = outgoing(p),
      owner = await me(timeoutMs);
    // A refusal with SENDER_CHANGED means the cached account is stale: drop it so the caller's retry reads /me again. It is not retried here.
    const result = await request<SendAnswer>(
      config,
      'POST',
      path,
      {
        text,
        mentions,
        clientId,
        expectedSenderId: owner.userId,
        ...(reply && { replyMode: p.thread === true ? 'thread' : 'direct' }),
      },
      timeoutMs,
    ).catch((e) => {
      if (typeof e?.message === 'string' && e.message.startsWith('SENDER_CHANGED：')) account = undefined;
      throw e;
    });
    const stamp = result.createdAt ?? result.sentAt;
    return {
      messageId: result.messageId,
      at: stamp ? Date.parse(stamp) : Date.now(),
      owner: owner.displayName,
      ...(result.threadRootMessageId && { threadRoot: result.threadRootMessageId }),
    };
  };
  // Give the chat of message messageId role on doc d, unless it has that role or more already or the owner may not give it; what became of it.
  // A grant that fails, refused or unanswered, fails for this doc only.
  const grant = async (messageId: string, d: DocItem, role: 'view' | 'edit', timeoutMs: number | undefined) => {
    const doc = { url: d.url, title: d.title };
    if (d.granted === role || d.granted === 'edit') return { ...doc, granted: true };
    if (!d.options.includes(role))
      return {
        ...doc,
        granted: false,
        reason: d.options.length
          ? `只能开放${d.options.map((o) => roleNames[o as 'view' | 'edit'] ?? o).join('、')}权限`
          : '你不能开放这个文档的权限',
      };
    try {
      await request(
        config,
        'POST',
        '/messages/doc-permissions',
        { grants: [{ messageId, url: d.url, role }] },
        timeoutMs,
      );
      return { ...doc, granted: true };
    } catch (e) {
      return { ...doc, granted: false, reason: String(e?.message ?? e) };
    }
  };
  return {
    async openLarkMessage({ messageId, timeoutMs }) {
      const id = encodeURIComponent(string(messageId, 'messageId')),
        item = await request<{ item: Item }>(config, 'GET', `/messages/${id}`, undefined, timeoutMs).then(
          (r) => r.item,
        );
      const chat = ownerChat(
        await request<Conversation>(
          config,
          'GET',
          `/conversations/${encodeURIComponent(item.feedId)}`,
          undefined,
          timeoutMs,
        ),
      );
      // A permalink is useful but incidental: neither a refusal nor an unreachable link endpoint may hide a message already read.
      const link = await request<{ url: string }>(config, 'POST', `/messages/${id}/link`, {}, timeoutMs)
        .then((r) => r.url)
        .catch(() => undefined);
      const text =
        item.parts
          .map((p) => (p.kind === 'image' ? '[图片]' : p.kind === 'file' ? `[文件] ${p.text ?? ''}` : (p.text ?? '')))
          .join('') ||
        item.textPreview ||
        '';
      return {
        ...chat,
        messageId: item.id,
        sender: { id: item.senderId, name: item.senderName },
        at: Date.parse(item.createdAt),
        text,
        ...(link ? { link } : {}),
        ...(item.threadMessageType === 'reply' && { inThread: true }),
      };
    },
    async openLarkChat({ chatId, timeoutMs }) {
      const id = encodeURIComponent(string(chatId, 'chatId'));
      return ownerChat(await request<Conversation>(config, 'GET', `/conversations/${id}`, undefined, timeoutMs));
    },
    async openLarkReply({ messageId, timeoutMs, ...params }) {
      const id = encodeURIComponent(string(messageId, 'messageId'));
      return deliver(`/messages/${id}/replies`, params, timeoutMs, true);
    },
    async openLarkSend({ chatId, timeoutMs, ...params }) {
      const id = encodeURIComponent(string(chatId, 'chatId'));
      return deliver(`/conversations/${id}/messages`, params, timeoutMs, false);
    },
    // open-lark places an image that replies to a message as it places a text reply, so it takes the same replyMode.
    async openLarkImage({ chatId, clientId, name, mimeType, data, replyTo, thread, timeoutMs }) {
      const id = encodeURIComponent(string(chatId, 'chatId'));
      if (!string(mimeType, 'mimeType').startsWith('image/')) throw invalid('mimeType');
      const body = {
        clientId: string(clientId, 'clientId'),
        data: base64(data, 'data', 10 * 1024 * 1024),
        mimeType,
        name: fileName(name),
        ...(replyTo !== undefined && {
          replyTo: string(replyTo, 'replyTo'),
          replyMode: thread === true ? 'thread' : 'direct',
        }),
      };
      return {
        messageId: (
          await request<{ messageId: string }>(config, 'POST', `/conversations/${id}/images`, body, timeoutMs)
        ).messageId,
      };
    },
    // A file is the bytes of the request, and where it goes is in its query: replyTo quotes a message, and threadRootId puts it inside a thread.
    async openLarkFile({ chatId, clientId, name, data, replyTo, threadRoot, timeoutMs }) {
      const id = encodeURIComponent(string(chatId, 'chatId')),
        bytes = Buffer.from(base64(data, 'data', fileChars), 'base64');
      const query = new URLSearchParams({
        clientId: string(clientId, 'clientId'),
        name: fileName(name),
        ...(replyTo !== undefined && { replyTo: string(replyTo, 'replyTo') }),
        ...(threadRoot !== undefined && { threadRootId: string(threadRoot, 'threadRoot') }),
      });
      return {
        messageId:
          (
            await request<{ messageId?: string }>(
              config,
              'POST',
              `/conversations/${id}/files?${query}`,
              bytes,
              timeoutMs,
            )
          ).messageId ?? null,
      };
    },
    // open-lark lists a doc once per message and url; a url that it lists twice is granted once.
    async openLarkDocAccess({ messageId, role, timeoutMs }) {
      const id = string(messageId, 'messageId');
      if (role !== 'view' && role !== 'edit') throw invalid('role');
      const { items } = await request<{ items: DocItem[] }>(
        config,
        'GET',
        `/messages/doc-permissions?ids=${encodeURIComponent(id)}`,
        undefined,
        timeoutMs,
      );
      const docs = [...new Map(items.map((d) => [d.url, d])).values()];
      const granted = [];
      for (const d of docs) granted.push(await grant(id, d, role, timeoutMs));
      return { docs: granted };
    },
  };
}
