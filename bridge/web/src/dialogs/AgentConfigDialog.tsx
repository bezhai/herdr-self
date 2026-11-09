import type { ChangeEvent } from 'react';
import type { ConsoleMachine } from '../../../console-state.ts';
import type { AgentConfig, Kind } from '../../../state.ts';
import { request } from '../api.ts';
import { agentKinds, configName, permissionModes } from '../model.ts';
import { FormDialog, useFields } from './FormDialog.tsx';

// Create an agent configuration (none given) or edit one. The machine is what selects the model environment. The name starts as the machine,
// the kind and the model, and follows them for as long as it is still that. Only Claude has a permission mode and a limit on the commands it
// may run (one program name per line); the other kinds leave both out.
export function AgentConfigDialog({ config, machines, onClose, onSaved }: { config?: AgentConfig, machines: ConsoleMachine[], onClose: () => void, onSaved: () => void }) {
  const machineId = config?.machineId || machines[0]?.id || '';
  const kind = config?.kind || 'claude';
  const model = config?.model || '';
  const nameFor = (v: { machineId: string, kind: string, model: string }) => configName(machines.find((m) => m.id === v.machineId), v.kind as Kind, v.model.trim());
  const { values, set, field } = useFields({
    name: config?.name || nameFor({ machineId, kind, model }),
    machineId,
    kind,
    model,
    permissionMode: config?.permissionMode || 'default',
    allowedCommands: config?.allowedCommands?.join('\n') || '',
  });

  // The field that the name follows: a change also renames the configuration while its name is still the one its fields gave.
  const following = (key: 'machineId' | 'kind' | 'model') => ({
    value: values[key],
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      if (values.name === nameFor(values)) set('name', nameFor({ ...values, [key]: e.target.value }));
      set(key, e.target.value);
    },
  });

  async function save() {
    const model = values.model.trim();
    const claude = values.kind === 'claude' && { permissionMode: values.permissionMode, allowedCommands: values.allowedCommands.split(/[\s,]+/).filter(Boolean) };
    await request('/agent-configs/save', { id: config?.id, name: values.name, machineId: values.machineId, kind: values.kind, ...(model && { model }), ...claude });
    onSaved();
  }

  return (
    <FormDialog title={config ? '编辑 Agent 配置' : '新建 Agent 配置'} submitLabel="保存" onSubmit={save} onClose={onClose}>
      <label>配置名称<input required {...field('name')} /></label>
      <div className="form-grid">
        <label>机器
          <select required {...following('machineId')}>
            {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>Agent 类型
          <select {...following('kind')}>
            {agentKinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
      </div>
      <label>模型<input className="mono" placeholder="例如：sonnet" {...following('model')} /></label>
      {values.kind === 'claude' && (
        <>
          <label>权限模式
            <select {...field('permissionMode')}>
              {permissionModes.map((m) => <option key={m.id} value={m.id}>{`${m.id}：${m.note}`}</option>)}
            </select>
          </label>
          <label>只允许执行的命令<textarea className="mono" rows={2} spellCheck="false" placeholder="每行一个，例如：butler" {...field('allowedCommands')} /></label>
        </>
      )}
    </FormDialog>
  );
}
