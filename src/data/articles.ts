import { zhPassages } from './zh-library.js';
import { enPassages } from './en-library.js';

export const difficulties = ['beginner', 'intermediate', 'advanced'] as const;
export type Difficulty = typeof difficulties[number];
export type Language = 'zh' | 'en';
export type ArticleSource = { name: string; url: string; license: 'public-domain' | 'reusable' };
export type Passage = { title: string; content: string; author: string; theme: string; source: ArticleSource };
export type Article = Passage & { id: string; language: Language; difficulty: Difficulty };

function createArticles(language: Language, difficulty: Difficulty, passages: Passage[]): Article[] {
  return passages.map((passage, index) => ({ ...passage, id: `${language}-${difficulty}-${index + 1}`, language, difficulty }));
}
export const articles: Article[] = difficulties.flatMap((difficulty) => [
  ...createArticles('zh', difficulty, zhPassages[difficulty]),
  ...createArticles('en', difficulty, enPassages[difficulty]),
]);
