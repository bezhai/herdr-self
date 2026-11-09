import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { expect, test, vi } from 'vitest';
import type { ConsoleState } from '../../../console-state.ts';
import { AppDialog } from './AppDialog.tsx';
import { ClientTokenDialog } from './ClientTokenDialog.tsx';
import { MachineDialog } from './MachineDialog.tsx';
import { RegistrationDialog } from './RegistrationDialog.tsx';
import { SkillDialog } from './SkillDialog.tsx';
import { base64, bodyOf, deferred, reply, sampleState, stubFetch } from '../test/fixtures.ts';

// In these tests, ! after a DOM query marks an element that the test has just rendered.

const optionLabels = (label: string) => [...screen.getByLabelText<HTMLSelectElement>(label).options].map((option) => option.textContent);
// Paragraphs in the open dialog other than the error line: forms carry no captions or explanations.
const prose = () => [...document.querySelectorAll('dialog p')].filter((p) => p.getAttribute('role') !== 'alert').map((p) => p.textContent);

test('form dialogs head with their title next to the close button and hold no explanatory text', () => {
  const state = sampleState();
  const forms: [ReactElement, string][] = [
    [<AppDialog onClose={vi.fn()} onSaved={vi.fn()} />, '应用配置'],
    [<MachineDialog onClose={vi.fn()} onSaved={vi.fn()} />, '添加机器'],
    [<SkillDialog onClose={vi.fn()} onSaved={vi.fn()} />, '新建 skill'],
    [<SkillDialog skill={{ ...state.skills[1], files: { 'SKILL.md': base64('---\n'), 'run.sh': base64('') } }} onClose={vi.fn()} onSaved={vi.fn()} />, '编辑 deploy-notes'],
  ];
  for (const [element, title] of forms) {
    const view = render(element);
    const head = document.querySelector<HTMLElement>('.dialog-head')!;
    expect(head.textContent).toBe(title);
    expect(within(head).getByRole('heading', { name: title })).toBeTruthy();
    expect(within(head).getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(prose()).toEqual([]);
    view.unmount();
  }
});

test('machine form asks only for the name and the Herdr session, starts from session default and saves with enabled:true; a failed save shows the error in the dialog and re-enables the button', async () => {
  const save = deferred();
  const fetch = stubFetch({ '/api/machines/save': () => save.promise });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<MachineDialog onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByRole('heading', { name: '添加机器' })).toBeTruthy();
  expect([...document.querySelectorAll('dialog label')].map((label) => label.textContent)).toEqual(['机器名称', 'Herdr Session']);
  expect(document.querySelectorAll('dialog input, dialog select, dialog textarea')).toHaveLength(2);
  expect(screen.getByLabelText<HTMLInputElement>('Herdr Session').value).toBe('default');

  await user.type(screen.getByLabelText('机器名称'), 'cpu9');
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: '下一步' });
  await user.click(submit);
  expect(submit.disabled).toBe(true);
  expect(bodyOf(fetch, '/api/machines/save')).toEqual({ name: 'cpu9', session: 'default', enabled: true });

  save.resolve(reply({ error: '机器名称已存在' }, 400));
  expect(await screen.findByText('机器名称已存在')).toBeTruthy();
  expect(submit.disabled).toBe(false);
  expect(onSaved).not.toHaveBeenCalled();
});

test('machine form edits a machine by its id and hands the saved machine to the caller', async () => {
  const fetch = stubFetch({ '/api/machines/save': { id: 'm-3' } });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<MachineDialog machine={sampleState().machines[2]} onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByRole('heading', { name: '编辑机器' })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>('机器名称').value).toBe('laptop');
  expect(screen.getByLabelText<HTMLInputElement>('Herdr Session').value).toBe('default');
  await user.clear(screen.getByLabelText('Herdr Session'));
  await user.type(screen.getByLabelText('Herdr Session'), 'work');
  await user.click(screen.getByRole('button', { name: '保存并连接' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'm-3', name: 'laptop', session: 'work' }));
  expect(bodyOf(fetch, '/api/machines/save')).toEqual({ id: 'm-3', name: 'laptop', session: 'work', enabled: true });
});

