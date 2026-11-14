// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { articles } from '../src/data/articles';
import { readDraft } from '../src/hooks/usePractice';

const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not apply a delayed submission to the next completed practice', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const { content: _content, ...article } = articles[0];
  let resolvePublish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/me') return Promise.resolve(response({ user: null }));
    if (url === '/api/articles') return Promise.resolve(response({ articles: [{ ...article, text: '甲乙丙丁', custom: false }] }));
    if (url === '/api/tests/start') return Promise.resolve(response({ id: body.clientId, target: '甲乙丙丁', claimVersion: 1 }));
    if (url.endsWith('/finish')) return Promise.resolve(response({ attemptId: url.split('/')[3], status: 'review', eligible: true, elapsedMs: 2000, score: { correct: 4, total: 4, accuracy: 100, cpm: 120, wpm: 24 } }));
    if (url === '/api/leaderboard' && options?.method === 'POST') return new Promise<Response>((resolve) => { resolvePublish = resolve; });
    return Promise.resolve(response({}));
  }));
  render(<App />);
  const input = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  await waitFor(() => expect(screen.getByTestId('article-count').textContent).toBe('4'));
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: '甲' } });
  await waitFor(() => expect(readDraft()?.id).toBeTruthy());
  time = 2000;
  fireEvent.change(input, { target: { value: '甲乙丙丁' } });
  const first = await screen.findByRole('dialog', { name: '练习成绩' });
  fireEvent.change(within(first).getByLabelText('上榜昵称'), { target: { value: '访客' } });
  fireEvent.click(within(first).getByRole('button', { name: '提交到排行榜' }));
  await waitFor(() => expect(resolvePublish).toBeTypeOf('function'));
  fireEvent.click(within(first).getByRole('button', { name: '再练一次' }));
  const secondInput = screen.getByRole('textbox', { name: '当前行输入' }) as HTMLTextAreaElement;
  fireEvent.change(secondInput, { target: { value: '甲' } });
  await waitFor(() => expect(readDraft()?.id).toBeTruthy());
  time = 4000;
  fireEvent.change(secondInput, { target: { value: '甲乙丙丁' } });
  const second = await screen.findByRole('dialog', { name: '练习成绩' });
  const newId = readDraft()?.recordId;
  await act(async () => resolvePublish(response({ status: 'review' })));
  expect(readDraft()?.recordId).toBe(newId);
  expect(within(second).queryByText('已提交，待复核。')).toBeNull();
  expect(within(second).getByRole('button', { name: '提交到排行榜' })).toBeTruthy();
});

it('unlocks the restored draft when an earlier submission is still pending', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000 + time);
  const { content: _content, ...article } = articles[0];
  let resolvePublish!: (value: Response) => void;
  const score = { correct: 4, total: 4, accuracy: 100, cpm: 120, wpm: 24 };
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/me') return Promise.resolve(response({ user: null }));
    if (url === '/api/articles') return Promise.resolve(response({ articles: [{ ...article, text: '甲乙丙丁', custom: false }] }));
    if (url === '/api/tests/start') return Promise.resolve(response({ id: body.clientId, target: '甲乙丙丁', claimVersion: 1 }));
    if (url === '/api/tests/recover') return Promise.resolve(response({ id: body.clientId, status: 'review', claimVersion: body.expectedClaimVersion + 1, typed: '甲乙丙丁', backspaces: 0,
      result: { attemptId: body.clientId, status: 'review', eligible: true, elapsedMs: 2000, score } }));
    if (url.endsWith('/finish')) return Promise.resolve(response({ attemptId: url.split('/')[3], status: 'review', eligible: true, elapsedMs: 2000, score }));
    if (url === '/api/leaderboard' && options?.method === 'POST') return new Promise<Response>((resolve) => { resolvePublish = resolve; });
    return Promise.resolve(response({}));
  }));
  render(<App />);
  let input = screen.getByRole('textbox', { name: '当前行输入' });
  await waitFor(() => expect(screen.getByTestId('article-count').textContent).toBe('4'));
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(input, { target: { value: '甲' } });
  await waitFor(() => expect(readDraft()?.id).toBeTruthy());
  time = 2000; fireEvent.change(input, { target: { value: '甲乙丙丁' } });
  let dialog = await screen.findByRole('dialog', { name: '练习成绩' });
  const firstId = readDraft()!.recordId;
  fireEvent.click(within(dialog).getByRole('button', { name: '再练一次' }));
  input = screen.getByRole('textbox', { name: '当前行输入' });
  fireEvent.change(input, { target: { value: '甲' } });
  await waitFor(() => expect(readDraft()?.recordId).not.toBe(firstId));
  time = 4000; fireEvent.change(input, { target: { value: '甲乙丙丁' } });
  dialog = await screen.findByRole('dialog', { name: '练习成绩' });
  fireEvent.change(within(dialog).getByLabelText('上榜昵称'), { target: { value: '访客' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '提交到排行榜' }));
  await waitFor(() => expect(resolvePublish).toBeTypeOf('function'));
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(screen.getByRole('button', { name: '草稿箱' }));
  const buttons = await screen.findAllByRole('button', { name: '恢复《背影》成绩' });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons.at(-1)!);
  dialog = await screen.findByRole('dialog', { name: '练习成绩' });
  await waitFor(() => expect((within(dialog).getByRole('button', { name: '提交到排行榜' }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => resolvePublish(response({ status: 'review' })));
  expect(within(dialog).queryByText('已提交，待复核。')).toBeNull();
  expect(readDraft()?.recordId).toBe(firstId);
});
