import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Check } from '@phosphor-icons/react/Check';
import { usePractice, type PracticePhase } from '../hooks/usePractice';
import type { ReaderSettings } from '../lib/models';
import { wrapPracticeLines, type PracticeLine } from '../lib/practice-lines';
import { splitCharacters } from '../lib/scoring';

type Practice = ReturnType<typeof usePractice>;
type Reader = Pick<ReaderSettings, 'fontSize' | 'lineHeight' | 'visibleLines'>;
type Props = { practice: Practice; title: string; reader?: Reader };
const fallbackMeasure = (character: string): number => /^[\x00-\x7f]$/.test(character) ? 10 : 18;
const visibleText = (text: string) => text.replaceAll('\n', '↵').replaceAll(' ', '·');
type RowProps = {
  line: PracticeLine; index: number; active: boolean; phase: PracticePhase;
  typedValue: string; value: string; composing: boolean; blocked: boolean; inputStart: number;
  controller: RefObject<Practice>; currentIndex: RefObject<number>;
  activeRow: RefObject<HTMLDivElement | null>;
  setComposing: (value: boolean) => void;
};

const PracticeRow = memo(function PracticeRow({ line, index, active, phase, typedValue, value, composing, blocked, inputStart, controller, currentIndex, activeRow, setComposing }: RowProps) {
  const actual = useMemo(() => splitCharacters(typedValue), [typedValue]);
  const completed = !blocked && actual.length === line.characters.length;
  const rowErrors = actual.filter((character, offset) => character !== line.characters[offset]).length;
  const prefix = () => splitCharacters(controller.current.typed).slice(0, inputStart).join('');

  // Software keyboards may emit beforeinput without any keydown/change on an
  // empty field. Handle that native event so correction also works on phones.
  useEffect(() => {
    if (!active || phase !== 'running') return;
    const field = controller.current.textareaRef.current;
    const beforeInput = (event: InputEvent) => {
      if (event.inputType !== 'deleteContentBackward' || event.isComposing || composing || !field || field.value || line.start <= controller.current.offset) return;
      event.preventDefault();
      controller.current.deletePreviousCharacter();
    };
    field?.addEventListener('beforeinput', beforeInput);
    return () => field?.removeEventListener('beforeinput', beforeInput);
  }, [active, phase, composing, line.start, inputStart, controller]);

  return <div ref={active ? activeRow : undefined} className={`practice-line${active ? ' line-active' : ''}${completed ? ' line-completed' : ''}`} data-active={active}>
    <div className="line-marker" aria-label={`第 ${index + 1} 行${completed ? '已完成' : active ? '当前行' : '待输入'}`}>
      {completed && rowErrors === 0 ? <Check size={16} weight="bold" aria-hidden="true" /> : String(index + 1).padStart(2, '0')}
    </div>
    <div className="line-pair">
      <div className="line-source" data-testid={`practice-source-${index}`} data-text={line.text} aria-label={line.text}>
        {!active && (actual.length === 0 || (completed && rowErrors === 0)) ? <span className={completed ? 'char-correct' : undefined}>{visibleText(line.text)}</span> : line.characters.map((character, offset) => {
          const state = offset < actual.length ? (actual[offset] === character ? 'char-correct' : 'char-wrong') : offset === actual.length && phase === 'running' ? 'char-current' : '';
          return <span key={offset} className={state} title={character === '\n' ? '换行' : character === ' ' ? '空格' : character === '\t' ? '制表符' : undefined}>{character === '\n' ? '↵' : character === ' ' ? <span className="space-character">·</span> : character}</span>;
        })}
      </div>
      <textarea
        ref={active ? controller.current.textareaRef : undefined}
        id={active ? 'typing-input' : undefined}
        aria-label={active ? '当前行输入' : `第 ${index + 1} 行输入`}
        value={value} disabled={!active || phase !== 'running'}
        rows={1} wrap="off" spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off"
        onChange={(event) => { if (index === currentIndex.current) controller.current.onChange(event, prefix()); }}
        onCompositionStart={() => { if (index === currentIndex.current && phase === 'running') { setComposing(true); controller.current.onCompositionStart(); } }}
        onCompositionEnd={(event) => { if (index === currentIndex.current) { controller.current.onCompositionEnd(event, prefix()); setComposing(false); } }}
        onKeyDown={(event) => {
          const practice = controller.current;
          if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Backspace' && !event.currentTarget.value && line.start > practice.offset) {
            event.preventDefault(); practice.deletePreviousCharacter(); return;
          }
          practice.onKeyDown(event);
          if (event.key === 'Escape') { event.preventDefault(); void practice.pause(); }
          if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            const field = event.currentTarget;
            const position = inputStart - line.start + splitCharacters(field.value.slice(0, field.selectionStart)).length;
            if (line.characters[position] === '\t') {
              event.preventDefault();
              practice.updateTyped(prefix() + field.value.slice(0, field.selectionStart) + '\t' + field.value.slice(field.selectionEnd));
            }
          }
          if (event.key === 'Enter' && !(line.text.endsWith('\n') && splitCharacters(event.currentTarget.value).length === line.end - inputStart - 1)) {
            event.preventDefault();
          }
        }}
        onPaste={() => controller.current.markSuspicious()} onDrop={() => controller.current.markSuspicious()}
      />
    </div>
  </div>;
});

