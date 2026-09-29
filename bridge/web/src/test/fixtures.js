import { vi } from 'vitest';

// Like a real response, every json() call yields a freshly parsed object.
export function reply(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) };
}

// Replaces global fetch. Each route is a response body, a reply(), or a function of the parsed request body.
export function stubFetch(routes) {
  const fetch = vi.fn(async (url, init = {}) => {
    const route = routes[url];
    if (route === undefined) return reply({ error: '接口不存在' }, 404);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const result = typeof route === 'function' ? await route(body) : route;
    return typeof result?.json === 'function' ? result : reply(result);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function bodyOf(fetch, url) {
  const call = fetch.mock.calls.findLast(([called]) => called === url);
  return call && JSON.parse(call[1].body);
}

export const callsTo = (fetch, url) => fetch.mock.calls.filter(([called]) => called === url).length;

export function sampleState() {
  const now = Date.now();
  return {
    host: 'bridge-host',
    version: '0.1.0',
    registration: null,
    apps: [
      {
        id: 'app-1', name: '工作助手', appId: 'cli_work', domain: 'feishu', enabled: true, connection: 'connected', verifiedAt: 1,
        avatar: { type: 'image/png', updatedAt: 1700000000000 }, allowedUsers: ['ou_1'], error: '',
      },
      { id: 'app-2', name: '备用应用', appId: 'cli_spare', domain: 'lark', enabled: false, connection: 'disabled', allowedUsers: [], error: '' },
    ],
    machines: [
      {
        id: 'm-1', name: 'cpu2', type: 'ssh', host: 'cpu2', port: 22, session: 'default', binary: '~/.local/bin/herdr',
        enabled: true, state: 'connected', checkedAt: 1, panes: [{}, {}, {}],
        agents: [
          { name: 'reviewer', agent: 'claude', pane_id: 'w1:p2', cwd: '/work', agent_status: 'working', agent_session: { value: 'session-claude' } },
          { agent: 'codex', pane_id: 'w1:p3', cwd: '/other', agent_status: 'idle' },
          { agent: 'codex', pane_id: 'w1:p4', cwd: '/srv', agent_status: 'blocked', agent_session: { value: 'session-codex' } },
        ],
      },
      { id: 'm-2', name: 'gpu1', type: 'ssh', host: 'gpu1', port: 2222, session: 'work', binary: '~/.local/bin/herdr', enabled: true, state: 'connected', checkedAt: 1, panes: [], agents: [] },
      { id: 'm-3', name: 'laptop', type: 'local', host: '', port: 22, session: 'default', binary: '~/.local/bin/herdr', enabled: false, state: 'disabled', panes: [], agents: [] },
      { id: 'm-4', name: 'cpu3', type: 'ssh', host: 'cpu3', port: 22, session: 'default', binary: '~/.local/bin/herdr', enabled: true, state: 'error', checkedAt: 1, error: 'ssh: connection refused', panes: [], agents: [] },
    ],
    bindings: [
      { id: 'b-1', name: '个人助手', appId: 'app-1', machineId: 'm-1', chatId: 'oc_1', cwd: '~/work', kind: 'claude', requireMention: true, enabled: true },
    ],
    pendingChats: [
      { token: 'tok-group', appId: 'app-1', chatId: 'oc_group', chatType: 'group', createdAt: now - 5 * 60000, expiresAt: now + 25 * 60000 },
      { token: 'tok-p2p', appId: 'app-1', chatId: 'oc_p2p', chatType: 'p2p', createdAt: now - 20 * 60000, expiresAt: now + 10 * 60000 },
    ],
    topics: [
      {
        id: 't-1', bindingId: 'b-1', appId: 'app-1', chatId: 'oc_1', rootId: 'om_1', machineId: 'm-1', workspaceId: 'w1', tabId: 'w1:t2',
        paneId: 'w1:p5', agentName: 'feishu-t1', title: '修复登录页', state: 'ready', error: '', createdAt: Date.UTC(2026, 8, 28, 1, 2),
      },
      {
        id: 't-2', bindingId: 'b-1', appId: 'app-1', chatId: 'oc_1', rootId: 'om_2', machineId: 'm-1', workspaceId: 'w1', tabId: '',
        paneId: '', agentName: 'feishu-t2', title: '升级依赖', state: 'failed', error: 'agent target pane w1:p6 is not an available shell',
        createdAt: Date.UTC(2026, 8, 29, 3, 4),
      },
    ],
    logs: [{ at: 1, kind: '机器连接', message: 'cpu2 已连接', level: 'info' }],
  };
}
