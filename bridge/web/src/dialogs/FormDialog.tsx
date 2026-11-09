import { useState } from 'react';
import type { ChangeEvent, ReactNode, SubmitEvent } from 'react';
import { CloseButton, Dialog } from '../components/Dialog.tsx';

// The keys of T whose values are of type V, and the elements whose text a field holds.
type KeysOf<T, V> = { [K in keyof T]: T[K] extends V ? K : never }[keyof T];
type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// Form state for a dialog. Dialogs are mounted on open, so every open starts from `initial`.
// A field holds the text of an input, select or textarea, or whether a checkbox is checked.
export function useFields<T extends { [key: string]: string | boolean }>(initial: T) {
  const [values, setValues] = useState(initial);
  const set = (key: keyof T, value: string | boolean) => setValues((current) => ({ ...current, [key]: value }));
  return {
    values,
    set,
    field: (key: KeysOf<T, string>) => ({ value: values[key], onChange: (e: ChangeEvent<FieldElement>) => set(key, e.target.value) }),
    checkbox: (key: KeysOf<T, boolean>) => ({ checked: values[key], onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.checked) }),
  };
}

// Dialog with a form. The primary button is disabled while onSubmit runs; a failure is shown inside the dialog.
// onSubmit resolves after the owner has handled success (usually: close and refresh). className goes to the dialog, for its width.
type FormDialogProps = { title: string, submitLabel: string, onSubmit: () => Promise<void>, onClose: () => void, className?: string, children: ReactNode };
export function FormDialog({ title, submitLabel, onSubmit, onClose, className, children }: FormDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
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
    <Dialog open className={className} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-head"><h2>{title}</h2><CloseButton onClick={onClose} /></div>
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
