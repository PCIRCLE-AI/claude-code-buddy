// =============================================================================
// One-shot repairs for data that 4.8.1 and earlier wrote wrongly
// =============================================================================
//
// v4.8.2 fixed two memory-layer defects (#240, #241). Both fixes stop the
// wrong rows from being written; neither touches the rows already there. On
// the maintainer's own graph that was 706 duplicate observations across
// session summaries and four `-other` lesson entities holding 39 unrelated
// lessons — and every graph that ran 4.8.1 hooks carries the same shape.
// A fix that only prevents new damage leaves `scripts/audit/memory-invariants.mjs`
// red on every existing install forever, and leaves recall matching the fused
// buckets (retrieved 61 times, matched 3) instead of the lessons in them.
//
// So the data is repaired here, once, at the first open after upgrade — the
// same place and the same shape as every other backfill in db.ts: a
// `runOnceMigration` keyed in `memesh_metadata`, transactional, non-fatal.
//
// Three passes, each owning exactly one invariant from memory-invariants.mjs:
//
//   dedupeSessionObservations  → stop-summary-no-duplicate-observations
//   retractZeroEditClaims      → stop-summary-does-not-assert-zero-edits-for-bash-sessions
//   splitFusedLessons          → explicit-lessons-not-fused-into-other-bucket
//
// What each pass does NOT do, and why:
//   - The dedupe keeps the lowest id of each (entity, content) pair and leaves
//     the entity's vector alone: the set of sentences is unchanged, so the
//     embedding of "name + observations" is the same text minus repeats.
//   - The split moves observation ROWS rather than copying them, so ids and
//     created_at survive and nothing is re-authored. The bucket keeps its
//     first lesson and every column that cannot be attributed to one lesson
//     (access counts, confidence, recall stats). Its vector is dropped, the
//     new entities get none, and `pending_reindex` is marked — the same flag
//     `memesh reindex` already clears — because a vector for the wrong text
//     is worse than none.
//   - FTS is rebuilt whole (`rebuildFtsIndex`, the same call the segmentation
//     migration makes) rather than patched row by row. `entities_fts` is
//     contentless: a delete must repeat the exact text that was indexed, and a
//     row the hook wrote without indexing has none — deleting it corrupts the
//     index ("database disk image is malformed"). A rebuild has no such input.
//   - `severity:*` is copied to a split-out lesson only when the bucket has
//     exactly one such tag. With several, which lesson was `critical` is not
//     recorded anywhere, and guessing would write a fact nobody stated.

import type { MemeshDatabase } from './sqlite.js';
import { rebuildFtsIndex, runOnceMigration } from './schema.js';
import { hasVectorIndex } from './vector-index.js';
import { lessonSlug } from '../core/lesson-slug.js';

export const SESSION_DEDUPE_KEY = 'session_observation_dedupe';
export const ZERO_EDIT_RETRACT_KEY = 'session_zero_edit_retract';
export const FUSED_LESSON_SPLIT_KEY = 'fused_lesson_split';

interface BucketRow {
  id: number;
  name: string;
  type: string;
  namespace: string | null;
  confidence: number | null;
}

interface ObsRow {
  id: number;
  content: string;
  created_at: string;
}

function observationsOf(db: MemeshDatabase, entityId: number): ObsRow[] {
  return db
    .prepare('SELECT id, content, created_at FROM observations WHERE entity_id = ? ORDER BY id')
    .all(entityId) as unknown as ObsRow[];
}

/**
 * #240 — session entities carry each observation once.
 *
 * The Stop hook re-appended the same summary on every Stop when a session's
 * edits went through Bash. Deletes every observation whose exact content
 * already appears on the same `session-*` entity with a lower id, then
 * re-derives FTS for each entity it touched.
 *
 * @returns number of duplicate rows removed, or -1 if the pass did not run
 */
export function dedupeSessionObservations(db: MemeshDatabase): number {
  let removed = -1;
  runOnceMigration(db, {
    key: SESSION_DEDUPE_KEY,
    version: 1,
    describe: 'session observation dedupe',
    migrate: (conn) => {
      const affected = conn
        .prepare(
          `SELECT DISTINCT e.id FROM entities e JOIN observations o ON o.entity_id = e.id
           WHERE e.name LIKE 'session-%'
           GROUP BY e.id, o.content HAVING COUNT(o.id) > 1`,
        )
        .all() as unknown as Array<{ id: number }>;
      removed = 0;
      for (const row of affected) {
        const r = conn
          .prepare(
            `DELETE FROM observations WHERE entity_id = ? AND id NOT IN (
               SELECT MIN(id) FROM observations WHERE entity_id = ? GROUP BY content)`,
          )
          .run(row.id, row.id);
        removed += Number(r.changes);
      }
      if (removed > 0) rebuildFtsIndex(conn);
    },
  });
  return removed;
}

/** The Bash write shapes the Stop hook could not see before 4.8.2 (#240). */
const BASH_WRITE_MARKS = ['<<', 'sed -i', 'write_text(', 'writeFileSync(', 'tee '];

/**
 * #240 — a summary does not claim "0 files edited" when it also recorded a
 * Bash command that writes files.
 *
 * The Stop hook counted only Edit/Write tool calls, so a session that wrote
 * through Bash was summarised as `0 files edited` — a false statement stored
 * as memory. The count cannot be recovered now (the transcript is gone), so
 * the claim is replaced by what IS known: the session edited files through
 * Bash and the number was not recorded. The tool-call count on the same line
 * is kept.
 *
 * @returns number of observations rewritten, or -1 if the pass did not run
 */
