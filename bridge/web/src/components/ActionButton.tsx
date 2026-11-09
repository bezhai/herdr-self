import { useState } from 'react';
import type { ReactNode } from 'react';

type ActionButtonProps = { className?: string, run: () => Promise<void>, onError: (message: string) => void, children: ReactNode };

// Button for a card action: disabled while `run` is pending; a failure is passed to onError.
export function ActionButton({ className = 'secondary', run, onError, children }: ActionButtonProps) {
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
