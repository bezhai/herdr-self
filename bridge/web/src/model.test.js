import { expect, test } from 'vitest';
import { bindingStatus, deliveryLabel, deliveryTone, metrics, registrationView, statusLabel, statusTone } from './model.js';
import { sampleState } from './test/fixtures.js';

test('status tones group connection and agent states', () => {
  expect(['error', 'failed'].map(statusTone)).toEqual(['error', 'error']);
  expect(['connected', 'ready'].map(statusTone)).toEqual(['ok', 'ok']);
  expect(['connecting', 'reconnecting', 'working', 'blocked'].map(statusTone)).toEqual(['warn', 'warn', 'warn', 'warn']);
  expect(['disabled', 'idle', 'offline', 'unknown-state'].map(statusTone)).toEqual(['neutral', 'neutral', 'neutral', 'neutral']);
  expect(statusLabel('reconnecting')).toBe('重连中');
  expect(statusLabel('blocked')).toBe('等待审批');
  expect(statusLabel('unknown-state')).toBe('unknown-state');
});

test('metrics count online machines, connected platforms, bindings and attached agents', () => {
  expect(metrics(sampleState())).toEqual({ machinesOnline: 2, machines: 4, platformsConnected: 1, platforms: 2, bindings: 1, agents: 1 });
});

test('a binding is usable only with its native session attached and its platform connected', () => {
  const state = sampleState();
  const binding = state.bindings[0];
  expect(bindingStatus(binding, state)).toEqual({ tone: 'ok', label: '可用' });
  state.apps[0].connection = 'reconnecting';
  expect(bindingStatus(binding, state)).toEqual({ tone: 'neutral', label: '等待平台连接' });
  expect(bindingStatus({ ...binding, nativeId: 'replaced-session' }, state)).toEqual({ tone: 'neutral', label: '等待原生会话' });
  expect(bindingStatus({ ...binding, machineId: 'removed' }, state)).toEqual({ tone: 'neutral', label: '等待原生会话' });
});

test('delivery labels keep the status table and warn on unknown delivery or missing reply', () => {
  expect(['queued', 'running', 'completed', 'delivery_unknown', 'no_reply', 'dispatching'].map(deliveryLabel))
    .toEqual(['排队中', '执行中', '已回复', '投递待核查', '需要关注', '投递中']);
  expect(deliveryLabel('new_status')).toBe('new_status');
  expect(['delivery_unknown', 'no_reply', 'completed', 'queued'].map(deliveryTone)).toEqual(['warn', 'warn', 'neutral', 'neutral']);
});

const apps = [
  { id: 'app-1', name: '工作助手', botName: 'WorkBot', enabled: true, connection: 'connected' },
  { id: 'app-2', name: '新应用', enabled: false, connection: 'disabled' },
];
const view = (registration, local = {}) => registrationView(registration, apps, { opening: false, previousId: null, scanning: false, ...local });

test('registration view: starting shows the spinner and the manual entry', () => {
  expect(view(null)).toEqual({
    opening: false, title: '在飞书中添加应用', subtitle: '新建或选择已有应用', spinner: true, result: null, qr: null,
    message: '正在打开飞书…', link: null, scan: false, scanLabel: '手机扫码', retry: false, done: false, configure: false, manual: true,
  });
  expect(view({ id: 'r1', status: 'connecting', appId: 'app-2' })).toMatchObject({ spinner: true, message: '正在连接…', done: false });
});

test('registration view: pending links to Feishu and toggles the QR code', () => {
  const pending = { id: 'r1', status: 'pending', url: 'https://open.feishu.cn/page/x', qr: 'data:image/png;base64,qr' };
  expect(view(pending)).toMatchObject({ spinner: true, qr: null, message: '等待飞书确认', link: pending.url, scan: true, scanLabel: '手机扫码' });
  expect(view(pending, { scanning: true })).toMatchObject({ spinner: false, qr: pending.qr, scan: true, scanLabel: '收起二维码' });
  expect(view({ ...pending, qr: undefined })).toMatchObject({ scan: false, link: pending.url });
});

test('registration view: completed, or an already connected app, shows the bot name and the done action', () => {
  const done = { spinner: false, result: 'success', title: '飞书已连接', subtitle: 'WorkBot', message: '已准备就绪', done: true, retry: false, configure: false, manual: false, link: null };
  expect(view({ id: 'r1', status: 'completed', appId: 'app-1' })).toMatchObject(done);
  expect(view({ id: 'r1', status: 'connection_error', appId: 'app-1' })).toMatchObject(done);
  expect(view({ id: 'r1', status: 'completed', appId: 'app-2' })).toMatchObject({ done: true, subtitle: '新应用' });
});

test('registration view: failures offer retry; connection_error and needs_owner offer the app settings', () => {
  for (const [status, message] of [['error', '暂时无法连接飞书'], ['expired', '二维码已过期'], ['denied', '未完成授权'], ['cancelled', '请重新添加']]) {
    expect(view({ id: 'r1', status })).toMatchObject({ spinner: false, result: 'problem', message, retry: true, configure: false, done: false, manual: true });
  }
  expect(view({ id: 'r1', status: 'connection_error', appId: 'app-2' })).toMatchObject({ spinner: false, result: 'problem', message: '应用已添加，连接未成功', configure: true, retry: false });
  expect(view({ id: 'r1', status: 'needs_owner', appId: 'app-2' })).toMatchObject({ result: 'problem', message: '请设置可操作用户', configure: true });
});

test('registration view: while opening, the previous finished registration is ignored until a new flow appears', () => {
  const previous = { id: 'r0', status: 'completed', appId: 'app-1' };
  expect(view(previous, { opening: true, previousId: 'r0' })).toMatchObject({ opening: true, spinner: true, done: false, message: '正在打开飞书…' });
  expect(view({ ...previous, status: 'pending', url: 'https://open.feishu.cn/x' }, { opening: true, previousId: 'r0' })).toMatchObject({ opening: false, link: 'https://open.feishu.cn/x' });
  expect(view({ id: 'r1', status: 'error' }, { opening: true, previousId: 'r0' })).toMatchObject({ opening: false, retry: true });
  expect(view(null, { opening: true, previousId: undefined })).toMatchObject({ opening: true, spinner: true });
});
