import { request } from '../api.js';
import { ActionButton } from '../components/ActionButton.jsx';
import { Badge, StatusBadge } from '../components/Badge.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';
import { statusTone } from '../model.js';

function AgentRow({ agent, adapter, onInspect }) {
  return (
    <div className={adapter ? 'agent-row ready' : 'agent-row'}>
      <i className="agent-dot" />
      <span className="agent-main">
        <strong>{agent.name || agent.agent || 'Agent'}</strong>
        <small>{`${agent.pane_id} · ${agent.cwd || ''}`}</small>
      </span>
      <Badge tone={statusTone(adapter ? 'ready' : 'offline')}>{adapter ? '已接入' : '需启动适配器'}</Badge>
      <span className="agent-action">
        {adapter && <button type="button" className="text-button" onClick={() => onInspect(adapter)}>查看连接</button>}
      </span>
    </div>
  );
}

function MachineCard({ machine: m, refresh, toast, openMachine, openInspect }) {
  async function connect() {
    const result = await request('/machines/connect', { id: m.id });
    toast(result.state === 'connected' ? '机器已连接' : '连接未成功，查看错误信息');
    await refresh();
  }
  async function act(path, message) {
    await request(path, { id: m.id });
    if (message) toast(message);
    await refresh();
  }
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name={m.type === 'ssh' ? 'globe' : 'terminal'} /></span>
        <div className="card-title">
          <strong>{m.name}</strong>
          <p><span>{m.type === 'ssh' ? `${m.host}:${m.port}` : '本机'}</span><span>{`session ${m.session}`}</span></p>
        </div>
        <StatusBadge status={m.enabled ? m.state || 'connecting' : 'disabled'} />
        <div className="card-actions">
          <ActionButton run={m.enabled ? () => act('/machines/disconnect') : connect} onError={toast}>{m.enabled ? '断开' : '连接'}</ActionButton>
          <ActionButton run={connect} onError={toast}>刷新</ActionButton>
          {!m.enabled && <button type="button" className="secondary" onClick={() => openMachine(m)}>编辑</button>}
          {!m.enabled && <ActionButton className="text-button danger" run={() => act('/machines/remove')} onError={toast}>移除</ActionButton>}
        </div>
      </div>
      <div className="card-detail">
        <span className="facts">
          <span><b>{m.panes?.length || 0}</b>个终端</span>
          <span><b>{m.agents?.length || 0}</b>个 Agent</span>
          <span><b>{m.adapters?.length || 0}</b>个已接入</span>
        </span>
        <ActionButton className="text-button" run={() => act('/machines/install', '已安装。请在对应 Herdr pane 中运行 ~/.local/bin/herdr-bridge-claude')} onError={toast}>
          {m.adapterInstalled ? '更新 Claude 适配器' : '安装 Claude 适配器'}
        </ActionButton>
      </div>
      {m.error && m.enabled && <div className="card-error">{m.error}</div>}
      {m.agents?.length > 0 && (
        <div className="agents">
          {m.agents.map((agent) => (
            <AgentRow
              key={agent.pane_id}
              agent={agent}
              adapter={m.adapters?.find((a) => a.paneId === agent.pane_id)}
              onInspect={(adapter) => openInspect({ machineId: m.id, adapterId: adapter.id })}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function MachinesPage({ state, refresh, toast, openMachine, openInspect }) {
  return (
    <section className="page">
      <div className="section-heading"><h2>Herdr 实例<span>hosts</span></h2></div>
      <div className="stack">
        {state.machines.length
          ? state.machines.map((m) => <MachineCard key={m.id} machine={m} refresh={refresh} toast={toast} openMachine={openMachine} openInspect={openInspect} />)
          : <EmptyState icon="server" title="接入第一台机器">使用上方的「添加机器」，连接 Bridge 本机或 SSH 上的 Herdr。</EmptyState>}
      </div>
      <div className="notice">
        <strong>接入 Claude 会话</strong>
        <ol>
          <li>在机器卡片中安装 Claude 适配器。</li>
          <li>在对应的 Herdr pane 中运行 <code>~/.local/bin/herdr-bridge-claude</code>。已在运行的 Claude 需要通过这条命令重新启动。</li>
          <li>首次启动时确认 Claude 的 development channel 提示，会话随后出现在机器卡片中。</li>
        </ol>
      </div>
    </section>
  );
}
