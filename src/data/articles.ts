import { zhPassages } from './zh-library';
import { enPassages } from './en-library';

export const difficulties = ['beginner', 'intermediate', 'advanced'] as const;
export type Difficulty = typeof difficulties[number];
export type Language = 'zh' | 'en';
export type Article = { id: string; language: Language; difficulty: Difficulty; title: string; content: string };

type Passage = { title: string; content: string };
function createArticles(language: Language, difficulty: Difficulty, passages: Passage[]): Article[] {
  return passages.map((passage, index) => ({ ...passage, id: `${language}-${difficulty}-${index + 1}`, language, difficulty }));
}
export const articles: Article[] = difficulties.flatMap((difficulty) => [
  ...createArticles('zh', difficulty, zhPassages[difficulty]),
  ...createArticles('en', difficulty, enPassages[difficulty]),
]);
