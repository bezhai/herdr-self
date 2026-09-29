import { useState } from 'react';
import { CloseButton, Dialog } from '../components/Dialog.jsx';

// Form state for a dialog. Dialogs are mounted on open, so every open starts from `initial`.
export function useFields(initial) {
  const [values, setValues] = useState(initial);
  const set = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  return {
    values,
    set,
    field: (key) => ({ value: values[key], onChange: (e) => set(key, e.target.value) }),
    checkbox: (key) => ({ checked: values[key], onChange: (e) => set(key, e.target.checked) }),
  };
}

// Dialog with a form. The primary button is disabled while onSubmit runs; a failure is shown inside the dialog.
// onSubmit resolves after the owner has handled success (usually: close and refresh).
export function FormDialog({ id, eyebrow, title, submitLabel, onSubmit, onClose, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose}>
      <form id={id} onSubmit={submit}>
        <div className="dialog-head"><span className="eyebrow">{eyebrow}</span><CloseButton onClick={onClose} /></div>
        <h2>{title}</h2>
        {children}
        <p className="error" role="alert">{error}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={busy}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}
