import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { BookOpen } from '@phosphor-icons/react/BookOpen';
import { CaretDown } from '@phosphor-icons/react/CaretDown';
import { CheckCircle } from '@phosphor-icons/react/CheckCircle';
import { Clock } from '@phosphor-icons/react/Clock';
import { Cloud } from '@phosphor-icons/react/Cloud';
import { Crown } from '@phosphor-icons/react/Crown';
import { Crosshair } from '@phosphor-icons/react/Crosshair';
import { Keyboard } from '@phosphor-icons/react/Keyboard';
import { MoonStars } from '@phosphor-icons/react/MoonStars';
import { Pause } from '@phosphor-icons/react/Pause';
import { Play } from '@phosphor-icons/react/Play';
import { SignOut } from '@phosphor-icons/react/SignOut';
import { Sparkle } from '@phosphor-icons/react/Sparkle';
import { Sun } from '@phosphor-icons/react/Sun';
import { Trophy } from '@phosphor-icons/react/Trophy';
import { UserCircle } from '@phosphor-icons/react/UserCircle';
import { articles, type Difficulty, type Language } from './data/articles';
import { api, type User } from './lib/api';
import { scoreTyping, splitCharacters } from './lib/scoring';
import { resolveTheme, themeStorageKey, type Theme } from './lib/theme';
import { localHistory, readDraft, usePractice, type History } from './hooks/usePractice';
import { AuthDialog } from './components/AuthDialog';
import { Dialog } from './components/Dialog';

type View = 'practice' | 'rankings' | 'history' | 'admin';
type Ranking = { nickname: string; speed: number; accuracy: number; guest: number; createdAt: number; attemptId: string };
type ReviewEntry = { id: string; nickname: string; language: Language; difficulty: Difficulty; duration: number; speed: number; accuracy: number; checkpoints: number; reasons: string[] };

