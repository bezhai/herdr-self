// The routing agent's tools over a test store and a fake Bridge: the window listing, the topic listing and one-topic read,
// and the note with its checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBridge, KEY } from './fake-bridge.mjs';
import { tempStore, post } from './helpers.mjs';
import { Bridge } from '../bridge-client.mjs';
import { RouteWindows } from '../route-windows.mjs';
import { RouteTools, Refusal } from '../route-tools.mjs';
import { formatMessages, formatTopics, formatTopic, pageOf, OUTPUT_BYTES } from '../route-print.mjs';

process.env.TZ = 'Asia/Shanghai';
const BRIDGE_BOT = '7100000000000000001';
const OWN_BOT = '7100000000000000002';
const T0 = Date.parse('2026-11-27T10:00:00+08:00');
const minute = (n) => T0 + n * 60e3;
const FIRE = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  title: '火山发文平台映射',
  goal: '改火山发文的接口',
  chatId: 'oc_1',
  chatName: '火山发文 - [需求同步群]',
  createdAt: Date.parse('2026-11-26T15:00:00+08:00'),
  adopted: false,
  pending: 0,
  exchanges: [
    { from: 'owner', at: minute(-60), text: '把接口改好以后发给评审群' },
    { from: 'agent', at: minute(-50), text: '已改好，起草了发给评审群的消息' },
  ],
  sources: [
    {
      messageId: '7301',
      chatId: '7001',
      chatName: '产品群',
      sender: '陈帆',
      at: minute(-90),
      text: '接口什么时候好？',
    },
  ],
  drafts: [
    {
      chatId: '7002',
      chatName: '评审群',
      replyTo: '7301',
      state: 'delivered',
      at: minute(-40),
      text: '请帮忙评审接口改动',
      sent: { messageId: '7302' },
    },
  ],
};
const REVIEW = {
  ...FIRE,
  id: 'a1b2ffff-0000-4000-8000-000000000002',
  title: '接管 · review',
  goal: '接管 · review',
  adopted: true,
  pending: 1,
  exchanges: [],
  sources: [],
  drafts: [],
};

// A store with a fake Bridge whose live topics are FIRE and REVIEW, and tools over them.
async function world(t) {
  const { store } = tempStore(t);
  const bridge = await new FakeBridge().listen();
  t.after(() => bridge.close());
  bridge.topics = structuredClone([FIRE, REVIEW]);
  const windows = new RouteWindows(store, { bridgeBotId: BRIDGE_BOT, ownBotId: OWN_BOT });
  const tools = new RouteTools({ store, windows, bridge: new Bridge({ url: bridge.url, key: KEY }) });
  return { store, bridge, windows, tools };
}
// A message stored n minutes after T0, sent when it was stored unless o.at says otherwise (see post in helpers.mjs).
const say = (f, n, o = {}) => post(f.store, { at: minute(n), seen: minute(n), categories: ['stored'], ...o });
// The window of the 10 minutes after T0.
const tenMinutes = (f, mode = 'dry-run') => f.windows.create({ from: { at: T0, id: null }, until: minute(10), mode });
const listed = (f, window) => f.tools.listing(window.id).messages.map((m) => m.text);
const bytesOf = (text) => Buffer.byteLength(text);
const refusal = (pattern) => (e) => e instanceof Refusal && pattern.test(e.message);

