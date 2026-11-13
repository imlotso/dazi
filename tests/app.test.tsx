// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { readDraft } from '../src/hooks/usePractice';

type RequestInitWithBody = RequestInit & { body?: string };
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;

async function startPractice(container?: HTMLElement) {
  const queries = container ? within(container) : screen;
  const button = await queries.findByRole('button', { name: '开始练习' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete document.documentElement.dataset.theme;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/me' ? { user: null } : {})));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('practice interface', () => {
  it('switches to night mode and remembers the choice on a later visit', async () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '切换至夜间模式' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('cloudtyping.theme.v1')).toBe('dark');
    first.unmount();
    render(<App />);
    expect(screen.getByRole('button', { name: '切换至日间模式' })).toBeTruthy();
  });

  it('does not count an IME candidate confirmed after the deadline', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let finishBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInitWithBody) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url === '/api/tests/test/finish') {
        finishBody = JSON.parse(options?.body || '{}');
        return response({ attemptId: 'test', score: { correct: 0, total: 0, accuracy: 0, cpm: 0, wpm: 0 }, status: 'finished', eligible: false });
      }
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '你' } });
    time = 300_001;
    fireEvent.compositionEnd(input, { data: '你' });
    await waitFor(() => expect(finishBody).toBeDefined());
    expect(finishBody?.typed).toBe('');
  });

  it('keeps the active language leaderboard when an older response arrives later', async () => {
    const pending = new Map<string, (value: Response) => void>();
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/me') return Promise.resolve(response({ user: null }));
      if (url.startsWith('/api/leaderboard?')) return new Promise<Response>((resolve) => pending.set(url.includes('language=zh') ? 'zh' : 'en', resolve));
      return Promise.resolve(response({}));
    }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
    await waitFor(() => expect(pending.has('zh')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(pending.has('en')).toBe(true));
    await act(async () => pending.get('en')!(response({ entries: [{ nickname: 'English player', speed: 60, accuracy: 99, guest: 1, createdAt: 1, attemptId: 'en' }] })));
    expect(screen.getByText('English player')).toBeTruthy();
    await act(async () => pending.get('zh')!(response({ entries: [{ nickname: '中文旧成绩', speed: 80, accuracy: 98, guest: 1, createdAt: 1, attemptId: 'zh' }] })));
    expect(screen.queryByText('中文旧成绩')).toBeNull();
    expect(screen.getByText('English player')).toBeTruthy();
  });

  it('keeps the score submission available when a network request fails', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInitWithBody) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url === '/api/tests/test/finish') return response({ attemptId: 'test', score: { correct: 1, total: 1, accuracy: 100, cpm: 1, wpm: 0.2 }, status: 'finished', eligible: true });
      if (url === '/api/leaderboard' && options?.method === 'POST') return response({ error: '提交失败，请重试' }, false);
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: '你' } });
    time = 300_001;
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByRole('textbox', { name: '上榜昵称' }), { target: { value: '小云' } });
    fireEvent.click(screen.getByRole('button', { name: '提交到排行榜' }));
    await screen.findByText('提交失败，请重试');
    expect(screen.getByRole('button', { name: '提交到排行榜' })).toBeTruthy();
  });

  it('keeps a completed test bound to its language while the score is being saved', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/me') return Promise.resolve(response({ user: null }));
      if (url === '/api/tests/start') return Promise.resolve(response({ id: 'test', target: '你好世界' }));
      if (url === '/api/tests/test/finish') return new Promise<Response>((resolve) => { finish = resolve; });
      return Promise.resolve(response({ ok: true }));
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: '你' } });
    time = 300_001;
    await waitFor(() => expect(finish).toBeDefined());
    expect((screen.getByRole('button', { name: 'English' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(response({ attemptId: 'test', score: { correct: 1, total: 1, accuracy: 100, cpm: 1, wpm: 0.2 }, status: 'finished', eligible: true })));
    expect(screen.getByText('字 / 分钟')).toBeTruthy();
  });

  it('defaults to five minutes and only accepts a whole number from 1 to 60', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '开始练习' });
    const duration = screen.getByRole('spinbutton', { name: '测试时间（分钟）' }) as HTMLInputElement;
    expect(duration.value).toBe('5');
    fireEvent.change(duration, { target: { value: '0' } });
    expect((screen.getByRole('button', { name: '开始练习' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(duration, { target: { value: '61' } });
    expect((screen.getByRole('button', { name: '开始练习' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(duration, { target: { value: '1' } });
    expect((screen.getByRole('button', { name: '开始练习' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('counts only committed IME text, shows errors and backspaces, and finishes when the article is complete', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let finishBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInitWithBody) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url === '/api/tests/test/finish') {
        finishBody = JSON.parse(options?.body || '{}');
        return response({ attemptId: 'test', score: { correct: 3, total: 4, accuracy: 75, cpm: 60, wpm: 12 }, elapsedMs: 3000, status: 'review', eligible: true });
      }
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.getByTestId('article-count').textContent).toBe('4');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '你好' } });
    expect(screen.getByTestId('typed-count').textContent).toBe('0');
    fireEvent.compositionEnd(input, { data: '你好' });
    expect(screen.getByTestId('typed-count').textContent).toBe('2');
    fireEvent.change(input, { target: { value: '你好错' } });
    expect(screen.getByTestId('error-count').textContent).toBe('1');
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.change(input, { target: { value: '你好' } });
    expect(screen.getByTestId('backspace-count').textContent).toBe('1');
    time = 3000;
    fireEvent.change(input, { target: { value: '你好错界' } });
    await waitFor(() => expect(finishBody).toBeDefined());
    expect(finishBody).toMatchObject({ typed: '你好错界', backspaces: 1, early: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('restores unfinished text and backspace count in a paused state after reload', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url.endsWith('/pause') || url.endsWith('/resume')) return response({ elapsedMs: 5000, remainingMs: 295000 });
      return response({ ok: true });
    }));
    const first = render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    time = 5000;
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.change(input, { target: { value: '你' } });
    first.unmount();
    render(<App />);
    await screen.findByRole('button', { name: '继续练习' });
    expect((screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement).value).toBe('你');
    expect(screen.getByTestId('backspace-count').textContent).toBe('1');
    expect(screen.getByTestId('remaining-time').textContent).toBe('04:55');
  });

  it('does not count paused time and resumes from the remaining time', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url.endsWith('/pause') || url.endsWith('/resume')) return response({ elapsedMs: 10_000, remainingMs: 290_000 });
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    await waitFor(() => expect((screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement).disabled).toBe(false));
    time = 10_000;
    fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
    await screen.findByRole('button', { name: '继续练习' });
    expect(screen.getByTestId('remaining-time').textContent).toBe('04:50');
    time = 50_000;
    expect(screen.getByTestId('remaining-time').textContent).toBe('04:50');
    fireEvent.click(screen.getByRole('button', { name: '继续练习' }));
    await screen.findByRole('button', { name: '暂停练习' });
    time = 60_000;
    await waitFor(() => expect(screen.getByTestId('remaining-time').textContent).toBe('04:40'));
  });

  it('counts a mobile delete input without counting the same physical key twice', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: '你好' } });
    time = 1000;
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.input(input, { target: { value: '你' }, inputType: 'deleteContentBackward' });
    expect(screen.getByTestId('backspace-count').textContent).toBe('1');
    time = 2000;
    fireEvent.input(input, { target: { value: '' }, inputType: 'deleteContentBackward' });
    expect(screen.getByTestId('backspace-count').textContent).toBe('2');
  });

  it('does not count IME candidate editing as deleting committed article text', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Backspace', isComposing: true });
    expect(screen.getByTestId('backspace-count').textContent).toBe('0');
    fireEvent.compositionEnd(input, { data: '' });
    fireEvent.keyDown(input, { key: 'Backspace', isComposing: false });
    expect(screen.getByTestId('backspace-count').textContent).toBe('1');
  });

  it('lets the user paste a custom article for local practice', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '自定义文字' }));
    fireEvent.change(screen.getByRole('textbox', { name: '自定义文章内容' }), { target: { value: '自己选择的练习文字。' } });
    fireEvent.click(screen.getByRole('button', { name: '使用这段文字' }));
    expect(screen.getByRole('region', { name: '文章练习' }).textContent).toContain('自己选择的练习文字。');
  });

  it('recovers a completed result after refresh while the finish request is in flight', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let resolveFirst!: (value: Response) => void;
    const savedResult = { attemptId: 'test', score: { correct: 4, total: 4, accuracy: 100, cpm: 80, wpm: 16 }, elapsedMs: 3000, status: 'review', eligible: true };
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInitWithBody) => {
      if (url === '/api/me') return Promise.resolve(response({ user: null }));
      if (url === '/api/tests/start') return Promise.resolve(response({ id: 'test', target: '你好世界' }));
      if (url === '/api/tests/test/finish' && options?.method === 'POST') return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      if (url === '/api/tests/test') return Promise.resolve(response({ status: 'review', elapsedMs: 3000, remainingMs: 297000, duration: 300, result: savedResult }));
      return Promise.resolve(response({ ok: true }));
    }));
    const first = render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    time = 3000;
    fireEvent.change(input, { target: { value: '你好世界' } });
    await waitFor(() => expect(resolveFirst).toBeDefined());
    first.unmount();
    render(<App />);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('80')).toBeTruthy();
    await act(async () => resolveFirst(response(savedResult)));
  });

  it('shows the local result after restoring a draft at the time limit', async () => {
    localStorage.setItem('cloudtyping.practice.v1', JSON.stringify({ version: 1, articleId: 'custom', title: '自定义文字', text: '你好世界', target: '你好世界', language: 'zh', difficulty: 'beginner', duration: 60, custom: true, offline: true, elapsedMs: 60_000, typed: '你好', backspaces: 1, suspicious: false }));
    render(<App />);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('2 / 4')).toBeTruthy();
  });

  it('preserves another tab’s unfinished draft when one practice ends', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') { starts++; return response({ id: `test-${starts}`, target: starts === 1 ? '甲' : '乙丙' }); }
      if (url.endsWith('/finish')) return response({ attemptId: 'test-1', score: { correct: 1, total: 1, accuracy: 100, cpm: 20, wpm: 4 }, elapsedMs: 3000, status: 'review', eligible: true });
      return response({ ok: true });
    }));
    const first = render(<App />);
    const second = render(<App />);
    await startPractice(first.container);
    const firstInput = first.container.querySelector<HTMLTextAreaElement>('textarea')!;
    await waitFor(() => expect(firstInput.disabled).toBe(false));
    await startPractice(second.container);
    const secondInput = second.container.querySelector<HTMLTextAreaElement>('textarea')!;
    await waitFor(() => expect(secondInput.disabled).toBe(false));
    fireEvent.change(secondInput, { target: { value: '乙' } });
    time = 3000;
    fireEvent.change(firstInput, { target: { value: '甲' } });
    await within(first.container).findByRole('dialog');
    expect(readDraft()?.typed).toBe('乙');
  });

  it('returns from browser back-forward cache in a paused state without counting the absence', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url.endsWith('/pause') || url.endsWith('/resume')) return response({ elapsedMs: 5000, remainingMs: 295000 });
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    await waitFor(() => expect((screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement).disabled).toBe(false));
    time = 5000;
    fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
    time = 25000;
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
    await screen.findByRole('button', { name: '继续练习' });
    expect(screen.getByTestId('remaining-time').textContent).toBe('04:55');
  });

  it('shows a signed-in user their own offline practice records', async () => {
    localStorage.setItem('cloudtyping.history.v1', JSON.stringify([{ language: 'zh', difficulty: 'beginner', duration: 300, speed: 45, accuracy: 98, finishedAt: 1_800_000_000_000, recordId: 'local', ownerId: 'u1', localOnly: true }]));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: { id: 'u1', username: 'alice', email: 'alice@example.com', isAdmin: false } });
      if (url === '/api/history') return response({ entries: [] });
      return response({ ok: true });
    }));
    render(<App />);
    await screen.findByRole('button', { name: /alice/ });
    fireEvent.click(screen.getByRole('button', { name: '我的记录' }));
    expect(await screen.findByText(/45 字\/分/)).toBeTruthy();
  });

  it('keeps unassigned local records visible after the account becomes available', async () => {
    localStorage.setItem('cloudtyping.history.v1', JSON.stringify([{ language: 'zh', difficulty: 'beginner', duration: 300, speed: 38, accuracy: 97, finishedAt: 1_800_000_000_000, recordId: 'offline', ownerId: null, localOnly: true }]));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: { id: 'u1', username: 'alice', email: 'alice@example.com', isAdmin: false } });
      if (url === '/api/history') return response({ entries: [] });
      return response({ ok: true });
    }));
    render(<App />);
    await screen.findByRole('button', { name: /alice/ });
    fireEvent.click(screen.getByRole('button', { name: '我的记录' }));
    expect(await screen.findByText(/38 字\/分/)).toBeTruthy();
    expect(screen.getByText('本机未同步')).toBeTruthy();
  });

  it('waits for the current account before starting an offline practice', async () => {
    let resolveUser!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/me') return new Promise<Response>((resolve) => { resolveUser = resolve; });
      return Promise.resolve(response({ ok: true }));
    }));
    render(<App />);
    expect((screen.getByRole('button', { name: /准备中|开始练习/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveUser(response({ user: { id: 'u1', username: 'alice', email: 'alice@example.com', isAdmin: false } })));
    expect((screen.getByRole('button', { name: '开始练习' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards an unfinished IME candidate when a paused page is restored', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: 'test', target: '你好世界' });
      if (url.endsWith('/pause') || url.endsWith('/resume')) return response({ elapsedMs: 5000, remainingMs: 295000 });
      return response({ ok: true });
    }));
    render(<App />);
    await startPractice();
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: '你' } });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '你hao' } });
    fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
    fireEvent.compositionEnd(input, { data: 'hao' });
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
    await screen.findByRole('button', { name: '继续练习' });
    expect(input.value).toBe('你');
    expect(screen.getByTestId('typed-count').textContent).toBe('1');
  });

  it('copies a draft already active in another tab instead of deleting it on completion', async () => {
    const shared = { version: 1, articleId: 'custom', title: '自定义文字', text: '你好世界', target: '你好世界', language: 'zh', difficulty: 'beginner', duration: 300, custom: true, ownerId: null, offline: true, elapsedMs: 5000, typed: '你', backspaces: 0, suspicious: false, recordId: 'shared', savedAt: Date.now(), leaseOwner: 'another-tab', leaseAt: Date.now() };
    localStorage.setItem('cloudtyping.practice.v2.shared', JSON.stringify(shared));
    render(<App />);
    await screen.findByRole('button', { name: '继续练习' });
    await waitFor(() => expect((screen.getByRole('button', { name: '继续练习' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '继续练习' }));
    const input = screen.getByRole('textbox', { name: /在此输入上方文章/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: '你好世界' } });
    await screen.findByRole('dialog');
    expect(JSON.parse(localStorage.getItem('cloudtyping.practice.v2.shared') || 'null')?.typed).toBe('你');
  });

  it('does not overwrite a newer draft when returning from browser cache', async () => {
    const shared = { version: 1, articleId: 'custom', title: '自定义文字', text: '你好世界', target: '你好世界', language: 'zh', difficulty: 'beginner', duration: 300, custom: true, ownerId: null, offline: true, elapsedMs: 5000, typed: '你', backspaces: 0, suspicious: false, recordId: 'shared', revision: 1, savedAt: Date.now() };
    localStorage.setItem('cloudtyping.practice.v2.shared', JSON.stringify(shared));
    render(<App />);
    const continueButton = await screen.findByRole('button', { name: '继续练习' });
    await waitFor(() => expect((continueButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(continueButton);
    await screen.findByRole('button', { name: '暂停练习' });
    fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
    const current = JSON.parse(localStorage.getItem('cloudtyping.practice.v2.shared') || 'null');
    localStorage.setItem('cloudtyping.practice.v2.shared', JSON.stringify({ ...current, typed: '你好', revision: current.revision + 1, leaseOwner: null, leaseAt: 0 }));
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
    await screen.findByRole('button', { name: '继续练习' });
    expect(JSON.parse(localStorage.getItem('cloudtyping.practice.v2.shared') || 'null')?.typed).toBe('你好');
  });
});
