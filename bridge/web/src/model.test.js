import { expect, test } from 'vitest';
import {
  agentStatusLabel, avatarUrl, bindingStatus, chatTypeLabel, metrics, minutesLeft, permissionModeOf, registrationView, statusLabel, statusTone, topicStatus,
} from './model.js';
import { sampleState } from './test/fixtures.js';

test('status tones group connection and Herdr agent states', () => {
  expect(['error', 'failed'].map(statusTone)).toEqual(['error', 'error']);
  expect(statusTone('connected')).toBe('ok');
  expect(['connecting', 'reconnecting', 'working', 'blocked'].map(statusTone)).toEqual(['warn', 'warn', 'warn', 'warn']);
  expect(['disabled', 'idle', 'done', 'unknown', 'unknown-state'].map(statusTone)).toEqual(['neutral', 'neutral', 'neutral', 'neutral', 'neutral']);
  expect(statusLabel('reconnecting')).toBe('重连中');
  expect(statusLabel('idle')).toBe('未连接');
  expect(statusLabel('unknown-state')).toBe('unknown-state');
});

test('Herdr agent statuses have their own labels', () => {
  expect(['idle', 'working', 'blocked', 'done', 'unknown'].map(agentStatusLabel)).toEqual(['空闲', '运行中', '等待确认', '已完成', '未知']);
  expect(agentStatusLabel('new-status')).toBe('new-status');
});

test('topic states have a label and a tone', () => {
  expect(['starting', 'ready', 'failed', 'closed', 'other'].map(topicStatus)).toEqual([
    { tone: 'warn', label: '启动中' }, { tone: 'ok', label: '运行中' }, { tone: 'error', label: '失败' }, { tone: 'neutral', label: '已结束' },
    { tone: 'neutral', label: 'other' },
  ]);
});

test('metrics count online machines, connected platforms, bindings and the agents Herdr reports on connected machines', () => {
  const state = sampleState();
  expect(metrics(state)).toEqual({ machinesOnline: 2, machines: 4, platformsConnected: 1, platforms: 2, bindings: 1, agents: 3 });
  state.machines[2].agents = [{ pane_id: 'w1:p1', agent_status: 'idle' }];
  state.machines[3].agents = [{ pane_id: 'w1:p1', agent_status: 'idle' }];
  expect(metrics(state).agents).toBe(3);
});

test('a binding is usable while its platform app and its machine are connected', () => {
  const state = sampleState();
  const binding = state.bindings[0];
  const machineDown = { tone: 'neutral', label: '机器未连接' };
  expect(bindingStatus(binding, state)).toEqual({ tone: 'ok', label: '可用' });
  expect(bindingStatus({ ...binding, machineId: 'm-3' }, state)).toEqual(machineDown);
  expect(bindingStatus({ ...binding, machineId: 'm-4' }, state)).toEqual(machineDown);
  expect(bindingStatus({ ...binding, machineId: 'removed' }, state)).toEqual(machineDown);
  state.apps[0].connection = 'reconnecting';
  expect(bindingStatus(binding, state)).toEqual({ tone: 'neutral', label: '等待平台连接' });
});

test('a Claude binding saved before bindings had a permission mode uses default', () => {
  const [binding] = sampleState().bindings;
  expect(permissionModeOf(binding)).toBe('default');
  expect(permissionModeOf({ ...binding, permissionMode: 'auto' })).toBe('auto');
});

test('pending chats show their chat type and the whole minutes left, rounded up', () => {
  expect(['p2p', 'group'].map(chatTypeLabel)).toEqual(['私聊', '群聊']);
  expect(minutesLeft(10 * 60000, 0)).toBe(10);
  expect(minutesLeft(10 * 60000, 1)).toBe(10);
  expect(minutesLeft(10 * 60000 + 1, 0)).toBe(11);
  expect(minutesLeft(0, 5)).toBe(0);
});

test('an app avatar is served by the console API and versioned by its update time', () => {
  expect(avatarUrl({ id: 'app-1', avatar: { type: 'image/png', updatedAt: 5 } })).toBe('/api/apps/avatar?id=app-1&v=5');
  expect(avatarUrl({ id: 'a b&c', avatar: { type: 'image/png', updatedAt: 5 } })).toBe('/api/apps/avatar?id=a%20b%26c&v=5');
  expect(avatarUrl({ id: 'app-2' })).toBeNull();
  expect(avatarUrl(undefined)).toBeNull();
});

const apps = [
  { id: 'app-1', name: '工作助手', enabled: true, connection: 'connected' },
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

test('registration view: completed, or an already connected app, shows the app name and the done action', () => {
  const done = { spinner: false, result: 'success', title: '飞书已连接', subtitle: '工作助手', message: '已准备就绪', done: true, retry: false, configure: false, manual: false, link: null };
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
