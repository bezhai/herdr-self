import { formatTime } from '../model.js';

// Event list; newest first is up to the caller.
export function Stream({ empty, children }) {
  return <div className="stream">{children.length ? children : <p className="stream-empty">{empty}</p>}</div>;
}

// tone: a log level (info | error) or a delivery tone (warn | neutral).
export function StreamRow({ tone, at, title, children }) {
  return (
    <div className={tone && tone !== 'neutral' ? `log ${tone}` : 'log'}>
      <time>{formatTime(at)}</time>
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}
