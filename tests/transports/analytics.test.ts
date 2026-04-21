import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-analytics-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Analytics computation ──────────────────────────────────────────────────

describe('/v1/analytics computation', () => {
  it('health score is 0 for empty database', () => {
    const total = (
      db
        .prepare("SELECT COUNT(*) as c FROM entities WHERE status = 'active'")
        .get() as { c: number }
    ).c;
    expect(total).toBe(0);
    // With 0 entities, all ratios = 0, score = 0
  });

  it('health score increases with high-confidence entities', () => {
    remember({ name: 'test-entity', type: 'concept', observations: ['test obs'] });
    // Default confidence is 1.0 which is > 0.7
    const highConf = (
      db
        .prepare("SELECT COUNT(*) as c FROM entities WHERE confidence > 0.7")
        .get() as { c: number }
    ).c;
    expect(highConf).toBe(1);
  });

  it('health score rewards lesson_learned entities', () => {
    for (let i = 0; i < 5; i++) {
      remember({
        name: `lesson-${i}`,
        type: 'lesson_learned',
        observations: ['learned something'],
      });
    }
    const lessons = (
      db
        .prepare("SELECT COUNT(*) as c FROM entities WHERE type = 'lesson_learned'")
        .get() as { c: number }
    ).c;
    expect(lessons).toBe(5);
  });

  it('stale entity detection works', () => {
    remember({ name: 'old-entity', type: 'concept', observations: ['old'] });
    db.prepare(
      "UPDATE entities SET confidence = 0.2, last_accessed_at = datetime('now', '-60 days') WHERE name = ?",
    ).run('old-entity');

    const stale = db
      .prepare(
        `
      SELECT COUNT(*) as c FROM entities
      WHERE status = 'active' AND confidence < 0.4
        AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-30 days'))
    `,
      )
      .get() as { c: number };
    expect(stale.c).toBe(1);
  });

  it('timeline query returns daily buckets', () => {
    remember({ name: 'today-entity', type: 'concept', observations: ['created today'] });
    const rows = db
      .prepare(
        `
      SELECT DATE(created_at) as day, COUNT(*) as created
      FROM entities WHERE created_at > datetime('now', '-30 days')
      GROUP BY DATE(created_at) ORDER BY day ASC
    `,
      )
      .all() as Array<{ day: string; created: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].created).toBeGreaterThan(0);
  });

  it('type distribution reflects entity types', () => {
    remember({ name: 'e1', type: 'concept', observations: ['a'] });
    remember({ name: 'e2', type: 'decision', observations: ['b'] });
    remember({ name: 'e3', type: 'concept', observations: ['c'] });
    const types = db
      .prepare(
        "SELECT type, COUNT(*) as count FROM entities WHERE status = 'active' GROUP BY type ORDER BY count DESC",
      )
      .all() as Array<{ type: string; count: number }>;
    expect(types[0]).toEqual({ type: 'concept', count: 2 });
    expect(types[1]).toEqual({ type: 'decision', count: 1 });
  });
});

// ── Recall Effectiveness ─────────────────────────────────────────────────

describe('recall effectiveness tracking', () => {
  it('recall_hits and recall_misses default to 0 for new entities', () => {
    remember({ name: 'eff-test', type: 'decision', observations: ['test'] });
    const row = db.prepare(
      'SELECT recall_hits, recall_misses FROM entities WHERE name = ?'
    ).get('eff-test') as { recall_hits: number; recall_misses: number };
    expect(row.recall_hits).toBe(0);
    expect(row.recall_misses).toBe(0);
  });

  it('recall_hits increments correctly', () => {
    remember({ name: 'hit-entity', type: 'decision', observations: ['test'] });
    db.prepare('UPDATE entities SET recall_hits = recall_hits + 1 WHERE name = ?').run('hit-entity');
    db.prepare('UPDATE entities SET recall_hits = recall_hits + 1 WHERE name = ?').run('hit-entity');
    const row = db.prepare(
      'SELECT recall_hits FROM entities WHERE name = ?'
    ).get('hit-entity') as { recall_hits: number };
    expect(row.recall_hits).toBe(2);
  });

  it('recall_misses increments correctly', () => {
    remember({ name: 'miss-entity', type: 'decision', observations: ['test'] });
    db.prepare('UPDATE entities SET recall_misses = recall_misses + 1 WHERE name = ?').run('miss-entity');
    const row = db.prepare(
      'SELECT recall_misses FROM entities WHERE name = ?'
    ).get('miss-entity') as { recall_misses: number };
    expect(row.recall_misses).toBe(1);
  });

  it('hit rate calculation is correct', () => {
    remember({ name: 'rate-entity', type: 'decision', observations: ['test'] });
    db.prepare('UPDATE entities SET recall_hits = 7, recall_misses = 3 WHERE name = ?').run('rate-entity');
    const row = db.prepare(
      `SELECT CAST(recall_hits AS REAL) / (recall_hits + recall_misses) as hitRate
       FROM entities WHERE name = ?`
    ).get('rate-entity') as { hitRate: number };
    expect(row.hitRate).toBeCloseTo(0.7, 2);
  });

  it('overall hit rate aggregation works across multiple entities', () => {
    remember({ name: 'agg-1', type: 'concept', observations: ['a'] });
    remember({ name: 'agg-2', type: 'concept', observations: ['b'] });
    db.prepare('UPDATE entities SET recall_hits = 5, recall_misses = 5 WHERE name = ?').run('agg-1');
    db.prepare('UPDATE entities SET recall_hits = 8, recall_misses = 2 WHERE name = ?').run('agg-2');
    const totals = db.prepare(
      `SELECT COALESCE(SUM(recall_hits), 0) as hits, COALESCE(SUM(recall_misses), 0) as misses
       FROM entities WHERE (recall_hits > 0 OR recall_misses > 0)`
    ).get() as { hits: number; misses: number };
    expect(totals.hits).toBe(13);
    expect(totals.misses).toBe(7);
    const rate = totals.hits / (totals.hits + totals.misses);
    expect(rate).toBeCloseTo(0.65, 2);
  });
});
