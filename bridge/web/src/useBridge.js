import { useCallback, useEffect, useRef, useState } from 'react';
import { onUnauthorized, request } from './api.js';

const emptyState = { host: '', registration: null, machines: [], apps: [], bindings: [], pendingChats: [], topics: [], logs: [] };

// Polls /api/state every 4s, and every 1.2s while fastPoll is set. A refresh that starts while
// another is in flight is skipped. online: null until the first result, then whether the last refresh succeeded.
// authed: null until known; false after any 401.
export function useBridge({ fastPoll = false } = {}) {
  const [state, setState] = useState(emptyState);
  const [online, setOnline] = useState(null);
  const [authed, setAuthed] = useState(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setState(await request('/state'));
      setAuthed(true);
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => onUnauthorized(() => setAuthed(false)), []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!fastPoll) return undefined;
    const timer = setInterval(refresh, 1200);
    return () => clearInterval(timer);
  }, [fastPoll, refresh]);

  return { state, online, authed, refresh };
}
