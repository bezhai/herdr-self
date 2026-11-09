import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ConsoleState, HerdrStatus } from '../../console-state.ts';
import type { Machine, Skill } from '../../state.ts';
import { App } from './App.tsx';
import { assign } from './location.ts';
import { base64, bodyOf, callsTo, deferred, reply, sampleState, stubFetch } from './test/fixtures.ts';

// Navigation is replaced; reading and clearing the query string run against jsdom's real history.
vi.mock('./location.ts', async (importOriginal) => ({ ...(await importOriginal()), assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }));

afterEach(() => window.history.replaceState(null, '', '/'));

// Advances fake timers and lets pending fetch promises and React updates settle.
const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const pageTitle = () => screen.getByRole('heading', { level: 1 }).textContent;
// In these tests, ! after a DOM query marks an element that the test has just rendered; the open dialog is one too, except where a test
// expects none and checks that with toBeNull.
const card = (name: string) => screen.getByText(name).closest('article')!;
const nav = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const dialog = () => document.querySelector('dialog')!;
const avatar = '/api/apps/avatar?id=app-1&v=1700000000000';

test('polls every 4s, skips ticks while a refresh is pending and recovers after a failure', async () => {
  vi.useFakeTimers();
  let next: () => unknown = () => reply(sampleState());
  const fetch = stubFetch({ '/api/state': () => next() });
  render(<App />);
  await flush();
  expect(callsTo(fetch, '/api/state')).toBe(1);
  expect(screen.getByText('Bridge 在线')).toBeTruthy();

  const slow = deferred();
  next = () => slow.promise;
  await flush(4000);
  expect(callsTo(fetch, '/api/state')).toBe(2);
  await flush(8000);
  expect(callsTo(fetch, '/api/state')).toBe(2);

  slow.resolve(reply({ error: '请求失败' }, 500));
  await flush();
  expect(screen.getByText('连接中断')).toBeTruthy();
  expect(document.querySelector('.sidebar-footer .dot')!.classList.contains('bad')).toBe(true);

  next = () => reply(sampleState());
  await flush(4000);
  expect(callsTo(fetch, '/api/state')).toBe(3);
  expect(screen.getByText('Bridge 在线')).toBeTruthy();
  expect(document.querySelector('.sidebar-footer .dot')!.classList.contains('bad')).toBe(false);
});

