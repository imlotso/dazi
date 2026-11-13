import { describe, expect, it } from 'vitest';
import { wrapPracticeLines } from '../src/lib/practice-lines';

describe('practice line wrapping', () => {
  const measure = (character: string) => /^[\x00-\x7f]$/.test(character) ? 1 : 2;

  it('keeps English words and their spaces across line boundaries', () => {
    expect(wrapPracticeLines('one two three four', 10, measure).map((line) => line.text)).toEqual(['one two ', 'three four']);
  });

  it('preserves explicit and empty lines, punctuation and emoji graphemes', () => {
    const lines = wrapPracticeLines('你好👨‍👩‍👧‍👦！\n\nCafe\u0301 end', 8, measure);
    expect(lines.map((line) => line.text)).toEqual(['你好👨‍👩‍👧‍👦！\n', '\n', 'Café ', 'end']);
    expect(lines.map((line) => [line.start, line.end])).toEqual([[0, 5], [5, 6], [6, 11], [11, 14]]);
  });

  it('breaks long unspaced text without losing characters even at narrow widths', () => {
    expect(wrapPracticeLines('甲乙丙丁', 4, measure).map((line) => line.text)).toEqual(['甲乙', '丙丁']);
    expect(wrapPracticeLines('abcdef', 2, measure).map((line) => line.text)).toEqual(['ab', 'cd', 'ef']);
    expect(wrapPracticeLines('你好', 0, measure).map((line) => line.text)).toEqual(['你', '好']);
  });
});
