// =============================================================================
// Conflict-candidate generation — the cheap, deterministic half of the
// contradiction-proposal pipeline (P1).
// =============================================================================
//
// `findConflicts` (src/storage/conflicts.ts) reports pairs related by
// `contradicts` — but nothing in the system has ever CREATED that relation
// automatically, so in practice it always returned empty (verified
// 2026-08-13). This module is the first half of closing that gap: enumerate
// the pairs WORTH judging. The second half (an LLM judging each candidate as
// CONTRADICTS / SUPERSEDES / DUPLICATE / UNRELATED and staging a proposal for
// human review) is P2; nothing here writes anything.
//
// Design, from measurement on the real 761-entity graph (2026-08-13):
//   - Raw nearest-neighbour pairs explode: at cosine distance ≤ 0.55 the
//     144 embedded entities produced 9,997 pairs — 97% of the complete
//     graph. The tightest pairs were all same-kind EPISODIC rows
//     (session-insight × session-insight, weekly-summary × weekly-summary):
//     periodic auto-capture, not contradiction material. So candidates are
//     gated to SIGNAL types first — that alone cut the field to 69 entities
//     and made the tight pairs readable as duplicate / complementary /
//     potentially-contradictory material.
//   - 0.35 keeps ~160 signal pairs on that graph; per-entity top-k keeps the
//     list from scaling quadratically as the library grows. The clustering
//     threshold (0.55, dreamer.ts) answers a DIFFERENT question — "same
//     topic, same story" — and must not be borrowed here.
//
// Distance units, explicitly: `entities_vec` MATCH returns L2 distance over
// normalized embeddings; cosine distance = d²/2 (see the derivation at the
// top of embedder.ts, which also records the bug shipped by conflating the
// two scales). Every threshold in this module is COSINE distance; the L2
// conversion happens in exactly one place below.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { hasVectorIndex } from '../storage/vector-index.js';

/**
 * The types worth judging for contradictions: durable, human-meaningful
 * claims. Episodic auto-capture (commits, session notes, weekly summaries)
 * is excluded — near-identical episodic rows are periodicity, not
 * disagreement, and they drowned the candidate list when included.
 */
export const CONFLICT_SIGNAL_TYPES = [
  'decision',
  'lesson_learned',
  'lesson',
  'fact',
  'architecture',
  'architecture_decision',
  'pattern',
  'note',
] as const;

/**
 * Candidate gate, in COSINE distance (1 − cos). Measured 2026-08-13 on the
 * real graph: ≤ 0.30 → 68 signal pairs, ≤ 0.35 → 160, ≤ 0.40 → 535. 0.35 is
 * where the sampled tail still read as same-subject material; beyond it the
 * pairs drift to merely same-domain. The number belongs to this embedder
 * (768-dim); re-measure before changing embedders.
 */
export const CONFLICT_MAX_COSINE_DISTANCE = 0.35;

/** Nearest neighbours considered per entity — keeps candidate volume linear
 *  in library size instead of quadratic. */
export const CONFLICT_NEIGHBORS_PER_ENTITY = 3;

export interface ConflictCandidate {
  aId: number;
  aName: string;
  aType: string;
  bId: number;
  bName: string;
  bType: string;
  /** Cosine distance (1 − cos), NOT the raw L2 the vec index returns. */
  cosineDistance: number;
}

/** Stable identity for a pair, independent of direction. NOT the dreamer's
 *  cluster_key — cluster membership drifts; an id pair does not. */
export function pairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/**
 * Enumerate candidate pairs worth judging for contradiction.
 *
 * Read-only. Excludes: self-pairs, pairs already related by
 * supersedes/contradicts (already resolved by a human or an accepted
 * proposal), and pairs already judged (conflict_judged_pairs — a pair the
 * LLM called UNRELATED must not be re-bought every run).
 *
 * Returns [] when the vector index is unavailable (keyword-only installs):
 * candidates come from embeddings, and an empty list is the honest answer —
 * not an error, and never a fallback to a weaker similarity.
 */
export function findConflictCandidates(
  db: MemeshDatabase,
  opts: {
    maxCosineDistance?: number;
    neighborsPerEntity?: number;
    limit?: number;
  } = {},
): ConflictCandidate[] {
  const maxCos = opts.maxCosineDistance ?? CONFLICT_MAX_COSINE_DISTANCE;
  const k = opts.neighborsPerEntity ?? CONFLICT_NEIGHBORS_PER_ENTITY;

  if (!hasVectorIndex(db)) return [];

  const typePlaceholders = CONFLICT_SIGNAL_TYPES.map(() => '?').join(',');
  const signal = db.prepare(
    `SELECT v.rowid AS id, v.embedding AS emb, e.name, e.type
     FROM entities_vec v
     JOIN entities e ON e.id = v.rowid
     WHERE e.status = 'active' AND e.type IN (${typePlaceholders})`,
  ).all(...CONFLICT_SIGNAL_TYPES) as Array<{ id: number; emb: Uint8Array; name: string; type: string }>;
  if (signal.length < 2) return [];

  const byId = new Map(signal.map((s) => [s.id, s]));

  const excluded = new Set<string>();
  for (const r of db.prepare(
    `SELECT from_entity_id AS a, to_entity_id AS b FROM relations
     WHERE relation_type IN ('supersedes', 'contradicts')`,
  ).all() as Array<{ a: number; b: number }>) {
    excluded.add(pairKey(r.a, r.b));
  }
  for (const r of db.prepare(
    'SELECT pair_key FROM conflict_judged_pairs',
  ).all() as Array<{ pair_key: string }>) {
    excluded.add(r.pair_key);
  }

  // COSINE gate expressed on the L2 scale the index searches in — the one
  // place the conversion happens: d_l2 = sqrt(2 * d_cos).
  const maxL2 = Math.sqrt(2 * maxCos);

  const knn = db.prepare(
    'SELECT rowid AS id, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
  );

  const seen = new Set<string>();
  const out: ConflictCandidate[] = [];
  for (const s of signal) {
    // k+1 because the entity's own row comes back at distance 0.
    const hits = knn.all(s.emb, k + 1) as Array<{ id: number; distance: number }>;
    for (const hit of hits) {
      if (hit.id === s.id) continue;
      if (hit.distance > maxL2) continue;
      const other = byId.get(hit.id);
      if (!other) continue; // neighbour is not a signal-type entity
      const key = pairKey(s.id, hit.id);
      if (seen.has(key) || excluded.has(key)) continue;
      seen.add(key);
      out.push({
        aId: Math.min(s.id, other.id),
        aName: s.id < other.id ? s.name : other.name,
        aType: s.id < other.id ? s.type : other.type,
        bId: Math.max(s.id, other.id),
        bName: s.id < other.id ? other.name : s.name,
        bType: s.id < other.id ? other.type : s.type,
        cosineDistance: (hit.distance * hit.distance) / 2,
      });
    }
  }

  out.sort((x, y) => x.cosineDistance - y.cosineDistance);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}
