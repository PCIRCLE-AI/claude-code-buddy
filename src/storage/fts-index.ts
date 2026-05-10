// =============================================================================
// FTS5 index helpers — contentless-FTS5 delete + insert primitives
// =============================================================================
//
// SQLite's `content=''` FTS5 mode requires that deletes supply the
// previously-indexed column values (otherwise the row stays in the
// index). The pattern is:
//
//   INSERT INTO entities_fts(entities_fts, rowid, name, observations)
//   VALUES('delete', <rowid>, <previous-name>, <previous-obs-text>);
//   INSERT INTO entities_fts(rowid, name, observations) VALUES(?, ?, ?);
//
// This dance is identical at every call site. Centralizing it here:
//   - removes a documented drift hazard (4 inline copies in
//     knowledge-graph.ts + lifecycle.ts)
//   - gives a single place to bump if FTS schema changes
//   - keeps the helpers parameterless from `KnowledgeGraph`-state so
//     they can be called from non-class contexts (lifecycle.ts)

import type Database from 'better-sqlite3';

/**
 * Remove a row from the contentless FTS5 index. Caller must supply the
 * previously-indexed name + observation text — that's what FTS5
 * requires to find the row in `content=''` mode.
 *
 * Best-effort: this function MUST NOT throw, because callers (e.g.
 * `archiveEntity`, `rebuildFts`) treat FTS maintenance as a side
 * concern of the primary DB write — failing the whole operation
 * because the index is wedged would lose user data on the entities
 * table. But the prior implementation swallowed *every* exception
 * silently, including real DB faults (lock contention, disk full,
 * schema corruption), which let the index drift out of sync with
 * the entities table with no operator signal.
 *
 * Now we still never throw, but we log a single-line warning to
 * stderr for any error that isn't the documented "no row to delete"
 * benign case (FTS5 'delete' is idempotent for missing rowids — that
 * one is genuinely safe to ignore).
 */
export function removeFromFts(
  db: Database.Database,
  entityId: number,
  name: string,
  prevObsText: string,
): void {
  try {
    db.prepare(
      "INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)",
    ).run(entityId, name, prevObsText);
  } catch (err) {
    if (isBenignFtsDeleteError(err)) return;
    // Real failure — log so an operator sees the index drift signal
    // instead of discovering it later via stale search results.
    process.stderr.write(
      `[memesh fts-index] removeFromFts(rowid=${entityId}) failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/**
 * FTS5 contentless `'delete'` raises SQLITE_ERROR with a "database
 * disk image is malformed" or "no such rowid" style message when the
 * indexed (name, observations) values don't match what the index has
 * stored for the rowid. That's still benign in our schema: the entity
 * either was never indexed (e.g. status='archived' from migration) or
 * was already cleaned up by a prior call. We treat those as no-ops.
 *
 * Anything else — disk full, locked DB, malformed schema, foreign-key
 * cascade failure — should reach the operator.
 */
function isBenignFtsDeleteError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  // "no such rowid" — FTS row never existed, idempotent delete.
  // "values do not match" / "no such row" — caller's recorded values
  //    drifted from what FTS stored (entity edited outside the helper);
  //    rebuildFts will reindex the row anyway.
  // We deliberately do NOT classify "database is locked", "disk I/O",
  // "disk image is malformed", or "no such table" as benign. Those
  // are real DB faults the operator must see.
  return /no such rowid|values do not match|no such row\b/i.test(msg);
}

/**
 * Insert a fresh row into the FTS5 index. Used after `removeFromFts`
 * when re-indexing an entity, or standalone for a brand-new entity
 * that has no prior FTS row (e.g. weekly-summary entities created in
 * lifecycle.ts).
 */
export function insertFtsRow(
  db: Database.Database,
  entityId: number,
  name: string,
  observationsText: string,
): void {
  db.prepare(
    'INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)',
  ).run(entityId, name, observationsText);
}
