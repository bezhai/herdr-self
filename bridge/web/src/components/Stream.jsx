import { formatTime } from '../model.js';

// Event list; newest first is up to the caller.
export function Stream({ empty, children }) {
  return <div className="stream">{children.length ? children : <p className="stream-empty">{empty}</p>}</div>;
}

// level: a log level (info | error); errors are highlighted.
export function StreamRow({ level, at, title, children }) {
  return (
    <div className={level === 'error' ? 'log error' : 'log'}>
      <time>{formatTime(at)}</time>
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}
