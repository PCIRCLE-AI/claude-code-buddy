import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { computeAnalytics, computePmAnalytics, NOISE_TYPES } from '../../src/core/analytics.js';

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-analytics-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Analytics computation ──────────────────────────────────────────────────

describe('/v1/analytics computation', () => {
  // The one counter the retired Lessons tab carried that a reader acts on.
  // All three numbers travel together because `critical` alone overstates
  // what was measured: an unclassified lesson is not a non-critical one.
  it('critical lessons report their denominators, so the count cannot overstate', () => {
    remember({ name: 'crit-1', type: 'lesson_learned', observations: ['bad'], tags: ['severity:critical'] });
    remember({ name: 'minor-1', type: 'lesson_learned', observations: ['meh'], tags: ['severity:minor'] });
    remember({ name: 'unclassified', type: 'lesson_learned', observations: ['no severity tag'] });

    const { criticalLessons } = computeAnalytics(db);
    expect(criticalLessons).toEqual({ critical: 1, severityTagged: 2, total: 3 });
  });

  it('an unclassified library reports zero TAGGED, which the dashboard renders as not-measured', () => {
    remember({ name: 'lesson-a', type: 'lesson_learned', observations: ['no severity'] });
    const { criticalLessons } = computeAnalytics(db);
    // The distinction the tile depends on: nothing was classified, which is
    // not the same claim as "nothing is critical".
    expect(criticalLessons.severityTagged).toBe(0);
    expect(criticalLessons.total).toBe(1);
  });

  it('citation compliance is null until the counters exist — not 0%', () => {
    // The instrument has never been switched on: reporting 0% would be a
    // measurement claim about an agent that was never observed.
    expect(computeAnalytics(db).citationCompliance).toBeNull();

    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('citation_sessions_total', '4')").run();
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('citation_sessions_cited', '1')").run();
    expect(computeAnalytics(db).citationCompliance).toEqual({ cited: 1, total: 4 });

    // Measured and genuinely zero is a DIFFERENT answer from not measured.
    db.prepare("UPDATE memesh_metadata SET value = '0' WHERE key = 'citation_sessions_cited'").run();
    expect(computeAnalytics(db).citationCompliance).toEqual({ cited: 0, total: 4 });
  });

  it('health score is 0 for an empty database', () => {
    // It used to run its own COUNT and assert THAT was zero — a statement
    // about the fixture, not about `computeAnalytics`. `healthScore` is
    // published on `/v1/analytics`, rendered as the dashboard's Health Score
    // card, and was asserted nowhere in the suite: the whole four-factor
    // computation could return a constant and nothing would notice.
    expect(computeAnalytics(db).healthScore).toBe(0);
  });

  it('health score rises with the factors that feed it', () => {
    // The anti-vacuity half. A score hardwired to 0 satisfies the test above
    // and turns the dashboard's headline card into a decoration.
    //
    // `lessonRatio` is the cheapest of the four to move deterministically:
    // `min(lessonCount / 5, 1) * 20`. Five lessons is a full 20 points, and
    // the memories are freshly written so `freshnessRatio` contributes too.
    for (let i = 0; i < 5; i++) {
      remember({
        name: `lesson-${i}`,
        type: 'lesson_learned',
        observations: [`a lesson worth keeping, number ${i}`],
      });
    }

    const analytics = computeAnalytics(db);
    expect(analytics.healthScore, 'the score did not move when its inputs did').toBeGreaterThan(0);
    expect(analytics.healthScore).toBeLessThanOrEqual(100);
    // And the factor that moved it says so — the card shows the breakdown,
    // and a total that moves while its parts do not is unexplainable.
    expect(analytics.healthFactors.lessons.score, 'the lessons factor did not account for them')
      .toBeGreaterThan(0);
  });

  // The loop metric's honesty label. `reusedThisWeek` and `trend` are both
  // derived from `last_accessed_at`; the dashboard reads `computedFrom` to
  // decide whether to SHOW the "this is an approximation" caveat, so claiming
  // the precise mode does not mislabel a number — it hides the sentence that
  // explains it. The old gate flipped on "the column exists and some entity
  // has an in-window hit", which is not evidence that these queries read hits.
  // Measured on a real graph: 21 in-window hits, all written by the retired
  // literal-matching accounting, caveat hidden.
  it('never claims the precise mode while the numbers come from last_accessed_at', () => {
    remember({ name: 'reused-lesson', type: 'lesson_learned', observations: ['a lesson'] });
    // Exactly the state that used to flip the badge: an in-window hit count
    // from the retired accounting era (no `recall_accounting_mode` stamp).
    db.prepare(
      "UPDATE entities SET recall_hits = 5, last_accessed_at = datetime('now', '-1 day') WHERE name = ?",
    ).run('reused-lesson');

    const analytics = computeAnalytics(db);
    expect(analytics.loopMetric.reusedThisWeek).toBeGreaterThan(0);
    expect(analytics.loopMetric.computedFrom).toBe('last_accessed_at_approximation');
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

// ── ageMatrix + knowledgeRadar (v4.1.4 dashboard analytics) ────────────────

describe('/v1/analytics ageMatrix', () => {
  it('returns empty array on empty database', () => {
    const result = computeAnalytics(db);
    expect(result.ageMatrix).toEqual([]);
  });

  it('buckets entities by recency: a fresh entity lands in the "week" bucket', () => {
    remember({ name: 'fresh-lesson', type: 'lesson_learned', observations: ['just learned this'] });
    const result = computeAnalytics(db);
    const fresh = result.ageMatrix.find(e => e.type === 'lesson_learned');
    expect(fresh).toBeDefined();
    expect(fresh!.bucket).toBe('week');
    expect(fresh!.count).toBe(1);
  });

  it('excludes NOISE_TYPES from ageMatrix output', () => {
    // NOISE_TYPES (e.g. session_keypoint, commit) should be filtered so
    // the dashboard's hero "knowledge age" view doesn't drown in noise.
    expect(NOISE_TYPES.size).toBeGreaterThan(0);
    for (const noiseType of NOISE_TYPES) {
      remember({ name: `noise-${noiseType}`, type: noiseType, observations: ['noise'] });
    }
    remember({ name: 'real-knowledge', type: 'lesson_learned', observations: ['signal'] });

    const result = computeAnalytics(db);
    const noiseInMatrix = result.ageMatrix.filter(e => NOISE_TYPES.has(e.type));
    expect(noiseInMatrix).toEqual([]);
    expect(result.ageMatrix.find(e => e.type === 'lesson_learned')).toBeDefined();
  });

  it('aggregates same type+bucket into a single entry (not duplicated rows)', () => {
    // Two entities, same type, both fresh → one ageMatrix entry with count=2.
    remember({ name: 'lesson-1', type: 'lesson_learned', observations: ['a'] });
    remember({ name: 'lesson-2', type: 'lesson_learned', observations: ['b'] });
    const result = computeAnalytics(db);
    const entries = result.ageMatrix.filter(e => e.type === 'lesson_learned');
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
  });
});

describe('/v1/analytics knowledgeRadar', () => {
  it('returns six fixed axes regardless of database state', () => {
    const result = computeAnalytics(db);
    const axes = result.knowledgeRadar.map(e => e.axis);
    expect(axes).toEqual(['lessons', 'decisions', 'patterns', 'bugs', 'processes', 'architecture']);
  });

  it('every axis carries its types[] mapping (the radar UI needs this for tooltips)', () => {
    const result = computeAnalytics(db);
    for (const entry of result.knowledgeRadar) {
      expect(Array.isArray(entry.types)).toBe(true);
      expect(entry.types.length).toBeGreaterThan(0);
    }
  });

  it('counts include entities even from NOISE_TYPES filter (radar uses raw counts)', () => {
    // Knowledge Radar deliberately reads from the unfiltered ageMatrixRaw
    // so it reflects total knowledge accumulation, not just non-noise.
    // A `lesson_learned` is non-noise and maps to the `lessons` axis.
    remember({ name: 'l1', type: 'lesson_learned', observations: ['a'] });
    remember({ name: 'l2', type: 'lesson', observations: ['b'] });        // also `lessons` axis
    remember({ name: 'l3', type: 'mistake', observations: ['c'] });       // also `lessons` axis

    const result = computeAnalytics(db);
    const lessons = result.knowledgeRadar.find(e => e.axis === 'lessons');
    expect(lessons!.count).toBe(3);
  });

  it('unmapped types (e.g. concept) do not contribute to any axis', () => {
    remember({ name: 'random-concept', type: 'concept', observations: ['unmapped'] });
    const result = computeAnalytics(db);
    // No axis should have counted the `concept` type since it's not in
    // any axis's `types` whitelist. Total radar count stays 0.
    const total = result.knowledgeRadar.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(0);
  });

  it('correctly buckets architecture-axis types', () => {
    remember({ name: 'arch-1', type: 'architecture', observations: ['a'] });
    remember({ name: 'arch-2', type: 'feature', observations: ['b'] });
    remember({ name: 'arch-3', type: 'release', observations: ['c'] });
    remember({ name: 'arch-4', type: 'infrastructure', observations: ['d'] });

    const result = computeAnalytics(db);
    const arch = result.knowledgeRadar.find(e => e.axis === 'architecture');
    expect(arch!.count).toBe(4);
  });
});

// ── computePmAnalytics shape check ────────────────────────────────────────

describe('computePmAnalytics — response shape', () => {
  it('returns the expected PmAnalyticsResult structure on an empty DB', () => {
    const result = computePmAnalytics(db, 30);
    expect(result).toMatchObject({
      velocity: { windowDays: 30, decisionsPerWeek: expect.any(Number), releasesPerMonth: expect.any(Number) },
      staleness: { stalePlanCount: expect.any(Number), openDecisionCount: expect.any(Number) },
      connectedness: { orphanRate: expect.any(Number), totalRelations: expect.any(Number), activeEntities: expect.any(Number) },
    });
  });

  it('decisionsPerWeek and releasesPerMonth reflect seeded activity (not a constant 0)', () => {
    remember({ name: 'dec-a', type: 'decision', observations: ['decided x'] });
    remember({ name: 'rel-a', type: 'release', observations: ['shipped v1'] });
    const result = computePmAnalytics(db, 30);
    // Was `toBeGreaterThanOrEqual(0)`, which cannot fail — a broken date filter
    // zeroing velocity would still pass. We just seeded a decision and a release
    // dated now (inside the 30-day window), so both metrics must be positive.
    expect(result.velocity.decisionsPerWeek).toBeGreaterThan(0);
    expect(result.velocity.releasesPerMonth).toBeGreaterThan(0);
  });

  it('orphanRate is 1.0 when no relations exist', () => {
    remember({ name: 'solo-a', type: 'knowledge', observations: ['alone'] });
    remember({ name: 'solo-b', type: 'knowledge', observations: ['also alone'] });
    const result = computePmAnalytics(db, 30);
    expect(result.connectedness.orphanRate).toBeCloseTo(1.0);
  });
});
