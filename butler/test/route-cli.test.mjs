// Routing through butler's command line: the routing agent's tools as it runs them, the preview run by hand, the log,
// the processor's timer, and the config of routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempStore, post, waitFor } from './helpers.mjs';
import { FakeBridge, KEY } from './fake-bridge.mjs';
import { loadConfig, routingSetup, requireRoutingCwd } from '../config.mjs';
import { RouteWindows } from '../route-windows.mjs';
import { commandsOnly } from '../herdr-model.mjs';
import { ROUTING_COMMANDS, ROUTING_SYSTEM } from '../route-round.mjs';

process.env.TZ = 'Asia/Shanghai';
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const FAKE_HERDR = fileURLToPath(new URL('./fake-herdr.mjs', import.meta.url));
const BOT = '7100000000000000001';
const TOPIC = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  title: '火山发文平台映射',
  goal: '改火山发文的接口',
  chatId: 'oc_1',
  chatName: '火山发文 - [需求同步群]',
  createdAt: Date.parse('2026-11-26T15:00:00+08:00'),
  adopted: false,
  pending: 0,
  exchanges: [{ from: 'owner', at: Date.parse('2026-11-27T09:00:00+08:00'), text: '把接口改好' }],
  sources: [],
  drafts: [],
};

function start(config, args) {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--config', config, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function run(config, ...args) {
  return new Promise((resolve, reject) => {
    const child = start(config, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A store with one message in window 1 (the 10 minutes up to a minute ago, dry-run), a fake Bridge with TOPIC live, a
// fake herdr whose agent replies 分派完了, and a config that names them, with the routing agent's directory unless
// routingCwd is null. w.herdrCalls() are the herdr commands run.
async function world(t, routing = 'dry-run', { routingCwd = '/home/me/butler-routing' } = {}) {
  const { store, dir } = tempStore(t);
  const bridge = await new FakeBridge().listen();
  t.after(() => bridge.close());
  bridge.topics = [structuredClone(TOPIC)];
  const now = Date.now();
  const id = post(store, {
    name: '金垠廷',
    text: '接口文档更新了',
    at: now - 5 * 60e3,
    seen: now - 5 * 60e3,
    categories: ['stored'],
  });
  const windows = new RouteWindows(store, { bridgeBotId: BOT });
  windows.create({ from: { at: now - 11 * 60e3, id: null }, until: now - 60e3, mode: 'dry-run' });
  const herdrDir = path.join(dir, 'herdr');
  fs.mkdirSync(herdrDir);
  fs.writeFileSync(path.join(herdrDir, 'script.json'), JSON.stringify({ replies: [{ text: '分派完了' }] }));
  const herdr = path.join(dir, 'herdr.sh');
  fs.writeFileSync(herdr, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HERDR}" "${herdrDir}" "$@"\n`, {
    mode: 0o755,
  });
  const config = path.join(dir, 'butler.env');
  const lines = [
    'BUTLER_OPEN_LARK_TOKEN=r',
    'BUTLER_OPEN_LARK_URL=http://127.0.0.1:9',
    `BUTLER_DATA_DIR=${dir}`,
    `BUTLER_BRIDGE_URL=${bridge.url}`,
    `BUTLER_BRIDGE_KEY=${KEY}`,
    `BUTLER_BRIDGE_BOT_ID=${BOT}`,
    `BUTLER_ROUTING=${routing}`,
    'BUTLER_MODEL_MACHINE=cpu1-butler',
    'BUTLER_MODEL_CWD=/home/me/butler-model',
    ...(routingCwd ? [`BUTLER_ROUTING_CWD=${routingCwd}`] : []),
    `BUTLER_HERDR=${herdr}`,
  ];
  fs.writeFileSync(config, `${lines.join('\n')}\n`, { mode: 0o600 });
  const herdrCalls = () => {
    const file = path.join(herdrDir, 'calls.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return { store, dir, bridge, windows, id, config, herdrCalls };
}
// The routing agent's start and prompt among herdr's calls, as [claude's arguments, the prompt, the workspace's cwd].
function routingAgent(calls) {
  const prompt = calls.find((c) => c[2] === 'agent' && c[3] === 'prompt' && /分派第/.test(c[5]));
  if (!prompt) return undefined;
  const begin = calls.find((c) => c[2] === 'agent' && c[3] === 'start' && c[4] === prompt[4]);
  const create = calls.find((c) => c[2] === 'workspace' && c[3] === 'create');
  return [begin.slice(begin.indexOf('--') + 1), prompt[5], create[create.indexOf('--cwd') + 1]];
}

test('help lists the routing commands, and no dry run of the old router', async (t) => {
  const w = await world(t);
  const r = await run(w.config, '--help');
  for (const usage of [
    'route messages <段号> [--page 页码] [--json]',
    'route topics [--json]',
    'route topic <话题 id> [--json]',
    'route note <段号> <话题 id> <消息 id>... --text <摘要> [--json]',
    'route [--since 时间] [--until 时间] [--json]',
    'route log [--since 时间] [--limit 段数] [--json]',
  ])
    assert.ok(r.stdout.includes(usage), `help shows: ${usage}`);
  assert.doesNotMatch(r.stdout, /route --dry-run|每 5 分钟/);
});

test("the routing agent's tools through the command line: the window's messages, the topics, one topic and a note, each refusal on stderr with exit code 1", async (t) => {
  const w = await world(t);
  let r = await run(w.config, 'route', 'messages', '1');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^第 1 段（.* 收下的消息）：新消息 1 条，第 1\/1 页/);
  assert.match(
    r.stdout,
    new RegExp(`== 项目群 · 群 · feedId g1 ==\n${w.id}  \\d\\d-\\d\\d \\d\\d:\\d\\d  金垠廷：接口文档更新了`),
  );
  r = await run(w.config, 'route', 'messages', '1', '--json');
  assert.deepEqual(
    JSON.parse(r.stdout).messages.map((m) => [m.id, m.sender, m.text]),
    [[w.id, '金垠廷', '接口文档更新了']],
  );
  r = await run(w.config, 'route', 'topics');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /a1b2c3d4  火山发文平台映射\n  群：火山发文 - \[需求同步群\]/);
  r = await run(w.config, 'route', 'topic', 'a1b2');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /== 最近的对话，从早到晚 ==\n11-27 09:00 主人：把接口改好/);
  r = await run(w.config, 'route', 'note', '1', 'a1b2', w.id, '--text', '金垠廷更新了接口文档\n下午评审');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout.trim(),
    '已记下转给话题 a1b2c3d4「火山发文平台映射」的摘要（1 条消息）。现在是干跑，摘要只记下、不交给 Bridge，这是正常的；这个话题这一段已经转完了。',
  );
  assert.deepEqual(
    w.windows.notesOf(1).map((n) => [n.topicId, n.status, n.text]),
    [[TOPIC.id, 'dry', `金垠廷更新了接口文档\n下午评审\n涉及的消息：${w.id}`]],
  );
  assert.deepEqual(w.bridge.digests(), []);
  r = await run(w.config, 'route', 'note', '1', 'a1b2', w.id, '--text', '再一份');
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim(), '第 1 段已经给话题 a1b2c3d4 转过一份了，每段时间每个话题只转一份');
  r = await run(w.config, 'route', 'note', '1', 'a1b2', w.id);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /要用 --text 写摘要/);
  r = await run(w.config, 'route', 'messages', 'x');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /段号要写编号/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY), 'the key is never printed');
});

