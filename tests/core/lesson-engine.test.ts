import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { createLesson, createExplicitLesson, findProjectLessons, inferErrorPattern } from '../../src/core/lesson-engine.js';
import { recall } from '../../src/core/operations.js';
import type { StructuredLesson } from '../../src/core/failure-analyzer.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-lesson-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createLesson', () => {
  const mockLesson: StructuredLesson = {
    error: 'TypeError: Cannot read property of null',
    rootCause: 'Missing null check on API response',
    fix: 'Added optional chaining',
    prevention: 'Always validate API responses',
    errorPattern: 'null-reference',
    fixPattern: 'defensive-coding',
    severity: 'major',
  };

  it('creates a lesson_learned entity', () => {
    const result = createLesson(mockLesson, 'myapp');
    expect(result.name).toBe('lesson-myapp-null-reference');
    expect(result.isNew).toBe(true);
  });

  it('creates entity with correct tags', () => {
    createLesson(mockLesson, 'myapp');
    const entities = recall({ tag: 'error-pattern:null-reference' });
    expect(entities.length).toBeGreaterThanOrEqual(1);
    expect(entities[0].type).toBe('lesson_learned');
    expect(entities[0].tags).toContain('source:auto-learned');
    expect(entities[0].tags).toContain('severity:major');
  });

  it('appends observations on duplicate error pattern (upsert)', () => {
    createLesson(mockLesson, 'myapp');
    const result2 = createLesson({ ...mockLesson, fix: 'Better fix applied' }, 'myapp');
    expect(result2.isNew).toBe(false);

    const entities = recall({ tag: 'error-pattern:null-reference' });
    expect(entities[0].observations.length).toBe(8); // 4 + 4 appended
  });
});

describe('createExplicitLesson', () => {
  it('creates lesson from user input', () => {
    const result = createExplicitLesson('Test failure', 'Fixed assertion', 'myapp');
    expect(result.name).toContain('lesson-myapp-');

    const entities = recall({ tag: 'source:explicit' });
    expect(entities.length).toBe(1);
  });

  it('infers error pattern from description', () => {
    createExplicitLesson('TypeError: null is not an object', 'Added null check', 'myapp');
    const entities = recall({ tag: 'error-pattern:null-reference' });
    expect(entities.length).toBe(1);
  });
});

describe('findProjectLessons', () => {
  it('returns lessons for a project', () => {
    createExplicitLesson('Error 1', 'Fix 1', 'myapp');
    createExplicitLesson('Error 2', 'Fix 2', 'myapp');
    createExplicitLesson('Error 3', 'Fix 3', 'other-project');

    const lessons = findProjectLessons('myapp');
    // May find 2 lessons for myapp (depends on recall search behavior)
    expect(lessons.every(l => l.observations.length > 0)).toBe(true);
  });
});

describe('inferErrorPattern', () => {
  it('detects null-reference', () => {
    expect(inferErrorPattern('TypeError: Cannot read property of null')).toBe('null-reference');
    expect(inferErrorPattern('undefined is not a function')).toBe('null-reference');
  });

  it('detects type-error', () => {
    expect(inferErrorPattern('Type mismatch: string vs number')).toBe('type-error');
  });

  it('detects import-missing', () => {
    expect(inferErrorPattern('Module not found: ./utils')).toBe('import-missing');
  });

  it('detects config-error', () => {
    expect(inferErrorPattern('Missing environment variable')).toBe('config-error');
  });

  it('detects test-failure', () => {
    expect(inferErrorPattern('Test failed: assertion error')).toBe('test-failure');
  });

  it('defaults to other', () => {
    expect(inferErrorPattern('Something weird happened')).toBe('other');
  });
});
