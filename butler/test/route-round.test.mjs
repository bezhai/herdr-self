// The routing round over a test store, a fake Bridge and a fake agent: which window each round routes, retries and
// skips, when no agent starts, and the preview run by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBridge, KEY } from './fake-bridge.mjs';
import { tempStore, post, waitFor } from './helpers.mjs';
import { Bridge } from '../bridge-client.mjs';
import { RouteWindows } from '../route-windows.mjs';
import { RouteTools } from '../route-tools.mjs';
import { RouteRounds, ROUTING_COMMANDS, ROUTING_SYSTEM } from '../route-round.mjs';

process.env.TZ = 'Asia/Shanghai';
const BRIDGE_BOT = '7100000000000000001';
const T0 = Date.parse('2026-11-27T10:00:00+08:00');
const minute = (n) => T0 + n * 60e3;
const TOPIC = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  title: '火山发文平台映射',
  goal: '改火山发文的接口',
  chatId: 'oc_1',
  chatName: '火山发文 - [需求同步群]',
  createdAt: minute(-600),
  adopted: false,
  pending: 0,
  exchanges: [],
  sources: [],
  drafts: [],
};

// A fake routing agent: each ask runs the next step (prompt, windowId) or else replies 分派完了; every ask is kept.
function fakeAgent() {
  const agent = {
    asks: [],
    steps: [],
    async ask({ system, prompt }) {
      agent.asks.push({ system, prompt });
      const windowId = Number(/第 (\d+) 段/.exec(prompt)?.[1]);
      const step = agent.steps.shift();
      return step ? step(windowId) : '分派完了';
    },
  };
  return agent;
}

// A store, a fake Bridge with TOPIC live, and rounds over them whose clock is f.clock; f.restart() makes the rounds anew,
// as a restarted processor would.
async function world(t, { mode = 'dry-run' } = {}) {
  const { store } = tempStore(t);
  const fakeBridge = await new FakeBridge().listen();
  t.after(() => fakeBridge.close());
  fakeBridge.topics = [structuredClone(TOPIC)];
  const f = { store, fakeBridge, agent: fakeAgent(), clock: T0, journal: [] };
  const now = () => f.clock;
  f.windows = new RouteWindows(store, { bridgeBotId: BRIDGE_BOT, now });
  f.bridge = new Bridge({ url: fakeBridge.url, key: KEY });
  f.tools = new RouteTools({ store, windows: f.windows, bridge: f.bridge });
  f.restart = () => {
    f.rounds = new RouteRounds({
      store,
      windows: f.windows,
      bridge: f.bridge,
      agent: f.agent,
      mode,
      now,
      log: (line) => f.journal.push(line),
    });
    return f.rounds;
  };
  f.restart();
  return f;
}
const say = (f, n, o = {}) => post(f.store, { at: minute(n), seen: minute(n), categories: ['stored'], ...o });
const listed = (f, id) => f.windows.messages(f.windows.window(id)).map((m) => m.text);
const errors = (f) => f.store.errors(20).map((e) => e.message);
const noteOn = (f, text) => (windowId) => {
  const id = f.windows.messages(f.windows.window(windowId))[0].id;
  return f.tools.note({ windowId, topic: 'a1b2', messageIds: [id], text }).then(() => '转了一份');
};

test("the agent may run only its tools, and is told so in one line; how to route is the skill's", () => {
  assert.deepEqual(ROUTING_COMMANDS, [
    'butler route messages *',
    'butler route topics',
    'butler route topics *',
    'butler route topic *',
    'butler route note *',
    'ol *',
    'bridge-skill read *',
  ]);
  assert.doesNotMatch(ROUTING_SYSTEM, /\n/);
  for (const command of ['butler route messages', 'butler route note', 'ol', 'bridge-skill read'])
    assert.ok(ROUTING_SYSTEM.includes(command), command);
});

test('each round routes one fixed window, from where the last one ended to a minute ago: the first starts at the old router cursor, and a restart goes on from where the last window ended', async (t) => {
  const f = await world(t);
  f.store.setMeta('routing', { cursor: { at: T0, id: '7200000000000000500' }, at: T0, mode: 'dry-run' });
  say(f, 0, { id: '7200000000000000400', text: '旧路由转过的' });
  say(f, 0, { id: '7200000000000000600', text: '旧路由没转到的' });
  say(f, 5, { text: '五分钟' });
  say(f, 9.5, { text: '收下不到一分钟的' });
  f.clock = minute(10);
  const first = await f.rounds.tick();
  assert.deepEqual(
    [first.id, first.mode, first.state, first.from, first.until, first.reply],
    [1, 'dry-run', 'done', { at: T0, id: '7200000000000000500' }, minute(9), '分派完了'],
  );
  assert.deepEqual(listed(f, 1), ['旧路由没转到的', '五分钟']);
  assert.deepEqual(f.agent.asks, [
    {
      system: ROUTING_SYSTEM,
      prompt:
        '先用 `bridge-skill read butler-routing` 读分派飞书消息的做法，然后分派第 1 段时间（2026-11-27 10:00–10:09）里的新消息。',
    },
  ]);
  assert.deepEqual(f.journal, ['分派第 1 段（干跑）：2 条新消息，写了 0 份摘要']);
  f.restart();
  f.clock = minute(20);
  const second = await f.rounds.tick();
  assert.deepEqual([second.id, second.from, second.until], [2, { at: minute(9), id: null }, minute(19)]);
  assert.deepEqual(listed(f, 2), ['收下不到一分钟的']);
});

