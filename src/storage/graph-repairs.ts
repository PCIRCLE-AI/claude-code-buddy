// =============================================================================
// One-shot repairs for data that 4.8.2 and earlier wrote wrongly
// =============================================================================
//
// v4.8.2 fixed two memory-layer defects (#240, #241). Both fixes stop the
// wrong rows from being written; neither touches the rows already there. On
// the maintainer's own graph that was 706 duplicate observations across
// session summaries and four `-other` lesson entities holding 39 unrelated
// lessons — and 4.8.2 itself still left readable-only explicit lesson names
// behind, so a re-learn after upgrade split one lesson's history across a
// legacy entity and its new digest-named successor.
// A fix that only prevents new damage leaves `scripts/audit/memory-invariants.mjs`
// red on every existing install forever, and leaves recall matching the fused
// buckets (retrieved 61 times, matched 3) instead of the lessons in them.
//
// So the data is repaired here, once, at the first open through the core
// `openDatabase` after upgrade — CLI, MCP, HTTP, and the two hook paths that
// import dist/db.js (the hooks' own wrapper in scripts/hooks/_shared.js runs
// no migrations) — the same place and the same shape as every other backfill
// in db.ts: a `runOnceMigration` keyed in `memesh_metadata`, transactional,
// non-fatal, one line on stderr when it changed something.
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
//     created_at survive and nothing is re-authored. EVERY explicit lesson
//     leaves the bucket — keeping the first would leave one lesson whose
//     re-learned copy lands beside its history instead of on it, the exact
//     state the split exists to end. The emptied bucket is archived, not
//     deleted: the entity row and its relations stay (the work-layer graph
//     view filters archived ends out; the full view still names it). Its
//     `source:explicit` tag is dropped ONLY when it emptied — a bucket that
//     kept a stray row must stay visible to the invariant, not be hidden
//     from it by losing the tag.
//   - Vectors are left where they are. sqlite-vec is loaded AFTER the
//     backfills run, so this code cannot touch `entities_vec` and does not
//     pretend to; it records that a rebuild is owed (`pending_reindex`, the
//     flag `memesh doctor` reports and `memesh reindex` clears). Until then
//     the bucket's old vector still describes text it no longer holds.
//   - FTS is rebuilt whole (`rebuildFtsIndex`, the same call the segmentation
//     migration makes) rather than patched row by row. `entities_fts` is
//     contentless: a delete must repeat the exact text that was indexed, and a
//     row the hook wrote without indexing has none — deleting it corrupts the
//     index ("database disk image is malformed"). A rebuild has no such input.
//   - `severity:*` is copied to a split-out lesson only when the bucket has
//     exactly one such tag. With several, which lesson was `critical` is not
//     recorded anywhere, and guessing would write a fact nobody stated. The
//     same rule for `source:explicit`: it is carried only when the bucket has
//     no `source:auto-learned` tag beside it.

import type { MemeshDatabase } from './sqlite.js';
import { rebuildFtsIndex, runOnceMigration } from './schema.js';
import { hasVectorIndex } from './vector-index.js';
import { lessonSlug } from '../core/lesson-slug.js';
import { computeSignalScore } from '../core/signal-scorer.js';

export const SESSION_DEDUPE_KEY = 'session_observation_dedupe';
export const ZERO_EDIT_RETRACT_KEY = 'session_zero_edit_retract';
export const FUSED_LESSON_SPLIT_KEY = 'fused_lesson_split';
export const ARCHIVED_FTS_ROWS_KEY = 'archived_fts_rows';
export const ARCHIVED_VECTOR_ROWS_KEY = 'archived_vector_rows';

/** The summary suffix the Stop hook wrote when it could not see Bash edits. */
const ZERO_EDITS = ', 0 files edited';
const ZERO_EDITS_RETRACTED = ', files edited through Bash (count not recorded before 4.8.2)';

interface ObsRow {
  id: number;
  content: string;
  created_at: string;
}

function note(line: string): void {
  process.stderr.write(`MeMesh: ${line}\n`);
}

