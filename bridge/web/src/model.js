// Pure display derivations from the /api/state payload. No DOM, no requests.

const statusLabels = {
  connected: '已连接', disabled: '已停用', idle: '未连接', error: '连接失败', failed: '连接失败', connecting: '连接中',
  reconnecting: '重连中', ready: '就绪', working: '执行中', blocked: '等待审批', offline: '未接入',
};

export const statusLabel = (status) => statusLabels[status] || status;

// Tone of a connection, platform or agent status: ok | warn | error | neutral.
export function statusTone(status) {
  if (['error', 'failed'].includes(status)) return 'error';
  if (['connected', 'ready'].includes(status)) return 'ok';
  if (['connecting', 'reconnecting', 'working', 'blocked'].includes(status)) return 'warn';
  return 'neutral';
}

// Machines that can take a new binding.
export const connectedMachines = (state) => state.machines.filter((m) => m.enabled && m.state === 'connected');

export function metrics(state) {
  return {
    machinesOnline: connectedMachines(state).length,
    machines: state.machines.length,
    platformsConnected: state.apps.filter((a) => a.connection === 'connected').length,
    platforms: state.apps.length,
    bindings: state.bindings.length,
    agents: state.machines.reduce((n, m) => n + (m.adapters?.length || 0), 0),
  };
}

// A binding works only while its pinned native session is attached and its platform app is connected.
export function bindingStatus(binding, state) {
  const machine = state.machines.find((m) => m.id === binding.machineId);
  const app = state.apps.find((a) => a.id === binding.appId);
  const adapter = machine?.adapters?.find((x) => x.id === binding.adapterId && x.nativeId === binding.nativeId);
  if (!adapter) return { tone: 'neutral', label: '等待原生会话' };
  if (app?.connection !== 'connected') return { tone: 'neutral', label: '等待平台连接' };
  return { tone: 'ok', label: '可用' };
}

const deliveryLabels = {
  queued: '排队中', running: '执行中', completed: '已回复', delivery_unknown: '投递待核查', no_reply: '需要关注', dispatching: '投递中',
};

export const deliveryLabel = (status) => deliveryLabels[status] || status;
export const deliveryTone = (status) => (['delivery_unknown', 'no_reply'].includes(status) ? 'warn' : 'neutral');

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
    subtitle: completed ? app?.botName || app?.name || '' : '新建或选择已有应用',
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
