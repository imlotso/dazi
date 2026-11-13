import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type KeyboardEvent } from 'react';
import type { Difficulty, Language } from '../data/articles';
import { api } from '../lib/api';
import { snapshotKey, type ArticleSnapshot, type MistakeSample, type PracticeMode, type PracticeRecord, type SavedPractice } from '../lib/models';
import { scoreTyping, splitCharacters, type Score } from '../lib/scoring';

export type PracticePhase = 'ready' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'restoring' | 'finishing' | 'finished';
type RoundConfig = { articleId: string; title: string; text: string; language: Language; difficulty: Difficulty; duration: number; custom: boolean; ownerId: string | null; article?: ArticleSnapshot; mode?: PracticeMode; strict?: boolean };
export type PracticeConfig = RoundConfig & {
  autoPause?: boolean;
  onRecord?: (record: PracticeRecord) => void;
  onDraft?: (draft: SavedPractice) => void;
  onRemoveDraft?: (id: string, ownerId: string | null) => void;
  isDraftDeleted?: (id: string, ownerId: string | null) => boolean;
};
export type PracticeResult = { score: Score; attemptId?: string; status?: string; eligible?: boolean; offline: boolean; language: Language; elapsedMs: number; backspaces: number; errors: number; articleTotal: number; custom: boolean; continuation?: SavedPractice };
type Attempt = RoundConfig & {
  id?: string; recordId: string; revision: number; legacy?: boolean; target: string;
  offline: boolean; elapsedMs: number; startedAt: number | null; suspicious: boolean;
  backspaces: number; nextCheckpointMs: number; offset?: number; mistakes?: MistakeSample[];
};
export type PracticeDraft = Omit<Attempt, 'startedAt' | 'nextCheckpointMs'> & { version: 1; typed: string; completed?: boolean; early?: boolean; savedAt?: number; leaseOwner?: string | null; leaseAt?: number };
export type History = PracticeRecord;
type ServerResult = { attemptId: string; score: Score; status: string; eligible: boolean; elapsedMs: number };

const articleLimitMs = 24 * 60 * 60 * 1000;
const draftIntervalMs = 5000;
const mistakeLimit = 500;
const maxTextLength = 30_000;
const legacyDraftKey = 'cloudtyping.practice.v1';
const draftPrefix = 'cloudtyping.practice.v2.';
const currentDraftKey = 'cloudtyping.current-practice.v2';
const historyKey = 'cloudtyping.history.v1';
const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const leaseTaken = (draft: PracticeDraft, owner: string) => !!draft.leaseOwner && draft.leaseOwner !== owner && typeof draft.leaseAt === 'number' && Date.now() - draft.leaseAt < 15_000;
const validDuration = (seconds: number) => Number.isInteger(seconds) && seconds >= 60 && seconds <= 3600 && seconds % 60 === 0;
const durationLimit = (round: Pick<RoundConfig, 'mode' | 'duration'>) => round.mode === 'article' ? articleLimitMs : round.duration * 1000;
const validAttemptId = (id: string) => /^[\w-]{1,80}$/.test(id);
export const practiceDraftId = (recordId: string) => `draft-${recordId}`;
function nextRecordId(recordId: string) {
  const [base, sequence] = recordId.split('~');
  return `${base.slice(0, 115)}~${(Number(sequence) || 0) + 1}`;
}
export const continuationDraftId = (recordId: string) => practiceDraftId(nextRecordId(recordId));

function boundedPrefix(characters: string[], graphemes: number) {
  let length = 0;
  let end = 0;
  while (end < characters.length && end < graphemes && length + characters[end].length <= maxTextLength) {
    length += characters[end].length;
    end++;
  }
  return characters.slice(0, end);
}

function articleSnapshot(round: RoundConfig, text: string): ArticleSnapshot {
  const { articleId, title, language, difficulty, custom, article } = round;
  return { ...article, id: articleId, title, language, difficulty, custom, text };
}

function legacyRecordId(draft: PracticeDraft) {
  if (typeof draft.recordId === 'string' && /^[^\p{Cc}\p{Cf}]{1,128}$/u.test(draft.recordId)) return draft.recordId;
  if (draft.id && validAttemptId(draft.id)) return draft.id;
  const text = JSON.stringify([draft.ownerId ?? null, draft.articleId, draft.target, draft.typed, draft.elapsedMs, draft.savedAt]);
  return snapshotKey({ ...articleSnapshot(draft, text), id: 'legacy' }).replace(':', '-');
}

function notify<Args extends unknown[]>(callback: ((...args: Args) => void) | undefined, ...args: Args) {
  try { void Promise.resolve(callback?.(...args)).catch(() => {}); } catch { /* Scoring and the local recovery copy remain available. */ }
}

function storedDraft(recordId: string): PracticeDraft | null {
  try { return JSON.parse(localStorage.getItem(draftPrefix + recordId) || 'null') as PracticeDraft | null; } catch { return null; }
}