test('an unauthenticated session shows the login page; a wrong key shows the error, a valid key opens the console', async () => {
  let authed = false;
  const fetch = stubFetch({
    '/api/state': () => (authed ? sampleState() : reply({ error: '请先登录' }, 401)),
    '/api/login': ({ key }: { key: string }) => {
      if (key !== 'right') return reply({ error: '访问密钥不正确' }, 401);
      authed = true;
      return { ok: true };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole('heading', { name: '登录管理台' })).toBeTruthy();
  // The panel holds the title and the form; the illustration holds only the route.
  expect([...document.querySelector('.login-body')!.children].map((el) => el.tagName)).toEqual(['H1', 'FORM']);
  expect([...document.querySelector('.login-visual')!.children].map((el) => el.className)).toEqual(['route']);

  await user.type(screen.getByLabelText('访问密钥'), 'wrong');
  await user.click(screen.getByRole('button', { name: '进入管理台' }));
  expect(await screen.findByText('访问密钥不正确')).toBeTruthy();
  expect(bodyOf(fetch, '/api/login')).toEqual({ key: 'wrong' });

  await user.clear(screen.getByLabelText('访问密钥'));
  await user.type(screen.getByLabelText('访问密钥'), 'right');
  await user.click(screen.getByRole('button', { name: '进入管理台' }));
  expect(await screen.findByRole('heading', { level: 1, name: '平台连接' })).toBeTruthy();
  expect(screen.getByText('bridge-host')).toBeTruthy();
});

test('a 401 from any request closes open dialogs and shows the login page', async () => {
  let authed = true;
  stubFetch({
    '/api/state': () => (authed ? sampleState() : reply({ error: '请先登录' }, 401)),
    '/api/machines/save': () => {
      authed = false;
      return reply({ error: '请先登录' }, 401);
    },
    '/api/login': () => {
      authed = true;
      return { ok: true };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));
  await user.click(screen.getByRole('button', { name: '+ 添加机器' }));
  await user.type(screen.getByLabelText('机器名称'), 'cpu9');
  await user.click(screen.getByRole('button', { name: '下一步' }));

  expect(await screen.findByRole('heading', { name: '登录管理台' })).toBeTruthy();
  expect(document.querySelector('dialog')).toBeNull();

  await user.type(screen.getByLabelText('访问密钥'), 'key');
  await user.click(screen.getByRole('button', { name: '进入管理台' }));
  expect(await screen.findByRole('heading', { level: 1, name: '机器连接' })).toBeTruthy();
  expect(document.querySelector('dialog')).toBeNull();
});

test('navigation switches the title, breadcrumb and page action, and closes the mobile sidebar', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole('button', { name: '+ 添加飞书' })).toBeTruthy();
  expect(pageTitle()).toBe('平台连接');

  await user.click(screen.getByRole('button', { name: '打开导航' }));
  expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(true);
  await user.click(nav('机器连接'));
  expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(false);
  expect(pageTitle()).toBe('机器连接');
  expect(document.querySelector('.crumbs strong')!.textContent).toBe('机器连接');
  expect(screen.getByRole('button', { name: '+ 添加机器' })).toBeTruthy();

  await user.click(nav('会话绑定'));
  expect(pageTitle()).toBe('会话绑定');
  expect(document.querySelector('.heading button')).toBeNull();

  await user.click(nav('项目'));
  expect(pageTitle()).toBe('项目');
  expect(nav('项目').querySelector('b')!.textContent).toBe('2');
  expect(screen.getByRole('button', { name: '+ 新建项目' })).toBeTruthy();

  await user.click(nav('Agent 配置'));
  expect(pageTitle()).toBe('Agent 配置');
  expect(nav('Agent 配置').querySelector('b')!.textContent).toBe('2');
  expect(screen.getByRole('button', { name: '+ 新建 Agent 配置' })).toBeTruthy();

  await user.click(nav('Skills'));
  expect(pageTitle()).toBe('Skills');
  expect(nav('Skills').querySelector('b')!.textContent).toBe('2');
  expect(screen.getByRole('button', { name: '+ 新建 skill' })).toBeTruthy();

  await user.click(nav('连接日志'));
  expect(pageTitle()).toBe('连接日志');
  expect(document.querySelector('.heading button')).toBeNull();
  expect(screen.getByText('cpu2 已连接')).toBeTruthy();
});

test('the sidebar groups the pages into connections, work configuration and what is running', async () => {
  stubFetch({ '/api/state': sampleState() });
  render(<App />);
  await screen.findByRole('button', { name: '+ 添加飞书' });
  const groups = [...document.querySelectorAll('.sidebar .nav-label')].map((label) => [label.textContent, [...label.nextElementSibling!.querySelectorAll('button')].map((b) => b.textContent)]);
  expect(groups).toEqual([
    ['连接管理', ['平台连接2', '机器连接5', '会话绑定1']],
    ['工作配置', ['项目2', 'Agent 配置2', 'Skills2']],
    ['运行情况', ['连接日志']],
  ]);
});

test('the breadcrumb names the sidebar group of the page', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: '+ 添加飞书' });
  const crumbs = () => document.querySelector('.topbar .crumbs')!.textContent;
  for (const [button, crumb] of [['项目2', '工作配置/项目'], ['Skills2', '工作配置/Skills'], ['连接日志', '运行情况/连接日志'], ['会话绑定1', '连接管理/会话绑定']]) {
    await user.click(within(document.querySelector<HTMLElement>('.sidebar')!).getByRole('button', { name: button }));
    expect(crumbs()).toBe(crumb);
  }
});

test('the topbar ends with the theme button', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: '+ 添加飞书' });
  const topbar = document.querySelector<HTMLElement>('.topbar')!;
  expect(topbar.lastElementChild).toBe(within(topbar).getByRole('button', { name: '主题：跟随系统' }));
  expect(topbar.textContent).toBe('连接管理/平台连接');
  await user.click(topbar.lastElementChild!);
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
});

test('page and section headings hold only their titles and the page action', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: '+ 添加飞书' });
  const headings = () => [document.querySelector('.heading')!.textContent, document.querySelector('.section-heading')!.textContent];
  expect(headings()).toEqual(['平台连接+ 添加飞书', '平台应用']);
  await user.click(nav('机器连接'));
  expect(headings()).toEqual(['机器连接+ 添加机器', 'Herdr 实例']);
  await user.click(nav('会话绑定'));
  expect(headings()).toEqual(['会话绑定', '消息路由']);
  await user.click(nav('项目'));
  expect(headings()).toEqual(['项目+ 新建项目', '项目列表']);
  await user.click(nav('Agent 配置'));
  expect(headings()).toEqual(['Agent 配置+ 新建 Agent 配置', 'Agent 配置列表']);
  await user.click(nav('Skills'));
  expect(headings()).toEqual(['Skills+ 新建 skill', 'Agent 的 skill']);
  await user.click(nav('连接日志'));
  expect(headings()).toEqual(['连接日志', '连接与消息事件']);
});

test('empty pages show only a short status', async () => {
  const state = { ...sampleState(), apps: [], machines: [], projects: [], agentConfigs: [], bindings: [], topics: [], skills: [], logs: [] };
  stubFetch({ '/api/state': state });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: '+ 添加飞书' });
  expect(document.querySelector('.empty-state')!.textContent).toBe('暂无飞书应用');
  await user.click(nav('机器连接'));
  expect(document.querySelector('.empty-state')!.textContent).toBe('暂无机器');
  await user.click(nav('会话绑定'));
  expect(document.querySelector('.table-empty')!.textContent).toBe('暂无会话绑定');
  await user.click(nav('项目'));
  expect(document.querySelector('.empty-state')!.textContent).toBe('暂无项目');
  await user.click(nav('Agent 配置'));
  expect(document.querySelector('.empty-state')!.textContent).toBe('暂无 Agent 配置');
  await user.click(nav('Skills'));
  expect(document.querySelector('.empty-state')!.textContent).toBe('暂无 skill');
  await user.click(nav('连接日志'));
  expect(document.querySelector('.stream-empty')!.textContent).toBe('暂无事件');
});

