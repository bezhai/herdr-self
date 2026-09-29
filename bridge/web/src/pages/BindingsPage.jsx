import { request } from '../api.js';
import { ActionButton } from '../components/ActionButton.jsx';
import { Badge } from '../components/Badge.jsx';
import { Stream, StreamRow } from '../components/Stream.jsx';
import { bindingStatus, deliveryLabel, deliveryTone } from '../model.js';

function BindingRow({ binding: b, state, refresh, toast }) {
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
          <small>{app?.name}</small>
          <code>{b.chatId}</code>
          {b.rootId && <code>{`话题 ${b.rootId}`}</code>}
        </div>
      </td>
      <td data-label="目标会话"><div><strong>{machine?.name}</strong><code>{`${b.paneId} · ${b.nativeId.slice(0, 8)}`}</code></div></td>
      <td data-label="触发方式"><div>{b.requireMention ? '@机器人' : '全部消息'}</div></td>
      <td data-label="回复模式"><div>{b.replyInThread ? '话题回复' : '直接回复'}</div></td>
      <td data-label="状态"><div><Badge tone={status.tone}>{status.label}</Badge></div></td>
      <td className="row-action"><ActionButton className="text-button danger" run={remove} onError={toast}>解除</ActionButton></td>
    </tr>
  );
}

export function BindingsPage({ state, refresh, toast }) {
  return (
    <section className="page">
      <div className="section-heading"><h2>消息路由<span>routes</span></h2><p>聊天 / 话题 → 机器 → 原生会话</p></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>来源</th><th>目标会话</th><th>触发方式</th><th>回复模式</th><th>状态</th><th><span className="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            {state.bindings.length
              ? state.bindings.map((b) => <BindingRow key={b.id} binding={b} state={state} refresh={refresh} toast={toast} />)
              : <tr><td colSpan={6} className="table-empty">暂无会话绑定。接入机器与飞书应用后，使用上方的「新建绑定」。</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="section-heading"><h2>最近投递<span>deliveries</span></h2></div>
      <Stream empty="尚未接收平台消息。">
        {state.deliveries.slice().reverse().map((d) => (
          <StreamRow key={d.id || d.messageId} tone={deliveryTone(d.status)} at={d.createdAt} title={deliveryLabel(d.status)}>
            {d.messageId}{d.lastError ? ` · ${d.lastError}` : ''}
          </StreamRow>
        ))}
      </Stream>
    </section>
  );
}
