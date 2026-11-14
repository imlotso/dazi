// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url === '/api/me' ? { user: null } : {},
  } as Response)));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function englishPractice() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  fireEvent.click(screen.getByRole('button', { name: '自定义文字' }));
  fireEvent.change(screen.getByLabelText('自定义文章内容'), { target: { value: 'Hi, there.' } });
  fireEvent.click(screen.getByRole('button', { name: '使用这段文字' }));
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '当前行输入' });
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
}

it('shows both English speeds in practice, based on correct characters and active time', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const input = await englishPractice();
  const speed = screen.getByRole('group', { name: '英文速度' });
  expect(within(speed).getAllByText('—')).toHaveLength(2);

  fireEvent.change(input, { target: { value: 'Hi, tX' } });
  now = 1500;
  await waitFor(() => expect(speed.textContent).toMatch(/40\s*WPM/));
  expect(speed.textContent).toMatch(/200\s*字符\/分钟/);

  fireEvent.click(screen.getByRole('button', { name: '暂停练习' }));
  const resume = await screen.findByRole('button', { name: '继续练习' });
  now = 18000;
  expect(speed.textContent).toMatch(/40\s*WPM/);
  expect(speed.textContent).toMatch(/200\s*字符\/分钟/);
  fireEvent.click(resume);
  await screen.findByRole('button', { name: '暂停练习' });
  now = 19500;
  await waitFor(() => expect(speed.textContent).toMatch(/20\s*WPM/));
  expect(speed.textContent).toMatch(/100\s*字符\/分钟/);
});

it('shows both final English speeds and explains the conversion from the result dialog', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const input = await englishPractice();
  fireEvent.change(input, { target: { value: 'H' } });
  now = 3000;
  fireEvent.change(input, { target: { value: 'Hi, there.' } });

  const dialog = await screen.findByRole('dialog', { name: '练习成绩' });
  const speed = within(dialog).getByRole('group', { name: '英文速度' });
  expect(speed.textContent).toMatch(/40\s*WPM/);
  expect(speed.textContent).toMatch(/200\s*字符\/分钟/);
  const help = within(speed).getByRole('button', { name: '英文速度说明' });
  expect(help.getAttribute('aria-expanded')).toBe('false');
  help.focus();
  const user = userEvent.setup();
  await user.keyboard('{Enter}');
  expect(help.getAttribute('aria-expanded')).toBe('true');
  expect(within(speed).getByText(/每 5 个正确字符/)).toBeTruthy();
  expect(within(speed).getByText(/暂停时间/)).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(help.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(help);
});