test('machine cards list Herdr agents with their status, mark agents without a session identity and offer no session actions', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));

  const cpu2 = card('cpu2');
  const [reviewer, codex, blocked] = cpu2.querySelectorAll<HTMLElement>('.agent-row');
  expect(within(reviewer).getByText('reviewer')).toBeTruthy();
  expect(within(reviewer).getByText('w1:p2 · /work')).toBeTruthy();
  expect(within(reviewer).getByText('运行中').classList.contains('warn')).toBe(true);
  expect(within(reviewer).queryByText('未识别会话')).toBeNull();
  expect(within(codex).getByText('codex')).toBeTruthy();
  expect(within(codex).getByText('空闲').classList.contains('neutral')).toBe(true);
  expect(within(codex).getByText('未识别会话')).toBeTruthy();
  expect(within(blocked).getByText('等待确认')).toBeTruthy();
  expect(cpu2.querySelector('.facts')!.textContent).toBe('3个终端3个 Agentcpu2-host上的客户端');
  expect(within(cpu2).queryByRole('button', { name: '查看连接' })).toBeNull();
  expect(within(cpu2).queryByRole('button', { name: /适配器/ })).toBeNull();
  expect(screen.getByText('Agent', { selector: '.metric span' }).nextElementSibling!.textContent).toBe('3');
});

test('machine cards show the Herdr session and the status Bridge polls through the client, with no connection type or address', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));

  const names = ['cpu2', 'gpu1', 'laptop', 'cpu3', 'gpu2'];
  expect(names.map((name) => card(name).querySelector('.card-title p')!.textContent)).toEqual([
    'session default', 'session work', 'session default', 'session default', 'session default',
  ]);
  expect(names.map((name) => card(name).querySelector('.card-icon use')!.getAttribute('href'))).toEqual(names.map(() => '#i-server'));
  expect(within(card('cpu2')).getByText('已连接').className).toBe('badge');
  expect(within(card('laptop')).getByText('已停用').classList.contains('neutral')).toBe(true);
  // A refused client leaves Herdr offline: the refusal is the only error on the card.
  const cpu3 = card('cpu3');
  expect(within(cpu3).getByText('离线').classList.contains('neutral')).toBe(true);
  expect([...cpu3.querySelectorAll('.card-error')].map((e) => e.textContent)).toEqual(['版本不一致：控制面协议 1，客户端协议 2']);
  // An online client whose Herdr poll failed shows the failure.
  const gpu2 = card('gpu2');
  expect(within(gpu2).getByText('连接失败').classList.contains('error')).toBe(true);
  expect(within(gpu2).getByText('客户端在线')).toBeTruthy();
  expect(within(gpu2).getByText('herdr: session default not found').className).toBe('card-error');
  expect(screen.getByText('机器在线', { selector: '.metric span' }).nextElementSibling!.textContent).toBe('3 / 5');
});

test('connecting or refreshing a machine reports whether Herdr connected, the client is still awaited, or the poll failed', async () => {
  const results: { [id: string]: HerdrStatus } = { 'm-1': { state: 'connected', agents: [], panes: [] }, 'm-3': { state: 'offline', agents: [], panes: [] }, 'm-5': { state: 'error', error: 'herdr: session default not found', agents: [], panes: [] } };
  const fetch = stubFetch({ '/api/state': sampleState(), '/api/machines/connect': ({ id }: Pick<Machine, 'id'>) => results[id] });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));
  const toast = () => screen.getByRole('status').textContent;

  await user.click(within(card('laptop')).getByRole('button', { name: '连接' }));
  expect(bodyOf(fetch, '/api/machines/connect')).toEqual({ id: 'm-3' });
  await waitFor(() => expect(toast()).toBe('机器已启用，等待客户端连接'));
  await user.click(within(card('cpu2')).getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(toast()).toBe('机器已连接'));
  await user.click(within(card('gpu2')).getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(toast()).toBe('连接未成功，查看错误信息'));
});

