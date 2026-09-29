import { request } from '../api.js';
import { AppAvatar } from '../components/AppAvatar.jsx';
import { chatTypeLabel, connectedMachines } from '../model.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// Herdr agent kinds a topic can start.
const kinds = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }];

// A select's effective value: the chosen option while it still exists, otherwise the first option.
const selected = (options, value) => (options.some((o) => o.id === value) ? value : options[0]?.id || '');

// Route the pending chat that asked for a binding to a machine: each topic of the chat will start an agent of the chosen kind
// in the working directory. The chat is fixed by its link token; only enabled, connected machines can be targets.
// Mentions matter only in groups: a direct chat always triggers.
export function BindingDialog({ state, chat, onClose, onSaved }) {
  const group = chat.chatType === 'group';
  const { values, field, checkbox } = useFields({
    name: `飞书${chatTypeLabel(chat.chatType)}`, machineId: '', cwd: '', kind: 'claude', requireMention: true,
  });
  const machines = connectedMachines(state);
  const machineId = selected(machines, values.machineId);
  const app = state.apps.find((a) => a.id === chat.appId);

  async function save() {
    const { name, cwd, kind, requireMention } = values;
    await request('/bindings/save', { token: chat.token, name, machineId, cwd, kind, requireMention: group && requireMention });
    onSaved();
  }

  return (
    <FormDialog eyebrow="ROUTE" title="连接聊天与会话" submitLabel="保存绑定" onSubmit={save} onClose={onClose}>
      <label>绑定名称<input required placeholder="例如：个人开发助手" {...field('name')} /></label>
      <fieldset>
        <legend>来源 · 飞书</legend>
        <div className="chat-source">
          <span className="chat-avatar"><AppAvatar app={app} /></span>
          <span className="chat-main">
            <strong>{app?.name}</strong>
            <code>{chat.chatId}</code>
          </span>
          <span className="chat-meta"><small>{chatTypeLabel(chat.chatType)}</small></span>
        </div>
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
      {group && <label className="checkbox"><input type="checkbox" {...checkbox('requireMention')} /><span>仅 @机器人时触发</span></label>}
    </FormDialog>
  );
}
