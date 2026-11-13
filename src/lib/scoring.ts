export type Score = { correct: number; total: number; accuracy: number; cpm: number; wpm: number };

export function splitCharacters(text: string): string[] {
  const normalized = text.normalize('NFC');
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized), (item) => item.segment);
  }
  return Array.from(normalized);
}

export function scoreTyping(target: string, input: string, seconds: number): Score {
  const expected = splitCharacters(target);
  const actual = splitCharacters(input);
  const correct = actual.reduce((count, character, index) => count + (character === expected[index] ? 1 : 0), 0);
  const total = actual.length;
  const round = (value: number) => Math.round(value * 100) / 100;
  const cpm = seconds > 0 && Number.isFinite(seconds) ? correct * 60 / seconds : 0;
  return {
    correct,
    total,
    accuracy: total ? round(correct / total * 100) : 0,
    cpm: round(cpm),
    wpm: round(cpm / 5),
  };
}