export function localHistory(): History[] {
  try { const value = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(value) ? value.slice(0, 50) : []; } catch { return []; }
}
function rememberHistory(entry: History) {
  try { localStorage.setItem(historyKey, JSON.stringify([entry, ...localHistory().filter((item) => !entry.recordId || item.recordId !== entry.recordId)].slice(0, 50))); } catch { /* Practice still works without storage. */ }
}
export function readDrafts(ownerId?: string | null): PracticeDraft[] {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => !!key && key.startsWith(draftPrefix));
    const candidates = keys.map((key) => { try { return JSON.parse(localStorage.getItem(key) || 'null') as PracticeDraft | null; } catch { return null; } }).filter((item): item is PracticeDraft => !!item);
    let legacy: PracticeDraft | null = null;
    try { legacy = JSON.parse(localStorage.getItem(legacyDraftKey) || 'null') as PracticeDraft | null; } catch { /* Other saved attempts can still be recovered. */ }
    if (legacy) candidates.push({ ...legacy, legacy: true });
    const valid = candidates.filter((data) => (ownerId === undefined || (data.ownerId ?? null) === ownerId) && data.version === 1 && ['zh', 'en'].includes(data.language) && ['beginner', 'intermediate', 'advanced'].includes(data.difficulty) && validDuration(data.duration) && typeof data.target === 'string' && !!data.target && data.target.length <= 30000 && typeof data.typed === 'string' && splitCharacters(data.typed).length <= splitCharacters(data.target).length && typeof data.articleId === 'string' && typeof data.title === 'string' && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 && data.elapsedMs <= durationLimit(data) && Number.isInteger(data.backspaces) && data.backspaces >= 0 && (data.id === undefined || (typeof data.id === 'string' && validAttemptId(data.id))));
    return valid.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).map((data) => {
      data.recordId = legacyRecordId(data);
      if (!Number.isSafeInteger(data.revision) || data.revision < 0) data.revision = 0;
      if (typeof data.ownerId !== 'string') data.ownerId = null;
      data.typed = boundedPrefix(splitCharacters(data.typed), splitCharacters(data.target).length).join('');
      if (data.elapsedMs === durationLimit(data)) { data.completed = true; data.early = false; }
      return data;
    });
  } catch { return []; }
}
export function readDraft(ownerId?: string | null): PracticeDraft | null {
  const drafts = readDrafts(ownerId);
  try {
    const current = sessionStorage.getItem(currentDraftKey);
    return drafts.find((item) => item.recordId === current) ?? drafts[0] ?? null;
  } catch { return drafts[0] ?? null; }
}
function clearDraft(attempt: Attempt | null, owner: string) {
  if (!attempt) return false;
  const current = storedDraft(attempt.recordId);
  if (current && (leaseTaken(current, owner) || (current.revision ?? 0) > attempt.revision)) return false;
  try { localStorage.removeItem(draftPrefix + attempt.recordId); if (attempt.legacy) localStorage.removeItem(legacyDraftKey); } catch { return false; }
  try { if (sessionStorage.getItem(currentDraftKey) === attempt.recordId) sessionStorage.removeItem(currentDraftKey); } catch { /* Storage is optional. */ }
  return true;
}
export function discardSavedDraft(saved: SavedPractice): boolean {
  try {
    const key = draftPrefix + saved.recordId;
    const current = storedDraft(saved.recordId);
    if (current) {
      if ((current.ownerId ?? null) !== saved.ownerId || current.articleId !== saved.article.id || current.target !== saved.article.text || leaseTaken(current, '')) return false;
      localStorage.removeItem(key);
    } else {
      let legacy: PracticeDraft | null = null;
      try { legacy = JSON.parse(localStorage.getItem(legacyDraftKey) || 'null') as PracticeDraft | null; } catch { /* An unrelated invalid legacy draft does not block deletion. */ }
      if (legacy?.version === 1 && legacyRecordId(legacy) === saved.recordId) {
        if ((legacy.ownerId ?? null) !== saved.ownerId || legacy.articleId !== saved.article.id || legacy.target !== saved.article.text || leaseTaken(legacy, '')) return false;
        localStorage.removeItem(legacyDraftKey);
      }
    }
    try { if (sessionStorage.getItem(currentDraftKey) === saved.recordId) sessionStorage.removeItem(currentDraftKey); } catch { /* Storage is optional. */ }
    return true;
  } catch { return false; }
}
function elapsedTime(attempt: Attempt) {
  return Math.min(durationLimit(attempt), attempt.elapsedMs + (attempt.startedAt === null ? 0 : Math.max(0, performance.now() - attempt.startedAt)));
}
function saveDraft(attempt: Attempt, typed: string, owner: string, completed = false, early = false) {
  const { startedAt: _startedAt, nextCheckpointMs: _nextCheckpointMs, ...rest } = attempt;
  const data: PracticeDraft = { ...rest, revision: attempt.revision + 1, version: 1, elapsedMs: elapsedTime(attempt), typed, completed, early, savedAt: Date.now(), leaseOwner: owner, leaseAt: Date.now() };
  try {
    localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify(data));
    attempt.revision = data.revision;
    if (attempt.legacy) { localStorage.removeItem(legacyDraftKey); attempt.legacy = false; }
    try { sessionStorage.setItem(currentDraftKey, attempt.recordId); } catch { /* Most recent draft remains discoverable. */ }
    return true;
  } catch { return false; }
}
function releaseLease(attempt: Attempt, owner: string) {
  try {
    const draft = storedDraft(attempt.recordId);
    if (draft?.leaseOwner === owner) localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify({ ...draft, leaseOwner: null, leaseAt: 0 }));
  } catch { /* The stored progress remains usable. */ }
}
function localResult(attempt: Attempt, used: number, typed: string): PracticeResult {
  const expected = splitCharacters(attempt.target);
  const offset = attempt.offset ?? 0;
  const score = scoreTyping(offset ? expected.slice(offset).join('') : attempt.target, offset ? splitCharacters(typed).slice(offset).join('') : typed, Math.max(used / 1000, 0.1));
  return { score, offline: attempt.offline, language: attempt.language, elapsedMs: used, backspaces: attempt.backspaces, errors: score.total - score.correct, articleTotal: expected.length, custom: attempt.custom };
}
function withServerResult(local: PracticeResult, saved: ServerResult): PracticeResult {
  if (!saved.score || typeof saved.score.correct !== 'number' || typeof saved.score.total !== 'number' || typeof saved.score.accuracy !== 'number' || typeof saved.score.cpm !== 'number' || typeof saved.score.wpm !== 'number') throw new Error('成绩数据无效');
  return { ...local, ...saved, offline: false, elapsedMs: Number.isFinite(saved.elapsedMs) ? saved.elapsedMs : local.elapsedMs, errors: saved.score.total - saved.score.correct };
}
function recordResult(attempt: Attempt, result: PracticeResult, typed: string): PracticeRecord {
  return {
    language: attempt.language, difficulty: attempt.difficulty, duration: attempt.duration, speed: attempt.language === 'zh' ? result.score.cpm : result.score.wpm,
    accuracy: result.score.accuracy, finishedAt: Date.now(), status: result.status, elapsedMs: Math.round(result.elapsedMs), backspaces: result.backspaces, errors: result.errors,
    recordId: attempt.recordId, ownerId: attempt.ownerId, localOnly: result.offline, article: articleSnapshot(attempt, attempt.target), typed,
    offset: attempt.offset ?? 0, total: result.score.total, correct: result.score.correct, articleTotal: result.articleTotal,
    mode: attempt.mode ?? 'timed', strict: !!attempt.strict, mistakes: [...(attempt.mistakes ?? [])],
  };
}

