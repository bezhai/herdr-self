import type { ConsoleMachine, HerdrStatus } from '../../../console-state.ts';
import type { Agent } from '../../../core.ts';
import { request } from '../api.ts';
import { ActionButton } from '../components/ActionButton.tsx';
import { Badge, StatusBadge } from '../components/Badge.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Icon } from '../components/Icon.tsx';
import { agentStatusLabel, clientStatus, statusTone } from '../model.ts';
import type { PageProps } from './pageInfo.ts';

type Props = PageProps & { openMachine: (machine: ConsoleMachine) => void, openToken: (machine: ConsoleMachine) => void };

// An agent as Herdr reports it. Without a session identity Herdr cannot tell which conversation runs in the pane.
function AgentRow({ agent }: { agent: Agent }) {
  return (
    <div className="agent-row">
      <i className="agent-dot" />
      <span className="agent-main">
        <strong>{agent.name || agent.agent || 'Agent'}</strong>
        <small>{`${agent.pane_id} · ${agent.cwd || ''}`}</small>
      </span>
      {!agent.agent_session?.value && <small className="agent-note">未识别 Agent 会话</small>}
      <Badge tone={statusTone(agent.agent_status)}>{agentStatusLabel(agent.agent_status)}</Badge>
    </div>
  );
}

// Toast after connecting or refreshing a machine, by the Herdr status it reached; any other status is a failed poll.
const connectMessages: { [state: string]: string } = { connected: '机器已连接', offline: '机器已启用，等待客户端连接' };

// Bridge reaches a machine only through its client, which connects with the machine's token (shown once when generated).
// The card shows that connection and the Herdr status Bridge polls through it: offline while the client is not connected.
function MachineCard({ machine: m, refresh, toast, openMachine, openToken }: Omit<Props, 'state'> & { machine: ConsoleMachine }) {
  const client = clientStatus(m.client);
  async function connect() {
    const result = await request<HerdrStatus>('/machines/connect', { id: m.id });
    toast(connectMessages[result.state] || '连接未成功，查看错误信息');
    await refresh();
  }
  async function act(path: string, message?: string) {
    await request(path, { id: m.id });
    if (message) toast(message);
    await refresh();
  }
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name="server" /></span>
        <div className="card-title">
          <strong>{m.name}</strong>
          <p><span>{`session ${m.session}`}</span></p>
        </div>
        <StatusBadge status={m.state} />
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
      {/* The server leaves agents out while the first poll connects: undefined > 0 is false then, but TypeScript wants the two ! here. */}
      {m.agents?.length! > 0 && (
        <div className="agents">
          {m.agents!.map((agent) => <AgentRow key={agent.pane_id} agent={agent} />)}
        </div>
      )}
    </article>
  );
}

export function MachinesPage({ state, refresh, toast, openMachine, openToken }: Props) {
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
