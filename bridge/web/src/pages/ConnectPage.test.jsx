import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { replace } from '../location.js';
import { bodyOf, callsTo, reply, stubFetch } from '../test/fixtures.js';
import { ConnectPage } from './ConnectPage.jsx';

vi.mock('../location.js', () => ({ assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }));

const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const failure = () => screen.getByRole('heading', { name: '未能打开飞书' });

test('polls once a second and redirects to an allowed Feishu URL once the registration is pending', async () => {
  vi.useFakeTimers();
  const url = 'https://open.feishu.cn/page/launcher?user_code=x';
  const fetch = stubFetch({
    '/api/apps/registration/start': { id: 'r1', status: 'starting' },
    '/api/state': { registration: { id: 'r1', status: 'pending', url } },
  });
  render(<ConnectPage />);
  await flush();
  expect(screen.getByRole('heading', { name: '正在打开飞书' })).toBeTruthy();
  expect(bodyOf(fetch, '/api/apps/registration/start')).toEqual({});
  expect(replace).not.toHaveBeenCalled();
  await flush(999);
  expect(callsTo(fetch, '/api/state')).toBe(0);
  await flush(1);
  expect(replace).toHaveBeenCalledWith(url);
});

test('refuses to redirect outside the Feishu hosts or without https', async () => {
  for (const url of ['https://attacker.example/x', 'http://open.feishu.cn/x', 'https://open.feishu.cn.attacker.example/x']) {
    stubFetch({ '/api/apps/registration/start': { id: 'r1', status: 'pending', url } });
    const view = render(<ConnectPage />);
    expect(await screen.findByText('创建链接不可用')).toBeTruthy();
    expect(failure()).toBeTruthy();
    view.unmount();
  }
  expect(replace).not.toHaveBeenCalled();
});

test('a 401 returns to the console before the response is parsed', async () => {
  const json = vi.fn(async () => ({}));
  stubFetch({ '/api/apps/registration/start': { status: 401, ok: false, json } });
  render(<ConnectPage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  expect(json).not.toHaveBeenCalled();
});

test('other request failures show a generic message; retry starts the flow again', async () => {
  let fail = true;
  stubFetch({
    '/api/apps/registration/start': () => (fail ? reply({ error: 'internal detail' }, 400) : { id: 'r2', status: 'pending', url: 'https://open.larksuite.com/x' }),
  });
  const user = userEvent.setup();
  render(<ConnectPage />);
  expect(await screen.findByText('暂时无法打开飞书')).toBeTruthy();
  expect(failure()).toBeTruthy();
  expect(screen.queryByText('internal detail')).toBeNull();
  expect(screen.getByRole('link', { name: '返回管理台' }).getAttribute('href')).toBe('/');

  fail = false;
  await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(replace).toHaveBeenCalledWith('https://open.larksuite.com/x'));
});

test('a replaced or finished registration asks to return to the console', async () => {
  stubFetch({ '/api/apps/registration/start': { id: 'r1', status: 'error' } });
  render(<ConnectPage />);
  expect(await screen.findByText('请返回管理台重试')).toBeTruthy();
});

test('gives up after 40 polls', async () => {
  vi.useFakeTimers();
  const fetch = stubFetch({
    '/api/apps/registration/start': { id: 'r1', status: 'starting' },
    '/api/state': { registration: { id: 'r1', status: 'starting' } },
  });
  render(<ConnectPage />);
  await flush();
  await flush(39_000);
  expect(screen.queryByText('连接超时，请重试')).toBeNull();
  expect(callsTo(fetch, '/api/state')).toBe(39);
  await flush(1000);
  expect(screen.getByText('连接超时，请重试')).toBeTruthy();
  expect(callsTo(fetch, '/api/state')).toBe(40);
  expect(replace).not.toHaveBeenCalled();
});
