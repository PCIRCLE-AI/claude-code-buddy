// Candidate generation for the contradiction-proposal pipeline (P1).
//
// Vectors are written directly into `entities_vec` (the same discipline as
// dreamer-semantic-clustering.test.ts): the module under test consumes the
// index, not an embedding provider, and a real provider would make these
// tests network-dependent and non-deterministic.
//
// Every seeded vector is UNIT LENGTH, deliberately. The module's d²/2
// conversion is only valid over unit vectors — the first version of this
// file seeded non-unit vectors and its gate test certified an exclusion the
// gate's definition does not make (a pair at true cosine distance 0.332,
// inside the 0.35 gate, pinned as excluded because its inflated L2 failed
// the converted bound). toVectorBlob now normalizes at the write chokepoint,
// but these tests bypass it by writing blobs directly, so they must honour
// the invariant themselves.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, closeDatabase } from '../../src/db.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import {
  findConflictCandidates,
  pairKey,
  CONFLICT_MAX_COSINE_DISTANCE,
  CONFLICT_SIGNAL_TYPES,
} from '../../src/core/conflict-candidates.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-conflict-cand-');

/** Keyword-only default width — see dreamer-semantic-clustering.test.ts for
 *  why this is 384 under the isolated runner and MUST stay so. */
const DIM = 384;

/** A UNIT vector on `axis` with a small nudge on a far axis, so same-axis
 *  vectors are near but not identical. Cosine distance between nudges a and
 *  b ≈ (a−b)²/2 for small nudges — comfortably inside 0.35. */
function vectorOn(axis: number, nudge: number): Float32Array {
  const v = new Float32Array(DIM);
  const norm = Math.hypot(1, nudge);
  v[axis] = 1 / norm;
  v[(axis + 50) % DIM] = nudge / norm;
  return v;
}

/** A unit vector at angle `deg` in the plane spanned by axes a1/a2 —
 *  cosine distance to the 0° vector is exactly 1 − cos(deg). */
function vectorAtAngle(a1: number, a2: number, deg: number): Float32Array {
  const v = new Float32Array(DIM);
  const rad = (deg * Math.PI) / 180;
  v[a1] = Math.cos(rad);
  v[a2] = Math.sin(rad);
  return v;
}

function seedVec(name: string, type: string, vec: Float32Array): number {
  const db = getDatabase();
  db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(name, type);
  const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
  db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
    BigInt(id),
    Buffer.from(vec.buffer),
  );
  return id;
}

function seedEntity(name: string, type: string, axis: number, nudge: number): number {
  return seedVec(name, type, vectorOn(axis, nudge));
}

