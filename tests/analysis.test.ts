import { describe, expect, it } from 'vitest';
import { calculateStats, collectMistakes, createMistakeDrill } from '../src/lib/analysis';
import type { ArticleSnapshot, PracticeRecord } from '../src/lib/models';

const base: PracticeRecord = {
  language: 'en', difficulty: 'beginner', duration: 300, speed: 60, accuracy: 90,
  finishedAt: new Date(2026, 10, 13, 9).getTime(),
};
const article: ArticleSnapshot = {
  id: 'story', title: 'A letter', text: 'A letter, a letter.', language: 'en', difficulty: 'beginner', custom: false,
};

describe('mistake notebook', () => {
  it('groups corrected English mistakes by source word and preserves punctuation', () => {
    const entries = collectMistakes([{ ...base, article, typed: article.text, mistakes: [
      { position: 3, expected: 'e', actual: 'a' },
      { position: 14, expected: 't', actual: 'r' },
      { position: 8, expected: ',', actual: '.' },
    ] }]);
    expect(entries.find((entry) => entry.expected === 'letter')).toMatchObject({
      count: 2, actual: ['latter', 'lerter'], lastSeen: base.finishedAt,
    });
    expect(entries.find((entry) => entry.expected === ',')).toMatchObject({ count: 1, actual: ['.'] });
    const drill = createMistakeDrill(entries, 'en');
    expect(drill).toMatchObject({ custom: true, language: 'en', text: 'letter,' });
  });

  it('keeps source context when a newline is the only selected mistake', () => {
    const multiline = { ...article, text: 'A letter\nfrom home.' };
    const entries = collectMistakes([{ ...base, article: multiline, typed: 'A letter,', mistakes: [
      { position: 8, expected: '\n', actual: ',' },
    ] }]);
    expect(createMistakeDrill(entries, 'en').text).toBe('A letter\nfrom home.');
  });

  it('skips previous rounds when deriving mistakes from stored input', () => {
    const chinese = { ...article, language: 'zh' as const, text: '春风细雨。' };
    const entries = collectMistakes([{ ...base, language: 'zh', article: chinese, typed: '村风戏', offset: 2 }]);
    expect(entries.map(({ expected, actual }) => [expected, actual])).toEqual([['细', ['戏']]]);
  });
});

describe('progress statistics', () => {
  it('keeps legacy scores, excludes other languages and sums only known active time', () => {
    const now = new Date(2026, 10, 13, 12);
    const today = { ...base, speed: 30, accuracy: 100, elapsedMs: 5000 };
    const firstDay = { ...base, finishedAt: new Date(2026, 10, 7, 0).getTime() };
    const tooOld = { ...base, finishedAt: new Date(2026, 10, 6, 23, 59).getTime() };
    const otherLanguage = { ...today, language: 'zh' as const };
    const stats = calculateStats([today, firstDay, tooOld, otherLanguage], 'en', 7, now);
    expect(stats).toMatchObject({ sessions: 2, elapsedMs: 5000, timedSessions: 1, bestSpeed: 60, averageSpeed: 45, averageAccuracy: 95 });
    expect(stats.daily).toHaveLength(7);
    expect(stats.daily[0]).toMatchObject({ sessions: 1, speed: 60, accuracy: 90 });
    expect(stats.daily[1]).toMatchObject({ sessions: 0, speed: null, accuracy: null });
    expect(stats.daily[6]).toMatchObject({ sessions: 1, speed: 30, accuracy: 100 });
  });
});
