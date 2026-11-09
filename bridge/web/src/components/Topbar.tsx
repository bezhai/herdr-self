import { groupOf, pageInfo } from '../pages/pageInfo.ts';
import type { Page } from '../pages/pageInfo.ts';
import { Icon } from './Icon.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

export function Topbar({ page, onMenu }: { page: Page, onMenu: () => void }) {
  return (
    <header className="topbar">
      <button type="button" className="icon mobile" aria-label="打开导航" onClick={onMenu}><Icon name="menu" /></button>
      <div className="crumbs">{groupOf(page)}<span>/</span><strong>{pageInfo[page].title}</strong></div>
      <ThemeToggle />
    </header>
  );
}