test('the client token dialog warns that a new token replaces the old one, then shows the config of the client once; a first token needs no warning and a failure stays in the dialog', async () => {
  const issue = deferred();
  const fetch = stubFetch({ '/api/machines/token': () => issue.promise });
  const onIssued = vi.fn();
  const user = userEvent.setup();
  const view = render(<ClientTokenDialog machine={sampleState().machines[0]} onClose={vi.fn()} onIssued={onIssued} />);
  expect(document.querySelector('.dialog-head')!.textContent).toBe('重新生成客户端 token');
  expect(prose()).toEqual(['旧 token 立即失效，正在用它连接的客户端会断开。']);
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: '重新生成' });
  await user.click(submit);
  expect(submit.disabled).toBe(true);
  expect(bodyOf(fetch, '/api/machines/token')).toEqual({ id: 'm-1' });

  const config = '{\n  "url": "ws://bridge-host:8080/api/client",\n  "token": "secret"\n}\n';
  issue.resolve(reply({ config }));
  const field = await screen.findByLabelText<HTMLTextAreaElement>('客户端配置');
  expect(field.value).toBe(config);
  expect(field.readOnly).toBe(true);
  expect(document.querySelector('.dialog-head')!.textContent).toBe('cpu2 的客户端配置');
  expect(prose()).toEqual(['只显示这一次。保存为那台机器上的 ~/.config/herdr-bridge/client.json，权限 600。']);
  expect(onIssued).toHaveBeenCalledTimes(1);
  view.unmount();

  stubFetch({ '/api/machines/token': reply({ error: '机器连接不存在' }, 400) });
  render(<ClientTokenDialog machine={sampleState().machines[2]} onClose={vi.fn()} onIssued={onIssued} />);
  expect(document.querySelector('.dialog-head')!.textContent).toBe('生成客户端 token');
  expect(prose()).toEqual([]);
  await user.click(screen.getByRole('button', { name: '生成' }));
  expect(await screen.findByText('机器连接不存在')).toBeTruthy();
  expect(screen.queryByLabelText('客户端配置')).toBeNull();
  expect(onIssued).toHaveBeenCalledTimes(1);
});

test('app form defaults to Feishu, splits allowed users and clears the secret after saving', async () => {
  const fetch = stubFetch({ '/api/apps/save': reply({ error: '该应用已添加' }, 400) });
  const user = userEvent.setup();
  const { unmount } = render(<AppDialog onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText<HTMLSelectElement>('API 环境').value).toBe('feishu');
  unmount();

  render(<AppDialog app={sampleState().apps[1]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText<HTMLInputElement>('应用名称').value).toBe('备用应用');
  expect(prose()).toEqual([]);
  expect(screen.getByLabelText<HTMLInputElement>('App ID').value).toBe('cli_spare');
  expect(screen.getByLabelText<HTMLSelectElement>('API 环境').value).toBe('lark');
  await user.type(screen.getByLabelText('App Secret'), 'new-secret');
  await user.type(screen.getByLabelText('允许操作的用户 open_id'), 'ou_a, ou_b{Enter}ou_c');
  await user.click(screen.getByRole('button', { name: '保存应用' }));
  expect(await screen.findByText('该应用已添加')).toBeTruthy();
  expect(bodyOf(fetch, '/api/apps/save')).toEqual({ id: 'app-2', name: '备用应用', appId: 'cli_spare', appSecret: 'new-secret', domain: 'lark', allowedUsers: ['ou_a', 'ou_b', 'ou_c'] });
  expect(screen.getByLabelText<HTMLInputElement>('App Secret').value).toBe('');
});

// Replaces the text of a field with text, which may hold characters that user.type would read as keys.
async function replaceText(user: UserEvent, field: HTMLElement, text: string) {
  await user.clear(field);
  await user.click(field);
  await user.paste(text);
}

test('skill form for a new skill asks for its name and its SKILL.md, which starts from the frontmatter that a skill needs, and saves it as a new skill; a refusal stays in the dialog', async () => {
  const save = deferred();
  const fetch = stubFetch({ '/api/skills/save': () => save.promise });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<SkillDialog onClose={vi.fn()} onSaved={onSaved} />);
  expect(document.querySelectorAll('dialog input, dialog select, dialog textarea')).toHaveLength(2);
  expect(screen.getByLabelText<HTMLInputElement>('skill 名称').value).toBe('');
  expect(screen.getByLabelText<HTMLTextAreaElement>('SKILL.md').value).toBe('---\nname: \ndescription: \n---\n');
  expect(document.querySelector('.skill-files')).toBeNull();

  const text = '---\nname: deploy-notes\ndescription: 部署前后要检查的事项。\n---\n\n先看 CI。\n';
  await user.type(screen.getByLabelText('skill 名称'), 'deploy-notes');
  await replaceText(user, screen.getByLabelText('SKILL.md'), text);
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: '保存' });
  await user.click(submit);
  expect(submit.disabled).toBe(true);
  expect(bodyOf(fetch, '/api/skills/save')).toEqual({ name: 'deploy-notes', text, create: true });

  save.resolve(reply({ error: 'skill 已存在：deploy-notes' }, 400));
  expect(await screen.findByText('skill 已存在：deploy-notes')).toBeTruthy();
  expect(submit.disabled).toBe(false);
  expect(onSaved).not.toHaveBeenCalled();
});

