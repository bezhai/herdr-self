import { request } from '../api.js';
import { ActionButton } from '../components/ActionButton.jsx';
import { StatusBadge } from '../components/Badge.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Icon } from '../components/Icon.jsx';

const domainNames = { bytedance: '字节内部', lark: 'Lark 国际版' };

function AppCard({ app, bindings, refresh, toast, openApp }) {
  async function act(path, body, message) {
    await request(path, body);
    if (message) toast(message);
    await refresh();
  }
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name="feishu" /></span>
        <div className="card-title">
          <strong>{app.name}</strong>
          <p><span>{app.appId}</span><span>{domainNames[app.domain] || '飞书开放平台'}</span></p>
        </div>
        <StatusBadge status={app.connection} />
        <div className="card-actions">
          <ActionButton run={() => act('/apps/test', { id: app.id }, '应用凭证验证通过')} onError={toast}>验证凭证</ActionButton>
          <ActionButton run={() => act('/apps/toggle', { id: app.id, enabled: !app.enabled }, app.enabled ? '应用已停用' : '正在建立长连接')} onError={toast}>
            {app.enabled ? '停用' : '启用连接'}
          </ActionButton>
          {!app.enabled && <button type="button" className="secondary" onClick={() => openApp(app)}>配置</button>}
          {!app.enabled && <ActionButton className="text-button danger" run={() => act('/apps/remove', { id: app.id })} onError={toast}>移除</ActionButton>}
        </div>
      </div>
      <div className="card-detail">
        <span>{app.verifiedAt ? `凭证已验证${app.botName ? ` · ${app.botName}` : ''}` : '尚未验证凭证'}</span>
        <span className="facts">
          <span><b>{app.allowedUsers.length}</b>位授权用户</span>
          <span><b>{bindings.filter((b) => b.appId === app.id).length}</b>个绑定</span>
        </span>
      </div>
      {app.error && <div className="card-error">{app.error}</div>}
    </article>
  );
}

export function PlatformsPage({ state, refresh, toast, openApp }) {
  return (
    <section className="page">
      <div className="section-heading"><h2>平台应用<span>feishu</span></h2></div>
      <div className="stack">
        {state.apps.length
          ? state.apps.map((app) => <AppCard key={app.id} app={app} bindings={state.bindings} refresh={refresh} toast={toast} openApp={openApp} />)
          : <EmptyState icon="chat" title="连接飞书">使用上方的「添加飞书」，在飞书中新建或选择已有应用，确认后自动建立长连接。</EmptyState>}
      </div>
    </section>
  );
}
