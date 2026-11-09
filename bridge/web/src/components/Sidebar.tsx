import { Fragment } from 'react';
import { pageGroups, pageInfo } from '../pages/pageInfo.ts';
import type { Page } from '../pages/pageInfo.ts';
import type { BridgeState } from '../useBridge.ts';
import { Icon } from './Icon.tsx';
import { Brand } from './Logo.tsx';

function NavButton({ page, current, count, onNavigate }: { page: Page, current: Page, count?: number, onNavigate: (page: Page) => void }) {
  const info = pageInfo[page];
  return (
    <button type="button" className={page === current ? 'nav-button active' : 'nav-button'} onClick={() => onNavigate(page)}>
      <Icon name={info.icon} />{info.title}{count !== undefined && <b>{count}</b>}
    </button>
  );
}

// The number beside each page's name; the logs have none.
const counts = (state: BridgeState): Partial<Record<Page, number>> => ({
  platforms: state.apps.length, machines: state.machines.length, bindings: state.bindings.length,
  projects: state.projects.length, agentConfigs: state.agentConfigs.length, skills: state.skills.length,
});

// online: null before the first refresh, then whether the last refresh succeeded.
type SidebarProps = { state: BridgeState, page: Page, online: boolean | null, open: boolean, onNavigate: (page: Page) => void, onLogout: () => void };
export function Sidebar({ state, page, online, open, onNavigate, onLogout }: SidebarProps) {
  const nav = { current: page, onNavigate };
  return (
    <aside className={open ? 'sidebar open' : 'sidebar'}>
      <Brand />
      <div className="host"><i className="dot" /><strong>{state.host}</strong><span>Bridge 主机</span></div>
      {pageGroups.map((group) => (
        <Fragment key={group.label}>
          <p className="nav-label">{group.label}</p>
          <nav>{group.pages.map((p) => <NavButton key={p} page={p} count={counts(state)[p]} {...nav} />)}</nav>
        </Fragment>
      ))}
      <div className="sidebar-footer">
        <span className="status">
          <i className={online === false ? 'dot bad' : 'dot'} />
          <span>{online === null ? '正在连接' : online ? 'Bridge 在线' : '连接中断'}</span>
        </span>
        <button type="button" className="ghost" title="退出登录" onClick={onLogout}><Icon name="exit" />退出</button>
      </div>
    </aside>
  );
}