test('skill form for an existing skill edits its SKILL.md alone: the title names the skill, the other files are listed, and saving sends the text to the skill', async () => {
  const fetch = stubFetch({ '/api/skills/save': { ok: true } });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const text = '---\nname: deploy-notes\ndescription: 部署前后要检查的事项。\n---\n先看 CI。\n';
  const skill = { ...sampleState().skills[1], files: { 'SKILL.md': base64(text), 'references/checklist.md': base64('- CI\n'), 'scripts/check.sh': base64('echo\n') } };
  render(<SkillDialog skill={skill} onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.queryByLabelText('skill 名称')).toBeNull();
  expect(screen.getByLabelText<HTMLTextAreaElement>('SKILL.md').value).toBe(text);
  const files = screen.getByRole('group', { name: '其他文件' });
  expect([...files.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['references/checklist.md', 'scripts/check.sh']);
  expect(document.querySelectorAll('dialog input, dialog select, dialog textarea')).toHaveLength(1);

  const changed = text.replace('先看 CI。', '先看 CI，再看告警。');
  await replaceText(user, screen.getByLabelText('SKILL.md'), changed);
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(bodyOf(fetch, '/api/skills/save')).toEqual({ name: 'deploy-notes', text: changed, create: false });
});

// as: the registrations below hold only what the dialog reads.
type Registration = NonNullable<ConsoleState['registration']>;
const registrationProps = () => ({ apps: sampleState().apps, previousId: 'r0', onRetry: vi.fn(), onDone: vi.fn(), onConfigure: vi.fn(), onManual: vi.fn(), onClose: vi.fn() });

test('registration dialog shows 完成 once the flow completes', async () => {
  const props = registrationProps();
  const user = userEvent.setup();
  render(<RegistrationDialog registration={{ id: 'r1', status: 'completed', appId: 'app-1' } as Registration} {...props} />);
  expect(screen.getByRole('heading', { name: '飞书已连接' })).toBeTruthy();
  expect(screen.getByText('工作助手')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '手动接入' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '完成' }));
  expect(props.onDone).toHaveBeenCalled();
});

test('registration dialog links to Feishu and switches to the QR code for phones', async () => {
  const props = registrationProps();
  const user = userEvent.setup();
  const registration = { id: 'r1', status: 'pending', url: 'https://open.feishu.cn/page/x', qr: 'data:image/png;base64,qr' } as Registration;
  render(<RegistrationDialog registration={registration} {...props} />);
  expect(prose()).toEqual(['等待飞书确认']);
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
