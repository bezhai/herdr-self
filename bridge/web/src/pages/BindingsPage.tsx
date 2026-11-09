import { Fragment } from 'react';
import type { ConsoleBinding, ConsoleTopic } from '../../../console-state.ts';
import { request } from '../api.ts';
import { ActionButton } from '../components/ActionButton.tsx';
import { AppAvatar } from '../components/AppAvatar.tsx';
import { Badge } from '../components/Badge.tsx';
import { bindingStatus, chatTypeLabel, formatDateTime, topicStatus } from '../model.ts';
import type { BridgeState } from '../useBridge.ts';
import type { PageProps } from './pageInfo.ts';

type Props = PageProps & { openBinding: (binding: ConsoleBinding) => void };

// The topics of one binding, newest first: each is an agent session in its own Herdr tab, or one it adopted from any pane (/adopt).
function TopicsRow({ topics, state }: { topics: ConsoleTopic[], state: BridgeState }) {
  return (
    <tr className="topics-row">
      <td colSpan={6}>
        <ul className="topics">
          {topics.map((t) => {
            const status = topicStatus(t.state);
            const machine = state.machines.find((m) => m.id === t.machineId);
            return (
              <li key={t.id} className="topic">
                <Badge tone={status.tone}>{status.label}</Badge>
                <strong>{t.title}</strong>
                <code>{[machine?.name, t.paneId].filter(Boolean).join(' · ')}</code>
                <time dateTime={new Date(t.createdAt).toISOString()}>{formatDateTime(t.createdAt)}</time>
                {t.state === 'failed' && t.error && <p className="topic-error">{t.error}</p>}
              </li>
            );
          })}
        </ul>
      </td>
    </tr>
  );
}

// The chat a binding is for, with the project and the agent configuration its topics start with. A direct chat has no project: each of its
// topics gets the one that fits its task.
function BindingRow({ binding: b, state, refresh, toast, openBinding }: Props & { binding: ConsoleBinding }) {
  const project = state.projects.find((p) => p.id === b.defaultProjectId);
  const config = state.agentConfigs.find((c) => c.id === b.defaultAgentConfigId);
  const app = state.apps.find((a) => a.id === b.appId);
  const status = bindingStatus(b, state);
  async function remove() {
    await request('/bindings/remove', { id: b.id });
    await refresh();
  }
  return (
    <tr>
      <td data-label="来源">
        <div>
          <strong>{b.name}</strong>
          <small className="app-name"><AppAvatar app={app} />{app?.name}</small>
          <code>{`${chatTypeLabel(b.chatType)} · ${b.chatId}`}</code>
        </div>
      </td>
      <td data-label="默认项目"><div>{b.chatType === 'p2p' ? '按任务自动选择' : project?.name}</div></td>
      <td className="nowrap" data-label="默认 Agent 配置"><div>{config?.name}</div></td>
      <td className="nowrap" data-label="触发方式"><div>{b.requireMention ? '@机器人' : '全部消息'}</div></td>
      <td data-label="状态"><div><Badge tone={status.tone}>{status.label}</Badge></div></td>
      <td className="row-action">
        <button type="button" className="secondary" onClick={() => openBinding(b)}>编辑</button>
        <ActionButton className="text-button danger" run={remove} onError={toast}>解除</ActionButton>
      </td>
    </tr>
  );
}

export function BindingsPage({ state, refresh, toast, openBinding }: Props) {
  return (
    <section className="page">
      <div className="section-heading"><h2>消息路由</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>来源</th><th>默认项目</th><th>默认 Agent 配置</th><th>触发方式</th><th>状态</th><th><span className="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            {state.bindings.length
              ? state.bindings.map((b) => {
                const topics = state.topics.filter((t) => t.bindingId === b.id).sort((x, y) => y.createdAt - x.createdAt);
                return (
                  <Fragment key={b.id}>
                    <BindingRow binding={b} state={state} refresh={refresh} toast={toast} openBinding={openBinding} />
                    {topics.length > 0 && <TopicsRow topics={topics} state={state} />}
                  </Fragment>
                );
              })
              : <tr><td colSpan={6} className="table-empty">暂无会话绑定</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
