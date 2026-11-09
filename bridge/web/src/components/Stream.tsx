import type { ReactNode } from 'react';
import type { Log } from '../../../state.ts';
import { formatTime } from '../model.ts';

// Event list; newest first is up to the caller.
export function Stream({ empty, children }: { empty: string, children: ReactNode[] }) {
  return <div className="stream">{children.length ? children : <p className="stream-empty">{empty}</p>}</div>;
}

// level: a log level (info | error); errors are highlighted.
export function StreamRow({ level, at, title, children }: { level: Log['level'], at: number, title: string, children: ReactNode }) {
  return (
    <div className={level === 'error' ? 'log error' : 'log'}>
      <time>{formatTime(at)}</time>
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}