test("a window lists what butler stored in it; it leaves out only Bridge's and butler's bots, the owner in a Bridge topic thread, and history sent over a day before it was stored", async (t) => {
  const f = await world(t);
  say(f, -1, { text: '上一段的' });
  say(f, 1, { text: '别人的' });
  say(f, 2, { text: '我在别处说的', mine: true });
  say(f, 3, { text: '审批通过', type: 'bot', sender: '7100000000000000009', name: '审批' });
  say(f, 4, { text: 'Bridge 机器人说的', sender: BRIDGE_BOT, type: 'bot' });
  say(f, 4, { text: '管家机器人说的', sender: OWN_BOT, type: 'bot' });
  const root = say(f, 5, { text: '话题的根', sender: BRIDGE_BOT, type: 'bot' });
  say(f, 5, { text: '我在 Bridge 话题里说的', mine: true, rootId: root, threadRole: 'reply' });
  say(f, 5, { text: '别人在 Bridge 话题里说的', rootId: root, threadRole: 'reply' });
  const mine = '7299000000000000001';
  say(f, 6, { id: mine, text: '我开的 thread', mine: true, rootId: mine, threadRole: 'root' });
  say(f, 6, { text: '机器人在我的 thread 里回复', sender: BRIDGE_BOT, type: 'bot', rootId: mine, threadRole: 'reply' });
  say(f, 6, { text: '我在那个 thread 里接着说', mine: true, rootId: mine, threadRole: 'reply' });
  say(f, 7, { text: '刚进群看到的旧消息', at: minute(7) - 86_400_000 - 1 });
  say(f, 7, { text: '一天以内的旧消息', at: minute(7) - 86_400_000 + 60e3 });
  say(f, 11, { text: '下一段的' });
  assert.deepEqual(listed(f, tenMinutes(f)), [
    '一天以内的旧消息',
    '别人的',
    '我在别处说的',
    '审批通过',
    '别人在 Bridge 话题里说的',
  ]);
});

test('the listing groups messages by chat and gives each its id, time, sender, thread and reply, cut to one line, so that an agent can judge it and read the original with ol', async (t) => {
  const f = await world(t);
  const question = say(f, 1, { chat: 'g1', name: '陈帆', text: '接口什么时候好？\n今天能发吗' });
  say(f, 2, { chat: 'd1', name: '张三', text: '在吗' });
  say(f, 3, { chat: 'g1', name: '金垠廷', text: '今天下午', parentId: question });
  say(f, 4, { chat: 'g1', text: 'x'.repeat(400), rootId: question, threadRole: 'reply' });
  say(f, 5, { chat: 'g1', mine: true, text: '好的' });
  const listing = pageOf(f.tools.listing(tenMinutes(f).id));
  const [first, , reply, long, mine] = listing.messages.map((m) => m.id);
  assert.equal(
    formatMessages(listing),
    [
      '第 1 段（2026-11-27 10:00 到 10:10 收下的消息）：新消息 5 条，第 1/1 页。正文超过 300 字的截断了，全文用 ol GET /messages/<消息 id> 读。',
      '',
      '== 项目群 · 群 · feedId g1 ==',
      `${first}  11-27 10:01  陈帆：接口什么时候好？ 今天能发吗`,
      `${reply}  11-27 10:03  金垠廷 · 回复 ${first}（陈帆：接口什么时候好？ 今天能发吗）：今天下午`,
      `${long}  11-27 10:04  陈帆 · thread ${first}（陈帆：接口什么时候好？ 今天能发吗）里：${'x'.repeat(299)}…`,
      `${mine}  11-27 10:05  原智鸿（我）：好的`,
      '',
      '== 张三 · 私聊 · feedId d1 ==',
      `${listing.messages[1].id}  11-27 10:02  张三：在吗`,
    ].join('\n'),
  );
});

test('a big window is read in pages of at most 50, and each page says how to read the next', async (t) => {
  const f = await world(t);
  for (let n = 0; n < 120; n++) say(f, 1 + n / 20, { text: `第 ${n + 1} 条` });
  const window = tenMinutes(f);
  const listing = f.tools.listing(window.id);
  const first = pageOf(listing);
  assert.deepEqual([first.total, first.page, first.pages, first.after, first.messages.length], [120, 1, 3, 70, 50]);
  assert.match(formatMessages(first), /还有 70 条：butler route messages 1 --page 2$/);
  const last = pageOf(listing, 3);
  assert.deepEqual(
    [last.messages.length, last.messages[0].text, last.messages.at(-1).text],
    [20, '第 101 条', '第 120 条'],
  );
  assert.doesNotMatch(formatMessages(last), /还有/);
  assert.throws(() => pageOf(listing, 4), refusal(/第 1 段只有 3 页/));
  assert.throws(() => f.tools.listing(9), refusal(/没有第 9 段/));
});

