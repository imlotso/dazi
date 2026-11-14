import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type KeyboardEvent } from 'react';
import type { Difficulty, Language } from '../data/articles';
import { api, ApiError } from '../lib/api';
import { catalogSnapshotKey, compareDraftProgress, sameDraftSnapshot, snapshotKey, type ArticleSnapshot, type MistakeSample, type PracticeMode, type PracticeRecord, type SavedPractice } from '../lib/models';
import { scoreTyping, splitCharacters, type Score } from '../lib/scoring';

export type PracticePhase = 'ready' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'restoring' | 'finishing' | 'finished';
type RoundConfig = { articleId: string; title: string; text: string; language: Language; difficulty: Difficulty; duration: number; custom: boolean; ownerId: string | null; article?: ArticleSnapshot; mode?: PracticeMode; strict?: boolean };
export type PracticeConfig = RoundConfig & {
  guardCatalog?: boolean;
  onCatalogStale?: () => void;
  autoPause?: boolean;
  onRecord?: (record: PracticeRecord) => void;
  onDraft?: (draft: SavedPractice) => void;
  onRemoveDraft?: (id: string, ownerId: string | null) => void;
  onReplaceRecord?: (id: string, ownerId: string | null) => void;
  isDraftDeleted?: (id: string, ownerId: string | null) => boolean;
};
export type PracticeResult = { score: Score; attemptId?: string; status?: string; eligible?: boolean; submitted?: boolean; offline: boolean; language: Language; elapsedMs: number; backspaces: number; errors: number; articleTotal: number; custom: boolean; continuation?: SavedPractice };
type Attempt = RoundConfig & {
  id?: string; recordId: string; revision: number; legacy?: boolean; target: string;
  offline: boolean; elapsedMs: number; startedAt: number | null; suspicious: boolean;
  backspaces: number; nextCheckpointMs: number; offset?: number; mistakes?: MistakeSample[]; pendingStart?: boolean;
  recoveryId?: string; recoveryKey?: string; claimId?: string; claimVersion?: number; recoveryRequestId?: string; recoveryMarker?: string; progressVersion?: number; recoveryBaseVersion?: number; progressFingerprint?: string; personalOnly?: boolean;
};
export type PracticeDraft = Omit<Attempt, 'startedAt' | 'nextCheckpointMs'> & { version: 1; typed: string; completed?: boolean; early?: boolean; savedAt?: number; leaseOwner?: string | null; leaseAt?: number };
export type History = PracticeRecord;
type ServerResult = { attemptId: string; score: Score; status: string; eligible: boolean; elapsedMs: number; submitted?: boolean };
type RecoveryState = { id: string; status: string; elapsedMs?: number; remainingMs?: number; claimVersion?: number; result?: ServerResult; typed?: string; backspaces?: number };

const articleLimitMs = 24 * 60 * 60 * 1000;
const draftIntervalMs = 5000;
const mistakeLimit = 500;
const maxTextLength = 30_000;
const legacyDraftKey = 'cloudtyping.practice.v1';
const draftPrefix = 'cloudtyping.practice.v2.';
const currentDraftKey = 'cloudtyping.current-practice.v2';
const historyKey = 'cloudtyping.history.v1';
const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function clientChallengeId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch { return undefined; }
}
function clientRecoveryKey() {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  } catch { return undefined; }
}
const leaseTaken = (draft: PracticeDraft, owner: string) => !!draft.leaseOwner && draft.leaseOwner !== owner && typeof draft.leaseAt === 'number' && Date.now() - draft.leaseAt < 15_000;
export const draftAwaitingStart = (draft: PracticeDraft) => !!draft.pendingStart && leaseTaken(draft, '');
const validDuration = (seconds: number) => Number.isInteger(seconds) && seconds >= 60 && seconds <= 3600 && seconds % 60 === 0;
const durationLimit = (round: Pick<RoundConfig, 'mode' | 'duration'>) => round.mode === 'article' ? articleLimitMs : round.duration * 1000;
const validAttemptId = (id: string) => /^[\w-]{1,80}$/.test(id);
const guestPracticeDisabledMessage = '游客在线练习已关闭，已转为本地练习。';
const isGuestPracticeDisabled = (error: unknown) => error instanceof ApiError && error.code === 'GUEST_ONLINE_PRACTICE_DISABLED';
const recoveryUuid = (id: string | undefined): id is string => !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
function recoverableId(attempt: Attempt) {
  if (attempt.custom || attempt.personalOnly || (attempt.offset ?? 0) > 0) return undefined;
  return [attempt.recoveryId, attempt.id, attempt.recordId].find(recoveryUuid);
}
function practiceClaim(attempt: Attempt): Record<string, string> | undefined {
  return recoveryUuid(attempt.claimId) && Number.isSafeInteger(attempt.claimVersion) && attempt.claimVersion! > 0
    ? { 'X-Practice-Claim': `${attempt.claimId}:${attempt.claimVersion}` } : undefined;
}
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
function rememberHistory(entry: History, previousId?: string) {
  try { localStorage.setItem(historyKey, JSON.stringify([entry, ...localHistory().filter((item) => item.ownerId !== entry.ownerId || !item.recordId || (item.recordId !== entry.recordId && item.recordId !== previousId))].slice(0, 50))); } catch { /* Practice still works without storage. */ }
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
function progressFingerprint(attempt: Pick<Attempt, 'backspaces' | 'offset' | 'suspicious' | 'mistakes'>, typed: string, elapsed: number) {
  return JSON.stringify([typed, elapsed, attempt.backspaces, attempt.offset ?? 0, !!attempt.suspicious, attempt.mistakes ?? []]);
}
function saveDraft(attempt: Attempt, typed: string, owner: string, completed = false, early = false) {
  const { startedAt: _startedAt, nextCheckpointMs: _nextCheckpointMs, progressFingerprint: _fingerprint, ...rest } = attempt;
  const elapsed = elapsedTime(attempt);
  const fingerprint = progressFingerprint(attempt, typed, elapsed);
  const version = (attempt.progressVersion ?? 0) + Number(attempt.progressFingerprint !== fingerprint);
  const data: PracticeDraft = { ...rest, revision: attempt.revision + 1, progressVersion: version, version: 1, elapsedMs: elapsed, typed, completed, early, savedAt: Date.now(), leaseOwner: owner, leaseAt: Date.now() };
  try {
    localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify(data));
    attempt.revision = data.revision;
    attempt.progressVersion = data.progressVersion;
    attempt.progressFingerprint = fingerprint;
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
    recordId: result.attemptId ?? attempt.recordId, ownerId: attempt.ownerId, localOnly: result.offline, article: articleSnapshot(attempt, attempt.target), typed,
    offset: attempt.offset ?? 0, total: result.score.total, correct: result.score.correct, articleTotal: result.articleTotal,
    mode: attempt.mode ?? 'timed', strict: !!attempt.strict, mistakes: [...(attempt.mistakes ?? [])],
  };
}

