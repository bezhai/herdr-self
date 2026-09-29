import { metrics } from '../model.js';

export function Metrics({ state }) {
  const m = metrics(state);
  return (
    <section className="metrics">
      <div className="metric"><span>机器在线</span><strong>{m.machinesOnline} <small>/ {m.machines}</small></strong></div>
      <div className="metric"><span>平台已连接</span><strong>{m.platformsConnected} <small>/ {m.platforms}</small></strong></div>
      <div className="metric"><span>会话绑定</span><strong>{m.bindings}</strong></div>
      <div className="metric"><span>Agent 已接入</span><strong>{m.agents}</strong></div>
    </section>
  );
}
