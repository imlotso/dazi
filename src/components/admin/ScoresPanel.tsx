import { useState } from 'react';
import type { Difficulty, Language } from '../../data/articles';
import type { PracticeMode } from '../../lib/models';
import { Dialog } from '../Dialog';
import {
  adminWrite, ConfirmationForm, DateTime, difficulties, languages, LoadState, Pagination, QueryField, reasonLabels,
  ScrollList, SelectField, useAdminList, type AdminProps, type Confirmation,
} from './common';

type ScoreRow = {
  id: string; nickname: string; language: Language; difficulty: Difficulty;
  articleId: string | null; articleTitle: string | null; status: keyof typeof statuses; duration: number; mode: PracticeMode;
  strict: boolean; speed: number; accuracy: number; checkpoints: number; reasons: string[]; finishedAt: number;
};
const statuses = { pending: '待审核', published: '已发布', rejected: '已拒绝', removed: '已下架' };
const actions = { approve: '通过', reject: '拒绝', remove: '下架' };
type Action = keyof typeof actions;

function permitted(status: string): Action[] {
  if (status === 'pending') return ['approve', 'reject'];
  return status === 'published' ? ['remove'] : [];
}

export function ScoresPanel({ ownerId }: AdminProps) {
  const list = useAdminList<ScoreRow>(ownerId, '/scores', { status: 'pending' });
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const rows = list.data?.entries ?? [];
  const batch = permitted(list.filters.status);
  const visibleIds = rows.map(({ id }) => id);
  const selected = selection?.key === list.identity ? selection.ids.filter((id) => visibleIds.includes(id)) : [];
  const allSelected = rows.length > 0 && selected.length === rows.length;

  function updateSelection(ids: string[]) {
    setSelection({ key: list.identity, ids });
  }

  function filter(key: string, value: string) {
    setSelection(undefined);
    list.filter(key, value);
  }

  function changePage(page: number) {
    setSelection(undefined);
    list.setPage(page);
  }

  function moderate(action: Action, ids: string[], target: string) {
    const name = actions[action];
    setConfirmation({
      title: `${name}成绩`, action: name, target,
      submit: (reason) => adminWrite(ownerId, '/scores/moderate', { ids, action, reason }),
    });
  }

  return <>
    <div className="admin-filters feature-filters">
      <QueryField label="昵称或文章" onSearch={(value) => filter('q', value)} />
      <SelectField label="成绩状态" options={Object.entries(statuses)} value={list.filters.status} onChange={(value) => filter('status', value)} />
      <SelectField label="语言" options={Object.entries(languages)} all value={list.filters.language ?? ''} onChange={(value) => filter('language', value)} />
      <SelectField label="难度" options={Object.entries(difficulties)} all value={list.filters.difficulty ?? ''} onChange={(value) => filter('difficulty', value)} />
    </div>
    {!list.data ? <LoadState error={list.error} retry={list.retry} /> : <>
      {!!rows.length && !!batch.length && <div className="admin-bulk">
        <label><input type="checkbox" checked={allSelected} ref={(input) => { if (input) input.indeterminate = selected.length > 0 && !allSelected; }}
          onChange={(event) => updateSelection(event.target.checked ? visibleIds : [])} />全选本页</label>
        <span className="feature-muted">已选 {selected.length} 项</span>
        <div className="feature-actions">{batch.map((action) => <button key={action} className="outline-button feature-action-button"
          disabled={!selected.length} onClick={() => moderate(action, selected, `${selected.length} 条成绩`)}>{actions[action]}所选</button>)}</div>
      </div>}
      {rows.length ? <ScrollList label="成绩列表">{rows.map((score) => <li className="feature-row admin-score-row" key={score.id}>
        {!!batch.length && <input type="checkbox" className="admin-row-checkbox" aria-label={`选择 ${score.nickname}`} checked={selected.includes(score.id)}
          onChange={(event) => updateSelection(event.target.checked ? [...selected, score.id] : selected.filter((id) => id !== score.id))} />}
        <div className="feature-row-main">
          <h3>{score.nickname}</h3>
          <div className="feature-meta">
            {score.articleTitle && <span>{score.articleTitle}</span>}
            <span>{languages[score.language]} · {difficulties[score.difficulty]}</span>
            <span>{score.mode === 'article' ? '整篇' : `${score.duration / 60} 分钟`}{score.strict ? ' · 严格纠错' : ''}</span>
            <DateTime value={score.finishedAt} />
          </div>
          <div className="feature-meta">
            <span className="admin-score-metric">{score.speed} {score.language === 'zh' ? '字/分' : 'WPM'}</span>
            <span>准确率 {score.accuracy}%</span><span>进度记录 {score.checkpoints} 次</span>
          </div>
          {!!score.reasons.length && <p className="admin-reason feature-muted">{score.reasons.map((reason) => reasonLabels[reason] ?? reason).join('、')}</p>}
        </div>
        <div className="feature-actions">{permitted(score.status).map((action) => <button key={action} className="outline-button feature-action-button"
          onClick={() => moderate(action, [score.id], score.nickname)}>{actions[action]}</button>)}</div>
      </li>)}</ScrollList> : <p className="admin-load-state feature-muted">暂无匹配成绩</p>}
      <Pagination data={list.data} setPage={changePage} />
    </>}
    {confirmation && <Dialog title={confirmation.title} onClose={() => setConfirmation(undefined)} dismissible={!busy}>
      <ConfirmationForm confirmation={confirmation} busy={busy} setBusy={setBusy}
        onCancel={() => setConfirmation(undefined)} onSuccess={() => { setConfirmation(undefined); setSelection(undefined); list.refresh(); }} />
    </Dialog>}
  </>;
}