function workspaceDraft(attempt: Attempt, typed: string): SavedPractice {
  const article = articleSnapshot(attempt, attempt.target);
  return {
    id: practiceDraftId(attempt.recordId), article, typed, elapsedMs: Math.round(elapsedTime(attempt)), backspaces: attempt.backspaces,
    duration: attempt.duration, mode: attempt.mode ?? 'timed', strict: !!attempt.strict, offset: attempt.offset ?? 0,
    recordId: attempt.recordId, attemptId: attempt.offline ? undefined : attempt.id, offline: attempt.offline,
    ownerId: attempt.ownerId, savedAt: Date.now(), mistakes: [...(attempt.mistakes ?? [])], suspicious: attempt.suspicious,
  };
}
export function savedPracticeFromLegacy(draft: PracticeDraft): SavedPractice {
  return { ...workspaceDraft({ ...draft, startedAt: null, nextCheckpointMs: 0 }, draft.typed), savedAt: draft.savedAt ?? 0 };
}

function continuationOffset(strict: boolean | undefined, offset: number, characters: string[], expected: string[]) {
  const wrong = strict ? characters.findIndex((character, index) => index >= offset && character !== expected[index]) : -1;
  return wrong < 0 ? characters.length : wrong;
}

function attemptFromSaved(saved: SavedPractice, typed: string, revision = 0): Attempt {
  const { id: articleId, title, text, language, difficulty, custom } = saved.article;
  const offline = saved.offline || custom || saved.offset > 0 || !saved.attemptId || !validAttemptId(saved.attemptId);
  return {
    articleId, title, text, language, difficulty, custom, article: saved.article, target: text,
    ownerId: saved.ownerId, duration: saved.duration, mode: saved.mode, strict: saved.strict,
    id: offline ? undefined : saved.attemptId, recordId: saved.recordId, revision, offline,
    elapsedMs: Math.min(durationLimit(saved), Math.max(0, saved.elapsedMs)), startedAt: null, nextCheckpointMs: saved.elapsedMs + 5000,
    backspaces: saved.backspaces, suspicious: !!saved.suspicious, offset: Math.min(saved.offset, splitCharacters(typed).length), mistakes: [...(saved.mistakes ?? []).slice(0, mistakeLimit)],
  };
}

