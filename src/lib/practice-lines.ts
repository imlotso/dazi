import { splitCharacters } from './scoring.js';

export type PracticeLine = { text: string; characters: string[]; start: number; end: number };

/** Layout only: never trim or insert characters in the scored article. */
export function wrapPracticeLines(text: string, width: number, measure: (character: string) => number): PracticeLine[] {
  const characters = splitCharacters(text);
  const lines: PracticeLine[] = [];
  const widths = new Map<string, number>();
  let start = 0;
  while (start < characters.length) {
    let end = start;
    let used = 0;
    let wordBoundary = start;
    while (end < characters.length) {
      const character = characters[end];
      if (character === '\n') { end++; break; }
      if (!widths.has(character)) widths.set(character, measure(character));
      const nextWidth = widths.get(character)!;
      if (end > start && used + nextWidth > Math.max(1, width)) {
        if (wordBoundary > start) end = wordBoundary;
        break;
      }
      used += nextWidth;
      end++;
      if (character === ' ' || character === '\t') wordBoundary = end;
    }
    const row = characters.slice(start, end);
    lines.push({ text: row.join(''), characters: row, start, end });
    start = end;
  }
  return lines;
}

export function readableCharacter(character: string) {
  return character === ' ' ? '空格' : character === '\n' ? '换行' : character === '\t' ? 'Tab' : character;
}
