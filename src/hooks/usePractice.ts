import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type KeyboardEvent } from 'react';
import type { Difficulty, Language } from '../data/articles';
import { api } from '../lib/api';
import { scoreTyping, splitCharacters, type Score } from '../lib/scoring';

export type PracticePhase = 'ready' | 'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'restoring' | 'finishing' | 'finished';
export type PracticeConfig = { articleId: string; title: string; text: string; language: Language; difficulty: Difficulty; duration: number; custom: boolean; ownerId: string | null };
export type PracticeResult = { score: Score; attemptId?: string; status?: string; eligible?: boolean; offline: boolean; language: Language; elapsedMs: number; backspaces: number; errors: number; articleTotal: number; custom: boolean };
type Attempt = PracticeConfig & { id?: string; recordId: string; revision: number; legacy?: boolean; target: string; offline: boolean; elapsedMs: number; startedAt: number | null; suspicious: boolean; backspaces: number; nextCheckpointMs: number };
export type PracticeDraft = Omit<Attempt, 'startedAt' | 'nextCheckpointMs'> & { version: 1; typed: string; completed?: boolean; early?: boolean; savedAt?: number; leaseOwner?: string | null; leaseAt?: number };
export type History = { language: Language; difficulty: Difficulty; duration: number; speed: number; accuracy: number; finishedAt: number; status?: string; elapsedMs?: number; backspaces?: number; errors?: number; recordId?: string; ownerId?: string | null; localOnly?: boolean };
type ServerResult = { attemptId: string; score: Score; status: string; eligible: boolean; elapsedMs: number };

const legacyDraftKey = 'cloudtyping.practice.v1';
const draftPrefix = 'cloudtyping.practice.v2.';
const currentDraftKey = 'cloudtyping.current-practice.v2';
const historyKey = 'cloudtyping.history.v1';
const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const leaseTaken = (draft: PracticeDraft, owner: string) => !!draft.leaseOwner && draft.leaseOwner !== owner && typeof draft.leaseAt === 'number' && Date.now() - draft.leaseAt < 15_000;
function storedDraft(recordId: string): PracticeDraft | null {
  try { return JSON.parse(localStorage.getItem(draftPrefix + recordId) || 'null') as PracticeDraft | null; } catch { return null; }
}