const difficultyNames: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };
const languageNames: Record<Language, string> = { zh: '中文', en: 'English' };
const reviewReasonNames: Record<string, string> = { paste_or_drop: '检测到粘贴或拖放', unusual_progress: '输入进度异常', missing_activity: '练习进度记录不足', stale_activity: '结束前进度记录缺失', high_speed: '速度较高', paused_session: '练习曾暂停或恢复', timing_discrepancy: '计时差异较大' };
function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
function initialTheme(): Theme {
  let saved: string | null = null;
  try { saved = localStorage.getItem(themeStorageKey); } catch { /* Use the system preference when storage is unavailable. */ }
  return resolveTheme(saved, typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

export function App() {
  const initialDraft = useMemo(() => readDraft(), []);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [view, setView] = useState<View>('practice');
  const [language, setLanguage] = useState<Language>(initialDraft?.language ?? 'zh');
  const [difficulty, setDifficulty] = useState<Difficulty>(initialDraft?.difficulty ?? 'beginner');
  const [minutesText, setMinutesText] = useState(initialDraft ? String(initialDraft.duration / 60) : '5');
  const [articleId, setArticleId] = useState(initialDraft?.articleId ?? 'zh-beginner-1');
  const [customText, setCustomText] = useState(initialDraft?.custom ? initialDraft.target : '');
  const [customDraft, setCustomDraft] = useState('');
  const [customError, setCustomError] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [nickname, setNickname] = useState('');
  const [rankMessage, setRankMessage] = useState('');
  const [rankSubmitted, setRankSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [review, setReview] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const rankRequest = useRef<AbortController | null>(null);
  const rankRequestId = useRef(0);
  const activeCharacterRef = useRef<HTMLSpanElement>(null);
  const availableArticles = useMemo(() => articles.filter((item) => item.language === language && item.difficulty === difficulty), [language, difficulty]);
  const selectedArticle = articles.find((item) => item.id === articleId) || availableArticles[0];
  const minutes = Number(minutesText);
  const validDuration = /^\d+$/.test(minutesText) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 60;
  const duration = validDuration ? minutes * 60 : 0;
  const displayTitle = customText ? '自定义文字' : selectedArticle.title;
  const practice = usePractice({ articleId, title: displayTitle, text: customText || selectedArticle.content, language, difficulty, duration, custom: !!customText, ownerId: user?.id ?? null }, initialDraft);
  const { phase, target, typed, result } = practice;
  const locked = !['ready', 'finished'].includes(phase);
  const previewScore = scoreTyping(target, typed, Math.max(practice.elapsedMs / 1000, 0.1));
  const typedCharacters = useMemo(() => splitCharacters(typed), [typed]);
  const targetCharacters = useMemo(() => splitCharacters(target), [target]);
  const remainingMs = Math.max(0, duration * 1000 - practice.elapsedMs);

  useEffect(() => {
    let active = true;
    api<{ user: User | null }>('/api/me', { timeoutMs: 3000 }).then((data) => { if (active) setUser(data.user); }).catch(() => {}).finally(() => { if (active) setAuthReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(themeStorageKey, theme); } catch { /* Theme switching still works for this visit. */ }
  }, [theme]);
  useEffect(() => {
    if (phase === 'running' && activeCharacterRef.current) activeCharacterRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [typedCharacters.length, phase]);
  useEffect(() => {
    if (result) { setRankMessage(''); setRankSubmitted(false); setShowResult(true); }
  }, [result]);

  function resetPractice(nextText = customText || selectedArticle.content) {
    practice.reset(nextText); setRankMessage(''); setRankSubmitted(false);
  }
  function changeLanguage(next: Language) {
    if (locked) return;
    const nextArticle = articles.find((item) => item.language === next && item.difficulty === difficulty)!;
    setLanguage(next); setArticleId(nextArticle.id); setCustomText(''); resetPractice(nextArticle.content);
  }
  function changeDifficulty(next: Difficulty) {
    if (locked) return;
    const nextArticle = articles.find((item) => item.language === language && item.difficulty === next)!;
    setDifficulty(next); setArticleId(nextArticle.id); setCustomText(''); resetPractice(nextArticle.content);
  }
  function changeDuration(event: ChangeEvent<HTMLInputElement>) {
    if (locked) return;
    setMinutesText(event.target.value);
    if (phase === 'finished') resetPractice();
  }
  function changeArticle(event: ChangeEvent<HTMLSelectElement>) {
    const article = articles.find((item) => item.id === event.target.value);
    if (!article || locked) return;
    setArticleId(article.id); setCustomText(''); resetPractice(article.content);
  }
  function useCustomText() {
    const value = customDraft.replace(/\r\n?/g, '\n').trim();
    if (!value || splitCharacters(value).length > 20000) { setCustomError('请输入 1–20000 个字符的练习文字。'); return; }
    setCustomText(value); setArticleId('custom'); setCustomError(''); setShowCustom(false); resetPractice(value);
  }
  async function submitRank() {
    if (!result?.attemptId) return;
    setBusy(true); setRankMessage('');
    try {
      const data = await api<{ status: string }>('/api/leaderboard', { method: 'POST', body: { attemptId: result.attemptId, nickname } });
      setRankMessage(data.status === 'review' ? '成绩已提交，正在等待复核。' : '成绩已提交到排行榜！');
      setRankSubmitted(true);
    } catch (problem) { setRankMessage((problem as Error).message); setRankSubmitted(false); }
    finally { setBusy(false); }
  }
  const loadRankings = useCallback(async () => {
    rankRequest.current?.abort();
    if (!validDuration) { setRankings([]); setFeedback('请输入 1–60 分钟的整数。'); return; }
    const controller = new AbortController();
    rankRequest.current = controller;
    const requestId = ++rankRequestId.current;
    setLoading(true); setFeedback('');
    try {
      const data = await api<{ entries: Ranking[] }>(`/api/leaderboard?language=${language}&difficulty=${difficulty}&duration=${duration}`, { signal: controller.signal });
      if (!controller.signal.aborted && requestId === rankRequestId.current) setRankings(data.entries);
    } catch (problem) {
      if (!controller.signal.aborted && requestId === rankRequestId.current) { setRankings([]); setFeedback((problem as Error).message); }
    } finally {
      if (!controller.signal.aborted && requestId === rankRequestId.current) setLoading(false);
    }
  }, [language, difficulty, duration, validDuration]);
  const loadHistory = useCallback(async () => {
    setLoading(true); setFeedback('');
    const ownLocal = localHistory().filter((entry) => user ? entry.ownerId === user.id || (!entry.ownerId && entry.localOnly) : !entry.ownerId);
    try {
      if (!user) setHistory(ownLocal);
      else {
        const remote = (await api<{ entries: History[] }>('/api/history')).entries;
        const remoteIds = new Set(remote.map((entry) => entry.recordId));
        setHistory([...remote, ...ownLocal.filter((entry) => entry.localOnly && !remoteIds.has(entry.recordId))].sort((a, b) => b.finishedAt - a.finishedAt));
      }
    } catch { setHistory(ownLocal); setFeedback('暂时无法连接服务，正在显示本机记录。'); }
    finally { setLoading(false); }
  }, [user]);
  const loadReview = useCallback(async () => {
    setLoading(true); setFeedback('');
    try { setReview((await api<{ entries: ReviewEntry[] }>('/api/admin/review')).entries); }
    catch (problem) { setFeedback((problem as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (view === 'rankings') {
      void loadRankings();
      return () => { rankRequest.current?.abort(); rankRequestId.current++; };
    }
    if (view === 'history') void loadHistory();
    if (view === 'admin') void loadReview();
  }, [view, loadRankings, loadHistory, loadReview]);
  async function reviewAction(id: string, action: 'approve' | 'reject') {
    try { await api(`/api/admin/review/${id}`, { method: 'POST', body: { action } }); await loadReview(); }
    catch (problem) { setFeedback((problem as Error).message); }
  }
  async function removeScore(id: string) {
    try { await api(`/api/admin/remove/${id}`, { method: 'POST', body: {} }); await loadRankings(); }
    catch (problem) { setFeedback((problem as Error).message); }
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); setUser(null); setView('practice'); }
    catch (problem) { setFeedback((problem as Error).message); }
  }
  function navigate(next: View) {
    if (locked) { setFeedback(phase === 'finishing' ? '正在保存本次成绩，请稍候。' : '请先完成或重新开始当前练习。'); return; }
    setFeedback(''); setView(next);
  }

  const filters = <>
    <div className="top-filters">
      <div className="segmented language-switch" role="group" aria-label="选择语言">
        {(['zh', 'en'] as const).map((item) => <button key={item} disabled={locked} aria-pressed={language === item} onClick={() => changeLanguage(item)}>{languageNames[item]}</button>)}
      </div>
      <span className="filter-divider" aria-hidden="true" />
      <label className="duration-input"><Clock size={21} /><span>测试时间</span><input type="number" min="1" max="60" step="1" aria-label="测试时间（分钟）" aria-invalid={!validDuration} value={minutesText} disabled={locked} onChange={changeDuration} /><span>分钟</span></label>
    </div>
    <div className="detail-filters">
      {view === 'practice' && <div className="article-choice"><label className="article-picker"><BookOpen size={24} /><span>选择文章</span><span className="select-wrap"><select value={articleId} disabled={locked} onChange={changeArticle} aria-label="选择练习文章">{customText && <option value="custom">自定义文字</option>}{availableArticles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select><CaretDown aria-hidden="true" size={17} /></span></label><button className="text-button custom-button" disabled={locked} onClick={() => { setCustomDraft(customText); setCustomError(''); setShowCustom(true); }}>自定义文字</button></div>}
      <div className="difficulty-picker"><span>难度：</span><div className="segmented difficulty-switch" role="group" aria-label="选择难度">{(['beginner', 'intermediate', 'advanced'] as const).map((item) => <button key={item} disabled={locked} aria-pressed={difficulty === item} onClick={() => changeDifficulty(item)}>{difficultyNames[item]}</button>)}</div></div>
    </div>
  </>;

  return <div className="app-shell">
    <header className="site-header">
      <button className="brand" onClick={() => navigate('practice')} aria-label="云打字练习首页"><Cloud size={40} weight="regular" /><span>云打字练习</span></button>
      <span className="brand-subtitle">中文 / English 打字测试</span>
      <nav aria-label="主要导航">
        <button className={view === 'practice' ? 'nav-active' : ''} onClick={() => navigate('practice')}>练习</button>
        <button className={view === 'rankings' ? 'nav-active' : ''} onClick={() => navigate('rankings')}>排行榜</button>
        <button className={view === 'history' ? 'nav-active' : ''} onClick={() => navigate('history')}>我的记录</button>
        {user?.isAdmin && <button className={view === 'admin' ? 'nav-active' : ''} onClick={() => navigate('admin')}>审核</button>}
        <button className="theme-button" aria-label={theme === 'dark' ? '切换至日间模式' : '切换至夜间模式'} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={20} /> : <MoonStars size={20} />}<span>{theme === 'dark' ? '日间' : '夜间'}</span></button>
        {user ? <button className="account-button" disabled={locked} onClick={logout} title="退出登录"><UserCircle size={21} /> {user.username} <SignOut size={16} /></button> : <button className="account-button" disabled={locked || !authReady} onClick={() => setShowAuth(true)}>登录</button>}
      </nav>
    </header>
    <main className="room">
      <div className="workspace">
        {(view === 'practice' || view === 'rankings') && filters}
        {view === 'practice' && <>
          <div className="status-row"><span><Clock size={23} /> 剩余时间：<b data-testid="remaining-time">{formatTime(remainingMs)}</b></span><span><Crosshair size={23} /> 准确率：{typed ? `${previewScore.accuracy}%` : '—'}</span><span><Keyboard size={23} /> {language === 'zh' ? '字 / 分钟' : 'WPM'}：{typed ? (language === 'zh' ? previewScore.cpm : previewScore.wpm) : '—'}</span></div>
          <div className="progress-row"><span>文章字数：<b data-testid="article-count">{targetCharacters.length}</b></span><span>已打字数：<b data-testid="typed-count">{typedCharacters.length}</b></span><span>当前错误：<b data-testid="error-count">{previewScore.total - previewScore.correct}</b></span><span title="输入法候选词编辑不计入退格次数">退格：<b data-testid="backspace-count">{practice.backspaces}</b></span></div>
          <section className="typing-panel" aria-label="文章练习">
            <div className="passage" aria-label={`当前文章：${displayTitle}`}>
              {targetCharacters.map((character, index) => <span key={index} ref={index === typedCharacters.length ? activeCharacterRef : undefined} className={index < typedCharacters.length ? (typedCharacters[index] === character ? 'char-correct' : 'char-wrong') : index === typedCharacters.length && phase === 'running' ? 'char-current' : ''}>{character}</span>)}
            </div>
            <label className="sr-only" htmlFor="typing-input">在此输入上方文章，中文候选字上屏后计入成绩</label>
            <textarea id="typing-input" ref={practice.textareaRef} value={practice.raw} disabled={phase !== 'running'} onChange={practice.onChange} onKeyDown={practice.onKeyDown} onCompositionStart={practice.onCompositionStart} onCompositionEnd={practice.onCompositionEnd} onPaste={practice.markSuspicious} onDrop={practice.markSuspicious} placeholder={phase === 'running' ? '在这里输入文章…' : phase === 'paused' ? '练习已暂停' : '点击下方按钮开始练习'} spellCheck={false} autoComplete="off" />
          </section>
          <div className="practice-actions">
            {phase === 'running' ? <button className="primary-button start-button" onClick={() => void practice.pause()}><Pause size={22} weight="fill" /> 暂停练习</button> : phase === 'paused' ? <><button className="primary-button start-button" disabled={!authReady} onClick={() => void practice.resume()}><Play size={22} weight="fill" /> 继续练习</button><button className="outline-button" onClick={() => resetPractice()}>重新开始</button></> : <button className="primary-button start-button" onClick={phase === 'finished' ? () => resetPractice() : () => void practice.start()} disabled={locked || !validDuration || !authReady}>{phase === 'starting' || !authReady ? '准备中…' : phase === 'restoring' ? '恢复进度中…' : phase === 'pausing' ? '正在暂停…' : phase === 'resuming' ? '正在继续…' : phase === 'finishing' ? '正在结算…' : phase === 'finished' ? '再练一次' : <><Play size={22} weight="fill" /> 开始练习</>}</button>}
          </div>
          <p className="helper-text" role="status">{!validDuration ? '请输入 1–60 分钟的整数。' : feedback || practice.feedback || (phase === 'paused' ? '练习已暂停，暂停时间不计入成绩。' : '选好文章和时间；打完当前文章或时间到时显示结果。')}</p>
        </>}
        {view === 'rankings' && <section className="content-panel"><div className="content-heading"><div><h1><Trophy size={26} /> 排行榜</h1><p>同语言、同难度和同一时长的成绩一起比较。</p></div><span className="count-chip">前 100 名</span></div>{feedback && <p className="form-error">{feedback}</p>}{loading ? <p className="empty-state">正在寻找星星般的成绩…</p> : rankings.length === 0 ? <p className="empty-state">还没有成绩，来留下第一个脚印吧。</p> : <ol className="ranking-list">{rankings.map((entry, index) => <li key={`${entry.attemptId}-${index}`}><span className={`rank-number rank-${index + 1}`}>{index < 3 ? <Crown size={21} weight="fill" /> : index + 1}</span><span className="rank-name">{entry.nickname} {entry.guest ? <small>游客</small> : null}</span><span className="rank-accuracy">准确率 {entry.accuracy}%</span><strong>{entry.speed} <small>{language === 'zh' ? '字/分' : 'WPM'}</small></strong>{user?.isAdmin && <button className="text-button" onClick={() => void removeScore(entry.attemptId)}>下架</button>}</li>)}</ol>}</section>}
        {view === 'history' && <section className="content-panel"><div className="content-heading"><div><h1><Clock size={26} /> 我的记录</h1><p>{user ? '账号成绩与本机未同步记录都会显示在这里。' : '游客记录保存在当前浏览器中。'}</p></div>{!user && <button className="outline-button" onClick={() => setShowAuth(true)}>登录同步</button>}</div>{feedback && <p className="form-error">{feedback}</p>}{loading ? <p className="empty-state">正在加载…</p> : history.length === 0 ? <p className="empty-state">还没有练习记录，开始一段轻松的打字时光吧。</p> : <ul className="history-list">{history.map((entry, index) => <li key={`${entry.finishedAt}-${index}`}><span><strong>{languageNames[entry.language]} · {difficultyNames[entry.difficulty]}</strong><small>{formatDate(entry.finishedAt)} · 限时 {entry.duration / 60} 分钟{entry.elapsedMs != null ? ` · 用时 ${formatTime(entry.elapsedMs)}` : ''}</small>{entry.localOnly && <small>本机未同步</small>}</span><span>{entry.speed} {entry.language === 'zh' ? '字/分' : 'WPM'}<small>准确率 {entry.accuracy}% · 错误 {entry.errors ?? 0} · 退格 {entry.backspaces ?? 0}</small></span></li>)}</ul>}</section>}
        {view === 'admin' && <section className="content-panel"><div className="content-heading"><div><h1><Sparkle size={26} /> 成绩复核</h1><p>检查被标记的成绩；通过后才会进入排行榜。</p></div></div>{feedback && <p className="form-error">{feedback}</p>}{review.length === 0 ? <p className="empty-state">目前没有待复核的成绩。</p> : <ul className="history-list">{review.map((entry) => <li key={entry.id}><span><strong>{entry.nickname} · {languageNames[entry.language]} {difficultyNames[entry.difficulty]}</strong><small>{entry.duration}秒 · {entry.speed} · 准确率 {entry.accuracy}% · 进度记录 {entry.checkpoints} 次</small><small>复核原因：{entry.reasons.map((reason) => reviewReasonNames[reason] || reason).join('、') || '人工标记'}</small></span><span className="review-actions"><button className="text-button" onClick={() => void reviewAction(entry.id, 'approve')}>通过</button><button className="text-button" onClick={() => void reviewAction(entry.id, 'reject')}>拒绝</button></span></li>)}</ul>}</section>}
      </div>
      <img className="sleeping-cat" src="/assets/sleeping-cat.png" alt="" aria-hidden="true" />
    </main>
    {showCustom && <Dialog title="自定义练习文字" onClose={() => setShowCustom(false)}><p className="dialog-intro">粘贴或输入想练习的内容，当前语言和难度仍可用于分类。自定义文字仅作本地练习。</p><label className="custom-editor">练习文字<textarea aria-label="自定义文章内容" value={customDraft} maxLength={20000} onChange={(event) => setCustomDraft(event.target.value)} placeholder="在这里输入或粘贴文章…" /></label>{customError && <p className="form-error" role="alert">{customError}</p>}<div className="result-actions"><span className="custom-count">{splitCharacters(customDraft).length} / 20000 字符</span><button className="primary-button" onClick={useCustomText}>使用这段文字</button></div></Dialog>}
    {showAuth && <AuthDialog onClose={() => setShowAuth(false)} onLogin={setUser} />}
    {showResult && result && <Dialog title="练习完成！" onClose={() => setShowResult(false)}>
      <p className="dialog-intro">{result.offline ? '这次是本地练习，成绩已保存在当前浏览器。' : '每一次练习，都是向前的一小步。'}</p>
      <div className="result-metrics"><div><strong>{result.language === 'zh' ? result.score.cpm : result.score.wpm}</strong><span>{result.language === 'zh' ? '字 / 分钟' : 'WPM'}</span></div><div><strong>{result.score.accuracy}%</strong><span>准确率</span></div><div><strong>{result.score.total} / {result.articleTotal}</strong><span>已打 / 文章字数</span></div><div><strong>{result.errors}</strong><span>错误字数</span></div><div><strong>{result.backspaces}</strong><span>退格次数</span></div><div><strong>{formatTime(result.elapsedMs)}</strong><span>有效用时</span></div></div>
      {!result.offline && result.eligible && !rankSubmitted && <div className="rank-submit">{!user && <label>上榜昵称<input value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} placeholder="给自己取个昵称" /></label>}<button className="primary-button" disabled={busy || (!user && !nickname.trim())} onClick={() => void submitRank()}><Trophy size={20} /> {busy ? '提交中…' : '提交到排行榜'}</button></div>}
      {rankMessage && <p className={rankSubmitted ? 'form-notice' : 'form-error'} role={rankSubmitted ? 'status' : 'alert'}>{rankSubmitted && <CheckCircle size={18} />} {rankMessage}</p>}
      <div className="result-actions"><button className="outline-button" onClick={() => { setShowResult(false); resetPractice(); }}>再练一次</button><button className="text-button" onClick={() => { setShowResult(false); navigate('rankings'); }}>查看排行榜</button></div>
    </Dialog>}
  </div>;
}
