// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localHistory, readDraft, readDrafts } from '../src/hooks/usePractice';

const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/me' ? { user: null } : {})));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function useText(text: string) {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '自定义文字' }));
  fireEvent.change(screen.getByLabelText('自定义文章内容'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '使用这段文字' }));
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
}

it('starts on the first actual input, not focus, and preserves that first input', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const input = await useText('甲乙丙丁');
  expect(screen.queryByRole('button', { name: '开始练习' })).toBeNull();
  input.focus(); time = 10000;
  expect(screen.getByTestId('remaining-time').textContent).toBe('05:00');
  expect(readDraft()).toBeNull();
  fireEvent.change(input, { target: { value: '甲' } });
  expect(screen.getByTestId('typed-count').textContent).toBe('1');
  expect(input.value).toBe('甲');
  expect(screen.getByRole('button', { name: '暂停练习' })).toBeTruthy();
  time = 13000;
  await waitFor(() => expect(screen.getByTestId('remaining-time').textContent).toBe('04:57'));
  expect(readDraft()?.typed).toBe('甲');
});

it('starts when an IME candidate first changes and only scores it after confirmation', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const input = await useText('你好世界');
  fireEvent.compositionStart(input);
  expect(screen.queryByRole('button', { name: '暂停练习' })).toBeNull();
  fireEvent.change(input, { target: { value: 'ni' } });
  expect(screen.getByRole('button', { name: '暂停练习' })).toBeTruthy();
  expect(screen.getByTestId('typed-count').textContent).toBe('0');
  time = 2000;
  fireEvent.change(input, { target: { value: '你' } });
  fireEvent.compositionEnd(input, { data: '你' });
  expect(input.value).toBe('你');
  expect(readDraft()?.typed).toBe('你');
  await waitFor(() => expect(screen.getByTestId('remaining-time').textContent).toBe('04:58'));
});

it('displays spaces as real blank space on all source rows, while keeping periods', async () => {
  const input = await useText('Hello world.\nNext line.');
  expect(screen.getByTestId('practice-source-0').textContent).toBe('Hello world.↵');
  expect(screen.getByTestId('practice-source-1').textContent).toBe('Next line.');
  fireEvent.change(input, { target: { value: 'Hello ' } });
  expect(screen.getByTestId('practice-source-0').textContent).toBe('Hello world.↵');
  expect(screen.getByTestId('practice-source-1').textContent).toBe('Next line.');
});

it('keeps input and elapsed time responsive while a delayed online start completes', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  let resolveStart!: (value: Response) => void;
  let id = '';
  const source = await import('../src/data/articles');
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/tests/start') { id = JSON.parse(String(options?.body)).clientId; return new Promise<Response>((resolve) => { resolveStart = resolve; }); }
    if (url.endsWith('/pause')) return Promise.resolve(response({ elapsedMs: 2000, remainingMs: 298000 }));
    return Promise.resolve(response(url === '/api/me' ? { user: null } : {}));
  }));
  render(<App />);
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  const target = screen.getByTestId('practice-source-0').getAttribute('data-text')!;
  fireEvent.change(input, { target: { value: target.slice(0, 1) } });
  expect(input.value).toBe(target.slice(0, 1));
  expect(screen.getByTestId('typed-count').textContent).toBe('1');
  time = 2000;
  await waitFor(() => expect(screen.getByTestId('remaining-time').textContent).toBe('04:58'));
  fireEvent.change(input, { target: { value: target.slice(0, 2) } });
  expect(screen.getByTestId('typed-count').textContent).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
  await act(async () => resolveStart(response({ id, target: source.articles[0].content })));
  await screen.findByRole('button', { name: '继续练习' });
  expect(readDraft()?.typed).toBe(target.slice(0, 2));
  expect(readDraft()?.offline).toBe(false);
  expect(readDraft()?.id).toBe(id);
});

it('finishes a pending online start and pause before allowing resume', async () => {
  let resolveStart!: (value: Response) => void;
  let id = '';
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    calls.push(url);
    if (url === '/api/tests/start') { id = JSON.parse(String(options?.body)).clientId; return new Promise<Response>((resolve) => { resolveStart = resolve; }); }
    if (url.endsWith('/pause') || url.endsWith('/resume')) return Promise.resolve(response({ elapsedMs: 0, remainingMs: 300000 }));
    return Promise.resolve(response(url === '/api/me' ? { user: null } : {}));
  }));
  render(<App />);
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  const source = await import('../src/data/articles');
  fireEvent.change(input, { target: { value: '我' } });
  fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
  await act(async () => resolveStart(response({ id, target: source.articles[0].content })));
  fireEvent.click(await screen.findByRole('button', { name: '继续练习' }));
  await screen.findByRole('button', { name: '暂停练习' });
  expect(readDraft()?.offline).toBe(false);
  expect(readDraft()?.id).toBe(id);
  expect(calls).toContain(`/api/tests/${id}/pause`);
  expect(calls).toContain(`/api/tests/${id}/resume`);
});

it('uses the newly selected duration for the first input and online request', async () => {
  const calls: Array<{ duration: number }> = [];
  const source = await import('../src/data/articles');
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/tests/start') {
      calls.push(JSON.parse(String(options?.body)));
      return response({ id: JSON.parse(String(options?.body)).clientId, target: source.articles[0].content });
    }
    return response(url === '/api/me' ? { user: null } : {});
  }));
  render(<App />);
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(screen.getByRole('spinbutton', { name: '测试时间（分钟）' }), { target: { value: '1' } });
  expect(screen.getByTestId('remaining-time').textContent).toBe('01:00');
  fireEvent.change(input, { target: { value: '我' } });
  expect(readDraft()?.duration).toBe(60);
  expect(calls[0].duration).toBe(60);
  expect(screen.getByTestId('remaining-time').textContent).toBe('01:00');
});

