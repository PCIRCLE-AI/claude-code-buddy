import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { backfillRelations } from '../../src/core/kg-backfill.js';

const require = createRequire(import.meta.url);

// Integration test: seed 50 entities across types and sessions,
// run all 4 rules, verify orphan rate drops below 50%.
describe('KG backfill — integration: orphan rate reduction', () => {
  let testDir: string;
  let dbPath: string;
  let prevDbPath: string | undefined;
  let Database: ReturnType<typeof require>;
  let db: InstanceType<typeof Database>;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-kg-integration-'));
    dbPath = path.join(testDir, 'test.db');
    prevDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* nothing open */ }
    openDatabase();
    Database = require('better-sqlite3');
    db = new Database(dbPath);
  });

  afterEach(async () => {
    db.close();
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    if (prevDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = prevDbPath;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reduces orphan rate below 50% on a mixed 50-entity seed', () => {
    // Helper to insert and return id
    const insertEntity = (name: string, type: string, meta?: Record<string, unknown>): number => {
      const r = db.prepare(
        "INSERT INTO entities (name, type, status, metadata) VALUES (?, ?, 'active', ?)"
      ).run(name, type, meta ? JSON.stringify(meta) : null);
      return r.lastInsertRowid as number;
    };

    const insertTag = (eid: number, tag: string): void => {
      db.prepare("INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)").run(eid, tag);
    };

    // Session groups: 5 sessions × 5 entities each (high-signal types)
    const sessionTypes = ['lesson_learned', 'decision', 'feature', 'architecture', 'bug_fix'];
    const sessionIds: number[][] = [];
    for (let s = 0; s < 5; s++) {
      const group: number[] = [];
      for (let i = 0; i < 5; i++) {
        const type = sessionTypes[i];
        const id = insertEntity(
          `${type} for auth module session ${s} item ${i}`,
          type,
          { signal_score: 0.8 }
        );
        insertTag(id, `session:sess${s}`);
        insertTag(id, `project:projectA`);
        group.push(id);
      }
      sessionIds.push(group);
    }

    // Name-token group: 10 entities sharing "auth flow" tokens
    for (let i = 0; i < 5; i++) {
      insertEntity(`auth flow configuration step ${i}`, 'feature', { signal_score: 0.7 });
    }
    for (let i = 0; i < 5; i++) {
      insertEntity(`auth flow validation rule ${i}`, 'decision', { signal_score: 0.8 });
    }

    // Noise entities (session_keypoint / commit) — should remain orphans since low signal
    for (let i = 0; i < 10; i++) {
      const id = insertEntity(`session note ${i}`, 'session_keypoint', { signal_score: 0.1 });
      insertTag(id, `session:sess${i % 5}`);
    }

    // Project anchor: one release in projectA for project clustering (Rule 2)
    const releaseId = insertEntity('v1.0.0 auth module release', 'release');
    insertTag(releaseId, 'project:projectA');

    const before = (db.prepare(
      "SELECT COUNT(*) AS n FROM entities e WHERE e.status='active' AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_entity_id=e.id OR r.to_entity_id=e.id)"
    ).get() as { n: number }).n;

    const total = (db.prepare("SELECT COUNT(*) AS n FROM entities WHERE status='active'").get() as { n: number }).n;
    // 25 session entities + 10 name-token entities + 10 keypoints + 1 release = 46
    expect(total).toBe(46);
    expect(before).toBe(46); // all orphans before backfill

    backfillRelations({
      includeSessionCooccurrence: true,
      includeNameTokenSimilarity: true,
      maxEdgesPerSource: 3,
      dryRun: false,
    });

    const orphansAfter = (db.prepare(
      "SELECT COUNT(*) AS n FROM entities e WHERE e.status='active' AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_entity_id=e.id OR r.to_entity_id=e.id)"
    ).get() as { n: number }).n;

    const orphanRate = orphansAfter / total;
    // Noise entities (10 session_keypoints with signal_score=0.1) and release
    // will remain orphaned; high-signal entities should be connected
    expect(orphanRate).toBeLessThan(0.50);
  });
});