test('a window whose agent fails is run again as it is on the next rounds; after three failures it is skipped and recorded, and the next round goes on after it', async (t) => {
  const f = await world(t);
  say(f, 5, { text: '五分钟' });
  const fail = () => {
    throw Error('模型结束了这一轮，但没有回复');
  };
  f.agent.steps.push(fail, fail, fail);
  for (const at of [10, 20, 30]) {
    f.clock = minute(at);
    if (at === 20) f.restart();
    await f.rounds.tick();
  }
  const window = f.windows.window(1);
  assert.deepEqual([window.state, window.attempts, window.until], ['skipped', 3, minute(9)]);
  assert.equal(new Set(f.agent.asks.map((a) => a.prompt)).size, 1, 'the same window every time');
  assert.deepEqual(errors(f).slice(0, 3).reverse(), [
    '第 1 段没有分派完，下一轮再试：模型结束了这一轮，但没有回复',
    '第 1 段没有分派完，下一轮再试：模型结束了这一轮，但没有回复',
    '第 1 段试了 3 次都没有分派完，跳过：模型结束了这一轮，但没有回复',
  ]);
  say(f, 35, { text: '跳过以后的' });
  f.clock = minute(40);
  const next = await f.rounds.tick();
  assert.deepEqual([next.id, next.from.at, next.until, next.state], [2, minute(9), minute(39), 'done']);
  assert.deepEqual(listed(f, 2), ['跳过以后的']);
});

test('no agent starts for a stretch with nothing new or with no live topic, which is passed over; Bridge unreachable leaves it for the next round', async (t) => {
  const f = await world(t);
  say(f, 3, { text: 'Bridge 机器人说的', sender: BRIDGE_BOT, type: 'bot' });
  f.clock = minute(10);
  assert.equal(await f.rounds.tick(), undefined);
  assert.deepEqual([f.agent.asks, f.fakeBridge.requests], [[], []], 'nothing new: Bridge is not even asked');
  assert.deepEqual(f.windows.cursor(), { at: minute(9), id: null });
  say(f, 15, { text: '有人说话' });
  f.fakeBridge.topics = [];
  f.clock = minute(20);
  assert.equal(await f.rounds.tick(), undefined);
  assert.deepEqual(f.agent.asks, [], 'no live topic');
  assert.deepEqual(f.windows.cursor(), { at: minute(19), id: null });
  say(f, 25, { text: '又有人说话' });
  await f.fakeBridge.close();
  f.clock = minute(30);
  assert.equal(await f.rounds.tick(), undefined);
  assert.deepEqual(f.windows.cursor(), { at: minute(19), id: null }, 'the stretch waits');
  assert.match(errors(f)[0], /^分派新消息没有完成，下一轮再试：连不上 Bridge/);
  assert.equal(f.windows.window(1), undefined);
});

test('on: a note Bridge did not take yet is handed over at the start of the next round, under the same key', async (t) => {
  const f = await world(t, { mode: 'on' });
  say(f, 5, { text: '五分钟' });
  f.fakeBridge.digestScript.push({ status: 503, body: { error: '重启中' } });
  f.agent.steps.push(noteOn(f, '金垠廷更新了接口文档'));
  f.clock = minute(10);
  await f.rounds.tick();
  assert.deepEqual(
    f.windows.notesOf(1).map((n) => n.status),
    ['pending'],
  );
  f.clock = minute(20);
  await f.rounds.tick();
  assert.deepEqual(
    f.windows.notesOf(1).map((n) => n.status),
    ['given'],
  );
  const key = `butler-route:w1:${TOPIC.id}`;
  assert.deepEqual(
    f.fakeBridge.digests().map((d) => d.key),
    [key, key],
  );
  assert.deepEqual(f.agent.asks.length, 1, 'nothing new in the second round');
});

test('rounds never overlap: a tick during a round joins it; stop waits for the round under way', async (t) => {
  const f = await world(t);
  say(f, 5, { text: '五分钟' });
  let finish;
  f.agent.steps.push(() => new Promise((resolve) => (finish = resolve)));
  f.clock = minute(10);
  f.rounds.start();
  await waitFor(() => f.agent.asks.length === 1, { message: 'the first round' });
  const joined = f.rounds.tick();
  const stopped = f.rounds.stop();
  finish('分派完了');
  await Promise.all([joined, stopped]);
  assert.deepEqual([f.agent.asks.length, f.windows.window(1).state], [1, 'done']);
});

test('a preview routes a chosen stretch once: its notes are kept as a preview and never handed over, and the timer goes on as if it had not run', async (t) => {
  const f = await world(t, { mode: 'on' });
  say(f, 5, { text: '五分钟' });
  f.agent.steps.push(noteOn(f, '金垠廷更新了接口文档'));
  f.clock = minute(60);
  const preview = await f.rounds.preview({ since: minute(0), until: minute(9) });
  assert.deepEqual(
    [preview.window.mode, preview.window.state, preview.messages, preview.topics],
    ['preview', 'done', 1, 1],
  );
  assert.deepEqual(
    preview.notes.map((n) => [n.status, n.preview, n.topicId]),
    [['dry', true, TOPIC.id]],
  );
  assert.deepEqual(f.fakeBridge.digests(), []);
  assert.equal(f.windows.cursor(), undefined, 'the cursor is the timer’s');
  assert.equal(f.windows.openWindow(), undefined);
  f.agent.steps.push(() => Promise.reject(Error('超时')));
  const failing = await f.rounds.preview({ since: minute(0), until: minute(9) });
  assert.deepEqual([failing.window.state, failing.error], ['skipped', '超时']);
  assert.deepEqual(await f.rounds.preview({ since: minute(10), until: minute(20) }), {
    skipped: '这段时间没有新消息',
  });
  f.fakeBridge.topics = [];
  assert.deepEqual(await f.rounds.preview({ since: minute(0), until: minute(9) }), {
    skipped: '没有进行中的话题',
  });
});
