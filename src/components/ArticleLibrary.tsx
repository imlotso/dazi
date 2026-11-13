import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Books } from '@phosphor-icons/react/Books';
import { FileText } from '@phosphor-icons/react/FileText';
import { PencilSimple } from '@phosphor-icons/react/PencilSimple';
import { Plus } from '@phosphor-icons/react/Plus';
import { Star } from '@phosphor-icons/react/Star';
import { Trash } from '@phosphor-icons/react/Trash';
import type { Difficulty, Language } from '../data/articles';
import { articleLength, MAX_PRIVATE_BYTES, MAX_PRIVATE_CHARACTERS } from '../lib/analysis';
import type { ArticleSnapshot, PrivateArticle } from '../lib/models';
import { splitCharacters } from '../lib/scoring';
import { Dialog } from './Dialog';

type Props = {
  articles: ArticleSnapshot[];
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  onSelect: (article: ArticleSnapshot) => void;
  onSave: (article: PrivateArticle) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
};

const difficultyNames: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };
const libraryTabs = { all: '全部', favorites: '收藏', private: '我的文章' } as const;
const lengthRanges = [
  { min: 0, max: 999, label: '少于 1,000' },
  { min: 1000, max: 1999, label: '1,000–1,999' },
  { min: 2000, max: Infinity, label: '2,000 以上' },
];

const emotionsOf = (article: ArticleSnapshot) => article.theme?.split(/[与、]/u).map((part) => part.trim()).filter(Boolean) ?? [];
const normalizeText = (value: string) => value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').normalize('NFC');

function validateText(text: string) {
  if (!text.trim()) return '请输入正文';
  if (text.length > MAX_PRIVATE_CHARACTERS) return '正文不能超过 20,000 字符';
  if (new TextEncoder().encode(text).length > MAX_PRIVATE_BYTES) return '正文不能超过 100 KB';
  return '';
}

function privateArticleId() {
  if (typeof crypto.randomUUID === 'function') return `my-${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `my-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readTxt(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(reader.result as ArrayBuffer)); }
      catch { reject(new Error('TXT 编码须为 UTF-8')); }
    };
    reader.onerror = () => reject(new Error('无法读取 TXT'));
    reader.readAsArrayBuffer(file);
  });
}