test('adding a machine saves its name and session, then goes straight on to generating the token of its client', async () => {
  const state = sampleState();
  const config = '{\n  "url": "ws://bridge-host:8080/api/client",\n  "token": "secret"\n}\n';
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/machines/save': ({ name, session, enabled }: Pick<Machine, 'name' | 'session' | 'enabled'>) => {
      state.machines.push({ id: 'm-6', name, session, enabled, hasToken: false, client: { state: 'offline' }, state: 'offline', panes: [], agents: [] });
      return { id: 'm-6' };
    },
    '/api/machines/token': () => {
      state.machines[5] = { ...state.machines[5], hasToken: true };
      return { config };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));
  await user.click(screen.getByRole('button', { name: '+ 添加机器' }));
  await user.type(screen.getByLabelText('机器名称'), 'cpu9');
  const before = callsTo(fetch, '/api/state');
  await user.click(screen.getByRole('button', { name: '下一步' }));

  expect(await screen.findByRole('heading', { name: '生成客户端 token' })).toBeTruthy();
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(bodyOf(fetch, '/api/machines/save')).toEqual({ name: 'cpu9', session: 'default', enabled: true });
  await waitFor(() => expect(callsTo(fetch, '/api/state')).toBe(before + 1));
  expect(within(card('cpu9')).getByText('离线')).toBeTruthy();
  expect(within(card('cpu9')).getByText('客户端离线')).toBeTruthy();

  await user.click(within(dialog()).getByRole('button', { name: '生成' }));
  expect((await screen.findByLabelText<HTMLTextAreaElement>('客户端配置')).value).toBe(config);
  expect(bodyOf(fetch, '/api/machines/token')).toEqual({ id: 'm-6' });
  expect(document.querySelector('.dialog-head')!.textContent).toBe('cpu9 的客户端配置');
  await waitFor(() => expect(within(card('cpu9')).getByRole('button', { name: '重新生成 token' })).toBeTruthy());
});

test('editing a disabled machine saves it by its id, closes the dialog and fetches the machines again', async () => {
  const state = sampleState();
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/machines/save': ({ id, name, session, enabled }: Pick<Machine, 'id' | 'name' | 'session' | 'enabled'>) => {
      state.machines[2] = { ...state.machines[2], name, session, enabled, state: 'offline' };
      return { id };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));
  await user.click(within(card('laptop')).getByRole('button', { name: '编辑' }));
  expect(screen.getByRole('heading', { name: '编辑机器' })).toBeTruthy();
  await user.clear(screen.getByLabelText('机器名称'));
  await user.type(screen.getByLabelText('机器名称'), 'laptop2');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));

  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/machines/save')).toEqual({ id: 'm-3', name: 'laptop2', session: 'default', enabled: true });
  await waitFor(() => expect(within(card('laptop2')).getByText('离线')).toBeTruthy());
});

test('machine cards show the connection of their client, online with its host, refused with the reason or offline, and generate its token; a new token comes after a warning, and the machines are fetched again', async () => {
  const state = sampleState();
  const config = '{\n  "url": "ws://bridge-host:8080/api/client",\n  "token": "secret"\n}\n';
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/machines/token': () => {
      state.machines[0] = { ...state.machines[0], client: { state: 'offline' }, state: 'offline', panes: [], agents: [] };
      return { config };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));
  const cpu2 = card('cpu2');
  expect(within(cpu2).getByText('客户端在线').className).toBe('badge');
  expect(within(cpu2.querySelector<HTMLElement>('.facts')!).getByText('cpu2-host').tagName).toBe('B');
  expect(within(card('gpu1')).getByText('客户端在线')).toBeTruthy();
  expect(card('gpu1').querySelector('.facts')!.textContent).toBe('0个终端0个 Agentgpu1-host上的客户端');
  expect(within(card('laptop')).getByText('客户端离线').classList.contains('neutral')).toBe(true);
  expect(card('laptop').querySelector('.facts')!.textContent).toBe('0个终端0个 Agent');
  const cpu3 = card('cpu3');
  expect(within(cpu3).getByText('客户端被拒绝').classList.contains('error')).toBe(true);
  expect(within(cpu3).getByText('版本不一致：控制面协议 1，客户端协议 2').className).toBe('card-error');
  expect(within(card('laptop')).getByRole('button', { name: '生成 token' })).toBeTruthy();
  expect(within(card('gpu1')).getByRole('button', { name: '重新生成 token' })).toBeTruthy();
  expect(within(cpu3).getByRole('button', { name: '重新生成 token' })).toBeTruthy();

  await user.click(within(cpu2).getByRole('button', { name: '重新生成 token' }));
  expect(screen.getByRole('heading', { name: '重新生成客户端 token' })).toBeTruthy();
  const before = callsTo(fetch, '/api/state');
  await user.click(screen.getByRole('button', { name: '重新生成' }));
  expect((await screen.findByLabelText<HTMLTextAreaElement>('客户端配置')).value).toBe(config);
  expect(bodyOf(fetch, '/api/machines/token')).toEqual({ id: 'm-1' });
  await waitFor(() => expect(within(card('cpu2')).getByText('客户端离线')).toBeTruthy());
  expect(within(card('cpu2')).getByText('离线')).toBeTruthy();
  expect(callsTo(fetch, '/api/state')).toBe(before + 1);
  await user.click(within(dialog()).getByRole('button', { name: '关闭' }));
  expect(dialog()).toBeNull();
});