export function localHistory(): History[] {
  try { const value = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(value) ? value.slice(0, 50) : []; } catch { return []; }
}
function rememberHistory(entry: History) {
  try { localStorage.setItem(historyKey, JSON.stringify([entry, ...localHistory().filter((item) => !entry.recordId || item.recordId !== entry.recordId)].slice(0, 50))); } catch { /* Practice still works without storage. */ }
}
export function readDraft(): PracticeDraft | null {
  try {
    let current: string | null = null;
    try { current = sessionStorage.getItem(currentDraftKey); } catch { /* Continue with the most recent saved draft. */ }
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => !!key && key.startsWith(draftPrefix));
    const candidates = keys.map((key) => { try { return JSON.parse(localStorage.getItem(key) || 'null') as PracticeDraft | null; } catch { return null; } }).filter((item): item is PracticeDraft => !!item);
    let legacy: PracticeDraft | null = null;
    try { legacy = JSON.parse(localStorage.getItem(legacyDraftKey) || 'null') as PracticeDraft | null; } catch { /* Other saved attempts can still be recovered. */ }
    if (legacy) candidates.push({ ...legacy, legacy: true });
    const valid = candidates.filter((data) => data.version === 1 && ['zh', 'en'].includes(data.language) && ['beginner', 'intermediate', 'advanced'].includes(data.difficulty) && Number.isInteger(data.duration) && data.duration >= 60 && data.duration <= 3600 && data.duration % 60 === 0 && typeof data.target === 'string' && !!data.target && data.target.length <= 30000 && typeof data.typed === 'string' && splitCharacters(data.typed).length <= splitCharacters(data.target).length && typeof data.articleId === 'string' && typeof data.title === 'string' && typeof data.elapsedMs === 'number' && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 && data.elapsedMs <= data.duration * 1000 && Number.isInteger(data.backspaces) && data.backspaces >= 0 && (data.id === undefined || (typeof data.id === 'string' && /^[\w-]{1,80}$/.test(data.id))));
    const data = valid.find((item) => item.recordId === current) ?? valid.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))[0] ?? null;
    if (!data) return null;
    if (typeof data.recordId !== 'string' || !data.recordId || data.recordId.length > 128) data.recordId = data.id || uniqueId();
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) data.revision = 0;
    if (typeof data.ownerId !== 'string') data.ownerId = null;
    if (data.elapsedMs === data.duration * 1000) { data.completed = true; data.early = false; }
    return data;
  } catch { return null; }
}
function clearDraft(attempt: Attempt | null, owner: string) {
  if (!attempt) return;
  const current = storedDraft(attempt.recordId);
  if (current && (leaseTaken(current, owner) || (current.revision ?? 0) > attempt.revision)) return;
  try { localStorage.removeItem(draftPrefix + attempt.recordId); if (attempt.legacy) localStorage.removeItem(legacyDraftKey); } catch { /* Nothing else to do. */ }
  try { if (sessionStorage.getItem(currentDraftKey) === attempt.recordId) sessionStorage.removeItem(currentDraftKey); } catch { /* Storage is optional. */ }
}
function elapsedTime(attempt: Attempt) {
  return Math.min(attempt.duration * 1000, attempt.elapsedMs + (attempt.startedAt === null ? 0 : Math.max(0, performance.now() - attempt.startedAt)));
}
function saveDraft(attempt: Attempt, typed: string, owner: string, completed = false, early = false) {
  attempt.revision++;
  const { startedAt: _startedAt, nextCheckpointMs: _nextCheckpointMs, ...rest } = attempt;
  const data: PracticeDraft = { ...rest, version: 1, elapsedMs: elapsedTime(attempt), typed, completed, early, savedAt: Date.now(), leaseOwner: owner, leaseAt: Date.now() };
  try {
    localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify(data));
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
  const score = scoreTyping(attempt.target, typed, Math.max(used / 1000, 0.1));
  return { score, offline: attempt.offline, language: attempt.language, elapsedMs: used, backspaces: attempt.backspaces, errors: score.total - score.correct, articleTotal: splitCharacters(attempt.target).length, custom: attempt.custom };
}
function withServerResult(local: PracticeResult, saved: ServerResult): PracticeResult {
  if (!saved.score || typeof saved.score.correct !== 'number' || typeof saved.score.total !== 'number' || typeof saved.score.accuracy !== 'number' || typeof saved.score.cpm !== 'number' || typeof saved.score.wpm !== 'number') throw new Error('成绩数据无效');
  return { ...local, ...saved, offline: false, elapsedMs: Number.isFinite(saved.elapsedMs) ? saved.elapsedMs : local.elapsedMs, errors: saved.score.total - saved.score.correct };
}
function recordResult(attempt: Attempt, result: PracticeResult) {
  rememberHistory({ language: attempt.language, difficulty: attempt.difficulty, duration: attempt.duration, speed: attempt.language === 'zh' ? result.score.cpm : result.score.wpm, accuracy: result.score.accuracy, finishedAt: Date.now(), status: result.status, elapsedMs: result.elapsedMs, backspaces: result.backspaces, errors: result.errors, recordId: attempt.recordId, ownerId: attempt.ownerId, localOnly: result.offline });
}

