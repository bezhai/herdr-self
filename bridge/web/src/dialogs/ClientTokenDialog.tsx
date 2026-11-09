import { useState } from 'react';
import type { ConsoleMachine } from '../../../console-state.ts';
import { request } from '../api.ts';
import { CloseButton, Dialog } from '../components/Dialog.tsx';
import { FormDialog } from './FormDialog.tsx';
import type { SavedMachine } from './MachineDialog.tsx';

// Generate the token of a machine's client, which replaces any token it had and drops the client using that one. Bridge keeps only a
// hash, so the config with the token is shown once, right after; onIssued refreshes the machines. A machine just added has no token yet.
type ClientTokenDialogProps = { machine: SavedMachine & Partial<Pick<ConsoleMachine, 'hasToken'>>, onClose: () => void, onIssued: () => void };
export function ClientTokenDialog({ machine, onClose, onIssued }: ClientTokenDialogProps) {
  const [config, setConfig] = useState('');
  const again = machine.hasToken;

  async function issue() {
    const result = await request<{ config: string }>('/machines/token', { id: machine.id });
    setConfig(result.config);
    onIssued();
  }

  if (!config) {
    return (
      <FormDialog title={again ? '重新生成客户端 token' : '生成客户端 token'} submitLabel={again ? '重新生成' : '生成'} onSubmit={issue} onClose={onClose}>
        {again && <p className="dialog-note">旧 token 立即失效，正在用它连接的客户端会断开。</p>}
      </FormDialog>
    );
  }
  return (
    <Dialog open onClose={onClose}>
      <div className="dialog-body">
        <div className="dialog-head"><h2>{`${machine.name} 的客户端配置`}</h2><CloseButton onClick={onClose} /></div>
        <label>客户端配置<textarea className="mono" readOnly rows={4} value={config} /></label>
        <p className="dialog-note">只显示这一次。保存为那台机器上的 ~/.config/herdr-bridge/client.json，权限 600。</p>
      </div>
    </Dialog>
  );
}
