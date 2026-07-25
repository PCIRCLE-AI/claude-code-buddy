import { describe, it, expect } from 'vitest';
import { extractJsonBlock } from '../../src/core/json-utils.js';

describe('extractJsonBlock', () => {
  it('extracts an object wrapped in prose', () => {
    const text = 'Sure! Here is the result:\n{"action":"ADD","n":1}\nHope that helps.';
    expect(extractJsonBlock(text, 'object')).toBe('{"action":"ADD","n":1}');
  });

  it('extracts a flat array wrapped in prose', () => {
    expect(extractJsonBlock('tags: ["auth","cli"] done', 'array')).toBe('["auth","cli"]');
  });

  // The case the LAZY regex broke on: a nested block cut to the first closer.
  it('keeps a NESTED array whole (lazy /\\[[\\s\\S]*?\\]/ would truncate it)', () => {
    expect(extractJsonBlock('[[1,2],[3,4]]', 'array')).toBe('[[1,2],[3,4]]');
  });

  it('keeps a NESTED object whole', () => {
    const t = 'reply: {"a":{"b":1},"c":2} end';
    expect(extractJsonBlock(t, 'object')).toBe('{"a":{"b":1},"c":2}');
  });

  // The case the GREEDY regex broke on: a closer char appears later in prose.
  it('stops at the first balanced block, ignoring a later bracket in prose (greedy would swallow it)', () => {
    expect(extractJsonBlock('["a","b"] and see [the docs] for more', 'array')).toBe('["a","b"]');
    expect(extractJsonBlock('{"ok":true} then note: {unrelated', 'object')).toBe('{"ok":true}');
  });

  // The case BOTH regexes broke on: a closer char inside a string literal.
  it('does not treat brackets inside string literals as structure', () => {
    expect(extractJsonBlock('{"note":"a } b","x":1}', 'object')).toBe('{"note":"a } b","x":1}');
    expect(extractJsonBlock('["a ] b","c"]', 'array')).toBe('["a ] b","c"]');
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonBlock('{"q":"she said \\"hi\\" }"}', 'object')).toBe('{"q":"she said \\"hi\\" }"}');
  });

  it('extracts from a markdown code fence', () => {
    expect(extractJsonBlock('```json\n{"a":1}\n```', 'object')).toBe('{"a":1}');
  });

  it('returns null when there is no opener', () => {
    expect(extractJsonBlock('no json here', 'object')).toBeNull();
    expect(extractJsonBlock('', 'array')).toBeNull();
  });

  it('returns null when the block is never balanced (opener, no closer)', () => {
    expect(extractJsonBlock('{"a":1', 'object')).toBeNull();
  });

  // Round-trips through JSON.parse for the real callers.
  it('produces JSON.parse-able output for each broken-regex case', () => {
    expect(JSON.parse(extractJsonBlock('[[1,2],[3,4]] trailing', 'array')!)).toEqual([[1, 2], [3, 4]]);
    expect(JSON.parse(extractJsonBlock('{"note":"a } b"} x', 'object')!)).toEqual({ note: 'a } b' });
  });
});
