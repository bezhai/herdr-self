import { request } from '../api.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// Add or edit (machine given) a Herdr connection. Saving always enables it.
// For type=local the SSH fields are hidden by the stylesheet (#machine-form / #machine-type) but still submitted.
export function MachineDialog({ machine, onClose, onSaved }) {
  const { values, field } = useFields({
    name: machine?.name || '',
    type: machine?.type || 'ssh',
    host: machine?.host || '',
    session: machine?.session || 'default',
    port: String(machine?.port || 22),
    binary: machine?.binary || '~/.local/bin/herdr',
  });

  async function save() {
    await request('/machines/save', { id: machine?.id, ...values, enabled: true });
    onSaved();
  }

  return (
    <FormDialog id="machine-form" eyebrow="MACHINE" title="添加 Herdr 连接" submitLabel="保存并连接" onSubmit={save} onClose={onClose}>
      <label>连接名称<input required placeholder="例如：cpu2" {...field('name')} /></label>
      <div className="form-grid">
        <label>连接方式
          <select id="machine-type" {...field('type')}><option value="ssh">SSH</option><option value="local">本机</option></select>
        </label>
        <label>Herdr Session<input required {...field('session')} /></label>
      </div>
      <div className="ssh-only">
        <div className="form-grid wide-first">
          <label>SSH 地址 / 别名<input placeholder="user@host 或 SSH config 别名" {...field('host')} /></label>
          <label>端口<input type="number" min="1" max="65535" {...field('port')} /></label>
        </div>
        <p className="fine">使用 Bridge 主机的 SSH 配置、密钥和 known_hosts。</p>
      </div>
      <label>Herdr 可执行文件<input required {...field('binary')} /></label>
    </FormDialog>
  );
}
