import { describe, expect, it } from 'vitest';
import { scoreTyping, splitCharacters } from '../src/lib/scoring';

describe('typing score', () => {
  it('scores confirmed characters against the target including punctuation', () => {
    expect(scoreTyping('你好，世界', '你好，世错', 60)).toEqual({
      correct: 4, total: 5, accuracy: 80, cpm: 4, wpm: 0.8,
    });
  });

  it('treats a composed character as one visible character', () => {
    expect(splitCharacters('a🙂e\u0301')).toEqual(['a', '🙂', 'é']);
    expect(scoreTyping('a🙂é', 'a🙂e\u0301', 30).correct).toBe(3);
  });

  it('returns zero accuracy and speed for empty input', () => {
    expect(scoreTyping('hello', '', 60)).toEqual({
      correct: 0, total: 0, accuracy: 0, cpm: 0, wpm: 0,
    });
  });

  it('counts extra characters as incorrect', () => {
    expect(scoreTyping('hi', 'hii', 60)).toMatchObject({
      correct: 2, total: 3, accuracy: 66.67,
    });
  });
});
