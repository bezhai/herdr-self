import { statusLabel, statusTone } from '../model.js';

// tone: ok | warn | error | neutral (see statusTone).
export function Badge({ tone, children }) {
  return <span className={tone === 'ok' ? 'badge' : `badge ${tone}`}>{children}</span>;
}

export function StatusBadge({ status }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}
