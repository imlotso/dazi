import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { ArrowRight } from '@phosphor-icons/react/ArrowRight';
import { BookOpen } from '@phosphor-icons/react/BookOpen';
import { CaretDown } from '@phosphor-icons/react/CaretDown';
import { CheckCircle } from '@phosphor-icons/react/CheckCircle';
import { Clock } from '@phosphor-icons/react/Clock';
import { Cloud } from '@phosphor-icons/react/Cloud';
import { Crosshair } from '@phosphor-icons/react/Crosshair';
import { Keyboard } from '@phosphor-icons/react/Keyboard';
import { MoonStars } from '@phosphor-icons/react/MoonStars';
import { Pause } from '@phosphor-icons/react/Pause';
import { Play } from '@phosphor-icons/react/Play';
import { SignOut } from '@phosphor-icons/react/SignOut';
import { Sun } from '@phosphor-icons/react/Sun';
import { Trophy } from '@phosphor-icons/react/Trophy';
import { UserCircle } from '@phosphor-icons/react/UserCircle';
import { AdminWorkspace } from './components/AdminWorkspace';
import { ArticleLibrary } from './components/ArticleLibrary';
import { BackgroundDialog } from './components/BackgroundDialog';
import { RoomBackground } from './components/RoomBackground';
import { AuthDialog } from './components/AuthDialog';
import { Dialog } from './components/Dialog';
import { DraftsView } from './components/DraftsView';
import { MistakesView } from './components/MistakesView';
import { PracticeLines } from './components/PracticeLines';
import { RankingView } from './components/RankingView';
import { RecordsView } from './components/RecordsView';
import { SettingsDialog } from './components/SettingsDialog';
import { StatsView } from './components/StatsView';
import { articles, type Difficulty, type Language } from './data/articles';
import { continuationDraftId, discardSavedDraft, localHistory, practiceDraftId, readDraft, readDrafts, savedPracticeFromLegacy, usePractice, type PracticeDraft } from './hooks/usePractice';
import { useWorkspace } from './hooks/useWorkspace';
import { api, type User } from './lib/api';
import { catalogSnapshotKey, type ArticleSnapshot, type PracticeRecord, type ReaderSettings, type SavedPractice } from './lib/models';
import { readableCharacter } from './lib/practice-lines';
import { scoreTyping, splitCharacters } from './lib/scoring';
import { resolveTheme, themeStorageKey, type Theme } from './lib/theme';
import { deleteWorkspaceValue, DraftDeletedError, isWorkspaceDraftDeleted, putWorkspaceValue } from './lib/workspace';