test('route --since previews one round by hand: the agent starts with only its commands, its notes stay a preview, and route log shows the timer windows, the previews and the old router apart', async (t) => {
  const w = await world(t);
  w.store.db
    .prepare("INSERT INTO routed(at,topic_id,topic_title,message_ids,text,status,run_ids) VALUES(?,?,?,?,?,'dry','[]')")
    .run(Date.now() - 3600e3, 'T0', '旧话题', JSON.stringify(['7300']), '旧路由的摘要');
  let r = await run(w.config, 'route', 'note', '1', 'a1b2', w.id, '--text', '金垠廷更新了接口文档');
  assert.equal(r.code, 0, r.stderr);
  r = await run(w.config, 'route', '--since', '2h');
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /^预览第 2 段（.* 收下的消息）：新消息 1 条，进行中的话题 1 个；写了 0 份摘要，只记下，没有交给 Bridge\n\nAgent 最后说：分派完了/,
  );
  const [claude, prompt, cwd] = routingAgent(w.herdrCalls());
  assert.deepEqual(claude.slice(0, -2), commandsOnly(ROUTING_COMMANDS));
  assert.deepEqual(claude.slice(-2), ['--system-prompt', ROUTING_SYSTEM]);
  assert.match(
    prompt,
    /^先用 `bridge-skill read butler-routing` 读分派飞书消息的做法，然后分派第 2 段时间（\d{4}-\d\d-\d\d \d\d:\d\d–.*\d\d:\d\d）里的新消息。$/,
  );
  assert.equal(cwd, '/home/me/butler-routing', 'its own directory, apart from the other model runs');
  assert.deepEqual(w.bridge.digests(), [], 'nothing handed over');
  r = await run(w.config, 'route', 'log');
  assert.equal(r.code, 0, r.stderr);
  const [timer, previews, earlier] = r.stdout.split('\n\n');
  assert.match(
    timer,
    /^== 定时分派 ==\n第 1 段  .*  还没分派完（干跑）\n  话题 a1b2c3d4「火山发文平台映射」  干跑  1 条消息\n    金垠廷更新了接口文档\n    涉及的消息：/,
  );
  assert.match(previews, /^== 预览 ==\n第 2 段  .*  分派完了\n  没有转给任何话题\n  Agent 最后说：分派完了$/);
  assert.match(earlier, /^== 分段以前的转交 ==\n.*  干跑  话题「旧话题」  1 条消息\n  旧路由的摘要/);
  r = await run(w.config, 'route', 'log', '--json');
  const log = JSON.parse(r.stdout);
  assert.deepEqual(
    [log.windows.map((x) => x.id), log.previews.map((x) => x.id), log.earlier.map((x) => x.text)],
    [[1], [2], ['旧路由的摘要']],
  );
  r = await run(w.config, 'route', 'sideways');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /用法：butler route/);
});

