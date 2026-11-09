import type { AgentConfig } from '../../../state.ts';
import { request } from '../api.ts';
import { ActionButton } from '../components/ActionButton.tsx';
import { Badge } from '../components/Badge.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Icon } from '../components/Icon.tsx';
import { agentKinds, configName } from '../model.ts';
import type { PageProps } from './pageInfo.ts';

type Props = PageProps & { openConfig: (config: AgentConfig) => void };

// An agent configuration: the kind of agent, its model and, for Claude, its permission mode and the commands it is limited to, on one machine.
// A name other than the one that machine, kind and model would give is followed by those. One that a binding uses as its default, or that
// has topics running, cannot be deleted; the refusal comes back as a toast.
function ConfigCard({ config: c, state, refresh, toast, openConfig }: Props & { config: AgentConfig }) {
  const machine = state.machines.find((m) => m.id === c.machineId);
  const details = [machine?.name, agentKinds.find((k) => k.id === c.kind)?.name, c.model].filter(Boolean);
  async function remove() {
    await request('/agent-configs/remove', { id: c.id });
    await refresh();
  }
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name="terminal" /></span>
        <div className="card-title">
          <strong>{c.name}</strong>
          {c.name !== configName(machine, c.kind, c.model || '') && <p>{details.map((text) => <span key={text}>{text}</span>)}</p>}
        </div>
        {c.permissionMode && <Badge tone="neutral">{c.permissionMode}</Badge>}
        <div className="card-actions">
          <button type="button" className="secondary" onClick={() => openConfig(c)}>编辑</button>
          <ActionButton className="text-button danger" run={remove} onError={toast}>删除</ActionButton>
        </div>
      </div>
      {c.allowedCommands && (
        <div className="card-detail">
          <span>只允许执行的命令</span>
          <span className="facts">{c.allowedCommands.map((command) => <span key={command}><b>{command}</b></span>)}</span>
        </div>
      )}
    </article>
  );
}

export function AgentConfigsPage(props: Props) {
  const { state } = props;
  return (
    <section className="page">
      <div className="section-heading"><h2>Agent 配置列表</h2></div>
      <div className="stack">
        {state.agentConfigs.length
          ? state.agentConfigs.map((c) => <ConfigCard key={c.id} config={c} {...props} />)
          : <EmptyState icon="terminal" title="暂无 Agent 配置" />}
      </div>
    </section>
  );
}