type View = 'practice' | 'library' | 'rankings' | 'history' | 'drafts' | 'mistakes' | 'stats';
type PendingLoad = { legacy: PracticeDraft } | { draft: SavedPractice; newRound?: boolean };
const difficultyNames: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };
const languageNames: Record<Language, string> = { zh: '中文', en: 'English' };
const builtIns: ArticleSnapshot[] = articles.map(({ content, ...article }) => ({ ...article, text: content, custom: false }));
const builtInById = new Map(builtIns.map((article) => [article.id, article]));
const recordViews: View[] = ['history', 'mistakes', 'stats'];

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function initialTheme(): Theme {
  let saved: string | null = null;
  try { saved = localStorage.getItem(themeStorageKey); } catch { /* The system preference is still available. */ }
  return resolveTheme(saved, typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

function legacyArticle(draft: PracticeDraft): ArticleSnapshot {
  const builtIn = builtInById.get(draft.articleId);
  if (draft.article) return { ...draft.article, text: draft.target };
  if (builtIn?.text === draft.target && builtIn.title === draft.title) return builtIn;
  return { id: draft.articleId, title: draft.title, text: draft.target, language: draft.language, difficulty: draft.difficulty, custom: draft.custom };
}

function mergeRecords(local: PracticeRecord[], remote: PracticeRecord[], workspace: PracticeRecord[]) {
  const recordKey = (record: PracticeRecord) => record.recordId || `${record.finishedAt}:${record.language}:${record.difficulty}:${record.speed}:${record.accuracy}`;
  const statuses = new Map(remote.flatMap((record) => record.status ? [[recordKey(record), record.status] as const] : []));
  const entries = new Map<string, PracticeRecord>();
  for (const record of [...local, ...remote, ...workspace]) {
    const key = recordKey(record);
    const previous = entries.get(key);
    if (!previous) { entries.set(key, record); continue; }
    const rich = [record, previous].find((entry) => entry.article && entry.typed != null);
    const mistakes = [record, previous].find((entry) => entry.mistakes?.length)?.mistakes;
    entries.set(key, { ...previous, ...record, ...rich && { article: rich.article, typed: rich.typed, offset: rich.offset, articleTotal: rich.articleTotal }, ...mistakes && { mistakes } });
  }
  return [...entries].map(([key, record]) => {
    const status = statuses.get(key);
    return status ? { ...record, status } : record;
  }).sort((a, b) => b.finishedAt - a.finishedAt);
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [previewOwner, setPreviewOwner] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const changeUser = useCallback((next: User | null) => {
    request.current?.abort();
    setPreviewOwner(undefined);
    window.history.replaceState(null, '', next?.isAdmin ? '/admin' : '/');
    setUser(next);
    setAuthReady(true);
  }, []);

  useEffect(() => {
    function checkAccount() {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      api<{ user: User | null }>('/api/me', { timeoutMs: 3000, signal: controller.signal }).then(({ user: current }) => {
        if (!controller.signal.aborted) setUser(current ?? null);
      }).catch(() => {}).finally(() => {
        if (!controller.signal.aborted) setAuthReady(true);
      });
    }
    checkAccount();
    window.addEventListener('focus', checkAccount);
    return () => {
      request.current?.abort();
      window.removeEventListener('focus', checkAccount);
    };
  }, []);

  const inAdministration = !!user?.isAdmin && previewOwner !== user.id;
  useEffect(() => {
    if (!authReady || !user) return;
    const target = inAdministration ? '/admin' : '/';
    if (window.location.pathname !== target) window.history.replaceState(null, '', target);
  }, [authReady, user?.id, user?.isAdmin, inAdministration]);
  useEffect(() => {
    if (!user?.isAdmin || previewOwner !== user.id) setPreviewOwner(undefined);
  }, [user?.id, user?.isAdmin, previewOwner]);

  if (!authReady && /^\/admin\/?$/.test(window.location.pathname)) return <div className="administration-session" role="status"><Cloud size={32} aria-hidden="true" />正在读取账号…</div>;
  if (inAdministration && user) return <AdminWorkspace key={user.id} user={user} onLogout={() => changeUser(null)} onPreview={() => setPreviewOwner(user.id)} />;
  return <PracticeApp key={user ? `account:${user.id}` : 'guest'} user={user} authReady={authReady} onUser={changeUser}
    onAdministration={user?.isAdmin ? () => setPreviewOwner(undefined) : undefined} />;
}

function PracticeApp({ user, authReady, onUser, onAdministration }: { user: User | null; authReady: boolean; onUser: (user: User | null) => void; onAdministration?: () => void }) {
  const ownerId = user?.id ?? null;
  const workspace = useWorkspace(ownerId, authReady);
  const [selection, setSelection] = useState(builtIns[0]);
  const [publicArticles, setPublicArticles] = useState(builtIns);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const refreshCatalog = useCallback(() => setCatalogRevision((revision) => revision + 1), []);
  const [guestTheme, setGuestTheme] = useState(initialTheme);
  const [directAdmin] = useState(() => /^\/admin\/?$/.test(window.location.pathname));
  const [view, setView] = useState<View>('practice');
  const [adminLoginDismissed, setAdminLoginDismissed] = useState(false);
  const [minutesText, setMinutesText] = useState<string>();
  const [pendingTheme, setPendingTheme] = useState<Theme>();
  const [customDraft, setCustomDraft] = useState('');
  const [customError, setCustomError] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBackground, setShowBackground] = useState<Theme>();
  const [showMore, setShowMore] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [confirmPractice, setConfirmPractice] = useState<{ action: 'restart' | 'finish'; resumeOnCancel: boolean } | null>(null);
  const [nickname, setNickname] = useState('');
  const [rankMessage, setRankMessage] = useState('');
  const [rankSubmitted, setRankSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pendingLoad, setPendingLoad] = useState<PendingLoad>();
  const [remoteHistory, setRemoteHistory] = useState<PracticeRecord[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const bootstrapped = useRef(false);
  const interacted = useRef(false);
  const navigation = useRef(false);
  const moreMenu = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const focusButton = useRef<HTMLButtonElement>(null);
  const focusRoot = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const { language, difficulty, title: displayTitle, text } = selection;
  const publicById = useMemo(() => new Map(publicArticles.map((article) => [article.id, catalogSnapshotKey(article)])), [publicArticles]);
  const selectedCatalogKey = useMemo(() => catalogSnapshotKey(selection), [selection]);
  const catalog = useMemo(() => [...publicArticles, ...workspace.privateArticles], [publicArticles, workspace.privateArticles]);
  const availableArticles = useMemo(() => catalog.filter((article) => article.language === language && article.difficulty === difficulty), [catalog, difficulty, language]);
  const configuredMinutes = minutesText ?? String(workspace.settings.minutes);
  const minutes = Number(configuredMinutes);
  const validDuration = /^\d+$/.test(configuredMinutes) && minutes >= 1 && minutes <= 60;
  const duration = validDuration ? minutes * 60 : workspace.settings.minutes * 60;
  const theme = user ? pendingTheme ?? workspace.settings.theme : guestTheme;
  const ready = authReady && workspace.ready;
  const adminLogin = directAdmin && authReady && !user && !adminLoginDismissed;
  const reportSaveError = useCallback(() => { if (live.current) setFeedback('无法保存进度'); }, []);

  const practice = usePractice({
    article: selection, articleId: selection.id, title: displayTitle, text, language, difficulty, duration,
    custom: selection.custom || publicById.get(selection.id) !== selectedCatalogKey,
    guardCatalog: true, onCatalogStale: refreshCatalog, ownerId,
    mode: workspace.settings.mode, strict: workspace.settings.strict, autoPause: workspace.settings.autoPause,
    onRecord(record) {
      if (record.recordId) void putWorkspaceValue(record.ownerId ?? null, 'record', record.recordId, record).catch(reportSaveError);
    },
    onDraft(draft) {
      return putWorkspaceValue(draft.ownerId, 'draft', draft.id, draft).catch((error: unknown) => {
        if (error instanceof DraftDeletedError) throw error;
        reportSaveError();
      });
    },
    isDraftDeleted: (id, owner) => isWorkspaceDraftDeleted(owner, id),
    onRemoveDraft(id, owner) {
      void deleteWorkspaceValue(owner, 'draft', id).catch(reportSaveError);
    },
  }, null);
  const { phase, target, typed, result } = practice;
  const locked = !['ready', 'finished'].includes(phase);
  const currentMode = phase === 'ready' ? workspace.settings.mode : practice.mode;
  const currentDuration = phase === 'ready' ? duration : practice.duration;
  const currentStrict = phase === 'ready' ? workspace.settings.strict : practice.strict;
  const canStart = ready && !pendingLoad && !accountBusy && !locked && (validDuration || currentMode === 'article');
  const typedCharacters = useMemo(() => splitCharacters(typed), [typed]);
  const targetCharacters = useMemo(() => splitCharacters(target), [target]);
  const roundTyped = useMemo(() => typedCharacters.slice(practice.offset).join(''), [typedCharacters, practice.offset]);
  const roundTarget = useMemo(() => targetCharacters.slice(practice.offset, typedCharacters.length).join(''), [targetCharacters, typedCharacters.length, practice.offset]);
  const previewScore = useMemo(() => scoreTyping(roundTarget, roundTyped, Math.max(practice.elapsedMs / 1000, 0.1)), [roundTarget, roundTyped, practice.elapsedMs]);
  const clockMs = currentMode === 'article' ? practice.elapsedMs : Math.max(0, currentDuration * 1000 - practice.elapsedMs);
  const practiceNotice = feedback || practice.feedback || (!locked && currentMode === 'timed' && !validDuration ? '时长须为 1–60 分钟的整数。' : '');
  const mistakes = useMemo(() => typedCharacters.flatMap((character, index) => index >= practice.offset && character !== targetCharacters[index] ? [{ index, expected: targetCharacters[index], actual: character }] : []), [typedCharacters, targetCharacters, practice.offset]);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ articles: ArticleSnapshot[] }>('/api/articles', { signal: controller.signal }).then(({ articles: published }) => {
      if (controller.signal.aborted || !Array.isArray(published) || !published.length) return;
      setPublicArticles(published);
      if (!interacted.current) setSelection((current) => current === builtIns[0] ? published[0] : current);
    }).catch(() => { /* Bundled articles are available on static and offline deployments. */ });
    return () => controller.abort();
  }, [catalogRevision]);

  useEffect(() => {
    if (!ready || bootstrapped.current || (ownerId && !workspace.cloudLoaded)) return;
    bootstrapped.current = true;
    const deleted = new Set(workspace.deletedDraftIds);
    const preferred = readDraft(ownerId);
    const recoverable = (draft: PracticeDraft) => draft.completed || !deleted.has(practiceDraftId(draft.recordId));
    const legacy = preferred && recoverable(preferred) ? preferred : readDrafts(ownerId).find(recoverable);
    if (!interacted.current && phase === 'ready' && legacy) {
      setSelection(legacyArticle(legacy));
      setPendingLoad({ legacy });
    }
  }, [ready, ownerId, phase, workspace.cloudLoaded, workspace.deletedDraftIds]);

  const loadCurrent = useRef(practice);
  loadCurrent.current = practice;
  useEffect(() => {
    if (!pendingLoad) return;
    setPendingLoad(undefined);
    if ('legacy' in pendingLoad) void loadCurrent.current.loadLegacy(pendingLoad.legacy);
    else void loadCurrent.current.loadSaved(pendingLoad.draft, { newRound: pendingLoad.newRound });
  }, [pendingLoad]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (pendingTheme === workspace.settings.theme) setPendingTheme(undefined);
  }, [pendingTheme, workspace.settings.theme]);

  useEffect(() => {
    if (minutesText !== undefined && validDuration && minutes === workspace.settings.minutes) setMinutesText(undefined);
  }, [minutes, minutesText, validDuration, workspace.settings.minutes]);

  useEffect(() => {
    if (result) { setRankMessage(''); setRankSubmitted(false); setShowResult(true); }
  }, [result]);

  useEffect(() => {
    if (!ownerId || !recordViews.includes(view)) return;
    const controller = new AbortController();
    setHistoryError(false);
    api<{ entries: PracticeRecord[] }>('/api/history', { signal: controller.signal, headers: { 'X-Workspace-Owner': ownerId } }).then(({ entries }) => {
      if (!controller.signal.aborted && Array.isArray(entries)) setRemoteHistory(entries);
    }).catch(() => {
      if (!controller.signal.aborted) { setRemoteHistory([]); setHistoryError(true); }
    });
    return () => controller.abort();
  }, [view, ownerId, result]);

  const records = useMemo(() => {
    if (!authReady) return [];
    const local = localHistory().filter((record) => (record.ownerId ?? null) === ownerId);
    return mergeRecords(local, remoteHistory, workspace.records);
  }, [authReady, ownerId, remoteHistory, workspace.records, result, view]);

  const draftBox = useMemo(() => {
    if (!ready || view !== 'drafts') return { drafts: [], completed: [] };
    const drafts = new Map(workspace.drafts.map((draft) => [draft.recordId, draft]));
    const deleted = new Set(workspace.deletedDraftIds);
    const completed: PracticeDraft[] = [];
    for (const draft of readDrafts(ownerId)) {
      if (draft.completed) {
        drafts.delete(draft.recordId);
        completed.push(draft);
      } else if (!drafts.has(draft.recordId) && !deleted.has(practiceDraftId(draft.recordId))) {
        drafts.set(draft.recordId, savedPracticeFromLegacy(draft));
      }
    }
    return { drafts: [...drafts.values()], completed };
  }, [ready, view, ownerId, workspace.drafts, workspace.deletedDraftIds]);

  useEffect(() => {
    if (!showMore) return;
    const closeOutside = (event: PointerEvent) => {
      if (!moreMenu.current?.contains(event.target as Node)) setShowMore(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setShowMore(false); moreButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [showMore]);

  useEffect(() => {
    if (!focused) return;
    focusButton.current?.focus();
    let wasFullscreen = document.fullscreenElement === focusRoot.current;
    const fullscreenChange = () => {
      if (document.fullscreenElement === focusRoot.current) wasFullscreen = true;
      else if (wasFullscreen) setFocused(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !showResult && !confirmPractice && !showSettings && !showBackground) exitFocus();
    };
    document.addEventListener('fullscreenchange', fullscreenChange);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('fullscreenchange', fullscreenChange);
      document.removeEventListener('keydown', escape);
    };
  }, [focused, showResult, confirmPractice, showSettings, showBackground]);

  function exitFocus() {
    setFocused(false);
    if (document.fullscreenElement === focusRoot.current) void document.exitFullscreen?.().catch(() => {});
  }

  function enterFocus() {
    setShowSettings(false);
    setView('practice');
    setFocused(true);
    try { void focusRoot.current?.requestFullscreen?.().catch(() => {}); } catch { /* Embedded preview still uses focus layout. */ }
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    if (user) {
      setPendingTheme(next);
      void workspace.updateSettings({ theme: next }).catch(() => {
        setPendingTheme((pending) => pending === next ? undefined : pending);
        reportSaveError();
      });
      return;
    }
    setGuestTheme(next);
    try { localStorage.setItem(themeStorageKey, next); } catch { /* The current view still changes. */ }
  }

  function updateSettings(patch: Partial<ReaderSettings>) {
    if (patch.minutes !== undefined) setMinutesText(String(patch.minutes));
    if (phase === 'finished' && (patch.mode !== undefined || patch.strict !== undefined || patch.minutes !== undefined)) {
      resetPractice(selection, true);
    }
    void workspace.updateSettings(patch).catch(reportSaveError);
  }

  function resetPractice(article = selection, keepDraft = false) {
    interacted.current = true;
    setSelection(article);
    practice.reset(article.text, { keepDraft });
    setShowResult(false);
    setRankMessage('');
    setRankSubmitted(false);
    setFeedback('');
  }

  async function afterPark(action: () => void | Promise<void>) {
    if (navigation.current) return;
    navigation.current = true;
    interacted.current = true;
    try {
      if (locked && !await practice.park()) {
        if (phase === 'starting' || phase === 'finishing') setFeedback('练习保存中…');
        return;
      }
      const pending = live.current ? action() : undefined;
      if (pending) await pending;
    } finally {
      navigation.current = false;
    }
  }

  function navigate(next: View) {
    setShowMore(false);
    if (next === view) return;
    void afterPark(() => { setShowResult(false); setFeedback(''); setView(next); });
  }

  function openSettings() {
    setShowMore(false);
    void afterPark(() => setShowSettings(true));
  }

  function selectArticle(article: ArticleSnapshot) {
    void afterPark(() => {
      resetPractice(article, true);
      setView('practice');
    });
  }

  function continueDraft(draft: SavedPractice, newRound = false) {
    void afterPark(() => {
      setShowResult(false);
      setFeedback('');
      setSelection(draft.article);
      const legacy = !newRound && readDrafts(ownerId).find((item) => item.legacy && item.recordId === draft.recordId);
      setPendingLoad(legacy ? { legacy } : { draft, newRound });
      setView('practice');
    });
  }

  function continueRecord(record: PracticeRecord) {
    if (!record.article || record.typed == null) return;
    const article = record.article;
    const continuationId = record.recordId ? continuationDraftId(record.recordId) : undefined;
    const saved = workspace.drafts.find((draft) => draft.id === continuationId);
    const typed = splitCharacters(record.typed);
    const expected = splitCharacters(article.text);
    const wrong = record.strict ? typed.findIndex((character, index) => character !== expected[index]) : -1;
    const offset = wrong >= 0 ? wrong : typed.length;
    if (saved && (saved.offset >= offset || splitCharacters(saved.typed).length >= typed.length)) {
      continueDraft(saved);
      return;
    }
    const recordId = `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const draft: SavedPractice = {
      id: practiceDraftId(recordId), article, typed: record.typed, elapsedMs: 0, backspaces: 0, duration: record.duration,
      mode: record.mode ?? 'timed', strict: !!record.strict, offset, recordId,
      ownerId, savedAt: Date.now(), offline: true,
    };
    continueDraft(draft, true);
  }

  function deleteDraft(id: string) {
    const draft = draftBox.drafts.find((item) => item.id === id);
    if (!draft) return;
    void afterPark(() => {
      if (!discardSavedDraft(draft)) { setFeedback('草稿正在其他页面使用'); return; }
      if (practice.draftId === id) resetPractice(selection, true);
      void workspace.remove('draft', id).catch(reportSaveError);
    });
  }

  function nextArticle() {
    if (locked) return;
    const index = availableArticles.findIndex((article) => article.id === selection.id);
    resetPractice(availableArticles[(index + 1) % availableArticles.length] ?? publicArticles[0], true);
  }

  async function requestPracticeAction(action: 'restart' | 'finish') {
    const resumeOnCancel = phase === 'running';
    if (resumeOnCancel && !await practice.pause()) return;
    setConfirmPractice({ action, resumeOnCancel });
  }

  function cancelPracticeAction() {
    const resume = confirmPractice?.resumeOnCancel;
    setConfirmPractice(null);
    if (resume) void practice.resume();
  }

  function changeLanguage(next: Language) {
    if (locked || next === language) return;
    resetPractice(publicArticles.find((item) => item.language === next && item.difficulty === difficulty) ?? publicArticles[0], true);
  }

  function changeDifficulty(next: Difficulty) {
    if (locked || next === difficulty) return;
    resetPractice(publicArticles.find((item) => item.language === language && item.difficulty === next) ?? publicArticles[0], true);
  }

  function changeDuration(event: ChangeEvent<HTMLInputElement>) {
    if (locked) return;
    const value = event.target.value;
    setMinutesText(value);
    if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 60) {
      void workspace.updateSettings({ minutes: Number(value) }).catch(reportSaveError);
    }
    if (phase === 'finished') resetPractice(selection, true);
  }

  function changeArticle(event: ChangeEvent<HTMLSelectElement>) {
    const article = catalog.find((item) => item.id === event.target.value);
    if (article && !locked) resetPractice(article, true);
  }

  function useCustomText() {
    const value = customDraft.replace(/\r\n?/g, '\n').trim().normalize('NFC');
    if (!value || value.length > 20000) { setCustomError('请输入 1–20,000 个字符。'); return; }
    setCustomError('');
    setShowCustom(false);
    resetPractice({ id: 'custom', title: '自定义文字', text: value, language, difficulty, custom: true }, true);
  }

  async function submitRank() {
    if (!result?.attemptId) return;
    setBusy(true); setRankMessage('');
    try {
      const data = await api<{ status: string }>('/api/leaderboard', { method: 'POST', body: { attemptId: result.attemptId, nickname } });
      setRankMessage(data.status === 'review' ? '已提交，待复核。' : '已上榜。');
      setRankSubmitted(true);
    } catch (problem) { setRankMessage((problem as Error).message); setRankSubmitted(false); }
    finally { setBusy(false); }
  }

  const canChangeAccount = authReady && !pendingLoad && !accountBusy &&
    ['ready', 'running', 'paused', 'finished'].includes(phase);

  async function changeAccount() {
    if (!canChangeAccount) return;
    if (onAdministration) { await afterPark(onAdministration); return; }
    setAccountBusy(true);
    try {
      await afterPark(async () => {
        if (!user) { setShowAuth(true); return; }
        await api('/api/auth/logout', { method: 'POST', body: {}, headers: { 'X-Workspace-Owner': user.id } });
        if (live.current) onUser(null);
      });
    } catch (problem) {
      if (live.current) setFeedback((problem as Error).message);
    } finally {
      if (live.current) setAccountBusy(false);
    }
  }

  const matchingArticle = availableArticles.find((article) => article.id === selection.id);
  const snapshotOption = !matchingArticle || matchingArticle.title !== selection.title || matchingArticle.text !== selection.text;
  const selectedOption = snapshotOption ? 'current-snapshot' : selection.id;
  const source = selection.source && /^https?:\/\//iu.test(selection.source.url) ? selection.source : undefined;
  const filters = <>
    <div className="top-filters">
      <div className="segmented language-switch" role="group" aria-label="选择语言">
        {(['zh', 'en'] as const).map((item) => <button key={item} disabled={locked} aria-pressed={language === item} onClick={() => changeLanguage(item)}>{languageNames[item]}</button>)}
      </div>
      <span className="filter-divider" aria-hidden="true" />
      {currentMode === 'timed' ? <label className="duration-input"><Clock size={21} /><span>测试时间</span><input type="number" min="1" max="60" step="1" aria-label="测试时间（分钟）" aria-invalid={!locked && !validDuration} value={phase === 'ready' ? configuredMinutes : String(currentDuration / 60)} disabled={locked || (!!user && !workspace.settingsReady)} onChange={changeDuration} /><span>分钟</span></label> : <span className="count-chip">整篇</span>}
      {currentStrict && <span className="count-chip">严格纠错</span>}
    </div>
    <div className="detail-filters">
      <div className="article-choice"><label className="article-picker"><BookOpen size={24} /><span>选择文章</span><span className="select-wrap"><select value={selectedOption} disabled={locked} onChange={changeArticle} aria-label="选择练习文章">{snapshotOption && <option value="current-snapshot">{selection.title}</option>}{availableArticles.map((article) => <option key={article.id} value={article.id}>{article.title}{article.author ? ` · ${article.author}` : ''}</option>)}</select><CaretDown aria-hidden="true" size={17} /></span></label><button className="text-button custom-button" disabled={locked} onClick={() => { setCustomDraft(selection.id === 'custom' ? text : ''); setCustomError(''); setShowCustom(true); }}>自定义文字</button></div>
      <div className="difficulty-picker"><span>难度：</span><div className="segmented difficulty-switch" role="group" aria-label="选择难度">{(['beginner', 'intermediate', 'advanced'] as const).map((item) => <button key={item} disabled={locked} aria-pressed={difficulty === item} onClick={() => changeDifficulty(item)}>{difficultyNames[item]}</button>)}</div></div>
    </div>
  </>;

  const actionNames = { library: '文章库', practice: '练习', rankings: '排行榜', history: '我的记录' } as const;
  const secondaryNames = { drafts: '草稿箱', mistakes: '错字本', stats: '统计' } as const;

  return <div className={`app-shell${focused ? ' app-focused' : ''}`} ref={focusRoot}>
    {!focused && <header className="site-header">
      <button className="brand" onClick={() => navigate('practice')} aria-label="云打字练习首页"><Cloud size={40} weight="regular" /><span>云打字练习</span></button>
      <nav aria-label="主要导航">
        {(['practice', 'library', 'rankings', 'history'] as const).map((item) => <button key={item} className={view === item ? 'nav-active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => navigate(item)}>{actionNames[item]}</button>)}
        <div className="more-nav" ref={moreMenu}>
          <button ref={moreButton} className={view === 'drafts' || view === 'mistakes' || view === 'stats' ? 'nav-active' : ''} aria-expanded={showMore} aria-controls={showMore ? 'practice-more' : undefined} onClick={() => setShowMore((value) => !value)}>更多 <CaretDown size={12} aria-hidden="true" /></button>
          {showMore && <div className="more-popover" id="practice-more">
            {(Object.keys(secondaryNames) as Array<keyof typeof secondaryNames>).map((item) => <button key={item} aria-current={view === item ? 'page' : undefined} onClick={() => { moreButton.current?.focus(); navigate(item); }}>{secondaryNames[item]}</button>)}
            <button disabled={!!user && !workspace.settingsReady} onClick={() => { moreButton.current?.focus(); openSettings(); }}>设置</button>
          </div>}
        </div>
        <button className="theme-button" disabled={!!user && !workspace.settingsReady} aria-label={theme === 'dark' ? '切换至日间模式' : '切换至夜间模式'} aria-pressed={theme === 'dark'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={20} /> : <MoonStars size={20} />}<span>{theme === 'dark' ? '日间' : '夜间'}</span></button>
        {user ? <button className="account-button" disabled={!canChangeAccount} onClick={() => void changeAccount()} title={onAdministration ? '返回管理界面' : '退出登录'} aria-label={onAdministration ? `${user.username}，返回管理界面` : undefined}><UserCircle size={21} /> {onAdministration ? '返回管理' : user.username} {onAdministration ? <ArrowRight size={16} /> : <SignOut size={16} />}</button> : <button className="account-button" disabled={!canChangeAccount} onClick={() => void changeAccount()}>登录</button>}
      </nav>
    </header>}
    <RoomBackground theme={theme} background={workspace.backgrounds[theme]}>
      <div className="workspace">
        {view === 'practice' && <>
          {focused ? <div className="focus-actions"><button ref={focusButton} className="outline-button feature-action-button" onClick={exitFocus}>退出专注</button></div> : filters}
          <div className="status-row"><span><Clock size={23} /> {currentMode === 'article' ? '用时' : '剩余时间'}：<b data-testid="remaining-time">{formatTime(clockMs)}</b></span><span><Crosshair size={23} /> 准确率：{roundTyped ? `${previewScore.accuracy}%` : '—'}</span><span><Keyboard size={23} /> {language === 'zh' ? '字 / 分钟' : 'WPM'}：{roundTyped ? (language === 'zh' ? previewScore.cpm : previewScore.wpm) : '—'}</span></div>
          <div className="progress-row"><span>文章字数：<b data-testid="article-count">{targetCharacters.length}</b></span><span>已打字数：<b data-testid="typed-count">{typedCharacters.length}</b></span><span>当前错误：<b data-testid="error-count">{previewScore.total - previewScore.correct}</b></span><span>退格：<b data-testid="backspace-count">{practice.backspaces}</b></span></div>
          <section className="typing-panel" aria-label="文章练习">
            <div className="practice-heading">
              <div className="practice-title"><BookOpen size={22} aria-hidden="true" /><div>
                <h1>{displayTitle}</h1>
                {target === text && (selection.author || selection.theme || source) && <p className="article-meta">
                  {selection.author && <span>{selection.author}</span>}
                  {selection.theme && <span>{selection.theme}</span>}
                  {source && <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.name} aria-label={`查看《${displayTitle}》原文`}>查看原文</a>}
                </p>}
              </div></div>
              <div className="practice-actions">
                {phase === 'running' ? <button className="primary-button start-button" onClick={() => void practice.pause()}><Pause size={18} weight="fill" aria-hidden="true" /> 暂停练习</button>
                  : phase === 'paused' ? <button className="primary-button start-button" disabled={!ready || accountBusy} onClick={() => void practice.resume()}><Play size={18} weight="fill" aria-hidden="true" /> 继续练习</button>
                    : <button className="primary-button start-button" onClick={phase === 'finished' ? () => resetPractice(selection, true) : () => { interacted.current = true; void practice.start(); }} disabled={!canStart}>
                      {phase === 'starting' ? '准备中…' : phase === 'restoring' ? '恢复进度中…' : phase === 'pausing' ? '正在暂停…' : phase === 'resuming' ? '正在继续…' : phase === 'finishing' ? '正在结算…' : phase === 'finished' ? '再练一次' : <><Play size={18} weight="fill" aria-hidden="true" /> 开始练习</>}
                    </button>}
                {(phase === 'running' || phase === 'paused') && <><button className="text-button restart-button" onClick={() => void requestPracticeAction('restart')}><ArrowCounterClockwise size={18} aria-hidden="true" />重新开始</button><button className="text-button" onClick={() => void requestPracticeAction('finish')}>结束练习</button></>}
                {phase === 'ready' && !focused && <button className="text-button" onClick={nextArticle}>换一篇 <ArrowRight size={16} aria-hidden="true" /></button>}
                {phase === 'finished' && <button className="text-button" onClick={() => setShowResult(true)}>查看本次成绩</button>}
              </div>
            </div>
            <PracticeLines practice={practice} title={displayTitle} reader={workspace.settings} />
          </section>
          {practiceNotice && <p className="practice-notice" role="status">{practiceNotice}</p>}
        </>}
        {view !== 'practice' && feedback && <p className="form-error view-error" role="alert">{feedback}</p>}
        {historyError && recordViews.includes(view) && <p className="form-error view-error" role="status">连接失败，显示本机记录。</p>}
        {view === 'library' && <ArticleLibrary articles={catalog} favorites={workspace.favorites} onToggleFavorite={(id) => void workspace.toggleFavorite(id).catch(reportSaveError)} onSelect={selectArticle} onSave={(article) => workspace.put('article', article.id, article)} onDelete={(id) => workspace.remove('article', id)} />}
        {view === 'rankings' && <RankingView initial={{ language, difficulty, duration, mode: currentMode, strict: currentStrict }} articles={publicArticles} isAdmin={false} ownerId={ownerId} />}
        {view === 'history' && <RecordsView records={records} onReplay={selectArticle} onContinue={continueRecord} />}
        {view === 'drafts' && <DraftsView drafts={draftBox.drafts} onResume={(draft) => continueDraft(draft)} onDelete={deleteDraft}
          recovery={draftBox.completed.map((draft) => ({
            id: draft.recordId, title: draft.title, savedAt: draft.savedAt,
            recover: () => void afterPark(() => {
              setShowResult(false);
              setFeedback('');
              setSelection(legacyArticle(draft));
              setPendingLoad({ legacy: draft });
              setView('practice');
            }),
          }))}
        />}
        {view === 'mistakes' && <MistakesView records={records} onPractice={selectArticle} />}
        {view === 'stats' && <StatsView records={records} />}
      </div>
    </RoomBackground>
    {showCustom && <Dialog title="自定义练习文字" onClose={() => setShowCustom(false)}>
      <label className="custom-editor">练习文字<textarea aria-label="自定义文章内容" value={customDraft} maxLength={20000} onChange={(event) => setCustomDraft(event.target.value)} /></label>
      {customError && <p className="form-error" role="alert">{customError}</p>}
      <div className="result-actions"><span className="custom-count">{splitCharacters(customDraft).length} / 20000 字符</span><button className="primary-button" onClick={useCustomText}>使用这段文字</button></div>
    </Dialog>}
    {(showAuth || adminLogin) && <AuthDialog onClose={() => { setShowAuth(false); setAdminLoginDismissed(true); if (directAdmin) window.history.replaceState(null, '', '/'); }} onLogin={onUser} />}
    {showSettings && <SettingsDialog settings={{ ...workspace.settings, minutes: locked ? currentDuration / 60 : duration / 60, mode: locked ? currentMode : workspace.settings.mode, strict: locked ? currentStrict : workspace.settings.strict }} onChange={updateSettings} locked={locked} onClose={() => setShowSettings(false)} onFocus={enterFocus} focused={focused} syncState={workspace.syncState} onSync={() => void workspace.sync()} isSignedIn={!!user} hasBackground={!!workspace.backgrounds[theme]} onBackground={() => { setShowSettings(false); setShowBackground(theme); }} />}
    {showBackground && <BackgroundDialog theme={showBackground} value={workspace.backgrounds[showBackground]} onClose={() => setShowBackground(undefined)} onSave={(background) => background ? workspace.put('background', showBackground, background) : workspace.remove('background', showBackground)} />}
    {confirmPractice && <Dialog title={confirmPractice.action === 'restart' ? '重新开始本次练习？' : '结束本次练习？'} onClose={cancelPracticeAction}>
      {confirmPractice.action === 'restart' && <p className="dialog-intro">本次输入和计时将被清除。</p>}
      {phase === 'restoring' && <p className="dialog-intro" role="status">恢复中…</p>}
      <div className="result-actions">
        <button className="outline-button" disabled={phase !== 'paused'} onClick={cancelPracticeAction}>继续当前练习</button>
        <button className="primary-button" disabled={phase !== 'paused'} onClick={() => {
          const action = confirmPractice.action;
          setConfirmPractice(null);
          if (action === 'restart') resetPractice(catalog.find((article) => article.id === selection.id) ?? selection);
          else void practice.finish();
        }}>{confirmPractice.action === 'restart' ? '确认重新开始' : '结束并查看成绩'}</button>
      </div>
    </Dialog>}
    {showResult && result && <Dialog title="练习成绩" onClose={() => setShowResult(false)}>
      {result.offline && <p className="dialog-intro">{!result.custom && result.elapsedMs < 1000 ? (user ? '用时不足 1 秒，不参与排行' : '用时不足 1 秒，仅本机保存') : user ? '个人成绩' : '仅本机保存'}</p>}
      <div className="result-metrics">
        <div><strong>{result.language === 'zh' ? result.score.cpm : result.score.wpm}</strong><span>{result.language === 'zh' ? '字 / 分钟' : 'WPM'}</span></div>
        <div><strong>{result.score.accuracy}%</strong><span>准确率</span></div>
        <div><strong>{typedCharacters.length} / {result.articleTotal}</strong><span>已打 / 文章字数</span>{practice.offset > 0 && <small>本轮 {result.score.total} 字</small>}</div>
        <div><strong>{result.errors}</strong><span>错误字数</span></div>
        <div><strong>{result.backspaces}</strong><span>退格次数</span></div>
        <div><strong>{formatTime(result.elapsedMs)}</strong><span>有效用时</span></div>
      </div>
      {mistakes.length > 0 && <details className="mistake-review"><summary>错字回看 · {mistakes.length > 30 ? `前 30 / ${mistakes.length}` : mistakes.length} 处</summary><ul>{mistakes.slice(0, 30).map((mistake) => <li key={mistake.index}><span>第 {mistake.index + 1} 字</span><span>原文 <b>{readableCharacter(mistake.expected)}</b></span><span>输入 <del>{readableCharacter(mistake.actual)}</del></span></li>)}</ul></details>}
      {!result.offline && result.eligible && !rankSubmitted && <div className="rank-submit">
        {!user && <label>上榜昵称<input value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} /></label>}
        <button className="primary-button" disabled={busy || (!user && !nickname.trim())} onClick={() => void submitRank()}><Trophy size={20} /> {busy ? '提交中…' : '提交到排行榜'}</button>
      </div>}
      {rankMessage && <p className={rankSubmitted ? 'form-notice' : 'form-error'} role={rankSubmitted ? 'status' : 'alert'}>{rankSubmitted && <CheckCircle size={18} />} {rankMessage}</p>}
      <div className={`result-actions result-navigation${result.continuation ? ' with-continuation' : ''}`}>
        {result.continuation && <button className="primary-button" onClick={() => continueDraft(result.continuation!)}>继续本篇</button>}
        <button className="outline-button" onClick={() => resetPractice(selection, true)}>再练一次</button>
        {!focused && <button className="text-button" onClick={nextArticle}>下一篇 <ArrowRight size={16} aria-hidden="true" /></button>}
        {!focused && <button className="text-button" onClick={() => navigate('rankings')}>排行榜</button>}
      </div>
    </Dialog>}
  </div>;
}
