/**
 * The dreamer used to group entries by the ISO week they were written in.
 *
 * A calendar week is not a topic. Two unrelated pieces of work done on the
 * same Tuesday went into one digest, and one piece of work spanning a Friday
 * and the following Monday was split down the middle — the bucket boundary
 * cutting through the narrative it was supposed to summarise. Grouping is now
 * by stored embedding distance, with the project still a hard partition.
 *
 * These tests write vectors directly into `entities_vec` rather than calling an
 * embedder: the quantity under test is the CLUSTERING rule, and a test that
 * needed a live ollama would not run in CI. The vectors are placed on
 * orthogonal axes so "same topic" and "different topic" are unambiguous — the
 * shipped threshold comes from a measurement on a real graph, recorded on
 * `COMPACT_MAX_CLUSTER_DISTANCE`, not from these fixtures.
 */
import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { runDreamer } from '../../src/core/dreamer.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-dreamer-semantic-');

const DIM = 384; // the keyword-only default the test DB is created with

/** A unit vector on `axis`, nudged so members of a topic are not identical. */
function vectorOn(axis: number, nudge: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  v[(axis + 100) % DIM] = nudge; // ‖nudge‖ ≪ the 0.55 cut-off
  return v;
}

interface Seed { name: string; day: string; axis: number; nudge: number }

/** Compactable entities with an embedding, all in one project. */
function seed(entities: Seed[], opts: { withVectors?: boolean } = {}): void {
  const db = getDatabase();
  for (const e of entities) {
    db.prepare(
      "INSERT INTO entities (name, type, created_at, metadata) VALUES (?, 'commit', ?, ?)"
    ).run(e.name, `${e.day}T12:00:00.000Z`, JSON.stringify({ signal_score: 0.5 }));
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(e.name) as { id: number }).id;
    db.prepare("INSERT INTO tags (entity_id, tag) VALUES (?, 'project:demo')").run(id);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, `work on ${e.name}`);
    if (opts.withVectors !== false) {
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
        BigInt(id), // sqlite-vec rejects a JS number for a vec0 primary key
        Buffer.from(vectorOn(e.axis, e.nudge).buffer)
      );
    }
  }
}

/** Recent dates, so the dreamer's default window contains them. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

/**
 * A dreamer pass that forms clusters and stops before the network.
 *
 * `maxLlmCalls: 0` makes every cluster surface in `skipped` with its key, so
 * the grouping is observable without stubbing a provider.
 */
function dreamPass(opts: { maxLlmCalls?: number; dryRun?: boolean } = {}) {
  return runDreamer(getDatabase(), { provider: 'anthropic', apiKey: 'sk-test' }, {
    dryRun: opts.dryRun ?? true,
    maxLlmCalls: opts.maxLlmCalls ?? 0,
  });
}

describe('dreamer clusters by meaning, not by calendar week', () => {
  it('splits two unrelated topics recorded on the same day', async () => {
    // Six entries, one day, two subjects. The week bucket produced ONE cluster
    // of six and asked an LLM to find the narrative in it.
    seed([
      { name: 'auth-1', day: daysAgo(3), axis: 0, nudge: 0.05 },
      { name: 'auth-2', day: daysAgo(3), axis: 0, nudge: 0.10 },
      { name: 'auth-3', day: daysAgo(3), axis: 0, nudge: 0.15 },
      { name: 'css-1', day: daysAgo(3), axis: 1, nudge: 0.05 },
      { name: 'css-2', day: daysAgo(3), axis: 1, nudge: 0.10 },
      { name: 'css-3', day: daysAgo(3), axis: 1, nudge: 0.15 },
    ]);

    const result = await dreamPass();
    expect(result.clusteringMode).toBe('semantic');
    expect(result.clustersScanned, 'the two subjects were merged into one cluster').toBe(2);
  });

  it('keeps one topic together across a week boundary', async () => {
    // The dates straddle a Monday, so the old ISO-week key put these in two
    // buckets and no digest was ever proposed for either half.
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() - 1);
    const saturday = new Date(monday); saturday.setUTCDate(monday.getUTCDate() - 2);
    const tuesday = new Date(monday); tuesday.setUTCDate(monday.getUTCDate() + 1);

    seed([
      { name: 'migrate-1', day: iso(saturday), axis: 5, nudge: 0.05 },
      { name: 'migrate-2', day: iso(sunday), axis: 5, nudge: 0.08 },
      { name: 'migrate-3', day: iso(monday), axis: 5, nudge: 0.11 },
      { name: 'migrate-4', day: iso(tuesday), axis: 5, nudge: 0.14 },
    ]);

    const result = await dreamPass();
    expect(result.clusteringMode).toBe('semantic');
    expect(result.clustersScanned, 'the week boundary still cut the topic in two').toBe(1);
    // The label says the span, and the span crosses the boundary.
    const key = result.skipped.find(s => s.clusterKey)?.clusterKey ?? '';
    expect(key).toContain(iso(saturday));
    expect(key).toContain(iso(tuesday));
  });

  it('does not merge two projects however close their vectors are', async () => {
    // Identical vectors, different projects. Project stays a hard partition.
    seed([{ name: 'a-1', day: daysAgo(2), axis: 7, nudge: 0.05 }]);
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type, created_at, metadata) VALUES ('b-1', 'commit', ?, ?)")
      .run(`${daysAgo(2)}T12:00:00.000Z`, JSON.stringify({ signal_score: 0.5 }));
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'b-1'").get() as { id: number }).id;
    db.prepare("INSERT INTO tags (entity_id, tag) VALUES (?, 'project:other')").run(id);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'work on b-1');
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(id), Buffer.from(vectorOn(7, 0.05).buffer));

    const result = await dreamPass();
    expect(result.clustersScanned).toBe(2);
  });
});

