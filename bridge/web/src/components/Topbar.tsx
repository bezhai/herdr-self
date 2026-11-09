import { Icon } from './Icon.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

export function Topbar({ title, onMenu }: { title: string, onMenu: () => void }) {
  return (
    <header className="topbar">
      <button type="button" className="icon mobile" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div className="crumbs">连接管理<span>/</span><strong>{title}</strong></div>
      <ThemeToggle />
    </header>
  );
}
