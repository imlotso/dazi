import type { Language } from '../data/articles';
import { snapshotKey, type ArticleSnapshot, type MistakeEntry, type MistakeSample, type PracticeRecord } from './models';
import { splitCharacters } from './scoring';

export const MAX_PRIVATE_CHARACTERS = 20_000;
export const MAX_PRIVATE_BYTES = 100_000;

const englishWordPattern = /\p{Script=Latin}+(?:['’\-]\p{Script=Latin}+)*/gu;

export function articleLength(article: ArticleSnapshot) {
  const pattern = article.language === 'zh' ? /\p{Script=Han}/gu : englishWordPattern;
  return (article.text.match(pattern) ?? []).length;
}

export function recordMistakes(record: PracticeRecord, target = splitCharacters(record.article?.text ?? '')): MistakeSample[] {
  if (record.mistakes?.length) return record.mistakes;
  const typed = splitCharacters(record.typed ?? '');
  const offset = record.offset ?? 0;
  return typed.slice(offset).flatMap((actual, index) => {
    const position = offset + index;
    const expected = target[position];
    return expected && expected !== actual ? [{ position, expected, actual }] : [];
  });
}

function englishWordPositions(characters: string[]) {
  const words = new Map<number, { text: string; start: number; end: number }>();
  const boundaries = new Map<number, number>();
  let utf16Index = 0;
  characters.forEach((character, index) => {
    boundaries.set(utf16Index, index);
    utf16Index += character.length;
  });
  boundaries.set(utf16Index, characters.length);
  for (const match of characters.join('').matchAll(englishWordPattern)) {
    const start = boundaries.get(match.index);
    const end = boundaries.get(match.index + match[0].length);
    if (start === undefined || end === undefined) continue;
    const word = { text: match[0], start, end };
    for (let position = start; position < end; position++) words.set(position, word);
  }
  return words;
}

export function collectMistakes(records: PracticeRecord[]): MistakeEntry[] {
  const groups = new Map<string, MistakeEntry>();
  for (const record of records) {
    if (!record.mistakes?.length && !record.typed) continue;
    const target = splitCharacters(record.article?.text ?? '');
    const samples = recordMistakes(record, target);
    if (!samples.length) continue;
    const words = record.language === 'en' ? englishWordPositions(target) : undefined;
    for (const sample of samples) {
      if (!sample.expected || sample.expected === sample.actual) continue;
      const word = words?.get(sample.position);
      const expected = word?.text ?? sample.expected;
      const actual = word
        ? [...target.slice(word.start, sample.position), sample.actual, ...target.slice(sample.position + 1, word.end)].join('')
        : sample.actual;
      const id = `${record.language}:${expected}`;
      const entry = groups.get(id) ?? { id, language: record.language, expected, actual: [], count: 0, lastSeen: record.finishedAt, contexts: [] };
      const context = target.slice(Math.max(0, (word?.start ?? sample.position) - 12), (word?.end ?? sample.position + 1) + 12).join('').trim();
      entry.count++;
      entry.lastSeen = Math.max(entry.lastSeen, record.finishedAt);
      if (!entry.actual.includes(actual) && entry.actual.length < 12) entry.actual.push(actual);
      if (context && !entry.contexts.includes(context) && entry.contexts.length < 3) entry.contexts.push(context);
      groups.set(id, entry);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.expected.localeCompare(b.expected));
}

export function createMistakeDrill(entries: MistakeEntry[], language: Language): ArticleSnapshot {
  let text = '';
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    if (entry.language !== language) continue;
    const expected = entry.expected.trim() ? entry.expected : entry.contexts.find((context) => context.includes(entry.expected));
    if (!expected) continue;
    const separator = language === 'en' && text && !/\s$/u.test(text) && /^[\p{L}\p{N}]/u.test(expected) ? ' ' : '';
    const next = separator + expected;
    const nextBytes = encoder.encode(next).length;
    if (text.length + next.length > MAX_PRIVATE_CHARACTERS || bytes + nextBytes > MAX_PRIVATE_BYTES) break;
    text += next;
    bytes += nextBytes;
  }
  const article: ArticleSnapshot = { id: 'mistake-drill', title: '错字专项', text, language, difficulty: 'beginner', custom: true };
  return { ...article, id: snapshotKey(article).replace(':', '-') };
}

export type DailyStats = {
  date: Date;
  sessions: number;
  speed: number | null;
  accuracy: number | null;
};

export type PracticeStats = {
  sessions: number;
  elapsedMs: number;
  timedSessions: number;
  bestSpeed: number | null;
  averageSpeed: number | null;
  averageAccuracy: number | null;
  daily: DailyStats[];
};

const average = (sum: number, count: number) => count ? Math.round(sum * 100 / count) / 100 : null;

/** Aggregate recorded scores by local calendar day, including today. Active time includes only recorded elapsed time. */
export function calculateStats(records: PracticeRecord[], language: Language, days: 7 | 30, now = new Date()): PracticeStats {
  const groups = Array.from({ length: days }, (_, index) => ({
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1 + index),
    sessions: 0, speed: 0, accuracy: 0,
  }));
  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const groupsByDay = new Map(groups.map((group) => [dayKey(group.date), group]));
  let sessions = 0;
  let timedSessions = 0;
  let elapsedMs = 0;
  let speed = 0;
  let accuracy = 0;
  let bestSpeed: number | null = null;
  for (const record of records) {
    if (record.language !== language || record.finishedAt > now.getTime()) continue;
    const group = groupsByDay.get(dayKey(new Date(record.finishedAt)));
    if (!group) continue;
    group.sessions++;
    group.speed += record.speed;
    group.accuracy += record.accuracy;
    sessions++;
    speed += record.speed;
    accuracy += record.accuracy;
    bestSpeed = Math.max(bestSpeed ?? 0, record.speed);
    if (record.elapsedMs != null && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0) {
      timedSessions++;
      elapsedMs += record.elapsedMs;
    }
  }
  return {
    sessions, elapsedMs, timedSessions, bestSpeed,
    averageSpeed: average(speed, sessions),
    averageAccuracy: average(accuracy, sessions),
    daily: groups.map((group) => ({
      date: group.date, sessions: group.sessions,
      speed: average(group.speed, group.sessions),
      accuracy: average(group.accuracy, group.sessions),
    })),
  };
}
