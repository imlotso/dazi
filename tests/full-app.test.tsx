// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { readDraft } from '../src/hooks/usePractice';
import { putWorkspaceValue, readWorkspace } from '../src/lib/workspace';
import { defaultBackground } from '../src/lib/background';
import { defaultSettings } from '../src/lib/models';

const response = (value: unknown) => ({ ok: true, json: async () => value }) as Response;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/me' ? { user: null } : {})));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function startCustom(text: string) {
  const input = await screen.findByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '自定义文字' }));
  fireEvent.change(screen.getByRole('textbox', { name: '自定义文章内容' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '使用这段文字' }));
  const field = screen.getByRole('textbox', { name: '当前行输入' });
  fireEvent.compositionStart(field);
  fireEvent.change(field, { target: { value: 'x' } });
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.compositionEnd(field, { data: '' });
  await screen.findByRole('button', { name: '暂停练习' });
}

function more(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(screen.getByRole('button', { name }));
}

it.each(['adjust', 'reset'])('keeps the edited background theme fixed when remote settings switch themes (%s)', async (action) => {
  const owner = 'background-theme-owner';
  const image = { name: 'day.png', width: 1, height: 1, image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=' };
  const night = defaultBackground('dark', { ...image, name: 'night.png' });
  await putWorkspaceValue(owner, 'background', 'light', defaultBackground('light', image));
  await putWorkspaceValue(owner, 'background', 'dark', night);
  await putWorkspaceValue(owner, 'settings', 'preferences', { ...defaultSettings, theme: 'light' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/me' ? { user: { id: owner, username: '背景账号' } } : { items: [], serverTime: Date.now() })));
  render(<App />);
  await screen.findByRole('button', { name: /背景账号/ });
  await waitFor(() => expect((screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement).disabled).toBe(false));
  more('设置'); fireEvent.click(screen.getByRole('button', { name: '背景图' }));
  if (action === 'reset') fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
  else fireEvent.change(screen.getByRole('slider', { name: '模糊' }), { target: { value: 4 } });
  await act(() => putWorkspaceValue(owner, 'settings', 'preferences', { ...defaultSettings, theme: 'dark' }));
  expect(screen.getByRole('dialog', { name: '日间背景' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const items = await readWorkspace(owner);
  expect(items.find((item) => item.kind === 'background' && item.id === 'dark')?.value).toEqual(night);
  const day = items.find((item) => item.kind === 'background' && item.id === 'light');
  if (action === 'reset') expect(day?.deleted).toBe(true);
  else expect(day?.value).toMatchObject({ name: 'day.png', blur: 4 });
});

it('parks active text across navigation and resumes its exact draft', async () => {
  render(<App />);
  await startCustom('甲乙丙丁');
  fireEvent.change(screen.getByRole('textbox', { name: '当前行输入' }), { target: { value: '甲乙' } });
  fireEvent.click(screen.getByRole('button', { name: '文章库' }));
  await screen.findByRole('heading', { name: '文章库' });
  more('草稿箱');
  await screen.findByRole('heading', { name: '练习草稿' });
  fireEvent.click(await screen.findByRole('button', { name: '继续《自定义文字》' }));
  await screen.findByRole('button', { name: '继续练习' });
  expect(screen.getByTestId('typed-count').textContent).toBe('2');
  expect((screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement).value).toBe('甲乙');
});

it('uses reader settings and exits focus mode with Escape', async () => {
  render(<App />);
  await screen.findByRole('textbox', { name: '当前行输入' });
  more('设置');
  const dialog = screen.getByRole('dialog', { name: '练习设置' });
  fireEvent.change(within(dialog).getByRole('slider', { name: '字号' }), { target: { value: '24' } });
  await waitFor(() => expect(screen.getByLabelText('当前文章：背影').style.getPropertyValue('--practice-font-size')).toBe('24px'));
  fireEvent.click(within(dialog).getByRole('button', { name: '进入专注' }));
  expect(screen.queryByRole('navigation', { name: '主要导航' })).toBeNull();
  expect(screen.getByRole('button', { name: '退出专注' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('navigation', { name: '主要导航' })).toBeTruthy();
});

it('never renders a prior account draft before authentication settles', async () => {
  const secret = { version: 1, articleId: 'custom', title: '甲账户文章', text: '甲账户文章', target: '甲账户文章',
    language: 'zh', difficulty: 'beginner', duration: 300, custom: true, offline: true, ownerId: 'account-a',
    elapsedMs: 5000, typed: '甲', backspaces: 0, suspicious: false };
  localStorage.setItem('cloudtyping.practice.v1', JSON.stringify(secret));
  let resolveMe!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/me'
    ? new Promise<Response>((resolve) => { resolveMe = resolve; })
    : Promise.resolve(response({ items: [], serverTime: Date.now() }))));
  render(<App />);
  expect(screen.queryByText('甲账户文章')).toBeNull();
  await act(async () => resolveMe(response({ user: { id: 'account-b', username: '另一账户' } })));
  await screen.findByRole('button', { name: /另一账户/ });
  expect(screen.queryByText('甲账户文章')).toBeNull();
});

it('honors leaderboard filters and displays the signed-in user beyond the visible rankings', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: { id: 'b', username: '小云' } });
    if (url === '/api/workspace') return response({ items: [], serverTime: Date.now() });
    return response({ entries: [], self: { rank: 108, nickname: '小云', speed: 30, accuracy: 95, mine: true }, total: 108 });
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('button', { name: /小云/ });
  fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
  fireEvent.change(await screen.findByLabelText('排行时段'), { target: { value: 'week' } });
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('/api/leaderboard?') && url.includes('period=week'))).toBe(true));
  expect(await screen.findByText('第 108 名')).toBeTruthy();
});

