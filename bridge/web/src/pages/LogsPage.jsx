import { Stream, StreamRow } from '../components/Stream.jsx';

export function LogsPage({ state }) {
  const logs = state.logs.slice().reverse();
  return (
    <section className="page">
      <div className="section-heading"><h2>连接与消息事件<span>events</span></h2></div>
      <Stream empty="暂无事件。">
        {logs.map((log, i) => (
          <StreamRow key={`${log.at}-${logs.length - i}`} level={log.level} at={log.at} title={log.kind}>{log.message}</StreamRow>
        ))}
      </Stream>
    </section>
  );
}
