import { describe, it, expect } from 'vitest';
import { parseTags } from '../../src/core/auto-tagger.js';
import { remember } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

useTestDatabase('memesh-autotag-');

describe('Auto-Tagger parseTags', () => {
  it('should parse valid JSON array of tags', () => {
    const result = parseTags('["project:memesh", "topic:auth", "tech:sqlite"]');
    expect(result).toEqual(['project:memesh', 'topic:auth', 'tech:sqlite']);
  });

  it('should extract JSON array from surrounding text', () => {
    const result = parseTags('Here are the tags: ["project:myapp", "topic:database"] Hope this helps!');
    expect(result).toEqual(['project:myapp', 'topic:database']);
  });

  it('should filter out tags without valid prefixes', () => {
    const result = parseTags('["project:memesh", "invalid-tag", "random", "tech:node"]');
    expect(result).toEqual(['project:memesh', 'tech:node']);
  });

  it('should return empty array for invalid JSON', () => {
    expect(parseTags('not json')).toEqual([]);
    expect(parseTags('{}')).toEqual([]);
    expect(parseTags('')).toEqual([]);
  });

  it('should limit to 5 tags maximum', () => {
    const input = '["project:a", "project:b", "topic:c", "tech:d", "scope:e", "severity:f", "topic:g"]';
    const result = parseTags(input);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('should lowercase tags', () => {
    const result = parseTags('["Project:MyApp", "Topic:AUTH"]');
    expect(result).toEqual(['project:myapp', 'topic:auth']);
  });
});

describe('Auto-Tagger integration', () => {
  it('remember without tags does not crash (auto-tag is fire-and-forget)', () => {
    // This test verifies remember() doesn't throw when no tags provided
    // Auto-tagging runs async and won't actually call LLM in test env
    const result = remember({
      name: 'no-tags-entity',
      type: 'decision',
      observations: ['Use SQLite for local storage'],
    });
    expect(result.stored).toBe(true);
    expect(result.tags).toBe(0);
  });

  it('remember with tags skips auto-tagging', () => {
    // `result.tags` is the count of tags the CALLER supplied, so asserting
    // `1` here asserted the argument on the line above — auto-tagging could
    // not have influenced it in either direction. What "skips auto-tagging"
    // actually means is that the stored entity carries the caller's tag and
    // nothing else, which is read back from the graph.
    const result = remember({
      name: 'tagged-entity',
      type: 'decision',
      observations: ['Use SQLite'],
      tags: ['project:memesh'],
    });
    expect(result.stored).toBe(true);

    const stored = new KnowledgeGraph(getDatabase()).getEntity('tagged-entity');
    expect(stored?.tags, 'a tag appeared that the caller did not supply')
      .toEqual(['project:memesh']);
  });
});
