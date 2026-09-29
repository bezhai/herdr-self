import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { App } from './App.jsx';
import { assign } from './location.js';
import { bodyOf, callsTo, deferred, reply, sampleState, stubFetch } from './test/fixtures.js';

vi.mock('./location.js', () => ({ assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }));

// Advances fake timers and lets pending fetch promises and React updates settle.
const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const pageTitle = () => screen.getByRole('heading', { level: 1 }).textContent;
const card = (name) => screen.getByText(name).closest('article');
const nav = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

test('polls every 4s, skips ticks while a refresh is pending and recovers after a failure', async () => {
  vi.useFakeTimers();
  let next = () => reply(sampleState());
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
  expect(document.querySelector('.sidebar-footer .dot').classList.contains('bad')).toBe(true);

  next = () => reply(sampleState());
  await flush(4000);
  expect(callsTo(fetch, '/api/state')).toBe(3);
  expect(screen.getByText('Bridge 在线')).toBeTruthy();
  expect(document.querySelector('.sidebar-footer .dot').classList.contains('bad')).toBe(false);
});

test('an unauthenticated session shows the login page; a wrong key shows the error, a valid key opens the console', async () => {
  let authed = false;
  const fetch = stubFetch({
    '/api/state': () => (authed ? sampleState() : reply({ error: '请先登录' }, 401)),
    '/api/login': ({ key }) => {
      if (key !== 'right') return reply({ error: '访问密钥不正确' }, 401);
      authed = true;
      return { ok: true };
    },
  });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole('heading', { name: '登录管理台' })).toBeTruthy();

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
  await user.type(screen.getByLabelText('连接名称'), 'cpu9');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));

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
  expect(document.querySelector('.sidebar').classList.contains('open')).toBe(true);
  await user.click(nav('机器连接'));
  expect(document.querySelector('.sidebar').classList.contains('open')).toBe(false);
  expect(pageTitle()).toBe('机器连接');
  expect(document.querySelector('.crumbs strong').textContent).toBe('机器连接');
  expect(screen.getByText('MACHINES')).toBeTruthy();
  expect(screen.getByRole('button', { name: '+ 添加机器' })).toBeTruthy();

  await user.click(nav('会话绑定'));
  expect(pageTitle()).toBe('会话绑定');
  expect(screen.getByRole('button', { name: '+ 新建绑定' })).toBeTruthy();

  await user.click(nav('连接日志'));
  expect(pageTitle()).toBe('连接日志');
  expect(document.querySelector('.heading button')).toBeNull();
  expect(screen.getByText('cpu2 已连接')).toBeTruthy();
});

test('machine cards list Herdr agents with their status, mark agents without a session identity and offer no session actions', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^机器连接/ }));

  const cpu2 = card('cpu2');
  const [reviewer, codex, blocked] = cpu2.querySelectorAll('.agent-row');
  expect(within(reviewer).getByText('reviewer')).toBeTruthy();
  expect(within(reviewer).getByText('w1:p2 · /work')).toBeTruthy();
  expect(within(reviewer).getByText('运行中').classList.contains('warn')).toBe(true);
  expect(within(reviewer).queryByText('未识别会话')).toBeNull();
  expect(within(codex).getByText('codex')).toBeTruthy();
  expect(within(codex).getByText('空闲').classList.contains('neutral')).toBe(true);
  expect(within(codex).getByText('未识别会话')).toBeTruthy();
  expect(within(blocked).getByText('等待确认')).toBeTruthy();
  expect(cpu2.querySelector('.facts').textContent).toBe('3个终端3个 Agent');
  expect(within(cpu2).queryByRole('button', { name: '查看连接' })).toBeNull();
  expect(within(cpu2).queryByRole('button', { name: /适配器/ })).toBeNull();
  expect(within(card('cpu3')).getByText('ssh: connection refused')).toBeTruthy();
  expect(screen.getByText('Agent', { selector: '.metric span' }).nextElementSibling.textContent).toBe('3');
});

test('binding rows show the chat, the machine with the agent kind and working directory, and the status; the page holds only the routes table', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^会话绑定/ }));

  const row = screen.getByText('个人助手').closest('tr');
  expect(within(row).getByText('oc_1')).toBeTruthy();
  expect(within(row).getByText('cpu2')).toBeTruthy();
  expect(within(row).getByText('claude · ~/work')).toBeTruthy();
  expect(within(row).getByText('@机器人')).toBeTruthy();
  expect(within(row).getByText('可用')).toBeTruthy();
  expect([...document.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['来源', '目标', '触发方式', '状态', '操作']);
  expect(screen.queryByText('最近投递')).toBeNull();
});

test('each binding lists its topics newest first with state, pane and creation time, and shows why a topic failed', async () => {
  stubFetch({ '/api/state': sampleState() });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^会话绑定/ }));

  const topicsRow = document.querySelector('.topics-row');
  expect(topicsRow.previousElementSibling).toBe(screen.getByText('个人助手').closest('tr'));
  const [failed, ready] = topicsRow.querySelectorAll('.topic');
  expect(within(failed).getByText('升级依赖')).toBeTruthy();
  expect(within(failed).getByText('失败').classList.contains('error')).toBe(true);
  expect(within(failed).getByText('cpu2')).toBeTruthy();
  expect(within(failed).getByText('agent target pane w1:p6 is not an available shell')).toBeTruthy();
  expect(within(ready).getByText('修复登录页')).toBeTruthy();
  expect(within(ready).getByText('运行中').className).toBe('badge');
  expect(within(ready).getByText('cpu2 · w1:p5')).toBeTruthy();
  expect(ready.querySelector('time').getAttribute('datetime')).toBe('2026-09-28T01:02:00.000Z');
  expect(ready.querySelector('.topic-error')).toBeNull();
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
  expect(screen.getByLabelText('App ID').value).toBe('cli_spare');
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

  const verifyButton = within(card('工作助手')).getByRole('button', { name: '验证凭证' });
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
  state.registration = { id: 'r0', status: 'completed', appId: 'app-1' };
  const fetch = stubFetch({ '/api/state': () => state });
  const open = vi.spyOn(window, 'open').mockReturnValue({});
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
  state.registration = { id: 'r1', status: 'completed', appId: 'app-1' };
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
