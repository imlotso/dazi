export type Theme = 'light' | 'dark';
export const themeStorageKey = 'cloudtyping.theme.v1';

export function resolveTheme(saved: string | null, prefersDark: boolean): Theme {
  if (saved === 'light' || saved === 'dark') return saved;
  return prefersDark ? 'dark' : 'light';
}
