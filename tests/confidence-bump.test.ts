// G1 verification: confidence is no longer a one-way decay. Three paths
// must bump it back up:
//   1. createEntity() re-asserting an existing active entity (+0.05 cap 1.0)
//   2. consolidator post-LLM-summary (reset to 1.0)
//   3. lesson-engine createExplicitLesson (reset to 1.0)
//
// We validate by writing a low confidence to disk (simulating prior auto-
// decay) and confirming each bump path lifts it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('G1 — confidence bump paths', () => {
  let tmpHome: string;
  let kg: any;
  let db: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-g1-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    // Single module instance — re-imports must hit the same db.ts cache
    // so getDatabase() inside operations.ts → remember() finds the open
    // handle. closeDatabase() in afterEach resets module state safely.
    const dbMod = await import('../src/db.js');
    const kgMod = await import('../src/knowledge-graph.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    kg = new kgMod.KnowledgeGraph(db);

    kg.createEntity('decayed', 'lesson_learned', { observations: ['original obs'] });
    // Force-decay confidence to simulate prior lifecycle decay
    db.prepare('UPDATE entities SET confidence = 0.4 WHERE name = ?').run('decayed');
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function getConfidence(name: string): number {
    return (db.prepare('SELECT confidence FROM entities WHERE name = ?').get(name) as { confidence: number }).confidence;
  }

  it('re-asserting an existing entity bumps confidence by +0.05', () => {
    expect(getConfidence('decayed')).toBeCloseTo(0.4, 5);
    kg.createEntity('decayed', 'lesson_learned', { observations: ['additional obs'] });
    expect(getConfidence('decayed')).toBeCloseTo(0.45, 5);
  });

  it('the +0.05 bump caps at 1.0 (does not overshoot)', () => {
    db.prepare('UPDATE entities SET confidence = 0.97 WHERE name = ?').run('decayed');
    kg.createEntity('decayed', 'lesson_learned', { observations: ['x'] });
    // 0.97 + 0.05 = 1.02 → clamped to 1.0
    expect(getConfidence('decayed')).toBeCloseTo(1.0, 5);
  });

  it('first-creation does not double-bump confidence', () => {
    // A truly new entity inserts at default 1.0 and should NOT receive the
    // +0.05 bump (we only counter decay on RE-ASSERTING)
    kg.createEntity('fresh', 'decision');
    expect(getConfidence('fresh')).toBeCloseTo(1.0, 5);
  });

  it('reactivating an archived entity does not bump (separate path)', async () => {
    // Archive it
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = ?").run('decayed');
    db.prepare('UPDATE entities SET confidence = 0.3 WHERE name = ?').run('decayed');

    // Re-create reactivates and sets status='active'; the early `wasArchived`
    // branch in createEntity intentionally skips the confidence bump so a
    // reactivation alone is not treated as a re-assert.
    kg.createEntity('decayed', 'lesson_learned', { observations: ['reactivated'] });
    expect(getConfidence('decayed')).toBeCloseTo(0.3, 5);
  });

  it('createExplicitLesson resets confidence to 1.0 — highest-trust signal', async () => {
    // First: simulate a prior decayed lesson_learned for this project.
    kg.createEntity('lesson-test-project-network-error', 'lesson_learned', {
      observations: ['Error: stale', 'Root cause: stale', 'Fix: stale', 'Prevention: stale'],
    });
    db.prepare('UPDATE entities SET confidence = 0.3 WHERE name = ?').run('lesson-test-project-network-error');

    // Now call createExplicitLesson with the same project + same error pattern
    // and verify confidence is reset to 1.0.
    const { createExplicitLesson } = await import('../src/core/lesson-engine.js');
    createExplicitLesson(
      'connection refused on cold-start',
      'add retry-with-backoff',
      'test-project',
      { errorPattern: 'network-error' }
    );
    expect(getConfidence('lesson-test-project-network-error')).toBeCloseTo(1.0, 5);
  });
});