test('binding rows show the chat, its default project and agent configuration, and the status; a direct chat has its project chosen per task; the page holds only the bindings table', async () => {
  const state = sampleState();
  const [group] = state.bindings;
  state.bindings.push({ id: 'b-2', name: '私聊', appId: 'app-1', chatId: 'oc_2', chatType: 'p2p', requireMention: false, enabled: true, defaultAgentConfigId: 'c-2' });
  stubFetch({ '/api/state': () => state });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^会话绑定/ }));

  const row = screen.getByText(group.name).closest('tr')!;
  expect(within(row).getByText('群聊 · oc_1')).toBeTruthy();
  expect(within(row).getByText('工作助手')).toBeTruthy();
  expect(row.querySelector('img')!.getAttribute('src')).toBe(avatar);
  expect(within(row).getByText('genvi')).toBeTruthy();
  expect(within(row).getByText('cpu2 · Claude')).toBeTruthy();
  expect(within(row).getByText('@机器人')).toBeTruthy();
  expect(within(row).getByText('可用')).toBeTruthy();
  const direct = screen.getByText('私聊').closest('tr')!;
  expect(within(direct).getByText('私聊 · oc_2')).toBeTruthy();
  expect(within(direct).getByText('按任务自动选择')).toBeTruthy();
  expect(within(direct).getByText('cpu2 · Codex')).toBeTruthy();
  expect(within(direct).getByText('全部消息')).toBeTruthy();
  expect([...document.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['来源', '默认项目', '默认 Agent 配置', '触发方式', '状态', '操作']);
  expect(screen.queryByText('最近投递')).toBeNull();
});

test('editing a binding changes its defaults by its id, closes the form and fetches the bindings again', async () => {
  const state = sampleState();
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/bindings/save': ({ id, defaultProjectId, defaultAgentConfigId }: { id: string, defaultProjectId: string, defaultAgentConfigId: string }) => {
      state.bindings = state.bindings.map((b) => (b.id === id ? { ...b, defaultProjectId, defaultAgentConfigId } : b));
      return { ok: true };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^会话绑定/ }));
  await user.click(within(screen.getByText('个人助手').closest('tr')!).getByRole('button', { name: '编辑' }));
  expect(within(dialog()).getByRole('heading', { name: '编辑会话绑定' })).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('默认项目'), 'test');
  const before = callsTo(fetch, '/api/state');
  await user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/bindings/save')).toEqual({ id: 'b-1', defaultProjectId: 'p-2', defaultAgentConfigId: 'c-1', requireMention: true });
  await waitFor(() => expect(callsTo(fetch, '/api/state')).toBe(before + 1));
  expect(within(screen.getByText('个人助手').closest('tr')!).getByText('test')).toBeTruthy();
});

test('project cards show the name, how the topics share the directory, the description and what the project holds; they are created, edited and deleted from the page', async () => {
  const state = sampleState();
  state.projects[0].skills = ['deploy-notes'];
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/projects/save': (body: ConsoleState['projects'][number]) => {
      if (body.id) state.projects = state.projects.map((p) => (p.id === body.id ? { ...p, ...body } : p));
      else state.projects.push({ ...body, id: 'p-9', adopted: false });
      return { id: body.id || 'p-9' };
    },
    '/api/projects/remove': ({ id }: { id: string }) => {
      if (id === 'p-1') return reply({ error: '请先修改使用该项目的会话绑定' }, 400);
      state.projects = state.projects.filter((p) => p.id !== id);
      return { ok: true };
    },
  });
  const projectCard = (name: string) => screen.getByText(name, { selector: 'strong' }).closest('article')!;
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^项目/ }));

  const genvi = projectCard('genvi');
  expect(genvi.querySelector('.card-icon use')!.getAttribute('href')).toBe('#i-folder');
  expect(within(genvi).getByText('每个话题独立')).toBeTruthy();
  expect(within(genvi).getByText('增长相关的服务')).toBeTruthy();
  expect(within(genvi).getByText('个仓库').querySelector('b')!.textContent).toBe('1');
  expect(within(genvi).getByText('个 skill').querySelector('b')!.textContent).toBe('1');
  expect(within(projectCard('test')).getByText('所有话题共用')).toBeTruthy();
  expect(within(projectCard('test')).getByText('个仓库').querySelector('b')!.textContent).toBe('0');

  await user.click(screen.getByRole('button', { name: '+ 新建项目' }));
  await user.type(screen.getByLabelText('项目名称'), 'promoter');
  const before = callsTo(fetch, '/api/state');
  await user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/projects/save')).toMatchObject({ name: 'promoter', workMode: 'isolated' });
  await waitFor(() => expect(callsTo(fetch, '/api/state')).toBe(before + 1));
  expect(within(projectCard('promoter')).getByText('每个话题独立')).toBeTruthy();

  await user.click(within(projectCard('test')).getByRole('button', { name: '编辑' }));
  expect(within(dialog()).getByRole('heading', { name: '编辑项目' })).toBeTruthy();
  await user.type(screen.getByLabelText('描述'), '测试用');
  await user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/projects/save')).toMatchObject({ id: 'p-2', description: '测试用' });
  expect(await screen.findByText('测试用')).toBeTruthy();

  await user.click(within(projectCard('genvi')).getByRole('button', { name: '删除' }));
  expect(bodyOf(fetch, '/api/projects/remove')).toEqual({ id: 'p-1' });
  expect((await screen.findByRole('status')).textContent).toBe('请先修改使用该项目的会话绑定');
  expect(projectCard('genvi')).toBeTruthy();
  await user.click(within(projectCard('promoter')).getByRole('button', { name: '删除' }));
  expect(bodyOf(fetch, '/api/projects/remove')).toEqual({ id: 'p-9' });
  await waitFor(() => expect(screen.queryByText('promoter')).toBeNull());
});

