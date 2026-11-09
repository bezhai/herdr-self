import { useEffect } from 'react';

// A toast: its text, and an id that makes a toast of the same text new.
export type ToastMessage = { text: string, id: number };

// toast: { text, id } or null. A new toast replaces the current one and restarts the 6.5s timer.
export function Toast({ toast, onExpire }: { toast: ToastMessage | null, onExpire: () => void }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onExpire, 6500);
    return () => clearTimeout(timer);
  }, [toast, onExpire]);

  return <div className={toast ? 'toast' : 'toast hidden'} role="status">{toast?.text}</div>;
}
