// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readDraft } from '../src/hooks/usePractice';

const valid = { version: 1, articleId: 'zh-beginner-1', title: '清晨的光', text: '你好世界', target: '你好世界', language: 'zh', difficulty: 'beginner', duration: 300, custom: false, ownerId: null, offline: true, elapsedMs: 5000, typed: '你好', backspaces: 1, suspicious: false, recordId: 'valid', savedAt: 10 };

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe('saved practice recovery', () => {
  it('recovers a valid draft even when an unrelated saved record is malformed', () => {
    localStorage.setItem('cloudtyping.practice.v1', '{broken');
    localStorage.setItem('cloudtyping.practice.v2.valid', JSON.stringify(valid));
    localStorage.setItem('cloudtyping.practice.v2.invalid', JSON.stringify({ ...valid, recordId: 'invalid', duration: -1, savedAt: 20 }));
    expect(readDraft()?.typed).toBe('你好');
  });
});