export function usePractice(config: PracticeConfig, initialDraft: PracticeDraft | null) {
  const ownerToken = useRef(uniqueId());
  const [draft] = useState<PracticeDraft | null>(() => initialDraft && leaseTaken(initialDraft, ownerToken.current) ? { ...initialDraft, id: undefined, recordId: uniqueId(), revision: 0, offline: true, legacy: false, leaseOwner: null, leaseAt: 0 } : initialDraft);
  const wasForked = !!draft && !!initialDraft && draft.recordId !== initialDraft.recordId;
  const restoredAttempt: Attempt | null = draft ? { ...draft, startedAt: null, nextCheckpointMs: draft.elapsedMs + 5000 } : null;
  const initialPhase: PracticePhase = draft ? (draft.completed || (draft.id && !draft.offline) ? 'restoring' : 'paused') : 'ready';
  const [phase, setPhase] = useState<PracticePhase>(initialPhase);
  const phaseRef = useRef<PracticePhase>(initialPhase);
  const [target, setTarget] = useState(draft?.target ?? config.text);
  const [raw, setRaw] = useState(draft?.typed ?? '');
  const [typed, setTyped] = useState(draft?.typed ?? '');
  const typedRef = useRef(draft?.typed ?? '');
  const [elapsedMs, setElapsedMs] = useState(draft?.elapsedMs ?? 0);
  const [backspaces, setBackspaces] = useState(draft?.backspaces ?? 0);
  const [feedback, setFeedback] = useState(wasForked ? '另一个标签页正在使用原进度，已复制为本地练习。' : draft ? '已恢复上次进度，点击继续练习。' : '');
  const [result, setResult] = useState<PracticeResult | null>(null);
  const [restored, setRestored] = useState(!!draft);
  const attemptRef = useRef<Attempt | null>(restoredAttempt);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const composing = useRef(false);
  const lastBackspaceKey = useRef(-Infinity);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const setCurrentPhase = (next: PracticePhase) => { phaseRef.current = next; setPhase(next); };
  const clearTimer = () => { if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; };
  const ensureOwnership = (attempt: Attempt) => {
    const existing = storedDraft(attempt.recordId);
    if (existing && (leaseTaken(existing, ownerToken.current) || (existing.revision ?? 0) > attempt.revision)) {
      attempt.recordId = uniqueId(); attempt.revision = 0; attempt.id = undefined; attempt.offline = true; attempt.legacy = false;
      setFeedback('另一个标签页正在使用原进度，已复制为本地练习。');
    }
  };
  const persist = useCallback((attempt: Attempt) => {
    ensureOwnership(attempt);
    if (!saveDraft(attempt, typedRef.current, ownerToken.current)) setFeedback('当前浏览器无法保存进度，请保持页面打开。');
  }, []);

  useEffect(() => {
    if (!draft || (!draft.completed && (!draft.id || draft.offline))) return;
    let cancelled = false;
    const restoreOnline = async () => {
      const attempt = attemptRef.current;
      if (!attempt) return;
      if (draft.completed) {
        let final = localResult(attempt, attempt.elapsedMs, typedRef.current);
        if (attempt.id && !attempt.offline) {
          try {
            const state = await api<{ status: string; result?: ServerResult }>(`/api/tests/${attempt.id}`);
            if (cancelled) return;
            const saved = state.result ?? await api<ServerResult>(`/api/tests/${attempt.id}/finish`, { method: 'POST', body: { typed: typedRef.current, suspicious: attempt.suspicious, backspaces: attempt.backspaces, elapsedMs: Math.round(attempt.elapsedMs), early: !!draft.early } });
            final = withServerResult(final, saved);
          } catch { final.offline = true; }
        }
        if (!cancelled) { recordResult(attempt, final); clearDraft(attempt, ownerToken.current); setResult(final); setCurrentPhase('finished'); }
        return;
      }
      try {
        const state = await api<{ elapsedMs: number; remainingMs: number }>(`/api/tests/${attempt.id}/pause`, { method: 'POST', body: {} });
        if (!Number.isFinite(state.remainingMs)) throw new Error('在线计时不可用');
      } catch {
        attempt.offline = true;
        if (!cancelled) setFeedback('已恢复本地进度；在线计时已中断，本次成绩仅保存到本机。');
      }
      if (!cancelled) { persist(attempt); setCurrentPhase('paused'); }
    };
    void restoreOnline();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => {
      const attempt = attemptRef.current;
      if (!attempt) return;
      if (phaseRef.current === 'running') {
        const used = elapsedTime(attempt);
        composing.current = false; setRaw(typedRef.current);
        attempt.elapsedMs = used; attempt.startedAt = null; clearTimer(); setElapsedMs(used); setCurrentPhase('paused');
        ensureOwnership(attempt);
        saveDraft(attempt, typedRef.current, ownerToken.current);
        if (attempt.id && !attempt.offline && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon(`/api/tests/${attempt.id}/pause`, new Blob(['{}'], { type: 'application/json' }));
        }
      }
      releaseLease(attempt, ownerToken.current);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      const attempt = attemptRef.current;
      if (!event.persisted || !attempt || phaseRef.current !== 'paused') return;
      ensureOwnership(attempt); persist(attempt);
      if (!attempt.id || attempt.offline) return;
      setCurrentPhase('restoring');
      void api(`/api/tests/${attempt.id}/pause`, { method: 'POST', body: {} }).catch(() => {
        attempt.offline = true; setFeedback('已恢复本地进度；在线计时已中断，本次成绩仅保存到本机。');
      }).finally(() => { if (mounted.current) { persist(attempt); setCurrentPhase('paused'); } });
    };
    const initial = attemptRef.current;
    if (initial && phaseRef.current === 'paused') persist(initial);
    const heartbeat = setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || !['running', 'paused', 'restoring', 'pausing', 'resuming'].includes(phaseRef.current)) return;
      const saved = storedDraft(attempt.recordId);
      if (saved && !leaseTaken(saved, ownerToken.current)) {
        try { localStorage.setItem(draftPrefix + attempt.recordId, JSON.stringify({ ...saved, leaseOwner: ownerToken.current, leaseAt: Date.now() })); } catch { /* Progress remains usable in memory. */ }
      }
    }, 5000);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => { mounted.current = false; window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow); clearInterval(heartbeat); clearTimer(); if (attemptRef.current) releaseLease(attemptRef.current, ownerToken.current); };
  }, []);

  const finish = useCallback(async (early = false) => {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    const used = elapsedTime(attempt);
    attempt.elapsedMs = used; attempt.startedAt = null;
    clearTimer(); setCurrentPhase('finishing'); setElapsedMs(used);
    const value = typedRef.current;
    ensureOwnership(attempt);
    saveDraft(attempt, value, ownerToken.current, true, early);
    let final = localResult(attempt, used, value);
    if (attempt.id && !attempt.offline) {
      try {
        const saved = await api<ServerResult>(`/api/tests/${attempt.id}/finish`, { method: 'POST', body: { typed: value, suspicious: attempt.suspicious, backspaces: attempt.backspaces, elapsedMs: Math.round(used), early } });
        final = withServerResult(final, saved);
      } catch { final.offline = true; }
    }
    if (!mounted.current) return;
    recordResult(attempt, final);
    clearDraft(attempt, ownerToken.current); setResult(final); setCurrentPhase('finished');
  }, []);

  const beginClock = useCallback(() => {
    clearTimer();
    timerRef.current = setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || phaseRef.current !== 'running') return;
      const used = elapsedTime(attempt);
      setElapsedMs(used);
      if (used >= attempt.duration * 1000) { void finish(false); return; }
      if (attempt.id && !attempt.offline && used >= attempt.nextCheckpointMs) {
        attempt.nextCheckpointMs = used + 5000;
        void api(`/api/tests/${attempt.id}/checkpoint`, { method: 'POST', body: { typed: typedRef.current, elapsedMs: Math.round(used) } }).catch(() => {});
      }
      if (Math.floor(used / 1000) !== Math.floor(Math.max(0, used - 100) / 1000)) persist(attempt);
    }, 100);
  }, [finish, persist]);

  async function start() {
    if (phaseRef.current !== 'ready' || config.duration < 60 || config.duration > 3600 || config.duration % 60 || !config.text) return;
    setCurrentPhase('starting'); setFeedback(''); setResult(null); setRestored(false); setRaw(''); setTyped(''); typedRef.current = ''; composing.current = false; setBackspaces(0); setElapsedMs(0);
    let testTarget = config.text;
    let id: string | undefined;
    let offline = config.custom;
    if (!config.custom) {
      try {
        const challenge = await api<{ id: string; target: string }>('/api/tests/start', { method: 'POST', body: { articleId: config.articleId, duration: config.duration } });
        if (typeof challenge.id !== 'string' || typeof challenge.target !== 'string' || !challenge.target) throw new Error('练习数据无效');
        id = challenge.id; testTarget = challenge.target;
      } catch { offline = true; setFeedback('当前为本地练习，联网后可参加排行榜。'); }
    } else setFeedback('自定义文字使用本地练习，成绩保存在当前浏览器。');
    const attempt: Attempt = { ...config, text: testTarget, id, recordId: id || uniqueId(), revision: 0, target: testTarget, offline, elapsedMs: 0, startedAt: performance.now(), suspicious: false, backspaces: 0, nextCheckpointMs: 5000 };
    attemptRef.current = attempt; setTarget(testTarget); setCurrentPhase('running'); persist(attempt); beginClock();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function pause() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    const used = elapsedTime(attempt);
    if (used >= attempt.duration * 1000) { void finish(false); return; }
    composing.current = false; setRaw(typedRef.current);
    attempt.elapsedMs = used; attempt.startedAt = null; setElapsedMs(used); clearTimer(); setCurrentPhase('pausing'); persist(attempt);
    if (attempt.id && !attempt.offline) {
      try { await api(`/api/tests/${attempt.id}/pause`, { method: 'POST', body: {} }); }
      catch { attempt.offline = true; setFeedback('网络已中断，进度仍保存在本机，本次成绩不会上榜。'); }
    }
    persist(attempt); setCurrentPhase('paused');
  }

  async function resume() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'paused') return;
    ensureOwnership(attempt);
    setCurrentPhase('resuming');
    if (attempt.id && !attempt.offline) {
      try {
        const state = await api<{ remainingMs: number }>(`/api/tests/${attempt.id}/resume`, { method: 'POST', body: {} });
        if (!Number.isFinite(state.remainingMs)) throw new Error('在线计时不可用');
      } catch { attempt.offline = true; setFeedback('网络已中断，继续本地练习；本次成绩不会上榜。'); }
    }
    attempt.startedAt = performance.now(); attempt.nextCheckpointMs = attempt.elapsedMs + 5000;
    setCurrentPhase('running'); setRestored(false); persist(attempt); beginClock();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function reset(nextTarget = config.text) {
    clearTimer(); clearDraft(attemptRef.current, ownerToken.current); attemptRef.current = null; typedRef.current = ''; composing.current = false;
    setRaw(''); setTyped(''); setTarget(nextTarget); setElapsedMs(0); setBackspaces(0); setResult(null); setFeedback(''); setRestored(false); setCurrentPhase('ready');
  }

  function recordBackspace() {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    if (elapsedTime(attempt) >= attempt.duration * 1000) { void finish(false); return; }
    attempt.backspaces++; setBackspaces(attempt.backspaces); persist(attempt);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Backspace' && phaseRef.current === 'running' && !composing.current && !event.nativeEvent.isComposing) { lastBackspaceKey.current = performance.now(); recordBackspace(); }
  }
  function commit(value: string) {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    if (elapsedTime(attempt) >= attempt.duration * 1000) { void finish(false); return; }
    const characters = splitCharacters(value);
    const limit = splitCharacters(attempt.target).length;
    const safe = characters.length > limit ? characters.slice(0, limit).join('') : value;
    typedRef.current = safe; setTyped(safe); setRaw(safe); persist(attempt);
    if (characters.length >= limit) void finish(true);
  }
  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    if (phaseRef.current !== 'running') return;
    const input = event.nativeEvent as InputEvent;
    if (attemptRef.current && elapsedTime(attemptRef.current) >= attemptRef.current.duration * 1000) { void finish(false); return; }
    if (input.inputType === 'deleteContentBackward' && !composing.current && !input.isComposing && performance.now() - lastBackspaceKey.current > 250) recordBackspace();
    const value = event.target.value;
    if (composing.current || input.isComposing) setRaw(value);
    else commit(value);
  }
  function onCompositionStart() { if (phaseRef.current === 'running') composing.current = true; }
  function onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
    const wasComposing = composing.current;
    composing.current = false;
    if (!wasComposing) { setRaw(typedRef.current); return; }
    if (phaseRef.current === 'running') commit(event.currentTarget.value);
  }
  function markSuspicious() { if (attemptRef.current) { attemptRef.current.suspicious = true; persist(attemptRef.current); } }

  return { phase, target, raw, typed, elapsedMs, backspaces, feedback, result, restored, textareaRef, start, pause, resume, reset, onChange, onKeyDown, onCompositionStart, onCompositionEnd, markSuspicious };
}
