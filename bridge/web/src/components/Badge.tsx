import type { ReactNode } from 'react';
import { statusLabel, statusTone } from '../model.ts';
import type { Tone } from '../model.ts';

// tone: ok | warn | error | neutral (see statusTone).
export function Badge({ tone, children }: { tone: Tone, children: ReactNode }) {
  return <span className={tone === 'ok' ? 'badge' : `badge ${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}