describe('findConflictCandidates', () => {
  it('derives its signal types from the dreamer partition — the high-value claim types are present', () => {
    // The first hand-written copy of this list omitted exactly these four.
    for (const t of ['release', 'plan', 'technical_pattern', 'best_practice', 'decision', 'lesson_learned', 'fact', 'note']) {
      expect(CONFLICT_SIGNAL_TYPES).toContain(t);
    }
    for (const t of ['commit', 'session-insight', 'weekly-summary', 'digest']) {
      expect(CONFLICT_SIGNAL_TYPES).not.toContain(t);
    }
  });

  it('pairs near signal entities and reports COSINE distance, not raw L2', () => {
    const a = seedEntity('decision-old', 'decision', 3, 0.05);
    const b = seedEntity('decision-new', 'decision', 3, 0.15);
    seedEntity('unrelated-fact', 'fact', 200, 0.05); // far axis — no pair

    const out = findConflictCandidates(getDatabase());
    expect(out).toHaveLength(1);
    expect([out[0].aId, out[0].bId].sort()).toEqual([a, b].sort());
    // The vec index returns L2; the module must hand back cosine (1 − cos).
    // For these two vectors cosine distance ≈ 0.005 — an unconverted L2
    // (≈ 0.1) would still pass a sloppy "< 0.35" assertion, so pin the
    // magnitude tightly enough to catch the missing d²/2.
    expect(out[0].cosineDistance).toBeGreaterThan(0);
    expect(out[0].cosineDistance).toBeLessThan(0.01);
  });

  it('episodic types never enter the candidate set, however close', () => {
    seedEntity('session-a', 'session-insight', 7, 0.01);
    seedEntity('session-b', 'session-insight', 7, 0.02);
    seedEntity('weekly-1', 'weekly-summary', 7, 0.03);

    expect(findConflictCandidates(getDatabase())).toHaveLength(0);
  });

  it('a signal entity near an episodic one produces no cross-kind pair', () => {
    seedEntity('real-decision', 'decision', 9, 0.01);
    seedEntity('session-echo', 'session-insight', 9, 0.02);

    expect(findConflictCandidates(getDatabase())).toHaveLength(0);
  });

  it('episodic rows cannot crowd signal partners out of the KNN slots', () => {
    // Four episodic rows sit CLOSER to each decision than the decisions sit
    // to each other. A global KNN at k=3 hands every slot to the episodic
    // rows and this pair — cosine distance 0.02, the tightest kind of
    // conflict material — never surfaces from either endpoint. The
    // `rowid IN` constraint keeps the search inside signal rows.
    const a = seedVec('decision-a', 'decision', vectorAtAngle(30, 31, 0));
    for (let i = 1; i <= 4; i++) {
      seedVec(`noise-${i}`, 'session-insight', vectorAtAngle(30, 31, i));
    }
    const b = seedVec('decision-b', 'decision', vectorAtAngle(30, 31, 11.5));

    const out = findConflictCandidates(getDatabase());
    expect(out).toHaveLength(1);
    expect([out[0].aId, out[0].bId].sort()).toEqual([a, b].sort());
  });

  it('holds the per-entity bound even when identical embeddings displace the self row', () => {
    // sqlite-vec breaks distance ties by DESCENDING rowid, so among six
    // byte-identical embeddings the low-rowid entities' own rows fall out of
    // LIMIT k+1 entirely. Without the post-filter slice each such entity
    // contributes k+1 neighbours (14 distinct pairs on this fixture); the
    // slice pins the bound back to k (12). The exact count is derived from
    // that tie-break — every query returns [6,5,4,3], minus self, sliced to
    // 3 — so re-derive it if a sqlite-vec upgrade changes tie-breaking.
    for (let i = 1; i <= 6; i++) {
      seedVec(`dup-${i}`, 'fact', vectorAtAngle(40, 41, 25));
    }
    const out = findConflictCandidates(getDatabase());
    expect(out).toHaveLength(12);
    for (const c of out) {
      expect(c.cosineDistance).toBeCloseTo(0, 5);
      expect(c.aId).not.toBe(c.bId);
    }
  });

  it('pairs already related by supersedes or contradicts are excluded', () => {
    const db = getDatabase();
    const a = seedEntity('lesson-v1', 'lesson_learned', 11, 0.02);
    const b = seedEntity('lesson-v2', 'lesson_learned', 11, 0.08);
    db.prepare(
      "INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, 'contradicts')",
    ).run(b, a);

    expect(findConflictCandidates(db)).toHaveLength(0);
  });

  it('pairs already judged are excluded — UNRELATED must not be re-bought', () => {
    const db = getDatabase();
    const a = seedEntity('fact-x', 'fact', 13, 0.02);
    const b = seedEntity('fact-y', 'fact', 13, 0.09);
    db.prepare(
      "INSERT INTO conflict_judged_pairs (pair_key, verdict) VALUES (?, 'unrelated')",
    ).run(pairKey(a, b));

    expect(findConflictCandidates(db)).toHaveLength(0);
  });

  it('the distance gate admits true same-topic pairs and rejects same-domain-only pairs', () => {
    // Unit vectors at explicit angles: cosine distance to 0° is 1 − cos θ.
    // 48° → 0.331, INSIDE the 0.35 gate — the pre-fix version of this test
    // pinned a pair like this one as excluded, because its non-unit vectors
    // inflated the L2 the gate saw. 60° → 0.5, outside from both others.
    const a = seedVec('claim-base', 'decision', vectorAtAngle(17, 18, 0));
    const b = seedVec('claim-near', 'decision', vectorAtAngle(17, 18, 48));
    seedVec('claim-far', 'decision', vectorAtAngle(17, 18, -60));

    const out = findConflictCandidates(getDatabase());
    expect(out).toHaveLength(1);
    expect([out[0].aId, out[0].bId].sort()).toEqual([a, b].sort());
    expect(out[0].cosineDistance).toBeGreaterThan(0.32);
    expect(out[0].cosineDistance).toBeLessThanOrEqual(CONFLICT_MAX_COSINE_DISTANCE);
  });

  it('respects the limit option and sorts tightest-first', () => {
    seedEntity('p1a', 'fact', 21, 0.01);
    seedEntity('p1b', 'fact', 21, 0.02); // very tight pair
    seedEntity('p2a', 'fact', 23, 0.01);
    seedEntity('p2b', 'fact', 23, 0.4);  // looser pair, still inside gate

    const all = findConflictCandidates(getDatabase());
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].cosineDistance).toBeLessThanOrEqual(all[1].cosineDistance);

    const limited = findConflictCandidates(getDatabase(), { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].cosineDistance).toBe(all[0].cosineDistance);
  });

  it('returns [] — not a throw — when the catalogue lists entities_vec but the vec0 module is absent', () => {
    // hasVectorIndex answers from sqlite_master, which persists in the file.
    // A database created where sqlite-vec loaded, reopened on a platform
    // where the binary is missing, passes that check and then throws on
    // first touch of the virtual table. That throw must be absorbed as the
    // keyword-only answer; any other error must still surface.
    seedEntity('decision-x', 'decision', 3, 0.05);
    seedEntity('decision-y', 'decision', 3, 0.15);
    closeDatabase();

    const raw = new DatabaseSync(dbHandle.dbPath); // no allowExtension: vec0 cannot load
    try {
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE name = 'entities_vec'").get(),
      ).toBeTruthy();
      expect(() => raw.prepare('SELECT count(*) AS c FROM entities_vec').get()).toThrow(/no such module/);
      expect(findConflictCandidates(raw as unknown as MemeshDatabase)).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
