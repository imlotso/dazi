// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SmtpPanel } from '../src/components/admin/SmtpPanel';
import { api } from '../src/lib/api';

vi.mock('../src/lib/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/api')>(), api: vi.fn() }));
afterEach(cleanup);

it('verifies an SMTP draft, saves it, and clears it only after confirmation', async () => {
  const none = { source: 'unconfigured', fallback: 'unconfigured', revision: 0, editable: true, config: null, passwordState: 'empty' };
  const config = { host: 'smtp.example.test', from: 'sender@example.test', username: 'sender', port: 465, security: 'tls' };
  const apiMock = vi.mocked(api);
  apiMock.mockImplementation(async (url, options) => {
    if (url === '/api/admin/smtp/verify') return { ok: true };
    if (url === '/api/admin/smtp/reset') return { ...none, revision: 2 };
    if (options?.method === 'POST') return { ...none, source: 'admin', revision: 1, config, passwordState: 'saved' };
    return none;
  });
  render(<SmtpPanel ownerId="admin" />);
  fireEvent.change(await screen.findByLabelText('SMTP 主机'), { target: { value: config.host } });
  fireEvent.change(screen.getByLabelText('加密方式'), { target: { value: 'tls' } });
  expect((screen.getByLabelText('端口') as HTMLSelectElement).value).toBe('465');
  fireEvent.change(screen.getByLabelText('发件人邮箱'), { target: { value: config.from } });
  fireEvent.change(screen.getByLabelText('SMTP 账号'), { target: { value: config.username } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-password' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect((await screen.findByRole('status')).textContent).toBe('SMTP 连接验证成功');
  expect(apiMock.mock.calls.find(([url]) => url.endsWith('/verify'))?.[1]?.body).toEqual({
    revision: 0, draft: { ...config, password: 'test-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  const password = await screen.findByLabelText('密码（已保存）') as HTMLInputElement;
  expect(password.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '清除配置' }));
  expect(apiMock.mock.calls.some(([url]) => url.endsWith('/reset'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认清除配置' }));
  expect((await screen.findByRole('status')).textContent).toBe('已清除');
});
