// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { localHistory, readDraft } from '../src/hooks/usePractice';
import { articles } from '../src/data/articles';

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ user: null }) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function customPractice(text = '甲乙\n丙丁\n戊己') {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '自定义文字' }));
  fireEvent.change(screen.getByLabelText('自定义文章内容'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '使用这段文字' }));
  await waitFor(() => expect(activeInput().disabled).toBe(false));
  beginWithCancelledComposition();
}
function activeInput() { return screen.getByRole('textbox', { name: /当前行输入/ }) as HTMLTextAreaElement; }
function beginWithCancelledComposition() {
  const input = activeInput();
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: 'x' } });
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.compositionEnd(input, { data: '' });
}

describe('line-by-line practice', () => {
  it('returns the passage to its beginning when restarting after scrolling', async () => {
    await customPractice();
    const viewport = screen.getByLabelText('当前文章：自定义文字');
    fireEvent.scroll(viewport, { target: { scrollTop: 200 } });
    fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
    await screen.findByRole('button', { name: '继续练习' });
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认重新开始' }));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.getByTestId('typed-count').textContent).toBe('0');
  });

  it('advances to the next paired input and backspaces across a boundary without losing progress', async () => {
    await customPractice();
    const first = activeInput();
    fireEvent.change(first, { target: { value: '甲乙\n' } });
    const second = activeInput();
    expect(second).not.toBe(first);
    expect(second.value).toBe('');
    expect(first.value).toBe('甲乙\n');
    expect(readDraft()?.typed).toBe('甲乙\n');
    fireEvent.keyDown(second, { key: 'Backspace' });
    expect(activeInput()).toBe(first);
    expect(first.value).toBe('甲乙');
    expect(screen.getByTestId('backspace-count').textContent).toBe('1');
    fireEvent.change(first, { target: { value: '甲乙\n' } });
    fireEvent.change(activeInput(), { target: { value: '丙' } });
    expect(readDraft()?.typed).toBe('甲乙\n丙');
  });

  it('handles software-keyboard backspace on an empty row through beforeinput exactly once', async () => {
    await customPractice();
    fireEvent.change(activeInput(), { target: { value: '甲乙\n' } });
    const second = activeInput();
    const deletion = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
    act(() => { second.dispatchEvent(deletion); });
    expect(deletion.defaultPrevented).toBe(true);
    expect(activeInput().value).toBe('甲乙');
    expect(readDraft()?.typed).toBe('甲乙');
    expect(screen.getByTestId('backspace-count').textContent).toBe('1');
  });

  it('commits an IME phrase spanning rows once and ignores its trailing old-input event', async () => {
    await customPractice();
    const first = activeInput();
    fireEvent.compositionStart(first);
    fireEvent.change(first, { target: { value: '甲乙\n丙' } });
    expect(screen.getByTestId('typed-count').textContent).toBe('0');
    expect(activeInput()).toBe(first);
    fireEvent.compositionEnd(first, { data: '甲乙\n丙' });
    expect(activeInput()).not.toBe(first);
    expect(activeInput().value).toBe('丙');
    fireEvent.change(first, { target: { value: '甲乙\n丙' } });
    expect(readDraft()?.typed).toBe('甲乙\n丙');
    fireEvent.change(activeInput(), { target: { value: '丙丁\n戊己' } });
    await screen.findByRole('dialog', { name: '练习成绩' });
    expect(localHistory()[0].accuracy).toBe(100);
  });

  it('preserves the caret when IME corrects text in the middle of the current row', async () => {
    await customPractice('甲乙丙丁戊己庚辛');
    const input = activeInput();
    fireEvent.change(input, { target: { value: '甲错丙错戊己' } });
    input.setSelectionRange(1, 2);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '甲乙丙错戊己' } });
    input.setSelectionRange(2, 2);
    fireEvent.compositionEnd(input, { data: '乙' });
    expect(input.selectionStart).toBe(2);
    expect(readDraft()?.typed).toBe('甲乙丙错戊己');
  });

  it('restores the correct row paused after a reload', async () => {
    await customPractice();
    fireEvent.change(activeInput(), { target: { value: '甲乙\n丙' } });
    fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
    await screen.findByRole('button', { name: '继续练习' });
    cleanup(); render(<App />);
    const resume = await screen.findByRole('button', { name: '继续练习' });
    expect(activeInput().value).toBe('丙');
    expect(activeInput().disabled).toBe(true);
    await waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resume);
    expect(activeInput().disabled).toBe(false);
    expect(readDraft()?.typed).toBe('甲乙\n丙');
  });

  it('keeps the composing input stable while resizing, then reflows the committed text', async () => {
    let width = 88;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (text: string) => ({ width: text.length * 10 }) } as CanvasRenderingContext2D);
    await customPractice('abcdefghijklmno');
    expect(screen.getByTestId('practice-source-0').getAttribute('data-text')).toBe('abcdef');
    const first = activeInput();
    fireEvent.compositionStart(first);
    fireEvent.change(first, { target: { value: 'abcdefg' } });
    width = 128;
    fireEvent(window, new Event('resize'));
    expect(screen.getByTestId('practice-source-0').getAttribute('data-text')).toBe('abcdef');
    expect(activeInput()).toBe(first);
    fireEvent.compositionEnd(first, { data: 'abcdefg' });
    expect(screen.getByTestId('practice-source-0').getAttribute('data-text')).toBe('abcdefghij');
    expect(activeInput().value).toBe('abcdefg');
    expect(readDraft()?.typed).toBe('abcdefg');
  });

  it('allows a literal Tab only when required by the article', async () => {
    await customPractice('甲\t乙\n丙');
    fireEvent.change(activeInput(), { target: { value: '甲' } });
    activeInput().setSelectionRange(1, 1);
    fireEvent.keyDown(activeInput(), { key: 'Tab' });
    expect(readDraft()?.typed).toBe('甲\t');
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    activeInput().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('settles an expired composition without displaying unconfirmed text', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    await customPractice();
    const input = activeInput();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'jia' } });
    time = 300001;
    await screen.findByRole('dialog', { name: '练习成绩' });
    expect(input.value).toBe('');
    expect(localHistory()[0].errors).toBe(0);
  });

  it('does not open a restart confirmation if the timer expires during that action', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    await customPractice();
    time = 300001;
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    await screen.findByRole('dialog', { name: '练习成绩' });
    expect(screen.queryByRole('dialog', { name: '重新开始本次练习？' })).toBeNull();
  });

  it('waits for online restoration before allowing the open restart dialog to discard progress', async () => {
    let resolvePause!: (value: Response) => void;
    let pauseCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      const response = (value: unknown) => Promise.resolve({ ok: true, json: async () => value } as Response);
      if (url === '/api/me') return response({ user: null });
      if (url === '/api/tests/start') return response({ id: JSON.parse(String(options?.body)).clientId, target: articles[0].content });
      if (url.endsWith('/pause') && ++pauseCalls === 2) return new Promise<Response>((resolve) => { resolvePause = resolve; });
      return response({ elapsedMs: 0, remainingMs: 300000 });
    }));
    render(<App />);
    await waitFor(() => expect(activeInput().disabled).toBe(false));
    beginWithCancelledComposition();
    await screen.findByRole('button', { name: '暂停练习' });
    fireEvent.change(activeInput(), { target: { value: '甲' } });
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    const dialog = await screen.findByRole('dialog', { name: '重新开始本次练习？' });
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
    expect((within(dialog).getByRole('button', { name: '确认重新开始' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolvePause({ ok: true, json: async () => ({ elapsedMs: 0, remainingMs: 300000 }) } as Response));
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重新开始' }));
    expect(activeInput().disabled).toBe(false);
    expect(readDraft()).toBeNull();
    beginWithCancelledComposition();
    await screen.findByRole('button', { name: '暂停练习' });
    expect(activeInput().disabled).toBe(false);
  });

  it('cancels restart without losing text, then confirms an early finish with paused time excluded', async () => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    await customPractice();
    time = 3000;
    fireEvent.change(activeInput(), { target: { value: '甲错' } });
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    const restart = await screen.findByRole('dialog', { name: '重新开始本次练习？' });
    time = 13000;
    fireEvent.click(within(restart).getByRole('button', { name: '继续当前练习' }));
    await screen.findByRole('button', { name: '暂停练习' });
    expect(readDraft()?.typed).toBe('甲错');
    time = 15000;
    fireEvent.click(screen.getByRole('button', { name: '结束练习' }));
    const ending = await screen.findByRole('dialog', { name: '结束本次练习？' });
    time = 25000;
    fireEvent.click(within(ending).getByRole('button', { name: '结束并查看成绩' }));
    const result = await screen.findByRole('dialog', { name: '练习成绩' });
    expect(localHistory()[0].elapsedMs).toBe(5000);
    expect(localHistory()[0].errors).toBe(1);
    expect(result.textContent).toContain('错字回看');
    fireEvent.click(within(result).getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '查看本次成绩' }));
    expect(await screen.findByRole('dialog', { name: '练习成绩' })).toBeTruthy();
    expect(localHistory()).toHaveLength(1);
  });
});
