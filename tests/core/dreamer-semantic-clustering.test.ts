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

/**
 * A real pass that WRITES: the network is stubbed to always return one ADD, so
 * a proposal is genuinely staged and the retirement path can be observed.
 */
async function dreamPassWithLlm() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ text: JSON.stringify({ action: 'ADD', digest: { name: 'digest', type: 'digest', observations: ['summary'], tags: [] } }) }],
    }),
    text: async () => '',
  })) as unknown as typeof fetch;
  try {
    return await runDreamer(getDatabase(), { provider: 'anthropic', apiKey: 'sk-test' }, { maxLlmCalls: 5 });
  } finally {
    globalThis.fetch = realFetch;
  }
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

  it('week-buckets the candidates it cannot place by meaning, rather than dropping them', async () => {
    // Partial coverage is the NORMAL state: the capture hooks write entities
    // without embedding them, and `reindex` is a manual command. Semantic mode
    // used to be chosen if ANY candidate had a vector and then discard the
    // rest — measured, ONE embedded entity among ten dropped the other nine
    // and took the run from one proposal to none. Every candidate is now
    // grouped by the best rule available to it.
    seed([
      { name: 'v-1', day: daysAgo(3), axis: 0, nudge: 0.05 },
      { name: 'v-2', day: daysAgo(3), axis: 0, nudge: 0.08 },
    ]);
    seed([{ name: 'v-3', day: daysAgo(3), axis: 0, nudge: 0.11 }], { withVectors: false });

    const result = await dreamPass();
    expect(result.clusteringMode).toBe('semantic');
    expect(result.clusteringNote).toMatch(/1 candidate has no embedding/);
    expect(result.clusteringNote).toMatch(/grouped by calendar week/);

    // Two clusters: the embedded pair by meaning, the unembedded one by week.
    // A count of 1 would mean the unembedded candidate was thrown away.
    expect(result.clustersScanned, 'the unembedded candidate was dropped').toBe(2);
  });
});

describe('more candidates than fit in one SQL statement', () => {
  it('loads every vector across chunk boundaries', async () => {
    // Vectors were fetched with one placeholder per candidate. SQLite's
    // ceiling is 32766 — past it the statement throws, the catch turned that
    // into "no vector index", and the graph large enough to need semantic
    // clustering was the one that silently lost it. The lookup is chunked now,
    // and the risk moves to the chunk loop: an off-by-one there drops vectors
    // for whole chunks, which would show up as a fall back to calendar mode or
    // as candidates counted "without embedding".
    const CHUNK = 500;
    const total = CHUNK + 100;
    const db = getDatabase();
    const day = daysAgo(3);
    for (let i = 0; i < total; i++) {
      const name = `bulk-${i}`;
      db.prepare("INSERT INTO entities (name, type, created_at, metadata) VALUES (?, 'commit', ?, ?)")
        .run(name, `${day}T12:00:00.000Z`, JSON.stringify({ signal_score: 0.5 }));
      const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
      db.prepare("INSERT INTO tags (entity_id, tag) VALUES (?, 'project:demo')").run(id);
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, `work ${i}`);
      // All on one axis, so they form a single cluster and every one of them
      // must have been read for the count below to come out right.
      const v = new Float32Array(DIM);
      v[3] = 1;
      v[4] = (i % 10) * 0.001;
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
        .run(BigInt(id), Buffer.from(v.buffer));
    }

    const result = await dreamPass();
    expect(result.clusteringMode, 'the chunked lookup fell back to calendar mode').toBe('semantic');
    expect(result.clusteringNote, 'vectors went missing across a chunk boundary').toBeUndefined();
    expect(result.clustersScanned).toBe(1);
  });
});

