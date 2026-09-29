import { request } from '../api.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// Add or edit (app given) a Feishu app manually. An empty secret keeps the saved one for the same app.
export function AppDialog({ app, onClose, onSaved }) {
  const { values, field, set } = useFields({
    name: app?.name || '',
    appId: app?.appId || '',
    domain: app?.domain || 'feishu',
    appSecret: '',
    allowedUsers: app?.allowedUsers.join('\n') || '',
  });

  async function save() {
    try {
      await request('/apps/save', { id: app?.id, ...values, allowedUsers: values.allowedUsers.split(/[\s,]+/).filter(Boolean) });
      onSaved();
    } finally {
      set('appSecret', '');
    }
  }

  return (
    <FormDialog eyebrow="FEISHU APP" title="应用配置" submitLabel="保存应用" onSubmit={save} onClose={onClose}>
      <label>应用名称<input required placeholder="Claude 工作助手" {...field('name')} /></label>
      <div className="form-grid">
        <label>App ID<input className="mono" required placeholder="cli_…" {...field('appId')} /></label>
        <label>API 环境
          <select {...field('domain')}>
            <option value="feishu">飞书开放平台</option>
            <option value="lark">Lark 国际版</option>
            <option value="bytedance">字节内部 fsopen</option>
          </select>
        </label>
      </div>
      <label>App Secret<input className="mono" type="password" autoComplete="new-password" placeholder="填写新密钥；编辑时留空保留" {...field('appSecret')} /></label>
      <label>允许操作的用户 open_id<textarea className="mono" rows="3" placeholder="ou_…，每行一个" {...field('allowedUsers')} /></label>
    </FormDialog>
  );
}
