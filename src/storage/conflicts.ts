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

import type Database from 'better-sqlite3';

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
export function findConflicts(db: Database.Database, entityNames: string[]): string[] {
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
 * Increment access_count and refresh last_accessed_at for the given
 * entity ids. Called by every search/recall path so scoring can
 * factor recency + frequency.
 *
 * No-op for empty input. Wraps all updates in a single transaction so
 * partial failures roll back cleanly.
 */
export function trackAccess(db: Database.Database, entityIds: number[]): void {
  if (entityIds.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?',
  );
  const txn = db.transaction(() => {
    for (const id of entityIds) {
      stmt.run(now, id);
    }
  });
  txn();
}
