// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PracticeLines } from '../src/components/PracticeLines';
import { localHistory, readDraft, usePractice, type PracticeConfig } from '../src/hooks/usePractice';
import { snapshotKey, type ArticleSnapshot, type PracticeRecord, type SavedPractice } from '../src/lib/models';

const article: ArticleSnapshot = { id: 'private-a', title: '片段', text: '甲乙\n丙丁', language: 'zh', difficulty: 'beginner', custom: true };
const config: PracticeConfig = { ...article, article, articleId: article.id, duration: 60, ownerId: null };
let time: number;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the active row on a strict mismatch while allowing full IME candidates', async () => {
  const records: PracticeRecord[] = [];
  function Session() {
    const practice = usePractice({ ...config, strict: true, onRecord: (record) => records.push(record) }, null);
    return <><button onClick={() => void practice.start()}>开始</button><PracticeLines title={article.title} practice={practice} /></>;
  }
  render(<Session />);
  fireEvent.click(screen.getByRole('button', { name: '开始' }));
  const first = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '当前行输入' });
  fireEvent.compositionStart(first);
  fireEvent.change(first, { target: { value: '甲乙错丙' } });
  expect(first.value).toBe('甲乙错丙');
  expect(readDraft()?.typed).toBe('');
  fireEvent.compositionEnd(first, { data: '甲乙错丙' });
  expect(screen.getByRole('textbox', { name: '当前行输入' })).toBe(first);
  expect(first.value).toBe('甲乙错');
  expect(readDraft()?.typed).toBe('甲乙错');
  fireEvent.change(first, { target: { value: '甲乙错丁' } });
  time = 3000;
  fireEvent.change(first, { target: { value: '甲乙\n丙错' } });
  const last = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '当前行输入' });
  expect(last.value).toBe('丙错');
  expect(last.disabled).toBe(false);
  expect(records).toEqual([]);
  fireEvent.change(last, { target: { value: '丙丁' } });
  expect(records[0]).toMatchObject({
    total: 5, correct: 5, mode: 'timed', strict: true,
    mistakes: [{ position: 2, expected: '\n', actual: '错' }, { position: 4, expected: '丁', actual: '错' }],
  });
});

it('lets whole-article practice run past the timed duration and records active time only', async () => {
  const records: PracticeRecord[] = [];
  const { result } = renderHook(() => usePractice({ ...config, mode: 'article', onRecord: (record) => records.push(record) }, null));
  await act(() => result.current.start());
  time = 61_000;
  act(() => result.current.updateTyped('甲'));
  expect(result.current.phase).toBe('running');
  await act(() => result.current.pause());
  time = 361_000;
  await act(() => result.current.resume());
  time = 365_000;
  act(() => result.current.updateTyped(article.text));
  expect(result.current.phase).toBe('finished');
  expect(records[0]).toMatchObject({ mode: 'article', elapsedMs: 65_000, typed: article.text });
});

it('preserves an incomplete round and counts only newly typed characters in its continuation', async () => {
  const records: PracticeRecord[] = [];
  const drafts: SavedPractice[] = [];
  const removed: string[] = [];
  const { result } = renderHook(() => usePractice({
    ...config, onRecord: (record) => records.push(record), onDraft: (draft) => drafts.push(draft), onRemoveDraft: (id) => removed.push(id),
  }, null));
  await act(() => result.current.start());
  time = 5000;
  act(() => result.current.updateTyped('甲错'));
  await act(() => result.current.pause());
  await act(() => result.current.finish(true));
  expect(records[0]).toMatchObject({ typed: '甲错', offset: 0, total: 2, correct: 1 });
  const continuation = result.current.result?.continuation;
  expect(continuation).toMatchObject({ typed: '甲错', offset: 2, elapsedMs: 0, backspaces: 0, offline: true });
  expect(drafts.at(-1)).toEqual(continuation);
  expect(removed).toEqual([drafts[0].id]);
  expect(continuation!.recordId).not.toBe(records[0].recordId);
  await act(() => result.current.loadSaved(continuation!));
  expect(result.current.phase).toBe('paused');
  await act(() => result.current.resume());
  time = 8000;
  act(() => result.current.updateTyped('甲错\n丙丁'));
  expect(records).toHaveLength(2);
  expect(records[1]).toMatchObject({ typed: '甲错\n丙丁', offset: 2, total: 3, correct: 3, articleTotal: 5, accuracy: 100, speed: 60 });
  expect(removed).toEqual([drafts[0].id, continuation!.id]);
  expect(readDraft()).toBeNull();
});

