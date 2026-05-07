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

  it('re-asserting an existing entity does NOT bump confidence (pump-attack guard)', () => {
    // Earlier versions bumped +0.05 here, but that path was driven by every
    // caller of remember() — auto-tagger, verifier, importer — letting a
    // tight loop inflate confidence to 1.0 without adding any real truth.
    // The bump now requires a content-validating signal (consolidate or
    // explicit learn), not just a re-call of createEntity.
    expect(getConfidence('decayed')).toBeCloseTo(0.4, 5);
    kg.createEntity('decayed', 'lesson_learned', { observations: ['additional obs'] });
    expect(getConfidence('decayed')).toBeCloseTo(0.4, 5);
  });

  it('first-creation leaves confidence at the schema default (1.0)', () => {
    kg.createEntity('fresh', 'decision');
    expect(getConfidence('fresh')).toBeCloseTo(1.0, 5);
  });

  it('reactivating an archived entity does not change confidence', async () => {
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = ?").run('decayed');
    db.prepare('UPDATE entities SET confidence = 0.3 WHERE name = ?').run('decayed');

    kg.createEntity('decayed', 'lesson_learned', { observations: ['reactivated'] });
    expect(getConfidence('decayed')).toBeCloseTo(0.3, 5);
  });

  it('a tight remember-loop cannot pump confidence (regression guard)', () => {
    db.prepare('UPDATE entities SET confidence = 0.3 WHERE name = ?').run('decayed');
    for (let i = 0; i < 50; i++) {
      kg.createEntity('decayed', 'lesson_learned', { observations: [`obs-${i}`] });
    }
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
