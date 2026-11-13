import { useState } from 'react';
import { ShieldCheck } from '@phosphor-icons/react/ShieldCheck';
import { ArticlesPanel } from './admin/ArticlesPanel';
import { ScoresPanel } from './admin/ScoresPanel';
import { UsersPanel } from './admin/UsersPanel';
import {
  AuditRows, LoadState, Metrics, Pagination, QueryField, SelectField, targets, useAdminList, useAdminResource,
  type AdminProps, type Audit,
} from './admin/common';
import '../admin.css';

const tabs = [
  ['overview', '概览'], ['users', '用户'], ['articles', '文章'], ['scores', '成绩'], ['audit', '操作日志'],
] as const;
type Tab = typeof tabs[number][0];
const labels = {
  users: '注册账号', disabledUsers: '已停用账号', admins: '在任管理员', activeUsers7d: '近 7 天练习账号',
  finishedPractices7d: '近 7 天在线练习', pendingScores: '待审核成绩', publishedScores: '已发布成绩', publishedArticles: '已发布文章',
};
type Overview = { metrics: Record<keyof typeof labels, number>; recentActions: Audit[] };

function OverviewPanel({ ownerId }: AdminProps) {
  const { data, error, retry } = useAdminResource<Overview>(ownerId, '/overview');
  if (!data) return <LoadState error={error} retry={retry} />;
  return <>
    <Metrics entries={(Object.keys(labels) as (keyof typeof labels)[]).map((key) => [labels[key], data.metrics[key]])} />
    <h2 className="admin-section-heading">最近操作</h2>
    <AuditRows entries={data.recentActions} label="最近操作列表" />
  </>;
}

function AuditPanel({ ownerId }: AdminProps) {
  const list = useAdminList<Audit>(ownerId, '/audit');
  return <>
    <div className="admin-filters feature-filters">
      <QueryField label="管理员、对象或原因" onSearch={(value) => list.filter('q', value)} />
      <SelectField label="对象类型" options={Object.entries(targets)} all value={list.filters.targetType ?? ''} onChange={(value) => list.filter('targetType', value)} />
    </div>
    {!list.data ? <LoadState error={list.error} retry={list.retry} /> : <>
      <AuditRows entries={list.data.entries} label="操作日志列表" />
      <Pagination data={list.data} setPage={list.setPage} />
    </>}
  </>;
}

export function AdminConsole({ ownerId, onCatalogChange }: AdminProps & { onCatalogChange: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  return <section className="content-panel feature-panel admin-console">
    <div className="content-heading"><h1><ShieldCheck size={25} aria-hidden="true" />管理后台</h1></div>
    <nav className="admin-navigation" aria-label="后台栏目">
      {tabs.map(([value, label]) => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{label}</button>)}
    </nav>
    <div className="admin-panel" key={ownerId}>
      {tab === 'overview' && <OverviewPanel ownerId={ownerId} />}
      {tab === 'users' && <UsersPanel ownerId={ownerId} />}
      {tab === 'articles' && <ArticlesPanel ownerId={ownerId} onCatalogChange={onCatalogChange} />}
      {tab === 'scores' && <ScoresPanel ownerId={ownerId} />}
      {tab === 'audit' && <AuditPanel ownerId={ownerId} />}
    </div>
  </section>;
}