it('saves the committed prefix when the document hides during composition', async () => {
  const drafts: SavedPractice[] = [];
  const { result } = renderHook(() => usePractice({ ...config, autoPause: true, onDraft: (draft) => drafts.push(draft) }, null));
  await act(() => result.current.start());
  time = 2000;
  act(() => result.current.updateTyped('甲'));
  act(() => result.current.onCompositionStart());
  act(() => result.current.onChange({ nativeEvent: { isComposing: true }, target: { value: '甲yi' } } as unknown as Parameters<typeof result.current.onChange>[0]));
  expect(result.current.raw).toBe('甲yi');
  expect(drafts).toHaveLength(1);
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  expect(result.current.phase).toBe('paused');
  expect(result.current.raw).toBe('甲');
  expect(drafts.at(-1)).toMatchObject({ typed: '甲', elapsedMs: 2000 });
  hidden.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  expect(result.current.phase).toBe('paused');
});

it('parks and restores a draft with its own article, mode and active time', async () => {
  const drafts: SavedPractice[] = [];
  const { result, rerender } = renderHook((settings: PracticeConfig) => usePractice(settings, null), { initialProps: { ...config, onDraft: (draft: SavedPractice) => drafts.push(draft) } });
  await act(() => result.current.start());
  time = 500;
  act(() => result.current.updateTyped('甲'));
  await act(async () => { expect(await result.current.park()).toBe(true); });
  const saved = drafts.at(-1)!;
  expect(saved).toMatchObject({ typed: '甲', elapsedMs: 500 });
  expect(readDraft()?.leaseOwner).toBeNull();
  const another = { ...article, id: 'private-b', text: '另一个片段' };
  const nextConfig = { ...config, ...another, articleId: another.id, article: another, mode: 'article' as const, strict: true, onDraft: (draft: SavedPractice) => drafts.push(draft) };
  rerender(nextConfig);
  act(() => result.current.reset(another.text, { keepDraft: true }));
  expect(readDraft()?.typed).toBe('甲');
  await act(() => result.current.loadSaved(saved));
  expect(result.current).toMatchObject({ target: article.text, mode: 'timed', strict: false, offset: 0, phase: 'paused', elapsedMs: 500 });
  await act(() => result.current.finish(true));
  expect(localHistory()[0]).toMatchObject({ article, elapsedMs: 500 });
});

it('does not log shifted characters as newly typed errors when a backspace edits the middle', async () => {
  const records: PracticeRecord[] = [];
  function Session() {
    const practice = usePractice({ ...config, onRecord: (record) => records.push(record) }, null);
    return <><button onClick={() => void practice.start()}>开始</button><PracticeLines title={article.title} practice={practice} /></>;
  }
  render(<Session />);
  fireEvent.click(screen.getByRole('button', { name: '开始' }));
  const first = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '当前行输入' });
  fireEvent.change(first, { target: { value: '甲乙' } });
  fireEvent.input(first, { target: { value: '乙' }, inputType: 'deleteContentBackward' });
  fireEvent.change(first, { target: { value: article.text } });
  expect(records[0]).toMatchObject({ mistakes: [], backspaces: 1 });
});

it('ignores an old online pause response after a different draft is loaded', async () => {
  let resolvePause!: (value: Response) => void;
  const reply = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
  const fetchAttempt = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/tests/start') return reply({ id: 'official', target: article.text });
    if (url.endsWith('/pause')) return new Promise<Response>((resolve) => { resolvePause = resolve; });
    throw new Error(`Unexpected request ${url}: ${init.method}`);
  });
  vi.stubGlobal('fetch', fetchAttempt);
  const drafts: SavedPractice[] = [];
  const { result } = renderHook(() => usePractice({ ...config, custom: false, onDraft: (draft) => drafts.push(draft) }, null));
  await act(() => result.current.start());
  time = 3000;
  act(() => result.current.updateTyped('甲'));
  let pause!: Promise<boolean>;
  act(() => { pause = result.current.pause(); });
  const next = { ...article, id: 'private-b', text: '另一篇文章' };
  await act(() => result.current.loadSaved({
    id: snapshotKey(next), article: next, ownerId: null, typed: '另一', duration: 60, mode: 'article', strict: false,
    offset: 0, backspaces: 0, elapsedMs: 1200, offline: true, recordId: 'next', savedAt: Date.now(),
  }));
  await act(async () => {
    resolvePause(reply({ remainingMs: 57000 }));
    expect(await pause).toBe(false);
  });
  expect(result.current).toMatchObject({ phase: 'paused', target: next.text, typed: '另一', elapsedMs: 0, offset: 2 });
  expect(drafts.at(-1)).toMatchObject({ typed: '另一', offset: 2 });
  expect(drafts.at(-1)?.recordId).not.toBe('next');
});

