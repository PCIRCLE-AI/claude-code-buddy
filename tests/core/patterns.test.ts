import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { computePatterns } from '../../src/core/patterns.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-patterns-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computePatterns', () => {
  it('returns all pattern categories for empty database', () => {
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule).toBeDefined();
    expect(result.workSchedule.hourDistribution).toEqual([]);
    expect(result.workSchedule.dayDistribution).toEqual([]);
    expect(result.toolPreferences).toEqual([]);
    expect(result.focusAreas).toEqual([]);
    expect(result.workflow.totalSessions).toBe(0);
    expect(result.workflow.totalCommits).toBe(0);
    expect(result.workflow.avgSessionMinutes).toBe(0);
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
    expect(result.toolPreferences).toEqual([]);
  });

  it('computes hour distribution ordered by hour', () => {
    remember({ name: 'e1', type: 'concept', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule.hourDistribution.length).toBeGreaterThan(0);
    const total = result.workSchedule.hourDistribution.reduce((s, h) => s + h.count, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('includes dayNum in day distribution', () => {
    remember({ name: 'e1', type: 'concept', observations: ['test'] });
    const db = getDatabase();
    const result = computePatterns(db);
    expect(result.workSchedule.dayDistribution.length).toBeGreaterThan(0);
    for (const entry of result.workSchedule.dayDistribution) {
      expect(entry).toHaveProperty('day');
      expect(entry).toHaveProperty('dayNum');
      expect(entry).toHaveProperty('count');
      expect(typeof entry.dayNum).toBe('number');
    }
  });
});
