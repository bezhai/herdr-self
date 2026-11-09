import { Stream, StreamRow } from '../components/Stream.tsx';
import type { BridgeState } from '../useBridge.ts';

export function LogsPage({ state }: { state: BridgeState }) {
  const logs = state.logs.slice().reverse();
  return (
    <section className="page">
      <div className="section-heading"><h2>连接与消息事件</h2></div>
      <Stream empty="暂无事件">
        {logs.map((log, i) => (
          <StreamRow key={`${log.at}-${logs.length - i}`} level={log.level} at={log.at} title={log.kind}>{log.message}</StreamRow>
        ))}
      </Stream>
    </section>
  );
}
