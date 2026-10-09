// Pure display derivations from the /api/state payload. No DOM, no requests.

const statusLabels = {
  connected: '已连接', disabled: '已停用', idle: '未连接', error: '连接失败', failed: '连接失败', connecting: '连接中', reconnecting: '重连中',
};

// Label of a machine or platform connection status.
export const statusLabel = (status) => statusLabels[status] || status;

const agentStatusLabels = { idle: '空闲', working: '运行中', blocked: '等待确认', done: '已完成', unknown: '未知' };

// Label of a Herdr agent_status. Its tone comes from statusTone like every other status.
export const agentStatusLabel = (status) => agentStatusLabels[status] || status;

// Tone of a connection, platform or Herdr agent status: ok | warn | error | neutral.
export function statusTone(status) {
  if (['error', 'failed'].includes(status)) return 'error';
  if (status === 'connected') return 'ok';
  if (['connecting', 'reconnecting', 'working', 'blocked'].includes(status)) return 'warn';
  return 'neutral';
}

// Enabled machines whose last Herdr refresh succeeded; only these can take a new binding.
export const connectedMachines = (state) => state.machines.filter((m) => m.enabled && m.state === 'connected');

export function metrics(state) {
  return {
    machinesOnline: connectedMachines(state).length,
    machines: state.machines.length,
    platformsConnected: state.apps.filter((a) => a.connection === 'connected').length,
    platforms: state.apps.length,
    bindings: state.bindings.length,
    agents: connectedMachines(state).reduce((n, m) => n + m.agents.length, 0),
  };
}

// A binding is usable while its platform app and its machine are connected.
export function bindingStatus(binding, state) {
  const app = state.apps.find((a) => a.id === binding.appId);
  if (app?.connection !== 'connected') return { tone: 'neutral', label: '等待平台连接' };
  if (!connectedMachines(state).some((m) => m.id === binding.machineId)) return { tone: 'neutral', label: '机器未连接' };
  return { tone: 'ok', label: '可用' };
}

// Claude permission modes a binding starts its topic agents with, and what each does.
export const permissionModes = [
  { id: 'default', note: '需要确认的操作发卡片到飞书' },
  { id: 'auto', note: '由 Claude 自动决定，很少需要确认' },
];

// Permission mode of a Claude binding: one saved before bindings had a mode has none and uses default.
export const permissionModeOf = (binding) => binding.permissionMode || 'default';

// choosing: a topic opened by /adopt that waits for an agent to be picked in Feishu.
const topicStates = { starting: ['warn', '启动中'], choosing: ['warn', '待选择'], ready: ['ok', '运行中'], failed: ['error', '失败'], closed: ['neutral', '已结束'] };

// Badge of a topic session state.
export function topicStatus(state) {
  const [tone, label] = topicStates[state] || ['neutral', state];
  return { tone, label };
}

// Label of a Feishu chat type: p2p is a direct chat, anything else a group.
export const chatTypeLabel = (type) => (type === 'p2p' ? '私聊' : '群聊');

// Whole minutes until a pending chat's binding link expires, rounded up.
export const minutesLeft = (expiresAt, now = Date.now()) => Math.max(0, Math.ceil((expiresAt - now) / 60000));

// Address of an app's bot avatar, or null without one. The update time busts the browser cache after a new download.
export const avatarUrl = (app) => (app?.avatar ? `/api/apps/avatar?id=${encodeURIComponent(app.id)}&v=${app.avatar.updatedAt}` : null);

export const formatDateTime = (time) => new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export const formatTime = (time) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const registrationMessages = {
  starting: '正在打开飞书…', pending: '等待飞书确认', connecting: '正在连接…', completed: '已准备就绪', expired: '二维码已过期',
  denied: '未完成授权', cancelled: '请重新添加', error: '暂时无法连接飞书', connection_error: '应用已添加，连接未成功', needs_owner: '请设置可操作用户',
};

// View of the "add Feishu" dialog.
// local.opening: the dialog was just opened; the registration that existed before (local.previousId) is ignored
// until a new flow appears or the flow is active. The returned `opening` is the value to keep for the next render.
export function registrationView(registration, apps, { opening, previousId, scanning }) {
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
    subtitle: completed ? app?.name || '' : '新建或选择已有应用',
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
