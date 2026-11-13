import { useState, type FormEvent } from 'react';
import type { Difficulty, Language } from '../../data/articles';
import { articleLength } from '../../lib/analysis';
import { Dialog } from '../Dialog';
import {
  adminWrite, ConfirmationForm, DateTime, difficulties, languages, LoadState, Pagination, QueryField,
  ScrollList, SelectField, useAdminList, useAdminResource, type AdminProps, type Confirmation,
} from './common';

type ArticleInput = {
  title: string; text: string; language: Language; difficulty: Difficulty; author: string; theme: string;
  source: { name: string; url: string; license: 'public-domain' | 'reusable' };
};
type ArticleRow = Omit<ArticleInput, 'text'> & {
  id: string; status: keyof typeof statuses; revision: number; updatedAt: number; length: number;
};
type ArticleDetail = ArticleRow & { text: string };
const statuses = { draft: '草稿', published: '已发布', archived: '已归档' };
const licenses = { 'public-domain': '公有领域', reusable: '明确授权转载' };
const blank: ArticleInput = {
  title: '', author: '', theme: '', language: 'zh', difficulty: 'beginner', text: '',
  source: { name: '', url: '', license: 'public-domain' },
};

function articleInput(article?: ArticleDetail): ArticleInput {
  if (!article) return blank;
  const { title, text, language, difficulty, author, theme, source } = article;
  return { title, text, language, difficulty, author, theme, source };
}

