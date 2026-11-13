import { useState } from 'react';
import { ChartBar } from '@phosphor-icons/react/ChartBar';
import type { Language } from '../data/articles';
import { calculateStats } from '../lib/analysis';
import type { PracticeRecord } from '../lib/models';

function elapsedLabel(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export function StatsView({ records }: { records: PracticeRecord[] }) {
  const [language, setLanguage] = useState<Language>('zh');
  const [days, setDays] = useState<7 | 30>(7);
  const stats = calculateStats(records, language, days);
  const unit = language === 'zh' ? '字/分' : 'WPM';
  const speed = (value: number | null) => value === null ? '—' : `${value} ${unit}`;
  const accuracy = (value: number | null) => value === null ? '—' : `${value}%`;
  const maxSpeed = Math.max(1, stats.bestSpeed ?? 0);

  return <section className="content-panel stats feature-panel">
    <div className="content-heading"><h1><ChartBar size={25} aria-hidden="true" /> 练习统计</h1></div>
    <div className="feature-toolbar">
      <div className="segmented feature-segments" role="group" aria-label="统计语言">
        <button aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
        <button aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>English</button>
      </div>
      <div className="segmented feature-segments" role="group" aria-label="统计时段">
        <button aria-pressed={days === 7} onClick={() => setDays(7)}>7 天</button>
        <button aria-pressed={days === 30} onClick={() => setDays(30)}>30 天</button>
      </div>
    </div>
    <dl className="feature-metrics">
      <div><dt>练习次数</dt><dd>{stats.sessions}</dd></div>
      <div><dt>累计用时</dt><dd>{stats.timedSessions ? elapsedLabel(stats.elapsedMs) : '—'}</dd></div>
      <div><dt>最高速度</dt><dd>{speed(stats.bestSpeed)}</dd></div>
      <div><dt>平均速度</dt><dd>{speed(stats.averageSpeed)}</dd></div>
      <div><dt>平均准确率</dt><dd>{accuracy(stats.averageAccuracy)}</dd></div>
    </dl>
    {stats.sessions === 0 ? <p className="empty-state">暂无练习</p> : <div className="stats-trend" tabIndex={0} role="region" aria-label="每日统计列表">
      <table aria-label="每日统计">
        <thead><tr><th scope="col">日期</th><th scope="col">次数</th><th scope="col">速度</th><th scope="col">准确率</th></tr></thead>
        <tbody>
          {[...stats.daily].reverse().map((day) => <tr key={day.date.getTime()}>
            <th scope="row">{day.date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</th>
            <td>{day.sessions || '—'}</td>
            <td>{speed(day.speed)}{day.speed != null && <div className="stats-bar" aria-hidden="true"><span style={{ width: `${day.speed / maxSpeed * 100}%` }} /></div>}</td>
            <td>{accuracy(day.accuracy)}{day.accuracy != null && <div className="stats-bar stats-accuracy" aria-hidden="true"><span style={{ width: `${day.accuracy}%` }} /></div>}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
  </section>;
}
