import { useEffect } from 'react';

// toast: { text, id } or null. A new toast replaces the current one and restarts the 6.5s timer.
export function Toast({ toast, onExpire }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onExpire, 6500);
    return () => clearTimeout(timer);
  }, [toast, onExpire]);

  return <div className={toast ? 'toast' : 'toast hidden'} role="status">{toast?.text}</div>;
}