function workspaceDraft(attempt: Attempt, typed: string): SavedPractice {
  const article = articleSnapshot(attempt, attempt.target);
  return {
    id: practiceDraftId(attempt.recordId), article, typed, elapsedMs: Math.round(elapsedTime(attempt)), backspaces: attempt.backspaces,
    duration: attempt.duration, mode: attempt.mode ?? 'timed', strict: !!attempt.strict, offset: attempt.offset ?? 0,
    recordId: attempt.recordId, attemptId: attempt.id, recoveryId: attempt.recoveryId, recoveryKey: attempt.recoveryKey,
    claimVersion: attempt.claimVersion, recoveryMarker: attempt.recoveryMarker,
    recoveryBaseVersion: attempt.recoveryRequestId ? attempt.recoveryBaseVersion : undefined,
    progressVersion: attempt.progressVersion, personalOnly: attempt.personalOnly, offline: attempt.offline,
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
    id: custom || saved.offset > 0 || saved.personalOnly ? undefined : saved.attemptId, recoveryId: saved.recoveryId, recoveryKey: saved.recoveryKey,
    claimVersion: saved.claimVersion, progressVersion: saved.progressVersion, recoveryBaseVersion: saved.progressVersion, personalOnly: saved.personalOnly, recordId: saved.recordId, revision, offline,
    elapsedMs: Math.min(durationLimit(saved), Math.max(0, saved.elapsedMs)), startedAt: null, nextCheckpointMs: saved.elapsedMs + 5000,
    backspaces: saved.backspaces, suspicious: !!saved.suspicious, offset: Math.min(saved.offset, splitCharacters(typed).length), mistakes: [...(saved.mistakes ?? []).slice(0, mistakeLimit)],
  };
}