/**
 * #240 — session entities carry each observation once.
 *
 * The Stop hook re-appended the same summary on every Stop when a session's
 * edits went through Bash. Deletes every observation whose exact content
 * already appears on the same `session-*` entity with a lower id.
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
      const del = conn.prepare(
        `DELETE FROM observations WHERE entity_id = ? AND id NOT IN (
           SELECT MIN(id) FROM observations WHERE entity_id = ? GROUP BY content)`,
      );
      for (const row of affected) removed += Number(del.run(row.id, row.id).changes);
      if (removed > 0) {
        rebuildFtsIndex(conn);
        note(`removed ${removed} duplicate observation(s) from ${affected.length} session entit${affected.length === 1 ? 'y' : 'ies'} (written by 4.8.1 hooks).`);
      }
    },
  });
  return removed;
}

/**
 * Does this stored `Command:` line write a file in place? The same shapes
 * the Stop hook's `bashEditedPaths` recognises (scripts/hooks/session-summary.js)
 * — heredoc redirection, `cat >`, `tee`, `sed -i`, `write_text(`,
 * `writeFileSync(` — and the same exclusions: `/dev/*` and `/tmp/*` targets
 * are not edits. A bare `<<` is NOT a write (`psql <<EOF`, `python3 - <<'PY'`
 * only feed stdin), and neither is `| tee` with no path, so substring
 * matching would have turned a true "0 files edited" into a false claim.
 */