it('opens a history continuation with only the new round contributing to live speed', async () => {
  const article = { id: 'old-custom', title: '旧信', text: '甲乙丙丁', language: 'zh' as const, difficulty: 'beginner' as const, custom: true };
  await putWorkspaceValue(null, 'record', 'old', {
    recordId: 'old', ownerId: null, article, typed: '甲乙', total: 2, articleTotal: 4, offset: 0,
    language: 'zh', difficulty: 'beginner', duration: 300, speed: 45, accuracy: 100, finishedAt: Date.now(),
  });
  render(<App />);
  await screen.findByRole('textbox', { name: '当前行输入' });
  fireEvent.click(screen.getByRole('button', { name: '我的记录' }));
  fireEvent.click(await screen.findByRole('button', { name: '《旧信》详情' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: '练习详情' })).getByRole('button', { name: '继续练习' }));
  await screen.findByRole('button', { name: '继续练习' });
  expect(screen.getByTestId('typed-count').textContent).toBe('2');
  expect(screen.getByText(/字 \/ 分钟：—/)).toBeTruthy();
});

it('keeps the local practice snapshot and uses the authoritative moderation status', async () => {
  const record = {
    recordId: 'attempt', ownerId: 'account', article: { id: 'old', title: '留存的信', text: '甲乙', custom: false, language: 'zh' as const, difficulty: 'beginner' as const },
    typed: '甲甲', mistakes: [{ position: 1, expected: '乙', actual: '甲' }], language: 'zh' as const,
    difficulty: 'beginner' as const, duration: 300, speed: 15, accuracy: 50, finishedAt: Date.now(), status: 'review', localOnly: true,
  };
  await putWorkspaceValue('account', 'record', record.recordId, record);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: { id: 'account', username: '本账号' } });
    if (url === '/api/history') return response({ entries: [{ ...record, status: 'rejected', article: undefined, typed: undefined, mistakes: undefined, localOnly: undefined }] });
    return response({ items: [], serverTime: Date.now() });
  }));
  render(<App />);
  await screen.findByRole('button', { name: /本账号/ });
  fireEvent.click(screen.getByRole('button', { name: '我的记录' }));
  await screen.findByText('复核未通过');
  expect(screen.queryByText('个人练习')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '《留存的信》详情' }));
  const details = screen.getByRole('dialog', { name: '练习详情' });
  expect(within(details).getByText('复核未通过')).toBeTruthy();
  expect(within(details).getByText('第 2 字符')).toBeTruthy();
});

it('can explicitly resume a local account draft while the sync endpoint is unavailable', async () => {
  const ownerId = 'offline-account';
  localStorage.setItem('cloudtyping.practice.v1', JSON.stringify({
    version: 1, ownerId, articleId: 'custom', title: '离线草稿', text: '山海相望', target: '山海相望',
    language: 'zh', difficulty: 'beginner', duration: 300, custom: true, offline: true, elapsedMs: 5000,
    typed: '山海', backspaces: 1, suspicious: false,
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: { id: ownerId, username: '离线账号' } });
    throw new Error('offline');
  }));
  render(<App />);
  await screen.findByRole('button', { name: /离线账号/ });
  await waitFor(() => expect((screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.queryByRole('heading', { name: '离线草稿' })).toBeNull();
  more('草稿箱');
  fireEvent.click(await screen.findByRole('button', { name: '继续《离线草稿》' }));
  await screen.findByRole('button', { name: '继续练习' });
  expect(screen.getByTestId('typed-count').textContent).toBe('2');
  expect(screen.getByTestId('backspace-count').textContent).toBe('1');
});

it('does not revive a locally cached draft deleted on another device', async () => {
  const ownerId = 'synced-account';
  localStorage.setItem('cloudtyping.practice.v2.old', JSON.stringify({
    version: 1, ownerId, recordId: 'old', articleId: 'custom', title: '已删草稿', text: '山海相望', target: '山海相望',
    language: 'zh', difficulty: 'beginner', duration: 300, custom: true, offline: true, elapsedMs: 5000,
    typed: '山海', backspaces: 1, suspicious: false,
  }));
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: { id: ownerId, username: '同步账号' } });
    return response({ items: [{ kind: 'draft', id: 'draft-old', updatedAt: Date.now(), deleted: true }], serverTime: Date.now() });
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('button', { name: /同步账号/ });
  more('设置');
  const settings = screen.getByRole('dialog', { name: '练习设置' });
  await within(settings).findByText('已同步');
  fireEvent.click(within(settings).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('heading', { name: '已删草稿' })).toBeNull();
  more('草稿箱');
  expect(await screen.findByText('暂无草稿')).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url === '/api/workspace/sync')).toBe(false);
});