it('restores a completed legacy round after auth without duplicating its result', async () => {
  const records: PracticeRecord[] = [];
  const drafts: SavedPractice[] = [];
  const ownerId = 'user-a';
  const saved = { version: 1, ...config, ownerId, recordId: 'pending-finish', revision: 1, target: article.text,
    typed: '甲乙', elapsedMs: 60_000, backspaces: 1, suspicious: false, offline: true, completed: true };
  localStorage.setItem('cloudtyping.practice.v2.pending-finish', JSON.stringify(saved));
  expect(readDraft(null)).toBeNull();
  const pending = readDraft(ownerId)!;
  const { result } = renderHook(() => usePractice({ ...config, ownerId, onRecord: (record) => records.push(record), onDraft: (draft) => drafts.push(draft) }, null));
  await act(() => result.current.loadLegacy(pending));
  expect(result.current.phase).toBe('finished');
  expect(records[0]).toMatchObject({ recordId: 'pending-finish', ownerId, elapsedMs: 60_000, article, typed: '甲乙' });
  expect(drafts[0]).toMatchObject({ ownerId, offset: 2, elapsedMs: 0, typed: '甲乙' });
  await act(() => result.current.loadLegacy(pending));
  expect(records).toHaveLength(1);
  expect(drafts).toHaveLength(1);
  expect(readDraft(ownerId)?.recordId).toBe(drafts[0].recordId);
});

it('discards a saved round only when its legacy copy belongs to the same owner and is unleased', async () => {
  const { discardSavedDraft } = await import('../src/hooks/usePractice');
  const ownerId = 'user-a';
  const saved: SavedPractice = {
    id: snapshotKey(article), article, ownerId, typed: '甲', duration: 60, mode: 'timed', strict: false,
    offset: 0, backspaces: 0, elapsedMs: 500, offline: true, recordId: 'parked', savedAt: Date.now(),
  };
  const draft = { version: 1, ...config, ownerId, recordId: 'parked', revision: 1, target: article.text,
    typed: '甲', elapsedMs: 500, backspaces: 0, suspicious: false, offline: true };
  localStorage.setItem('cloudtyping.practice.v2.parked', JSON.stringify({ ...draft, leaseOwner: 'another-tab', leaseAt: Date.now() }));
  expect(discardSavedDraft(saved)).toBe(false);
  expect(readDraft(ownerId)?.typed).toBe('甲');
  localStorage.setItem('cloudtyping.practice.v2.parked', JSON.stringify(draft));
  expect(discardSavedDraft({ ...saved, ownerId: 'user-b' })).toBe(false);
  expect(readDraft(ownerId)?.typed).toBe('甲');
  expect(discardSavedDraft(saved)).toBe(true);
  expect(readDraft(ownerId)).toBeNull();
});

it('opens a continuation on the unfinished row with a blank input for new text', async () => {
  const saved: SavedPractice = {
    id: snapshotKey(article), article, ownerId: null, typed: '甲', duration: 60, mode: 'timed', strict: false,
    offset: 1, backspaces: 0, elapsedMs: 0, offline: true, recordId: 'continued', savedAt: Date.now(),
  };
  function Session() {
    const practice = usePractice(config, null);
    return <>
      <button onClick={() => void practice.loadSaved(saved)}>加载</button>
      <button onClick={() => void practice.resume()}>继续</button>
      <PracticeLines title={article.title} practice={practice} />
    </>;
  }
  render(<Session />);
  fireEvent.click(screen.getByRole('button', { name: '加载' }));
  const first = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '当前行输入' });
  expect(first.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  fireEvent.change(first, { target: { value: '乙\n' } });
  const next = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '当前行输入' });
  expect(next).not.toBe(first);
  expect(next.value).toBe('');
  expect(readDraft()?.typed).toBe('甲乙\n');
});

