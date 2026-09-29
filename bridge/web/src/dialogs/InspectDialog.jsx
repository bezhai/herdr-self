import { useCallback, useEffect, useState } from 'react';
import { request } from '../api.js';
import { CloseButton, Dialog } from '../components/Dialog.jsx';
import { formatTime, statusLabel } from '../model.js';

const messageId = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function Approval({ permission: p, disabled, onVerdict }) {
  return (
    <div className="approval">
      <strong>{`${p.tool_name} · ${p.request_id}`}</strong>
      <pre>{p.input_preview}</pre>
      {p.status === 'pending' ? (
        <>
          <button type="button" className="secondary" disabled={disabled} onClick={() => onVerdict(p.request_id, 'deny')}>拒绝</button>
          <button type="button" className="primary" disabled={disabled} onClick={() => onVerdict(p.request_id, 'allow')}>允许这一次</button>
        </>
      ) : <p className="fine">已提交，等待 Claude 处理</p>}
    </div>
  );
}

// Transcript, approvals and a test message for one attached native session.
// target: { machineId, adapterId }. Reloads on open and on every state refresh (a new `state` object).
export function InspectDialog({ target, state, toast, onClose }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [approving, setApproving] = useState(false);

  const load = useCallback(async () => {
    try {
      setSession(await request('/adapters/inspect', target));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [target]);

  useEffect(() => { load(); }, [load, state]);

  // Commands are pinned to the native session identity shown in the dialog.
  const pinned = session && { ...target, nativeId: session.nativeId, paneId: session.paneId };

  async function send(event) {
    event.preventDefault();
    try {
      await request('/adapters/message', { target: pinned, id: messageId(), text });
      setText('');
      await load();
    } catch (e) {
      toast(e.message);
    }
  }

  async function verdict(requestId, behavior) {
    setApproving(true);
    try {
      await request('/adapters/permission', { target: pinned, requestId, behavior });
      await load();
    } catch (e) {
      toast(e.message);
    } finally {
      setApproving(false);
    }
  }

  const messages = (session?.events || []).filter((e) => e.kind === 'user' || e.kind === 'reply').slice(-15);
  return (
    <Dialog open onClose={onClose} className="wide">
      <div className="dialog-body">
        <div className="dialog-head"><span className="eyebrow">AGENT SESSION</span><CloseButton onClick={onClose} /></div>
        <h2>{session ? `Claude · ${session.paneId}` : 'Agent 会话'}</h2>
        <p className="fine mono">{error || (session && `${statusLabel(session.status)} · ${session.nativeId}`)}</p>
        <div className="transcript">
          {messages.length
            ? messages.map((e, i) => (
              <div key={`${e.at}-${i}`} className={`inspect-message ${e.kind}`}>
                <strong>{`${e.kind === 'user' ? '你' : 'Claude'} · ${formatTime(e.at)}`}</strong>
                {e.data.text}
              </div>
            ))
            : <p className="fine">该会话尚无 Bridge 消息。可发送一条消息验证连通性。</p>}
        </div>
        <div>
          {(session?.permissions || []).map((p) => <Approval key={p.request_id} permission={p} disabled={approving} onVerdict={verdict} />)}
        </div>
        <form className="composer" onSubmit={send}>
          <label htmlFor="inspect-text">连通性对话</label>
          <div className="composer-row">
            <textarea id="inspect-text" rows="2" required placeholder="向这个原生会话发送一条消息" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="primary" disabled={session?.status !== 'ready'}>发送</button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