const BASH_WRITE_SHAPES: RegExp[] = [
  /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/,
  /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/,
  /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/,
  /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/,
  /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/,
  /writeFileSync\(\s*['"]([^'"]+)['"]/,
];

export function bashWritesFiles(command: string): boolean {
  for (const re of BASH_WRITE_SHAPES) {
    // Every match, like the hook: `… | tee /tmp/t.log && … | tee CHANGELOG.md`
    // writes a file even though its FIRST tee target is excluded. A fresh
    // global regex per call so no `lastIndex` survives an early return.
    for (const m of command.matchAll(new RegExp(re.source, 'g'))) {
      if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/')) return true;
    }
  }
  return false;
}

/**
 * #240 — a summary does not claim "0 files edited" when it also recorded a
 * Bash command that writes files.
 *
 * The Stop hook counted only Edit/Write tool calls, so a session that wrote
 * through Bash was summarised as `0 files edited` — a false statement stored
 * as memory. The count cannot be recovered now (the transcript is gone), so
 * the claim is replaced by what IS known: the session edited files through
 * Bash and the number was not recorded. The tool-call count on the same line
 * is kept. Anchored on `, 0 files edited` — `10 files edited` ends in the
 * same characters and is a true sentence.
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
      const candidates = conn
        .prepare(
          `SELECT o.id, o.content, o.entity_id FROM observations o JOIN entities e ON e.id = o.entity_id
           WHERE e.name LIKE 'session-%-summary'
             AND o.content LIKE 'Significant session:%${ZERO_EDITS}%'`,
        )
        .all() as unknown as Array<{ id: number; content: string; entity_id: number }>;
      const commands = conn.prepare(
        "SELECT content FROM observations WHERE entity_id = ? AND content LIKE 'Command:%'",
      );
      const update = conn.prepare('UPDATE observations SET content = ? WHERE id = ?');
      rewritten = 0;
      for (const row of candidates) {
        const cmds = commands.all(row.entity_id) as unknown as Array<{ content: string }>;
        if (!cmds.some((c) => bashWritesFiles(c.content))) continue;
        update.run(row.content.replace(ZERO_EDITS, ZERO_EDITS_RETRACTED), row.id);
        rewritten += 1;
      }
      if (rewritten > 0) {
        rebuildFtsIndex(conn);
        note(`retracted "0 files edited" on ${rewritten} session summar${rewritten === 1 ? 'y' : 'ies'} that recorded a Bash write.`);
      }
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
 * 4.8.2's first explicit-lesson slug: readable only, no digest.
 *
 * Kept local to the repair. Runtime writes use `core/lesson-slug.ts`; this
 * exists only to recognise historical names that must be canonicalised once.
 */
function legacyReadableLessonSlug(error: string): string {
  const words = error
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  const slug = words.join('-');
  return slug.length > 0 ? slug.slice(0, 80) : 'unspecified';
}

/**
 * #241 — one explicit lesson per entity.
 *
 * `learn()` first keyed every lesson whose error matched no known runtime
 * category as `lesson-<project>-other`, fusing unrelated lessons into one
 * entity per project; then 4.8.2 switched to a readable-only slug, which kept
 * one lesson per entity but still collided on shared openings and left old
 * names behind. The current runtime keys explicit lessons by a readable prefix
 * plus a digest of the full error text. This pass gives the old rows those
 * canonical names, so a lesson re-learned after the upgrade lands on its own
 * history rather than beside it.
 *
 * Each lesson moves — rows, ids and timestamps intact — to
 * `lesson-<project>-<slug>`: created if absent (with the bucket's tags under
 * the rules in the header, its namespace and confidence, and a heuristic
 * title from `deriveTitle`), revived if it exists archived (a `forget` of the
 * re-learned copy must not swallow the older one), appended to if active.
 * The bucket loses its `source:explicit` tag and, once empty, is archived.
 * FTS follows; a reindex is marked owed via `markReindexOwed`.
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
    version: 2,
    describe: 'fused lesson split',
    migrate: (conn) => {
      const buckets = conn
        .prepare(
          `SELECT e.id, e.name, e.type, e.namespace, e.confidence, e.metadata
           FROM entities e
           WHERE e.type = 'lesson_learned' AND e.name LIKE 'lesson-%-other'
             AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')`,
        )
        .all() as unknown as Array<{ id: number; name: string; type: string; namespace: string | null; confidence: number | null; metadata: string | null }>;
      const tagsOf = conn.prepare('SELECT tag FROM tags WHERE entity_id = ?');
      const obsOf = conn.prepare('SELECT id, content, created_at FROM observations WHERE entity_id = ? ORDER BY id');
      const findTarget = conn.prepare('SELECT id, status FROM entities WHERE name = ?');
      const revive = conn.prepare("UPDATE entities SET status = 'active' WHERE id = ?");
      const insertEntity = conn.prepare(
        `INSERT INTO entities (name, type, created_at, metadata, status, confidence, namespace, title)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      );
      const insertTag = conn.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
      const moveRow = conn.prepare('UPDATE observations SET entity_id = ? WHERE id = ?');
      // Both only when the bucket emptied: a bucket that kept a stray row is
      // still the invariant's business and must keep the tag it keys on.
      const emptied = 'NOT EXISTS (SELECT 1 FROM observations WHERE entity_id = ?)';
      const dropExplicit = conn.prepare(`DELETE FROM tags WHERE entity_id = ? AND tag = 'source:explicit' AND ${emptied}`);
      const archive = conn.prepare(`UPDATE entities SET status = 'archived' WHERE id = ? AND ${emptied}`);
      moved = 0;
      let bucketsTouched = 0;
      let legacyReadableMoved = 0;

      const moveLessonGroups = (
        source: { id: number; name: string; type: string; namespace: string | null; confidence: number | null; metadata: string | null },
        project: string,
        groups: LessonGroup[],
        tags: string[],
      ): number => {
        // The source metadata (trust, provenance, …) describes every lesson
        // in it equally, so each split-out lesson starts from a copy; only
        // the fields that are per-entity are replaced below.
        let inherited: Record<string, unknown> = {};
        try {
          const parsed: unknown = source.metadata ? JSON.parse(source.metadata) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inherited = parsed as Record<string, unknown>;
        } catch { /* unreadable metadata: carry nothing rather than guess */ }

        const severities = tags.filter((t) => t.startsWith('severity:'));
        const carried = tags.filter((t) => !t.startsWith('severity:') && !t.startsWith('source:'));
        if (severities.length === 1) carried.push(severities[0]);
        if (!tags.includes('source:auto-learned')) carried.push('source:explicit');

        let movedFromSource = 0;
        for (const group of groups) {
          const name = `lesson-${project}-${lessonSlug(group.error)}`;
          let target = findTarget.get(name) as { id: number; status: string } | undefined;
          if (target) {
            if (target.status !== 'active') revive.run(target.id);
          } else {
            const contents = group.rows.map((o) => o.content);
            const title = deps.deriveTitle(source.type, contents);
            const metadata: Record<string, unknown> = {
              ...inherited,
              split_from: source.name,
              // The signal-score backfill already ran this open; score here so
              // the split-out lesson is not the one entity without a score.
              signal_score: computeSignalScore({ type: source.type, name, observations: contents, tags: carried }),
            };
            if (title) metadata.title_source = 'heuristic'; else delete metadata.title_source;
            // Per-entity facts that must not be multiplied: one `dream accept`
            // put ONE guard on the source (copying it would fire N identical
            // warnings and count N acceptances); `evidence_for` pairs with a
            // relation row the new entity does not have; `previous_namespace`
            // records a move that never happened to it.
            delete metadata.guard;
            delete metadata.evidence_for;
            delete metadata.previous_namespace;
            const inserted = insertEntity.run(
              name,
              source.type,
              group.rows[0].created_at,
              JSON.stringify(metadata),
              source.confidence,
              source.namespace,
              title,
            );
            target = { id: Number(inserted.lastInsertRowid), status: 'active' };
            for (const tag of carried) insertTag.run(target.id, tag);
          }
          for (const row of group.rows) moveRow.run(target.id, row.id);
          moved += 1;
          movedFromSource += 1;
        }
        return movedFromSource;
      };

      for (const bucket of buckets) {
        const groups = groupLessons(obsOf.all(bucket.id) as unknown as ObsRow[]);
        if (groups.length === 0) continue;

        const tags = (tagsOf.all(bucket.id) as unknown as Array<{ tag: string }>).map((t) => t.tag);
        // `lesson-<project>-other` — the tag is the record, the name the fallback.
        const project =
          tags.find((t) => t.startsWith('project:'))?.slice('project:'.length) ??
          bucket.name.slice('lesson-'.length, -'-other'.length);
        const movedFromBucket = moveLessonGroups(bucket, project, groups, tags);
        dropExplicit.run(bucket.id, bucket.id);
        archive.run(bucket.id, bucket.id);
        if (movedFromBucket > 0) bucketsTouched += 1;
      }

      const legacyReadable = conn
        .prepare(
          `SELECT e.id, e.name, e.type, e.namespace, e.confidence, e.metadata
           FROM entities e
           WHERE e.status = 'active'
             AND e.type = 'lesson_learned'
             AND e.name LIKE 'lesson-%'
             AND e.name NOT LIKE 'lesson-%-other'
             AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')`,
        )
        .all() as unknown as Array<{ id: number; name: string; type: string; namespace: string | null; confidence: number | null; metadata: string | null }>;

      for (const entity of legacyReadable) {
        const rows = obsOf.all(entity.id) as unknown as ObsRow[];
        const groups = groupLessons(rows);
        if (groups.length === 0) continue;
        if (groups.reduce((n, group) => n + group.rows.length, 0) !== rows.length) continue;
        const tags = (tagsOf.all(entity.id) as unknown as Array<{ tag: string }>).map((t) => t.tag);
        const project = tags.find((t) => t.startsWith('project:'))?.slice('project:'.length);
        if (!project) continue;
        const suffix = entity.name.slice(`lesson-${project}-`.length);
        // Matching identity and error-pattern tags are indistinguishable from
        // caller-supplied recurring lessons, so preserve them rather than guess.
        if (tags.includes(`error-pattern:${suffix}`)) continue;
        if (!groups.every((group) => `lesson-${project}-${legacyReadableLessonSlug(group.error)}` === entity.name)) continue;

        const movedFromEntity = moveLessonGroups(entity, project, groups, tags);
        archive.run(entity.id, entity.id);
        legacyReadableMoved += movedFromEntity;
      }

      if (moved > 0) {
        rebuildFtsIndex(conn);
        deps.markReindexOwed(conn);
        if (legacyReadableMoved === 0) {
          note(`moved ${moved} lesson(s) out of ${bucketsTouched} "-other" bucket(s) into their own entities; run 'memesh reindex' to refresh their vectors.`);
        } else if (bucketsTouched === 0) {
          note(`moved ${legacyReadableMoved} legacy readable-only lesson(s) into their canonical digest entities; run 'memesh reindex' to refresh their vectors.`);
        } else {
          note(`moved ${moved - legacyReadableMoved} lesson(s) out of ${bucketsTouched} "-other" bucket(s) and ${legacyReadableMoved} legacy readable-only lesson(s) into their canonical digest entities; run 'memesh reindex' to refresh their vectors.`);
        }
      }
    },
  });
  return moved;
}

