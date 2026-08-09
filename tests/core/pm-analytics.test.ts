import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { computePmAnalytics } from '../../src/core/analytics.js';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

const require = createRequire(import.meta.url);

describe('computePmAnalytics', () => {
  let testDir: string;
  let dbPath: string;
  let prevDbPath: string | undefined;
  let Database: ReturnType<typeof require>;
  let db: InstanceType<typeof Database>;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pm-analytics-'));
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

  const insertEntity = (name: string, type: string, daysAgo = 0, lastAccessedDaysAgo?: number): number => {
    const createdAt = new Date(Date.now() - daysAgo * 86400 * 1000).toISOString();
    const lastAccessed = lastAccessedDaysAgo !== undefined
      ? new Date(Date.now() - lastAccessedDaysAgo * 86400 * 1000).toISOString()
      : null;
    const r = db.prepare(
      "INSERT INTO entities (name, type, status, created_at, last_accessed_at) VALUES (?, ?, 'active', ?, ?)"
    ).run(name, type, createdAt, lastAccessed);
    return r.lastInsertRowid as number;
  };

  it('C1: decisionsPerWeek counts decisions created within the window', () => {
    // 4 decisions within the last 14 days
    insertEntity('decision A', 'decision', 2);
    insertEntity('decision B', 'decision', 5);
    insertEntity('decision C', 'decision', 10);
    insertEntity('decision D', 'decision', 13);
    // 1 decision outside the 14-day window — should not count
    insertEntity('decision E', 'decision', 20);

    const result = computePmAnalytics(db, 14);
    // 4 decisions / (14/7 = 2 weeks) = 2.0
    expect(result.velocity.decisionsPerWeek).toBeCloseTo(2.0);
    expect(result.velocity.windowDays).toBe(14);
  });

  it('C1b: releasesPerMonth counts releases within the window', () => {
    insertEntity('v1.0.0', 'release', 5);
    insertEntity('v1.1.0', 'release', 25);
    // outside 30-day window
    insertEntity('v0.9.0', 'release', 40);

    const result = computePmAnalytics(db, 30);
    // 2 releases / (30/30 = 1 month) = 2.0
    expect(result.velocity.releasesPerMonth).toBeCloseTo(2.0);
  });

  it('C2: stalePlanCount counts plan entities not accessed in 30+ days', () => {
    // Stale: last accessed 45 days ago
    insertEntity('old roadmap', 'plan', 50, 45);
    // Active: last accessed 5 days ago
    insertEntity('current sprint', 'plan', 10, 5);
    // Never accessed — counts as stale (NULL last_accessed_at < threshold)
    insertEntity('never accessed plan', 'plan', 60, undefined);

    const result = computePmAnalytics(db, 90);
    expect(result.staleness.stalePlanCount).toBe(2); // old roadmap + never accessed
  });

  it('C2b: openDecisionCount counts decisions older than 14d without supersedes relation', () => {
    // Old unsuperseded decision
    const oldDec = insertEntity('old auth decision', 'decision', 20);
    // Old decision that was superseded
    const superseded = insertEntity('old login decision', 'decision', 20);
    // Link superseded with a supersedes relation
    db.prepare(
      "INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, 'supersedes')"
    ).run(superseded, oldDec);
    // Recent decision (not yet 14 days old)
    insertEntity('new decision', 'decision', 5);

    const result = computePmAnalytics(db, 30);
    // Only oldDec qualifies: old + no supersedes relation from it
    expect(result.staleness.openDecisionCount).toBe(1);
  });

  it('C3: orphanRate = entities_without_relations / total_active', () => {
    // 10 entities, 3 get relations
    const ids = [];
    for (let i = 0; i < 10; i++) {
      ids.push(insertEntity(`entity ${i}`, 'knowledge'));
    }
    // Connect 3 entities
    db.prepare(
      "INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, 'related-to')"
    ).run(ids[0], ids[1]);
    db.prepare(
      "INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, 'related-to')"
    ).run(ids[2], ids[3]);

    const result = computePmAnalytics(db, 30);
    // ids[0], ids[1], ids[2], ids[3] have relations → 4 connected, 6 orphans
    expect(result.connectedness.orphanRate).toBeCloseTo(6 / 10);
    expect(result.connectedness.totalRelations).toBe(2);
    expect(result.connectedness.activeEntities).toBe(10);
  });

  it('returns zero-valued result for empty database', () => {
    const result = computePmAnalytics(db, 30);
    expect(result.velocity.decisionsPerWeek).toBe(0);
    expect(result.velocity.releasesPerMonth).toBe(0);
    expect(result.staleness.stalePlanCount).toBe(0);
    expect(result.staleness.openDecisionCount).toBe(0);
    expect(result.connectedness.orphanRate).toBe(0);
    expect(result.connectedness.totalRelations).toBe(0);
    expect(result.connectedness.activeEntities).toBe(0);
  });
});
