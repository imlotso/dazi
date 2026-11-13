// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminConsole } from '../src/components/AdminConsole';
import { api } from '../src/lib/api';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const overview = {
  metrics: { users: 3, disabledUsers: 1, admins: 2, activeUsers7d: 1, finishedPractices7d: 10,
    pendingScores: 2, publishedScores: 0, publishedArticles: 42 },
  recentActions: [],
};

const page = <T,>(entries: T[]) => ({ entries, page: 1, pageSize: 20, total: entries.length });
const call = vi.mocked(api);
const request = (path: string) => call.mock.calls.find(([url]) => url === path)?.[1];

it('loads overview data and disables a searched account only after confirmation', async () => {
  const user = { id: 'account', username: 'lin', email: 'lin@example.test', role: 'user', status: 'active', createdAt: 1000 };
  let disabled = false;
  call.mockImplementation(async (url) => {
    if (url === '/api/admin/overview') return overview;
    if (url.startsWith('/api/admin/users?')) return page([{ ...user, status: disabled ? 'disabled' : 'active' }]);
    if (url === '/api/admin/users/account') return { user: { ...user, activeSessions: 2, finishedPractices: 3, publishedScores: 0, lastPracticeAt: null } };
    if (url === '/api/admin/users/account/status') { disabled = true; return { ok: true }; }
    throw new Error('unexpected request');
  });
  render(<AdminConsole ownerId="manager" onCatalogChange={vi.fn()} />);
  expect(await screen.findByText('42')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '用户' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lin' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await waitFor(() => expect(call.mock.calls.some(([url]) => url.includes('q=lin'))).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: 'lin 详情' }));
  const detail = await screen.findByRole('dialog', { name: '用户详情' });
  fireEvent.click(await within(detail).findByRole('button', { name: '停用' }));
  const confirmation = screen.getByRole('dialog', { name: '停用账号' });
  expect(request('/api/admin/users/account/status')).toBeUndefined();
  fireEvent.change(within(confirmation).getByRole('textbox', { name: '原因' }), { target: { value: '账号安全核查' } });
  fireEvent.click(within(confirmation).getByRole('button', { name: '确认停用' }));
  expect(await screen.findByText('已停用')).toBeTruthy();
  expect(request('/api/admin/users/account/status')).toMatchObject({
    method: 'POST', headers: { 'X-Workspace-Owner': 'manager' }, body: { status: 'disabled', reason: '账号安全核查' },
  });
});

it('moderates only selected scores and preserves the reason for a retry', async () => {
  const scores = ['春日', '秋日'].map((nickname, i) => ({
    id: `attempt-${i}`, nickname, language: 'zh', difficulty: 'beginner', articleId: 'spring', articleTitle: '春雨',
    status: 'pending', duration: 300, mode: 'timed', strict: false, speed: 56, accuracy: 100, checkpoints: 2,
    reasons: ['paused_session'], finishedAt: 1000,
  }));
  let writes = 0;
  call.mockImplementation(async (url) => {
    if (url === '/api/admin/overview') return overview;
    if (url.startsWith('/api/admin/scores?')) return page(writes > 1 ? [] : scores);
    if (url === '/api/admin/scores/moderate') {
      if (++writes === 1) throw new Error('暂时无法保存');
      return { ok: true, count: 2 };
    }
    throw new Error('unexpected request');
  });
  render(<AdminConsole ownerId="manager" onCatalogChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '成绩' }));
  await screen.findByText('春日');
  fireEvent.click(screen.getByRole('checkbox', { name: '全选本页' }));
  fireEvent.click(screen.getByRole('button', { name: '通过所选' }));
  const confirmation = screen.getByRole('dialog', { name: '通过成绩' });
  const reason = within(confirmation).getByRole('textbox', { name: '原因' }) as HTMLInputElement;
  fireEvent.change(reason, { target: { value: '已检查进度记录' } });
  const submit = within(confirmation).getByRole('button', { name: '确认通过' });
  fireEvent.click(submit);
  expect((await within(confirmation).findByRole('alert')).textContent).toBe('暂时无法保存');
  expect(reason.value).toBe('已检查进度记录');
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(request('/api/admin/scores/moderate')?.body).toEqual({
    ids: ['attempt-0', 'attempt-1'], action: 'approve', reason: '已检查进度记录',
  });
});

