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

  it('uses at least 1000 Han characters or English words for every selection', () => {
    for (const article of articles) {
      const count = article.language === 'zh' ? (article.content.match(/\p{Script=Han}/gu) || []).length : (article.content.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || []).length;
      expect(count, `${article.title} is too short`).toBeGreaterThanOrEqual(1000);
    }
  });

  it('keeps sourced texts within the draft recovery limit and removes page furniture', () => {
    for (const article of articles) {
      expect(article.content.length).toBeLessThanOrEqual(30000);
      expect(article.content).not.toMatch(/\u200b|START OF THE PROJECT GUTENBERG|END OF THE PROJECT GUTENBERG|检索自|本站的全部文字|mw-parser-output|licenseContainer|variant-tooltip/);
      if (article.language === 'en') expect(article.content).toMatch(/^[\x09\x0a\x20-\x7e]+$/);
    }
  });

  it('attributes each real work to an author and a reusable source', () => {
    for (const article of articles) {
      expect(article.author, article.title).toBeTruthy();
      expect(article.theme, article.title).toBeTruthy();
      expect(article.source?.license, article.title).toBe('public-domain');
      const url = new URL(article.source.url);
      expect(url.protocol).toBe('https:');
      expect(['zh.wikisource.org', 'www.gutenberg.org']).toContain(url.hostname);
    }
  });

  it('preserves original quotations and prose stored outside paragraph tags in the sources', () => {
    expect(articles.find((article) => article.title === '荷塘月色')?.content).toContain('可见当时嬉游的光景了。这真是有趣的事，可惜我们现在早已无福消受了。');
    const fair = articles.find((article) => article.title === '五猖会')?.content;
    expect(fair).toContain('粤自盘古，生于太荒，');
    expect(fair).toContain('首出御世，肇开混茫。');
  });
});