describe('the distance cut-off is the shipped one', () => {
  /**
   * The orthogonal fixtures above separate topics at L2 ≈ 1.41 and hold
   * same-topic pairs under 0.10, so ANY threshold between roughly 0.12 and
   * 1.40 keeps every test in this file green. Measured: setting
   * `COMPACT_MAX_CLUSTER_DISTANCE` to 1.2 left all 38 dreamer tests passing.
   * A constant carrying a measured-not-guessed argument in its docstring needs
   * a test that fails when it moves, or the argument protects nothing.
   *
   * These two cases straddle 0.55 deliberately: 0.50 apart must merge, 0.60
   * apart must not. They fail if the cut-off moves in either direction.
   */
  function vectorAtDistance(d: number): Float32Array {
    // Distance from the all-zero seed vector is exactly `d` along one axis.
    const v = new Float32Array(DIM);
    v[42] = d;
    return v;
  }

  function seedPair(names: [string, string], distance: number): void {
    const db = getDatabase();
    const vectors = [new Float32Array(DIM), vectorAtDistance(distance)];
    names.forEach((name, i) => {
      db.prepare("INSERT INTO entities (name, type, created_at, metadata) VALUES (?, 'commit', ?, ?)")
        .run(name, `${daysAgo(3)}T12:0${i}:00.000Z`, JSON.stringify({ signal_score: 0.5 }));
      const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
      db.prepare("INSERT INTO tags (entity_id, tag) VALUES (?, 'project:demo')").run(id);
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, `work ${name}`);
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
        .run(BigInt(id), Buffer.from(vectors[i].buffer));
    });
  }

  it('merges a pair just inside it', async () => {
    seedPair(['near-a', 'near-b'], 0.50);
    const result = await dreamPass();
    expect(result.clusteringMode).toBe('semantic');
    expect(result.clustersScanned, 'a pair 0.50 apart should be one cluster at a 0.55 cut-off').toBe(1);
  });

  it('keeps a pair just outside it apart', async () => {
    seedPair(['far-a', 'far-b'], 0.60);
    const result = await dreamPass();
    expect(result.clusteringMode).toBe('semantic');
    expect(result.clustersScanned, 'a pair 0.60 apart should be two clusters at a 0.55 cut-off').toBe(2);
  });
});

describe('dreamer says when it could not group by meaning', () => {
  it('falls back to the calendar week and reports that it did', async () => {
    // The default configuration stores no embeddings at all, which is the
    // common case — the fallback has to be visible, not inferred from odd
    // digests.
    seed([
      { name: 'x-1', day: daysAgo(3), axis: 0, nudge: 0.05 },
      { name: 'x-2', day: daysAgo(3), axis: 1, nudge: 0.05 },
    ], { withVectors: false });

    const result = await dreamPass();
    expect(result.clusteringMode).toBe('calendar');
    expect(result.clusteringNote).toMatch(/calendar week/);
    expect(result.clusteringNote).toMatch(/embed/i);
  });

  it('counts the candidates it had to leave out', async () => {
    seed([
      { name: 'v-1', day: daysAgo(3), axis: 0, nudge: 0.05 },
      { name: 'v-2', day: daysAgo(3), axis: 0, nudge: 0.08 },
    ]);
    seed([{ name: 'v-3', day: daysAgo(3), axis: 0, nudge: 0.11 }], { withVectors: false });

    const result = await dreamPass();
    expect(result.clusteringMode).toBe('semantic');
    expect(result.clusteringNote).toMatch(/1 candidate had no embedding/);
  });
});

