import { vi } from 'vitest';
import type { ConsoleState } from '../../../console-state.ts';
import themeScript from '../../public/theme.js?raw';

// Runs public/theme.js the way the pages' <head> does: as a classic script, before the app renders.
export const runThemeScript = () => new Function(themeScript)();

// Like a real response, every json() call yields a freshly parsed object.
export function reply(body: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) };
}

// Replaces global fetch. Each route is a response body, a reply(), or a function of the parsed request body.
// callApi always passes an init, with the JSON body of a POST.
export function stubFetch(routes: { [url: string]: unknown }) {
  const fetch = vi.fn<(url: string, init: { body?: string }) => Promise<unknown>>(async (url, init = {}) => {
    const route = routes[url];
    if (route === undefined) return reply({ error: '接口不存在' }, 404);
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    // as: each test writes what its routes read of the body and what they answer, a body or something with json() like a reply().
    const result = (typeof route === 'function' ? await route(body) : route) as { json?: unknown } | null | undefined;
    return typeof result?.json === 'function' ? result : reply(result);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

export function deferred() {
  let resolve!: (value: unknown) => void; // !: the executor below runs before the promise is returned.
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function bodyOf(fetch: ReturnType<typeof stubFetch>, url: string): unknown {
  const call = fetch.mock.calls.findLast(([called]) => called === url);
  return call && JSON.parse(call[1].body!); // !: the url was posted, with a body.
}

export const callsTo = (fetch: ReturnType<typeof stubFetch>, url: string) => fetch.mock.calls.filter(([called]) => called === url).length;

// Text as base64 of its UTF-8 bytes, like the files of a skill that /api/skills/read returns.
export const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

// as: partial where the console reads nothing. The apps have no hasSecret (nor the appSecret: undefined that JSON drops), the agents no
// workspace_id, tab_id or state_change_seq, and the topics no replySeq.
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
    // As the server derives them: Herdr is polled only through an online client, so any other machine is disabled or offline.
    machines: [
      {
        id: 'm-1', name: 'cpu2', session: 'default', enabled: true, hasToken: true, client: { state: 'online', host: 'cpu2-host', since: 1 },
        state: 'connected', checkedAt: 1, panes: [{}, {}, {}],
        agents: [
          { name: 'reviewer', agent: 'claude', pane_id: 'w1:p2', cwd: '/work', agent_status: 'working', agent_session: { value: 'session-claude' } },
          { agent: 'codex', pane_id: 'w1:p3', cwd: '/other', agent_status: 'idle' },
          { agent: 'codex', pane_id: 'w1:p4', cwd: '/srv', agent_status: 'blocked', agent_session: { value: 'session-codex' } },
        ],
      },
      {
        id: 'm-2', name: 'gpu1', session: 'work', enabled: true, hasToken: true, client: { state: 'online', host: 'gpu1-host', since: 1 },
        state: 'connected', checkedAt: 1, panes: [], agents: [],
      },
      { id: 'm-3', name: 'laptop', session: 'default', enabled: false, hasToken: false, client: { state: 'offline' }, state: 'disabled', panes: [], agents: [] },
      {
        id: 'm-4', name: 'cpu3', session: 'default', enabled: true, hasToken: true, client: { state: 'refused', error: '版本不一致：控制面协议 1，客户端协议 2' },
        state: 'offline', panes: [], agents: [],
      },
      {
        id: 'm-5', name: 'gpu2', session: 'default', enabled: true, hasToken: true, client: { state: 'online', host: 'gpu2-host', since: 1 },
        state: 'error', checkedAt: 1, error: 'herdr: session default not found', panes: [], agents: [],
      },
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
    // The index of the skills, without their files.
    skills: [
      { name: 'bridge-schedule', description: '在飞书话题里用定时任务做事时使用。', preload: true, digest: 'a'.repeat(64) },
      { name: 'deploy-notes', description: '部署前后要检查的事项。', preload: false, digest: 'b'.repeat(64) },
    ],
    logs: [{ at: 1, kind: '机器连接', message: 'cpu2 已连接', level: 'info' }],
  } as ConsoleState;
}
