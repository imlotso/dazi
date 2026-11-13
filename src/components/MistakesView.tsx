import { useMemo, useState } from 'react';
import { Notebook } from '@phosphor-icons/react/Notebook';
import { Play } from '@phosphor-icons/react/Play';
import type { Language } from '../data/articles';
import { collectMistakes, createMistakeDrill } from '../lib/analysis';
import type { ArticleSnapshot, PracticeRecord } from '../lib/models';
import { readableCharacter } from '../lib/practice-lines';

type Props = { records: PracticeRecord[]; onPractice: (article: ArticleSnapshot) => void };

export function MistakesView({ records, onPractice }: Props) {
  const [language, setLanguage] = useState<Language>('zh');
  const [selected, setSelected] = useState(new Set<string>());
  const entries = useMemo(() => collectMistakes(records), [records]);
  const shown = entries.filter((entry) => entry.language === language);
  const drill = createMistakeDrill(shown.filter(({ id }) => selected.has(id)), language);

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return <section className="content-panel mistakes feature-panel">
    <div className="content-heading">
      <h1><Notebook size={25} aria-hidden="true" /> 错字本</h1>
      <button className="primary-button feature-action-button" disabled={!drill.text.trim()} onClick={() => onPractice(drill)}><Play size={16} aria-hidden="true" /> 专项练习</button>
    </div>
    <div className="feature-toolbar">
      <div className="segmented feature-segments" role="group" aria-label="错字语言">
        <button aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
        <button aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>English</button>
      </div>
    </div>
    {!shown.length ? <p className="empty-state">暂无错字</p> : <ul className="feature-list">
      {shown.map((entry) => {
        const expected = readableCharacter(entry.expected);
        const date = new Date(entry.lastSeen);
        return <li key={entry.id} className="feature-row">
          <div className="feature-row-main">
            <label className="mistake-option">
              <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
              <strong>{expected}</strong>
            </label>
            <div className="feature-meta">
              <span>{entry.count} 次</span>
              <time dateTime={date.toISOString()}>{date.toLocaleDateString('zh-CN')}</time>
              <span>误输 {entry.actual.map((value) => readableCharacter(value) || '空').join('、')}</span>
            </div>
            {entry.contexts[0] && <p className="mistake-context">{entry.contexts[0]}</p>}
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}