function ArticleEditor({ ownerId, article, onClose, onChange }: AdminProps & {
  article?: ArticleDetail; onClose: () => void; onChange: () => void;
}) {
  const [input, setInput] = useState(() => articleInput(article));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const finish = () => { onClose(); onChange(); };
  const dirty = JSON.stringify(articleInput(article)) !== JSON.stringify(input);
  const path = article ? `/articles/${encodeURIComponent(article.id)}` : '/articles';
  const length = articleLength(input);
  const published = article?.status === 'published';
  const publishable = length >= 1000 && !!input.author.trim() && !!input.theme.trim() && !!input.source.name.trim() && !!input.source.url.trim();
  const textUnit = input.language === 'zh' ? '个汉字' : '词';

  function setField<K extends keyof ArticleInput>(field: K, value: ArticleInput[K]) {
    setInput((previous) => ({ ...previous, [field]: value }));
  }

  function setSource<K extends keyof ArticleInput['source']>(field: K, value: ArticleInput['source'][K]) {
    setInput((previous) => ({ ...previous, source: { ...previous.source, [field]: value } }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!input.title.trim()) { setError('请输入标题'); return; }
    if (published && !publishable) { setError(`已发布文章须有完整来源，正文至少 1,000 ${textUnit}`); return; }
    setBusy(true);
    setError('');
    try {
      await adminWrite(ownerId, path, article ? { ...input, revision: article.revision } : input);
      finish();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (confirmation) { setConfirmation(undefined); return; }
    if (!dirty) { onClose(); return; }
    setConfirmation({ title: '放弃未保存的修改', action: '放弃', target: '未保存的修改将丢失。', requireReason: false, submit: async () => {} });
  }

  function transition(status: 'published' | 'archived') {
    if (!article || dirty) return;
    if (status === 'published' && !publishable) {
      setError(`请填写作者、主题和来源，正文至少 1,000 ${textUnit}`);
      return;
    }
    setError('');
    const action = status === 'published' ? '发布' : '归档';
    setConfirmation({
      title: `${action}文章`, action, target: article.title, requireReason: status === 'archived',
      submit: (reason) => adminWrite(ownerId, `${path}/status`, { status, revision: article.revision, ...(reason && { reason }) }),
    });
  }

  function remove() {
    if (!article || dirty) return;
    setConfirmation({
      title: '删除文章', action: '删除', target: article.title, note: '删除后无法从后台恢复。',
      submit: (reason) => adminWrite(ownerId, `${path}/delete`, { revision: article.revision, reason }),
    });
  }

  return <Dialog key={confirmation?.title ?? 'editor'} title={confirmation?.title ?? (article ? '编辑文章' : '新建文章')}
    className={confirmation ? '' : 'admin-editor'} onClose={requestClose} dismissible={!busy}>
    {confirmation
      ? <ConfirmationForm confirmation={confirmation} busy={busy} setBusy={setBusy} onCancel={() => setConfirmation(undefined)}
        onSuccess={confirmation.action === '放弃' ? onClose : finish} />
      : <form className="feature-form" onSubmit={save}>
        {article && <div className="feature-meta"><span className="admin-status">{statuses[article.status]}</span><DateTime value={article.updatedAt} /></div>}
        <fieldset className="admin-editor-fields" disabled={busy}>
          <label>标题<input value={input.title} required maxLength={200} onChange={(event) => setField('title', event.target.value)} /></label>
          <div className="feature-form-pair">
            <SelectField label="语言" options={Object.entries(languages)} value={input.language} onChange={(value) => setField('language', value as Language)} />
            <SelectField label="难度" options={Object.entries(difficulties)} value={input.difficulty} onChange={(value) => setField('difficulty', value as Difficulty)} />
          </div>
          <div className="feature-form-pair">
            <label>作者<input value={input.author} required={published} maxLength={300} onChange={(event) => setField('author', event.target.value)} /></label>
            <label>主题<input value={input.theme} required={published} maxLength={300} onChange={(event) => setField('theme', event.target.value)} /></label>
          </div>
          <label>正文<textarea value={input.text} rows={7} maxLength={30000} onChange={(event) => setField('text', event.target.value)} /></label>
          <p className="feature-muted admin-editor-count">{length.toLocaleString('zh-CN')} {textUnit} · 发布至少 1,000</p>
          <div className="feature-form-pair">
            <label>来源名称<input value={input.source.name} required={published} maxLength={300} onChange={(event) => setSource('name', event.target.value)} /></label>
            <SelectField label="授权" options={Object.entries(licenses)} value={input.source.license} onChange={(value) => setSource('license', value as ArticleInput['source']['license'])} />
          </div>
          <label>原文链接<input type="url" value={input.source.url} required={published} maxLength={2048} onChange={(event) => setSource('url', event.target.value)} /></label>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="feature-actions">
          {article && (published
            ? <button className="outline-button" type="button" disabled={busy || dirty} onClick={() => transition('archived')}>归档</button>
            : <>
              <button className="outline-button" type="button" disabled={busy || dirty} onClick={remove}>删除</button>
              <button className="outline-button" type="button" disabled={busy || dirty} onClick={() => transition('published')}>发布</button>
            </>)}
          <button className="primary-button" disabled={busy || !input.title.trim() || (!!article && !dirty)}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>}
  </Dialog>;
}

function LoadedEditor({ ownerId, id, onClose, onChange }: AdminProps & { id: string; onClose: () => void; onChange: () => void }) {
  const { data, error, retry } = useAdminResource<{ article: ArticleDetail }>(ownerId, `/articles/${encodeURIComponent(id)}`);
  if (!data) return <Dialog title="编辑文章" onClose={onClose}><LoadState error={error} retry={retry} /></Dialog>;
  return <ArticleEditor ownerId={ownerId} article={data.article} onClose={onClose} onChange={onChange} />;
}

export function ArticlesPanel({ ownerId, onCatalogChange }: AdminProps & { onCatalogChange: () => void }) {
  const list = useAdminList<ArticleRow>(ownerId, '/articles');
  const [selected, setSelected] = useState<{ id?: string }>();
  const onClose = () => setSelected(undefined);
  const onChange = () => { list.refresh(); onCatalogChange(); };

  return <>
    <div className="admin-panel-actions"><button className="primary-button feature-action-button" onClick={() => setSelected({})}>新建文章</button></div>
    <div className="admin-filters feature-filters">
      <QueryField label="标题或作者" onSearch={(value) => list.filter('q', value)} />
      <SelectField label="文章状态" options={Object.entries(statuses)} all value={list.filters.status ?? ''} onChange={(value) => list.filter('status', value)} />
      <SelectField label="语言" options={Object.entries(languages)} all value={list.filters.language ?? ''} onChange={(value) => list.filter('language', value)} />
      <SelectField label="难度" options={Object.entries(difficulties)} all value={list.filters.difficulty ?? ''} onChange={(value) => list.filter('difficulty', value)} />
    </div>
    {!list.data ? <LoadState error={list.error} retry={list.retry} /> : <>
      {list.data.entries.length ? <ScrollList label="文章列表">{list.data.entries.map((article) => <li className="feature-row" key={article.id}>
        <div className="feature-row-main">
          <h3>{article.title}</h3>
          <div className="feature-meta">
            {article.author && <span>{article.author}</span>}
            <span>{languages[article.language]} · {difficulties[article.difficulty]}</span>
            <span>{article.length.toLocaleString('zh-CN')} {article.language === 'zh' ? '字' : '词'}</span>
            <span className="admin-status">{statuses[article.status]}</span>
          </div>
        </div>
        <button className="outline-button feature-action-button" aria-label={`编辑《${article.title}》`} onClick={() => setSelected({ id: article.id })}>编辑</button>
      </li>)}</ScrollList> : <p className="admin-load-state feature-muted">暂无匹配文章</p>}
      <Pagination data={list.data} setPage={list.setPage} />
    </>}
    {selected && (selected.id
      ? <LoadedEditor ownerId={ownerId} id={selected.id} onClose={onClose} onChange={onChange} />
      : <ArticleEditor ownerId={ownerId} onClose={onClose} onChange={onChange} />)}
  </>;
}
