// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { User } from '../src/lib/api';
import { defaultSettings } from '../src/lib/models';
import { putWorkspaceValue, readWorkspace } from '../src/lib/workspace';

const admin: User = { id: 'manager', username: 'manager', email: 'manager@example.test', isAdmin: true };
const member: User = { id: 'reader', username: 'reader', email: 'reader@example.test', isAdmin: false };
const overview = { metrics: { users: 2, disabledUsers: 0, admins: 1, activeUsers7d: 0, finishedPractices7d: 0, pendingScores: 0, publishedScores: 0, publishedArticles: 42 }, recentActions: [] };
let account: User | null;
let loginAs: User;

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/');
  account = null; loginAs = admin;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    let body: unknown = {};
    if (path === '/api/me') body = { user: account };
    else if (path === '/api/auth/login') { account = loginAs; body = { user: account }; }
    else if (path === '/api/auth/logout') { account = null; body = { ok: true }; }
    else if (path === '/api/admin/overview') body = overview;
    else if (path.startsWith('/api/workspace')) body = { items: [], serverTime: Date.now() };
    else if (path === '/api/articles') body = { articles: [] };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

async function signIn() {
  const login = await screen.findByRole('button', { name: '登录' });
  await waitFor(() => expect((login as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(login);
  const dialog = screen.getByRole('dialog', { name: '登录' });
  fireEvent.change(within(dialog).getByLabelText('用户名或邮箱'), { target: { value: loginAs.username } });
  fireEvent.change(within(dialog).getByLabelText('密码'), { target: { value: 'test-password-only' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '登录' }));
}

it('uses the shared login to open a separate admin interface without practice navigation or room art', async () => {
  render(<App />);
  expect(screen.queryByRole('button', { name: '管理后台' })).toBeNull();
  await signIn();
  await screen.findByRole('heading', { name: '管理后台' });
  expect(screen.queryByRole('navigation', { name: '主要导航' })).toBeNull();
  expect(screen.queryByRole('button', { name: '开始练习' })).toBeNull();
  expect(document.querySelector('.room')).toBeNull();
  expect(document.querySelector('.sleeping-cat')).toBeNull();
  expect(window.location.pathname).toBe('/admin');
  expect(screen.getByRole('button', { name: '用户' })).toBeTruthy();
});

it('does not mount practice or administration while a bookmarked admin session is being checked', async () => {
  window.history.replaceState(null, '', '/admin');
  let resolveAccount!: (response: Response) => void;
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => path === '/api/me'
    ? new Promise<Response>((resolve) => { resolveAccount = resolve; })
    : original(path, options)));
  render(<App />);
  expect(screen.queryByRole('navigation', { name: '主要导航' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '管理后台' })).toBeNull();
  await act(async () => resolveAccount(new Response(JSON.stringify({ user: admin }))));
  await screen.findByRole('heading', { name: '管理后台' });
});

it('restores an administrator into management even from the public root and logs out to the shared login', async () => {
  account = admin;
  render(<App />);
  await screen.findByRole('heading', { name: '管理后台' });
  fireEvent.click(screen.getByTitle('退出登录'));
  await screen.findByRole('button', { name: '登录' });
  expect(screen.queryByRole('heading', { name: '管理后台' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull();
  expect(window.location.pathname).toBe('/');
});

it('keeps a normal account in the practice interface after shared login', async () => {
  loginAs = member;
  render(<App />); await signIn();
  await screen.findByRole('button', { name: /reader/ });
  expect(screen.getByRole('textbox', { name: '当前行输入' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '管理后台' })).toBeNull();
  expect(screen.queryByRole('button', { name: '管理后台' })).toBeNull();
  expect(window.location.pathname).toBe('/');
});

it('returns from an explicit site preview through the account entry and preserves active input', async () => {
  account = admin; render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '预览网站' }));
  expect(screen.queryByRole('button', { name: '管理后台' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '自定义文字' }));
  fireEvent.change(screen.getByRole('textbox', { name: '自定义文章内容' }), { target: { value: '甲乙丙丁' } });
  fireEvent.click(screen.getByRole('button', { name: '使用这段文字' }));
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: '甲乙' } });
  fireEvent.click(screen.getByTitle('返回管理界面'));
  await screen.findByRole('heading', { name: '管理后台' });
  fireEvent.click(screen.getByRole('button', { name: '预览网站' }));
  await screen.findByRole('button', { name: '继续练习' });
  expect(screen.getByTestId('typed-count').textContent).toBe('2');
});

it('removes the admin interface when focus revalidation discovers a different normal account', async () => {
  account = admin; render(<App />);
  await screen.findByRole('heading', { name: '管理后台' });
  await act(async () => { account = member; window.dispatchEvent(new Event('focus')); });
  await screen.findByRole('button', { name: /reader/ });
  expect(screen.queryByRole('heading', { name: '管理后台' })).toBeNull();
  expect(screen.getByRole('navigation', { name: '主要导航' })).toBeTruthy();
  expect(window.location.pathname).toBe('/');
});

it('does not restore a former preview after switching between administrator accounts', async () => {
  account = admin; render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '预览网站' }));
  await act(async () => { account = { ...admin, id: 'another-admin', username: 'another-admin' }; window.dispatchEvent(new Event('focus')); });
  await screen.findByRole('heading', { name: '管理后台' });
  await act(async () => { account = admin; window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(screen.getByTitle('退出登录').textContent).toContain(admin.username));
  expect(screen.queryByRole('navigation', { name: '主要导航' })).toBeNull();
});

it.each([admin, member])('waits for uncached account preferences before allowing a theme write ($username)', async (current) => {
  account = current;
  const preferences = { ...defaultSettings, minutes: 17, fontSize: 23 };
  const original = vi.mocked(fetch).getMockImplementation()!;
  let resolveWorkspace!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => path === '/api/workspace'
    ? new Promise<Response>((resolve) => { resolveWorkspace = resolve; }) : original(path, options)));
  render(<App />);
  if (current.isAdmin) await screen.findByRole('heading', { name: '管理后台' });
  else await screen.findByRole('button', { name: /reader/ });
  const toggle = screen.getByRole('button', { name: '切换至夜间模式' }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
  await waitFor(() => expect(resolveWorkspace).toBeTypeOf('function'));
  await act(async () => resolveWorkspace(new Response(JSON.stringify({ items: [{ kind: 'settings', id: 'preferences', updatedAt: Date.now(), value: preferences }], serverTime: Date.now() }))));
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await waitFor(async () => expect((await readWorkspace(current.id)).find((item) => item.kind === 'settings')?.value).toMatchObject({ minutes: 17, fontSize: 23, theme: 'dark' }));
});

it('can update known cached preferences while cloud sync is offline', async () => {
  account = admin;
  await putWorkspaceValue(admin.id, 'settings', 'preferences', { ...defaultSettings, minutes: 19 });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => path === '/api/workspace'
    ? Promise.reject(new Error('offline')) : original(path, options)));
  render(<App />);
  await screen.findByRole('heading', { name: '管理后台' });
  const toggle = screen.getByRole('button', { name: '切换至夜间模式' }) as HTMLButtonElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await waitFor(async () => expect((await readWorkspace(admin.id)).find((item) => item.kind === 'settings')?.value).toMatchObject({ minutes: 19, theme: 'dark' }));
});
