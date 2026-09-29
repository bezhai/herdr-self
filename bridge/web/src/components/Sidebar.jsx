import { pageInfo } from '../pages/pageInfo.js';
import { Icon } from './Icon.jsx';
import { Brand } from './Logo.jsx';

function NavButton({ page, current, count, onNavigate }) {
  const info = pageInfo[page];
  return (
    <button type="button" className={page === current ? 'nav-button active' : 'nav-button'} onClick={() => onNavigate(page)}>
      <Icon name={info.icon} />{info.title}{count !== undefined && <b>{count}</b>}
    </button>
  );
}

// online: null before the first refresh, then whether the last refresh succeeded.
export function Sidebar({ state, page, online, open, onNavigate, onLogout }) {
  const nav = { current: page, onNavigate };
  return (
    <aside className={open ? 'sidebar open' : 'sidebar'}>
      <Brand />
      <div className="host"><i className="dot" /><strong>{state.host}</strong><span>Bridge 主机</span></div>
      <p className="nav-label">连接管理</p>
      <nav>
        <NavButton page="platforms" count={state.apps.length} {...nav} />
        <NavButton page="machines" count={state.machines.length} {...nav} />
        <NavButton page="bindings" count={state.bindings.length} {...nav} />
      </nav>
      <p className="nav-label">运行情况</p>
      <nav>
        <NavButton page="logs" {...nav} />
      </nav>
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
