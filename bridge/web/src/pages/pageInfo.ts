import type { BridgeState } from '../useBridge.ts';

// Navigation, breadcrumb and heading copy for each console page. An empty action means no page button.
export const pageInfo = {
  platforms: { icon: 'chat', title: '平台连接', action: '+ 添加飞书' },
  machines: { icon: 'server', title: '机器连接', action: '+ 添加机器' },
  bindings: { icon: 'route', title: '会话绑定', action: '+ 新建绑定' },
  skills: { icon: 'skill', title: 'Skills', action: '+ 新建 skill' },
  logs: { icon: 'log', title: '连接日志', action: '' },
};

export type Page = keyof typeof pageInfo;

// What App passes to every page but the logs: the state, refresh() and toast(text).
export type PageProps = { state: BridgeState, refresh: () => Promise<void>, toast: (text: string) => void };
