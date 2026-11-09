import { useState } from 'react';

// Button for a card action: disabled while `run` is pending; a failure is passed to onError.
export function ActionButton({ className = 'secondary', run, onError, children }) {
  const [busy, setBusy] = useState(false);

  async function click() {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <button type="button" className={className} disabled={busy} onClick={click}>{children}</button>;
}