it('uses the latest practice mode when input starts', async () => {
  const input = await useText('甲乙丙丁');
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.change(screen.getByLabelText('练习模式'), { target: { value: 'article' } });
  await waitFor(() => expect((screen.getByLabelText('练习模式') as HTMLSelectElement).value).toBe('article'));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.change(input, { target: { value: '甲' } });
  expect(readDraft()?.mode).toBe('article');
  expect(screen.getByText(/用时/)).toBeTruthy();
});


it('keeps the server identity when a submitted result response is lost', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const source = await import('../src/data/articles');
  const { content: _content, ...article } = source.articles[0];
  let id = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/me') return response({ user: null });
    if (url === '/api/articles') return response({ articles: [{ ...article, text: '甲乙丙丁', custom: false }] });
    if (url === '/api/tests/start') { id = JSON.parse(String(options?.body)).clientId; return response({ id, target: '甲乙丙丁' }); }
    if (url.endsWith('/pause')) return response({ elapsedMs: 3000, remainingMs: 297000 });
    if (url.endsWith('/finish')) throw new Error('connection lost after server accepted');
    return response({});
  }));
  render(<App />);
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(screen.getByTestId('article-count').textContent).toBe('4'));
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: '甲' } });
  await waitFor(() => expect(readDraft()?.id).toBe(id));
  time = 3000;
  fireEvent.click(screen.getByRole('button', { name: '结束练习' }));
  await screen.findByRole('dialog', { name: '结束本次练习？' });
  fireEvent.click(screen.getByRole('button', { name: '结束并查看成绩' }));
  await screen.findByRole('dialog', { name: '练习成绩' });
  expect(localHistory()[0].recordId).toBe(id);
  expect(readDrafts().some((draft) => draft.recordId === `${id}~1`)).toBe(true);
});

it('keeps one result across tabs when a completed round is still starting online', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const source = await import('../src/data/articles');
  const { content: _content, ...article } = source.articles[0];
  let resolveStart!: (value: Response) => void;
  let id = '';
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/me') return Promise.resolve(response({ user: null }));
    if (url === '/api/articles') return Promise.resolve(response({ articles: [{ ...article, text: '甲乙丙丁', custom: false }] }));
    if (url === '/api/tests/start') {
      id = JSON.parse(String(options?.body)).clientId ?? 'server-duplicate';
      return new Promise<Response>((resolve) => { resolveStart = resolve; });
    }
    if (url === `/api/tests/${id}`) return Promise.resolve(response({ elapsedMs: 3000, remainingMs: 297000 }));
    if (url.endsWith('/finish')) return Promise.resolve(response({ attemptId: id, score: { correct: 4, total: 4, accuracy: 100, cpm: 80, wpm: 16 }, elapsedMs: 3000, status: 'review', eligible: true }));
    return Promise.resolve(response({}));
  }));
  const first = render(<App />);
  const firstInput = first.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(first.getByTestId('article-count').textContent).toBe('4'));
  await waitFor(() => expect(firstInput.disabled).toBe(false));
  fireEvent.change(firstInput, { target: { value: '甲' } });
  time = 3000;
  fireEvent.change(firstInput, { target: { value: '甲乙丙丁' } });
  const second = render(<App />);
  await waitFor(() => expect((within(second.container).getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.queryByRole('dialog', { name: '练习成绩' })).toBeNull();
  expect(localHistory()).toHaveLength(0);
  await act(async () => resolveStart(response({ id, target: '甲乙丙丁' })));
  await screen.findByRole('dialog', { name: '练习成绩' });
  expect(localHistory()).toHaveLength(1);
});

it('saves the first confirmed character before an automatic hidden-page pause', async () => {
  const input = await useText('甲乙丙丁');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent.change(input, { target: { value: '甲' } });
  await screen.findByRole('button', { name: '继续练习' });
  expect(readDraft()?.typed).toBe('甲');
  expect(screen.getByTestId('typed-count').textContent).toBe('1');
});

it('releases a pending start on pagehide so the next page can restore and sync', async () => {
  const { readWorkspace } = await import('../src/lib/workspace');
  let resolveStart!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/tests/start'
    ? new Promise<Response>((resolve) => { resolveStart = resolve; })
    : Promise.resolve(response(url === '/api/me' ? { user: null } : {}))));
  const first = render(<App />);
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: '我' } });
  fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
  fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
  expect(readDraft()).toMatchObject({ typed: '我', pendingStart: false, leaseOwner: null });
  first.unmount();
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '继续练习' }));
  await screen.findByRole('button', { name: '暂停练习' });
  fireEvent.change(screen.getByRole('textbox', { name: '当前行输入' }), { target: { value: '我与' } });
  fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
  await screen.findByRole('button', { name: '继续练习' });
  await waitFor(async () => expect((await readWorkspace(null)).some((item) => item.kind === 'draft' && !item.deleted && (item.value as { typed?: string })?.typed === '我与')).toBe(true));
  await act(async () => resolveStart(response({ id: 'late', target: 'ignored' })));
});
