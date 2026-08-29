import { describe, it, expect } from 'vitest';
import { createLesson, createExplicitLesson, inferErrorPattern, lessonSlug } from '../../src/core/lesson-engine.js';
import { getDatabase } from '../../src/db.js';
import { recall } from '../../src/core/operations.js';
import type { StructuredLesson } from '../../src/core/failure-analyzer.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-lesson-');

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

  it('marks auto-learned lessons as untrusted (anti trust-laundering)', () => {
    // F2 fix: lessons paraphrased by an LLM from session-transcript errors
    // must not be `trusted`, otherwise a malicious dependency printing
    // prompt-injection error text gets surfaced as authoritative guidance.
    createLesson(mockLesson, 'myapp');
    const entities = recall({ tag: 'error-pattern:null-reference' });
    const meta = entities[0].metadata as { trust?: string; provenance?: { source?: string } } | undefined;
    expect(meta?.trust).toBe('untrusted');
    expect(meta?.provenance?.source).toBe('auto-learned');
  });

  it('marks explicit lessons (user-typed) as trusted', () => {
    // The `learn` MCP tool / createExplicitLesson path is user-supplied
    // text, so it remains `trusted` and IS surfaced at session-start.
    createExplicitLesson('manual error', 'manual fix', 'myapp', { severity: 'major' });
    const entities = recall({ tag: 'source:explicit' });
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const meta = entities[0].metadata as { trust?: string } | undefined;
    expect(meta?.trust).toBe('trusted');
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

describe('Regression #241: explicit lessons are keyed on content, not on the error enum', () => {
  it('two unrelated lessons in one project become two entities', () => {
    const a = createExplicitLesson('A test fake answered from a flag it set itself instead of from the written body', 'Make the fake a store', 'proj');
    const b = createExplicitLesson('The shared secret pattern list has three consumers and one of them drops content', 'Enumerate consumers before editing the list', 'proj');
    expect(a.name).not.toBe(b.name);
    expect(a.name).toMatch(/^lesson-proj-/);
    expect(b.name).toMatch(/^lesson-proj-/);
    // Neither collapsed into the shared bucket.
    expect(a.name).not.toBe('lesson-proj-other');
    expect(b.name).not.toBe('lesson-proj-other');
  });

  it('resubmitting the same lesson still lands on the same entity and appends', () => {
    const first = createExplicitLesson('Widened the credential regex without a left boundary', 'Add \\b', 'proj');
    const again = createExplicitLesson('Widened the credential regex without a left boundary', 'Add \\b and a negative corpus', 'proj');
    expect(again.name).toBe(first.name);
    const db = getDatabase();
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(first.name) as { id: number };
    const n = (db.prepare('SELECT COUNT(*) AS n FROM observations WHERE entity_id = ?').get(row.id) as { n: number }).n;
    expect(n).toBe(8); // two submissions x four fields
  });

  it('lessonSlug is bounded and stable', () => {
    expect(lessonSlug('Null pointer in the auth path')).toBe('null-pointer-in-the-auth-path');
    expect(lessonSlug('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    expect(lessonSlug('!!!')).toBe('unspecified');
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
