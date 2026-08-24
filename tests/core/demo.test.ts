// SPEC-4 demo seeder — verifies the curated dataset lands cleanly,
// every entity carries the metadata.demo flag, the created_at spread
// covers a believable 30-day window, and --reset removes only those
// entities (real memories captured in between are untouched).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('seedDemo', () => {
  let tmpHome: string;
  let db: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-demo-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('seeds 30 entities all flagged metadata.demo = true', async () => {
    const { seedDemo } = await import('../../src/core/demo.js');
    const result = seedDemo(db);
    expect(result.inserted).toBe(30);
    expect(result.removed).toBe(0);
    const flagged = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE json_extract(metadata, '$.demo') = 1",
    ).get() as { c: number }).c;
    expect(flagged).toBe(30);
  });

  it('spreads created_at across the last ~30 days', async () => {
    const { seedDemo } = await import('../../src/core/demo.js');
    seedDemo(db);
    const range = db.prepare(
      "SELECT MIN(created_at) as min, MAX(created_at) as max FROM entities WHERE json_extract(metadata, '$.demo') = 1",
    ).get() as { min: string; max: string };
    const span = (Date.parse(range.max) - Date.parse(range.min)) / 86400000;
    // The fixture runs from daysAgo: 30 down to 0, so the span should
    // be very close to 30 days. Allow ±1 day for clock drift between
    // the test setup and the assertion.
    expect(span).toBeGreaterThanOrEqual(29);
    expect(span).toBeLessThanOrEqual(31);
  });

  it('is idempotent — re-running without --reset is a no-op', async () => {
    const { seedDemo } = await import('../../src/core/demo.js');
    const first = seedDemo(db);
    expect(first.inserted).toBe(30);
    const second = seedDemo(db);
    expect(second.inserted).toBe(0);
  });

  it('every demo entity carries the project:memesh-demo tag', async () => {
    const { seedDemo } = await import('../../src/core/demo.js');
    seedDemo(db);
    const untagged = (db.prepare(`
      SELECT COUNT(*) as c FROM entities e
      WHERE json_extract(e.metadata, '$.demo') = 1
        AND NOT EXISTS (
          SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'project:memesh-demo'
        )
    `).get() as { c: number }).c;
    expect(untagged).toBe(0);
  });

  it('--reset removes only demo entities, leaving real memories alone', async () => {
    const { seedDemo } = await import('../../src/core/demo.js');
    const { remember } = await import('../../src/core/operations.js');
    // Seed demo first, then add a real entity, then reset.
    seedDemo(db);
    remember({ name: 'real-memory', type: 'decision', observations: ['I added this manually'] });

    const result = seedDemo(db, { reset: true });
    expect(result.removed).toBe(30);

    const totalLeft = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    expect(totalLeft).toBe(1);
    const real = db.prepare("SELECT name FROM entities WHERE name = ?").get('real-memory');
    expect(real).toBeDefined();
  });

  it('seeds typed relations so the Graph tab shows a graph, not 30 orphans', async () => {
    const { seedDemo, DEMO_RELATIONS } = await import('../../src/core/demo.js');
    seedDemo(db);
    const edges = (db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c;
    // A typo'd endpoint name in the fixture makes createRelation THROW (it
    // resolves both names up front), so seedDemo itself fails loudly and the
    // count assertion above never sees a short table. No dangling-row check
    // here — the insert path makes that state unreachable, and a query for
    // an unreachable state is a gate that cannot fail.
    expect(edges).toBe(DEMO_RELATIONS.length);
    expect(edges).toBeGreaterThanOrEqual(15);
    // Idempotent re-run must not double the edges.
    seedDemo(db);
    const after = (db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c;
    expect(after).toBe(edges);
  });

  it('a real memory whose name collides with a demo entity gets no demo edges (M-16)', async () => {
    // `auth-decision` is a name a real user's own memory could plausibly
    // carry (it is a plausible name, not a demo-specific one) — and DEMO_
    // RELATIONS wires an edge onto it. `if (exists) continue` in seedDemo
    // already refuses to touch or duplicate the row itself; this pins the
    // OTHER half — createRelation resolves both endpoints by NAME alone,
    // with no notion of who created the row, so without the collision
    // guard the real memory still ends up wired into the demo graph the
    // moment any other demo entity in the run needs inserting.
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const kg = new KnowledgeGraph(db);
    const realId = kg.createEntity('auth-decision', 'decision', {
      observations: ['This is the real user memory, not the demo one.'],
    });

    const { seedDemo, DEMO_RELATIONS } = await import('../../src/core/demo.js');
    const result = seedDemo(db);

    // The real row survives untouched — still not flagged demo, still the
    // user's own observation, still the entity `createEntity` returned.
    const real = db.prepare(
      "SELECT id, metadata FROM entities WHERE name = 'auth-decision'",
    ).get() as { id: number; metadata: string | null };
    expect(real.id).toBe(realId);
    expect(real.metadata ? JSON.parse(real.metadata).demo : undefined).not.toBe(true);

    // Exactly one DEMO_RELATIONS triple names auth-decision as an endpoint
    // (`feature-auth-flow implements auth-decision`) — every OTHER edge
    // must still land, so this pins the one skip rather than a suite-wide
    // relations failure.
    const touchingAuthDecision = DEMO_RELATIONS.filter(([f, , t]) => f === 'auth-decision' || t === 'auth-decision');
    expect(touchingAuthDecision.length, 'fixture: no DEMO_RELATIONS entry names auth-decision').toBeGreaterThan(0);
    const edges = (db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c;
    expect(edges).toBe(DEMO_RELATIONS.length - touchingAuthDecision.length);

    const wired = db.prepare(
      `SELECT COUNT(*) as c FROM relations WHERE from_entity_id = ? OR to_entity_id = ?`,
    ).get(realId, realId) as { c: number };
    expect(wired.c, 'the real memory was wired into the demo graph').toBe(0);

    // The rest of the tour still seeded — one collision does not sink it.
    expect(result.inserted).toBe(29);
  });

  it('seeds at least one entity of every key type cluster (lessons, decisions, patterns, bug_fix, releases, plans)', async () => {
    const { seedDemo } = await import('../../src/core/demo.js');
    seedDemo(db);
    const wanted = ['lesson_learned', 'decision', 'pattern', 'bug_fix', 'release', 'plan'];
    for (const type of wanted) {
      const count = (db.prepare("SELECT COUNT(*) as c FROM entities WHERE type = ?").get(type) as { c: number }).c;
      expect(count, `expected at least one ${type}`).toBeGreaterThan(0);
    }
  });
});
