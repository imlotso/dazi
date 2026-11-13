import { useState } from 'react';
import { Archive } from '@phosphor-icons/react/Archive';
import { Trash } from '@phosphor-icons/react/Trash';
import type { SavedPractice } from '../lib/models';
import { splitCharacters } from '../lib/scoring';
import { Dialog } from './Dialog';

type Props = {
  drafts: SavedPractice[];
  onResume: (draft: SavedPractice) => void;
  onDelete: (id: string) => void;
  recovery?: { id: string; title: string; savedAt?: number; recover: () => void }[];
};

export function DraftsView({ drafts, onResume, onDelete, recovery = [] }: Props) {
  const [deleting, setDeleting] = useState<SavedPractice>();
  return <section className="content-panel drafts feature-panel">
    <div className="content-heading"><h1><Archive size={25} aria-hidden="true" /> 练习草稿</h1></div>
    {!!recovery.length && <ul className="feature-list" aria-label="待恢复成绩">{recovery.map((entry) => <li className="feature-row" key={entry.id}>
      <div className="feature-row-main">
        <h2>{entry.title}</h2>
        {entry.savedAt != null && <div className="feature-meta"><time dateTime={new Date(entry.savedAt).toISOString()}>{new Date(entry.savedAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</time></div>}
      </div>
      <button className="outline-button feature-action-button" aria-label={`恢复《${entry.title}》成绩`} onClick={entry.recover}>恢复成绩</button>
    </li>)}</ul>}
    {!drafts.length && !recovery.length ? <p className="empty-state">暂无草稿</p> : !!drafts.length && <ul className="feature-list">
      {[...drafts].sort((a, b) => b.savedAt - a.savedAt).map((draft) => {
        const total = splitCharacters(draft.article.text).length;
        const entered = splitCharacters(draft.typed).length;
        const savedAt = new Date(draft.savedAt);
        return <li key={draft.id} className="feature-row">
          <div className="feature-row-main">
            <h2>{draft.article.title}</h2>
            <div className="feature-meta">
              <span>{draft.article.language === 'zh' ? '中文' : 'English'}</span>
              <time dateTime={savedAt.toISOString()}>{savedAt.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</time>
              <span>{entered.toLocaleString()} / {total.toLocaleString()} 字符</span>
            </div>
            <progress className="feature-progress" aria-label={`《${draft.article.title}》进度`} max={total || 1} value={entered} />
          </div>
          <div className="feature-actions">
            <button className="icon-button" aria-label={`删除《${draft.article.title}》`} onClick={() => setDeleting(draft)}><Trash size={19} aria-hidden="true" /></button>
            <button className="outline-button feature-action-button" aria-label={`继续《${draft.article.title}》`} onClick={() => onResume(draft)}>继续</button>
          </div>
        </li>;
      })}
    </ul>}
    {deleting && <Dialog title={`删除《${deleting.article.title}》草稿？`} onClose={() => setDeleting(undefined)}>
      <div className="feature-form">
        <p className="feature-muted">未完成的进度将被删除。</p>
        <div className="feature-actions">
          <button className="outline-button" onClick={() => setDeleting(undefined)}>取消</button>
          <button className="primary-button" onClick={() => { onDelete(deleting.id); setDeleting(undefined); }}>删除</button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