export const PracticeLines = memo(function PracticeLines({ practice, title, reader }: Props) {
  const { target, typed, raw, phase, strict, offset } = practice;
  const controller = useRef(practice);
  controller.current = practice;
  const viewport = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const [layout, setLayout] = useState({ width: 640, measure: fallbackMeasure });
  const lastLayout = useRef('');
  const lines = useMemo(() => wrapPracticeLines(target, layout.width, layout.measure), [target, layout]);
  const typedCharacters = useMemo(() => splitCharacters(typed), [typed]);
  const rawCharacters = useMemo(() => splitCharacters(raw), [raw]);
  const expected = useMemo(() => splitCharacters(target), [target]);
  const wrong = strict ? typedCharacters.findIndex((character, index) => index >= offset && character !== expected[index]) : -1;
  const cursor = wrong >= 0 ? wrong : typedCharacters.length;
  const activeIndex = Math.max(0, lines.findIndex((line, index) => cursor < line.end || index === lines.length - 1));
  const currentIndex = useRef(activeIndex);
  currentIndex.current = activeIndex;

  useLayoutEffect(() => {
    if (composing && phase === 'running') return;
    const container = viewport.current;
    if (!container) return;
    const measure = () => {
      const sample = container.querySelector<HTMLElement>('.line-source');
      if (!sample?.clientWidth) return;
      const style = getComputedStyle(sample);
      const width = Math.max(1, sample.clientWidth - 28);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const key = `${width}:${font}`;
      if (lastLayout.current === key) return;
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = font;
      lastLayout.current = key;
      setLayout({ width, measure: (character) => context.measureText(character === '\t' ? '    ' : character).width });
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [target, composing, phase, reader?.fontSize, reader?.lineHeight, reader?.visibleLines]);

  useEffect(() => {
    if (phase !== 'running') setComposing(false);
    if (phase === 'ready') {
      if (viewport.current) viewport.current.scrollTop = 0;
      return;
    }
    if (composing) return;
    const input = practice.textareaRef.current;
    // A same-row IME edit owns its selection. Only a newly focused row should
    // move the caret to its end (including phrases committed across rows).
    if (phase === 'running' && input && document.activeElement !== input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
    const container = viewport.current;
    const row = activeRow.current;
    container?.querySelectorAll<HTMLTextAreaElement>('textarea:disabled').forEach((field) => { field.scrollTop = 0; });
    if (container && row) {
      const box = container.getBoundingClientRect();
      const item = row.getBoundingClientRect();
      if (item.top < box.top || item.bottom > box.bottom) container.scrollTop += item.top - box.top - 12;
      // A large requested row count can extend beyond the page viewport.
      // Follow the active input through both the inner scroller and the page.
      const inputBox = input?.getBoundingClientRect();
      if (phase === 'running' && inputBox && inputBox.height > 0 && (inputBox.top < 0 || inputBox.bottom > window.innerHeight)) {
        row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }, [activeIndex, phase, lines, composing, practice.textareaRef, reader?.fontSize, reader?.lineHeight, reader?.visibleLines]);

  const total = lines.at(-1)?.end ?? 0;
  const percent = total ? Math.min(100, Math.round(typedCharacters.length / total * 100)) : 0;
  const readerStyle = reader ? {
    '--practice-font-size': `${reader.fontSize}px`,
    '--practice-line-height': reader.lineHeight,
    '--practice-visible-lines': reader.visibleLines,
  } as CSSProperties : undefined;

  return <>
    <div className="line-progress">
      <span>第 {activeIndex + 1} / {lines.length} 行</span>
      <progress aria-label="文章完成进度" max={total || 1} value={typedCharacters.length} />
      <span className="progress-percent">{percent}%</span>
    </div>
    <div ref={viewport} className="practice-lines" aria-label={`当前文章：${title}`} style={readerStyle}>
      {lines.map((line, index) => {
        const active = index === activeIndex;
        const typedValue = typedCharacters.slice(line.start, line.end).join('');
        const inputStart = Math.max(line.start, offset);
        return <PracticeRow key={line.start} line={line} index={index} active={active} phase={phase}
          inputStart={inputStart} typedValue={typedValue} value={active ? rawCharacters.slice(inputStart).join('') : typedCharacters.slice(inputStart, line.end).join('')}
          blocked={active && wrong >= 0} composing={active && composing} controller={controller} currentIndex={currentIndex} activeRow={activeRow}
          setComposing={setComposing} />;
      })}
    </div>
  </>;
// Input handlers read the hook's live refs. Clock-only renders must not rebuild
// every character and input in a long article ten times per second.
}, (before, after) => before.title === after.title &&
  before.practice.target === after.practice.target && before.practice.typed === after.practice.typed &&
  before.practice.raw === after.practice.raw && before.practice.phase === after.practice.phase &&
  before.practice.strict === after.practice.strict && before.practice.offset === after.practice.offset &&
  before.reader?.fontSize === after.reader?.fontSize && before.reader?.lineHeight === after.reader?.lineHeight && before.reader?.visibleLines === after.reader?.visibleLines);
