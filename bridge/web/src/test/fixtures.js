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
  return {
    host: 'bridge-host',
    version: '0.1.0',
    registration: null,
    apps: [
      { id: 'app-1', name: '工作助手', appId: 'cli_work', domain: 'feishu', enabled: true, connection: 'connected', verifiedAt: 1, botName: 'WorkBot', allowedUsers: ['ou_1'], error: '' },
      { id: 'app-2', name: '备用应用', appId: 'cli_spare', domain: 'lark', enabled: false, connection: 'disabled', allowedUsers: [], error: '' },
    ],
    machines: [
      {
        id: 'm-1', name: 'cpu2', type: 'ssh', host: 'cpu2', port: 22, session: 'default', binary: '~/.local/bin/herdr',
        enabled: true, state: 'connected', adapterInstalled: true, panes: [{}, {}],
        agents: [{ name: 'claude', pane_id: 'w1:p2', cwd: '/work' }, { agent: 'codex', pane_id: 'w1:p3', cwd: '/other' }],
        adapters: [{ id: 'ad-1', paneId: 'w1:p2', nativeId: 'native-1234567890' }],
      },
      { id: 'm-2', name: 'gpu1', type: 'ssh', host: 'gpu1', port: 2222, session: 'work', binary: '~/.local/bin/herdr', enabled: true, state: 'connected', panes: [], agents: [], adapters: [] },
      { id: 'm-3', name: 'laptop', type: 'local', host: '', port: 22, session: 'default', binary: '~/.local/bin/herdr', enabled: false, state: 'disabled', panes: [], agents: [], adapters: [] },
      { id: 'm-4', name: 'cpu3', type: 'ssh', host: 'cpu3', port: 22, session: 'default', binary: '~/.local/bin/herdr', enabled: true, state: 'error', error: 'ssh: connection refused', panes: [], agents: [], adapters: [] },
    ],
    bindings: [
      { id: 'b-1', name: '个人助手', appId: 'app-1', machineId: 'm-1', adapterId: 'ad-1', nativeId: 'native-1234567890', paneId: 'w1:p2', chatId: 'oc_1', rootId: '', requireMention: true, replyInThread: true },
    ],
    logs: [{ at: 1, kind: '机器连接', message: 'cpu2 已连接', level: 'info' }],
    deliveries: [{ createdAt: 1, status: 'completed', messageId: 'om_1' }],
  };
}
