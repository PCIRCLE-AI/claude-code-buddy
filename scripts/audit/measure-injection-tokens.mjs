#!/usr/bin/env node
//
// Session-start injection size (A1)
// =================================
//
// What the SessionStart hook actually sends the model, measured by RUNNING
// the hook — not by re-deriving its queries here. A re-derivation is a second
// implementation that drifts from the thing it claims to measure; spawning
// the real hook means the number is always about the shipped code.
//
// Isolation: the hook is spawned against a throwaway HOME holding a COPY of
// the database, so a measurement can never write to the real graph (the hook
// opens read-write paths for noise compression and heartbeat stamping).
// Companion to measure-work-topology-baseline.mjs, which is read-only by
// construction and therefore cannot spawn anything.
//
// Usage:
//   node scripts/audit/measure-injection-tokens.mjs            # real DB, copied
//   node scripts/audit/measure-injection-tokens.mjs --json     # machine-readable
//
// The token figure is chars/4 — the same rough estimator used elsewhere in
// this repo's audits. It is a comparison instrument (before vs after the same
// database), not a billing number.
//

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIsolatedSuiteEnv } from '../lib/isolated-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const asJson = process.argv.includes('--json');

const realHome = process.env.HOME || os.homedir();
const sourceDb = process.env.MEMESH_MEASURE_DB || path.join(realHome, '.memesh', 'knowledge-graph.db');
if (!fs.existsSync(sourceDb)) {
  console.error(`measure-injection-tokens: no database at ${sourceDb}`);
  process.exit(2);
}

// Throwaway HOME with a copy of the graph. `-wal`/`-shm` come too: without
// them a database whose recent writes are still in the WAL measures short.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-inject-'));
const scratchMemesh = path.join(scratch, '.memesh');
fs.mkdirSync(scratchMemesh, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const from = `${sourceDb}${suffix}`;
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(scratchMemesh, `knowledge-graph.db${suffix}`));
}

// Bring the copy through the core migration chain first, the way any real
// machine already has: the SessionStart hook opens READ-ONLY and therefore
// never runs a backfill itself — the CLI, the MCP server and `memesh serve`
// do. Measuring a freshly-copied database without this step would report the
// pre-upgrade state and call it today's.
const migrate = spawnSync(
  process.execPath,
  ['-e', 'import(process.argv[1]).then(m => { m.openDatabase(process.argv[2]); m.closeDatabase(); })',
    path.join(repoRoot, 'dist/db.js'), path.join(scratchMemesh, 'knowledge-graph.db')],
  { encoding: 'utf8', env: buildIsolatedSuiteEnv(process.env, { runtimeHome: scratch }), timeout: 60_000 },
);
if (migrate.status !== 0) {
  console.error(`measure-injection-tokens: core open failed (${migrate.stderr?.trim().split('\n')[0] ?? 'unknown'})`);
  console.error('   run `npm run build` first — this needs dist/db.js');
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}

// A realistic SessionStart payload. `cwd` decides the project tag, so it must
// be a real project directory or the project-scoped half of the injection
// measures empty.
const payload = JSON.stringify({
  session_id: 'measure-injection',
  cwd: process.env.MEMESH_MEASURE_CWD || repoRoot,
  source: 'startup',
});

const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/hooks/session-start.js')], {
  input: payload,
  encoding: 'utf8',
  env: buildIsolatedSuiteEnv(process.env, { runtimeHome: scratch }),
  timeout: 60_000,
});

let injected = '';
let banner = '';
let parseNote = '';
try {
  const out = JSON.parse(run.stdout || '{}');
  injected = out?.hookSpecificOutput?.additionalContext ?? '';
  banner = out?.systemMessage ?? '';
} catch (err) {
  parseNote = `hook stdout was not JSON (${err instanceof Error ? err.message : String(err)})`;
}

const chars = injected.length;
const tokens = Math.round(chars / 4);
const lines = injected ? injected.split('\n').length : 0;

fs.rmSync(scratch, { recursive: true, force: true });

if (asJson) {
  console.log(JSON.stringify({ chars, tokens, lines, exitCode: run.status, parseNote }, null, 2));
} else {
  console.log('── SessionStart injection size ──────────────────────');
  console.log(`   source DB: ${sourceDb} (copied to a throwaway HOME)`);
  console.log(`   hook exit: ${run.status}`);
  if (parseNote) console.log(`   ! ${parseNote}`);
  if (run.stderr?.trim()) console.log(`   stderr: ${run.stderr.trim().split('\n')[0]}`);
  console.log(`   banner: ${banner.split('\n')[0] || '(none)'}`);
  console.log(`   injected additionalContext: ${chars.toLocaleString()} chars` +
              ` / ~${tokens.toLocaleString()} tokens / ${lines} lines`);
}

// A zero-length injection is a legitimate outcome (empty graph), but on a
// populated one it means the payload never reached the model — the exact
// silent regression this instrument exists to catch. Exit 1 so a CI or
// scripted caller notices, while still printing the numbers above.
if (chars === 0 && fs.statSync(sourceDb).size > 100_000) {
  console.error('   ✗ populated database produced an EMPTY injection');
  process.exit(1);
}
