import type { ConsoleBinding, ConsoleProject } from '../../../console-state.ts';
import type { AgentConfig } from '../../../state.ts';
import { request } from '../api.ts';
import { FormDialog, useFields } from './FormDialog.tsx';

// Change the defaults of a binding: the project (a group's; a direct chat gets the one that fits each task), the agent configuration and,
// in a group, whether the bot answers only when mentioned. The name is the chat's in Feishu and follows it, so it is only shown. Topics
// that are already open keep the project and configuration they started with.
export function BindingDialog({ binding, projects, agentConfigs, onClose, onSaved }: {
  binding: ConsoleBinding, projects: ConsoleProject[], agentConfigs: AgentConfig[], onClose: () => void, onSaved: () => void,
}) {
  const group = binding.chatType === 'group';
  const { values, field, checkbox } = useFields({
    defaultProjectId: binding.defaultProjectId || projects[0]?.id || '',
    defaultAgentConfigId: binding.defaultAgentConfigId,
    requireMention: binding.requireMention,
  });

  async function save() {
    const { defaultProjectId, defaultAgentConfigId, requireMention } = values;
    await request('/bindings/save', { id: binding.id, defaultAgentConfigId, ...(group && { defaultProjectId, requireMention }) });
    onSaved();
  }

  return (
    <FormDialog title="编辑会话绑定" submitLabel="保存" onSubmit={save} onClose={onClose}>
      <label>名称<input readOnly value={binding.name} /></label>
      {group
        ? (
          <label>默认项目
            <select required {...field('defaultProjectId')}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )
        : <label>默认项目<input readOnly value="按任务自动选择" /></label>}
      <label>默认 Agent 配置
        <select required {...field('defaultAgentConfigId')}>
          {agentConfigs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {group && <label className="checkbox"><input type="checkbox" {...checkbox('requireMention')} /><span>需要 @ 机器人</span></label>}
    </FormDialog>
  );
}
