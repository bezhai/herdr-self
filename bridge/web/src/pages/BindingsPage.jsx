import { Fragment } from 'react';
import { request } from '../api.js';
import { ActionButton } from '../components/ActionButton.jsx';
import { AppAvatar } from '../components/AppAvatar.jsx';
import { Badge } from '../components/Badge.jsx';
import { bindingStatus, formatDateTime, permissionModeOf, topicStatus } from '../model.js';

// The topics of one binding, newest first: each is an agent session in its own Herdr tab, or one it adopted from any pane (/接管).
function TopicsRow({ topics, state }) {
  return (
    <tr className="topics-row">
      <td colSpan={5}>
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

// A Claude binding shows its permission mode, which openPermissionMode(binding) changes.
function BindingRow({ binding: b, state, refresh, toast, openPermissionMode }) {
  const claude = b.kind === 'claude';
  const machine = state.machines.find((m) => m.id === b.machineId);
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
          <code>{b.chatId}</code>
        </div>
      </td>
      <td data-label="目标">
        <div>
          <strong>{machine?.name}</strong>
          <code>{`${b.kind} · ${b.cwd}`}</code>
          {claude && <small>{`权限模式：${permissionModeOf(b)}`}</small>}
        </div>
      </td>
      <td data-label="触发方式"><div>{b.requireMention ? '@机器人' : '全部消息'}</div></td>
      <td data-label="状态"><div><Badge tone={status.tone}>{status.label}</Badge></div></td>
      <td className="row-action">
        {claude && <button type="button" className="text-button" onClick={() => openPermissionMode(b)}>修改权限模式</button>}
        <ActionButton className="text-button danger" run={remove} onError={toast}>解除</ActionButton>
      </td>
    </tr>
  );
}

export function BindingsPage({ state, refresh, toast, openPermissionMode }) {
  return (
    <section className="page">
      <div className="section-heading"><h2>消息路由<span>routes</span></h2><p>每个飞书话题在 Herdr 中新开一个 tab</p></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>来源</th><th>目标</th><th>触发方式</th><th>状态</th><th><span className="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            {state.bindings.length
              ? state.bindings.map((b) => {
                const topics = state.topics.filter((t) => t.bindingId === b.id).sort((x, y) => y.createdAt - x.createdAt);
                return (
                  <Fragment key={b.id}>
                    <BindingRow binding={b} state={state} refresh={refresh} toast={toast} openPermissionMode={openPermissionMode} />
                    {topics.length > 0 && <TopicsRow topics={topics} state={state} />}
                  </Fragment>
                );
              })
              : <tr><td colSpan={5} className="table-empty">暂无会话绑定。在飞书里给机器人发一条消息，按机器人回复的链接完成绑定。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