export function retractZeroEditClaims(db: MemeshDatabase): number {
  let rewritten = -1;
  runOnceMigration(db, {
    key: ZERO_EDIT_RETRACT_KEY,
    version: 1,
    describe: 'session zero-edit retraction',
    migrate: (conn) => {
      const marks = BASH_WRITE_MARKS.map(() => "o2.content LIKE 'Command:%' AND o2.content LIKE ?").join(' OR ');
      const rows = conn
        .prepare(
          `SELECT o.id, o.content FROM observations o JOIN entities e ON e.id = o.entity_id
           WHERE e.name LIKE 'session-%-summary'
             AND o.content LIKE 'Significant session:%0 files edited%'
             AND EXISTS (SELECT 1 FROM observations o2 WHERE o2.entity_id = e.id AND (${marks}))`,
        )
        .all(...BASH_WRITE_MARKS.map((m) => `%${m}%`)) as unknown as Array<{ id: number; content: string }>;
      const update = conn.prepare('UPDATE observations SET content = ? WHERE id = ?');
      for (const row of rows) {
        update.run(row.content.replace('0 files edited', 'files edited through Bash (count not recorded before 4.8.2)'), row.id);
      }
      rewritten = rows.length;
      if (rewritten > 0) rebuildFtsIndex(conn);
    },
  });
  return rewritten;
}

/** One explicit lesson as `learn()` wrote it: four observations, Error first. */
interface LessonGroup {
  error: string;
  rows: ObsRow[];
}

/**
 * Cut a bucket's observations into the groups `learn()` appended. A group
 * starts at each `Error:` line and runs to the next. A row before the first
 * `Error:` belongs to no lesson and stays with the bucket.
 */
function groupLessons(rows: ObsRow[]): LessonGroup[] {
  const groups: LessonGroup[] = [];
  for (const row of rows) {
    if (row.content.startsWith('Error: ')) {
      groups.push({ error: row.content.slice('Error: '.length), rows: [row] });
    } else if (groups.length > 0) {
      groups[groups.length - 1].rows.push(row);
    }
  }
  return groups;
}

/**
 * #241 — one explicit lesson per entity.
 *
 * `learn()` keyed every lesson whose error matched no known runtime category
 * as `lesson-<project>-other`, fusing unrelated lessons into one entity per
 * project. 4.8.2 keys them by a slug of the error text. This pass gives the
 * lessons already fused the same names, so a lesson re-learned after the
 * upgrade lands on its own history rather than beside it.
 *
 * The bucket keeps its first lesson. Each later lesson moves — rows, ids and
 * timestamps intact — to `lesson-<project>-<slug>`, created if absent with
 * the bucket's tags (severity only when unambiguous), namespace and
 * confidence, and a heuristic title from `deriveTitle`. FTS follows; vectors
 * are dropped and a reindex is marked owed via `markReindexOwed`.
 *
 * @returns number of lessons moved out of buckets, or -1 if the pass did not run
 */
export function splitFusedLessons(
  db: MemeshDatabase,
  deps: {
    deriveTitle: (type: string, observations: string[]) => string | null;
    markReindexOwed: (conn: MemeshDatabase) => void;
  },
): number {
  let moved = -1;
  runOnceMigration(db, {
    key: FUSED_LESSON_SPLIT_KEY,
    version: 1,
    describe: 'fused lesson split',
    migrate: (conn) => {
      const buckets = conn
        .prepare(
          `SELECT e.id, e.name, e.type, e.namespace, e.confidence
           FROM entities e
           WHERE e.type = 'lesson_learned' AND e.name LIKE 'lesson-%-other'
             AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')
             AND (SELECT COUNT(*) FROM observations o WHERE o.entity_id = e.id) > 4`,
        )
        .all() as unknown as BucketRow[];
      moved = 0;
      const vec = hasVectorIndex(conn);

      for (const bucket of buckets) {
        const tags = (conn.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(bucket.id) as Array<{ tag: string }>)
          .map((t) => t.tag);
        const project = tags.find((t) => t.startsWith('project:'))?.slice('project:'.length);
        if (!project) continue; // cannot name the split-out lessons; leave the bucket as it is

        const rows = observationsOf(conn, bucket.id);
        const groups = groupLessons(rows);
        if (groups.length < 2) continue;

        const severities = tags.filter((t) => t.startsWith('severity:'));
        const carried = tags.filter((t) => !t.startsWith('severity:'));
        if (severities.length === 1) carried.push(severities[0]);

        for (const group of groups.slice(1)) {
          const name = `lesson-${project}-${lessonSlug(group.error)}`;
          let target = conn.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number } | undefined;
          if (!target) {
            const contents = group.rows.map((o) => o.content);
            const title = deps.deriveTitle(bucket.type, contents);
            const inserted = conn
              .prepare(
                `INSERT INTO entities (name, type, created_at, metadata, status, confidence, namespace, title)
                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
              )
              .run(
                name,
                bucket.type,
                group.rows[0].created_at,
                JSON.stringify(title ? { title_source: 'heuristic', split_from: bucket.name } : { split_from: bucket.name }),
                bucket.confidence,
                bucket.namespace,
                title,
              );
            target = { id: Number(inserted.lastInsertRowid) };
            const tagStmt = conn.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
            for (const tag of carried) tagStmt.run(target.id, tag);
          }
          const moveStmt = conn.prepare('UPDATE observations SET entity_id = ? WHERE id = ?');
          for (const row of group.rows) moveStmt.run(target.id, row.id);
          if (vec) conn.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(target.id));
          moved += 1;
        }

        if (vec) conn.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(bucket.id));
      }

      if (moved > 0) {
        rebuildFtsIndex(conn);
        // Owed whether or not sqlite-vec loaded in THIS process: the vectors on
        // disk describe text that is no longer on those entities either way.
        deps.markReindexOwed(conn);
      }
    },
  });
  return moved;
}
