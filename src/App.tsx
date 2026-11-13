import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { BookOpen, CaretDown, CheckCircle, Clock, Cloud, Crown, Crosshair, Keyboard, Play, SignOut, Sparkle, Trophy, UserCircle } from '@phosphor-icons/react';
import { articles, type Difficulty, type Language } from './data/articles';
import { api, type User } from './lib/api';
import { scoreTyping, splitCharacters, type Score } from './lib/scoring';
import { AuthDialog } from './components/AuthDialog';
import { Dialog } from './components/Dialog';

type View = 'practice' | 'rankings' | 'history' | 'admin';
type Phase = 'ready' | 'starting' | 'running' | 'finished';
type Finish = { score: Score; attemptId?: string; status?: string; eligible?: boolean; offline: boolean };
type Attempt = { target: string; id?: string; duration: number; language: Language; difficulty: Difficulty; title: string; offline: boolean; deadline: number; suspicious: boolean };
type Ranking = { nickname: string; speed: number; accuracy: number; guest: number; createdAt: number; attemptId: string };
type History = { language: Language; difficulty: Difficulty; duration: number; speed: number; accuracy: number; finishedAt: number; status?: string };
type ReviewEntry = { id: string; nickname: string; language: Language; difficulty: Difficulty; duration: number; speed: number; accuracy: number };

const difficultyNames: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };
const languageNames: Record<Language, string> = { zh: '中文', en: 'English' };
const durations = [30, 60, 120];
const historyKey = 'cloudtyping.history.v1';

function localHistory(): History[] {
  try { const value = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(value) ? value.slice(0, 50) : []; } catch { return []; }
}
function rememberHistory(entry: History) {
  try { localStorage.setItem(historyKey, JSON.stringify([entry, ...localHistory()].slice(0, 50))); } catch { /* Practice remains available when storage is disabled. */ }
}
function localTarget(articleId: string) {
  const article = articles.find((item) => item.id === articleId)!;
  const rest = articles.filter((item) => item.language === article.language && item.difficulty === article.difficulty && item.id !== article.id);
  return [article, ...rest].map((item) => item.content).join(article.language === 'zh' ? '' : ' ');
}
function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