describe('proposals the old calendar rule left behind', () => {
  /**
   * Retirement is TERMINAL — `applyProposal` requires `pending` and nothing
   * sets a proposal back — so it may only happen at the moment a replacement
   * is actually written. Two earlier versions rejected on the strength of a
   * replacement that had not happened: one before clustering (which on a
   * default install re-created the very key shape it retired, forever), one
   * after clustering but before the LLM loop (where a cluster can still be
   * dropped for size, the call cap, an error, a NOOP or the validator).
   */
  function seedTopic(names: string[]): number[] {
    seed(names.map((name, i) => ({ name, day: daysAgo(3), axis: 3, nudge: 0.05 + i * 0.01 })));
    const db = getDatabase();
    return (db.prepare('SELECT id FROM entities WHERE name IN (' + names.map(() => '?').join(',') + ') ORDER BY id')
      .all(...names) as Array<{ id: number }>).map(r => r.id);
  }

  function stageCalendarProposal(sourceIds: number[], key = '2026-W32'): void {
    getDatabase().prepare(
      "INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version) VALUES ('demo', ?, ?, '{}', 'v1')"
    ).run(key, JSON.stringify(sourceIds));
  }

  it('retires one only when a digest that covers it was actually written', async () => {
    // The week bucket held 3 of the 5; the semantic cluster spans all 5, so
    // dedup does not match and a genuine replacement is written.
    const ids = seedTopic(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);
    stageCalendarProposal(ids.slice(0, 3));
    stageCalendarProposal([90001], '2026-W29'); // covers nothing in this run

    const result = await dreamPassWithLlm();
    expect(result.proposalsCreated, 'no replacement was written, so nothing may be retired').toBe(1);

    const db = getDatabase();
    const covered = db.prepare("SELECT status FROM dream_proposals WHERE cluster_key = '2026-W32'").get() as { status: string };
    const uncovered = db.prepare("SELECT status FROM dream_proposals WHERE cluster_key = '2026-W29'").get() as { status: string };
    expect(covered.status).toBe('rejected');
    expect(uncovered.status, 'a proposal this digest does not cover was retired anyway').toBe('pending');
  });

  it('leaves the proposal alone when the cluster never becomes a digest', async () => {
    // Four entries form one cluster, below COMPACT_MIN_CLUSTER_SIZE, so the
    // run writes nothing. Measured before the fix: the proposal was rejected
    // and the SAME result also said "cluster smaller than 5 entities" — two
    // reasons contradicting each other, and a paid-for digest unrecoverable.
    const ids = seedTopic(['n-1', 'n-2', 'n-3', 'n-4']);
    stageCalendarProposal(ids);

    const result = await dreamPassWithLlm();
    expect(result.proposalsCreated).toBe(0);

    const row = getDatabase().prepare("SELECT status FROM dream_proposals WHERE cluster_key = '2026-W32'").get() as { status: string };
    expect(row.status, 'a proposal was retired with nothing replacing it').toBe('pending');
  });

  it('supersedes a narrower pending proposal when the cluster grows', async () => {
    // Not an upgrade case — this arises on its own. Cluster membership is a
    // topic, unbounded in time, so ONE new similar entry recorded later
    // re-opens a cluster that already has a pending proposal. The exact-match
    // dedup misses (different source set), a wider twin is staged, and
    // accepting both compacts the shared entries twice — `compacted_into` is
    // a plain overwrite. The wider digest supersedes the narrower proposal.
    const ids = seedTopic(['g-1', 'g-2', 'g-3', 'g-4', 'g-5']);
    // A SEMANTIC-era key, so this is not the calendar migration path.
    getDatabase().prepare(
      "INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version) VALUES ('demo', '2026-07-11..2026-07-13-dd5b1f44', ?, '{}', 'v1')"
    ).run(JSON.stringify(ids));
    seedTopic(['g-6']); // same topic, joins the cluster

    const result = await dreamPassWithLlm();
    expect(result.proposalsCreated).toBe(1);

    const pending = getDatabase()
      .prepare("SELECT COUNT(*) c FROM dream_proposals WHERE status = 'pending'")
      .get() as { c: number };
    expect(pending.c, 'an overlapping twin was left pending beside the wider digest').toBe(1);
  });

  it('retires nothing in calendar mode, where it would eat its own output', async () => {
    // Without vectors the fallback writes ISO-week keys itself, so a
    // retirement keyed on that shape rejects the proposal THIS run just
    // wrote. Measured before the guard: run 1 created #1 and rejected it, and
    // so did every run after — one metered LLM call each, nothing reviewable.
    seed([
      { name: 'cal-1', day: daysAgo(3), axis: 0, nudge: 0.05 },
      { name: 'cal-2', day: daysAgo(3), axis: 0, nudge: 0.08 },
      { name: 'cal-3', day: daysAgo(3), axis: 0, nudge: 0.11 },
      { name: 'cal-4', day: daysAgo(3), axis: 0, nudge: 0.14 },
      { name: 'cal-5', day: daysAgo(3), axis: 0, nudge: 0.17 },
    ], { withVectors: false });

    const result = await dreamPassWithLlm();
    expect(result.clusteringMode).toBe('calendar');
    expect(result.proposalsCreated).toBe(1);

    const rows = getDatabase().prepare("SELECT status FROM dream_proposals").all() as Array<{ status: string }>;
    expect(rows.map(r => r.status), 'calendar mode retired the proposal it just wrote').toEqual(['pending']);
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
