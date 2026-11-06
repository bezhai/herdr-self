import { request } from '../api.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// Add or edit (machine given) a machine: its name and the Herdr session its client works in. Saving always enables it.
// onSaved gets the saved machine ({ id, name, session }), so adding can go on to the token of its client.
export function MachineDialog({ machine, onClose, onSaved }) {
  const { values, field } = useFields({ name: machine?.name || '', session: machine?.session || 'default' });

  async function save() {
    const { id } = await request('/machines/save', { id: machine?.id, ...values, enabled: true });
    onSaved({ id, ...values });
  }

  return (
    <FormDialog title={machine ? '编辑机器' : '添加机器'} submitLabel={machine ? '保存并连接' : '下一步'} onSubmit={save} onClose={onClose}>
      <label>机器名称<input required placeholder="例如：cpu2" {...field('name')} /></label>
      <label>Herdr Session<input required {...field('session')} /></label>
    </FormDialog>
  );
}