export function App() {
  const [view, setView] = useState<View>('practice');
  const [language, setLanguage] = useState<Language>('zh');
  const [difficulty, setDifficulty] = useState<Difficulty>('beginner');
  const [duration, setDuration] = useState(60);
  const [articleId, setArticleId] = useState('zh-beginner-1');
  const [phase, setPhase] = useState<Phase>('ready');
  const phaseRef = useRef<Phase>('ready');
  const [target, setTarget] = useState(articles[0].content);
  const [raw, setRaw] = useState('');
  const [committed, setCommitted] = useState('');
  const committedRef = useRef('');
  const composing = useRef(false);
  const [remaining, setRemaining] = useState(60);
  const [result, setResult] = useState<Finish | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [nickname, setNickname] = useState('');
  const [rankMessage, setRankMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [review, setReview] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeCharacterRef = useRef<HTMLSpanElement>(null);

  const availableArticles = useMemo(() => articles.filter((item) => item.language === language && item.difficulty === difficulty), [language, difficulty]);
  const selectedArticle = articles.find((item) => item.id === articleId) || availableArticles[0];
  const previewScore = scoreTyping(target, committed, Math.max(1, duration - remaining));
  const typedCharacters = useMemo(() => splitCharacters(committed), [committed]);
  const targetCharacters = useMemo(() => splitCharacters(target), [target]);
  const locked = phase === 'running' || phase === 'starting';
  const setCurrentPhase = (value: Phase) => { phaseRef.current = value; setPhase(value); };

  useEffect(() => {
    api<{ user: User | null }>('/api/me').then((data) => setUser(data.user)).catch(() => {});
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);
  useEffect(() => {
    if (phase === 'running' && activeCharacterRef.current) activeCharacterRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [typedCharacters.length, phase]);

  const finishTest = useCallback(async () => {
    const attempt = attemptRef.current;
    if (!attempt || phaseRef.current !== 'running') return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setCurrentPhase('finished');
    setRemaining(0);
    const finalInput = committedRef.current;
    const localScore = scoreTyping(attempt.target, finalInput, attempt.duration);
    let finalResult: Finish = { score: localScore, offline: attempt.offline };
    if (attempt.id && !attempt.offline) {
      try {
        const saved = await api<{ attemptId: string; score: Score; status: string; eligible: boolean }>(`/api/tests/${attempt.id}/finish`, { method: 'POST', body: { typed: finalInput, suspicious: attempt.suspicious } });
        finalResult = { ...saved, offline: false };
      } catch {
        finalResult = { score: localScore, offline: true };
      }
    }
    rememberHistory({ language: attempt.language, difficulty: attempt.difficulty, duration: attempt.duration, speed: attempt.language === 'zh' ? finalResult.score.cpm : finalResult.score.wpm, accuracy: finalResult.score.accuracy, finishedAt: Date.now(), status: finalResult.status });
    setResult(finalResult); setRankMessage(''); setShowResult(true);
  }, []);

  async function startTest() {
    if (locked) return;
    setCurrentPhase('starting'); setFeedback(''); setResult(null); setRankMessage(''); setRaw(''); setCommitted(''); committedRef.current = ''; composing.current = false;
    let testTarget = localTarget(articleId);
    let id: string | undefined;
    let offline = false;
    try {
      const challenge = await api<{ id: string; target: string }>('/api/tests/start', { method: 'POST', body: { articleId, duration } });
      id = challenge.id; testTarget = challenge.target;
    } catch {
      offline = true; setFeedback('当前为本地练习，联网后可参加排行榜。');
    }
    setTarget(testTarget); setRemaining(duration);
    const attempt: Attempt = { id, target: testTarget, duration, language, difficulty, title: selectedArticle.title, offline, deadline: performance.now() + duration * 1000, suspicious: false };
    attemptRef.current = attempt;
    setCurrentPhase('running');
    timerRef.current = setInterval(() => {
      const left = Math.max(0, Math.ceil((attempt.deadline - performance.now()) / 1000));
      setRemaining(left);
      if (!left) void finishTest();
    }, 100);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function resetPractice() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null; attemptRef.current = null; committedRef.current = ''; composing.current = false;
    setRaw(''); setCommitted(''); setTarget(selectedArticle.content); setRemaining(duration); setResult(null); setFeedback(''); setRankMessage(''); setCurrentPhase('ready');
  }
  function changeLanguage(next: Language) {
    if (locked) return;
    setLanguage(next); const nextArticle = articles.find((item) => item.language === next && item.difficulty === difficulty)!;
    setArticleId(nextArticle.id); setTarget(nextArticle.content); setRaw(''); setCommitted(''); setCurrentPhase('ready'); setRemaining(duration); setResult(null);
  }
  function changeDifficulty(next: Difficulty) {
    if (locked) return;
    setDifficulty(next); const nextArticle = articles.find((item) => item.language === language && item.difficulty === next)!;
    setArticleId(nextArticle.id); setTarget(nextArticle.content); setRaw(''); setCommitted(''); setCurrentPhase('ready'); setRemaining(duration); setResult(null);
  }
  function changeDuration(next: number) {
    if (locked) return;
    setDuration(next); setRemaining(next); setCurrentPhase('ready'); setRaw(''); setCommitted(''); setTarget(selectedArticle.content); setResult(null);
  }
  function changeArticle(event: ChangeEvent<HTMLSelectElement>) {
    const article = articles.find((item) => item.id === event.target.value);
    if (!article || locked) return;
    setArticleId(article.id); setTarget(article.content); setCurrentPhase('ready'); setRaw(''); setCommitted(''); setRemaining(duration); setResult(null);
  }
  function changeInput(event: ChangeEvent<HTMLTextAreaElement>) {
    if (phaseRef.current !== 'running') return;
    const value = event.target.value;
    setRaw(value);
    if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) { committedRef.current = value; setCommitted(value); }
  }
  async function submitRank() {
    if (!result?.attemptId) return;
    setBusy(true); setRankMessage('');
    try {
      const data = await api<{ status: string }>('/api/leaderboard', { method: 'POST', body: { attemptId: result.attemptId, nickname } });
      setRankMessage(data.status === 'review' ? '成绩已提交，正在等待复核。' : '成绩已提交到排行榜！');
    } catch (problem) { setRankMessage((problem as Error).message); }
    finally { setBusy(false); }
  }
  const loadRankings = useCallback(async () => {
    setLoading(true); setFeedback('');
    try { const data = await api<{ entries: Ranking[] }>(`/api/leaderboard?language=${language}&difficulty=${difficulty}&duration=${duration}`); setRankings(data.entries); }
    catch (problem) { setRankings([]); setFeedback((problem as Error).message); }
    finally { setLoading(false); }
  }, [language, difficulty, duration]);
  const loadHistory = useCallback(async () => {
    setLoading(true); setFeedback('');
    try { setHistory(user ? (await api<{ entries: History[] }>('/api/history')).entries : localHistory()); }
    catch { setHistory(localHistory()); setFeedback('暂时无法连接服务，正在显示本机记录。'); }
    finally { setLoading(false); }
  }, [user]);
  const loadReview = useCallback(async () => {
    setLoading(true); setFeedback('');
    try { setReview((await api<{ entries: ReviewEntry[] }>('/api/admin/review')).entries); }
    catch (problem) { setFeedback((problem as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (view === 'rankings') void loadRankings();
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
    if (locked) { setFeedback('练习进行中，计时会继续。请先完成本次练习。'); return; }
    setFeedback(''); setView(next);
  }

  const filters = <>
    <div className="top-filters">
      <div className="segmented language-switch" role="group" aria-label="选择语言">
        {(['zh', 'en'] as const).map((item) => <button key={item} disabled={locked} aria-pressed={language === item} onClick={() => changeLanguage(item)}>{languageNames[item]}</button>)}
      </div>
      <span className="filter-divider" aria-hidden="true" />
      <div className="segmented duration-switch" role="group" aria-label="选择时长">
        {durations.map((item) => <button key={item} disabled={locked} aria-pressed={duration === item} onClick={() => changeDuration(item)}>{item}秒</button>)}
      </div>
    </div>
    <div className="detail-filters">
      {view === 'practice' && <label className="article-picker"><BookOpen size={24} /><span>选择文章</span><span className="select-wrap"><select value={articleId} disabled={locked} onChange={changeArticle} aria-label="选择练习文章">{availableArticles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select><CaretDown aria-hidden="true" size={17} /></span></label>}
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
        {user ? <button className="account-button" disabled={locked} onClick={logout} title="退出登录"><UserCircle size={21} /> {user.username} <SignOut size={16} /></button> : <button className="account-button" disabled={locked} onClick={() => setShowAuth(true)}>登录</button>}
      </nav>
    </header>
    <main className="room">
      <div className="workspace">
        {(view === 'practice' || view === 'rankings') && filters}
        {view === 'practice' && <>
          <div className="status-row" aria-live="polite"><span><Clock size={23} /> 时间：{remaining} 秒</span><span><Crosshair size={23} /> 准确率：{committed ? `${previewScore.accuracy}%` : '—'}</span><span><Keyboard size={23} /> {language === 'zh' ? '字 / 分钟' : 'WPM'}：{committed ? (language === 'zh' ? previewScore.cpm : previewScore.wpm) : '—'}</span></div>
          <section className="typing-panel" aria-label="文章练习">
            <div className="passage" aria-label={`当前文章：${selectedArticle.title}`}>
              {targetCharacters.map((character, index) => <span key={index} ref={index === typedCharacters.length ? activeCharacterRef : undefined} className={index < typedCharacters.length ? (typedCharacters[index] === character ? 'char-correct' : 'char-wrong') : index === typedCharacters.length && phase === 'running' ? 'char-current' : ''}>{character}</span>)}
            </div>
            <label className="sr-only" htmlFor="typing-input">在此输入上方文章，中文候选字上屏后计入成绩</label>
            <textarea id="typing-input" ref={textareaRef} value={raw} disabled={phase !== 'running'} onChange={changeInput} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(event) => { composing.current = false; if (phaseRef.current === 'running') { committedRef.current = event.currentTarget.value; setCommitted(event.currentTarget.value); setRaw(event.currentTarget.value); } }} onPaste={() => { if (attemptRef.current) attemptRef.current.suspicious = true; }} onDrop={() => { if (attemptRef.current) attemptRef.current.suspicious = true; }} placeholder={phase === 'running' ? '在这里输入文章…' : '点击下方按钮开始练习'} spellCheck={false} autoComplete="off" />
          </section>
          <div className="practice-actions"><button className="primary-button start-button" onClick={phase === 'finished' ? resetPractice : startTest} disabled={locked}>{phase === 'starting' ? '准备中…' : phase === 'running' ? '练习进行中' : phase === 'finished' ? '再练一次' : <><Play size={22} weight="fill" /> 开始练习</>}</button></div>
          <p className="helper-text">{feedback || '选好文章和时长，开始后即可输入。文章结束会自动衔接同难度内容。'}</p>
        </>}
        {view === 'rankings' && <section className="content-panel"><div className="content-heading"><div><h1><Trophy size={26} /> 排行榜</h1><p>同语言、同难度和同一时长的成绩一起比较。</p></div><span className="count-chip">前 100 名</span></div>{feedback && <p className="form-error">{feedback}</p>}{loading ? <p className="empty-state">正在寻找星星般的成绩…</p> : rankings.length === 0 ? <p className="empty-state">还没有成绩，来留下第一个脚印吧。</p> : <ol className="ranking-list">{rankings.map((entry, index) => <li key={`${entry.attemptId}-${index}`}><span className={`rank-number rank-${index + 1}`}>{index < 3 ? <Crown size={21} weight="fill" /> : index + 1}</span><span className="rank-name">{entry.nickname} {entry.guest ? <small>游客</small> : null}</span><span className="rank-accuracy">准确率 {entry.accuracy}%</span><strong>{entry.speed} <small>{language === 'zh' ? '字/分' : 'WPM'}</small></strong>{user?.isAdmin && <button className="text-button" onClick={() => void removeScore(entry.attemptId)}>下架</button>}</li>)}</ol>}</section>}
        {view === 'history' && <section className="content-panel"><div className="content-heading"><div><h1><Clock size={26} /> 我的记录</h1><p>{user ? '登录后的成绩会保存在账号中。' : '游客记录保存在当前浏览器中。'}</p></div>{!user && <button className="outline-button" onClick={() => setShowAuth(true)}>登录同步</button>}</div>{feedback && <p className="form-error">{feedback}</p>}{loading ? <p className="empty-state">正在加载…</p> : history.length === 0 ? <p className="empty-state">还没有练习记录，开始一段轻松的打字时光吧。</p> : <ul className="history-list">{history.map((entry, index) => <li key={`${entry.finishedAt}-${index}`}><span><strong>{languageNames[entry.language]} · {difficultyNames[entry.difficulty]}</strong><small>{formatDate(entry.finishedAt)} · {entry.duration}秒</small></span><span>{entry.speed} {entry.language === 'zh' ? '字/分' : 'WPM'}<small>准确率 {entry.accuracy}%</small></span></li>)}</ul>}</section>}
        {view === 'admin' && <section className="content-panel"><div className="content-heading"><div><h1><Sparkle size={26} /> 成绩复核</h1><p>检查被标记的成绩；通过后才会进入排行榜。</p></div></div>{feedback && <p className="form-error">{feedback}</p>}{review.length === 0 ? <p className="empty-state">目前没有待复核的成绩。</p> : <ul className="history-list">{review.map((entry) => <li key={entry.id}><span><strong>{entry.nickname} · {languageNames[entry.language]} {difficultyNames[entry.difficulty]}</strong><small>{entry.duration}秒 · {entry.speed} · 准确率 {entry.accuracy}%</small></span><span className="review-actions"><button className="text-button" onClick={() => void reviewAction(entry.id, 'approve')}>通过</button><button className="text-button" onClick={() => void reviewAction(entry.id, 'reject')}>拒绝</button></span></li>)}</ul>}</section>}
      </div>
      <img className="sleeping-cat" src="/assets/sleeping-cat.png" alt="" aria-hidden="true" />
    </main>
    {showAuth && <AuthDialog onClose={() => setShowAuth(false)} onLogin={setUser} />}
    {showResult && result && <Dialog title="练习完成！" onClose={() => setShowResult(false)}>
      <p className="dialog-intro">{result.offline ? '这次是本地练习，成绩已保存在当前浏览器。' : '每一次练习，都是向前的一小步。'}</p>
      <div className="result-metrics"><div><strong>{language === 'zh' ? result.score.cpm : result.score.wpm}</strong><span>{language === 'zh' ? '字 / 分钟' : 'WPM'}</span></div><div><strong>{result.score.accuracy}%</strong><span>准确率</span></div><div><strong>{result.score.correct}</strong><span>正确字符</span></div></div>
      {!result.offline && result.eligible && !rankMessage && <div className="rank-submit">{!user && <label>上榜昵称<input value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} placeholder="给自己取个昵称" /></label>}<button className="primary-button" disabled={busy || (!user && !nickname.trim())} onClick={() => void submitRank()}><Trophy size={20} /> {busy ? '提交中…' : '提交到排行榜'}</button></div>}
      {rankMessage && <p className="form-notice"><CheckCircle size={18} /> {rankMessage}</p>}
      <div className="result-actions"><button className="outline-button" onClick={() => { setShowResult(false); resetPractice(); }}>再练一次</button><button className="text-button" onClick={() => { setShowResult(false); navigate('rankings'); }}>查看排行榜</button></div>
    </Dialog>}
  </div>;
}
