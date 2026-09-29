// Navigation, breadcrumb and heading copy for each console page. An empty action means no page button.
export const pageInfo = {
  platforms: {
    icon: 'chat', eyebrow: 'PLATFORMS', title: '平台连接', action: '+ 添加飞书',
    description: '飞书应用通过长连接接收聊天消息，并按会话绑定校验路由。',
  },
  machines: {
    icon: 'server', eyebrow: 'MACHINES', title: '机器连接', action: '+ 添加机器',
    description: 'Bridge 通过本机或 SSH 调用 Herdr，读取终端与 Agent。',
  },
  bindings: {
    icon: 'route', eyebrow: 'ROUTES', title: '会话绑定', action: '+ 新建绑定',
    description: '把飞书聊天路由到某台机器上的 Herdr。每个飞书话题在 Herdr 中新开一个 tab，启动一个 Agent 会话。',
  },
  logs: {
    icon: 'log', eyebrow: 'EVENTS', title: '连接日志', action: '',
    description: '连接、消息与错误事件，最新的在前。',
  },
};
