import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/lib/theme';

describe('theme preference', () => {
  it('keeps a previously chosen night mode even when the system is light', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('keeps a previously chosen light mode even when the system is dark', () => {
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('uses the system preference when no valid choice was saved', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme('invalid', false)).toBe('light');
  });
});