it('keeps independent rounds of the same article accessible after another round finishes', async () => {
  const article = { id: 'same', title: '同一封信', text: '甲乙丙丁', language: 'zh' as const, difficulty: 'beginner' as const, custom: true };
  const savedAt = Date.now() - 3000;
  const common = { article, elapsedMs: 2000, backspaces: 0, duration: 300, mode: 'timed' as const, strict: false, offset: 0, offline: true, ownerId: null };
  await putWorkspaceValue(null, 'draft', 'draft-older', { ...common, id: 'draft-older', recordId: 'older', typed: '甲乙', savedAt });
  await putWorkspaceValue(null, 'draft', 'draft-newer', { ...common, id: 'draft-newer', recordId: 'newer', typed: '', savedAt: savedAt + 1000 });
  await putWorkspaceValue(null, 'record', 'completed', {
    recordId: 'completed', ownerId: null, article, typed: article.text, articleTotal: 4,
    language: 'zh', difficulty: 'beginner', duration: 300, speed: 60, accuracy: 100, finishedAt: savedAt + 2000,
  });
  render(<App />);
  await waitFor(() => expect((screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement).disabled).toBe(false));
  more('草稿箱');
  const actions = await screen.findAllByRole('button', { name: '继续《同一封信》' });
  expect(actions).toHaveLength(2);
  const older = screen.getByText('2 / 4 字符').closest('li')!;
  fireEvent.click(within(older).getByRole('button', { name: '继续《同一封信》' }));
  await screen.findByRole('button', { name: '继续练习' });
  expect(screen.getByTestId('typed-count').textContent).toBe('2');
});

it('recovers a completed local result from the draft box when cloud sync fails', async () => {
  const ownerId = 'completed-offline-account';
  localStorage.setItem('cloudtyping.practice.v2.done', JSON.stringify({
    version: 1, ownerId, recordId: 'done', articleId: 'custom', title: '已完成的练习', text: '山海相望', target: '山海相望',
    language: 'zh', difficulty: 'beginner', duration: 300, custom: true, offline: true, elapsedMs: 5000,
    typed: '山海相望', backspaces: 1, suspicious: false, completed: true,
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: { id: ownerId, username: '结果恢复账号' } });
    throw new Error('offline');
  }));
  render(<App />);
  await screen.findByRole('button', { name: /结果恢复账号/ });
  more('草稿箱');
  fireEvent.click(await screen.findByRole('button', { name: '恢复《已完成的练习》成绩' }));
  const result = await screen.findByRole('dialog', { name: '练习成绩' });
  expect(within(result).getByText('4 / 4')).toBeTruthy();
});

it('logs out after parking an unfinished round and keeps it with its account', async () => {
  const owner = { id: 'round-owner', username: '草稿账号' };
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: owner });
    if (url === '/api/auth/logout') return response({ ok: true });
    return response({ items: [], serverTime: Date.now() });
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('button', { name: /草稿账号/ });
  await startCustom('甲乙丙丁');
  fireEvent.change(screen.getByRole('textbox', { name: '当前行输入' }), { target: { value: '甲乙' } });
  fireEvent.click(screen.getByRole('button', { name: '文章库' }));
  await screen.findByRole('heading', { name: '文章库' });
  fireEvent.click(screen.getByTitle('退出登录'));
  await screen.findByRole('button', { name: '登录' });
  expect(fetch.mock.calls.some(([url]) => url === '/api/auth/logout')).toBe(true);
  expect(readDraft(owner.id)?.typed).toBe('甲乙');
  expect((await readWorkspace(owner.id)).some((item) => item.kind === 'draft' && (item.value as { typed?: string }).typed === '甲乙')).toBe(true);
  more('草稿箱');
  expect(await screen.findByText('暂无草稿')).toBeTruthy();
});

it('opens login from a paused guest round without moving its draft to the account', async () => {
  const owner = { id: 'new-account', username: '新账号' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return response({ user: null });
    if (url === '/api/auth/login') return response({ user: owner });
    return response({ items: [], serverTime: Date.now() });
  }));
  render(<App />);
  await startCustom('春风细雨');
  fireEvent.change(screen.getByRole('textbox', { name: '当前行输入' }), { target: { value: '春风' } });
  fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
  await screen.findByRole('button', { name: '继续练习' });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  const login = await screen.findByRole('dialog', { name: '登录' });
  fireEvent.change(within(login).getByLabelText('用户名或邮箱'), { target: { value: 'new@example.test' } });
  fireEvent.change(within(login).getByLabelText('密码'), { target: { value: 'password123' } });
  fireEvent.click(within(login).getByRole('button', { name: '登录' }));
  await screen.findByRole('button', { name: /新账号/ });
  expect(readDraft(null)?.typed).toBe('春风');
  expect(readDraft(owner.id)).toBeNull();
  more('草稿箱');
  expect(await screen.findByText('暂无草稿')).toBeTruthy();
});
