import { describe, it, expect } from 'vitest';
import { buildSessionRecallQuery, formatRecallOutput } from '../session-start-recall-utils.js';

describe('buildSessionRecallQuery', () => {
  it('combines project name and commits', () => {
    const result = buildSessionRecallQuery('my-project', ['add login page', 'fix header bug']);
    expect(result).toBe('my-project add login page fix header bug');
  });

  it('handles empty commits array', () => {
    const result = buildSessionRecallQuery('my-project', []);
    expect(result).toBe('my-project');
  });

  it('handles undefined commits', () => {
    const result = buildSessionRecallQuery('my-project');
    expect(result).toBe('my-project');
  });

  it('strips conventional commit prefixes', () => {
    const commits = [
      'fix: resolve null pointer',
      'feat(auth): add OAuth support',
      'chore(deps): update dependencies',
      'refactor: simplify logic',
    ];
    const result = buildSessionRecallQuery('app', commits);
    expect(result).toBe('app resolve null pointer add OAuth support update dependencies simplify logic');
  });

  it('filters out empty strings after stripping prefixes', () => {
    const commits = ['fix:', 'feat(scope): '];
    const result = buildSessionRecallQuery('app', commits);
    expect(result).toBe('app');
  });
});

describe('formatRecallOutput', () => {
  it('formats results with similarity percentage', () => {
    const results = [
      { name: 'Entity1', observations: ['obs1', 'obs2'], similarity: 0.85 },
    ];
    const output = formatRecallOutput(results);
    expect(output).toBe('  - Entity1 (85%): obs1; obs2');
  });

  it('returns empty string for empty results', () => {
    expect(formatRecallOutput([])).toBe('');
  });

  it('returns empty string for null results', () => {
    expect(formatRecallOutput(null)).toBe('');
  });

  it('returns empty string for undefined results', () => {
    expect(formatRecallOutput(undefined)).toBe('');
  });

  it('limits observations to 2', () => {
    const results = [
      { name: 'Entity1', observations: ['obs1', 'obs2', 'obs3', 'obs4'], similarity: 0.7 },
    ];
    const output = formatRecallOutput(results);
    expect(output).toBe('  - Entity1 (70%): obs1; obs2');
  });

  it('formats multiple results on separate lines', () => {
    const results = [
      { name: 'A', observations: ['a1'], similarity: 0.9 },
      { name: 'B', observations: ['b1', 'b2'], similarity: 0.6 },
    ];
    const output = formatRecallOutput(results);
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('  - A (90%): a1');
    expect(lines[1]).toBe('  - B (60%): b1; b2');
  });

  it('rounds similarity percentage', () => {
    const results = [
      { name: 'X', observations: ['x1'], similarity: 0.456 },
    ];
    const output = formatRecallOutput(results);
    expect(output).toBe('  - X (46%): x1');
  });
});