// Claude Code shows the agent a command's output only up to about 30000 bytes; a longer one goes to a file that the
// agent reads with cat or grep. These print the widest the tools allow: 4-byte characters wherever there is text.
test('a page of long messages holds fewer of them, so that what it prints stays within OUTPUT_BYTES; together the pages list the window once, in order', async (t) => {
  const f = await world(t);
  const wide = (n) => '😀'.repeat(n);
  const root = say(f, 0.1, { text: wide(100) });
  const parent = say(f, 0.2, { text: wide(100), rootId: root, threadRole: 'reply' });
  for (let n = 0; n < 120; n++)
    say(f, 1 + n / 20, {
      chat: `群${wide(30)}${n}`,
      name: wide(20),
      type: 'bot',
      text: wide(400),
      parentId: parent,
      rootId: root,
      threadRole: 'reply',
    });
  const listing = f.tools.listing(tenMinutes(f).id);
  const pages = [];
  for (let page = 1; page <= pageOf(listing).pages; page++) pages.push(pageOf(listing, page));
  assert.ok(pages.length > 3, `${pages.length} pages, fewer than 50 messages on each`);
  for (const page of pages) {
    const printed = formatMessages(page);
    assert.ok(bytesOf(printed) <= OUTPUT_BYTES, `page ${page.page} prints ${bytesOf(printed)} bytes`);
    assert.ok(page.messages.length > 0);
  }
  assert.deepEqual(
    pages.flatMap((page) => page.messages.map((m) => m.id)),
    listing.messages.map((m) => m.id),
  );
  assert.equal(pages.at(-1).after, 0);
});

test('live topics are listed with short ids; one is read by a unique prefix with its longer conversation and the notes butler gave it lately', async (t) => {
  const f = await world(t);
  const topics = await f.tools.topics();
  assert.equal(
    formatTopics(topics),
    [
      '进行中的话题 2 个（话题 id 写前几位就行，能认出是哪一个即可）：',
      '',
      'a1b2c3d4  火山发文平台映射',
      '  群：火山发文 - [需求同步群] · 11-26 15:00 开始',
      '  目标：改火山发文的接口',
      '  11-27 09:00 主人：把接口改好以后发给评审群',
      '  11-27 09:10 Agent：已改好，起草了发给评审群的消息',
      '',
      'a1b2ffff  接管 · review（接管的 Agent）',
      '  群：火山发文 - [需求同步群] · 11-26 15:00 开始 · 在等 Agent 空闲的转交 1 份',
      '',
      '读一个话题最近的对话：butler route topic <话题 id>',
    ].join('\n'),
  );
  const window = tenMinutes(f);
  const id = say(f, 1, { text: '接口文档更新了' });
  await f.tools.note({ windowId: window.id, topic: 'a1b2c', messageIds: [id], text: '金垠廷更新了接口文档' });
  const read = await f.tools.topic('a1b2c');
  assert.equal(f.bridge.requests.at(-1).query, `topicId=${FIRE.id}`);
  assert.equal(
    formatTopic(read),
    [
      'a1b2c3d4  火山发文平台映射',
      '群：火山发文 - [需求同步群] · 11-26 15:00 开始',
      '目标：改火山发文的接口',
      '',
      '== 最近的对话，从早到晚 ==',
      '11-27 09:00 主人：把接口改好以后发给评审群',
      '11-27 09:10 Agent：已改好，起草了发给评审群的消息',
      '',
      '== 放进话题的飞书消息 ==',
      '11-27 08:30 产品群 · 陈帆（消息 7301）：接口什么时候好？',
      '',
      '== 替主人起草的消息 ==',
      '11-27 09:20 评审群 · 回复 7301 · 已发出（消息 7302）：请帮忙评审接口改动',
      '',
      '== 管家最近转给它的 ==',
      `第 1 段（干跑）：金垠廷更新了接口文档\n  涉及的消息：${id}`,
    ].join('\n'),
  );
  await assert.rejects(f.tools.topic('a1b2'), refusal(/有 2 个话题的 id 以 a1b2 开头：a1b2c3d4、a1b2ffff，多写几位/));
  await assert.rejects(f.tools.topic('ffff'), refusal(/没有 id 以 ffff 开头的进行中的话题.*butler route topics/));
});

