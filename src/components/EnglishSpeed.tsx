import { useId, useState } from 'react';
import { Keyboard } from '@phosphor-icons/react/Keyboard';
import { Question } from '@phosphor-icons/react/Question';
import type { Score } from '../lib/scoring';

export function EnglishSpeed({ score, display }: { score?: Score; display: 'live' | 'result' }) {
  const [expanded, setExpanded] = useState(false);
  const explanationId = useId();

  return <div className={`english-speed english-speed-${display}`} role="group" aria-label="英文速度">
    <div className="english-speed-values">
      {display === 'live' && <Keyboard size={23} aria-hidden="true" />}
      <span className="english-speed-value"><strong>{score?.wpm ?? '—'}</strong> WPM</span>
      <span className="english-speed-value"><strong>{score?.cpm ?? '—'}</strong> 字符/分钟</span>
      <button type="button" className="icon-button" aria-label="英文速度说明" aria-expanded={expanded}
        aria-controls={explanationId} onClick={() => setExpanded((open) => !open)}>
        <Question size={20} aria-hidden="true" />
      </button>
    </div>
    <div className="english-speed-explanation" id={explanationId} hidden={!expanded}>
      <p><strong>字符/分钟（CPM）</strong> 等于正确字符数除以有效练习分钟数。正确输入的空格和标点也计入，暂停时间不计。</p>
      <p><strong>WPM（标准词/分钟）</strong> 按每 5 个正确字符折算为 1 个标准词。例如，200 字符/分钟等于 40 WPM。</p>
    </div>
  </div>;
}
