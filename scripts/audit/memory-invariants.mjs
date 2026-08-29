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
    id: 'stop-summary-no-duplicate-observations',
    refs: '#240',
    says: 'a session summary entity carries each observation once',
    sql: `
      SELECT e.name AS name, COUNT(o.id) AS total, COUNT(DISTINCT o.content) AS distinct_count
      FROM entities e JOIN observations o ON o.entity_id = e.id
      WHERE e.name LIKE 'session-%-summary'
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
    says: 'no lesson entity holds more than one explicit lesson (4 fields each) under the "-other" key',
    // "More than one lesson" is asked directly: `learn()` starts every lesson
    // with an `Error: ` line, and the repair's groupLessons cuts on the same
    // line, so detector and fixer agree by construction. Counting rows (>4)
    // and guessing from the name shape did not: a bucket renamed by
    // `kg rename-project` (name lesson-old-other, tag project:new) went
    // unseen, and a re-learned lesson named `…-the-other` was flagged.
    sql: `
      SELECT e.name AS name, COUNT(o.id) AS total,
             COUNT(DISTINCT CASE WHEN o.content LIKE 'Error: %' THEN o.content END) AS lessons
      FROM entities e JOIN observations o ON o.entity_id = e.id
      WHERE e.type = 'lesson_learned' AND e.name LIKE 'lesson-%-other'
        AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')
      GROUP BY e.id HAVING lessons > 1
      ORDER BY lessons DESC LIMIT ${MAX_ROWS + 1}`,
    row: (r) => `${r.name}  observations=${r.total} (${r.lessons} lessons)`,
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