/**
 * D11/D12 — an archived entity is in NEITHER search index.
 *
 * `archiveEntity` always dropped both index rows. `compressWeeklyNoise`, the
 * dreamer's compaction apply and `splitFusedLessons` archived with a bare
 * status UPDATE and dropped neither. Those three are fixed at the source, but
 * every graph written before the fix still holds the rows they left. Measured
 * on the maintainer's graph at 2136 entities (820 active, 1316 archived):
 *
 *   413 of 1013 vector rows belonged to archived entities — 41 real k-NN
 *       queries spent 290 of 820 top-20 slots (35.4%) on memories the user
 *       had put away, displacing active ones.
 *   213 archived entities were still in `entities_fts` — `MATCH 'ae83279'`
 *       returned the archived `commit-ae83279`.
 *
 * TWO `runOnceMigration` keys, not one, because the two halves have different
 * preconditions and one must not be able to mark the other done:
 *
 *   `archived_fts_rows`     always runnable — FTS5 is built into SQLite.
 *   `archived_vector_rows`  needs sqlite-vec loaded IN THIS PROCESS.
 *
 * On a platform sqlite-vec publishes no binary for, the vector half can never
 * run. Folded into one key it would either strand the FTS repair on those
 * machines forever, or stamp a marker over work that did not happen — and this
 * file exists precisely because "a fix that only prevents new damage" is not
 * enough. Split, each machine repairs what it can, and the vector half runs
 * the first time the file is opened somewhere that has the binary.
 *
 * The FTS half rebuilds the whole index rather than deleting the archived rows
 * one by one, for the reason the header gives: a contentless delete must repeat
 * the exact text that was indexed, and where an entity was re-remembered while
 * archived the index holds TWO documents at its rowid whose combined text
 * nothing can reconstruct. `rebuildFtsIndex` starts from `delete-all` and
 * re-inserts active rows only, so it needs no such input and clears both
 * defects at once. It is idempotent and may already have run this open.
 *
 * **Must be called AFTER the sqlite-vec load in `openDatabase`**, unlike the
 * three passes above, which run before it and therefore cannot touch
 * `entities_vec` at all.
 *
 * @returns `{ ftsRows, vectorRows }` — rows removed by each half, or -1 for a
 *          half that did not run.
 */
