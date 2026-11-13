import { describe, expect, it } from 'vitest';
import { articles, difficulties } from '../src/data/articles';

describe('built-in article library', () => {
  it.each(['zh', 'en'] as const)('contains at least 20 distinct %s articles', (language) => {
    const list = articles.filter((article) => article.language === language);
    expect(list.length).toBeGreaterThanOrEqual(20);
    expect(new Set(list.map((article) => article.id)).size).toBe(list.length);
    expect(new Set(list.map((article) => article.title)).size).toBe(list.length);
    expect(new Set(list.map((article) => article.content)).size).toBe(list.length);
  });

  it.each(['zh', 'en'] as const)('covers all three stages in %s', (language) => {
    for (const difficulty of difficulties) {
      expect(articles.filter((article) => article.language === language && article.difficulty === difficulty).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('contains usable passages, not single-sentence placeholders', () => {
    for (const article of articles) {
      expect(article.content.length).toBeGreaterThanOrEqual(article.language === 'zh' ? 80 : 180);
    }
  });
});
