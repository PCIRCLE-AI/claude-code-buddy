#!/usr/bin/env node
// =============================================================================
// Memory-layer invariants — checked against a REAL knowledge graph, read-only.
// =============================================================================
//
// Why this exists. v4.8.2 was reviewed seven times before release: two whole-
// diff reviews, a security review, a replay review, a contract review, a
// loop-closure pass and a guard sweep. Then dogfooding found three defects in
// the memory layer that every one of those reviews had missed — not because a
// reviewer was careless, but because all seven reviewed the DIFF, and the
// three defects sat in code the release never touched:
//
//   #240  the Stop hook re-appended one session's summary on every Stop
//         (measured: 196 observations, 50 unique, on one entity)
//   #241  learn() fused unrelated lessons into one `-other` entity per project
//         (measured: 68 observations, ~17 lessons, on one entity)
//   #242  a memory in the `global` namespace with no project tag was injected
//         nowhere (measured: 2 such entities, one a standing behaviour rule)
//
// Each of those is a one-line SQL question against the graph. A diff review
// cannot see them at any coverage; a query against the data sees them in
// milliseconds. That is the whole method: the graph is the product, so the
// graph is what gets checked.
//
// Contract:
//   - READ-ONLY. Opened with `?mode=ro`; there is no write path in this file.
//   - Exit 1 on any violation, 0 otherwise, 2 if the database cannot be read
//     or an invariant's own post-filter throws (a bug here, not a finding).
//   - Each invariant prints the offending rows, bounded, so the report is
//     actionable without a second query.
//   - Adding an invariant here is how a memory-layer defect stays fixed. A
//     fix without an invariant can regress silently; this file is the only
//     place that watches the data itself.
//
// Usage:
//   node scripts/audit/memory-invariants.mjs                 # ~/.memesh
//   node scripts/audit/memory-invariants.mjs --db <path>     # any graph
//   MEMESH_DB_PATH=... node scripts/audit/memory-invariants.mjs
//
// It is NOT part of `verify:release`, deliberately: the release gate must be
// reproducible on a fresh clone, and a real graph is per-machine state. Run it
// as the dogfood step before declaring a release verified, and in the weekly
// audit. It IS covered by tests/audit/memory-invariants.test.ts, which seeds
// each violation into a throwaway graph and requires exit 1.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_ROWS = 8;

/**
 * The Bash write shapes the Stop hook's `bashEditedPaths` recognises
 * (scripts/hooks/session-summary.js) — mirrored in src/storage/graph-repairs.ts,
 * which repairs what this invariant reports. Keep the three in step.
 */
