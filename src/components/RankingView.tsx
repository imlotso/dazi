import { useEffect, useState } from 'react';
import { Crown } from '@phosphor-icons/react/Crown';
import { Trophy } from '@phosphor-icons/react/Trophy';
import type { Difficulty, Language } from '../data/articles';
import { api } from '../lib/api';
import type { ArticleSnapshot, PracticeMode, RankingEntry } from '../lib/models';

type Board = { entries: RankingEntry[]; self?: RankingEntry | null; total?: number };
type Filters = { language: Language; difficulty: Difficulty; duration: number; mode: PracticeMode; strict: boolean };
type Props = {
  initial: Filters;
  articles: ArticleSnapshot[];
  isAdmin: boolean;
  ownerId: string | null;
};

const difficulties: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };

export function RankingView({ initial, articles, isAdmin, ownerId }: Props) {
  const [language, setLanguage] = useState(initial.language);
  const [difficulty, setDifficulty] = useState(initial.difficulty);
  const [minutes, setMinutes] = useState(String(initial.duration / 60 || 5));
  const [mode, setMode] = useState(initial.mode);
  const [strict, setStrict] = useState(initial.strict);
  const [period, setPeriod] = useState('all');
  const [articleId, setArticleId] = useState('');
  const [revision, setRevision] = useState(0);
  const [board, setBoard] = useState<{ query: string; data: Board }>();
  const [failure, setFailure] = useState<{ query: string; message: string }>();
  const [removing, setRemoving] = useState<string>();
  const validMinutes = /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 60;
  const query = new URLSearchParams({ language, difficulty, duration: String(mode === 'article' ? 300 : Number(minutes) * 60), mode, strict: String(strict), period });
  if (articleId) query.set('articleId', articleId);
  const request = mode === 'timed' && !validMinutes ? '' : query.toString();
  const identity = `${revision}:${request}`;

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setFailure(undefined);
    api<Board>(`/api/leaderboard?${request}`, { signal: controller.signal, headers: ownerId ? { 'X-Workspace-Owner': ownerId } : undefined }).then((data) => {
      if (!controller.signal.aborted) setBoard({ query: identity, data });
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure({ query: identity, message: (error as Error).message });
    });
    return () => controller.abort();
  }, [request, identity, ownerId]);

  async function removeScore(id: string) {
    setRemoving(id);
    try {
      await api(`/api/admin/remove/${id}`, { method: 'POST', body: {} });
      setRevision((value) => value + 1);
    } catch (error) {
      setFailure({ query: identity, message: (error as Error).message });
    } finally { setRemoving(undefined); }
  }

  const data = board?.query === identity ? board.data : undefined;
  const error = failure?.query === identity ? failure.message : '';
  const unit = language === 'zh' ? '字/分' : 'WPM';

  return <section className="content-panel feature-panel rankings">
    <div className="content-heading"><h1><Trophy size={25} aria-hidden="true" /> 排行榜</h1>{!!data?.total && <span className="count-chip">{data.total} 名</span>}</div>
    <div className="feature-toolbar">
      <div className="segmented feature-segments" role="group" aria-label="排行语言">
        <button aria-pressed={language === 'zh'} onClick={() => { setLanguage('zh'); setArticleId(''); }}>中文</button>
        <button aria-pressed={language === 'en'} onClick={() => { setLanguage('en'); setArticleId(''); }}>English</button>
      </div>
      <label className="ranking-strict"><input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />严格纠错</label>
    </div>
    <div className="feature-filters ranking-filters">
      <label>难度<select value={difficulty} onChange={(event) => { setDifficulty(event.target.value as Difficulty); setArticleId(''); }}>{Object.entries(difficulties).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>排行时段<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">全部</option><option value="week">近 7 天</option><option value="month">近 30 天</option></select></label>
      <label>练习模式<select value={mode} onChange={(event) => setMode(event.target.value as PracticeMode)}><option value="timed">限时</option><option value="article">整篇</option></select></label>
      {mode === 'timed' && <label>限时（分钟）<input type="number" min={1} max={60} step={1} aria-invalid={!validMinutes} value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label>}
      <label>文章<select value={articleId} onChange={(event) => setArticleId(event.target.value)}><option value="">全部</option>{articles.filter((article) => article.language === language && article.difficulty === difficulty).map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select></label>
    </div>
    {!request && <p className="form-error" role="alert">请输入 1–60 的整数</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!!request && !data && !error && <p className="empty-state" role="status">加载中…</p>}
    {data?.self && <p className="ranking-self"><strong>我的排名</strong> 第 {data.self.rank} 名 <span>{data.self.speed} {unit} · {data.self.accuracy}%</span></p>}
    {data && !data.entries.length && <p className="empty-state">暂无成绩</p>}
    {!!data?.entries.length && <ol className="ranking-list">{data.entries.map((entry, index) => {
      const rank = entry.rank ?? index + 1;
      return <li key={entry.attemptId ?? index} className={entry.mine ? 'rank-mine' : undefined}>
        <span className={`rank-number rank-${rank}`} aria-label={`第 ${rank} 名`}>{rank <= 3 ? <Crown size={21} weight="fill" aria-hidden="true" /> : rank}</span>
        <span className="rank-name">{entry.nickname} {entry.guest ? <small>游客</small> : null}</span>
        <span className="rank-accuracy">准确率 {entry.accuracy}%</span>
        <strong>{entry.speed} <small>{unit}</small></strong>
        {isAdmin && <button className="text-button" disabled={!!removing} onClick={() => void removeScore(entry.attemptId)}>下架</button>}
      </li>;
    })}</ol>}
  </section>;
}
