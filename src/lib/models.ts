import type { ArticleSource, Difficulty, Language } from '../data/articles';
import type { BackgroundConfig } from './background';

export type PracticeMode = 'timed' | 'article';
export type ReaderSettings = {
  minutes: number;
  mode: PracticeMode;
  strict: boolean;
  autoPause: boolean;
  fontSize: number;
  lineHeight: number;
  visibleLines: number;
  theme: 'light' | 'dark';
};
export const defaultSettings: ReaderSettings = { minutes: 5, mode: 'timed', strict: false, autoPause: true, fontSize: 18, lineHeight: 1.6, visibleLines: 4, theme: 'light' };
export type ArticleSnapshot = { id: string; title: string; text: string; language: Language; difficulty: Difficulty; custom: boolean; author?: string; theme?: string; source?: ArticleSource };
export type PrivateArticle = ArticleSnapshot & { custom: true };
export type MistakeSample = { position: number; expected: string; actual: string };
export type PracticeRecord = {
  language: Language; difficulty: Difficulty; duration: number; speed: number; accuracy: number; finishedAt: number;
  status?: string; elapsedMs?: number; backspaces?: number; errors?: number; recordId?: string; ownerId?: string | null; localOnly?: boolean;
  article?: ArticleSnapshot; typed?: string; offset?: number; total?: number; correct?: number; articleTotal?: number;
  mode?: PracticeMode; strict?: boolean; mistakes?: MistakeSample[];
};
export type SavedPractice = {
  id: string; article: ArticleSnapshot; typed: string; elapsedMs: number; backspaces: number;
  duration: number; mode: PracticeMode; strict: boolean; offset: number; recordId: string;
  attemptId?: string; offline: boolean; ownerId: string | null; savedAt: number; mistakes?: MistakeSample[]; suspicious?: boolean;
};
export type WorkspaceValues = {
  favorite: { articleId: string };
  article: PrivateArticle;
  draft: SavedPractice;
  record: PracticeRecord;
  settings: ReaderSettings;
  background: BackgroundConfig;
};
export type WorkspaceKind = keyof WorkspaceValues;
export type WorkspaceItem = { kind: WorkspaceKind; id: string; updatedAt: number; deleted?: boolean; value?: unknown };
export type SyncState = 'guest' | 'loading' | 'syncing' | 'synced' | 'error';
export type MistakeEntry = { id: string; language: Language; expected: string; actual: string[]; count: number; lastSeen: number; contexts: string[] };
export type RankingEntry = { nickname: string; speed: number; accuracy: number; guest: number; createdAt: number; attemptId: string; rank?: number; mine?: boolean; articleId?: string; mode?: PracticeMode; strict?: boolean };

export function snapshotKey(article: ArticleSnapshot) {
  let hash = 2166136261;
  for (let i = 0; i < article.text.length; i++) hash = Math.imul(hash ^ article.text.charCodeAt(i), 16777619);
  return `${article.id}:${(hash >>> 0).toString(16)}`;
}

// A catalog edit should not silently replace the selected text or its attribution.
export function catalogSnapshotKey(article: ArticleSnapshot) {
  return JSON.stringify([snapshotKey(article), article.title, article.language, article.difficulty, article.author,
    article.theme, article.source?.name, article.source?.url, article.source?.license]);
}