const BASH_WRITE_SHAPES = [
  /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/,
  /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/,
  /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/,
  /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/,
  /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/,
  /writeFileSync\(\s*['"]([^'"]+)['"]/,
];
/**
 * The name key of an explicit lesson — mirrored from src/core/lesson-slug.ts
 * (this script cannot import TypeScript). Keep the two in step: the
 * #241 invariant decides "fused" with exactly the key learn() and the repair
 * use, so a drift here would make the detector disagree with the fixer.
 */
function lessonSlug(error) {
  const normalized = error.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const words = normalized
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  const readable = words.join('-') || 'unspecified';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${readable.slice(0, 71)}-${digest}`;
}

function bashWritesFiles(command) {
  for (const re of BASH_WRITE_SHAPES) {
    // Every match, like the hook: the first tee target may be /tmp, the second real.
    for (const m of command.matchAll(new RegExp(re.source, 'g'))) {
      if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/')) return true;
    }
  }
  return false;
}

function resolveDbPath(argv) {
  const i = argv.indexOf('--db');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  if (process.env.MEMESH_DB_PATH) return process.env.MEMESH_DB_PATH;
  const dir = process.env.MEMESH_DIR ?? join(homedir(), '.memesh');
  return join(dir, 'knowledge-graph.db');
}

/** One invariant: a SQL query whose rows are violations. Zero rows = holds. */
const INVARIANTS = [
  {
    id: 'no-entity-carries-the-same-observation-twice',
    refs: '#240',
    says: 'no entity carries the same observation content more than once',
    // SCOPE: every entity except one structural exception, argued below.
    // There is deliberately no NAME predicate, and that is the whole point of
    // this invariant's second version.
    //
    // It used to ask `WHERE e.name LIKE 'session-%-summary'`, which keyed the
    // check to the NAME the ONE hook fixed for #240 happened to write. Two
    // sibling hooks write the same way under different names, and the
    // detector was structurally blind to both: measured on the maintainer's
    // graph, 2,188 duplicate rows on 58 `pre-compact-<sessionId>` entities
    // (worst: 220 observations, 2 distinct) and 14 on `commit-<sha>`, none of
    // it visible while this line named a session summary. A check keyed to
    // where the last bug was found only ever finds that bug again.
    //
    // The two narrower scopes that suggest themselves are both the same
    // mistake one layer out, and the snapshot says so:
    //   - `source:auto-capture` tag — `commit-32e98b8` HAS duplicates and does
    //     NOT carry the tag, and only 941 of 1,463 commit entities carry it at
    //     all. The tag is a proxy for the writer, not for the question.
    //   - entity TYPE — `pre-compact-*` is type `session-summary` while the
    //     real `session-<id>-summary` rows are type `session-insight`, so a
    //     type-keyed query would drop the family this invariant was written
    //     for in the first place.
    //
    // WHY a repeat is a defect at all, and what the exception is.
    //
    // Every reader that consumes observations AS CONTENT selects `content`
    // and nothing else (`grep -rn 'FROM observations' src/ dashboard/src/` —
    // `src/db.ts`, `src/knowledge-graph.ts`, `src/core/{operations,dreamer,
    // why,conflict-judge}.ts`; the dashboard and HTTP transport read none of
    // it directly). The single place `created_at` is selected is
    // `splitFusedLessons` (src/storage/graph-repairs.ts), which MOVES rows and
    // never displays the column. So a second row with identical content is
    // invisible to every reader: it says nothing the first row does not,
    // whatever event produced it. That holds
    // for the append-log entities the wide scope now also reaches —
    // `task-state:memesh`, `weekly-summary-*`, a `coordination-request` — and
    // `task-state` keeps its actual state in metadata (see
    // src/core/task-state-store.ts: "Metadata is the state's home"), so the
    // repeated history line is doubly unreachable.
    //
    // The exception is a reader that treats the list as ORDERED BLOCKS rather
    // than a bag of sentences. There are two:
    //   - `groupLessons` (src/storage/graph-repairs.ts:243) cuts a lesson
    //     entity's observations into lessons at each `Error: ` line.
    //   - `parseStructuredBlocks` (dashboard/src/components/LessonCards.tsx)
    //     does the same cut in the dashboard, keyed on CONTENT (an `Error:`
    //     line followed by a `Fix:` or `Root cause:` line) rather than type,
    //     so it renders any entity whose observations happen to have that
    //     shape — not only `lesson_learned`.
    // In both, a repeated line is not indistinguishable — its POSITION says
    // which lesson it belongs to, and two lessons in one bucket sharing a
    // `Fix:` line is ordinary. The exclusion below is keyed to the three
    // types the rest of this repository already treats as one lesson family
    // (`grep -rn "lesson_learned', 'lesson', 'mistake'" src/ scripts/` —
    // src/core/analytics.ts, src/core/work-topology.ts, src/core/doctor.ts,
    // scripts/hooks/_shared.js), not to a single type name: `lesson_learned`
    // alone left `lesson` and `mistake` entities with the same Error/Fix
    // structure unprotected, and this invariant flagged their intentional
    // repeats as violations. If a third positional reader is ever added,
    // this predicate is what has to be revisited with it.
    sql: `
      SELECT e.name AS name, COUNT(o.id) AS total, COUNT(DISTINCT o.content) AS distinct_count
      FROM entities e JOIN observations o ON o.entity_id = e.id
      WHERE e.type NOT IN ('lesson_learned', 'lesson', 'mistake')
      GROUP BY e.id HAVING total > distinct_count
      ORDER BY total - distinct_count DESC LIMIT ${MAX_ROWS + 1}`,
    row: (r) => `${r.name}  observations=${r.total} unique=${r.distinct_count}`,
  },
  {
    id: 'stop-summary-does-not-assert-zero-edits-for-bash-sessions',
    refs: '#240',
    says: 'a summary that recorded Bash commands does not claim "0 files edited"',
    sql: `
      SELECT e.name AS name
      FROM entities e
      WHERE e.name LIKE 'session-%-summary'
        AND EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND o.content LIKE 'Significant session:%, 0 files edited%')
        AND EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND o.content LIKE 'Command:%')`,
    // Anchored on ", 0 files edited": "10 files edited" ends the same way and is true.
    // The SQL only narrows; the Bash-write test is the hook's own regexes
    // (BASH_WRITE_SHAPES above), applied in JS — a bare `<<` only feeds stdin.
    // NO LIMIT in the SQL: it would bound candidates, not violations, and
    // eight honest sessions sorting first would hide a real one. The cap is
    // applied after the filter, by the caller, where it means "first 8 violations".
    rows: (db, rows) => {
      const commands = db.prepare("SELECT content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? AND o.content LIKE 'Command:%'");
      return rows.filter((r) => commands.all(r.name).some((o) => bashWritesFiles(o.content)));
    },
    row: (r) => r.name,
  },
  {
    id: 'explicit-lessons-not-fused-into-other-bucket',
    refs: '#241',
    says: 'no "-other" lesson entity holds more than one explicit lesson',
    // The SQL narrows: name shape, explicit tag, at least two `Error:` lines
    // (case-insensitive LIKE). A bucket holding exactly ONE lesson is
    // deliberately not a violation even when that lesson belongs under
    // another name — see "a single explicit lesson in -other is not a
    // violation" in the test file; the repair still moves it. Among the
    // rest, the verdict is the repair's own question, asked in JS below: cut
    // the observations into lessons on `Error: ` exactly as groupLessons
    // does, slug each error exactly as learn() does, and call the entity
    // fused only if it holds more than one slug or a slug its name does not
    // end with. No LIMIT here: it would bound candidates, not violations.
    sql: `
      SELECT e.name AS name, COUNT(o.id) AS total
      FROM entities e JOIN observations o ON o.entity_id = e.id
      WHERE e.type = 'lesson_learned' AND e.name LIKE 'lesson-%-other'
        AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')
      GROUP BY e.id
      HAVING SUM(CASE WHEN o.content LIKE 'Error: %' THEN 1 ELSE 0 END) > 1`,
    rows: (db, rows) => {
      const obs = db.prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id");
      const out = [];
      for (const r of rows) {
        const slugs = new Set();
        for (const o of obs.all(r.name)) {
          if (o.content.startsWith('Error: ')) slugs.add(lessonSlug(o.content.slice('Error: '.length)));
        }
        const foreign = [...slugs].filter((slug) => !r.name.endsWith(`-${slug}`));
        if (slugs.size > 1 || foreign.length > 0) out.push({ ...r, lessons: slugs.size });
      }
      return out;
    },
    row: (r) => `${r.name}  observations=${r.total} (${r.lessons} lessons)`,
  },
  {
    id: 'archived-entities-not-in-keyword-index',
    refs: '#D12',
    says: 'no archived entity is still findable through the full-text index',
    // `entities_fts` is contentless, so its COLUMNS cannot be selected — but
    // its rowids can be scanned, and a rowid is what identifies the leak. No
    // shadow-table name is assumed.
    //
    // Measured on the maintainer's graph before the fix: 213 archived entities
    // were still indexed, and `MATCH 'ae83279'` answered with the archived
    // `commit-ae83279`. Three archive paths dropped the status but not the
    // index row. A leak here is not only a wrong search result: re-remembering
    // one of these entities inserts a SECOND document at the same rowid, and a
    // contentless FTS5 delete can then never reach the first — its tokens
    // become permanently unremovable.
    sql: `
      SELECT e.name AS name FROM entities_fts f
        JOIN entities e ON e.id = f.rowid
       WHERE e.status = 'archived'
       ORDER BY e.id LIMIT ${MAX_ROWS + 1}`,
    row: (r) => r.name,
  },
  {
    id: 'archived-entities-not-in-vector-index',
    refs: '#D11',
    says: 'no archived entity keeps a row in the vector index',
    // Every slot an archived entity takes in a k-NN result is a slot an active
    // memory does not get — the LIMIT is spent before any status filter can
    // run. Measured on the maintainer's graph before the fix: 413 of 1013
    // vectors belonged to archived entities, and 41 synthetic 1536-dim queries
    // against a copy of it spent 290 of 820 top-20 slots (35.4%) on them.
    //
    // NO LIMIT: it would bound candidates, not violations. The cap is applied
    // after the post-filter, by the caller.
    sql: `SELECT e.id AS id, e.name AS name FROM entities e WHERE e.status = 'archived' ORDER BY e.id`,
    // `entities_vec` is a vec0 virtual table, and this audit opens the database
    // read-only without loading the extension — selecting from it raises
    // "no such module: vec0", which the caller would print as a benign `skip`.
    // A silent pass is the one outcome an invariant must never have, so the
    // vector side is read from sqlite-vec's plain rowid map instead, here in
    // the post-filter where a throw is exit 2 rather than a skip.
    rows: (db, rows) => {
      const table = (name) =>
        db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
      // No vector index in this database at all (sqlite-vec never loaded here,
      // or a keyword-only install). Nothing to violate.
      if (!table('entities_vec')) return [];
      // The vec0 table exists but its rowid map does not: sqlite-vec changed
      // its internal layout under us. Throwing is correct — this invariant can
      // no longer answer its question, and saying nothing would read as "holds".
      if (!table('entities_vec_rowids')) {
        throw new Error(
          'entities_vec exists but entities_vec_rowids does not — sqlite-vec shadow-table layout changed; this invariant needs updating',
        );
      }
      // `id` carries the user rowid when the vec0 table declares a rowid alias
      // and is NULL when it does not (memesh's does not). COALESCE reads both.
      const indexed = new Set(
        db
          .prepare('SELECT COALESCE(id, rowid) AS entity_id FROM entities_vec_rowids')
          .all()
          .map((r) => Number(r.entity_id)),
      );
      return rows.filter((r) => indexed.has(r.id));
    },
    row: (r) => r.name,
  },
  {
    id: 'global-namespace-reachable-by-injection',
    refs: '#242',
    says: 'every global-namespace entity is either project-tagged or the injection path reads namespace (this invariant only reports; the fix is in session-start.js)',
    // Reported, not failed: the data shape is legitimate after #242 lands.
    // Kept so the count is visible in every run — a jump means someone is
    // storing rules that the injection would have hidden before the fix.
    sql: `
      SELECT e.name AS name FROM entities e
      WHERE e.namespace = 'global'
        AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag LIKE 'project:%')
      LIMIT ${MAX_ROWS + 1}`,
    row: (r) => r.name,
    reportOnly: true,
  },
];

function main() {
  const dbPath = resolveDbPath(process.argv.slice(2));
  if (!existsSync(dbPath)) {
    console.error(`memory-invariants: no database at ${dbPath}`);
    return 2;
  }
  let db;
  try {
    db = new DatabaseSync(`file:${dbPath}?mode=ro`, { open: true, readOnly: true });
  } catch (err) {
    console.error(`memory-invariants: cannot open ${dbPath} read-only: ${err?.message ?? err}`);
    return 2;
  }
  let violations = 0;
  try {
    for (const inv of INVARIANTS) {
      let rows;
      try {
        rows = db.prepare(inv.sql).all();
      } catch (err) {
        // A schema older than the column an invariant needs is not a
        // violation of that invariant; say so and move on.
        console.log(`  skip ${inv.id} — ${err?.message ?? err}`);
        continue;
      }
      if (inv.rows) {
        // A failure HERE is a bug in this file, not an older schema: it must
        // not read as a benign skip and it must not let the run exit 0.
        try {
          rows = inv.rows(db, rows);
        } catch (err) {
          console.error(`memory-invariants: ${inv.id} post-filter threw: ${err?.message ?? err}`);
          return 2;
        }
      }
      if (rows.length === 0) {
        console.log(`  ok   ${inv.id}`);
        continue;
      }
      // Queries fetch one more than the cap, so "(first N)" is printed only
      // when an (N+1)th row really exists — not on exactly N.
      const more = rows.length > MAX_ROWS;
      rows = rows.slice(0, MAX_ROWS);
      const mark = inv.reportOnly ? 'note' : 'FAIL';
      console.log(`  ${mark} ${inv.id} (${inv.refs}) — ${inv.says}`);
      for (const r of rows) console.log(`         ${inv.row(r)}`);
      if (more) console.log(`         … (first ${MAX_ROWS})`);
      if (!inv.reportOnly) violations += 1;
    }
  } finally {
    db.close();
  }
  if (violations > 0) {
    console.log(`\n✗ ${violations} memory invariant(s) violated in ${dbPath}`);
    return 1;
  }
  console.log(`\n✓ memory invariants hold in ${dbPath}`);
  return 0;
}

process.exit(main());
