import { expect, test } from 'vitest';
import type { ClientStatus } from '../../clients.ts';
import type { ConsoleState } from '../../console-state.ts';
import type { Agent } from '../../core.ts';
import {
  agentStatusLabel, avatarUrl, bindingStatus, chatTypeLabel, clientStatus, configName, metrics, onlineMachines, registrationView, repoName, statusLabel,
  skillText, statusTone, topicStatus,
} from './model.ts';
import type { ConsoleApp } from './model.ts';
import { base64, sampleState } from './test/fixtures.ts';

test('status tones group connection and Herdr agent states', () => {
  expect(['error', 'failed'].map(statusTone)).toEqual(['error', 'error']);
  expect(statusTone('connected')).toBe('ok');
  expect(['connecting', 'reconnecting', 'working', 'blocked'].map(statusTone)).toEqual(['warn', 'warn', 'warn', 'warn']);
  expect(['disabled', 'idle', 'done', 'unknown', 'unknown-state'].map(statusTone)).toEqual(['neutral', 'neutral', 'neutral', 'neutral', 'neutral']);
  expect(statusLabel('reconnecting')).toBe('重连中');
  expect(statusLabel('idle')).toBe('未连接');
  expect(statusLabel('unknown-state')).toBe('unknown-state');
});

test('a machine whose client is not connected has the Herdr status offline', () => {
  expect(statusLabel('offline')).toBe('离线');
  expect(statusTone('offline')).toBe('neutral');
});

test('Herdr agent statuses have their own labels', () => {
  expect(['idle', 'working', 'blocked', 'done', 'unknown'].map(agentStatusLabel)).toEqual(['空闲', '运行中', '等待确认', '已完成', '未知']);
  expect(agentStatusLabel('new-status')).toBe('new-status');
});

test('topic states have a label and a tone', () => {
  expect(['starting', 'choosing', 'ready', 'failed', 'closed', 'other'].map(topicStatus)).toEqual([
    { tone: 'warn', label: '启动中' }, { tone: 'warn', label: '待选择' }, { tone: 'ok', label: '运行中' }, { tone: 'error', label: '失败' },
    { tone: 'neutral', label: '已结束' }, { tone: 'neutral', label: 'other' },
  ]);
});

test('the client connection of a machine is online, refused or offline, which is also what a machine without one shows', () => {
  // as: undefined is a machine without a client, which the server never sends.
  expect(([{ state: 'online', host: 'h', since: 1 }, { state: 'refused', error: 'x' }, { state: 'offline' }, undefined] as ClientStatus[]).map(clientStatus)).toEqual([
    { tone: 'ok', label: '客户端在线' }, { tone: 'error', label: '客户端被拒绝' }, { tone: 'neutral', label: '客户端离线' }, { tone: 'neutral', label: '客户端离线' },
  ]);
});

