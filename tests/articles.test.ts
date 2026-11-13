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

  it('provides substantial passages with length increasing by stage', () => {
    const minimumZh = { beginner: 120, intermediate: 180, advanced: 220 };
    const minimumEn = { beginner: 100, intermediate: 140, advanced: 180 };
    for (const article of articles) {
      const count = article.language === 'zh' ? (article.content.match(/\p{Script=Han}/gu) || []).length : article.content.trim().split(/\s+/).length;
      expect(count).toBeGreaterThanOrEqual(article.language === 'zh' ? minimumZh[article.difficulty] : minimumEn[article.difficulty]);
      if (article.language === 'en') expect(article.content).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
