import { request } from '../api.js';
import { ActionButton } from '../components/ActionButton.jsx';
import { Badge, StatusBadge } from '../components/Badge.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';
import { agentStatusLabel, clientStatus, statusTone } from '../model.js';

// An agent as Herdr reports it. Without a session identity Herdr cannot tell which conversation runs in the pane.
function AgentRow({ agent }) {
  return (
    <div className="agent-row">
      <i className="agent-dot" />
      <span className="agent-main">
        <strong>{agent.name || agent.agent || 'Agent'}</strong>
        <small>{`${agent.pane_id} · ${agent.cwd || ''}`}</small>
      </span>
      {!agent.agent_session?.value && <small className="agent-note">未识别会话</small>}
      <Badge tone={statusTone(agent.agent_status)}>{agentStatusLabel(agent.agent_status)}</Badge>
    </div>
  );
}

// Besides Herdr over SSH or locally, a machine has a client that connects to Bridge with the machine's token; the token is shown once.
function MachineCard({ machine: m, refresh, toast, openMachine, openToken }) {
  const client = clientStatus(m.client);
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
          <button type="button" className="secondary" onClick={() => openToken(m)}>{m.hasToken ? '重新生成 token' : '生成 token'}</button>
          {!m.enabled && <button type="button" className="secondary" onClick={() => openMachine(m)}>编辑</button>}
          {!m.enabled && <ActionButton className="text-button danger" run={() => act('/machines/remove')} onError={toast}>移除</ActionButton>}
        </div>
      </div>
      <div className="card-detail">
        <span className="facts">
          <span><b>{m.panes?.length || 0}</b>个终端</span>
          <span><b>{m.agents?.length || 0}</b>个 Agent</span>
          {m.client?.state === 'online' && <span><b>{m.client.host}</b>上的客户端</span>}
        </span>
        <Badge tone={client.tone}>{client.label}</Badge>
      </div>
      {m.error && m.enabled && <div className="card-error">{m.error}</div>}
      {m.client?.state === 'refused' && <div className="card-error">{m.client.error}</div>}
      {m.agents?.length > 0 && (
        <div className="agents">
          {m.agents.map((agent) => <AgentRow key={agent.pane_id} agent={agent} />)}
        </div>
      )}
    </article>
  );
}

export function MachinesPage({ state, refresh, toast, openMachine, openToken }) {
  return (
    <section className="page">
      <div className="section-heading"><h2>Herdr 实例</h2></div>
      <div className="stack">
        {state.machines.length
          ? state.machines.map((m) => <MachineCard key={m.id} machine={m} refresh={refresh} toast={toast} openMachine={openMachine} openToken={openToken} />)
          : <EmptyState icon="server" title="暂无机器" />}
      </div>
    </section>
  );
}
