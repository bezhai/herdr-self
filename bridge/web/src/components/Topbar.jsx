import { Icon } from './Icon.jsx';

export function Topbar({ title, onMenu }) {
  return (
    <header className="topbar">
      <button type="button" className="icon mobile" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div className="crumbs">连接管理<span>/</span><strong>{title}</strong></div>
      <span className="topbar-meta">自动同步 · 4s</span>
    </header>
  );
}
