// =============================================================================
// Conflict detection + access tracking — pure db-stateless helpers
// =============================================================================
//
// Both functions previously lived as instance methods on the
// `KnowledgeGraph` class. They never read class state beyond `this.db`,
// so extracting as free functions is mechanical and gives us:
//   - reusability from contexts that don't have a `KnowledgeGraph`
//     instance (analytics, future read-side modules)
//   - simpler unit tests (pass a Database directly)
//
// Public API on `KnowledgeGraph` is preserved via thin wrappers that
// delegate here.

import type { MemeshDatabase } from './sqlite.js';

/**
 * Find contradicting entity pairs among a set of result names.
 *
 * Looks for relations with type='contradicts' where both endpoints are
 * in the supplied name list. Returns human-readable strings for each
 * conflict, e.g. `"auth-decision-v1" contradicts "auth-decision-v2"`.
 *
 * Returns empty array when fewer than 2 names supplied (no pair to
 * contradict).
 */
export function findConflicts(db: MemeshDatabase, entityNames: string[]): string[] {
  if (entityNames.length < 2) return [];

  const conflicts: string[] = [];
  const placeholders = entityNames.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT e_from.name AS from_name, e_to.name AS to_name
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
    WHERE r.relation_type = 'contradicts'
      AND e_from.name IN (${placeholders})
      AND e_to.name IN (${placeholders})
  `).all(...entityNames, ...entityNames) as Array<{ from_name: string; to_name: string }>;

  for (const row of rows) {
    conflicts.push(`"${row.from_name}" contradicts "${row.to_name}"`);
  }

  return conflicts;
}

/**
 * Increment access_count and refresh last_accessed_at for the given entity ids.
 *
 * Called by every search/recall path so scoring can factor recency and
 * frequency. It deliberately does NOT touch `recall_hits`.
 *
 * `recall_hits` / `recall_misses` answer a different question — "was a memory we
 * injected actually used?" — and only the Stop hook can observe that, by
 * matching injected names against the session transcript
 * (`scripts/hooks/session-summary.js`). It is the only writer, and it writes
 * both sides. `scoring.ts::impactScore` reads the pair as a Laplace-smoothed
 * ratio, which is only meaningful if hits and misses come from the same
 * question.
 *
 * A retrieval path used to bump `recall_hits` too, under the reading "this
 * memory was pulled". That is a different definition, it can only ever add to
 * the hit side, and "was pulled" is already recorded — by `access_count`, in the
 * same statement. Measured on a real 91-entity database the two definitions had
 * not yet collided (29 hits against 365 misses; the impact factor's median sat
 * exactly at the neutral 0.5), but OR-joined query terms now return many more
 * rows per search, which is precisely when a one-sided writer starts to matter.
 *
 * No-op for empty input. Wraps all updates in a single transaction so partial
 * failures roll back cleanly.
 */
export function trackAccess(
  db: MemeshDatabase,
  entityIds: number[],
): void {
  if (entityIds.length === 0) return;
  const now = new Date().toISOString();
  // One statement, not one per entity: this runs on every search/recall
  // (including the session-start and pre-edit-recall hooks), and the id list
  // is bounded by the search limit (~20) — far under SQLite's bound-variable
  // cap. A single UPDATE is atomic, so no transaction wrapper is needed.
  const placeholders = entityIds.map(() => '?').join(',');
  try {
    db.prepare(
      `UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`,
    ).run(now, ...entityIds);
  } catch (error) {
    // Recall is still useful when a sandbox or snapshot permits SELECTs but
    // rejects this optional accounting write. Keep every other SQLite failure
    // visible: locks, corruption, missing schema, and disk errors are not a
    // read-only operating mode and must not be hidden.
    const message = error instanceof Error ? error.message : String(error);
    if (!/readonly database|SQLITE_READONLY/i.test(message)) throw error;
  }
}
