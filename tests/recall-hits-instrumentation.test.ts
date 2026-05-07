// G16 verification: every recall path that the SDD plan SPEC-1 promises to
// instrument actually bumps `recall_hits`. Browse-style listing does not.
//
// This test runs against a real in-memory SQLite DB to catch a class of
// bugs that mocks would miss (column missing, transaction failing,
// trackAccess invoked with the wrong opts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('G16 — recall_hits cross-transport instrumentation', () => {
  let tmpHome: string;
  let kg: any;
  let db: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-g16-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    // Re-import lazily so the new env path is picked up. db.ts caches by
    // env at first call, so reset module state between tests.
    const dbMod = await import('../src/db.js?g16=' + Date.now());
    const kgMod = await import('../src/knowledge-graph.js?g16=' + Date.now());
    // openDatabase explicitly so the per-test temp path is honoured
    // (getDatabase() throws "Database not opened" on first use).
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    kg = new kgMod.KnowledgeGraph(db);

    // Seed 3 entities. A recall hit increments recall_hits which starts
    // at 0 (DEFAULT 0 in the schema).
    kg.createEntity('alpha', 'decision', { observations: ['use OAuth 2.0 for browser flows'] });
    kg.createEntity('beta', 'pattern', { observations: ['rate limit token bucket'] });
    kg.createEntity('gamma', 'lesson_learned', { observations: ['avoid circular imports'] });
  });

  afterEach(() => {
    try { db?.close(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function getHits(name: string): number {
    const row = db.prepare('SELECT recall_hits FROM entities WHERE name = ?').get(name) as { recall_hits: number };
    return row.recall_hits;
  }

  it('search() with a query bumps recall_hits for every returned entity', () => {
    expect(getHits('alpha')).toBe(0);
    const results = kg.search('OAuth');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.find((e: any) => e.name === 'alpha')).toBeDefined();
    expect(getHits('alpha')).toBe(1);
  });

  it('search() bumps cumulatively across multiple calls', () => {
    kg.search('OAuth');
    kg.search('OAuth');
    kg.search('OAuth');
    expect(getHits('alpha')).toBe(3);
  });

  it('listRecent() does NOT bump recall_hits (browse-style)', () => {
    const results = kg.listRecent(10);
    expect(results.length).toBeGreaterThan(0);
    expect(getHits('alpha')).toBe(0);
    expect(getHits('beta')).toBe(0);
    expect(getHits('gamma')).toBe(0);
  });

  it('search() with an empty query falls through to listRecent and does NOT bump', () => {
    kg.search('');
    expect(getHits('alpha')).toBe(0);
  });

  it('search() with a tag filter (no query) routes through listRecentByTag and DOES bump', () => {
    // Tag the seed so we have something to filter on
    kg.createEntity('alpha', 'decision', { tags: ['project:memesh'] });
    kg.search(undefined, { tag: 'project:memesh' });
    expect(getHits('alpha')).toBe(1);
  });

  it('search() returning zero results is a no-op for recall_hits', () => {
    kg.search('this-string-matches-nothing-xyz');
    expect(getHits('alpha')).toBe(0);
    expect(getHits('beta')).toBe(0);
    expect(getHits('gamma')).toBe(0);
  });

  it('access_count is also bumped on every search and listRecent', () => {
    kg.search('OAuth');
    kg.listRecent(10);
    const row = db.prepare('SELECT access_count FROM entities WHERE name = ?').get('alpha') as { access_count: number };
    // Once for search() (matched), once for listRecent() (returned all)
    expect(row.access_count).toBe(2);
    // But recall_hits only fires for search()
    expect(getHits('alpha')).toBe(1);
  });
});
