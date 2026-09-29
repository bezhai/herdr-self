import { useEffect, useState } from 'react';
import { CloseButton, Dialog } from '../components/Dialog.jsx';
import { registrationView } from '../model.js';

// Progress of the "add Feishu" flow running in the /connect window. Mounted on every open;
// previousId is the registration that existed before this open and is ignored until a new flow shows up.
// onRetry must open /connect synchronously in the click handler (popup blocking).
export function RegistrationDialog({ registration, apps, previousId, onRetry, onDone, onConfigure, onManual, onClose }) {
  const [opening, setOpening] = useState(true);
  const [scanning, setScanning] = useState(false);
  const view = registrationView(registration, apps, { opening, previousId, scanning });

  useEffect(() => {
    if (opening && !view.opening) setOpening(false);
  }, [opening, view.opening]);

  return (
    <Dialog open onClose={onClose} className="connect-dialog">
      <div className="dialog-body">
        <CloseButton className="icon dialog-close" onClick={onClose} />
        <div className="feishu-mark" aria-hidden="true"><svg><use href="#i-feishu" /></svg></div>
        <h2>{view.title}</h2>
        <p className="connect-subtitle">{view.subtitle}</p>
        <div className="connect-visual">
          {view.spinner && <span className="spinner" />}
          {view.result && <span className={view.result === 'success' ? 'result-icon success' : 'result-icon'}>{view.result === 'success' ? '✓' : '!'}</span>}
          {view.qr && <div className="qr"><img id="registration-qr" src={view.qr} alt="飞书扫码" width="220" height="220" /></div>}
        </div>
        <p className="connect-status" aria-live="polite">{view.message}</p>
        {view.link && <a className="primary connect-primary" href={view.link} target="_blank" rel="noopener noreferrer">前往飞书 ↗</a>}
        {view.retry && <button type="button" className="primary connect-primary" onClick={onRetry}>重试</button>}
        {view.done && <button type="button" className="primary connect-primary" onClick={onDone}>完成</button>}
        {view.configure && <button type="button" className="primary connect-primary" onClick={onConfigure}>查看应用</button>}
        <div className="connect-footer">
          {view.scan && <button type="button" className="text-button" onClick={() => setScanning((s) => !s)}>{view.scanLabel}</button>}
          {view.manual && <button type="button" className="text-button" onClick={onManual}>手动接入</button>}
        </div>
      </div>
    </Dialog>
  );
}