it('uses separate workspace drafts for independent rounds of the same article', async () => {
  const drafts = new Map<string, SavedPractice>();
  const settings = { ...config, onDraft: (draft: SavedPractice) => { drafts.set(draft.id, draft); }, onRemoveDraft: (id: string) => { drafts.delete(id); } };
  const first = renderHook(() => usePractice(settings, null));
  const second = renderHook(() => usePractice(settings, null));
  await act(() => first.result.current.start());
  await act(() => second.result.current.start());
  time = 2000;
  act(() => second.result.current.updateTyped('甲'));
  await act(() => second.result.current.pause());
  expect(drafts.size).toBe(2);
  act(() => first.result.current.updateTyped(article.text));
  expect(drafts.size).toBe(1);
  expect([...drafts.values()][0].typed).toBe('甲');
});

it('opens a cloud-only online draft as a fresh personal continuation', async () => {
  const requests = vi.fn(async () => { throw new Error('Cloud-only progress must not contact an official attempt'); });
  vi.stubGlobal('fetch', requests);
  const records: PracticeRecord[] = [];
  const drafts: SavedPractice[] = [];
  const removed: string[] = [];
  const source: SavedPractice = {
    id: 'draft-official', recordId: 'official', attemptId: 'official', article: { ...article, custom: false },
    ownerId: 'alice', typed: '甲错', duration: 60, mode: 'timed', strict: false,
    offset: 0, elapsedMs: 10_000, backspaces: 4, offline: false, savedAt: Date.now(),
  };
  const { result } = renderHook(() => usePractice({
    ...config, ownerId: 'alice', onDraft: (draft) => drafts.push(draft),
    onRecord: (record) => records.push(record), onRemoveDraft: (id) => removed.push(id),
  }, null));
  await act(() => result.current.loadSaved(source));
  expect(result.current).toMatchObject({ phase: 'paused', typed: '甲错', offset: 2, elapsedMs: 0, backspaces: 0 });
  expect(drafts[0]).toMatchObject({ typed: '甲错', offline: true, offset: 2 });
  expect(drafts[0].recordId).not.toBe(source.recordId);
  expect(drafts[0].id).not.toBe(source.id);
  await act(() => result.current.resume());
  time = 3000;
  act(() => result.current.updateTyped('甲错\n丙丁'));
  expect(requests).not.toHaveBeenCalled();
  expect(records[0]).toMatchObject({ offset: 2, total: 3, correct: 3, speed: 60, localOnly: true });
  expect(removed).toEqual([drafts[0].id]);
});

it('does not republish a parked draft deleted while the tab was inactive', async () => {
  const drafts: SavedPractice[] = [];
  const { result } = renderHook(() => usePractice({ ...config, onDraft: (draft) => drafts.push(draft) }, null));
  await act(() => result.current.start());
  act(() => result.current.updateTyped('甲'));
  await act(() => result.current.park());
  const { discardSavedDraft } = await import('../src/hooks/usePractice');
  expect(discardSavedDraft(drafts.at(-1)!)).toBe(true);
  const count = drafts.length;
  fireEvent(window, new PageTransitionEvent('pagehide'));
  fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
  expect(drafts).toHaveLength(count);
  expect(readDraft()).toBeNull();
});

it('binds an online start request to the displayed account and saves locally on mismatch', async () => {
  let expectedOwner: string | null = null;
  vi.stubGlobal('fetch', vi.fn(async (_: string, options: RequestInit) => {
    expectedOwner = new Headers(options.headers).get('X-Workspace-Owner');
    return { ok: false, json: async () => ({ error: '账号已切换' }) } as Response;
  }));
  const drafts: SavedPractice[] = [];
  const { result } = renderHook(() => usePractice({ ...config, custom: false, ownerId: 'alice', onDraft: (draft) => drafts.push(draft) }, null));
  await act(() => result.current.start());
  expect(expectedOwner).toBe('alice');
  expect(result.current.phase).toBe('running');
  expect(drafts[0]).toMatchObject({ ownerId: 'alice', offline: true });
  expect(drafts[0].attemptId).toBeUndefined();
});

it('bounds committed text to workspace size while preserving whole graphemes', async () => {
  const giant = '👩' + '\u200d👩'.repeat(10_001);
  const { result } = renderHook(() => usePractice(config, null));
  await act(() => result.current.start());
  act(() => result.current.updateTyped('甲' + giant));
  expect(result.current.typed).toBe('甲');
  expect(readDraft()?.typed).toBe('甲');
  act(() => result.current.updateTyped('甲乙'));
  expect(result.current.typed).toBe('甲乙');
});