function ArticleEditor({ article, initialLanguage, onSave, onClose }: {
  article: PrivateArticle | null;
  initialLanguage: Language;
  onSave: (article: PrivateArticle) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(article?.title ?? '');
  const [language, setLanguage] = useState(article?.language ?? initialLanguage);
  const [difficulty, setDifficulty] = useState<Difficulty>(article?.difficulty ?? 'beginner');
  const [body, setBody] = useState(article?.text ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function importTxt(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.txt$/iu.test(file.name)) { setError('请选择 TXT 文件'); return; }
    if (file.size > MAX_PRIVATE_BYTES) { setError('TXT 文件不能超过 100 KB'); return; }
    setBusy(true);
    setError('');
    try {
      const text = normalizeText(await readTxt(file));
      const invalid = validateText(text);
      if (invalid) { setError(invalid); return; }
      setBody(text);
      setTitle((current) => current.trim() ? current : file.name.replace(/\.txt$/iu, '').slice(0, 200));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取 TXT');
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanTitle = title.trim();
    const text = normalizeText(body);
    const invalid = cleanTitle ? validateText(text) : '请输入标题';
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError('');
    try {
      const id = article?.id ?? privateArticleId();
      await onSave({ ...article, id, title: cleanTitle, language, difficulty, text, custom: true });
    } catch {
      setError('保存失败');
      setBusy(false);
    }
  }

  return <Dialog title={article ? '编辑文章' : '新建文章'} onClose={() => { if (!busy) onClose(); }}>
    <form className="feature-form" onSubmit={submit}>
      <label>标题<input value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <div className="feature-form-pair">
        <label>语言<select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as Language)}><option value="zh">中文</option><option value="en">English</option></select></label>
        <label>难度<select value={difficulty} disabled={busy} onChange={(event) => setDifficulty(event.target.value as Difficulty)}>{Object.entries(difficultyNames).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
      </div>
      <label>正文<textarea value={body} rows={7} disabled={busy} onChange={(event) => setBody(event.target.value)} /></label>
      <span className="feature-muted feature-editor-count">{splitCharacters(body.slice(0, MAX_PRIVATE_CHARACTERS + 1)).length.toLocaleString()} 字符</span>
      <label className="feature-file"><span><FileText size={16} /> 导入 TXT</span><input type="file" accept=".txt,text/plain" disabled={busy} onChange={(event) => void importTxt(event)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="feature-actions">
        <button type="button" className="outline-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={busy}>保存</button>
      </div>
    </form>
  </Dialog>;
}

export function ArticleLibrary({ articles, favorites, onToggleFavorite, onSelect, onSave, onDelete }: Props) {
  const [language, setLanguage] = useState<Language>('zh');
  const [tab, setTab] = useState<keyof typeof libraryTabs>('all');
  const [search, setSearch] = useState('');
  const [emotion, setEmotion] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [length, setLength] = useState('');
  const [editor, setEditor] = useState<PrivateArticle | null>();
  const [deleting, setDeleting] = useState<ArticleSnapshot>();
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const catalog = useMemo(() => articles.map((article) => ({ article, size: articleLength(article), emotions: emotionsOf(article) })), [articles]);
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const collection = catalog.filter(({ article }) => article.language === language);
  const themes = [...new Set(collection.flatMap(({ emotions }) => emotions))];
  const query = search.trim().toLocaleLowerCase();
  const range = length ? lengthRanges[Number(length)] : undefined;
  const matches = collection.filter(({ article, emotions, size }) =>
    (tab !== 'private' || article.custom) &&
    (tab !== 'favorites' || favoriteIds.has(article.id)) &&
    (!query || [article.title, article.author, article.theme].some((value) => value?.toLocaleLowerCase().includes(query))) &&
    (!emotion || emotions.includes(emotion)) &&
    (!difficulty || article.difficulty === difficulty) &&
    (!range || (size >= range.min && size <= range.max)));

  async function saveArticle(article: PrivateArticle) {
    await onSave(article);
    setEditor(undefined);
    setTab('private');
    setLanguage(article.language);
    setSearch('');
    setEmotion('');
    setDifficulty('');
    setLength('');
  }

  async function deleteArticle() {
    if (!deleting || deletePending) return;
    setDeletePending(true);
    setDeleteError(false);
    try {
      await onDelete(deleting.id);
      setDeleting(undefined);
    } catch {
      setDeleteError(true);
    } finally {
      setDeletePending(false);
    }
  }

  return <section className="content-panel library feature-panel">
    <div className="content-heading">
      <h1><Books size={25} aria-hidden="true" /> 文章库</h1>
      <button className="outline-button feature-action-button" onClick={() => setEditor(null)}><Plus size={16} aria-hidden="true" /> 新建文章</button>
    </div>
    <div className="feature-toolbar">
      <div className="segmented feature-segments" role="group" aria-label="文章语言">
        <button aria-pressed={language === 'zh'} onClick={() => { setLanguage('zh'); setEmotion(''); }}>中文</button>
        <button aria-pressed={language === 'en'} onClick={() => { setLanguage('en'); setEmotion(''); }}>English</button>
      </div>
      <div className="segmented feature-segments" role="group" aria-label="文章分类">
        {Object.entries(libraryTabs).map(([key, name]) => <button key={key} aria-pressed={tab === key} onClick={() => setTab(key as keyof typeof libraryTabs)}>{name}</button>)}
      </div>
    </div>
    <div className="feature-filters">
      <label>搜索<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>情绪<select value={emotion} onChange={(event) => setEmotion(event.target.value)}><option value="">全部</option>{themes.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>难度<select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="">全部</option>{Object.entries(difficultyNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>篇幅<select value={length} onChange={(event) => setLength(event.target.value)}><option value="">全部</option>{lengthRanges.map(({ label }, index) => <option key={label} value={index}>{label}</option>)}</select></label>
    </div>
    {!matches.length ? <p className="empty-state">暂无匹配文章</p> : <ul className="feature-list">
      {matches.map(({ article, size }) => <li key={article.id} className="feature-row">
        <div className="feature-row-main">
          <h2>{article.title}</h2>
          <div className="feature-meta">
            {article.author && <span>{article.author}</span>}
            {article.theme && <span>{article.theme}</span>}
            <span>{difficultyNames[article.difficulty]}</span>
            <span>{size.toLocaleString()} {language === 'zh' ? '字' : '词'}</span>
            {article.source && /^https?:\/\//iu.test(article.source.url) && <a href={article.source.url} target="_blank" rel="noreferrer" aria-label={`查看《${article.title}》原文`}>原文</a>}
          </div>
        </div>
        <div className="feature-actions">
          <button className="icon-button feature-star" aria-label={`收藏《${article.title}》`} aria-pressed={favoriteIds.has(article.id)} onClick={() => onToggleFavorite(article.id)}><Star size={19} weight={favoriteIds.has(article.id) ? 'fill' : 'regular'} aria-hidden="true" /></button>
          {article.custom && <>
            <button className="icon-button" aria-label={`编辑《${article.title}》`} onClick={() => setEditor({ ...article, custom: true })}><PencilSimple size={19} aria-hidden="true" /></button>
            <button className="icon-button" aria-label={`删除《${article.title}》`} onClick={() => { setDeleting(article); setDeleteError(false); }}><Trash size={19} aria-hidden="true" /></button>
          </>}
          <button className="outline-button feature-action-button" aria-label={`练习《${article.title}》`} onClick={() => onSelect(article)}>练习</button>
        </div>
      </li>)}
    </ul>}
    {editor !== undefined && <ArticleEditor article={editor} initialLanguage={language} onSave={saveArticle} onClose={() => setEditor(undefined)} />}
    {deleting && <Dialog title={`删除《${deleting.title}》？`} onClose={() => { if (!deletePending) setDeleting(undefined); }}>
      <div className="feature-form">
        {deleteError && <p className="form-error" role="alert">删除失败</p>}
        <div className="feature-actions">
          <button className="outline-button" disabled={deletePending} onClick={() => setDeleting(undefined)}>取消</button>
          <button className="primary-button" disabled={deletePending} onClick={() => void deleteArticle()}>删除</button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
