import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { AppDialog } from './AppDialog.jsx';
import { BindingDialog } from './BindingDialog.jsx';
import { MachineDialog } from './MachineDialog.jsx';
import { RegistrationDialog } from './RegistrationDialog.jsx';
import { bodyOf, deferred, reply, sampleState, stubFetch } from '../test/fixtures.js';

const optionLabels = (label) => [...screen.getByLabelText(label).options].map((option) => option.textContent);

test('machine form starts from defaults and saves with enabled:true; a failed save shows the error in the dialog and re-enables the button', async () => {
  const save = deferred();
  const fetch = stubFetch({ '/api/machines/save': () => save.promise });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<MachineDialog onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByRole('heading', { name: '添加 Herdr 连接' })).toBeTruthy();
  expect(screen.getByLabelText('连接方式').value).toBe('ssh');
  expect(screen.getByLabelText('Herdr Session').value).toBe('default');
  expect(screen.getByLabelText('端口').value).toBe('22');
  expect(screen.getByLabelText('Herdr 可执行文件').value).toBe('~/.local/bin/herdr');

  await user.type(screen.getByLabelText('连接名称'), 'cpu9');
  await user.type(screen.getByLabelText('SSH 地址 / 别名'), 'bad;host');
  const submit = screen.getByRole('button', { name: '保存并连接' });
  await user.click(submit);
  expect(submit.disabled).toBe(true);
  expect(bodyOf(fetch, '/api/machines/save')).toEqual({ name: 'cpu9', type: 'ssh', host: 'bad;host', session: 'default', port: '22', binary: '~/.local/bin/herdr', enabled: true });

  save.resolve(reply({ error: 'SSH 地址格式无效' }, 400));
  expect(await screen.findByText('SSH 地址格式无效')).toBeTruthy();
  expect(submit.disabled).toBe(false);
  expect(onSaved).not.toHaveBeenCalled();
});

test('machine form edits an existing machine and keeps SSH values when switched to local', async () => {
  const fetch = stubFetch({ '/api/machines/save': { id: 'm-3' } });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const machine = { ...sampleState().machines[3], enabled: false };
  render(<MachineDialog machine={machine} onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByLabelText('连接名称').value).toBe('cpu3');
  expect(screen.getByLabelText('SSH 地址 / 别名').value).toBe('cpu3');
  await user.selectOptions(screen.getByLabelText('连接方式'), 'local');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(bodyOf(fetch, '/api/machines/save')).toEqual({ id: 'm-4', name: 'cpu3', type: 'local', host: 'cpu3', session: 'default', port: '22', binary: '~/.local/bin/herdr', enabled: true });
});

test('app form defaults to Feishu, splits allowed users and clears the secret after saving', async () => {
  const fetch = stubFetch({ '/api/apps/save': reply({ error: '该应用已添加' }, 400) });
  const user = userEvent.setup();
  const { unmount } = render(<AppDialog onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText('API 环境').value).toBe('feishu');
  unmount();

  render(<AppDialog app={sampleState().apps[1]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText('App ID').value).toBe('cli_spare');
  expect(screen.getByLabelText('API 环境').value).toBe('lark');
  await user.type(screen.getByLabelText('App Secret'), 'new-secret');
  await user.type(screen.getByLabelText('允许操作的用户 open_id'), 'ou_a, ou_b{Enter}ou_c');
  await user.click(screen.getByRole('button', { name: '保存应用' }));
  expect(await screen.findByText('该应用已添加')).toBeTruthy();
  expect(bodyOf(fetch, '/api/apps/save')).toEqual({ id: 'app-2', name: '备用应用', appId: 'cli_spare', appSecret: 'new-secret', domain: 'lark', allowedUsers: ['ou_a', 'ou_b', 'ou_c'] });
  expect(screen.getByLabelText('App Secret').value).toBe('');
});

test('binding form lists every app and only connected machines, and saves a chat route with a working directory and agent kind', async () => {
  const fetch = stubFetch({ '/api/bindings/save': { ok: true } });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<BindingDialog state={sampleState()} onClose={vi.fn()} onSaved={onSaved} />);
  expect(optionLabels('飞书应用')).toEqual(['工作助手', '备用应用']);
  expect(optionLabels('机器 / Herdr 实例')).toEqual(['cpu2 / default', 'gpu1 / work']);
  expect(optionLabels('Agent 类型')).toEqual(['Claude', 'Codex']);
  expect(screen.getByLabelText('Agent 类型').value).toBe('claude');
  expect(screen.getByLabelText(/仅 @机器人时触发/).checked).toBe(true);
  expect(document.querySelectorAll('select')).toHaveLength(3);
  expect(screen.getByText(/^每个飞书话题会在 Herdr 中新开一个 tab/)).toBeTruthy();
  expect(screen.queryByLabelText('话题根消息 ID')).toBeNull();
  expect(screen.queryByLabelText('在话题中回复')).toBeNull();

  await user.type(screen.getByLabelText('绑定名称'), '个人助手');
  await user.selectOptions(screen.getByLabelText('飞书应用'), 'app-2');
  await user.type(screen.getByLabelText('Chat ID'), 'oc_42');
  await user.selectOptions(screen.getByLabelText('机器 / Herdr 实例'), 'm-2');
  await user.type(screen.getByLabelText('工作目录'), '~/code/bridge');
  await user.selectOptions(screen.getByLabelText('Agent 类型'), 'codex');
  await user.click(screen.getByLabelText(/仅 @机器人时触发/));
  await user.click(screen.getByRole('button', { name: '保存绑定' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(bodyOf(fetch, '/api/bindings/save')).toEqual({ name: '个人助手', appId: 'app-2', machineId: 'm-2', chatId: 'oc_42', cwd: '~/code/bridge', kind: 'codex', requireMention: false });
});

const registrationProps = () => ({ apps: sampleState().apps, previousId: 'r0', onRetry: vi.fn(), onDone: vi.fn(), onConfigure: vi.fn(), onManual: vi.fn(), onClose: vi.fn() });

test('registration dialog shows 完成 once the flow completes', async () => {
  const props = registrationProps();
  const user = userEvent.setup();
  render(<RegistrationDialog registration={{ id: 'r1', status: 'completed', appId: 'app-1' }} {...props} />);
  expect(screen.getByRole('heading', { name: '飞书已连接' })).toBeTruthy();
  expect(screen.getByText('WorkBot')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '手动接入' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '完成' }));
  expect(props.onDone).toHaveBeenCalled();
});

test('registration dialog links to Feishu and switches to the QR code for phones', async () => {
  const props = registrationProps();
  const user = userEvent.setup();
  const registration = { id: 'r1', status: 'pending', url: 'https://open.feishu.cn/page/x', qr: 'data:image/png;base64,qr' };
  render(<RegistrationDialog registration={registration} {...props} />);
  const link = screen.getByRole('link', { name: '前往飞书 ↗' });
  expect(link.getAttribute('href')).toBe(registration.url);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.queryByAltText('飞书扫码')).toBeNull();

  await user.click(screen.getByRole('button', { name: '手机扫码' }));
  expect(screen.getByAltText('飞书扫码').getAttribute('src')).toBe(registration.qr);
  await user.click(screen.getByRole('button', { name: '收起二维码' }));
  expect(screen.queryByAltText('飞书扫码')).toBeNull();

  await user.click(screen.getByRole('button', { name: '手动接入' }));
  expect(props.onManual).toHaveBeenCalled();
});
