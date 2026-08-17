// Contract tests for the two-layer graph server side (UX-4):
//
//   computeWorkGraph      — work-layer entities only, work↔work relations,
//                           per-node incoming-`evidences` counts
//   computeNodeEvidence   — drill-down for one node; null for a missing
//                           node (a 404, not an empty list); `truncated`
//                           reports observed overflow (R2 honesty rule)
//
// The layer boundary itself is WORK_LAYER_TYPES from work-topology.ts — the
// single whitelist. These tests deliberately use one member ('decision')
// and one non-member ('commit') rather than restating the list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { computeWorkGraph, computeNodeEvidence } from '../../src/core/graph.js';

describe('graph work layer', () => {
  let testDir: string;
  let dbPath: string;
  let prevDbPath: string | undefined;
  let db: Database;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-graph-work-test-'));
    dbPath = path.join(testDir, 'test.db');
    prevDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* nothing open */ }
    openDatabase();
    db = new Database(dbPath);
  });

  afterEach(async () => {
    db.close();
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    if (prevDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = prevDbPath;
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function insertEntity(name: string, type: string, status = 'active'): number {
    const r = db.prepare(
      'INSERT INTO entities (name, type, status) VALUES (?, ?, ?)'
    ).run(name, type, status);
    return r.lastInsertRowid as number;
  }

  function insertRelation(fromId: number, toId: number, relType: string): void {
    db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
    ).run(fromId, toId, relType);
  }

  function setCreatedAt(entityId: number, iso: string): void {
    db.prepare('UPDATE entities SET created_at = ? WHERE id = ?').run(iso, entityId);
  }

  it('returns only work-layer entities', () => {
    insertEntity('a-decision', 'decision');
    insertEntity('a-commit', 'commit');
    insertEntity('a-note', 'note');

    const g = computeWorkGraph(db);
    expect(g.entities.map((e) => e.name)).toEqual(['a-decision']);
  });

  it('excludes archived work entities', () => {
    insertEntity('live-decision', 'decision');
    insertEntity('dead-decision', 'decision', 'archived');

    const g = computeWorkGraph(db);
    expect(g.entities.map((e) => e.name)).toEqual(['live-decision']);
  });

  it('keeps only relations whose BOTH endpoints are work-layer', () => {
    const d1 = insertEntity('d1', 'decision');
    const d2 = insertEntity('d2', 'plan');
    const ev = insertEntity('ev1', 'commit');
    insertRelation(d1, d2, 'related-to');
    insertRelation(ev, d1, 'evidences');

    const g = computeWorkGraph(db);
    expect(g.relations).toEqual([{ from: 'd1', to: 'd2', type: 'related-to' }]);
  });

  it('counts incoming evidences edges per work node; zero-edge nodes are absent', () => {
    const d1 = insertEntity('d1', 'decision');
    insertEntity('d2', 'decision');
    const e1 = insertEntity('e1', 'commit');
    const e2 = insertEntity('e2', 'session-insight');
    insertRelation(e1, d1, 'evidences');
    insertRelation(e2, d1, 'evidences');

    const g = computeWorkGraph(db);
    expect(g.evidenceCounts).toEqual({ d1: 2 });
  });

  it('does not count archived evidence in the badge', () => {
    const d1 = insertEntity('d1', 'decision');
    const dead = insertEntity('dead-ev', 'commit', 'archived');
    insertRelation(dead, d1, 'evidences');

    const g = computeWorkGraph(db);
    expect(g.evidenceCounts).toEqual({});
  });

  it('drill-down returns the evidence entities and their edges, newest first', () => {
    const d1 = insertEntity('d1', 'decision');
    // Distinct created_at, inserted OUT of order, and asserted WITHOUT a
    // sort — otherwise the "newest first" in this test's name is a claim
    // nothing checks.
    const oldest = insertEntity('e-oldest', 'commit');
    setCreatedAt(oldest, '2026-08-01 09:00:00');
    const newest = insertEntity('e-newest', 'session-insight');
    setCreatedAt(newest, '2026-08-09 09:00:00');
    const middle = insertEntity('e-middle', 'commit');
    setCreatedAt(middle, '2026-08-05 09:00:00');
    for (const ev of [oldest, newest, middle]) insertRelation(ev, d1, 'evidences');
    // An unrelated relation type must not leak into the drill-down.
    const other = insertEntity('other', 'note');
    insertRelation(other, d1, 'related-to');

    const result = computeNodeEvidence(db, 'd1');
    expect(result).not.toBeNull();
    expect(result!.entities.map((e) => e.name)).toEqual(['e-newest', 'e-middle', 'e-oldest']);
    expect(result!.relations).toHaveLength(3);
    for (const rel of result!.relations) {
      expect(rel.to).toBe('d1');
      expect(rel.type).toBe('evidences');
    }
    expect(result!.truncated).toBe(false);
  });

  it('orders by real time even though the two timestamp columns are stored differently', () => {
    // `last_accessed_at` is written as `new Date().toISOString()` and
    // `created_at` is SQLite's CURRENT_TIMESTAMP, so a bare string ORDER BY
    // over COALESCE(last_accessed_at, created_at) compares 'T' (0x54) with
    // ' ' (0x20) once the date prefixes match — and among entities touched on
    // the same day every recalled one then sorts above every never-recalled
    // one, whatever the real times were.
    const recalledEarlier = insertEntity('recalled-9am', 'decision');
    db.prepare('UPDATE entities SET created_at = ?, last_accessed_at = ? WHERE id = ?')
      .run('2026-08-01 00:00:00', '2026-08-17T09:00:00.000Z', recalledEarlier);
    const freshLater = insertEntity('fresh-11pm', 'decision');
    db.prepare('UPDATE entities SET created_at = ?, last_accessed_at = NULL WHERE id = ?')
      .run('2026-08-17 23:00:00', freshLater);

    const g = computeWorkGraph(db);
    expect(
      g.entities.map((e) => e.name),
      'the 14-hours-older recalled entity was ranked as the newest',
    ).toEqual(['fresh-11pm', 'recalled-9am']);
  });

  it('drops a relation whose other endpoint is archived, not just the archived entity', () => {
    // The entity list filters on status; the relation list did not, so the
    // payload carried an edge to a node that is not in it. The dashboard
    // hides the edge but derives "orphan" from the RAW relation list, so the
    // live node rendered as connected with no visible edge.
    const live = insertEntity('live-d', 'decision');
    const dead = insertEntity('dead-d', 'decision', 'archived');
    insertRelation(live, dead, 'related-to');

    const g = computeWorkGraph(db);
    expect(g.entities.map((e) => e.name)).toEqual(['live-d']);
    expect(g.relations, 'a dangling edge to an archived node was shipped').toEqual([]);
  });

  it('drill-down returns null for a missing node (404, not an empty list)', () => {
    expect(computeNodeEvidence(db, 'no-such-node')).toBeNull();
  });

  it('drill-down reports truncation at the boundary, and does not claim it one row early', () => {
    // Every existing assertion took the false branch, so an off-by-one in the
    // cap+1 overflow probe would have shipped green — and `truncated` is the
    // honesty half of this endpoint: a full page that says nothing is
    // indistinguishable from a complete answer.
    const node = insertEntity('busy-decision', 'decision');
    for (let i = 0; i < 200; i++) {
      insertRelation(insertEntity(`ev-${i}`, 'commit'), node, 'evidences');
    }
    const exact = computeNodeEvidence(db, 'busy-decision');
    expect(exact!.entities).toHaveLength(200);
    expect(exact!.truncated, 'exactly at the cap is not truncated').toBe(false);

    insertRelation(insertEntity('ev-200', 'commit'), node, 'evidences');
    const over = computeNodeEvidence(db, 'busy-decision');
    expect(over!.entities).toHaveLength(200);
    expect(over!.truncated, 'one past the cap must say so').toBe(true);
  });

  it('drill-down of a node with no evidence returns empty lists, not null', () => {
    insertEntity('lonely', 'decision');
    const result = computeNodeEvidence(db, 'lonely');
    expect(result).toEqual({ entities: [], relations: [], truncated: false });
  });
});