test('agent configuration cards show the machine, type, model and permission mode, and the commands a configuration is limited to; they are created, edited and deleted from the page', async () => {
  const state = sampleState();
  state.agentConfigs[0].model = 'Seed';
  state.agentConfigs[0].allowedCommands = ['butler'];
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/agent-configs/save': (body: ConsoleState['agentConfigs'][number]) => {
      if (body.id) state.agentConfigs = state.agentConfigs.map((c) => (c.id === body.id ? { ...c, ...body } : c));
      else state.agentConfigs.push({ ...body, id: 'c-9' });
      return { id: body.id || 'c-9' };
    },
    '/api/agent-configs/remove': ({ id }: { id: string }) => {
      if (id === 'c-1') return reply({ error: '请先修改使用该 Agent 配置的会话绑定' }, 400);
      state.agentConfigs = state.agentConfigs.filter((c) => c.id !== id);
      return { ok: true };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^Agent 配置/ }));

  const claude = card('cpu2 · Claude');
  expect(claude.querySelector('.card-icon use')!.getAttribute('href')).toBe('#i-terminal');
  expect([...claude.querySelectorAll('.card-title p span')].map((s) => s.textContent)).toEqual(['cpu2', 'Claude', 'Seed']);
  expect(within(claude).getByText('default')).toBeTruthy();
  expect(within(claude).getByText('只允许执行的命令')).toBeTruthy();
  expect(within(claude).getByText('butler')).toBeTruthy();
  const codex = card('cpu2 · Codex');
  expect(codex.querySelector('.card-title p')).toBeNull(); // Its name already says machine and kind.
  expect(codex.querySelector('.badge')).toBeNull();
  expect(within(codex).queryByText('只允许执行的命令')).toBeNull();

  await user.click(screen.getByRole('button', { name: '+ 新建 Agent 配置' }));
  await user.selectOptions(screen.getByLabelText('机器'), 'gpu1');
  const before = callsTo(fetch, '/api/state');
  await user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/agent-configs/save')).toEqual({ name: 'gpu1 · Claude', machineId: 'm-2', kind: 'claude', permissionMode: 'default', allowedCommands: [] });
  await waitFor(() => expect(callsTo(fetch, '/api/state')).toBe(before + 1));
  expect(card('gpu1 · Claude')).toBeTruthy();

  await user.click(within(card('cpu2 · Codex')).getByRole('button', { name: '编辑' }));
  expect(within(dialog()).getByRole('heading', { name: '编辑 Agent 配置' })).toBeTruthy();
  await user.type(screen.getByLabelText('模型'), 'gpt-5');
  await user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/agent-configs/save')).toEqual({ id: 'c-2', name: 'cpu2 · Codex · gpt-5', machineId: 'm-1', kind: 'codex', model: 'gpt-5' });

  await user.click(within(card('cpu2 · Claude')).getByRole('button', { name: '删除' }));
  expect(bodyOf(fetch, '/api/agent-configs/remove')).toEqual({ id: 'c-1' });
  expect((await screen.findByRole('status')).textContent).toBe('请先修改使用该 Agent 配置的会话绑定');
  await user.click(within(card('gpu1 · Claude')).getByRole('button', { name: '删除' }));
  expect(bodyOf(fetch, '/api/agent-configs/remove')).toEqual({ id: 'c-9' });
  await waitFor(() => expect(screen.queryByText('gpu1 · Claude')).toBeNull());
});

test('each binding lists its topics newest first with state, pane and creation time, and shows why a topic failed', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^会话绑定/ }));

  const topicsRow = document.querySelector('.topics-row')!;
  expect(topicsRow.previousElementSibling).toBe(screen.getByText('个人助手').closest('tr'));
  const [failed, ready] = topicsRow.querySelectorAll<HTMLElement>('.topic');
  expect(within(failed).getByText('升级依赖')).toBeTruthy();
  expect(within(failed).getByText('失败').classList.contains('error')).toBe(true);
  expect(within(failed).getByText('cpu2')).toBeTruthy();
  expect(within(failed).getByText('agent target pane w1:p6 is not an available shell')).toBeTruthy();
  expect(within(ready).getByText('修复登录页')).toBeTruthy();
  expect(within(ready).getByText('运行中').className).toBe('badge');
  expect(within(ready).getByText('cpu2 · w1:p5')).toBeTruthy();
  expect(ready.querySelector('time')!.getAttribute('datetime')).toBe('2026-09-28T01:02:00.000Z');
  expect(ready.querySelector('.topic-error')).toBeNull();
});