describe('proposals the old calendar rule left behind', () => {
  it('retires them instead of staging an overlapping twin', async () => {
    // Dedup needs an EXACT source-id match, and a semantic cluster is by
    // construction a different set from the week bucket it came out of. So
    // without retirement, upgrading stages a second proposal over overlapping
    // entities beside every one still pending — and accepting both runs
    // compaction twice over shared sources, where `compacted_into` is a plain
    // overwrite.
    seed([
      { name: 'w-1', day: daysAgo(4), axis: 9, nudge: 0.05 },
      { name: 'w-2', day: daysAgo(4), axis: 9, nudge: 0.08 },
    ]);
    const db = getDatabase();
    const ids = (db.prepare("SELECT id FROM entities WHERE name LIKE 'w-%' ORDER BY id").all() as Array<{ id: number }>)
      .map(r => r.id);
    db.prepare(
      "INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version) VALUES ('demo', '2026-W32', ?, '{}', 'v1')"
    ).run(JSON.stringify(ids));

    // Not a dry run: a dry run correctly writes nothing.
    const result = await dreamPass({ dryRun: false });

    const row = db.prepare("SELECT status, reason FROM dream_proposals WHERE cluster_key = '2026-W32'")
      .get() as { status: string; reason: string | null };
    expect(row.status, 'the calendar-era proposal is still pending beside its replacement').toBe('rejected');
    expect(row.reason).toMatch(/[Ss]uperseded by meaning-based clustering/);
    expect(result.skipped.some(s => /calendar-week clustering/.test(s.reason))).toBe(true);
  });

  it('leaves a semantic-era pending proposal alone', async () => {
    // The control. Retiring by key SHAPE must not touch the new keys — which
    // are dates plus a membership hash, never `YYYY-Wnn`.
    const db = getDatabase();
    db.prepare(
      "INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version) VALUES ('demo', '2026-08-04..2026-08-09-a3f1c2d4', '[1,2]', '{}', 'v1')"
    ).run();

    await dreamPass({ dryRun: false });
    const row = db.prepare("SELECT status FROM dream_proposals WHERE cluster_key LIKE '2026-08-04%'")
      .get() as { status: string };
    expect(row.status).toBe('pending');
  });
});

describe('cluster identity survives its label changing', () => {
  it('does not re-propose a pending cluster whose label would differ', async () => {
    seed([
      { name: 'p-1', day: daysAgo(4), axis: 3, nudge: 0.05 },
      { name: 'p-2', day: daysAgo(4), axis: 3, nudge: 0.08 },
      { name: 'p-3', day: daysAgo(4), axis: 3, nudge: 0.11 },
      { name: 'p-4', day: daysAgo(4), axis: 3, nudge: 0.14 },
      { name: 'p-5', day: daysAgo(4), axis: 3, nudge: 0.17 },
    ]);
    const db = getDatabase();
    const ids = (db.prepare("SELECT id FROM entities WHERE name LIKE 'p-%' ORDER BY id").all() as Array<{ id: number }>)
      .map(r => r.id);

    // A pending proposal covering exactly these entries, filed under a label
    // this run will never generate. Matching on the label would miss it and
    // spend an LLM call staging a duplicate.
    db.prepare(
      "INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version) VALUES ('demo', '2026-W01', ?, '{}', 'v1')"
    ).run(JSON.stringify(ids));

    const result = await dreamPass({ maxLlmCalls: 5 });
    expect(result.skipped.some(s => /pending proposal already exists/.test(s.reason))).toBe(true);
    // `llmCalls` alone would not prove this: a call that THREW also leaves the
    // counter at 0. The cluster must have been skipped before the network,
    // so no attempt may appear among the reasons either.
    expect(
      result.skipped.filter(s => /LLM call failed/.test(s.reason)),
      'the duplicate was sent to the LLM and merely failed'
    ).toHaveLength(0);
    expect(result.llmCalls).toBe(0);
  });
});
