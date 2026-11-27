import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBridge, KEY } from './fake-bridge.mjs';
import { Bridge, BridgeError, BOT_CANNOT_POST } from '../bridge-client.mjs';

const start = async (t) => {
  const bridge = await new FakeBridge({ state: { projects: [{ id: 'p1', name: 'genvi' }] } }).listen();
  t.after(() => bridge.close());
  return bridge;
};
const client = (bridge, extra = {}) => new Bridge({ url: bridge.url, key: KEY, retryMs: 5, retryForMs: 100, ...extra });

test('state reads /api/state with the access key; a wrong key is an error that says so', async (t) => {
  const bridge = await start(t);
  assert.deepEqual((await client(bridge).state()).projects, [{ id: 'p1', name: 'genvi' }]);
  assert.equal(bridge.requests[0].authorization, `Bearer ${KEY}`);
  await assert.rejects(
    () => new Bridge({ url: bridge.url, key: 'wrong' }).state(),
    (e) => e instanceof BridgeError && e.status === 401 && /未授权/.test(e.message),
  );
});

test('openTopic posts what it is given and returns the answer; the same key opens nothing twice', async (t) => {
  const bridge = await start(t),
    b = client(bridge);
  const input = {
    chatId: 'oc_1',
    prompt: '做这个需求',
    title: '火山发文',
    rootText: '原智鸿的 Agent：火山发文',
    projectId: 'p1',
    agentConfigId: 'a1',
    key: 'newchat:1',
  };
  const first = await b.openTopic(input),
    again = await b.openTopic(input);
  assert.deepEqual(first, { topicId: 't1', bindingId: 'b1', rootMessageId: 'om_root1', created: true });
  assert.deepEqual(again, { ...first, created: false });
  assert.deepEqual(
    bridge.opens().map((r) => r.body),
    [input, input],
  );
});

test('the bot not yet able to post is retried for a while, other errors are not', async (t) => {
  const bridge = await start(t),
    b = client(bridge);
  bridge.script.push(
    { status: 409, body: { error: '机器人还不能在这个群发言', code: BOT_CANNOT_POST } },
    { status: 409, body: { error: '机器人还不能在这个群发言', code: BOT_CANNOT_POST } },
  );
  const r = await b.openTopic({ chatId: 'oc_1', prompt: 'x' });
  assert.equal(r.created, true);
  assert.equal(bridge.opens().length, 3, 'two refusals, then the topic');
  bridge.script.push({ status: 400, body: { error: '项目不存在', code: 'unknown_project' } });
  await assert.rejects(
    () => b.openTopic({ chatId: 'oc_1', prompt: 'x', projectId: 'gone', agentConfigId: 'a' }),
    (e) => e.status === 400 && e.code === 'unknown_project' && /项目不存在/.test(e.message),
  );
  assert.equal(bridge.opens().length, 4, 'not retried');
});

test('a bot that still cannot post when the time is up is the last error', async (t) => {
  const bridge = await start(t),
    b = client(bridge, { retryForMs: 30 });
  for (let i = 0; i < 50; i++)
    bridge.script.push({ status: 409, body: { error: '机器人还不能在这个群发言', code: BOT_CANNOT_POST } });
  await assert.rejects(
    () => b.openTopic({ chatId: 'oc_1', prompt: 'x' }),
    (e) => e.code === BOT_CANNOT_POST,
  );
  assert.ok(bridge.opens().length >= 2 && bridge.opens().length < 50);
});

test('an unreachable Bridge says where', async (t) => {
  const bridge = await start(t);
  const url = bridge.url;
  await bridge.close();
  await assert.rejects(() => new Bridge({ url, key: KEY }).state(), /连不上 Bridge/);
});

test('topicContext reads the live topics; giveDigest hands one a digest and returns the answer, and a refusal is an error with its code', async (t) => {
  const bridge = await start(t),
    b = client(bridge);
  bridge.topics = [{ id: 'T1', title: '火山发文', chatId: 'oc_1' }];
  assert.deepEqual(await b.topicContext(), [{ id: 'T1', title: '火山发文', chatId: 'oc_1' }]);
  assert.deepEqual(await b.giveDigest({ topicId: 'T1', key: 'butler-route:1', text: '陈帆：好了' }), {
    topicId: 'T1',
    key: 'butler-route:1',
    created: true,
    pending: 1,
  });
  assert.deepEqual(bridge.digests(), [{ topicId: 'T1', key: 'butler-route:1', text: '陈帆：好了' }]);
  await assert.rejects(
    () => b.giveDigest({ topicId: 'gone', key: 'k', text: 'x' }),
    (e) => e.status === 404 && e.code === 'unknown_topic',
  );
  assert.equal(bridge.requests.at(-1).authorization, `Bearer ${KEY}`);
});

test('topic reads one live topic with its longer conversation; an unknown or ended topic is an error with its code', async (t) => {
  const bridge = await start(t),
    b = client(bridge);
  bridge.topics = [{ id: 'T 1', title: '火山发文', chatId: 'oc_1' }];
  bridge.ended = ['T2'];
  assert.deepEqual(await b.topic('T 1'), { id: 'T 1', title: '火山发文', chatId: 'oc_1' });
  assert.equal(bridge.requests.at(-1).query, 'topicId=T%201');
  await assert.rejects(
    () => b.topic('T2'),
    (e) => e.status === 409 && e.code === 'topic_not_live',
  );
  await assert.rejects(
    () => b.topic('gone'),
    (e) => e.status === 404 && e.code === 'unknown_topic',
  );
});
