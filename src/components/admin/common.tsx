import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Difficulty, Language } from '../../data/articles';
import { api } from '../../lib/api';

export type Page<T> = { entries: T[]; page: number; pageSize: number; total: number };
export type Audit = {
  id: number; actorId: string; actorName: string; action: string;
  targetType: 'user' | 'article' | 'score' | 'setting'; targetId: string; targetLabel: string; reason: string | null; createdAt: number;
};
export type AdminProps = { ownerId: string };
export type Option = readonly [string, string];

export const languages: Record<Language, string> = { zh: '中文', en: 'English' };
export const difficulties: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };
export const targets = { user: '用户', article: '文章', score: '成绩', setting: '设置' };
export const reasonLabels: Record<string, string> = {
  paste_or_drop: '粘贴或拖放', unusual_progress: '输入进度异常', missing_activity: '进度记录不足',
  stale_activity: '结束前缺少进度记录', high_speed: '速度较高', paused_session: '曾暂停或恢复',
  timing_discrepancy: '计时差异较大', recovered_session: '恢复中断练习',
};
const actionLabels: Record<string, string> = {
  'user.bootstrap': '初始化管理员', 'user.disable': '停用账号', 'user.enable': '启用账号', 'user.promote': '设为管理员', 'user.demote': '撤销管理员', 'user.revoke_sessions': '退出所有会话',
  'article.create': '新建文章', 'article.update': '编辑文章', 'article.publish': '发布文章',
  'article.archive': '归档文章', 'article.delete': '删除文章',
  'score.approve': '通过成绩', 'score.reject': '拒绝成绩', 'score.remove': '下架成绩',
  'smtp.update': '保存', 'smtp.reset': '恢复默认', 'smtp.verify': '测试连接',
  'settings.site.update': '保存',
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

const compactDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const compactTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function DateTime({ value, compact = false }: { value: number; compact?: boolean }) {
  const dateTime = new Date(value).toISOString();
  return compact
    ? <time dateTime={dateTime} className="admin-compact-time"><span>{compactDate.format(value)}</span>{' '}<span>{compactTime.format(value)}</span></time>
    : <time dateTime={dateTime}>{dateFormat.format(value)}</time>;
}

export function adminWrite<T>(ownerId: string, path: string, body: unknown, timeoutMs?: number) {
  return api<T>(`/api/admin${path}`, { method: 'POST', headers: { 'X-Workspace-Owner': ownerId }, body, timeoutMs });
}

export function useAdminResource<T>(ownerId: string, path: string, revision = 0) {
  const key = JSON.stringify([ownerId, path, revision]);
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<T>(`/api/admin${path}`, { signal: controller.signal, headers: { 'X-Workspace-Owner': ownerId } })
      .then((data) => { if (!controller.signal.aborted) setState({ key, data }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : '加载失败' });
      });
    return () => controller.abort();
  }, [ownerId, path, key, attempt]);

  return {
    ...(state?.key === key ? state : undefined),
    retry: () => { setState(undefined); retry((previous) => previous + 1); },
  };
}

export function useAdminList<T>(ownerId: string, path: string, defaults: Record<string, string> = {}) {
  const [filters, setFilters] = useState(defaults);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const resource = useAdminResource<Page<T>>(ownerId, `${path}?${query}`, revision);
  const last = resource.data ? Math.max(1, Math.ceil(resource.data.total / resource.data.pageSize)) : page;

  useEffect(() => { if (page > last) setPage(last); }, [page, last]);
  return {
    ...resource, filters, page, setPage, identity: `${query}:${revision}`,
    filter: (key: string, value: string) => { setFilters((current) => ({ ...current, [key]: value })); setPage(1); },
    refresh: () => setRevision((current) => current + 1),
  };
}