test('a long topic leaves out its oldest exchanges first and says how many, so that what it prints stays within OUTPUT_BYTES', async (t) => {
  const f = await world(t);
  const exchanges = Array.from({ length: 20 }, (_, n) => ({
    from: n % 2 ? 'agent' : 'owner',
    at: minute(-60 + n),
    text: `第${n + 1}条 ${'长'.repeat(1995)}`,
  }));
  f.bridge.topics[0] = { ...f.bridge.topics[0], exchanges };
  const printed = formatTopic(await f.tools.topic('a1b2c'));
  assert.ok(bytesOf(printed) <= OUTPUT_BYTES, `${bytesOf(printed)} bytes`);
  const shown = exchanges.filter((e) => printed.includes(e.text.slice(0, 5)));
  assert.ok(shown.length >= 2, 'the latest exchanges are there');
  assert.deepEqual(shown, exchanges.slice(-shown.length), 'the ones left out are the oldest');
  assert.match(printed, new RegExp(`== 最近的对话，从早到晚 ==\n更早的 ${20 - shown.length} 条对话太长，没有列出\n`));
  assert.match(printed, /== 放进话题的飞书消息 ==[^]*== 替主人起草的消息 ==/, 'the rest stays');
});

test('a topic still too long without any exchange is cut at its end, with a line that says so', async (t) => {
  const f = await world(t);
  const wide = '😀'.repeat(500);
  const sources = Array.from({ length: 20 }, (_, n) => ({ ...FIRE.sources[0], messageId: `73${n}`, text: wide }));
  const drafts = Array.from({ length: 20 }, () => ({ ...FIRE.drafts[0], text: wide }));
  f.bridge.topics[0] = {
    ...f.bridge.topics[0],
    exchanges: [{ from: 'owner', at: minute(-1), text: wide }],
    sources,
    drafts,
  };
  const printed = formatTopic(await f.tools.topic('a1b2c'));
  assert.ok(bytesOf(printed) <= OUTPUT_BYTES, `${bytesOf(printed)} bytes`);
  assert.match(printed, /更早的 1 条对话太长，没有列出/);
  assert.match(printed, /\n……后面的没有列出：一次输出最多 25000 字节$/);
});