test('skill cards show the name, the description and whether the skill is loaded by default or read on demand; the card switches between the two, only a skill read on demand can be removed, and editing reads the skill before its form opens', async () => {
  const state = sampleState();
  const text = '---\nname: deploy-notes\ndescription: 部署前后要检查的事项。\n---\n先看 CI。\n';
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/skills/preload': ({ name, preload }: Pick<Skill, 'name' | 'preload'>) => {
      state.skills = state.skills.map((s) => (s.name === name ? { ...s, preload } : s));
      return { ok: true };
    },
    '/api/skills/remove': ({ name }: Pick<Skill, 'name'>) => {
      state.skills = state.skills.filter((s) => s.name !== name);
      return { ok: true };
    },
    '/api/skills/read?name=deploy-notes': { ...state.skills[1], files: { 'SKILL.md': base64(text), 'scripts/check.sh': base64('echo\n') } },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^Skills/ }));
  const toast = () => screen.getByRole('status').textContent;

  const schedule = card('bridge-schedule');
  expect(schedule.querySelector('.card-icon use')!.getAttribute('href')).toBe('#i-skill');
  expect(within(schedule).getByText('在飞书话题里用定时任务做事时使用。')).toBeTruthy();
  expect(within(schedule).getByText('默认加载').className).toBe('badge');
  expect(within(schedule).getByRole('button', { name: '设为按需读取' })).toBeTruthy();
  expect(within(schedule).queryByRole('button', { name: '删除' })).toBeNull();
  const notes = card('deploy-notes');
  expect(within(notes).getByText('按需读取').classList.contains('neutral')).toBe(true);
  expect(within(notes).getByRole('button', { name: '删除' })).toBeTruthy();

  await user.click(within(notes).getByRole('button', { name: '设为默认加载' }));
  expect(bodyOf(fetch, '/api/skills/preload')).toEqual({ name: 'deploy-notes', preload: true });
  await waitFor(() => expect(within(card('deploy-notes')).getByText('默认加载')).toBeTruthy());
  expect(toast()).toBe('deploy-notes 已设为默认加载');
  await user.click(within(card('bridge-schedule')).getByRole('button', { name: '设为按需读取' }));
  expect(bodyOf(fetch, '/api/skills/preload')).toEqual({ name: 'bridge-schedule', preload: false });
  await waitFor(() => expect(toast()).toBe('bridge-schedule 已设为按需读取'));
  await user.click(await within(card('bridge-schedule')).findByRole('button', { name: '删除' }));
  expect(bodyOf(fetch, '/api/skills/remove')).toEqual({ name: 'bridge-schedule' });
  await waitFor(() => expect(screen.queryByText('bridge-schedule')).toBeNull());

  await user.click(within(card('deploy-notes')).getByRole('button', { name: '编辑' }));
  expect(await screen.findByRole('heading', { name: '编辑 deploy-notes' })).toBeTruthy();
  expect(screen.getByLabelText<HTMLTextAreaElement>('SKILL.md').value).toBe(text);
  expect(within(dialog()).getByText('scripts/check.sh')).toBeTruthy();
});