test('the routing agent needs a directory of its own on the model machine: without BUTLER_ROUTING_CWD a preview and the processor refuse before anything starts', async (t) => {
  const w = await world(t, 'dry-run', { routingCwd: null });
  let r = await run(w.config, 'route', '--since', '2h');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /没有 BUTLER_ROUTING_CWD/);
  r = await run(w.config, 'process');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /没有 BUTLER_ROUTING_CWD/);
  assert.deepEqual(w.herdrCalls(), [], 'nothing ran on the model machine');
});

test('the processor starts the routing timer when routing is not off, and process --once does not route', async (t) => {
  const w = await world(t);
  w.windows.finish(1, '分派完了');
  w.store.setMeta('routing', { cursor: { at: Date.now() - 6 * 60e3, id: null } });
  w.store.setMeta('profile', { text: 'x', at: Date.now(), notes: [], messages: 1 });
  w.store.setMeta('review', { at: Date.now(), reviewed: 0, closed: 0, profileAt: Date.now(), notes: [] });
  let r = await run(w.config, 'process', '--once');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(routingAgent(w.herdrCalls()), undefined);
  const service = start(w.config, ['process']);
  t.after(() => service.kill('SIGKILL'));
  const [claude, prompt] = await waitFor(() => routingAgent(w.herdrCalls()), {
    timeout: 15_000,
    message: 'the routing agent',
  });
  assert.deepEqual(claude.slice(0, -2), commandsOnly(ROUTING_COMMANDS));
  assert.match(prompt, /分派第 2 段时间/);
  service.kill('SIGTERM');
});

test("config: BUTLER_ROUTING is off, dry-run or on, off by default; routing needs Bridge's address and key and its bot's id, and its agent a directory apart from the other model runs", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'butler-routing-')),
    file = (text) => {
      const f = path.join(dir, 'butler.env');
      fs.writeFileSync(f, text, { mode: 0o600 });
      return f;
    };
  try {
    const bridge = 'BUTLER_BRIDGE_URL=http://127.0.0.1:9\nBUTLER_BRIDGE_KEY=k\nBUTLER_BRIDGE_BOT_ID=7100\n';
    assert.equal(routingSetup(loadConfig(file(bridge))), undefined, 'off by default');
    assert.equal(routingSetup(loadConfig(file(`${bridge}BUTLER_ROUTING=off\n`))), undefined);
    assert.deepEqual(routingSetup(loadConfig(file(`${bridge}BUTLER_ROUTING=dry-run\nBUTLER_BOT_LARK_ID=7200\n`))), {
      mode: 'dry-run',
      bridgeUrl: 'http://127.0.0.1:9',
      bridgeKey: 'k',
      botId: '7100',
      ownBotId: '7200',
    });
    assert.equal(routingSetup(loadConfig(file(`${bridge}BUTLER_ROUTING=on\n`))).mode, 'on');
    assert.throws(() => loadConfig(file('BUTLER_ROUTING=yes\n')), /BUTLER_ROUTING 只能是 off、dry-run 或 on：yes/);
    const model = 'BUTLER_MODEL_CWD=/home/me/butler-model\n';
    assert.equal(
      requireRoutingCwd(loadConfig(file(`${model}BUTLER_ROUTING_CWD=/home/me/butler-routing\n`))),
      '/home/me/butler-routing',
    );
    assert.throws(() => requireRoutingCwd(loadConfig(file(model))), /没有 BUTLER_ROUTING_CWD/);
    assert.throws(
      () => requireRoutingCwd(loadConfig(file(`${model}BUTLER_ROUTING_CWD=/home/me/butler-model/\n`))),
      /BUTLER_ROUTING_CWD 要和 BUTLER_MODEL_CWD 不同/,
    );
    assert.throws(
      () => routingSetup(loadConfig(file('BUTLER_ROUTING=on\nBUTLER_BRIDGE_URL=http://127.0.0.1:9\n'))),
      /转交.*BUTLER_BRIDGE_KEY、BUTLER_BRIDGE_BOT_ID/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