test('the listing of many live topics stays within OUTPUT_BYTES: each goal is cut to a line, fifteen topics of long Chinese fit whole, and past what fits the end is cut', async (t) => {
  const topic = (n, character) => ({
    ...FIRE,
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`,
    title: character.repeat(60),
    goal: character.repeat(2000),
    chatName: character.repeat(40),
    exchanges: [
      { from: 'owner', at: minute(-2), text: character.repeat(2000) },
      { from: 'agent', at: minute(-1), text: character.repeat(2000) },
    ],
  });
  const fifteen = formatTopics(Array.from({ length: 15 }, (_, n) => topic(n, '长')));
  assert.ok(bytesOf(fifteen) <= OUTPUT_BYTES, `${bytesOf(fifteen)} bytes`);
  assert.doesNotMatch(fifteen, /后面的没有列出/, 'fifteen topics fit whole');
  assert.match(fifteen, new RegExp(`\\n  目标：${'长'.repeat(99)}…\\n`));
  const many = formatTopics(Array.from({ length: 60 }, (_, n) => topic(n, '😀')));
  assert.ok(bytesOf(many) <= OUTPUT_BYTES, `${bytesOf(many)} bytes`);
  assert.match(many, /\n……后面的没有列出：一次输出最多 25000 字节$/);
});

test('a note is checked before anything is kept: each refusal says what to do instead', async (t) => {
  const f = await world(t);
  const window = tenMinutes(f);
  const id = say(f, 1, { text: '接口文档更新了' });
  const later = say(f, 12, { text: '下一段的' });
  const note = (fields) =>
    f.tools.note({ windowId: window.id, topic: 'a1b2c', messageIds: [id], text: '摘要', ...fields });
  const cases = [
    [{ windowId: 9 }, /没有第 9 段/],
    [{ topic: 'a1b2' }, /多写几位/],
    [{ topic: 'ffff' }, /没有 id 以 ffff 开头的进行中的话题/],
    [{ messageIds: [] }, /至少写一条消息 id/],
    [{ messageIds: [later] }, new RegExp(`消息 ${later} 不在第 1 段里.*butler route messages 1`)],
    [{ messageIds: ['7300000000000000999'] }, /消息 7300000000000000999 不在第 1 段里/],
    [{ text: ' \n' }, /摘要是空的/],
    [{ text: '长'.repeat(1001) }, /摘要最长 1000 字，这次有 1001 字/],
    [{ messageIds: Array.from({ length: 31 }, (_, n) => `73000000000000000${n + 10}`) }, /一份摘要最多写 30 条消息/],
  ];
  for (const [fields, pattern] of cases) await assert.rejects(note(fields), refusal(pattern), JSON.stringify(fields));
  assert.deepEqual(f.windows.notesOf(window.id), [], 'nothing kept');
  const ended = 'a1b2eeee-0000-4000-8000-000000000003';
  f.bridge.ended.push(ended);
  await assert.rejects(note({ topic: ended }), refusal(/没有 id 以 a1b2eeee.* 开头的进行中的话题（话题可能已经结束/));
  await note({ text: '金垠廷更新了接口文档' });
  await assert.rejects(note({ text: '再说一次' }), refusal(/第 1 段已经给话题 a1b2c3d4 转过一份.*每个话题只转一份/));
  f.windows.finish(window.id, '分派完了');
  await assert.rejects(
    f.tools.note({ windowId: window.id, topic: 'a1b2f', messageIds: [id], text: 'x' }),
    refusal(/第 1 段已经分派完了/),
  );
});

test('in dry-run and in a preview a note is recorded with the message ids appended and nothing goes to Bridge; on hands it over under a key of its window and topic', async (t) => {
  const f = await world(t);
  const id = say(f, 1, { text: '接口文档更新了' });
  const other = say(f, 2, { text: '下午评审' });
  const results = [];
  for (const mode of ['dry-run', 'preview', 'on']) {
    const window = f.windows.create({ from: { at: T0, id: null }, until: minute(10), mode });
    results.push(
      await f.tools.note({
        windowId: window.id,
        topic: 'a1b2c',
        messageIds: [id, `${other},${id}`],
        text: ' 金垠廷更新了接口文档，下午评审\n',
      }),
    );
  }
  const text = `金垠廷更新了接口文档，下午评审\n涉及的消息：${id}、${other}`;
  assert.deepEqual(
    results.map((r) => [r.window, r.topicId, r.status, r.text, r.messageIds]),
    [
      [1, FIRE.id, 'dry', text, [id, other]],
      [2, FIRE.id, 'dry', text, [id, other]],
      [3, FIRE.id, 'given', text, [id, other]],
    ],
  );
  assert.deepEqual(f.bridge.digests(), [{ topicId: FIRE.id, key: `butler-route:w3:${FIRE.id}`, text }]);
  assert.deepEqual(
    [1, 2, 3].map((n) => f.windows.notesOf(n).map((r) => [r.status, r.preview, r.topicTitle])),
    [[['dry', false, '火山发文平台映射']], [['dry', true, '火山发文平台映射']], [['given', false, '火山发文平台映射']]],
  );
});

test('on: a note that cannot reach Bridge is kept pending for the round to hand over; one Bridge refuses is dropped, and the agent is told why', async (t) => {
  const f = await world(t);
  const id = say(f, 1, { text: '接口文档更新了' });
  const window = tenMinutes(f, 'on');
  f.bridge.digestScript.push({ status: 503, body: { error: '重启中' } });
  const kept = await f.tools.note({ windowId: window.id, topic: 'a1b2c', messageIds: [id], text: '摘要' });
  assert.equal(kept.status, 'pending');
  assert.deepEqual(
    f.windows.pendingNotes().map((n) => [n.topicId, n.key]),
    [[FIRE.id, `butler-route:w1:${FIRE.id}`]],
  );
  f.bridge.digestScript.push({
    status: 409,
    body: { error: '话题当前没有运行中的 Agent 会话', code: 'topic_not_live' },
  });
  await assert.rejects(
    f.tools.note({ windowId: window.id, topic: 'a1b2f', messageIds: [id], text: '摘要' }),
    refusal(/Bridge 没有收下：.*话题当前没有运行中的 Agent 会话/),
  );
  assert.deepEqual(
    f.windows.notesOf(window.id).map((n) => [n.topicId, n.status]),
    [
      [FIRE.id, 'pending'],
      [REVIEW.id, 'dropped'],
    ],
  );
});