test('online machines are the enabled ones whose client is connected, whatever their last Herdr poll returned', () => {
  const state = sampleState();
  expect(onlineMachines(state).map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-5']);
  state.machines[2].client = { state: 'online', host: 'laptop-host', since: 1 };
  state.machines[0].client = { state: 'offline' };
  expect(onlineMachines(state).map((m) => m.id)).toEqual(['m-2', 'm-5']);
});

test('metrics count online machines, connected platforms, bindings and the agents Herdr reports on online machines', () => {
  const state = sampleState();
  expect(metrics(state)).toEqual({ machinesOnline: 3, machines: 5, platformsConnected: 1, platforms: 2, bindings: 1, agents: 3 });
  // as: these agents hold only what metrics reads.
  state.machines[2].agents = [{ pane_id: 'w1:p1', agent_status: 'idle' }] as Agent[];
  state.machines[3].agents = [{ pane_id: 'w1:p1', agent_status: 'idle' }] as Agent[];
  expect(metrics(state).agents).toBe(3);
  state.machines[1].agents = [{ pane_id: 'w1:p1', agent_status: 'idle' }] as Agent[];
  expect(metrics(state).agents).toBe(4);
});

test('metrics count an online machine whose first poll is still connecting, which has no agents yet', () => {
  const state = sampleState();
  // as: what a machine looked like before the server sent empty lists for it.
  delete (state.machines[1] as Partial<typeof state.machines[1]>).agents;
  expect(metrics(state)).toMatchObject({ machinesOnline: 3, agents: 3 });
});

test('a binding is usable while its platform app is connected and the machine of its default agent configuration is online', () => {
  const state = sampleState();
  const binding = state.bindings[0];
  const machineDown = { tone: 'neutral', label: '机器未连接' };
  const onMachine = (machineId: string) => {
    state.agentConfigs[0] = { ...state.agentConfigs[0], machineId };
    return bindingStatus(binding, state);
  };
  expect(bindingStatus(binding, state)).toEqual({ tone: 'ok', label: '可用' });
  expect(onMachine('m-5')).toEqual({ tone: 'ok', label: '可用' });
  expect(onMachine('m-3')).toEqual(machineDown);
  expect(onMachine('m-4')).toEqual(machineDown);
  expect(onMachine('removed')).toEqual(machineDown);
  expect(bindingStatus({ ...binding, defaultAgentConfigId: 'removed' }, state)).toEqual(machineDown);
  state.agentConfigs[0] = { ...state.agentConfigs[0], machineId: 'm-1' };
  state.apps[0].connection = 'reconnecting';
  expect(bindingStatus(binding, state)).toEqual({ tone: 'neutral', label: '等待平台连接' });
});

test('an agent configuration is named after its machine, kind and model, whichever of them it has', () => {
  expect(configName({ name: 'cpu1' }, 'claude', 'Seed')).toBe('cpu1 · Claude · Seed');
  expect(configName({ name: 'cpu2' }, 'agy', '')).toBe('cpu2 · Antigravity');
  expect(configName(undefined, 'codex', '')).toBe('Codex');
});

test('a repository is named by the last part of its address, whether ssh or https', () => {
  expect(['git@code.example:growth/genvi.git', 'https://github.example/a/promoter/', 'ssh://git@host:2222/team/app.git'].map(repoName)).toEqual(['genvi', 'promoter', 'app']);
});

test('a chat type is labelled direct or group', () => {
  expect(['p2p', 'group'].map(chatTypeLabel)).toEqual(['私聊', '群聊']);
});

test('an app avatar is served by the console API and versioned by its update time', () => {
  expect(avatarUrl({ id: 'app-1', avatar: { type: 'image/png', updatedAt: 5 } })).toBe('/api/apps/avatar?id=app-1&v=5');
  expect(avatarUrl({ id: 'a b&c', avatar: { type: 'image/png', updatedAt: 5 } })).toBe('/api/apps/avatar?id=a%20b%26c&v=5');
  expect(avatarUrl({ id: 'app-2' })).toBeNull();
  expect(avatarUrl(undefined)).toBeNull();
});

// as: these apps hold only what registrationView reads, and so do the registrations that view() takes.
const apps = [
  { id: 'app-1', name: '工作助手', enabled: true, connection: 'connected' },
  { id: 'app-2', name: '新应用', enabled: false, connection: 'disabled' },
] as ConsoleApp[];
type Registration = Partial<NonNullable<ConsoleState['registration']>>;
const view = (registration: Registration | null, local: Partial<Parameters<typeof registrationView>[2]> = {}) => registrationView(registration as ConsoleState['registration'], apps, { opening: false, previousId: null, scanning: false, ...local });

test('registration view: starting shows the spinner and the manual entry', () => {
  expect(view(null)).toEqual({
    opening: false, title: '在飞书中添加应用', subtitle: '', spinner: true, result: null, qr: null,
    message: '正在打开飞书…', link: null, scan: false, scanLabel: '手机扫码', retry: false, done: false, configure: false, manual: true,
  });
  expect(view({ id: 'r1', status: 'connecting', appId: 'app-2' })).toMatchObject({ spinner: true, message: '正在连接…', done: false });
});

test('registration view: pending links to Feishu and toggles the QR code', () => {
  const pending: Registration = { id: 'r1', status: 'pending', url: 'https://open.feishu.cn/page/x', qr: 'data:image/png;base64,qr' };
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
  for (const [status, message] of [['error', '暂时无法连接飞书'], ['expired', '二维码已过期'], ['denied', '未完成授权'], ['cancelled', '请重新添加']] as const) {
    expect(view({ id: 'r1', status })).toMatchObject({ spinner: false, result: 'problem', message, retry: true, configure: false, done: false, manual: true });
  }
  expect(view({ id: 'r1', status: 'connection_error', appId: 'app-2' })).toMatchObject({ spinner: false, result: 'problem', message: '应用已添加，连接未成功', configure: true, retry: false });
  expect(view({ id: 'r1', status: 'needs_owner', appId: 'app-2' })).toMatchObject({ result: 'problem', message: '请设置可操作用户', configure: true });
});

test('registration view: while opening, the previous finished registration is ignored until a new flow appears', () => {
  const previous: Registration = { id: 'r0', status: 'completed', appId: 'app-1' };
  expect(view(previous, { opening: true, previousId: 'r0' })).toMatchObject({ opening: true, spinner: true, done: false, message: '正在打开飞书…' });
  expect(view({ ...previous, status: 'pending', url: 'https://open.feishu.cn/x' }, { opening: true, previousId: 'r0' })).toMatchObject({ opening: false, link: 'https://open.feishu.cn/x' });
  expect(view({ id: 'r1', status: 'error' }, { opening: true, previousId: 'r0' })).toMatchObject({ opening: false, retry: true });
  expect(view(null, { opening: true, previousId: undefined })).toMatchObject({ opening: true, spinner: true });
});

test('the SKILL.md of a skill read with its files is its UTF-8 text', () => {
  const text = '---\nname: deploy-notes\ndescription: 部署前后要检查的事项。\n---\n先看 CI 🚦\n';
  expect(skillText({ files: { 'SKILL.md': base64(text), 'scripts/run.sh': base64('echo\n') } })).toBe(text);
});
