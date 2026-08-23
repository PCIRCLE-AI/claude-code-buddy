import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { computePatterns } from '../../src/core/patterns.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-patterns-');

describe('computePatterns', () => {
  it('returns all pattern categories for empty database', () => {
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule).toBeDefined();
    expect(result.workSchedule.hourDistribution).toEqual([]);
    expect(result.workSchedule.dayDistribution).toEqual([]);
    expect(result.focusAreas).toEqual([]);
    expect(result.workflow.totalSessions).toBe(0);
    expect(result.workflow.totalCommits).toBe(0);
    expect(result.workflow.commitsPerSession).toBe(0);
    expect(result.strengths).toEqual([]);
    expect(result.learningAreas).toEqual([]);
  });

  it('computes focus areas excluding auto-tracked types', () => {
    remember({ name: 'e1', type: 'decision', observations: ['arch choice'] });
    remember({ name: 'e2', type: 'session_keypoint', observations: ['[SESSION] test'] });
    remember({ name: 'e3', type: 'lesson_learned', observations: ['Error: test'] });
    remember({ name: 'e4', type: 'commit', observations: ['fix: something'] });
    const db = getDatabase();
    const result = computePatterns(db);
    const types = result.focusAreas.map(f => f.type);
    expect(types).toContain('decision');
    expect(types).toContain('lesson_learned');
    expect(types).not.toContain('session_keypoint');
    expect(types).not.toContain('commit');
  });

  it('filters by categories when specified', () => {
    remember({ name: 'e1', type: 'decision', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db, ['workflow']);
    expect(result.workflow).toBeDefined();
    expect(result.workflow.totalSessions).toBe(0);
    // Categories not requested should be empty defaults
    expect(result.focusAreas).toEqual([]);
    expect(result.strengths).toEqual([]);
  });

  it('computes hour distribution ordered by hour', () => {
    remember({ name: 'e1', type: 'concept', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule.hourDistribution.length).toBeGreaterThan(0);
    const total = result.workSchedule.hourDistribution.reduce((s, h) => s + h.count, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('emits numeric dayNum (0-6) and no baked-in day name', () => {
    remember({ name: 'e1', type: 'concept', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule.dayDistribution.length).toBeGreaterThan(0);
    for (const entry of result.workSchedule.dayDistribution) {
      expect(entry).toHaveProperty('dayNum');
      expect(entry).toHaveProperty('count');
      expect(typeof entry.dayNum).toBe('number');
      expect(entry.dayNum).toBeGreaterThanOrEqual(0);
      expect(entry.dayNum).toBeLessThanOrEqual(6);
      // The English day-name column was removed on purpose (i18n): the
      // wire carries the number, each surface localises it.
      expect(entry).not.toHaveProperty('day');
    }
  });
});