export function dropArchivedIndexRows(db: MemeshDatabase): {
  ftsRows: number;
  vectorRows: number;
} {
  const result = { ftsRows: -1, vectorRows: -1 };

  runOnceMigration(db, {
    key: ARCHIVED_FTS_ROWS_KEY,
    version: 1,
    describe: 'archived rows removed from the keyword index',
    migrate: (conn) => {
      // Counted BEFORE the rebuild, from the index itself: `entities_fts` is
      // contentless, but its rowids are still scannable, and a rowid is what
      // identifies the leak. Counting archived entities instead would report
      // every archived row in the database, most of which were never indexed.
      //
      // This count is NOT the rebuild's gate — it is a log/note number only.
      // It can undercount: it joins on CURRENT `e.status = 'archived'`, so it
      // only proves something about a rowid that is archived RIGHT NOW. It
      // cannot see a document that is stale for a reason other than "this
      // row's status is archived" — e.g. one written under an FTS
      // segmentation rule that has since changed, or one left behind by a
      // sequence of archive / re-remember / archive-again that this join
      // was never designed to characterize. `rebuildFtsIndex` starts from
      // `delete-all` and reconstructs strictly from `entities` +
      // `observations`, so it needs no such count as input and is the only
      // thing here that can actually prove the index is clean. Skipping it
      // whenever the count read zero was the D11/D12 bug's own shape one
      // level up: a check for one specific shape of residue read all-clear
      // on the corpus it existed to catch. `ensureFtsSegmentation`
      // (schema.ts) already establishes unconditional rebuild as this
      // codebase's answer to that — its own comment records a version-keyed
      // skip that measured a real corpus it could not see. `rebuildFtsIndex`
      // is idempotent and this whole call sits behind a one-time
      // `runOnceMigration` key, so running it unconditionally costs one
      // extra pass through `entities` on the machines where the count really
      // was zero, and fixes the ones where it wasn't.
      const stale = conn
        .prepare(
          `SELECT COUNT(*) AS n FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
            WHERE e.status = 'archived'`,
        )
        .get() as { n: number };
      result.ftsRows = stale.n;
      rebuildFtsIndex(conn);
      if (stale.n > 0) {
        note(`removed ${stale.n} archived entit${stale.n === 1 ? 'y' : 'ies'} from the keyword index (archived before 4.8.4 by a path that left the index behind).`);
      }
    },
  });

  // Asked before `runOnceMigration`, not inside `migrate`: a migrate that
  // returns early because it cannot work still gets its marker stamped, and
  // this repair would then be permanently "done" on the one class of machine
  // that never performed it.
  if (!hasVectorIndex(db)) return result;

  runOnceMigration(db, {
    key: ARCHIVED_VECTOR_ROWS_KEY,
    version: 1,
    describe: 'archived rows removed from the vector index',
    migrate: (conn) => {
      const removed = conn
        .prepare(
          `DELETE FROM entities_vec WHERE rowid IN
             (SELECT e.id FROM entities e WHERE e.status = 'archived')`,
        )
        .run();
      result.vectorRows = Number(removed.changes);
      if (result.vectorRows > 0) {
        note(`removed ${result.vectorRows} archived entit${result.vectorRows === 1 ? 'y' : 'ies'} from the vector index; they were taking recall slots from live memories.`);
      }
    },
  });

  return result;
}