it('keeps a new local history continuation distinct from a cloud copy', async () => {
  const id = 'draft-history-followup';
  const { result } = renderHook(() => usePractice(config, null));
  await act(() => result.current.loadSaved({
    id, recordId: 'history-followup', article, ownerId: null, typed: '甲', duration: 60, mode: 'timed',
    strict: false, offset: 1, backspaces: 0, elapsedMs: 0, offline: true, savedAt: Date.now(),
  }, { newRound: true }));
  expect(result.current).toMatchObject({ draftId: id, phase: 'paused', offset: 1, feedback: '' });
  expect(readDraft()?.recordId).toBe('history-followup');
});

it('discards a v1 draft without a persisted round ID using its stable recovered identity', async () => {
  const { discardSavedDraft, savedPracticeFromLegacy } = await import('../src/hooks/usePractice');
  localStorage.setItem('cloudtyping.practice.v1', JSON.stringify({
    version: 1, ...config, target: article.text, typed: '甲', elapsedMs: 500, backspaces: 0, suspicious: false, offline: true,
  }));
  const recovered = readDraft()!;
  expect(readDraft()?.recordId).toBe(recovered.recordId);
  expect(discardSavedDraft(savedPracticeFromLegacy(recovered))).toBe(true);
  expect(readDraft()).toBeNull();
});

it('preserves new input under a fresh personal ID when an active draft is deleted remotely', async () => {
  const drafts = new Map<string, SavedPractice>();
  const records: PracticeRecord[] = [];
  const deleted = new Set<string>();
  const settings = {
    ...config, ownerId: 'alice', custom: false,
    isDraftDeleted: (id: string, owner: string | null) => owner === 'alice' && deleted.has(id),
    onDraft: (draft: SavedPractice) => { drafts.set(draft.id, draft); },
    onRecord: (record: PracticeRecord) => records.push(record),
  };
  const request = vi.fn(async (url: string) => {
    if (url === '/api/tests/start') return { ok: true, json: async () => ({ id: 'official', target: article.text }) } as Response;
    throw new Error('The deleted attempt must not be submitted');
  });
  vi.stubGlobal('fetch', request);
  const session = renderHook(() => usePractice(settings, null));
  await act(() => session.result.current.start());
  time = 1000;
  act(() => session.result.current.updateTyped('错'));
  const oldId = session.result.current.draftId!;
  drafts.delete(oldId);
  deleted.add(oldId);
  time = 3000;
  act(() => session.result.current.updateTyped('甲乙'));
  expect(session.result.current.phase).toBe('running');
  expect(session.result.current.draftId).not.toBe(oldId);
  expect(drafts.has(oldId)).toBe(false);
  expect(drafts.get(session.result.current.draftId!)).toMatchObject({
    typed: '甲乙', elapsedMs: 3000, offline: true, offset: 0, mistakes: [{ position: 0, expected: '甲', actual: '错' }],
  });
  expect(readDraft('alice')).toMatchObject({ typed: '甲乙', offline: true });
  expect(readDraft('alice')?.id).toBeUndefined();
  act(() => session.result.current.updateTyped(article.text));
  expect(request).toHaveBeenCalledTimes(1);
  expect(records[0]).toMatchObject({ localOnly: true, elapsedMs: 3000, typed: article.text, correct: 5 });
});

it('recovers the latest committed prefix if a pending save discovers a tombstone', async () => {
  const drafts: SavedPractice[] = [];
  const deleted = new Set<string>();
  let rejectSave!: (error: Error) => void;
  const session = renderHook(() => usePractice({
    ...config,
    isDraftDeleted: (id) => deleted.has(id),
    onDraft(draft) {
      drafts.push(draft);
      if (drafts.length === 1) return new Promise<void>((_, reject) => { rejectSave = reject; });
    },
  }, null));
  await act(() => session.result.current.start());
  const original = drafts[0];
  time = 1500;
  act(() => session.result.current.updateTyped('甲乙'));
  expect(drafts).toHaveLength(1);
  await act(async () => {
    deleted.add(original.id);
    rejectSave(new Error('Deleted draft'));
  });
  expect(session.result.current.draftId).not.toBe(original.id);
  expect(drafts.at(-1)).toMatchObject({ typed: '甲乙', elapsedMs: 1500, offline: true });
  expect(readDraft()).toMatchObject({ recordId: drafts.at(-1)?.recordId, typed: '甲乙' });
});
