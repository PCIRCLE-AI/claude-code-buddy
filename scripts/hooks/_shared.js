import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { MemeshDatabase } from './_generated/sqlite.js';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// =============================================================================
// Path helpers + FTS primitives — GENERATED from src/core (do not hand-mirror)
// =============================================================================
//
// These were once a 965-line hand-mirror of `src/core`, kept in lockstep by
// human review — until the copies drifted and shipped the P0 FTS bug (a hook
// wrote an entity+observations but the mirror's reindex step diverged, leaving
// the memory unrecallable).
//
// `src/core/paths.ts` and `src/storage/fts-index.ts` are runtime-LEAF modules
// (paths.ts imports only node builtins; fts-index.ts has only a type-only
// import), so `tsc` emits self-contained JS for them. `scripts/generate-hook-core.mjs`
// copies that compiled JS to `_generated/` at build time — committed, shipped in
// the tarball, and version-locked to its own install. So the hook path still
// survives a missing/stale `dist/` (the F5 constraint) exactly as the hand-mirror
// did, but the copy is byte-locked to core and CI-gated (`git diff` on rebuild +
// `tests/hooks/mirror-parity.test.ts`), making drift structurally impossible.
//
// Re-exported here so all 6 hooks keep importing these names from `_shared.js`
// unchanged.
import {
  homeDir,
  memeshDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  redactSecrets,
  slugFromRemoteUrl,
} from './_generated/core-paths.js';
import { autoCaptureDecision } from './_generated/capture-flag.js';
export { assembleTopologyBlock, buildReferenceContext, extractCitedMemoryIds, DEFAULT_TOPOLOGY_BUDGET, SNIPPET_FETCH_CHARS, TOPOLOGY_CANDIDATE_CAP } from './_generated/work-topology.js';
export { matchingGuards, guardFromMetadata } from './_generated/guards.js';
export { writeCitationRule, citationRulePath, CITATION_RULE_BODY } from './_generated/citation-rule.js';
import { guardFromMetadata as guardFromMetadataLocal } from './_generated/guards.js';

/**
 * Every accepted, enabled guard for one tool. Guards live as
 * `metadata.guard` on lesson-family entities (G1); the LIKE is a cheap
 * prefilter and `guardFromMetadata` is the tolerant parser. Any failure —
 * missing column on an old schema, corrupt metadata — returns an empty
 * list: a broken guard store must degrade to "no warnings", never to a
 * broken hook.
 */
