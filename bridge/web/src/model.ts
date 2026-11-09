import type { ClientStatus } from '../../clients.ts';
import type { ConsoleState } from '../../console-state.ts';
import type { Skills } from '../../skills.ts';
import type { Binding } from '../../state.ts';
import type { BridgeState } from './useBridge.ts';

// Pure display derivations from the /api/state payload. No DOM, no requests.

// The parts of the payload that components take one by one, and a skill with its files as /api/skills/read answers.
export type ConsoleApp = ConsoleState['apps'][number];
export type PendingChat = ConsoleState['pendingChats'][number];
export type SkillWithFiles = ReturnType<Skills['read']>;

// Tone of a badge: ok | warn | error | neutral. Tables of badges give the tone and the label of each state they know.
export type Tone = 'ok' | 'warn' | 'error' | 'neutral';
type Badges = { [state: string]: [Tone, string] };

const statusLabels: { [status: string]: string } = {
  connected: '已连接', disabled: '已停用', offline: '离线', idle: '未连接', error: '连接失败', failed: '连接失败', connecting: '连接中', reconnecting: '重连中',
};

// Label of a machine's Herdr status or a platform connection status. A machine is offline while its client is not connected.
export const statusLabel = (status: string) => statusLabels[status] || status;

const agentStatusLabels: { [status: string]: string } = { idle: '空闲', working: '运行中', blocked: '等待确认', done: '已完成', unknown: '未知' };

// Label of a Herdr agent_status. Its tone comes from statusTone like every other status.
export const agentStatusLabel = (status: string) => agentStatusLabels[status] || status;

// Tone of a connection, platform or Herdr agent status: ok | warn | error | neutral.
export function statusTone(status: string) {
  if (['error', 'failed'].includes(status)) return 'error';
  if (status === 'connected') return 'ok';
  if (['connecting', 'reconnecting', 'working', 'blocked'].includes(status)) return 'warn';
  return 'neutral';
}

const clientStates: Badges = { online: ['ok', '客户端在线'], refused: ['error', '客户端被拒绝'], offline: ['neutral', '客户端离线'] };

// Badge of the connection of a machine's client: online, refused (its last hello failed, for a reason the card shows) or offline.
export function clientStatus(client: ClientStatus) {
  const [tone, label] = clientStates[client?.state] || clientStates.offline;
  return { tone, label };
}

// Enabled machines whose client is connected. Bridge reaches a machine's Herdr only through its client,
// so only these report agents and can take a binding.
export const onlineMachines = (state: BridgeState) => state.machines.filter((m) => m.enabled && m.client?.state === 'online');

export function metrics(state: BridgeState) {
  const online = onlineMachines(state);
  return {
    machinesOnline: online.length,
    machines: state.machines.length,
    platformsConnected: state.apps.filter((a) => a.connection === 'connected').length,
    platforms: state.apps.length,
    bindings: state.bindings.length,
    agents: online.reduce((n, m) => n + m.agents!.length, 0), // !: the server leaves agents out while the first poll of a machine connects.
  };
}

// A binding is usable while its platform app is connected and its machine online.
export function bindingStatus(binding: Binding, state: BridgeState): { tone: Tone, label: string } {
  const app = state.apps.find((a) => a.id === binding.appId);
  if (app?.connection !== 'connected') return { tone: 'neutral', label: '等待平台连接' };
  if (!onlineMachines(state).some((m) => m.id === binding.machineId)) return { tone: 'neutral', label: '机器未连接' };
  return { tone: 'ok', label: '可用' };
}

// Claude permission modes a binding starts its topic agents with, and what each does.
export const permissionModes = [
  { id: 'default', note: '需要确认的操作发卡片到飞书' },
  { id: 'auto', note: '由 Claude 自动决定，很少需要确认' },
];

// The SKILL.md of a skill as /api/skills/read returns it, with its files in base64, as text.
export const skillText = (skill: Pick<SkillWithFiles, 'files'>) => new TextDecoder().decode(Uint8Array.from(atob(skill.files['SKILL.md'] || ''), (c) => c.charCodeAt(0)));

// Permission mode of a Claude binding: one saved before bindings had a mode has none and uses default.
export const permissionModeOf = (binding: Binding) => binding.permissionMode || 'default';

// choosing: a topic opened by /adopt that waits for an agent to be picked in Feishu.
const topicStates: Badges = { starting: ['warn', '启动中'], choosing: ['warn', '待选择'], ready: ['ok', '运行中'], failed: ['error', '失败'], closed: ['neutral', '已结束'] };

// Badge of a topic session state.
export function topicStatus(state: string) {
  const [tone, label] = topicStates[state] || ['neutral', state];
  return { tone, label };
}

// Label of a Feishu chat type: p2p is a direct chat, anything else a group.
export const chatTypeLabel = (type: string) => (type === 'p2p' ? '私聊' : '群聊');

// Whole minutes until a pending chat's binding link expires, rounded up.
export const minutesLeft = (expiresAt: number, now = Date.now()) => Math.max(0, Math.ceil((expiresAt - now) / 60000));

// Address of an app's bot avatar, or null without one. The update time busts the browser cache after a new download.
export const avatarUrl = (app: Pick<ConsoleApp, 'id' | 'avatar'> | undefined) => (app?.avatar ? `/api/apps/avatar?id=${encodeURIComponent(app.id)}&v=${app.avatar.updatedAt}` : null);

export const formatDateTime = (time: number) => new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export const formatTime = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const registrationMessages: { [status: string]: string } = {
  starting: '正在打开飞书…', pending: '等待飞书确认', connecting: '正在连接…', completed: '已准备就绪', expired: '二维码已过期',
  denied: '未完成授权', cancelled: '请重新添加', error: '暂时无法连接飞书', connection_error: '应用已添加，连接未成功', needs_owner: '请设置可操作用户',
};

// What the "add Feishu" dialog keeps itself; previousId is null or undefined without a registration before.
type RegistrationLocal = { opening: boolean, previousId?: string | null, scanning: boolean };

// View of the "add Feishu" dialog.
// local.opening: the dialog was just opened; the registration that existed before (local.previousId) is ignored
// until a new flow appears or the flow is active. The returned `opening` is the value to keep for the next render.
export function registrationView(registration: ConsoleState['registration'], apps: ConsoleApp[], { opening, previousId, scanning }: RegistrationLocal) {
  let r = registration;
  let stillOpening = opening;
  if (opening) {
    if (r && (r.id !== previousId || ['starting', 'pending', 'connecting'].includes(r.status))) stillOpening = false;
    else r = null;
  }
  const status = r?.status || 'starting';
  const app = apps.find((a) => a.id === r?.appId);
  const connected = app?.connection === 'connected';
  const completed = connected || status === 'completed';
  const problem = ['error', 'expired', 'denied', 'cancelled'].includes(status);
  const setup = ['connection_error', 'needs_owner'].includes(status) && !connected;
  const pending = status === 'pending';
  return {
    opening: stillOpening,
    title: completed ? '飞书已连接' : '在飞书中添加应用',
    subtitle: (completed && app?.name) || '',
    spinner: !(completed || problem || setup || (scanning && Boolean(r?.qr))),
    result: completed ? 'success' : problem || setup ? 'problem' : null,
    qr: scanning && pending && r?.qr ? r.qr : null,
    message: completed ? '已准备就绪' : registrationMessages[status] || '正在连接…',
    link: pending && r?.url ? r.url : null,
    scan: pending && Boolean(r?.qr),
    scanLabel: scanning ? '收起二维码' : '手机扫码',
    retry: problem,
    done: completed,
    configure: setup,
    manual: !completed,
  };
}
