// =============================================================================
// entity-index — an entity leaves BOTH search indexes as one act
// =============================================================================
//
// There are two indexes over `entities`, and they are separate tables that
// nothing joins: contentless `entities_fts` and the one whole-database
// `entities_vec`. Taking an entity out of circulation — archiving it, deleting
// it — means taking it out of both. Nothing in the schema enforces that, so
// every archive path had to remember, and three of the four did not:
//
//   src/core/lifecycle.ts       compressWeeklyNoise archived a week of noise
//                               with a bare UPDATE — neither index touched.
//   src/core/dreamer.ts         the compaction-digest apply loop, same shape.
//   src/storage/graph-repairs.ts  splitFusedLessons archives an emptied bucket.
//
// Measured on the maintainer's graph before this module existed: 413 of 1013
// vector rows and 213 FTS rows belonged to archived entities. 35.4% of every
// vector top-20 was spent on memories the user had already put away, and
// `MATCH 'ae83279'` still answered with the archived `commit-ae83279`.
//
// `KnowledgeGraph.archiveEntity` and `deleteEntity` already did the pair
// correctly. What was missing was an OWNER for the pair, so the rule had
// somewhere to live other than in four separate authors' memories. This is it.
//
// Not a fifth "just in case" guard: `vectorSearch` also pre-filters to active
// rows, and it has to, because this function cannot close every case. See
// `dropEntityFromIndexes` below for the one it structurally cannot.

import type { MemeshDatabase } from './sqlite.js';
import { hasVectorIndex } from './vector-index.js';
import { indexedObservationText, removeFromFts } from './fts-index.js';

/**
 * Drop an entity's row from `entities_vec`, if this process has an index.
 *
 * Asked (`hasVectorIndex`) rather than caught: a bare `try {} catch {}` would
 * swallow a real delete failure on a database that genuinely HAS an index.
 *
 * The early return is also a permanent leak, and it cannot be fixed here. On a
 * platform sqlite-vec publishes no binary for (musl, an unusual arch,
 * `npm ci --omit=optional`) the extension never loads, so an entity archived on
 * that machine keeps its vector — and the row is still there when the same file
 * is later opened where the binary IS present. No archive-path fix can reach
 * that row; `vectorSearch`'s active-only pre-filter and the one-shot repair in
 * `graph-repairs.ts` are what cover it.
 */
export function removeVectorRow(db: MemeshDatabase, entityId: number): void {
  if (!hasVectorIndex(db)) return;
  db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(entityId));
}

/**
 * Remove an entity from the keyword index and the vector index.
 *
 * `previousTitle` and the observation text are read from the database HERE, so
 * a caller cannot supply text that disagrees with what was indexed — which on
 * a contentless FTS5 table is the difference between a delete and a row that
 * survives every later rebuild. Callers that have already mutated the
 * observations must not use this function; they want `rebuildFts`, which takes
 * the previous text explicitly.
 *
 * Best-effort on the FTS side (see `removeFromFts`), authoritative on the
 * vector side. Callers should run it inside their own transaction alongside
 * the status change, so a partial archive cannot commit.
 */
export function dropEntityFromIndexes(
  db: MemeshDatabase,
  entityId: number,
  name: string,
): void {
  const titleRow = db
    .prepare('SELECT title FROM entities WHERE id = ?')
    .get(entityId) as { title: string | null } | undefined;
  removeFromFts(db, entityId, name, indexedObservationText(db, entityId), titleRow?.title ?? null);
  removeVectorRow(db, entityId);
}
