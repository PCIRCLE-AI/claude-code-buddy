// Who owns `recall_hits` / `recall_misses`.
//
// The pair answers one question — "was a memory we injected actually USED?" —
// and `scoring.ts::impactScore` reads it as a Laplace-smoothed ratio,
// (hits+1)/(hits+misses+2), which is only meaningful if both sides come from
// the same question. Only the Stop hook can observe it, by matching injected
// entity names against the session transcript.
//
// This file used to assert the opposite. Under the G16 / SPEC-1 reading,
// `search()` bumped `recall_hits` too, meaning "this memory was pulled". That
// is a second definition sharing one column, it can only ever add to the hit
// side, and "was pulled" is already recorded by `access_count` in the same
// statement. Measured on a real 91-entity database the two had not yet
// collided — 29 hits against 365 misses, impact median exactly 0.500 — but
// OR-joined query terms return many more rows per search than the old AND
// semantics did, which is when a one-sided writer starts to matter.
//
// So the cases below now pin the opposite contract: retrieval paths track
// access, and nothing but the Stop hook touches the hit/miss pair.
//
// Runs against a real in-memory SQLite DB to catch what mocks would miss
// (column missing, transaction failing, trackAccess invoked with wrong args).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('recall_hits ownership', () => {
  let tmpHome: string;
  let kg: any;
  let db: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-hits-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    // Re-import lazily so the new env path is picked up. db.ts caches by
    // env at first call, so reset module state between tests.
    const dbMod = await import('../src/db.js?hits=' + Date.now());
    const kgMod = await import('../src/knowledge-graph.js?hits=' + Date.now());
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    kg = new kgMod.KnowledgeGraph(db);

    kg.createEntity('alpha', 'decision', { observations: ['use OAuth 2.0 for browser flows'] });
    kg.createEntity('beta', 'pattern', { observations: ['rate limit token bucket'] });
    kg.createEntity('gamma', 'lesson_learned', { observations: ['avoid circular imports'] });
  });

  afterEach(() => {
    try { db?.close(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function getHits(name: string): number {
    const row = db.prepare('SELECT recall_hits FROM entities WHERE name = ?').get(name) as { recall_hits: number };
    return row.recall_hits;
  }
  function getAccess(name: string): number {
    const row = db.prepare('SELECT access_count FROM entities WHERE name = ?').get(name) as { access_count: number };
    return row.access_count;
  }

  it('search() does not touch recall_hits', () => {
    const results = kg.search('OAuth');
    expect(results.find((e: any) => e.name === 'alpha')).toBeDefined();
    expect(getHits('alpha')).toBe(0);
  });

  it('repeated searches never accumulate hits', () => {
    kg.search('OAuth');
    kg.search('OAuth');
    kg.search('OAuth');
    // The property that matters: no retrieval path can inflate the hit side
    // without a matching opportunity to record a miss.
    expect(getHits('alpha')).toBe(0);
  });

  it('a tag-filtered listing does not touch recall_hits either', () => {
    kg.createEntity('alpha', 'decision', { tags: ['project:memesh'] });
    kg.search(undefined, { tag: 'project:memesh' });
    expect(getHits('alpha')).toBe(0);
  });

  it('browse-style listing does not touch recall_hits', () => {
    const results = kg.listRecent(10);
    expect(results.length).toBeGreaterThan(0);
    expect(getHits('alpha')).toBe(0);
    expect(getHits('beta')).toBe(0);
    expect(getHits('gamma')).toBe(0);
  });

  it('every retrieval path still tracks access, which is what frequency scores', () => {
    // Removing the hit bump must not remove the access bump: recency and
    // frequency are 0.43 of the score between them and depend on it.
    expect(getAccess('alpha')).toBe(0);
    kg.search('OAuth');
    expect(getAccess('alpha')).toBe(1);
    kg.listRecent(10);
    expect(getAccess('alpha')).toBe(2);
  });

  it('a search that matches nothing touches neither counter', () => {
    kg.search('this-string-matches-nothing-xyz');
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(getHits(name)).toBe(0);
      expect(getAccess(name)).toBe(0);
    }
  });

  it('the hit/miss pair stays writable by its owner', () => {
    // The Stop hook's statements, run here directly: the column contract has
    // to keep working for the one writer that legitimately uses it.
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('alpha') as { id: number }).id;
    db.prepare('UPDATE entities SET recall_hits = COALESCE(recall_hits, 0) + 1 WHERE id = ?').run(id);
    db.prepare('UPDATE entities SET recall_misses = COALESCE(recall_misses, 0) + 1 WHERE id = ?').run(id);

    const row = db.prepare('SELECT recall_hits, recall_misses FROM entities WHERE id = ?').get(id) as
      { recall_hits: number; recall_misses: number };
    expect(row).toEqual({ recall_hits: 1, recall_misses: 1 });
  });
});
