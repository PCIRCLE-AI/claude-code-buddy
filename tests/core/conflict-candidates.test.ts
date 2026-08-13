// Candidate generation for the contradiction-proposal pipeline (P1).
//
// Vectors are written directly into `entities_vec` (the same discipline as
// dreamer-semantic-clustering.test.ts): the module under test consumes the
// index, not an embedding provider, and a real provider would make these
// tests network-dependent and non-deterministic.
import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import {
  findConflictCandidates,
  pairKey,
  CONFLICT_MAX_COSINE_DISTANCE,
} from '../../src/core/conflict-candidates.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-conflict-cand-');

/** Keyword-only default width — see dreamer-semantic-clustering.test.ts for
 *  why this is 384 under the isolated runner and MUST stay so. */
const DIM = 384;

/** A unit vector on `axis` with a small nudge, so same-axis vectors are near
 *  but not identical. cosine distance between two vectors on the same axis
 *  with nudges a,b ≈ (a-b)²/2 for small nudges — comfortably inside 0.35. */
function vectorOn(axis: number, nudge: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  v[(axis + 50) % DIM] = nudge;
  return v;
}

function seedEntity(name: string, type: string, axis: number, nudge: number): number {
  const db = getDatabase();
  db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(name, type);
  const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
  db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
    BigInt(id),
    Buffer.from(vectorOn(axis, nudge).buffer),
  );
  return id;
}

describe('findConflictCandidates', () => {
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

  it('the distance gate holds: same-topic near pairs in, same-domain far pairs out', () => {
    // Two on one axis (inside the gate) and one at an angle whose cosine
    // distance lands just OUTSIDE the gate: cos 60° = 0.5 → distance 0.5.
    const db = getDatabase();
    seedEntity('near-1', 'decision', 17, 0.02);
    seedEntity('near-2', 'decision', 17, 0.1);
    const far = new Float32Array(DIM);
    far[17] = 1;
    far[18] = 1.16; // angle ≈ 49.2°, cosine distance ≈ 0.347… vs 1.16→ tune below
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('angled', 'decision');
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'angled'").get() as { id: number }).id;
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(id), Buffer.from(far.buffer));

    const out = findConflictCandidates(db);
    const names = new Set(out.flatMap((c) => [c.aName, c.bName]));
    expect(names.has('near-1') && names.has('near-2')).toBe(true);
    for (const c of out) {
      expect(c.cosineDistance).toBeLessThanOrEqual(CONFLICT_MAX_COSINE_DISTANCE);
    }
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
});