export function loadActiveGuards(db, tool) {
  try {
    const rows = db.prepare(
      `SELECT id, metadata FROM entities
       WHERE status = 'active'
         AND type IN ('lesson_learned', 'lesson', 'mistake')
         AND metadata LIKE '%"guard"%'`
    ).all();
    const out = [];
    for (const r of rows) {
      const g = guardFromMetadataLocal(r.id, r.metadata);
      if (g && g.tool === tool) out.push(g);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The lines a fired guard injects — the message is memory content
 * (attacker-influenced in the general case), so callers wrap these with
 * buildReferenceContext like every other injection path. The `[mem:id]`
 * handle ties a heeded warning into citation accounting (R1).
 */
export function guardWarningLines(matches, toolName) {
  const lines = [`A guard you accepted matched this ${toolName} input — check before proceeding:`];
  for (const g of matches) {
    lines.push(`- [guard] ${g.message} [mem:${g.lessonId}]`);
  }
  return lines;
}

/**
 * Count a guard's fire. Opens its own WRITABLE handle briefly (the
 * evaluating hooks read through a read-only one) and swallows every
 * failure: the count powers guard-ROI review, and review data must never
 * block the user's work.
 */
export function recordGuardFires(dbPath, lessonIds) {
  if (!lessonIds || lessonIds.length === 0) return;
  try {
    const db = new MemeshDatabase(dbPath);
    try {
      const stmt = db.prepare(
        `UPDATE entities
         SET metadata = json_set(metadata,
           '$.guard.fires', COALESCE(json_extract(metadata, '$.guard.fires'), 0) + 1,
           '$.guard.last_fired_at', ?)
         WHERE id = ?`
      );
      const now = new Date().toISOString();
      for (const id of lessonIds) stmt.run(now, id);
    } finally {
      db.close();
    }
  } catch (err) {
    // Never block the user's work — but say so. A read-only database file, a
    // lost lock, or a schema drift silently stopped the fire counter, and
    // guard ROI is judged on exactly this number: a guard that fires often
    // and a guard whose counter never landed look identical in review. One
    // line on stderr is what guard-check already does for its own failures.
    try {
      process.stderr.write(`[memesh guard-fires] not counted: ${err?.message || err}\n`);
    } catch { /* stderr gone */ }
  }
}
import { isAutoInjectable } from './_generated/work-topology.js';
export { parseTaskState, taskStateLines, taskStateName } from './_generated/task-state.js';
import {
  indexedObservationText,
  insertFtsRow,
  joinIndexedObservations,
  removeFromFts,
  renderMatchExpression,
  tokenizeQuery,
} from './_generated/fts-index.js';

export { homeDir, memeshDir, getDbPath, getMemeshDirFromDbPath, getProjectName, redactSecrets, slugFromRemoteUrl };

const require = createRequire(import.meta.url);

/**
 * Resolve the package root from a hook file's `import.meta.url`.
 *
 * Hooks live at `<pkgRoot>/scripts/hooks/<file>.js`, so the path needs
 * three `dirname()` hops to reach `<pkgRoot>`. Centralising this here
 * prevents the off-by-one regression that silently disabled noise
 * compression and LLM failure analysis between 4.0.4–4.1.0 (the inline
 * `dirname(dirname(...))` only reached `<pkgRoot>/scripts`, and the
 * surrounding `catch` swallowed the resulting ENOENT).
 *
 * The path is derived strictly from the caller's URL — there is no env
 * override — so a malicious project's `.envrc` cannot redirect dynamic
 * imports to attacker-controlled code (the F5 boundary).
 *
 * @param {string} metaUrl - typically `import.meta.url` of the caller
 * @returns {string} absolute path to the package root
 */
export function resolvePluginRoot(metaUrl) {
  return dirname(dirname(dirname(fileURLToPath(metaUrl))));
}

/**
 * Dynamically import a built module from `<pluginRoot>/dist/...`.
 *
 * ESM `import()` takes a URL, not a filesystem path. On POSIX an absolute
 * path happens to work because it starts with `/`; on Windows an absolute
 * path is `D:\...`, which the ESM loader reads as a URL whose scheme is
 * `d:` and rejects with:
 *
 *   Only URLs with a scheme in: file, data, and node are supported by the
 *   default ESM loader. On Windows, absolute paths must be valid file://
 *   URLs. Received protocol 'd:'
 *
 * That error is caught by each caller's surrounding try/catch and only
 * traced to stderr, so on Windows every hook that reaches for a dist module
 * — LLM failure analysis, lesson creation, dream auto-trigger, auto-decay —
 * silently did nothing, while macOS/Linux and `memesh doctor` stayed green.
 * A textbook fake-working boundary: the discipline of converting the path
 * (already applied to the install-channel import above via
 * `pathToFileURL().href`) simply stopped at these call sites.
 *
 * Centralising the conversion here means it is done correctly once and can
 * never drift per-site again. All hook → dist imports MUST go through this.
 *
 * @param {string} pluginRoot - from `resolvePluginRoot(import.meta.url)`
 * @param {string} relativePath - e.g. `'dist/core/config.js'`
 * @returns {Promise<any>} the imported module namespace
 */
export function importFromPluginRoot(pluginRoot, relativePath) {
  return import(pathToFileURL(join(pluginRoot, relativePath)).href);
}

/**
 * Read ~/.memesh/config.json directly. Hooks must not depend on dist/
 * (F5 boundary), so this reads the JSON as a plain file rather than
 * importing readConfig from src/core/config.ts.
 *
 * Always reads `~/.memesh/config.json` to stay consistent with
 * `src/core/config.ts`, which is the single writer. Earlier versions
 * read `dirname(MEMESH_DB_PATH)/config.json`, which silently diverged
 * from the CLI-managed config any time a custom DB path was set: hooks
 * would ignore `memesh config set autoCapture …` and friends. Fixed
 * by treating the homedir path as the canonical source.
 *
 * Returns an empty object on missing/unreadable/malformed file —
 * callers must always be defensive about which fields are set.
 *
 * @param {NodeJS.ProcessEnv} [_env=process.env] - kept for signature
 *   compatibility (env was the prior MEMESH_DB_PATH source); ignored.
 * @returns {Record<string, any>}
 */
export function readHookConfig(_env = process.env) {
  const path = join(memeshDir(), 'config.json');
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the auto-capture flag.
 * Precedence: env > config > default(true).
 * Env semantics preserved: explicit `=== 'false'` disables; any other
 * value (including undefined) leaves it on or defers to config.
 *
 * src/core/doctor.ts duplicates this precedence (isAutoCaptureOff — the
 * TS/hook-JS bundle boundary forbids sharing code). A semantic change here
 * MUST be mirrored there, or doctor starts reasoning about a disabled state
 * the hooks don't agree on.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isAutoCaptureEnabled(env = process.env) {
  // The precedence (env > config > default-on, and which values count) lives
  // in src/core/capture-flag.ts, executed here via its generated copy — the
  // same code doctor's autoCaptureOffSource runs, so the two sides cannot
  // fork. Only the config READ stays hook-side (readHookConfig's lenient
  // parse).
  return autoCaptureDecision(env.MEMESH_AUTO_CAPTURE, readHookConfig(env).autoCapture).enabled;
}

/**
 * Resolve the session-start memory-injection top-N limit.
 * Precedence: env > config > default(10).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number}
 */
export function resolveSessionLimit(env = process.env) {
  const envVal = env.MEMESH_SESSION_LIMIT;
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cfg = readHookConfig(env);
  if (typeof cfg.sessionLimit === 'number' && cfg.sessionLimit > 0) {
    return cfg.sessionLimit;
  }
  return 10;
}

/**
 * The tag every capture hook attaches to what it writes.
 *
 * `memesh doctor`'s hook-activity row counts THIS to answer "is the
 * auto-capture loop alive" — it used to answer from entity type, and one of
 * those types is what `memesh learn` writes by hand. The constant lives in
 * `src/core/types.ts` for the TypeScript side; the hooks are plain .js loaded
 * by Claude Code and cannot import it, so this is the one mirror.
 * `tests/auto-capture-provenance.test.ts` fails if the two ever disagree, or
 * if a capture hook stops writing it.
 */
export const AUTO_CAPTURE_TAG = 'source:auto-capture';

const VALID_AUTO_UPDATE_POLICIES = new Set(['off', 'patch', 'minor', 'major']);

/**
 * Resolve the auto-update policy.
 * Precedence: env > config > default('off').
 *
 * The session-start hook uses this to decide whether to kick off a
 * background `npm install -g @pcircle/memesh@<latest>` when an update
 * is available. Default is 'off' so a fresh install never silently
 * upgrades the user's global binary; opting in is a deliberate
 * config write or env export.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {'off' | 'patch' | 'minor' | 'major'}
 */
export function resolveAutoUpdatePolicy(env = process.env) {
  const envVal = env.MEMESH_AUTO_UPDATE;
  if (typeof envVal === 'string') {
    const lowered = envVal.toLowerCase();
    if (VALID_AUTO_UPDATE_POLICIES.has(lowered)) return lowered;
  }
  const cfg = readHookConfig(env);
  if (typeof cfg.autoUpdate === 'string') {
    const lowered = cfg.autoUpdate.toLowerCase();
    if (VALID_AUTO_UPDATE_POLICIES.has(lowered)) return lowered;
  }
  return 'off';
}

// The schema and its migration toolkit come from src/storage/schema.ts via
// the generated copy — the SAME bytes core's openDatabase executes. The
// ~300-line hand-mirror that lived here ("must change in lockstep") is gone;
// a new column or migration lands in schema.ts once and reaches both sides.
export {
  SCHEMA_SQL,
  FTS_SQL,
  ensureTagsUniqueIndex,
  ensureHookRunsSince,
  FTS_SEGMENTATION_VERSION,
} from './_generated/schema.js';
import {
  SCHEMA_SQL,
  FTS_SQL,
  migrateEntitiesSchema,
  ensureTagsUniqueIndex,
  ensureHookRunsSince,
  ensureFtsSegmentation,
} from './_generated/schema.js';



/**
 * Open the hook-side memesh DB with schema + status migration applied.
 *
 * Two of three hooks (post-commit, pre-compact) previously inlined the
 * same SCHEMA_SQL but skipped the v2.11→v2.12 status migration that
 * session-summary.js ran. This unified helper closes the drift gap so
 * every hook converges on the same shape regardless of order.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {object} [opts]
 * @param {boolean} [opts.fts=false] - Also create the FTS5 virtual table.
 * @returns {{ db: any, dbPath: string }}
 */
// No native-binding probe, and nothing to self-heal.
//
// This is where ~160 lines used to live: a cached require() of
// better-sqlite3, an in-memory construction to force the deferred bindings
// load, two test seams to simulate the failure, and a detached
// `npm rebuild` with an O_EXCL marker so a crash-loop could not storm it.
// All of it existed because better-sqlite3 ships a compiled binary that
// `npm install --ignore-scripts` never builds — and Claude Code's
// `/plugin install` uses exactly that flag, so every hook silently did
// nothing. node:sqlite is part of the runtime: there is no binary to
// miss, so the failure mode and its whole recovery apparatus are gone.

/** See the pragma in `openHookDb` for why this is not the 30s the shared
 *  database class uses. */
const HOOK_BUSY_TIMEOUT_MS = 2000;

export function openHookDb(env = process.env, opts = {}) {

  // Path helpers read process.env directly (no-arg). The `env` parameter
  // is kept on this signature for backward compatibility with callers
  // and is consulted directly only for the DB-PATH dirname check below
  // — that's the one place where a caller's custom env should win over
  // process.env (e.g. the test harness redirects MEMESH_DB_PATH per test).
  const dbPath = env.MEMESH_DB_PATH ?? getDbPath();
  const dbDir = env.MEMESH_DB_PATH ? dirname(env.MEMESH_DB_PATH) : memeshDir();
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  // `allowExtension` matches src/db.ts: it only permits a later
  // `enableLoadExtension(true)`, and session-summary.js needs one to load
  // sqlite-vec through this handle. The switch itself stays off.
  const db = new MemeshDatabase(dbPath, { allowExtension: true });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // A hook waits for a held write lock for less time than Claude Code will
  // wait for the hook.
  //
  // `MemeshDatabase` sets `busy_timeout = 30000`, and that number is right
  // for the processes it was chosen for: a 30k-vector `swapVectorGeneration`
  // holds the write lock for ~9s, and the CLI, the MCP server and the HTTP
  // server should WAIT for it rather than fail. A hook cannot. Its budget in
  // `hooks/hooks.json` is 3s (UserPromptSubmit) to 10s (Stop, PreCompact),
  // so a 30s wait has exactly one possible ending: the harness kills the
  // hook. The capture is lost either way — the difference is that the user
  // also gets a hook-timeout error, which is the failure mode that makes
  // memesh something to switch off.
  //
  // 2s fits inside every budget with room for the hook's own work. On
  // contention the capture is skipped quietly, this run's `hook_runs` stamp
  // is not written, and `memesh doctor` reports the gap honestly.
  db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
  // Bringing the schema current is a WRITE, and "cannot migrate" must not
  // mean "cannot open": a database file that is read-only but behind on
  // schema (a pre-upgrade backup, a permissions accident) dies on the
  // CREATE TABLE any release adds. If the FILE refuses writes, open it for
  // what it can still do — reads; capture writes fail individually at
  // their own guarded call sites. Any other error still throws. Mirrors
  // initialiseDatabase() in src/db.ts — keep the two in lockstep.
  try {
    migrateHookDbToCurrent(db, opts);
  } catch (err) {
    if (!/readonly database|SQLITE_READONLY/i.test(err?.message || '')) throw err;
    try {
      process.stderr.write(
        'MeMesh: the database file is read-only, so schema migration was skipped — ' +
          'opened for reads only. Capture and migrations resume when the file is writable.\n',
      );
    } catch { /* stderr gone */ }
  }


  // No heartbeat here. This helper used to stamp `hook_runs` as soon as the
  // handle was usable, and that stamped-then-crashed hooks into looking
  // alive: a hook that opened the database and then died in its own capture
  // logic — the failure class this table exists to expose — read as PASS in
  // `memesh doctor` for the next 24 hours. Each capture hook now calls
  // recordHookRun() itself at every SUCCESSFUL exit (including "ran, nothing
  // worth saving"), so a mid-capture throw leaves no stamp.

  return { db, dbPath };
}

/**
 * Everything that makes a hook-opened handle CURRENT: schema, FTS,
 * one-time migrations and the segmentation rebuild. Split from
 * openHookDb() so the read-only-file tolerance there has a single
 * boundary to wrap — every statement in here may write, and none of
 * them is load-bearing for reading what the database already holds.
 * Mirrors migrateToCurrentSchema() in src/db.ts — keep in lockstep.
 *
 * @param {import('./_generated/sqlite.js').MemeshDatabase} db
 * @param {{fts?: boolean}} opts
 */
function migrateHookDbToCurrent(db, opts) {
  db.exec(SCHEMA_SQL);
  ensureTagsUniqueIndex(db);
  ensureHookRunsSince(db);
  if (opts.fts) db.exec(FTS_SQL);

  // The full conditional-ALTER chain — the SAME generated code core's
  // migrateToCurrentSchema runs, so a hook-only-touched DB converges on the
  // exact schema state core produces (the hand-copied chain that lived here
  // once stalled at v2.12 while core was at v4.0+).
  migrateEntitiesSchema(db);

  // Rebuild entities_fts when the segmentation rules change — the shared
  // runOnceMigration-based owner, so the hook side and core share one
  // marker AND one implementation. The near-twin that lived here was
  // already missing the ORDER BY fix core had picked up.
  if (opts.fts) ensureFtsSegmentation(db);
}



/**
 * Stamp a hook's heartbeat from a path that has no database handle open.
 *
 * session-summary's low-signal bails (non-agentic session, vanished
 * transcript, fewer than three tool calls) decide "nothing worth saving"
 * BEFORE opening the database — and a correct nothing-to-do decision is a
 * successful run that must stamp, or a user whose sessions are consistently
 * short reads as "capture has stopped" in doctor within a day: the exact
 * crying-wolf this table exists to end. Stop fires once per session, so one
 * extra open+close here is noise.
 *
 * Never throws: the heartbeat is diagnostics, and the bail it decorates was
 * already a successful exit.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} hook
 */
export function stampHookRunOnly(env, hook) {
  try {
    const { db } = openHookDb(env);
    try { recordHookRun(db, hook); } finally { db.close(); }
  } catch (err) {
    try {
      process.stderr.write(
        `MeMesh: could not stamp the ${hook} heartbeat on a no-capture exit (${err?.message ?? err}).\n`,
      );
    } catch { /* stderr gone */ }
  }
}

/**
 * Record that `hook` ran, right now.
 *
 * This is the only evidence in the system that a hook EXECUTED, as opposed to
 * a hook having captured something. Doctor could previously only count
 * auto-captured entities, which conflates the healthy "ran, nothing worth
 * saving" with the fatal "never ran" — see the `hook_runs` comment in
 * SCHEMA_SQL.
 *
 * A failure here must never take the hook down with it: the heartbeat is
 * diagnostics, and a session that captured its work but could not stamp the
 * row is far better than one that threw. But it is not swallowed either — it
 * writes to stderr, because a heartbeat that silently stops recording would
 * recreate the exact blind spot it exists to close.
 */
export function recordHookRun(db, hook) {
  try {
    db.prepare(
      `INSERT INTO hook_runs (hook, last_run_at, run_count)
       VALUES (?, datetime('now'), 1)
       ON CONFLICT(hook) DO UPDATE SET
         last_run_at = datetime('now'),
         run_count   = run_count + 1`,
    ).run(hook);
  } catch (err) {
    try {
      process.stderr.write(
        `MeMesh: could not record that the ${hook} hook ran (${err?.message ?? err}). ` +
          `Capture itself is unaffected, but 'memesh doctor' will under-report ` +
          `hook liveness until this succeeds.\n`,
      );
    } catch { /* stderr itself is gone; there is nowhere left to report */ }
  }
}


/** Same cap core uses, so a pathological filename cannot build a huge query. */
const HOOK_MAX_QUERY_TERMS = 32;

/**
 * Build an FTS5 MATCH expression the way core's `buildMatchExpression()` does.
 *
 * Hooks write to the index through the generated primitives, which segment and
 * normalise — but `pre-edit-recall.js` built its own MATCH by quoting a raw
 * filename. Against a segmented index a CJK basename therefore matched
 * nothing, and the surrounding `catch {}` meant neither the user nor an
 * operator ever saw it: the hook simply injected no memories.
 *
 * The document-frequency guard core applies is deliberately not mirrored here.
 * It is an optimisation, it needs a corpus-wide count, and this query is
 * already bounded by a tag filter and a LIMIT.
 *
 * @returns the MATCH expression, or null if there is nothing searchable
 */
export function hookMatchExpression(text) {
  return renderMatchExpression(tokenizeQuery(text).slice(0, HOOK_MAX_QUERY_TERMS));
}



// Title cap + truncation live in src/core/title.ts, executed here via the
// generated copy — the same code core's remember validation and the db
// backfill run, so the three writers cannot drift on the contract.
export { truncateTitle } from './_generated/title.js';

/**
 * Single owner of the hook-side entity write dance: upsert entity, append
 * observations + tags, and — critically — keep the contentless `entities_fts`
 * index in sync so the memory is recallable via the FTS keyword hot path.
 *
 * Why this exists: post-commit.js, pre-compact.js, and session-summary.js each
 * hand-rolled this dance inline. Three copies drifted — session-summary's copy
 * omitted the FTS reindex entirely, so every `session-insight` memory it wrote
 * was invisible to `recall` and pre-edit-recall (no FTS trigger, no self-heal
 * rebuild on open back it up). Centralising the dance here makes the FTS step
 * impossible to forget in a future hook. This mirrors, on the hook side, what
 * `src/storage/fts-index.ts` already does for core (the F5 boundary keeps them
 * as two implementations of the same contract).
 *
 * The caller MUST open its DB with `openHookDb(env, { fts: true })` so the FTS
 * table is guaranteed present. Embeddings + auto-tagging + signal-scoring are
 * deliberately NOT done here: hooks are cheap always-on capture, and those are
 * the heavier, user-initiated `remember` concerns (core owns them).
 *
 * @param {import('./_generated/sqlite.js').MemeshDatabase} db - an open hook DB handle
 * @param {{name: string, type: string, observations?: string[], tags?: string[], title?: string | null, metadata?: Record<string, unknown>}} entity
 *   `metadata` is extra INSERT-only metadata (e.g. post-commit's session_id +
 *   files). It cannot override the provenance/title_source stamps below, and
 *   an OR IGNORE re-capture of an existing entity leaves it untouched — same
 *   first-writer-wins rule provenance already follows.
 * @returns {{ id: number, isNew: boolean } | null} null if the row could not be resolved
 */
export function captureEntity(db, { name, type, observations = [], tags = [], title, metadata }) {
  // One transaction, because this function performs six writes that only
  // mean anything together: the entity row, its observations, its tags, and
  // the contentless-FTS delete + insert that make them findable.
  //
  // Without it, a throw anywhere in the middle — a lock lost to the CLI, a
  // full disk, an FTS corruption — committed the prefix and dropped the
  // rest, and the two most likely resting places are both invisible:
  // observations inserted with no FTS row (a memory that exists and can
  // never be recalled), or the old FTS row deleted and the new one not
  // written (a memory that just stopped being findable). Neither is
  // retried, because the callers dedupe on the entity NAME existing —
  // `INSERT OR IGNORE` reports "already there" on the next run and the
  // half-written state is permanent.
  return db.transaction(() => captureEntityInner(db, { name, type, observations, tags, title, metadata }))();
}

function captureEntityInner(db, { name, type, observations, tags, title, metadata }) {
  // source_host provenance: these hooks only ever run under Claude Code (they
  // are wired into ~/.claude/settings.json), so a hook-captured entity is by
  // definition a claude-code capture. Stamped only on the INSERT — an OR
  // IGNORE re-capture of an existing entity must not overwrite provenance an
  // earlier writer (possibly another host, via MCP) already recorded.
  //
  // title_source: every title a hook writes is machine-derived, so it is
  // marked 'heuristic'. The mark is what lets a later LLM titling pass
  // (dreamer backfill) know which titles it may replace — an UNMARKED title
  // is treated as human-provided and never touched, so omitting the mark
  // here would make today's date+verb titles permanent.
  const insertMetadata = { ...(metadata ?? {}), provenance: { source_host: 'claude-code' } };
  if (title != null) insertMetadata.title_source = 'heuristic';
  const insertResult = db
    .prepare('INSERT OR IGNORE INTO entities (name, type, metadata, title) VALUES (?, ?, ?, ?)')
    .run(name, type, JSON.stringify(insertMetadata), title ?? null);
  const isNew = insertResult.changes > 0;
  const row = db.prepare('SELECT id, title FROM entities WHERE name = ?').get(name);
  if (!row) return null;
  const id = row.id;

  // Title update on an EXISTING entity — INSERT OR IGNORE never touches
  // `title` when the row already exists, so mirror knowledge-graph.ts's
  // createEntity(): only an explicit, actually-different value writes
  // anything. Captured BEFORE the write so the FTS delete below matches
  // what was indexed.
  const previousTitle = row.title;
  if (!isNew && title !== undefined && title !== previousTitle) {
    db.prepare('UPDATE entities SET title = ? WHERE id = ?').run(title, id);
    // Keep the heuristic mark in step with the write. Heal corrupted metadata
    // (replace with {}) instead of leaving it — a corrupted metadata row would
    // otherwise never get title_source stamped and remain permanently broken.
    const metaRow = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id);
    let meta = parseEntityMetadata(metaRow?.metadata);
    // Heal corrupted metadata: if parse returned null but metadata field exists,
    // it's corrupted — replace with {} and log the healing.
    if (!meta && metaRow?.metadata) {
      try {
        // The id, not the name. The id is what a maintainer needs to look
        // the row up; the name is user-authored content, and this line goes
        // to a stderr stream the user may paste anywhere.
        process.stderr.write(
          `MeMesh: healed corrupted metadata for entity ${id}. ` +
          `Original value was unparseable; replaced with {}.\n`,
        );
      } catch { /* stderr gone */ }
      meta = {};
      // Write the healed metadata immediately so it doesn't get skipped again
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run('{}', id);
    }
    // Stamp title_source on every title write (not just initial). This keeps
    // the source field synchronized with the current title, per Fix C3.
    if (title != null) {
      const updatedMeta = { ...(meta ?? {}), title_source: 'heuristic' };
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(updatedMeta), id);
    }
  }

  // Capture the previously-indexed observation text BEFORE inserting new rows,
  // so the contentless-FTS 'delete' below matches what was indexed. Only for
  // existing entities — a brand-new row has no prior FTS entry to remove.
  // indexedObservationText is the convention's single owner (explicit ORDER
  // BY + the one join rule), via the generated fts-index copy.
  const prevObsText = isNew ? undefined : indexedObservationText(db, id);

  const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
  for (const obs of observations) insertObs.run(id, obs);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
  for (const tag of tags) insertTag.run(id, tag);

  // Reindex FTS: delete the stale entry (if any) then insert the full,
  // current observation set. Uses the generated copy of src/storage/fts-index.ts
  // so the contentless-FTS5 delete+insert dance can no longer drift from core.
  if (prevObsText !== undefined) {
    removeFromFts(db, id, name, prevObsText, previousTitle);
  }
  // Compose the indexed text from data already in hand instead of
  // re-SELECTing the rows just inserted: prev text + the new observations,
  // joined by the owner's single rule. This runs on every
  // Stop/PreCompact/PostToolUse capture, and the re-read grew with an
  // upserted entity's accumulated observation count.
  const obsParts = [];
  if (prevObsText) obsParts.push(prevObsText);
  if (observations.length) obsParts.push(joinIndexedObservations(observations));
  const allObsText = joinIndexedObservations(obsParts);
  // Current title is fully determined by the branches above — no re-read.
  const currentTitle = isNew
    ? (title ?? null)
    : ((title !== undefined && title !== previousTitle) ? title : previousTitle);
  insertFtsRow(db, id, name, allObsText, currentTitle);

  return { id, isNew };
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dirPath, PRIVATE_DIR_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

export function writePrivateFile(filePath, content) {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  try {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

export function writePrivateJson(filePath, value) {
  writePrivateFile(filePath, JSON.stringify(value));
}

export function parseEntityMetadata(rawMetadata) {
  if (!rawMetadata) return null;
  if (typeof rawMetadata === 'object') return rawMetadata;
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// The POLICY (which metadata may be auto-injected) lives in the
// work-topology leaf — isAutoInjectable — shared with the MCP briefing
// surface so the gate cannot fork. This wrapper keeps only the raw-column
// contract the hooks need: null column = no metadata recorded = allowed;
// an unparseable column = fail closed.
export function isTrustedForAutoContext(rawMetadata) {
  if (rawMetadata == null) return true;
  const metadata = parseEntityMetadata(rawMetadata);
  if (!metadata) return false;
  return isAutoInjectable(metadata);
}

// buildReferenceContext moved to src/core/work-topology.ts (re-exported above)
// so the MCP briefing surface and the hooks share one fence implementation.

// ─── Auto-update shared helpers ─────────────────────────────────────────────
// Shared between SessionStart and Stop hooks for auto-update coordination.

export function readUpdateCheckCache(installedVersion) {
  if (process.env.MEMESH_UPDATE_CHECK_PATH) {
    try {
      const overridePath = process.env.MEMESH_UPDATE_CHECK_PATH;
      if (!existsSync(overridePath)) return null;
      const parsed = JSON.parse(readFileSync(overridePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }
  const versionTag = typeof installedVersion === 'string'
    && /^[0-9A-Za-z.+-]+$/.test(installedVersion)
    ? installedVersion
    : 'unknown';
  const cachePath = join(memeshDir(), `update-check.${versionTag}.json`);
  try {
    if (!existsSync(cachePath)) return null;
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/;

export function classifyBumpHook(from, to) {
  const a = SEMVER_RE.exec((from || '').trim());
  const b = SEMVER_RE.exec((to || '').trim());
  if (!a || !b) return null;
  const ai = a.slice(1, 4).map(Number);
  const bi = b.slice(1, 4).map(Number);
  if (bi[0] > ai[0]) return 'major';
  if (bi[0] < ai[0]) return null;
  if (bi[1] > ai[1]) return 'minor';
  if (bi[1] < ai[1]) return null;
  if (bi[2] > ai[2]) return 'patch';
  return null;
}

const POLICY_RANK = { off: 0, patch: 1, minor: 2, major: 3 };
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const AUTO_UPDATE_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export function decideAutoUpdateHook(currentVersion, cache, policy) {
  if (!cache || cache.currentVersion !== currentVersion) return { run: false };
  const latest = cache.latestVersion;
  if (typeof latest !== 'string' || !latest) return { run: false };
  const bump = classifyBumpHook(currentVersion, latest);
  if (!bump) return { run: false };

  const lastSuccessAt = cache.lastSuccessfulCheckAt;
  const lastSuccessMs = typeof lastSuccessAt === 'string' ? Date.parse(lastSuccessAt) : NaN;
  const cacheAgeMs = Number.isFinite(lastSuccessMs) ? Date.now() - lastSuccessMs : Infinity;
  if (cacheAgeMs > AUTO_UPDATE_CACHE_FRESHNESS_MS) {
    return { run: false, reason: 'stale-cache' };
  }

  const policyAllows = (POLICY_RANK[policy] ?? 0) >= BUMP_RANK[bump];
  if (policyAllows) return { run: true, latest, bump, deprecationOverride: false };

  const deprecated = typeof cache.currentVersionDeprecation === 'string'
    && cache.currentVersionDeprecation.length > 0;
  if (deprecated && bump === 'patch') {
    return { run: true, latest, bump, deprecationOverride: true };
  }

  return { run: false };
}

export function logAutoUpdate(line) {
  try {
    const dir = getMemeshDirFromDbPath();
    ensurePrivateDir(dir);
    const path = join(dir, 'auto-update.log');
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
    try { chmodSync(path, 0o600); } catch { /* non-POSIX */ }
  } catch {
    // Logging is best-effort.
  }
}

export const AUTO_UPDATE_LOCK_TTL_MS = 10 * 60 * 1000;

export function tryAcquireAutoUpdateLock(version) {
  try {
    const dir = memeshDir();
    ensurePrivateDir(dir);
    const lockPath = join(dir, 'auto-update.lock');
    const fs = require('fs');
    const myToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payload = `${myToken}\n${process.pid}\n${Date.now()}\n${version}\n`;
    try {
      // O_CREAT|O_EXCL is the POSIX atomic create primitive — only one process wins.
      const O_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
      const fd = fs.openSync(lockPath, O_FLAGS, 0o600);
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      return { acquired: true, lockPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    let stat;
    try { stat = fs.statSync(lockPath); } catch { return { acquired: false, lockPath }; }
    if (Date.now() - stat.mtimeMs <= AUTO_UPDATE_LOCK_TTL_MS) {
      return { acquired: false, lockPath };
    }
    const tempPath = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      fs.writeFileSync(tempPath, payload, { mode: 0o600 });
      try { fs.unlinkSync(lockPath); } catch (e2) {
        if (e2?.code !== 'ENOENT') {
          try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
          return { acquired: false, lockPath };
        }
      }
      fs.renameSync(tempPath, lockPath);
    } catch {
      try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
      return { acquired: false, lockPath };
    }
    // The "race" here is the lock primitive itself: we just renamed our
    // temp file onto lockPath, then immediately read back to see whether
    // our token won. If a concurrent caller's rename landed in the
    // window between our rename and our read, their token is now there
    // and we correctly conclude we did NOT acquire the lock. That race
    // outcome IS the contract — last-writer-wins lock-file pattern, not
    // a TOCTOU defect. (CodeQL js/file-system-race #82 is dismissed on
    // the security dashboard with this rationale; CodeQL does not honor
    // inline suppression comments, so dismissal is the correct route.)
    let recorded;
    try { recorded = fs.readFileSync(lockPath, 'utf8'); } catch { return { acquired: false, lockPath }; }
    return recorded.split('\n')[0] === myToken
      ? { acquired: true, lockPath }
      : { acquired: false, lockPath };
  } catch {
    return { acquired: false, lockPath: null };
  }
}

/**
 * Spawn `npm install -g @pcircle/memesh@<version>` detached so the upgrade
 * can finish after this hook returns. Never blocks the session.
 *
 * @param {string} version - Target version to install
 * @param {boolean} deprecationOverride - Whether this is a security-override install
 * @param {object|null} installChannelMod - Preloaded dist/core/install-channel.js module
 * @returns {{ state: 'spawned'|'in-progress'|'channel'|'failed' }}
 */
export function spawnAutoUpdate(version, deprecationOverride, installChannelMod) {
  let lock = null;
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    let channel = 'unknown';
    if (installChannelMod) {
      try {
        channel = installChannelMod.getCurrentInstallChannel({ packageRoot: pluginRoot });
      } catch { /* best-effort */ }
    }
    if (channel !== 'npm-global') {
      logAutoUpdate(
        `auto-update SKIPPED: install channel '${channel}' does not support self-update via npm install -g`
      );
      return { state: 'channel' };
    }
    lock = tryAcquireAutoUpdateLock(version);
    if (!lock.acquired) {
      logAutoUpdate(
        `auto-update SKIPPED: another session already holds ${lock.lockPath ?? 'auto-update.lock'} for this upgrade`
      );
      return { state: 'in-progress' };
    }
    const dir = getMemeshDirFromDbPath();
    ensurePrivateDir(dir);
    const logPath = join(dir, 'auto-update.log');
    let fd = -1;
    try { fd = openSync(logPath, 'a', 0o600); } catch { fd = -1; }
    const stdio = fd >= 0 ? ['ignore', fd, fd] : 'ignore';
    const child = spawn(
      'npm',
      ['install', '-g', `@pcircle/memesh@${version}`],
      // windowsHide avoids a flashing console window on Windows; harmless on POSIX.
      { detached: true, stdio, env: process.env, windowsHide: true },
    );
    child.unref();
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    logAutoUpdate(
      `auto-update spawn: target=${version}${deprecationOverride ? ' (deprecation-override)' : ''} pid=${child.pid ?? 'unknown'} lock=${lock.lockPath}`
    );
    return { state: 'spawned' };
  } catch (err) {
    logAutoUpdate(`auto-update spawn FAILED: ${err?.message ?? err}`);
    if (lock?.acquired && lock.lockPath) {
      try { require('fs').unlinkSync(lock.lockPath); } catch { /* best-effort */ }
    }
    return { state: 'failed' };
  }
}
