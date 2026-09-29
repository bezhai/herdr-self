import { request } from '../api.js';
import { connectedMachines } from '../model.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// A select's effective value: the chosen option while it still exists, otherwise the first option.
const selected = (options, value) => (options.some((o) => o.id === value) ? value : options[0]?.id || '');

// Route a Feishu chat (or thread) to one attached native session. Every app is listed;
// only enabled, connected machines can be targets.
export function BindingDialog({ state, onClose, onSaved }) {
  const { values, field, checkbox } = useFields({
    name: '', appId: '', chatId: '', rootId: '', machineId: '', adapterId: '', requireMention: true, replyInThread: true,
  });
  const machines = connectedMachines(state);
  const machineId = selected(machines, values.machineId);
  const adapters = machines.find((m) => m.id === machineId)?.adapters || [];
  const appId = selected(state.apps, values.appId);
  const adapterId = selected(adapters, values.adapterId);

  async function save() {
    const { name, chatId, rootId, requireMention, replyInThread } = values;
    await request('/bindings/save', { name, appId, machineId, adapterId, chatId, rootId, requireMention, replyInThread });
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
        <div className="form-grid">
          <label>Chat ID<input className="mono" required placeholder="oc_…" {...field('chatId')} /></label>
          <label>话题根消息 ID<input className="mono" placeholder="可选，om_…" {...field('rootId')} /></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>目标 · Herdr</legend>
        <label>机器 / Herdr 实例
          <select required {...field('machineId')} value={machineId}>
            {machines.map((m) => <option key={m.id} value={m.id}>{`${m.name} / ${m.session}`}</option>)}
          </select>
        </label>
        <label>已接入的 Claude 会话
          <select className="mono" required {...field('adapterId')} value={adapterId}>
            {adapters.map((a) => <option key={a.id} value={a.id}>{`${a.paneId} · ${a.nativeId?.slice(0, 8) || '启动中'}`}</option>)}
          </select>
        </label>
        <p className="fine">
          {adapters.length
            ? '绑定固定的原生会话身份；会话变化后需要重新绑定。'
            : '暂无已接入会话。先在机器连接页安装适配器，再在 Herdr pane 中运行启动命令。'}
        </p>
      </fieldset>
      <label className="checkbox"><input type="checkbox" {...checkbox('requireMention')} /><span>仅 @机器人时触发<small>私聊请取消</small></span></label>
      <label className="checkbox"><input type="checkbox" {...checkbox('replyInThread')} /><span>在话题中回复</span></label>
    </FormDialog>
  );
}
