import { useState } from 'react';
import { Clock } from '@phosphor-icons/react/Clock';
import type { Difficulty, Language } from '../data/articles';
import { recordMistakes } from '../lib/analysis';
import type { ArticleSnapshot, PracticeRecord } from '../lib/models';
import { readableCharacter } from '../lib/practice-lines';
import { splitCharacters } from '../lib/scoring';
import { Dialog } from './Dialog';

type Props = {
  records: PracticeRecord[];
  onReplay: (article: ArticleSnapshot) => void;
  onContinue: (record: PracticeRecord) => void;
};

const difficultyNames: Record<Difficulty, string> = { beginner: '入门', intermediate: '进阶', advanced: '挑战' };
const languageNames: Record<Language, string> = { zh: '中文', en: 'English' };
const recordTitle = (record: PracticeRecord) => record.article?.title ?? `${languageNames[record.language]} · ${difficultyNames[record.difficulty]}`;
const statusLabel = (status?: string) => status === 'rejected' ? '复核未通过' : status === 'review' ? '待复核' : '';
const speedLabel = (record: PracticeRecord) => `${record.speed} ${record.language === 'zh' ? '字/分' : 'WPM'}`;
const dateText = (date: Date) => date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function RecordDetail({ record, onClose, onReplay, onContinue }: {
  record: PracticeRecord;
  onClose: () => void;
  onReplay: Props['onReplay'];
  onContinue: Props['onContinue'];
}) {
  const article = record.article;
  const target = splitCharacters(article?.text ?? '');
  const typed = record.typed == null ? undefined : splitCharacters(record.typed);
  const articleTotal = article ? target.length : record.articleTotal;
  const offset = record.offset ?? 0;
  const roundCount = record.total ?? (typed ? Math.max(0, typed.length - offset) : undefined);
  const entered = typed?.length ?? (roundCount == null ? undefined : offset + roundCount);
  const mistakes = recordMistakes(record, target);
  const canContinue = !!article && !!typed && (typed.length < target.length ||
    (record.strict && typed.some((character, index) => character !== target[index])));
  const date = new Date(record.finishedAt);

  return <Dialog title="练习详情" onClose={onClose}>
    <div className="feature-form record-detail">
      <div>
        <h3>{recordTitle(record)}</h3>
        <div className="feature-meta">
          {article?.author && <span>{article.author}</span>}
          <time dateTime={date.toISOString()}>{dateText(date)}</time>
          <span>{record.mode === 'article' ? '整篇' : `限时 ${record.duration / 60} 分钟`}</span>
          {record.strict && <span>严格纠错</span>}
          {statusLabel(record.status) && <span>{statusLabel(record.status)}</span>}
        </div>
      </div>
      <dl className="feature-metrics">
        <div><dt>速度</dt><dd>{speedLabel(record)}</dd></div>
        <div><dt>准确率</dt><dd>{record.accuracy}%</dd></div>
        {record.elapsedMs != null && <div><dt>练习用时</dt><dd>{Math.round(record.elapsedMs / 1000)} 秒</dd></div>}
        {roundCount != null && <div><dt>本轮输入</dt><dd>{roundCount} 字符</dd></div>}
        {record.correct != null && <div><dt>本轮正确</dt><dd>{record.correct} 字符</dd></div>}
        {entered != null && articleTotal != null && <div><dt>整篇进度</dt><dd>{entered.toLocaleString()} / {articleTotal.toLocaleString()}</dd></div>}
        {record.errors != null && <div><dt>错误</dt><dd>{record.errors}</dd></div>}
        {record.backspaces != null && <div><dt>退格</dt><dd>{record.backspaces}</dd></div>}
      </dl>
      {!!mistakes.length && <details className="feature-details" open>
        <summary>误输记录 · {mistakes.length}</summary>
        <ol className="feature-scroll">
          {mistakes.map((mistake, index) => <li key={index}>
            <span>第 {mistake.position + 1} 字符</span><strong>{readableCharacter(mistake.expected)}</strong><del>{readableCharacter(mistake.actual) || '空'}</del>
          </li>)}
        </ol>
      </details>}
      {article && <details className="feature-details">
        <summary>文章原文</summary>
        <p className="feature-scroll record-source" tabIndex={0}>{article.text}</p>
      </details>}
      {article && <div className="feature-actions">
        <button className="outline-button" onClick={() => { onClose(); onReplay(article); }}>重练</button>
        {canContinue && <button className="primary-button" onClick={() => { onClose(); onContinue(record); }}>继续练习</button>}
      </div>}
    </div>
  </Dialog>;
}

export function RecordsView({ records, onReplay, onContinue }: Props) {
  const [language, setLanguage] = useState<Language | ''>('');
  const [selected, setSelected] = useState<PracticeRecord>();
  const filtered = records.filter((record) => !language || record.language === language).sort((a, b) => b.finishedAt - a.finishedAt);

  return <section className="content-panel records feature-panel">
    <div className="content-heading"><h1><Clock size={25} aria-hidden="true" /> 我的记录</h1></div>
    <div className="feature-toolbar">
      <div className="segmented feature-segments" role="group" aria-label="记录语言">
        <button aria-pressed={language === ''} onClick={() => setLanguage('')}>全部</button>
        <button aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
        <button aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>English</button>
      </div>
    </div>
    {!filtered.length ? <p className="empty-state">暂无记录</p> : <ul className="feature-list">
      {filtered.map((record, index) => {
        const date = new Date(record.finishedAt);
        const title = recordTitle(record);
        return <li className="feature-row" key={record.recordId ?? `${record.finishedAt}-${index}`}>
          <div className="feature-row-main">
            <h2>{title}</h2>
            <div className="feature-meta">
              <time dateTime={date.toISOString()}>{dateText(date)}</time>
              {record.article && <span>{languageNames[record.language]} · {difficultyNames[record.difficulty]}</span>}
              {record.localOnly && <span>{record.ownerId ? '个人练习' : '本机'}</span>}
              {statusLabel(record.status) && <span>{statusLabel(record.status)}</span>}
            </div>
          </div>
          <div className="feature-actions">
            <div className="record-speed"><strong>{speedLabel(record)}</strong><span>准确率 {record.accuracy}%</span></div>
            <button className="outline-button feature-action-button" aria-label={`${record.article ? `《${title}》` : title}详情`} onClick={() => setSelected(record)}>详情</button>
          </div>
        </li>;
      })}
    </ul>}
    {selected && <RecordDetail record={selected} onClose={() => setSelected(undefined)} onReplay={onReplay} onContinue={onContinue} />}
  </section>;
}