export function usePractice(config: PracticeConfig, initialDraft: PracticeDraft | null) {
  const ownerToken = useRef(uniqueId());
  const [draft] = useState<PracticeDraft | null>(() => initialDraft && leaseTaken(initialDraft, ownerToken.current) && !initialDraft.completed ? { ...initialDraft, id: undefined, recordId: uniqueId(), revision: 0, offline: true, legacy: false, leaseOwner: null, leaseAt: 0 } : initialDraft);
  const wasForked = !!draft && !!initialDraft && draft.recordId !== initialDraft.recordId;
  const restoredAttempt: Attempt | null = draft ? { ...draft, startedAt: null, nextCheckpointMs: draft.elapsedMs + 5000 } : null;
  const initialPhase: PracticePhase = draft ? (draft.completed || (draft.id && !draft.offline) ? 'restoring' : 'paused') : 'ready';
  const [phase, setPhase] = useState<PracticePhase>(initialPhase);
  const phaseRef = useRef<PracticePhase>(initialPhase);
  const [target, setTarget] = useState(draft?.target ?? config.text);
  const targetCharacters = useRef<string[] | null>(null);
  const [raw, setRaw] = useState(draft?.typed ?? '');
  const [typed, setTyped] = useState(draft?.typed ?? '');
  const typedRef = useRef(draft?.typed ?? '');
  const committedCharacters = useRef<string[] | null>(null);
  const [elapsedMs, setElapsedMs] = useState(draft?.elapsedMs ?? 0);
  const [backspaces, setBackspaces] = useState(draft?.backspaces ?? 0);
  const [feedback, setFeedback] = useState(wasForked ? '原进度正在其他标签页使用，已另存。' : '');
  const [result, setResult] = useState<PracticeResult | null>(null);
  const [restored, setRestored] = useState(!!draft);
  const attemptRef = useRef<Attempt | null>(restoredAttempt);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const composing = useRef(false);
  const lastBackspaceKey = useRef(-Infinity);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const liveConfig = useRef(config);
  liveConfig.current = config;
  const startRequest = useRef(0);
  const parked = useRef(false);
  const lastWorkspaceSave = useRef(-Infinity);
  const recorded = useRef(new Set<string>());
  const continuationRef = useRef<Attempt | null>(null);
  const setCurrentPhase = (next: PracticePhase) => { phaseRef.current = next; setPhase(next); };
  const clearTimer = () => { if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; };
  const isCurrent = (attempt: Attempt, expectedPhase: PracticePhase) => mounted.current && attemptRef.current === attempt && phaseRef.current === expectedPhase;
  const committed = () => committedCharacters.current ??= splitCharacters(typedRef.current);
  const isDeleted = (attempt: Attempt) => liveConfig.current.isDraftDeleted?.(practiceDraftId(attempt.recordId), attempt.ownerId) === true;
  const ensureOwnership = (attempt: Attempt) => {
    const deleted = isDeleted(attempt);
    const existing = storedDraft(attempt.recordId);
    if (deleted || (existing && (leaseTaken(existing, ownerToken.current) || (existing.revision ?? 0) > attempt.revision)) ||
      (!existing && attempt.revision > 0 && !attempt.legacy)) {
      if (deleted) clearDraft(attempt, ownerToken.current);
      attempt.recordId = uniqueId(); attempt.revision = 0; attempt.id = undefined; attempt.offline = true; attempt.legacy = false;
      setFeedback(!deleted && existing ? '原进度正在其他标签页使用，已另存。' : '原草稿已移除，已另存。');
      return true;
    }
    return false;
  };
  const emitDraft = (attempt: Attempt, typed: string, force = false, snapshot?: SavedPractice) => {
    if (isDeleted(attempt) || (!force && performance.now() - lastWorkspaceSave.current < draftIntervalMs)) return;
    lastWorkspaceSave.current = performance.now();
    const outgoing = snapshot ?? workspaceDraft(attempt, typed);
    const recover = () => {
      if (!mounted.current || parked.current || attemptRef.current !== attempt || outgoing.recordId !== attempt.recordId ||
        !['running', 'paused', 'pausing', 'restoring', 'resuming'].includes(phaseRef.current) || !isDeleted(attempt)) return;
      persist(attempt, true);
    };
    try { void Promise.resolve(liveConfig.current.onDraft?.(outgoing)).catch(recover); } catch { recover(); }
  };
  const removeWorkspaceDraft = (attempt: Attempt) => {
    notify(liveConfig.current.onRemoveDraft, practiceDraftId(attempt.recordId), attempt.ownerId);
  };
  const persist = useCallback((attempt: Attempt, force = false) => {
    const forked = ensureOwnership(attempt);
    if (!saveDraft(attempt, typedRef.current, ownerToken.current)) setFeedback('进度保存失败。');
    emitDraft(attempt, typedRef.current, force || forked);
  }, []);

  const settle = (attempt: Attempt, final: PracticeResult, typed: string) => {
    const entry = recordResult(attempt, final, typed);
    const alreadyRecorded = recorded.current.has(attempt.recordId) || localHistory().some((item) => item.recordId === attempt.recordId && item.ownerId === attempt.ownerId);
    if (!alreadyRecorded) {
      recorded.current.add(attempt.recordId);
      rememberHistory(entry);
      notify(liveConfig.current.onRecord, entry);
    }
    const characters = committed();
    const offset = attempt.offset ?? 0;
    const expected = targetCharacters.current ??= splitCharacters(attempt.target);
    const nextOffset = continuationOffset(attempt.strict, offset, characters, expected);
    if (nextOffset < final.articleTotal) {
      const next: Attempt = {
        ...attempt, id: undefined, recordId: nextRecordId(attempt.recordId), revision: 0, legacy: false,
        offline: true, elapsedMs: 0, startedAt: null, nextCheckpointMs: 5000,
        suspicious: false, backspaces: 0, offset: nextOffset, mistakes: [],
      };
      if (!isDeleted(next)) {
        const existing = storedDraft(next.recordId);
        if (existing) next.revision = existing.revision;
        else {
          saveDraft(next, typed, ownerToken.current);
          releaseLease(next, ownerToken.current);
        }
        const continuation = existing ? workspaceDraft({ ...next, ...existing }, existing.typed) : workspaceDraft(next, typed);
        continuationRef.current = next;
        final = { ...final, continuation };
        if (!existing) emitDraft(next, continuation.typed, true, continuation);
      }
    }
    if (clearDraft(attempt, ownerToken.current) && !isDeleted(attempt)) removeWorkspaceDraft(attempt);
    setResult(final); setCurrentPhase('finished');
  };

  async function pauseOnline(attempt: Attempt, expectedPhase: 'pausing' | 'restoring', force = true) {
    let fellBack = false;
    if (attempt.id && !attempt.offline) {
      try {
        const state = await api<{ remainingMs: number }>(`/api/tests/${attempt.id}/pause`, { method: 'POST', body: {} });
        if (!Number.isFinite(state.remainingMs) || state.remainingMs <= 0) throw new Error('在线计时不可用');
      } catch {
        if (!isCurrent(attempt, expectedPhase)) return false;
        attempt.offline = true;
        fellBack = true;
        setFeedback('在线计时已中断。');
      }
    }
    if (!isCurrent(attempt, expectedPhase)) return false;
    persist(attempt, force || fellBack); setCurrentPhase('paused');
    return true;
  }

  async function restoreAttempt(attempt: Attempt, saved: PracticeDraft) {
    if (!saved.completed) {
      ensureOwnership(attempt);
      // Claim the local round before yielding to the server, so another tab
      // restoring the same paused round can only open a personal copy.
      if (!saveDraft(attempt, typedRef.current, ownerToken.current)) {
        attempt.id = undefined;
        attempt.offline = true;
        setFeedback('进度保存失败。');
      }
      await pauseOnline(attempt, 'restoring');
      return;
    }
    const value = saved.typed;
    let final = localResult(attempt, attempt.elapsedMs, value);
    if (attempt.id && !attempt.offline) {
      try {
        const state = await api<{ status: string; result?: ServerResult }>(`/api/tests/${attempt.id}`);
        if (!isCurrent(attempt, 'restoring')) return;
        const result = state.result ?? await api<ServerResult>(`/api/tests/${attempt.id}/finish`, { method: 'POST', body: { typed: value, suspicious: attempt.suspicious, backspaces: attempt.backspaces, elapsedMs: Math.round(attempt.elapsedMs), early: !!saved.early } });
        final = withServerResult(final, result);
      } catch { final.offline = true; }
    }
    if (isCurrent(attempt, 'restoring')) settle(attempt, final, value);
  }

  useEffect(() => {
    const attempt = attemptRef.current;
    if (attempt && draft && phaseRef.current === 'restoring') void restoreAttempt(attempt, draft);
  }, []);

  function bindAttempt(attempt: Attempt, typed: string) {
    ++startRequest.current;
    clearTimer();
    if (attemptRef.current) releaseLease(attemptRef.current, ownerToken.current);
    attemptRef.current = attempt; continuationRef.current = null; parked.current = false;
    composing.current = false; lastBackspaceKey.current = -Infinity;
    typedRef.current = typed;
    targetCharacters.current = null; committedCharacters.current = null;
    setTarget(attempt.target); setTyped(typed); setRaw(typed); setElapsedMs(attempt.elapsedMs); setBackspaces(attempt.backspaces);
    setFeedback(''); setResult(null); setRestored(true);
  }

  async function loadLegacy(saved: PracticeDraft) {
    if ((saved.ownerId ?? null) !== liveConfig.current.ownerId || !mounted.current) return;
    const previous = attemptRef.current;
    if (previous && phaseRef.current === 'running' && !await park()) return;
    if (previous !== attemptRef.current || !mounted.current || (saved.ownerId ?? null) !== liveConfig.current.ownerId) return;
    const attempt: Attempt = { ...saved, startedAt: null, nextCheckpointMs: saved.elapsedMs + 5000 };
    bindAttempt(attempt, saved.typed);
    if (!saved.completed) ensureOwnership(attempt);
    if (saved.completed || (attempt.id && !attempt.offline)) {
      setCurrentPhase('restoring');
      await restoreAttempt(attempt, saved);
    } else {
      persist(attempt, true); setCurrentPhase('paused');
    }
  }

  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => {
      const attempt = attemptRef.current;
      if (!attempt || parked.current) return;
      const saved = storedDraft(attempt.recordId);
      if (phaseRef.current === 'running') {
        const used = elapsedTime(attempt);
        composing.current = false; setRaw(typedRef.current);
        attempt.elapsedMs = used; attempt.startedAt = null; clearTimer(); setElapsedMs(used); setCurrentPhase('paused');
        persist(attempt, true);
        if (attempt.id && !attempt.offline && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon(`/api/tests/${attempt.id}/pause`, new Blob(['{}'], { type: 'application/json' }));
        }
      } else if (['paused', 'pausing', 'resuming'].includes(phaseRef.current) && saved?.leaseOwner === ownerToken.current &&
        !saved.completed && saved.revision === attempt.revision) {
        if (isDeleted(attempt)) persist(attempt, true);
        else emitDraft(attempt, typedRef.current, true);
      }
      releaseLease(attempt, ownerToken.current);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      const attempt = attemptRef.current;
      if (!event.persisted || !attempt || parked.current || phaseRef.current !== 'paused') return;
      if (!storedDraft(attempt.recordId)) return;
      persist(attempt);
      if (!attempt.id || attempt.offline) return;
      setCurrentPhase('restoring');
      void pauseOnline(attempt, 'restoring');
    };
    const initial = attemptRef.current;
    if (initial && phaseRef.current === 'paused') persist(initial, true);
    const heartbeat = setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || parked.current || !['running', 'paused', 'restoring', 'pausing', 'resuming'].includes(phaseRef.current)) return;
      if (phaseRef.current === 'running' && isDeleted(attempt)) { persist(attempt, true); return; }
      const saved = storedDraft(attempt.recordId);
      if (saved && !saved.completed && saved.revision === attempt.revision && !leaseTaken(saved, ownerToken.current)) {
        try { localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify({ ...saved, leaseOwner: ownerToken.current, leaseAt: Date.now() })); } catch { /* Progress remains usable in memory. */ }
      }
    }, 5000);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    const onVisibilityChange = () => {
      if (liveConfig.current.autoPause && document.visibilityState === 'hidden' && phaseRef.current === 'running') void pause();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { mounted.current = false; window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow); document.removeEventListener('visibilitychange', onVisibilityChange); clearInterval(heartbeat); clearTimer(); if (attemptRef.current) releaseLease(attemptRef.current, ownerToken.current); };
  }, []);

  const finish = useCallback(async (early = false) => {
    const attempt = attemptRef.current;
    if (!attempt || !['running', 'paused'].includes(phaseRef.current)) return;
    const used = elapsedTime(attempt);
    attempt.elapsedMs = used; attempt.startedAt = null;
    clearTimer(); setCurrentPhase('finishing'); setElapsedMs(used);
    const value = typedRef.current;
    composing.current = false; setRaw(value);
    ensureOwnership(attempt);
    saveDraft(attempt, value, ownerToken.current, true, early);
    let final = localResult(attempt, used, value);
    if (attempt.id && !attempt.offline) {
      try {
        const saved = await api<ServerResult>(`/api/tests/${attempt.id}/finish`, { method: 'POST', body: { typed: value, suspicious: attempt.suspicious, backspaces: attempt.backspaces, elapsedMs: Math.round(used), early } });
        final = withServerResult(final, saved);
      } catch { final.offline = true; }
    }
    if (isCurrent(attempt, 'finishing')) settle(attempt, final, value);
  }, []);

  const beginClock = useCallback(() => {
    clearTimer();
    timerRef.current = setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || phaseRef.current !== 'running') return;
      const used = elapsedTime(attempt);
      setElapsedMs(used);
      if (used >= durationLimit(attempt)) { void finish(false); return; }
      if (attempt.id && !attempt.offline && used >= attempt.nextCheckpointMs) {
        attempt.nextCheckpointMs = used + 5000;
        void api(`/api/tests/${attempt.id}/checkpoint`, { method: 'POST', body: { typed: typedRef.current, elapsedMs: Math.round(used) } }).catch(() => {});
      }
      if (Math.floor(used / 1000) !== Math.floor(Math.max(0, used - 100) / 1000)) persist(attempt);
    }, 100);
  }, [finish, persist]);

  async function start() {
    if (phaseRef.current !== 'ready' || !validDuration(config.duration) || !config.text) return;
    const request = ++startRequest.current;
    const current = () => mounted.current && startRequest.current === request && phaseRef.current === 'starting' && liveConfig.current.ownerId === config.ownerId;
    const { articleId, title, language, difficulty, duration, custom, ownerId, article, mode = 'timed', strict = false } = config;
    setCurrentPhase('starting'); setFeedback(''); setResult(null); setRestored(false); setRaw(''); setTyped(''); typedRef.current = ''; composing.current = false; setBackspaces(0); setElapsedMs(0);
    targetCharacters.current = null; committedCharacters.current = null;
    let testTarget = config.text;
    let id: string | undefined;
    let offline = custom;
    if (!custom) {
      try {
        const challenge = await api<{ id: string; target: string }>('/api/tests/start', {
          method: 'POST', headers: { 'X-Workspace-Owner': ownerId ?? 'guest' }, body: { articleId, duration, mode, strict },
        });
        if (typeof challenge.id !== 'string' || !validAttemptId(challenge.id) || typeof challenge.target !== 'string' || !challenge.target || challenge.target.length > maxTextLength) throw new Error('练习数据无效');
        id = challenge.id; testTarget = challenge.target;
      } catch { offline = true; }
    }
    if (!current()) {
      if (mounted.current && startRequest.current === request) setCurrentPhase('ready');
      return;
    }
    if (offline && !custom) setFeedback('在线练习不可用，已转为个人练习。');
    const attempt: Attempt = { articleId, title, language, difficulty, duration, custom, ownerId, article, mode, strict, text: testTarget, id, recordId: id || uniqueId(), revision: 0, target: testTarget, offline, elapsedMs: 0, startedAt: performance.now(), suspicious: false, backspaces: 0, nextCheckpointMs: 5000, offset: 0, mistakes: [] };
    parked.current = false; lastBackspaceKey.current = -Infinity;
    attemptRef.current = attempt; setTarget(testTarget); setCurrentPhase('running'); persist(attempt, true); beginClock();
    if (liveConfig.current.autoPause && document.visibilityState === 'hidden') void pause();
    window.setTimeout(() => { if (isCurrent(attempt, 'running')) textareaRef.current?.focus(); }, 0);
  }

  async function pause() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return false;
    const used = elapsedTime(attempt);
    if (used >= durationLimit(attempt)) { void finish(false); return false; }
    composing.current = false; setRaw(typedRef.current);
    attempt.elapsedMs = used; attempt.startedAt = null; setElapsedMs(used); clearTimer(); setCurrentPhase('pausing'); persist(attempt, true);
    return pauseOnline(attempt, 'pausing', false);
  }

  async function resume() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'paused') return;
    parked.current = false;
    if (isDeleted(attempt)) persist(attempt, true);
    else ensureOwnership(attempt);
    setCurrentPhase('resuming');
    if (attempt.id && !attempt.offline) {
      try {
        const state = await api<{ remainingMs: number }>(`/api/tests/${attempt.id}/resume`, { method: 'POST', body: {} });
        if (!Number.isFinite(state.remainingMs) || state.remainingMs <= 0) throw new Error('在线计时不可用');
      } catch {
        if (!isCurrent(attempt, 'resuming')) return;
        attempt.offline = true; setFeedback('在线计时已中断。');
      }
    }
    if (!isCurrent(attempt, 'resuming')) return;
    lastBackspaceKey.current = -Infinity;
    attempt.startedAt = performance.now(); attempt.nextCheckpointMs = attempt.elapsedMs + 5000;
    setCurrentPhase('running'); setRestored(false); persist(attempt, true); beginClock();
    if (liveConfig.current.autoPause && document.visibilityState === 'hidden') void pause();
    window.setTimeout(() => { if (isCurrent(attempt, 'running')) textareaRef.current?.focus(); }, 0);
  }

  async function park() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current === 'finished' || parked.current) return true;
    const running = phaseRef.current === 'running';
    if (running && !await pause()) return false;
    if (!isCurrent(attempt, 'paused')) return false;
    if (!running) persist(attempt, true);
    parked.current = true;
    releaseLease(attempt, ownerToken.current);
    return true;
  }

  async function loadSaved(saved: SavedPractice, options?: { newRound?: boolean }) {
    if (saved.ownerId !== liveConfig.current.ownerId || !validDuration(saved.duration) || !saved.article.text || saved.article.text.length > maxTextLength) return;
    const previous = attemptRef.current;
    if (previous && phaseRef.current === 'running' && !await park()) return;
    if (previous !== attemptRef.current || !mounted.current || saved.ownerId !== liveConfig.current.ownerId) return;
    const stored = storedDraft(saved.recordId);
    const local = stored?.version === 1 && stored.recordId === saved.recordId &&
      stored.ownerId === saved.ownerId && stored.articleId === saved.article.id && stored.target === saved.article.text ? stored : null;
    if (local?.completed && !leaseTaken(local, ownerToken.current)) {
      await loadLegacy(local);
      return;
    }
    if (local && !leaseTaken(local, ownerToken.current)) {
      await loadLegacy(local);
      return;
    }
    const expected = splitCharacters(saved.article.text);
    const characters = boundedPrefix(splitCharacters(local?.typed ?? saved.typed), expected.length);
    const typed = characters.join('');
    const fresh = options?.newRound && !stored && saved.offline && !saved.attemptId && validAttemptId(saved.recordId) &&
      saved.id === practiceDraftId(saved.recordId) && saved.elapsedMs === 0 && saved.backspaces === 0;
    const offset = continuationOffset(saved.strict, Math.min(saved.offset, characters.length), characters, expected);
    const attempt = attemptFromSaved({
      ...saved, attemptId: undefined, recordId: fresh ? saved.recordId : uniqueId(), offline: true, offset: fresh ? saved.offset : offset, elapsedMs: 0,
      backspaces: 0, mistakes: [], suspicious: false,
    }, typed);
    bindAttempt(attempt, typed);
    if (!fresh) setFeedback(local ? '原进度正在其他标签页使用，已另存。' : '已从云端草稿新建个人练习。');
    setCurrentPhase('paused');
    persist(attempt, true);
  }

  function reset(nextTarget = config.text, options?: { keepDraft?: boolean }) {
    ++startRequest.current;
    clearTimer();
    const attempt = attemptRef.current;
    if (attempt) {
      if (options?.keepDraft) releaseLease(attempt, ownerToken.current);
      else {
        const draft = continuationRef.current ?? attempt;
        if (clearDraft(draft, ownerToken.current)) removeWorkspaceDraft(draft);
      }
    }
    attemptRef.current = null; continuationRef.current = null; parked.current = false; typedRef.current = ''; composing.current = false;
    targetCharacters.current = null; committedCharacters.current = null;
    setRaw(''); setTyped(''); setTarget(nextTarget); setElapsedMs(0); setBackspaces(0); setResult(null); setFeedback(''); setRestored(false); setCurrentPhase('ready');
  }

  function recordBackspace() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    if (elapsedTime(attempt) >= durationLimit(attempt)) { void finish(false); return; }
    attempt.backspaces++; setBackspaces(attempt.backspaces); persist(attempt);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Backspace' && phaseRef.current === 'running' && !composing.current && !event.nativeEvent.isComposing) { lastBackspaceKey.current = performance.now(); recordBackspace(); }
  }
  function commit(value: string, deleting = false) {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    if (elapsedTime(attempt) >= durationLimit(attempt)) { void finish(false); return; }
    const characters = splitCharacters(value);
    const expected = targetCharacters.current ??= splitCharacters(attempt.target);
    const previous = committed();
    const offset = attempt.offset ?? 0;
    const next = boundedPrefix([...previous.slice(0, offset), ...characters.slice(offset, expected.length)], expected.length);
    const mistakes = attempt.mistakes ??= [];
    let blocked = false;
    for (let index = offset; index < next.length; index++) {
      const actual = next[index];
      if (actual === expected[index]) continue;
      if (!deleting && actual !== previous[index] && mistakes.length < mistakeLimit && actual.length <= 200 && expected[index].length <= 200) {
        mistakes.push({ position: index, expected: expected[index], actual });
      }
      if (attempt.strict) {
        next.length = index + 1;
        blocked = true;
        break;
      }
    }
    const safe = next.join('');
    typedRef.current = safe; committedCharacters.current = next; setTyped(safe); setRaw(safe); persist(attempt);
    if (next.length === expected.length && !blocked) void finish(true);
  }
  function onChange(event: ChangeEvent<HTMLTextAreaElement>, prefix = '') {
    if (phaseRef.current !== 'running') return;
    const input = event.nativeEvent as InputEvent;
    if (attemptRef.current && elapsedTime(attemptRef.current) >= durationLimit(attemptRef.current)) { void finish(false); return; }
    if (input.inputType === 'deleteContentBackward' && !composing.current && !input.isComposing && performance.now() - lastBackspaceKey.current > 250) recordBackspace();
    const value = prefix + event.target.value;
    if (composing.current || input.isComposing) setRaw(value);
    else commit(value, input.inputType?.startsWith('delete'));
  }
  function onCompositionStart() { if (phaseRef.current === 'running') composing.current = true; }
  function onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>, prefix = '') {
    const wasComposing = composing.current;
    composing.current = false;
    if (!wasComposing) { setRaw(typedRef.current); return; }
    if (phaseRef.current === 'running') commit(prefix + event.currentTarget.value);
  }
  function markSuspicious() {
    if (attemptRef.current && phaseRef.current === 'running') {
      attemptRef.current.suspicious = true;
      persist(attemptRef.current);
    }
  }
  function deletePreviousCharacter() {
    const characters = committed();
    if (characters.length <= (attemptRef.current?.offset ?? 0)) return;
    recordBackspace();
    commit(characters.slice(0, -1).join(''), true);
  }

  const attempt = attemptRef.current;
  const mode = (attempt ? attempt.mode : config.mode) ?? 'timed';
  const strict = attempt ? !!attempt.strict : !!config.strict;
  const duration = attempt?.duration ?? config.duration;
  const offset = attempt?.offset ?? 0;
  const draftId = attempt ? practiceDraftId(attempt.recordId) : undefined;
  return { phase, target, raw, typed, elapsedMs, backspaces, feedback, result, restored, mode, strict, duration, offset, draftId, textareaRef, start, pause, resume, reset, finish, park, loadSaved, loadLegacy, updateTyped: commit, deletePreviousCharacter, onChange, onKeyDown, onCompositionStart, onCompositionEnd, markSuspicious };
}