export function QueryField({ label, onSearch, maxLength = 100 }: { label: string; onSearch: (value: string) => void; maxLength?: number }) {
  const [value, setValue] = useState('');
  return <form className="admin-query feature-form" onSubmit={(event) => { event.preventDefault(); onSearch(value.trim()); }}>
    <label>{label}<input type="search" value={value} maxLength={maxLength} onChange={(event) => {
      const next = event.target.value;
      setValue(next);
      if (!next) onSearch('');
    }} /></label>
    <button className="outline-button feature-action-button">搜索</button>
  </form>;
}

export function SelectField({ label, options, value, onChange, all = false }: {
  label: string; options: readonly Option[]; value: string; onChange: (value: string) => void; all?: boolean;
}) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    {all && <option value="">全部</option>}
    {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
  </select></label>;
}

export function LoadState({ error, retry }: { error?: string; retry: () => void }) {
  return error
    ? <div className="admin-load-state"><p className="form-error" role="alert">{error}</p><button className="outline-button feature-action-button" onClick={retry}>重试</button></div>
    : <p className="admin-load-state feature-muted" role="status">加载中…</p>;
}

export function Pagination({ data, setPage }: { data: Page<unknown>; setPage: (page: number) => void }) {
  const last = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (data.total === 0) return null;
  return <nav className="admin-pagination" aria-label="列表分页">
    <button className="outline-button feature-action-button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</button>
    <span className="feature-muted">{data.page} / {last} 页 · {data.total} 项</span>
    <button className="outline-button feature-action-button" disabled={data.page >= last} onClick={() => setPage(data.page + 1)}>下一页</button>
  </nav>;
}

export function ScrollList({ label, ordered, children }: { label: string; ordered?: boolean; children: ReactNode }) {
  const List = ordered ? 'ol' : 'ul';
  return <div className="admin-list-scroll" role="region" aria-label={label} tabIndex={0}>
    <List className="feature-list">{children}</List>
  </div>;
}

export function AuditRows({ entries, label }: { entries: Audit[]; label: string }) {
  if (!entries.length) return <p className="admin-load-state feature-muted">暂无操作记录</p>;
  return <ScrollList label={label} ordered>{entries.map((entry) => <li className="feature-row" key={entry.id}>
    <div className="feature-row-main">
      <h3>{actionLabels[entry.action] ?? entry.action} · {entry.targetLabel}</h3>
      <div className="feature-meta"><span>{entry.actorName}</span><DateTime value={entry.createdAt} /></div>
      {entry.reason && <p className="admin-reason feature-muted">{entry.reason}</p>}
    </div>
  </li>)}</ScrollList>;
}

export type Confirmation = {
  title: string; action: string; target: string; requireReason?: boolean; note?: string;
  submit: (reason: string) => Promise<unknown>;
};

export function ConfirmationForm({ confirmation, busy, setBusy, onCancel, onSuccess }: {
  confirmation: Confirmation; busy: boolean; setBusy: (busy: boolean) => void; onCancel: () => void; onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => (first.current ?? cancel.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const needsReason = confirmation.requireReason !== false;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (needsReason && !reason.trim())) return;
    setBusy(true);
    setError('');
    try {
      await confirmation.submit(reason.trim());
      onSuccess();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  }

  return <form className="feature-form" onSubmit={submit}>
    <p className="admin-confirm-target">{confirmation.target}</p>
    {confirmation.note && <p className="feature-muted">{confirmation.note}</p>}
    {needsReason && <label>原因<input maxLength={300} required value={reason} ref={first}
      disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="feature-actions">
      <button type="button" className="outline-button" ref={cancel} disabled={busy} onClick={onCancel}>取消</button>
      <button className="primary-button" disabled={busy || (needsReason && !reason.trim())}>{busy ? '处理中…' : `确认${confirmation.action}`}</button>
    </div>
  </form>;
}

export function Metrics({ entries }: { entries: [string, ReactNode][] }) {
  return <dl className="admin-metrics">{entries.map(([label, value]) => <div key={label}>
    <dt>{label}</dt><dd>{typeof value === 'number' ? value.toLocaleString('zh-CN') : value}</dd>
  </div>)}</dl>;
}
