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
 * Best-effort: errors are swallowed because FTS row may not exist
 * (e.g. entity was archived previously). This matches every caller's
 * existing inline try/catch.
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
  } catch {
    // FTS row may not exist (archived already, schema race, etc.) — ignore.
  }
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