test('adding a skill saves it as a new one, closes the form and fetches the skills again', async () => {
  const state = sampleState();
  const fetch = stubFetch({
    '/api/state': () => state,
    '/api/skills/save': ({ name }: Pick<Skill, 'name'>) => {
      state.skills = [...state.skills, { name, description: '新的', preload: false, digest: 'c'.repeat(64) }];
      return { ok: true };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^Skills/ }));
  await user.click(screen.getByRole('button', { name: '+ 新建 skill' }));
  expect(within(dialog()).getByRole('heading', { name: '新建 skill' })).toBeTruthy();
  await user.type(screen.getByLabelText('skill 名称'), 'release-check');
  const before = callsTo(fetch, '/api/state');
  await user.click(within(dialog()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(bodyOf(fetch, '/api/skills/save')).toEqual({ name: 'release-check', text: '---\nname: \ndescription: \n---\n', create: true });
  await waitFor(() => expect(callsTo(fetch, '/api/state')).toBe(before + 1));
  expect(within(card('release-check')).getByText('新的')).toBeTruthy();
});

test('only disabled apps and machines offer configure/edit and remove', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText('工作助手');

  const enabledApp = card('工作助手');
  expect(within(enabledApp).getByRole('button', { name: '停用' })).toBeTruthy();
  expect(within(enabledApp).queryByRole('button', { name: '配置' })).toBeNull();
  expect(within(enabledApp).queryByRole('button', { name: '移除' })).toBeNull();
  const disabledApp = card('备用应用');
  expect(within(disabledApp).getByRole('button', { name: '启用连接' })).toBeTruthy();
  expect(within(disabledApp).getByRole('button', { name: '移除' })).toBeTruthy();

  await user.click(within(disabledApp).getByRole('button', { name: '配置' }));
  expect(screen.getByRole('heading', { name: '应用配置' })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>('App ID').value).toBe('cli_spare');
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(document.querySelector('dialog')).toBeNull();

  await user.click(nav('机器连接'));
  expect(within(card('cpu2')).queryByRole('button', { name: '编辑' })).toBeNull();
  expect(within(card('cpu2')).getByRole('button', { name: '断开' })).toBeTruthy();
  expect(within(card('laptop')).getByRole('button', { name: '编辑' })).toBeTruthy();
  expect(within(card('laptop')).getByRole('button', { name: '移除' })).toBeTruthy();
  expect(within(card('laptop')).getByRole('button', { name: '连接' })).toBeTruthy();
});

test('card actions disable their button while pending; a new toast replaces the old one and hides after 6.5s', async () => {
  vi.useFakeTimers();
  const verify = deferred();
  const fetch = stubFetch({
    '/api/state': sampleState(),
    '/api/apps/test': () => verify.promise,
    '/api/apps/toggle': reply({ error: '连接失败：凭证无效' }, 400),
  });
  render(<App />);
  await flush();

  const verifyButton = within(card('工作助手')).getByRole<HTMLButtonElement>('button', { name: '验证凭证' });
  fireEvent.click(verifyButton);
  await flush();
  expect(verifyButton.disabled).toBe(true);
  verify.resolve(reply({ ok: true }));
  await flush();
  expect(verifyButton.disabled).toBe(false);
  expect(bodyOf(fetch, '/api/apps/test')).toEqual({ id: 'app-1' });
  const toast = screen.getByRole('status');
  expect(toast.textContent).toBe('应用凭证验证通过');
  expect(toast.classList.contains('hidden')).toBe(false);

  await flush(3000);
  fireEvent.click(within(card('工作助手')).getByRole('button', { name: '停用' }));
  await flush();
  expect(bodyOf(fetch, '/api/apps/toggle')).toEqual({ id: 'app-1', enabled: false });
  expect(toast.textContent).toBe('连接失败：凭证无效');

  await flush(6000);
  expect(toast.classList.contains('hidden')).toBe(false);
  await flush(500);
  expect(toast.classList.contains('hidden')).toBe(true);
});

test('adding Feishu opens /connect synchronously in the click and falls back to same-tab navigation when the popup is blocked', async () => {
  vi.useFakeTimers();
  stubFetch({ '/api/state': sampleState() });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<App />);
  await flush();

  fireEvent.click(screen.getByRole('button', { name: '+ 添加飞书' }));
  expect(open).toHaveBeenCalledWith('/connect', '_blank');
  expect(assign).toHaveBeenCalledWith('/connect');
});

test('the registration dialog polls every 1.2s while open and finishes on the platforms page', async () => {
  vi.useFakeTimers();
  const state = sampleState();
  // as: the registrations here hold only what the dialog reads.
  state.registration = { id: 'r0', status: 'completed', appId: 'app-1' } as ConsoleState['registration'];
  const fetch = stubFetch({ '/api/state': () => state });
  const open = vi.spyOn(window, 'open').mockReturnValue({} as Window); // as: the window that opened, which App only tests for.
  render(<App />);
  await flush();

  fireEvent.click(screen.getByRole('button', { name: '+ 添加飞书' }));
  expect(open).toHaveBeenCalledWith('/connect', '_blank');
  expect(assign).not.toHaveBeenCalled();
  await flush();
  // The finished flow from before the click is not shown as the new result.
  expect(screen.getByText('正在打开飞书…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '完成' })).toBeNull();

  const before = callsTo(fetch, '/api/state');
  state.registration = { id: 'r1', status: 'completed', appId: 'app-1' } as ConsoleState['registration'];
  await flush(1200);
  expect(callsTo(fetch, '/api/state')).toBe(before + 1);
  expect(screen.getByRole('heading', { name: '飞书已连接' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await flush();
  expect(document.querySelector('dialog')).toBeNull();
  expect(pageTitle()).toBe('平台连接');
  const closed = callsTo(fetch, '/api/state');
  await flush(1200);
  expect(callsTo(fetch, '/api/state')).toBe(closed);
});

test('app cards show the bot avatar synced from Feishu, fall back to the Feishu icon and no longer repeat a bot name', async () => {
  stubFetch({ '/api/state': sampleState() });
  render(<App />);
  await screen.findByText('工作助手');
  expect(card('工作助手').querySelector('.card-icon img')!.getAttribute('src')).toBe(avatar);
  expect(card('备用应用').querySelector('.card-icon img')).toBeNull();
  expect(card('备用应用').querySelector('.card-icon use')!.getAttribute('href')).toBe('#i-feishu');
  expect(card('工作助手').querySelector('.card-detail > span')!.textContent).toBe('凭证已验证');
});