export function usePractice(config: PracticeConfig, initialDraft: PracticeDraft | null) {
  const ownerToken = useRef(uniqueId());
  const [draft] = useState<PracticeDraft | null>(() => initialDraft && leaseTaken(initialDraft, ownerToken.current) && !initialDraft.completed ? { ...initialDraft, id: undefined, recoveryId: undefined, recoveryKey: undefined, claimId: undefined, claimVersion: undefined, recoveryRequestId: undefined, recoveryMarker: undefined, progressVersion: 0, recoveryBaseVersion: undefined, personalOnly: true, recordId: uniqueId(), revision: 0, offline: true, legacy: false, leaseOwner: null, leaseAt: 0 } : initialDraft);
  const wasForked = !!draft && !!initialDraft && draft.recordId !== initialDraft.recordId;
  const restoredAttempt: Attempt | null = draft ? { ...draft, recoveryBaseVersion: draft.recoveryBaseVersion ?? draft.progressVersion, progressFingerprint: progressFingerprint(draft, draft.typed, draft.elapsedMs), startedAt: null, nextCheckpointMs: draft.elapsedMs + 5000 } : null;
  const initialPhase: PracticePhase = draft ? (draft.completed || (draft.id && !draft.offline) ? 'restoring' : 'paused') : 'ready';
  const [phase, setPhase] = useState<PracticePhase>(initialPhase);
  const phaseRef = useRef<PracticePhase>(initialPhase);
  const [storedTarget, setTarget] = useState(draft?.target ?? config.text);
  const target = phase === 'ready' ? config.text : storedTarget;
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
  const pendingStart = useRef<{ attempt: Attempt; promise: Promise<void> } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const composing = useRef(false);
  const pendingSuspicious = useRef(false);
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
      attempt.recordId = uniqueId(); attempt.revision = 0; attempt.id = undefined; attempt.recoveryId = undefined; attempt.recoveryKey = undefined; attempt.claimId = undefined; attempt.claimVersion = undefined; attempt.recoveryRequestId = undefined; attempt.recoveryMarker = undefined; attempt.progressVersion = 0; attempt.recoveryBaseVersion = undefined; attempt.progressFingerprint = undefined; attempt.personalOnly = true; attempt.offline = true; attempt.legacy = false; attempt.pendingStart = false;
      setFeedback(!deleted && existing ? '原进度正在其他标签页使用，已另存。' : '原草稿已移除，已另存。');
      return true;
    }
    return false;
  };
  const emitDraft = (attempt: Attempt, typed: string, force = false, snapshot?: SavedPractice) => {
    if (attempt.pendingStart || isDeleted(attempt) || (!force && performance.now() - lastWorkspaceSave.current < draftIntervalMs)) return;
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

  function detachFromOnline(attempt: Attempt, message: string) {
    if (storedDraft(attempt.recordId)?.completed) clearDraft(attempt, ownerToken.current);
    releaseLease(attempt, ownerToken.current);
    attempt.recordId = uniqueId(); attempt.revision = 0; attempt.progressVersion = 0; attempt.progressFingerprint = undefined;
    attempt.id = undefined; attempt.recoveryId = undefined; attempt.recoveryKey = undefined;
    attempt.claimId = undefined; attempt.claimVersion = undefined; attempt.recoveryRequestId = undefined; attempt.recoveryMarker = undefined; attempt.recoveryBaseVersion = undefined;
    attempt.personalOnly = true; attempt.offline = true; attempt.pendingStart = false;
    setFeedback(message);
    if (['running', 'paused', 'pausing', 'resuming'].includes(phaseRef.current)) persist(attempt, true);
  }

  function handleRecoveryConflict(attempt: Attempt, error: unknown) {
    if (!(error instanceof ApiError)) return false;
    if (error.code === 'PRACTICE_TAKEN') { detachFromOnline(attempt, '进度已在其他设备继续，当前练习已另存。'); return true; }
    if (error.code === 'DRAFT_DELETED') { detachFromOnline(attempt, '草稿已在其他设备删除，当前练习已另存。'); return true; }
    if (error.code === 'DRAFT_MISMATCH') { detachFromOnline(attempt, '草稿状态已变化，当前练习已另存。'); return true; }
    if (error.code === 'DRAFT_STALE') { detachFromOnline(attempt, '其他设备有更新，当前练习已另存。'); return true; }
    if (error.code === 'SCORE_FINALIZED') { detachFromOnline(attempt, '这次成绩已提交或审核结束。'); return true; }
    return false;
  }

  const settle = (attempt: Attempt, final: PracticeResult, typed: string) => {
    const entry = recordResult(attempt, final, typed);
    const recordId = final.attemptId ?? attempt.recordId;
    const previous = localHistory().find((item) => (item.recordId === recordId || item.recordId === attempt.recordId) && item.ownerId === attempt.ownerId);
    const alreadyRecorded = recorded.current.has(recordId) || !!previous;
    if (!alreadyRecorded || (!final.offline && previous?.localOnly)) {
      recorded.current.add(recordId);
      rememberHistory(entry, attempt.recordId);
      notify(liveConfig.current.onRecord, entry);
      if (previous?.recordId && previous.recordId !== recordId) notify(liveConfig.current.onReplaceRecord, previous.recordId, attempt.ownerId);
    }
    const characters = committed();
    const offset = attempt.offset ?? 0;
    const expected = targetCharacters.current ??= splitCharacters(attempt.target);
    const nextOffset = continuationOffset(attempt.strict, offset, characters, expected);
    if (nextOffset < final.articleTotal) {
      const next: Attempt = {
        ...attempt, id: undefined, recoveryId: undefined, recoveryKey: undefined, claimId: undefined, claimVersion: undefined, recoveryRequestId: undefined, recoveryMarker: undefined, progressVersion: 0, recoveryBaseVersion: undefined, progressFingerprint: undefined, personalOnly: true, recordId: nextRecordId(recordId), revision: 0, legacy: false,
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
    const keepResult = (final.offline && final.elapsedMs >= 1000 && recoverableId(attempt)) || (!final.offline && !final.submitted && final.eligible && final.attemptId);
    if (keepResult) {
      const saved = storedDraft(attempt.recordId);
      if (!saved || !leaseTaken(saved, ownerToken.current)) {
        saveDraft(attempt, typed, ownerToken.current, true, !!saved?.early);
        emitDraft(attempt, typed, true);
      }
    }
    if (!keepResult && clearDraft(attempt, ownerToken.current) && !isDeleted(attempt)) removeWorkspaceDraft(attempt);
    setResult(final); setCurrentPhase('finished');
  };

  async function recoverOnline(attempt: Attempt, expectedPhase: 'paused' | 'pausing' | 'restoring' | 'resuming' | 'finishing' | 'finished', allowReplacement = true): Promise<RecoveryState | undefined> {
    let id = recoverableId(attempt);
    if (!id) return undefined;
    attempt.claimId ??= clientChallengeId();
    attempt.claimVersion ??= 0;
    attempt.recoveryRequestId ??= clientChallengeId();
    attempt.recoveryMarker ??= clientChallengeId();
    attempt.recoveryBaseVersion ??= attempt.progressVersion ?? 0;
    if (!attempt.claimId || !attempt.recoveryRequestId || !attempt.recoveryMarker) return undefined;
    const recordId = attempt.recordId;
    const current = () => isCurrent(attempt, expectedPhase) && attempt.recordId === recordId &&
      liveConfig.current.ownerId === attempt.ownerId && (expectedPhase === 'finished' || !isDeleted(attempt));
    const saveRequest = () => {
      const saved = storedDraft(attempt.recordId);
      if (expectedPhase === 'finished' && (!saved?.completed || leaseTaken(saved, ownerToken.current))) return;
      if (saved?.completed) saveDraft(attempt, typedRef.current, ownerToken.current, true, !!saved.early);
      else persist(attempt, true);
    };
    saveRequest();
    if (!current()) return undefined;
    const recover = (clientId: string) => api<RecoveryState>('/api/tests/recover', {
      method: 'POST', timeoutMs: 5000, headers: { 'X-Workspace-Owner': attempt.ownerId ?? 'guest' }, body: {
        clientId, ...(attempt.recoveryKey && { recoveryKey: attempt.recoveryKey }),
        claimId: attempt.claimId, expectedClaimVersion: attempt.claimVersion, recoveryRequestId: attempt.recoveryRequestId,
        expectedProgressVersion: attempt.recoveryBaseVersion, recoveryMarker: attempt.recoveryMarker,
        ...(expectedPhase !== 'finished' && { draftId: practiceDraftId(attempt.recordId) }),
        articleId: attempt.articleId, target: attempt.target,
        ...(attempt.article && { articleKey: catalogSnapshotKey(attempt.article) }),
        duration: attempt.duration, mode: attempt.mode ?? 'timed', strict: !!attempt.strict,
        elapsedMs: Math.round(elapsedTime(attempt)),
      },
    });
    try {
      let state: RecoveryState;
      try { state = await recover(id); }
      catch (error) {
        if (error instanceof ApiError && error.code === 'RECOVERY_ALREADY_USED' && Number.isSafeInteger(error.claimVersion) && error.claimVersion! > 0 && current()) {
          attempt.claimVersion = error.claimVersion;
          attempt.recoveryRequestId = clientChallengeId();
          attempt.recoveryMarker = clientChallengeId();
          if (!attempt.recoveryRequestId || !attempt.recoveryMarker) throw error;
          saveRequest();
          state = await recover(id);
        } else {
        // A guest cookie may have been lost with the original response. Do
        // not claim another owner's record; create a separately reviewed round.
          const replacement = allowReplacement && error instanceof ApiError && error.status === 404 ? clientChallengeId() : undefined;
          if (!replacement || !current()) throw error;
          id = replacement;
          state = await recover(id);
        }
      }
      if (!current()) return undefined;
      if (state.id !== id || !['paused', 'finished', 'review'].includes(state.status) ||
        (state.status === 'paused' && (!Number.isFinite(state.remainingMs) || !Number.isFinite(state.elapsedMs) || state.elapsedMs! < 0 || state.elapsedMs! > durationLimit(attempt))) ||
        (state.status !== 'paused' && !state.result) || !Number.isSafeInteger(state.claimVersion) || state.claimVersion! < 1) throw new Error('练习恢复数据无效');
      attempt.id = id; attempt.recoveryId = id; attempt.offline = false; attempt.pendingStart = false;
      attempt.claimVersion = state.claimVersion; attempt.recoveryRequestId = undefined;
      attempt.recoveryMarker = undefined;
      attempt.recoveryBaseVersion = undefined;
      if (state.result && state.typed !== undefined) {
        if (typeof state.typed !== 'string' || !Number.isSafeInteger(state.backspaces) || state.backspaces! < 0 ||
          !Number.isFinite(state.result.elapsedMs) || state.result.elapsedMs < 0 || state.result.elapsedMs > durationLimit(attempt)) throw new Error('成绩数据无效');
        const confirmed = splitCharacters(state.typed);
        const verified = scoreTyping(attempt.target, state.typed, Math.max(state.result.elapsedMs / 1000, 0.1));
        if (confirmed.length > splitCharacters(attempt.target).length || verified.total !== state.result.score.total || verified.correct !== state.result.score.correct) throw new Error('成绩数据无效');
        typedRef.current = state.typed; committedCharacters.current = confirmed; attempt.backspaces = state.backspaces!;
        attempt.elapsedMs = state.result.elapsedMs; setElapsedMs(attempt.elapsedMs);
        setTyped(state.typed); setRaw(state.typed); setBackspaces(state.backspaces!);
      }
      if (state.result && expectedPhase === 'finished') {
        const saved = storedDraft(attempt.recordId);
        if (saved?.completed && !leaseTaken(saved, ownerToken.current)) saveDraft(attempt, typedRef.current, ownerToken.current, true, !!saved.early);
      }
      if (state.status === 'paused' && state.elapsedMs! > attempt.elapsedMs) { attempt.elapsedMs = state.elapsedMs!; setElapsedMs(attempt.elapsedMs); }
      setFeedback('');
      return state;
    } catch (error) {
      if (!current()) return undefined;
      if (isGuestPracticeDisabled(error)) {
        attempt.personalOnly = true;
        attempt.offline = true;
        attempt.recoveryRequestId = undefined;
        setFeedback(guestPracticeDisabledMessage);
        if (expectedPhase === 'paused') persist(attempt, true);
      } else if (!handleRecoveryConflict(attempt, error)) {
        attempt.offline = true;
        setFeedback(error instanceof ApiError && error.status === 404 ? '文章或账号状态已变化，无法恢复上榜。' : '网络暂不可用，进度暂存本机。');
      }
      return undefined;
    }
  }

  async function completeOnline(attempt: Attempt, used: number, value: string, early: boolean, expectedPhase: 'restoring' | 'finishing') {
    let final = localResult(attempt, Math.max(used, attempt.elapsedMs), value);
    if ((attempt.offline || expectedPhase === 'restoring') && recoverableId(attempt)) {
      const recovered = await recoverOnline(attempt, expectedPhase);
      if (!isCurrent(attempt, expectedPhase)) return undefined;
      if (recovered?.result) return withServerResult(localResult(attempt, recovered.result.elapsedMs, typedRef.current), recovered.result);
      final = localResult(attempt, Math.max(used, attempt.elapsedMs), value);
      const saved = storedDraft(attempt.recordId);
      if (recovered && (!saved || !leaseTaken(saved, ownerToken.current))) saveDraft(attempt, value, ownerToken.current, true, early);
    }
    if (!attempt.id || attempt.offline) return { ...final, offline: true };
    const finishRequest = () => api<ServerResult>(`/api/tests/${attempt.id}/finish`, {
      method: 'POST', headers: practiceClaim(attempt), body: { typed: value, suspicious: attempt.suspicious, backspaces: attempt.backspaces, elapsedMs: Math.round(Math.max(used, attempt.elapsedMs)), early },
    });
    try {
      if (expectedPhase === 'restoring') {
        const state = await api<{ result?: ServerResult }>(`/api/tests/${attempt.id}`, { headers: practiceClaim(attempt) });
        if (!isCurrent(attempt, expectedPhase)) return undefined;
        if (state.result) return withServerResult(final, state.result);
      }
      return withServerResult(final, await finishRequest());
    }
    catch (error) {
      if (!isCurrent(attempt, expectedPhase)) return undefined;
      if (handleRecoveryConflict(attempt, error)) return localResult(attempt, Math.max(used, attempt.elapsedMs), value);
      attempt.offline = true;
      const recovered = await recoverOnline(attempt, expectedPhase);
      if (!isCurrent(attempt, expectedPhase)) return undefined;
      if (recovered?.result) return withServerResult(localResult(attempt, recovered.result.elapsedMs, typedRef.current), recovered.result);
      if (recovered?.status === 'paused') {
        final = localResult(attempt, Math.max(used, attempt.elapsedMs), value);
        const saved = storedDraft(attempt.recordId);
        if (!saved || !leaseTaken(saved, ownerToken.current)) saveDraft(attempt, value, ownerToken.current, true, early);
        try { return withServerResult(final, await finishRequest()); }
        catch (error) { if (!isCurrent(attempt, expectedPhase)) return undefined; if (handleRecoveryConflict(attempt, error)) return localResult(attempt, Math.max(used, attempt.elapsedMs), value); attempt.offline = true; }
      }
      return { ...final, offline: true };
    }
  }

  async function pauseOnline(attempt: Attempt, expectedPhase: 'pausing' | 'restoring', force = true) {
    let fellBack = false;
    let paused = false;
    if (attempt.id && !attempt.offline && !(expectedPhase === 'restoring' && recoverableId(attempt))) {
      try {
        const state = await api<{ remainingMs: number }>(`/api/tests/${attempt.id}/pause`, { method: 'POST', headers: practiceClaim(attempt), body: {} });
        if (!Number.isFinite(state.remainingMs) || state.remainingMs <= 0) throw new Error('在线计时不可用');
        paused = true;
      } catch (error) {
        if (!isCurrent(attempt, expectedPhase)) return false;
        if (handleRecoveryConflict(attempt, error)) { setCurrentPhase('paused'); return true; }
        attempt.offline = true;
        fellBack = true;
      }
    }
    if (!paused && recoverableId(attempt)) {
      const recovered = await recoverOnline(attempt, expectedPhase);
      if (!isCurrent(attempt, expectedPhase)) return false;
      if (recovered?.result) { settle(attempt, withServerResult(localResult(attempt, attempt.elapsedMs, typedRef.current), recovered.result), typedRef.current); return true; }
      if (recovered?.status === 'paused') { paused = true; fellBack = true; }
    }
    if (!paused && attempt.id) { attempt.offline = true; fellBack = true; }
    if (!isCurrent(attempt, expectedPhase)) return false;
    persist(attempt, force || fellBack); setCurrentPhase('paused');
    if (paused && attempt.elapsedMs >= durationLimit(attempt)) void finish(false);
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
    const final = !attempt.id && !recoverableId(attempt) ? localResult(attempt, attempt.elapsedMs, value) : await completeOnline(attempt, attempt.elapsedMs, value, !!saved.early, 'restoring');
    if (final && isCurrent(attempt, 'restoring')) settle(attempt, final, typedRef.current);
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
    attempt.progressFingerprint = progressFingerprint(attempt, typed, attempt.elapsedMs);
    targetCharacters.current = null; committedCharacters.current = null;
    setTarget(attempt.target); setTyped(typed); setRaw(typed); setElapsedMs(attempt.elapsedMs); setBackspaces(attempt.backspaces);
    setFeedback(''); setResult(null); setRestored(true);
  }

  async function loadLegacy(saved: PracticeDraft) {
    if ((saved.ownerId ?? null) !== liveConfig.current.ownerId || !mounted.current) return;
    if (draftAwaitingStart(saved) && saved.leaseOwner !== ownerToken.current) return;
    const previous = attemptRef.current;
    if (previous && phaseRef.current === 'running' && !await park()) return;
    if (previous !== attemptRef.current || !mounted.current || (saved.ownerId ?? null) !== liveConfig.current.ownerId) return;
    const attempt: Attempt = { ...saved, pendingStart: false, recoveryBaseVersion: saved.recoveryBaseVersion ?? saved.progressVersion, startedAt: null, nextCheckpointMs: saved.elapsedMs + 5000 };
    bindAttempt(attempt, saved.typed);
    if (isDeleted(attempt)) {
      if (saved.completed) { attempt.offline = true; attempt.personalOnly = true; setResult(localResult(attempt, attempt.elapsedMs, saved.typed)); setCurrentPhase('finished'); }
      else setCurrentPhase('ready');
      return;
    }
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
      let saved = storedDraft(attempt.recordId);
      if (attempt.pendingStart) {
        ++startRequest.current; attempt.pendingStart = false;
        if (phaseRef.current === 'finishing') saveDraft(attempt, typedRef.current, ownerToken.current, true, !!saved?.early);
        else if (phaseRef.current !== 'running') saveDraft(attempt, typedRef.current, ownerToken.current);
        if (phaseRef.current === 'pausing') setCurrentPhase('paused');
        saved = storedDraft(attempt.recordId);
      }
      if (phaseRef.current === 'running') {
        ++startRequest.current;
        const used = elapsedTime(attempt);
        composing.current = false; setRaw(typedRef.current);
        attempt.elapsedMs = used; attempt.startedAt = null; clearTimer(); setElapsedMs(used); setCurrentPhase('paused');
        persist(attempt, true);
        if (attempt.id && !attempt.offline) {
          const claim = practiceClaim(attempt);
          if (claim) {
            void fetch(`/api/tests/${attempt.id}/pause`, { method: 'POST', credentials: 'same-origin', keepalive: true,
              headers: { ...claim, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
          } else if (typeof navigator.sendBeacon === 'function') {
            navigator.sendBeacon(`/api/tests/${attempt.id}/pause`, new Blob(['{}'], { type: 'application/json' }));
          }
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
    let recoveringPaused = false;
    const retryPaused = () => {
      const attempt = attemptRef.current;
      if (attempt && !parked.current && phaseRef.current === 'paused' && attempt.offline && attempt.recoveryRequestId && recoverableId(attempt) && !recoveringPaused && document.visibilityState !== 'hidden') {
        recoveringPaused = true;
        void recoverOnline(attempt, 'paused').then((state) => {
          if (!isCurrent(attempt, 'paused')) return;
          if (state?.result) { settle(attempt, withServerResult(localResult(attempt, attempt.elapsedMs, typedRef.current), state.result), typedRef.current); return; }
          if (state?.status === 'paused') { persist(attempt, true); if (attempt.elapsedMs >= durationLimit(attempt)) void finish(false); }
        }).finally(() => { recoveringPaused = false; });
      }
    };
    const heartbeat = setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || parked.current || !['running', 'paused', 'restoring', 'pausing', 'resuming'].includes(phaseRef.current)) return;
      retryPaused();
      if (phaseRef.current === 'running' && isDeleted(attempt)) { persist(attempt, true); return; }
      const saved = storedDraft(attempt.recordId);
      if (saved && !saved.completed && saved.revision === attempt.revision && !leaseTaken(saved, ownerToken.current)) {
        try { localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify({ ...saved, leaseOwner: ownerToken.current, leaseAt: Date.now() })); } catch { /* Progress remains usable in memory. */ }
      }
    }, 5000);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', retryPaused);
    const onVisibilityChange = () => {
      if (liveConfig.current.autoPause && document.visibilityState === 'hidden' && phaseRef.current === 'running') void pause();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { mounted.current = false; window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow); window.removeEventListener('online', retryPaused); document.removeEventListener('visibilitychange', onVisibilityChange); clearInterval(heartbeat); clearTimer(); if (attemptRef.current) releaseLease(attemptRef.current, ownerToken.current); };
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
    const savedLocally = saveDraft(attempt, value, ownerToken.current, true, early);
    if (pendingStart.current?.attempt === attempt) await pendingStart.current.promise;
    if (!isCurrent(attempt, 'finishing')) return;
    let latestDraft = storedDraft(attempt.recordId);
    if (savedLocally && latestDraft && !latestDraft.leaseOwner && latestDraft.revision === attempt.revision && !isDeleted(attempt)) {
      saveDraft(attempt, value, ownerToken.current, true, early);
      latestDraft = storedDraft(attempt.recordId);
    }
    if (savedLocally && (!latestDraft || latestDraft.leaseOwner !== ownerToken.current || latestDraft.revision !== attempt.revision || isDeleted(attempt))) {
      setResult(localResult(attempt, used, value)); setCurrentPhase('finished'); return;
    }
    // Save the final online identity as well, so a reload can recover the
    // result even when the start response arrived during settlement.
    saveDraft(attempt, value, ownerToken.current, true, early);
    const final = !attempt.id && !recoverableId(attempt) ? localResult(attempt, used, value) : await completeOnline(attempt, used, value, early, 'finishing');
    if (final && isCurrent(attempt, 'finishing')) settle(attempt, final, typedRef.current);
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
        void api(`/api/tests/${attempt.id}/checkpoint`, { method: 'POST', headers: practiceClaim(attempt), body: { typed: typedRef.current, elapsedMs: Math.round(used) } }).catch((error: unknown) => {
          if (isCurrent(attempt, 'running')) handleRecoveryConflict(attempt, error);
        });
      }
      if (Math.floor(used / 1000) !== Math.floor(Math.max(0, used - 100) / 1000)) persist(attempt);
    }, 100);
  }, [finish, persist]);

  // Start locally on the first edit so server setup never delays typing or the
  // clock. Pause and settlement coordinate with the bounded setup request.
  function startFromInput() {
    const settings = liveConfig.current;
    if (phaseRef.current !== 'ready' || !validDuration(settings.duration) || !settings.text) return;
    const request = ++startRequest.current;
    const { articleId, title, language, difficulty, duration, custom, ownerId, article, mode = 'timed', strict = false } = settings;
    const clientId = custom ? undefined : clientChallengeId();
    const recoveryKey = clientId ? clientRecoveryKey() : undefined;
    const claimId = clientId ? clientChallengeId() : undefined;
    const attempt: Attempt = {
      articleId, title, language, difficulty, duration, custom, ownerId, article, mode, strict,
      text: settings.text, recordId: clientId ?? uniqueId(), recoveryId: clientId, recoveryKey, claimId, claimVersion: claimId ? 1 : undefined, revision: 0, target: settings.text, offline: true, pendingStart: !!clientId && !!claimId,
      elapsedMs: 0, startedAt: performance.now(), suspicious: pendingSuspicious.current,
      backspaces: 0, nextCheckpointMs: 5000, offset: 0, mistakes: [],
    };
    const originalRecordId = attempt.recordId;
    pendingSuspicious.current = false;
    parked.current = false; lastBackspaceKey.current = -Infinity;
    targetCharacters.current = null; committedCharacters.current = null;
    attemptRef.current = attempt; setTarget(attempt.target); setFeedback(''); setResult(null); setRestored(false);
    setBackspaces(0); setElapsedMs(0); setCurrentPhase('running'); persist(attempt, true); beginClock();
    if (!custom && clientId && claimId) {
      const current = () => mounted.current && attemptRef.current === attempt && startRequest.current === request &&
        attempt.recordId === originalRecordId && ['running', 'pausing', 'finishing'].includes(phaseRef.current);
      const promise = (async () => {
        try {
          const challenge = await api<{ id: string; target: string }>('/api/tests/start', {
            method: 'POST', timeoutMs: 3000, headers: { 'X-Workspace-Owner': ownerId ?? 'guest' }, body: {
              articleId, duration, mode, strict, clientId, draftId: practiceDraftId(attempt.recordId), ...(recoveryKey && { recoveryKey }), ...(claimId && { claimId }),
              ...(settings.guardCatalog && article ? { articleKey: catalogSnapshotKey(article) } : {}),
            },
          });
          if (challenge.id !== clientId || challenge.target !== attempt.target) throw new Error('练习数据无效');
          if (!current()) return;
          attempt.id = challenge.id; attempt.offline = false; attempt.pendingStart = false;
          if (phaseRef.current !== 'finishing') persist(attempt, true);
        } catch (error) {
          if (!current()) return;
          attempt.pendingStart = false;
          if (settings.guardCatalog && error instanceof ApiError && (error.status === 409 || error.status === 400)) settings.onCatalogStale?.();
          if (isGuestPracticeDisabled(error)) {
            attempt.personalOnly = true;
            setFeedback(guestPracticeDisabledMessage);
          } else setFeedback('网络暂不可用，进度暂存本机。');
          if (phaseRef.current !== 'finishing') persist(attempt, true);
        }
      })();
      pendingStart.current = { attempt, promise };
      void promise.finally(() => { if (pendingStart.current?.promise === promise) pendingStart.current = null; });
    } else if (!custom) setFeedback('在线练习不可用，已转为个人练习。');
    queueMicrotask(() => { if (isCurrent(attempt, 'running') && liveConfig.current.autoPause && document.visibilityState === 'hidden') void pause(); });
  }

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
    let personalOnly = false;
    if (!custom) {
      try {
        const challenge = await api<{ id: string; target: string }>('/api/tests/start', {
          method: 'POST', headers: { 'X-Workspace-Owner': ownerId ?? 'guest' }, body: {
            articleId, duration, mode, strict,
            ...(config.guardCatalog && article ? { articleKey: catalogSnapshotKey(article) } : {}),
          },
        });
        if (typeof challenge.id !== 'string' || !validAttemptId(challenge.id) || typeof challenge.target !== 'string' || !challenge.target || challenge.target.length > maxTextLength) throw new Error('练习数据无效');
        id = challenge.id; testTarget = challenge.target;
      } catch (error) {
        if (config.guardCatalog && error instanceof ApiError && (error.status === 409 || error.status === 400)) config.onCatalogStale?.();
        offline = true;
        personalOnly = isGuestPracticeDisabled(error);
      }
    }
    if (!current()) {
      if (mounted.current && startRequest.current === request) setCurrentPhase('ready');
      return;
    }
    if (offline && !custom) setFeedback(personalOnly ? guestPracticeDisabledMessage : '在线练习不可用，已转为个人练习。');
    const attempt: Attempt = { articleId, title, language, difficulty, duration, custom, ownerId, article, mode, strict, text: testTarget, id, recordId: id || uniqueId(), revision: 0, target: testTarget, offline, personalOnly, elapsedMs: 0, startedAt: performance.now(), suspicious: false, backspaces: 0, nextCheckpointMs: 5000, offset: 0, mistakes: [] };
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
    if (pendingStart.current?.attempt === attempt) await pendingStart.current.promise;
    if (!isCurrent(attempt, 'pausing')) return false;
    return pauseOnline(attempt, 'pausing', false);
  }

  async function resume() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'paused') return;
    parked.current = false;
    if (isDeleted(attempt)) persist(attempt, true);
    else ensureOwnership(attempt);
    setCurrentPhase('resuming');
    if (attempt.offline && recoverableId(attempt)) {
      const recovered = await recoverOnline(attempt, 'resuming');
      if (!isCurrent(attempt, 'resuming')) return;
      if (recovered?.result) { settle(attempt, withServerResult(localResult(attempt, attempt.elapsedMs, typedRef.current), recovered.result), typedRef.current); return; }
      if (recovered?.status === 'paused' && attempt.elapsedMs >= durationLimit(attempt)) {
        setCurrentPhase('paused'); void finish(false); return;
      }
    }
    if (attempt.id && !attempt.offline) {
      try {
        const state = await api<{ remainingMs: number }>(`/api/tests/${attempt.id}/resume`, { method: 'POST', headers: practiceClaim(attempt), body: {} });
        if (!Number.isFinite(state.remainingMs) || state.remainingMs <= 0) throw new Error('在线计时不可用');
      } catch (error) {
        if (!isCurrent(attempt, 'resuming')) return;
        if (handleRecoveryConflict(attempt, error)) {
          attempt.startedAt = performance.now(); setCurrentPhase('running'); beginClock(); return;
        }
        attempt.offline = true;
        const recovered = await recoverOnline(attempt, 'resuming');
        if (!isCurrent(attempt, 'resuming')) return;
        if (recovered?.result) { settle(attempt, withServerResult(localResult(attempt, attempt.elapsedMs, typedRef.current), recovered.result), typedRef.current); return; }
        if (recovered?.status === 'paused' && attempt.elapsedMs >= durationLimit(attempt)) {
          setCurrentPhase('paused'); void finish(false); return;
        }
        if (recovered?.status === 'paused' && recovered.remainingMs && recovered.remainingMs > 0) {
          try {
            const state = await api<{ remainingMs: number }>(`/api/tests/${attempt.id}/resume`, { method: 'POST', headers: practiceClaim(attempt), body: {} });
            if (!Number.isFinite(state.remainingMs) || state.remainingMs <= 0) throw new Error('在线计时不可用');
          } catch (error) { if (!isCurrent(attempt, 'resuming')) return; if (!handleRecoveryConflict(attempt, error)) { attempt.offline = true; setFeedback('网络暂不可用，进度暂存本机。'); } }
        }
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

  async function retryOnline() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'finished' || !result?.offline || !recoverableId(attempt)) return;
    const saved = storedDraft(attempt.recordId) ?? { ...attempt, version: 1 as const, typed: typedRef.current, completed: true, early: true };
    parked.current = false;
    setCurrentPhase('restoring');
    await restoreAttempt(attempt, { ...saved, completed: true });
  }

  async function recoverForRanking(attemptId: string) {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'finished' || !result?.eligible || attempt.id !== attemptId) return false;
    const id = attemptId;
    const state = await recoverOnline(attempt, 'finished', false);
    if (!state?.result || state.id !== id || !isCurrent(attempt, 'finished')) return false;
    return true;
  }

  function markRankSubmitted(attemptId: string) {
    const attempt = attemptRef.current;
    if (attempt && attempt.id === attemptId && phaseRef.current === 'finished' && clearDraft(attempt, ownerToken.current) && !isDeleted(attempt)) removeWorkspaceDraft(attempt);
  }

  async function loadSaved(saved: SavedPractice, options?: { newRound?: boolean }) {
    if (saved.ownerId !== liveConfig.current.ownerId || !validDuration(saved.duration) || !saved.article.text || saved.article.text.length > maxTextLength) return;
    const previous = attemptRef.current;
    if (previous && phaseRef.current === 'running' && !await park()) return;
    if (previous !== attemptRef.current || !mounted.current || saved.ownerId !== liveConfig.current.ownerId) return;
    const stored = storedDraft(saved.recordId);
    const local = stored?.version === 1 && stored.recordId === saved.recordId && stored.ownerId === saved.ownerId &&
      stored.articleId === saved.article.id && stored.target === saved.article.text && stored.duration === saved.duration &&
      (stored.mode ?? 'timed') === saved.mode && !!stored.strict === saved.strict ? stored : null;
    const localAvailable = !!local && !leaseTaken(local, ownerToken.current);
    if (localAvailable) {
      const localSnapshot = savedPracticeFromLegacy(local!);
      const comparison = compareDraftProgress(localSnapshot, saved);
      if (comparison > 0 || (comparison === 0 && sameDraftSnapshot(localSnapshot, saved))) { await loadLegacy(local!); return; }
    }
    const expected = splitCharacters(saved.article.text);
    const characters = boundedPrefix(splitCharacters(local && !localAvailable ? local.typed : saved.typed), expected.length);
    const typed = characters.join('');
    const synced = attemptFromSaved(saved, typed, localAvailable ? local!.revision : 0);
    if ((!local || localAvailable) && !options?.newRound && recoverableId(synced)) {
      bindAttempt(synced, typed);
      setCurrentPhase('restoring');
      await restoreAttempt(synced, { ...synced, version: 1, typed });
      return;
    }
    const fresh = options?.newRound && !stored && saved.offline && !saved.attemptId && validAttemptId(saved.recordId) &&
      saved.id === practiceDraftId(saved.recordId) && saved.elapsedMs === 0 && saved.backspaces === 0;
    const offset = continuationOffset(saved.strict, Math.min(saved.offset, characters.length), characters, expected);
    const attempt = attemptFromSaved({
      ...saved, attemptId: undefined, recoveryId: undefined, recoveryKey: undefined, claimId: undefined, claimVersion: undefined, recoveryRequestId: undefined, recoveryMarker: undefined, progressVersion: 0, personalOnly: true, recordId: fresh ? saved.recordId : uniqueId(), offline: true, offset: fresh ? saved.offset : offset, elapsedMs: 0,
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
    attemptRef.current = null; continuationRef.current = null; parked.current = false; typedRef.current = ''; composing.current = false; pendingSuspicious.current = false;
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
    if (phaseRef.current === 'ready' && event.target.value) startFromInput();
    if (phaseRef.current !== 'running') return;
    const input = event.nativeEvent as InputEvent;
    if (attemptRef.current && elapsedTime(attemptRef.current) >= durationLimit(attemptRef.current)) { void finish(false); return; }
    if (input.inputType === 'deleteContentBackward' && !composing.current && !input.isComposing && performance.now() - lastBackspaceKey.current > 250) recordBackspace();
    const value = prefix + event.target.value;
    if (composing.current || input.isComposing) setRaw(value);
    else commit(value, input.inputType?.startsWith('delete'));
  }
  function onCompositionStart() { if (phaseRef.current === 'running' || phaseRef.current === 'ready') composing.current = true; }
  function onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>, prefix = '') {
    const wasComposing = composing.current;
    composing.current = false;
    if (!wasComposing) { setRaw(typedRef.current); return; }
    if (phaseRef.current === 'ready' && event.currentTarget.value) startFromInput();
    if (phaseRef.current === 'running') commit(prefix + event.currentTarget.value);
  }
  function markSuspicious() {
    if (phaseRef.current === 'ready') pendingSuspicious.current = true;
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
  function updateTyped(value: string) {
    if (phaseRef.current === 'ready' && value) startFromInput();
    commit(value);
  }

  const attempt = attemptRef.current;
  const mode = (attempt ? attempt.mode : config.mode) ?? 'timed';
  const strict = attempt ? !!attempt.strict : !!config.strict;
  const duration = attempt?.duration ?? config.duration;
  const offset = attempt?.offset ?? 0;
  const draftId = attempt ? practiceDraftId(attempt.recordId) : undefined;
  const canRetryOnline = !!(result?.offline && result.elapsedMs >= 1000 && attempt && recoverableId(attempt));
  const getClaimHeaders = () => attemptRef.current ? practiceClaim(attemptRef.current) : undefined;
  return { phase, target, raw, typed, elapsedMs, backspaces, feedback, result, restored, mode, strict, duration, offset, draftId, textareaRef, start, pause, resume, retryOnline, recoverForRanking, markRankSubmitted, getClaimHeaders, canRetryOnline, reset, finish, park, loadSaved, loadLegacy, updateTyped, deletePreviousCharacter, onChange, onKeyDown, onCompositionStart, onCompositionEnd, markSuspicious };
}
