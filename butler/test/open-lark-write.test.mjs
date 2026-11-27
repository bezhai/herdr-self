import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeOpenLark } from './fake-open-lark.mjs';
import { OpenLark, readOnly, addBotOnly } from '../open-lark.mjs';

test('the read-only client refuses to add a bot, and the write client refuses every route but that one', async (t) => {
  const lark = await startFakeOpenLark();
  t.after(() => lark.close());
  const feed = lark.chat({ name: '需求群' });
  const reader = new OpenLark({ url: lark.url, token: lark.token, gapMs: 0 }),
    writer = new OpenLark({ url: lark.url, token: lark.fullToken, gapMs: 0, guard: addBotOnly });
  await assert.rejects(async () => reader.addBot(feed, 'cli_bridge'), /只读/);
  assert.deepEqual(lark.writes(), [], 'nothing was sent');
  await assert.rejects(async () => writer.conversation(feed), /只允许把机器人加进群/);
  await assert.rejects(async () => writer.me(), /只允许把机器人加进群/);
  await assert.rejects(async () => writer.mentionHistory({ startTime: 1, endTime: 2 }), /只允许把机器人加进群/);
  assert.deepEqual(
    lark.requests.filter((r) => r.path.startsWith('/agent/v1')).length,
    0,
    'no request left the process',
  );
  assert.deepEqual(await writer.addBot(feed, 'cli_bridge'), { added: true, botId: 'cli_bridge', feedId: feed });
  assert.deepEqual(
    lark.writes().map((r) => [r.method, r.path, r.body]),
    [['POST', `/agent/v1/conversations/${feed}/bots`, { botId: 'cli_bridge' }]],
  );
});

test('addBotOnly allows exactly POST /conversations/<id>/bots, and never anything near pins', () => {
  addBotOnly('POST', '/conversations/7710172215941057838/bots');
  for (const [m, p] of [
    ['GET', '/conversations/1/bots'],
    ['POST', '/conversations/1/bots/x'],
    ['POST', '/conversations/1/messages'],
    ['POST', '/conversations/1/bots?x=1'],
    ['POST', '/conversations/a/bots'],
    ['POST', '/conversations/1/members'],
    ['DELETE', '/conversations/1/bots'],
    ['PATCH', '/conversations/1/settings'],
    ['POST', '/conversations/1/pins/read'],
    ['POST', '/messages/1/replies'],
    ['POST', '/conversations/1/bots/../messages'],
  ])
    assert.throws(() => addBotOnly(m, p), /只允许把机器人加进群/, `${m} ${p}`);
  assert.throws(() => readOnly('POST', '/conversations/1/bots'), /只读/);
  assert.throws(() => readOnly('GET', '/conversations/1/pins'), /pins/);
});

test('the reads of a new group: settings, chat tabs and bots', async (t) => {
  const lark = await startFakeOpenLark();
  t.after(() => lark.close());
  const feed = lark.chat({ name: '需求群' });
  const c = lark.conversations.get(feed);
  c.settings = { labels: ['需求群'], ownerId: 'u9' };
  c.tabs = [{ id: '1', kind: 'url', name: 'PRD', url: 'https://x/y' }];
  c.bots = [{ displayName: 'Meego', joinedAtMs: 5 }];
  const reader = new OpenLark({ url: lark.url, token: lark.token, gapMs: 0 });
  assert.equal((await reader.settings(feed)).ownerId, 'u9');
  assert.equal((await reader.chatTabs(feed)).tabs[0].name, 'PRD');
  assert.equal((await reader.bots(feed)).items[0].displayName, 'Meego');
  assert.deepEqual(lark.writes(), []);
});