it('creates a draft and publishes the saved revision through the article editor', async () => {
  const article = {
    id: 'new-article', title: '冬信', language: 'zh', difficulty: 'beginner', author: '作者名', theme: '思念',
    source: { name: '原文库', url: 'https://example.test/winter', license: 'public-domain' },
    text: '春风'.repeat(500), status: 'draft', revision: 3, updatedAt: 1000, length: 1000,
  };
  let created = false;
  let published = false;
  call.mockImplementation(async (url, options) => {
    if (url === '/api/admin/overview') return overview;
    if (url.startsWith('/api/admin/articles?')) return page(created ? [{ ...article, status: published ? 'published' : 'draft' }] : []);
    if (url === '/api/admin/articles' && options?.method === 'POST') { created = true; return { article }; }
    if (url === '/api/admin/articles/new-article') return { article };
    if (url === '/api/admin/articles/new-article/status') { published = true; return { article }; }
    throw new Error('unexpected request');
  });
  const onCatalogChange = vi.fn();
  render(<AdminConsole ownerId="manager" onCatalogChange={onCatalogChange} />);
  fireEvent.click(screen.getByRole('button', { name: '文章' }));
  fireEvent.click(screen.getByRole('button', { name: '新建文章' }));
  const editor = screen.getByRole('dialog', { name: '新建文章' });
  fireEvent.change(within(editor).getByRole('textbox', { name: '标题' }), { target: { value: '冬信' } });
  fireEvent.click(within(editor).getByRole('button', { name: '保存' }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑《冬信》' }));
  fireEvent.click(await screen.findByRole('button', { name: '发布' }));
  const confirm = screen.getByRole('dialog', { name: '发布文章' });
  fireEvent.click(within(confirm).getByRole('button', { name: '确认发布' }));
  expect(await screen.findByText('已发布')).toBeTruthy();
  expect(request('/api/admin/articles')?.body).toMatchObject({ title: '冬信', text: '' });
  expect(request('/api/admin/articles/new-article/status')?.body).toEqual({ status: 'published', revision: 3 });
  expect(onCatalogChange).toHaveBeenCalledTimes(2);
});

it('keeps article filters and pagination outside the keyboard-accessible list', async () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    id: `article-${index}`, title: `文章 ${index + 1}`, language: 'zh', difficulty: 'beginner', author: '作者名', theme: '思念',
    source: { name: '原文库', url: 'https://example.test/winter', license: 'public-domain' },
    status: 'published', revision: 1, updatedAt: 1000, length: 1000,
  }));
  call.mockImplementation(async (url) => {
    if (url === '/api/admin/overview') return overview;
    if (url.startsWith('/api/admin/articles?')) return { ...page(entries), total: 42 };
    throw new Error('unexpected request');
  });
  render(<AdminConsole ownerId="manager" onCatalogChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '文章' }));
  const region = await screen.findByRole('region', { name: '文章列表' });
  expect(region.tabIndex).toBe(0);
  expect(within(region).getAllByRole('listitem')).toHaveLength(20);
  expect(within(region).queryByRole('searchbox')).toBeNull();
  expect(within(region).queryByRole('button', { name: '下一页' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(call.mock.calls.some(([url]) => url.includes('page=2'))).toBe(true));
});

it('revokes another user’s sessions after confirmation and refreshes their account details', async () => {
  const user = { id: 'reader', username: 'reader', email: 'reader@example.test', role: 'user', status: 'active', createdAt: 1000 };
  let activeSessions = 2;
  call.mockImplementation(async (url) => {
    if (url === '/api/admin/overview') return overview;
    if (url.startsWith('/api/admin/users?')) return page([user]);
    if (url === '/api/admin/users/reader') return { user: { ...user, activeSessions, finishedPractices: 3, publishedScores: 0, lastPracticeAt: 2000 } };
    if (url === '/api/admin/users/reader/sessions/revoke') { activeSessions = 0; return { ok: true }; }
    throw new Error('unexpected request');
  });
  render(<AdminConsole ownerId="manager" onCatalogChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '用户' }));
  fireEvent.click(await screen.findByRole('button', { name: 'reader 详情' }));
  fireEvent.click(await screen.findByRole('button', { name: '退出所有会话' }));
  const confirmation = screen.getByRole('dialog', { name: '退出所有会话' });
  expect(request('/api/admin/users/reader/sessions/revoke')).toBeUndefined();
  fireEvent.change(within(confirmation).getByRole('textbox', { name: '原因' }), { target: { value: '账号安全核查' } });
  fireEvent.click(within(confirmation).getByRole('button', { name: '确认退出' }));
  await waitFor(() => {
    const detail = screen.getByRole('dialog', { name: '用户详情' });
    expect(within(detail).getByText('活跃会话').nextElementSibling?.textContent).toBe('0');
    expect(within(detail).queryByRole('button', { name: '退出所有会话' })).toBeNull();
    expect(within(detail).getByText('正常')).toBeTruthy();
  });
  expect(request('/api/admin/users/reader/sessions/revoke')).toMatchObject({
    method: 'POST', headers: { 'X-Workspace-Owner': 'manager' }, body: { reason: '账号安全核查' },
  });
});
