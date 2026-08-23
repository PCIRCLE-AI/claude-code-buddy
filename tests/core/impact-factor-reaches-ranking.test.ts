/**
 * The impact factor is 10% of the ranking, and it reached the scorer as a
 * constant.
 *
 * `rankEntities` reads `entity.recall_hits` / `recall_misses`
 * (`scoring.ts:89`). `getEntitiesByIds` — the hydrator behind `search`,
 * `listRecent`, and the vector supplement, i.e. every recall — did not select
 * those columns. So the scorer received `undefined` for both,
 * `impactScore(undefined ?? 0, undefined ?? 0)` returned 0.5, and every row
 * got the identical 0.05 contribution forever.
 *
 * The signal itself was alive the whole time: the Stop hook writes
 * `recall_hits` from `[mem:id]` citations, and on a real graph 83 entities
 * carried accounting spanning impactScore 0.037 to 0.750. `briefing.ts`
 * hydrates the columns and got the real values; the recall path did not — so
 * one scoring function behaved differently depending on which caller reached
 * it.
 *
 * `scoring.ts:9` records that `temporalValidity` was deleted in 2026-05 for
 * being "a constant 1.0 for every entity — a no-op factor". This was the same
 * thing, in a factor nobody had checked.
 *
 * Two things are pinned, because the column being present is not the same as
 * the ranking using it:
 *   1. the hydrator carries the counters out of the database
 *   2. two memories that differ ONLY in citation history come back in the
 *      order that history implies
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { impactScore, rankEntities } from '../../src/core/scoring.js';

let dir: string;
let savedMemeshDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-impact-'));
  savedMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(path.join(dir, 'kg.db'));
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedMemeshDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Give an entity the citation history the Stop hook would have written. */
function setAccounting(name: string, hits: number, misses: number): void {
  getDatabase()
    .prepare('UPDATE entities SET recall_hits = ?, recall_misses = ? WHERE name = ?')
    .run(hits, misses, name);
}

describe('the hydrator carries the counters', () => {
  it('returns the citation history that is in the database', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('cited-often', 'note', { observations: ['a widget fact'] });
    setAccounting('cited-often', 12, 1);

    const [entity] = kg.search('widget');

    expect(entity, 'fixture: the search found nothing').toBeDefined();
    expect(entity.recall_hits, 'the hydrator dropped recall_hits').toBe(12);
    expect(entity.recall_misses, 'the hydrator dropped recall_misses').toBe(1);
  });

  it('reports zero — not undefined — for a memory with no history yet', () => {
    // The difference matters: `undefined` and `0` score identically today,
    // which is exactly why the defect was invisible. A fresh memory must
    // read as a measured zero.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('brand-new', 'note', { observations: ['another widget fact'] });

    const [entity] = kg.search('another');

    expect(entity.recall_hits).toBe(0);
    expect(entity.recall_misses).toBe(0);
  });

  it('carries them through getEntity too', () => {
    // Same row type, a different query — and it was also short two columns.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('single-read', 'note', { observations: ['fact'] });
    setAccounting('single-read', 5, 2);

    const entity = kg.getEntity('single-read');
    expect(entity?.recall_hits).toBe(5);
    expect(entity?.recall_misses).toBe(2);
  });
});

describe('the factor actually moves the ranking', () => {
  it('separates two memories that differ ONLY in citation history', () => {
    // The behavioural half. A hydrator that returned the columns but a
    // scorer that ignored them would pass every assertion above.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('proven-useful', 'note', { observations: ['shared search term here'] });
    kg.createEntity('never-cited', 'note', { observations: ['shared search term here'] });

    setAccounting('proven-useful', 20, 0);   // impactScore = 21/22 ≈ 0.955
    setAccounting('never-cited', 0, 20);     // impactScore =  1/22 ≈ 0.045

    // Identical relevance for both, so impact is the only factor that differs.
    const found = kg.search('shared');
    expect(found, 'fixture: both memories must be in the result set').toHaveLength(2);

    const relevance = new Map(found.map((e) => [e.name, 1.0] as const));
    const ranked = rankEntities(found, relevance).map((e) => e.name);

    expect(ranked[0], 'the cited memory did not outrank the ignored one').toBe('proven-useful');
    expect(ranked[1]).toBe('never-cited');
  });

  it('the two histories really do score differently — the arithmetic half', () => {
    // Guards against the ranking test passing for an unrelated reason (tie
    // broken by id, say). If these two were equal, the test above would be
    // asserting insertion order.
    expect(impactScore(20, 0)).toBeGreaterThan(impactScore(0, 20));
    expect(impactScore(0, 0), 'a memory with no history should sit between them').toBe(0.5);
  });
});
