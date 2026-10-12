import { request } from '../api.js';
import { permissionModeOf, permissionModes } from '../model.js';
import { FormDialog, useFields } from './FormDialog.jsx';

// Select of a Claude binding's permission mode; each option says what the mode does. props: the select's value and onChange.
export function PermissionModeField(props) {
  return (
    <label>权限模式
      <select {...props}>
        {permissionModes.map((m) => <option key={m.id} value={m.id}>{`${m.id}：${m.note}`}</option>)}
      </select>
    </label>
  );
}

// Change the permission mode of a Claude binding. Topics already open keep the mode their agent started with.
export function PermissionModeDialog({ binding, onClose, onSaved }) {
  const { values, field } = useFields({ permissionMode: permissionModeOf(binding) });

  async function save() {
    await request('/bindings/permission-mode', { id: binding.id, permissionMode: values.permissionMode });
    onSaved();
  }

  return (
    <FormDialog title="修改权限模式" submitLabel="保存" onSubmit={save} onClose={onClose}>
      <PermissionModeField {...field('permissionMode')} />
    </FormDialog>
  );
}
