import { request } from '../api.js';
import { connectedMachines } from '../model.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// Herdr agent kinds a topic can start.
const kinds = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }];

// A select's effective value: the chosen option while it still exists, otherwise the first option.
const selected = (options, value) => (options.some((o) => o.id === value) ? value : options[0]?.id || '');

// Route a Feishu chat to a machine: each topic of the chat will start an agent of the chosen kind in the working directory.
// Every app is listed; only enabled, connected machines can be targets.
export function BindingDialog({ state, onClose, onSaved }) {
  const { values, field, checkbox } = useFields({
    name: '', appId: '', chatId: '', machineId: '', cwd: '', kind: 'claude', requireMention: true,
  });
  const machines = connectedMachines(state);
  const machineId = selected(machines, values.machineId);
  const appId = selected(state.apps, values.appId);

  async function save() {
    const { name, chatId, cwd, kind, requireMention } = values;
    await request('/bindings/save', { name, appId, machineId, chatId, cwd, kind, requireMention });
    onSaved();
  }

  return (
    <FormDialog eyebrow="ROUTE" title="连接聊天与会话" submitLabel="保存绑定" onSubmit={save} onClose={onClose}>
      <label>绑定名称<input required placeholder="例如：个人开发助手" {...field('name')} /></label>
      <fieldset>
        <legend>来源 · 飞书</legend>
        <label>飞书应用
          <select required {...field('appId')} value={appId}>
            {state.apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>Chat ID<input className="mono" required placeholder="oc_…" {...field('chatId')} /></label>
      </fieldset>
      <fieldset>
        <legend>目标 · Herdr</legend>
        <label>机器 / Herdr 实例
          <select required {...field('machineId')} value={machineId}>
            {machines.map((m) => <option key={m.id} value={m.id}>{`${m.name} / ${m.session}`}</option>)}
          </select>
        </label>
        <div className="form-grid wide-first">
          <label>工作目录<input className="mono" required placeholder="~/code/project" {...field('cwd')} /></label>
          <label>Agent 类型
            <select {...field('kind')}>
              {kinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </label>
        </div>
        <p className="fine">每个飞书话题会在 Herdr 中新开一个 tab，在该目录启动所选 Agent；这些 tab 都放在工作区「飞书 · 绑定名称」中。</p>
      </fieldset>
      <label className="checkbox"><input type="checkbox" {...checkbox('requireMention')} /><span>仅 @机器人时触发<small>私聊请取消</small></span></label>
    </FormDialog>
  );
}
