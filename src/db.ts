import { MemeshDatabase } from './storage/sqlite.js';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { resolveEmbeddingDimension } from './core/config.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { getDbPath } from './core/paths.js';
import { insertFtsRow, joinIndexedObservations, removeFromFts } from './storage/fts-index.js';
import {
  SCHEMA_SQL,
  FTS_SQL,
  safeAlter,
  migrateEntitiesSchema,
  ensureTagsUniqueIndex,
  ensureHookRunsSince,
  ensureFtsSegmentation,
  rebuildFtsIndex,
  runOnceMigration,
  FTS_SEGMENTATION_VERSION,
} from './storage/schema.js';

// Existing import surface (tests, sqlite driver docs) — the implementations
// moved to storage/schema.ts, the shared owner both core and the hooks run.
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
import type { PragmaColumnRow } from './core/types.js';
import { truncateTitle, isBoilerplateObservation } from './core/title.js';

let db: MemeshDatabase | null = null;
/** The dimension-mismatch notice has been printed this process. See ensureVecTable. */
let dimensionMismatchNoticed = false;

// SCHEMA_SQL / FTS_SQL and the whole migration toolkit live in
// storage/schema.ts — the single owner both this file and the hooks (via
// scripts/hooks/_generated/schema.js) execute. The ~300-line hand-mirror
// this file and _shared.js used to keep "in lockstep" is gone.




export function openDatabase(dbPath?: string): MemeshDatabase {
  if (db) return db;

  const resolvedPath = dbPath ?? getDbPath();

  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }

  // The module singleton is published only once initialisation SUCCEEDS.
  //
  // This used to assign `db` first and initialise through it, so any throw
  // after `new Database()` — a peer holding the write lock during SCHEMA_SQL, a
  // read-only file, a failed extension load — left the singleton pointing at a
  // handle with no schema, no migrations and no sqlite-vec. `if (db) return db`
  // then handed that handle to every later caller in the process, forever.
  // Reproduced: with a peer holding BEGIN EXCLUSIVE the first call threw
  // "database is locked", and the next call returned the poisoned handle and
  // threw "no such table: memesh_metadata" — while `runOnceMigration`'s
  // careful transient-error backoff, which exists precisely so a held lock is
  // retried later, never got the chance to run.
  //
  // Failing closed matters more than usual here: writes would still go through
  // `insertFtsRow`'s current segmentation rules into an index that was never
  // migrated, which is the contentless-FTS delete mismatch the rest of this
  // release exists to eliminate.
  const opening = new MemeshDatabase(resolvedPath, { allowExtension: true });
  try {
    initialiseDatabase(opening, resolvedPath);
  } catch (err) {
    try { opening.close(); } catch { /* already closing down */ }
    throw err;
  }
  db = opening;
  return db;
}

/**
 * Everything `openDatabase` does to a freshly-opened handle before it is safe
 * to publish. Extracted so the failure path has something to unwind: while this
 * was inline, "assign the singleton" and "finish initialising it" could not be
 * separated.
 */
/**
 * Is this error SQLite refusing a write because the database FILE is
 * read-only? The one error class the open path deliberately survives.
 */
function isReadonlyDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /readonly database|SQLITE_READONLY/i.test(msg);
}

function initialiseDatabase(db: MemeshDatabase, resolvedPath: string): MemeshDatabase {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Bringing the schema current is a WRITE, and "cannot migrate" must not
  // mean "cannot open": a database file that is read-only (a backup, a
  // snapshot, a permissions accident) but behind on schema used to die
  // right here — first on a DML statement that lived inside SCHEMA_SQL,
  // and once that moved out, on the CREATE TABLE any release adds. The
  // class of failure is the same each time, so the tolerance is general:
  // if the file refuses writes, open it for what it can still do — reads.
  // Anything else still throws; a read-only file is the ONE state where
  // an incomplete migration is survivable, because nothing can write to
  // the old shape either.
  try {
    migrateToCurrentSchema(db, resolvedPath);
  } catch (err) {
    if (!isReadonlyDbError(err)) throw err;
    try {
      process.stderr.write(
        'MeMesh: the database file is read-only, so schema migration was skipped — ' +
          'opened for reads only. Capture and migrations resume when the file is writable.\n',
      );
    } catch { /* stderr gone */ }
  }
  return db;
}

/**
 * Everything that makes an opened handle CURRENT: schema, FTS, one-time
 * migrations, maintenance sweeps and the vector table. Split from
 * `initialiseDatabase` so the read-only-file tolerance above has a single
 * boundary to wrap — every statement in here may write, and none of them
 * is load-bearing for reading what the database already holds.
 */

function migrateToCurrentSchema(db: MemeshDatabase, resolvedPath: string): void {
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  ensureTagsUniqueIndex(db);
  ensureHookRunsSince(db);

  // Tighten file mode on the DB and its WAL/SHM sidecars so other local
  // users on a shared system cannot read memory contents. The DB
  // contains all observations and possibly secrets pasted into Claude.
  //
  // Two-layer defence:
  //   1. Tighten the process umask BEFORE writing any sidecar so that
  //      any SQLite-created -wal/-shm files (including ones recreated
  //      after a checkpoint(TRUNCATE) or fresh shm-mapping) are born
  //      with 0600. The earlier one-shot chmod missed sidecars that
  //      SQLite created later during normal operation.
  //   2. Belt-and-suspenders: explicitly chmod the existing files now,
  //      in case the umask was looser when this process started and
  //      SQLite already created them.
  try { process.umask(0o077); } catch { /* non-POSIX */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(`${resolvedPath}${suffix}`, 0o600); }
    catch { /* sidecar may not exist yet, or non-POSIX */ }
  }

  // The full conditional-ALTER chain — shared with the hooks via
  // storage/schema.ts, so a new column lands in ONE place and reaches both
  // sides of the F5 boundary through the generated copy.
  migrateEntitiesSchema(db);

  // Run auto-decay: reduce confidence for stale entities (throttled to once per 24h)
  runAutoDecay(db);

  // Phase-1 of #39: backfill metadata.signal_score on any entity
  // that doesn't already have one. One-time scan per install (the
  // MARKER key in backfillSignalScores guards against repeats).
  // Rule-based scorer is fast — 3000 entities cost ~50ms. Future
  // schema-version bumps to the scorer can re-run by changing the
  // marker key.
  backfillSignalScores(db);

  // UX-1: give pre-title rows a human-readable heuristic title. Same
  // marker + fill-only discipline as backfillSignalScores above.
  backfillTitles(db);

  // A1: release the auto-injection block on memories a human already
  // accepted via `dream accept`. Same marker + fill-only discipline.
  backfillAcceptedProposalTrust(db);

  // Phase-2 of #39 (LLM cluster compactor): proposed digests live in
  // a staging table, written by the dreamer and reviewed by the user
  // before any source entities are archived. Mirrors Mem0's 4-op
  // tool-call constraint + Graphiti's invalidate-don't-delete +
  // claude-mem dream-skill's safety promise.
  ensureDreamProposalsTable(db);

  // Conflict pipeline: pairs an LLM has already judged (P2 writes them;
  // candidate generation excludes them so a pair called UNRELATED is not
  // re-bought on every run). Keyed by the sorted entity-id pair, NOT the
  // dreamer's cluster_key — cluster membership drifts, an id pair does not.
  ensureConflictJudgedPairsTable(db);

  // LLM telemetry: every callLLM attempt (primary + each fallback)
  // gets a row so the user can answer "what did memesh's LLM
  // pipeline actually do this week?". Without this, primary outages
  // (rotated keys, rate limits) stay invisible — which is exactly
  // what bit the maintainer when their Anthropic key died.
  ensureLlmTelemetryTable(db);

  // Auto-prune telemetry rows older than 180 days, throttled to once
  // per 24h. Closes the "no automatic retention" known limitation
  // documented in v4.2.0 CHANGELOG. One indexed DELETE — milliseconds
  // even at 100k rows.
  runAutoTelemetryPrune(db);

  // Rebuild entities_fts once when the way text is segmented changes.
  // Databases written before CJK segmentation hold whole-run tokens that no
  // segmented query can match, so without this the change would take Chinese
  // recall from bad to zero while English kept working — a silent regression.
  ensureFtsSegmentation(db);

  // Load sqlite-vec extension for vector similarity search.
  //
  // node:sqlite gates extension loading twice — `allowExtension` at open time
  // (see openDatabase) and this switch — and `sqliteVec.load` is just
  // `db.loadExtension(path)`, so without the switch it throws. It is turned
  // back off immediately: nothing else in memesh loads an extension, and
  // leaving the door open would let any later SQL in this process load
  // arbitrary native code.
  //
  // A FAILED load is survivable, and used not to be. sqlite-vec ships its
  // engine as a per-platform file through optionalDependencies, so on a
  // platform it does not publish npm installs the wrapper, installs no binary,
  // and says nothing — and this call threw straight out of `openDatabase`.
  // Measured before changing it: hiding `sqlite-vec-darwin-arm64` made both
  // `memesh remember` and `memesh recall` exit 1 with a raw
  // ERR_MODULE_NOT_FOUND stack trace. That contradicted memesh's own design,
  // stated in the README and in `reindex()`'s own error text: vector search
  // SUPPLEMENTS FTS5 keyword recall. A supplement must not be able to stop the
  // database from opening.
  //
  // So the failure is caught, traced once to stderr (never swallowed — see
  // `hasVectorIndex`), and the vector table is simply not created. Every site
  // that touches `entities_vec` asks first.
  let vectorIndexAvailable = true;
  db.enableLoadExtension(true);
  try {
    sqliteVec.load(db);
  } catch (err) {
    vectorIndexAvailable = false;
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `MeMesh: sqlite-vec could not be loaded (${detail}).\n` +
      'MeMesh: recall will use FTS5 keyword search only. `memesh doctor` explains this row.\n'
    );
  } finally {
    db.enableLoadExtension(false);
  }

  if (vectorIndexAvailable) {
    // Create/migrate vector table for entity embeddings
    // Dimension depends on embedding provider (768=Ollama, 1536=OpenAI;
    // 384 is the keyword-only default that also matches legacy tables)
    // `confident` is false only when the config file exists but could not be
    // read. ensureVecTable DROPs on a dimension mismatch, so acting on a
    // fallback dimension derived from an unreadable config would delete a BYOK
    // user's entire vector index because of a truncated write.
    const { dimension: targetDim, confident: dimensionKnown } = resolveEmbeddingDimension();
    ensureVecTable(db, resolvedPath, targetDim, dimensionKnown);
  }
}

// FTS_SEGMENTATION_VERSION, runOnceMigration, isTransientDbError,
// rebuildFtsIndex and ensureFtsSegmentation live in storage/schema.ts (the
// shared owner) — re-exported below for the existing import surface.



/**
 * Rebuild the full-text index on demand, regardless of the version marker.
 *
 * The marker is monotonic, which leaves one state it cannot describe: a
 * database migrated by a segmentation-aware build, then written to by an older
 * one. The older build does not know the marker exists, so it indexes new
 * memories with the old rules and leaves the marker alone; re-upgrading then
 * short-circuits and those memories stay unreachable by any partial-phrase
 * query. Users legitimately end up in that state — an npm-global and a
 * plugin-marketplace install side by side, or a deliberate downgrade to
 * recover from a bad release.
 *
 * Rather than guess at version archaeology the older build left no trace of,
 * this is the escape hatch: an explicit, always-runs rebuild. `memesh doctor`
 * detects the condition directly and points here.
 */
export function reindexFts(): { entities: number } {
  const database = getDatabase();
  // Rebuild and marker in ONE immediate transaction, so a failure between them
  // cannot leave a rebuilt index under a stale marker. The marker only moves
  // forward, so that state never reconciles itself.
  //
  // Pinned by `tests/migration-atomicity.test.ts`, which fails the marker write
  // exactly where a crash would — a BEFORE INSERT trigger on `memesh_metadata`
  // — and asserts the rebuild rolled back with it. This was first written off
  // as untestable, on the grounds that observing it needs the process killed
  // mid-transaction. That was a failure to design the test: the fault can be
  // injected in-process, deterministically. Splitting the transaction fails it.
  //
  // `.immediate()` specifically is NOT load-bearing here, and the test does not
  // claim it is: `rebuildFtsIndex` now has no read half, so its first executed
  // statement is the `delete-all` write and a DEFERRED transaction takes the
  // lock at the same instant. Confirmed by mutation — `.immediate()` -> `()`
  // changes nothing observable. It stays for consistency with
  // `runOnceMigration`, where the callback reads BEFORE writing and the
  // distinction is the whole fix.
  database.transaction(() => {
    rebuildFtsIndex(database);
    database
      .prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
      .run('fts_segmentation_version', String(FTS_SEGMENTATION_VERSION));
    database.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(
      'fts_segmentation_version_last_attempt'
    );
  }).immediate();

  const { c } = database
    .prepare("SELECT count(*) AS c FROM entities WHERE status = 'active'")
    .get() as { c: number };
  return { entities: c };
}

/**
 * Ensure entities_vec table exists with the correct dimension.
 *
 * A dimension change deletes nothing. The existing index is kept and keeps
 * answering queries; the mismatch is recorded as a rebuild owed, and
 * `memesh reindex` builds the new width in a staging generation and swaps it
 * in only once complete (see `beginVectorGeneration` / `swapVectorGeneration`).
 * There is no destructive branch here to consent to any more.
 */
function ensureVecTable(
  db: MemeshDatabase,
  resolvedPath: string,
  targetDim: number,
  dimensionKnown = true
): void {
  const storedDim = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'"
  ).get() as { value: string } | undefined;

  const currentDim = storedDim ? parseInt(storedDim.value, 10) : 0;

  const vecExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'"
  ).get();

  if (vecExists && currentDim === targetDim) {
    return; // table exists with correct dimension
  }

  // Refuse to destroy vectors on a dimension we are not sure of.
  //
  // `targetDim` comes from the config, and an unreadable config yields the
  // 384-dim keyword-only default — indistinguishable, before this guard, from a
  // user who genuinely configured nothing. For a BYOK user on OpenAI's 1536-dim
  // embeddings that meant a momentarily corrupt or unreadable config file
  // deleted every vector in the database: no backup, no confirmation, and
  // regenerating them means re-running the whole embedding pipeline and
  // paying an API provider for it a second time.
  //
  // Keeping the existing table is the safe direction. A stale-but-correct
  // index degrades to "embeddings still work as before"; a dropped one is
  // unrecoverable.
  if (vecExists && !dimensionKnown) {
    process.stderr.write(
      `MeMesh: embedding dimension could not be determined (config unreadable), so the ` +
        `existing ${currentDim}-dim vector index was left untouched rather than rebuilt. ` +
        `Fix ~/.memesh/config.json to change embedders.\n`
    );
    return;
  }

  // The same refusal whenever the database and the config disagree about the
  // dimension, whatever state the config is in.
  //
  // This used to be gated on the config being ABSENT (`!configPresent`), on the
  // argument that an absent config is weak evidence. It is — the config and the
  // database are located by independent environment variables: `configDir()`
  // follows MEMESH_DIR/HOME, `getDbPath()` follows MEMESH_DB_PATH. A process
  // that opens this database under a different HOME (an HTTP server started
  // from launchd/systemd, `sudo memesh doctor`, a script with an isolated HOME
  // and MEMESH_DB_PATH pointed at the real file) sees no config and would read
  // that as "the user configured nothing", then drop a BYOK user's 1536-dim
  // index.
  //
  // But *present* is not the same as *authoritative*, and the guard was keyed
  // to the wrong fact. Every one of those foreign-HOME cases behaves
  // identically when the foreign HOME happens to contain a config file — a
  // container image shipping a default config.json, a second machine profile, a
  // config whose embedder key was lost to an unrelated edit. The guard then
  // treats it as authoritative for a database it has never seen, and takes the
  // DROP branch on exactly the evidence the guard exists to distrust.
  //
  // So the refusal follows the consequence instead: a stale-but-correct index
  // degrades to "embeddings keep working as before" and is recoverable by
  // restoring the config, while a dropped one is gone, and on an API embedder
  // has to be paid for a second time. A dimension change now drops nothing at
  // all, so there is no longer any consent to ask for.
  //
  // This used to be the one destructive step in the whole open path: with
  // consent recorded by `reindex --vectors`, the DROP committed here — before
  // the refill loop had even started — so a run that died at 60% left 40% of
  // the graph with no vector at all, and on a paid provider the finished 60%
  // had to be bought a second time. The consent flow made that loss deliberate
  // rather than accidental, which is not the same as making it acceptable.
  //
  // Generations replace it (see `beginVectorGeneration` and
  // `swapVectorGeneration`): the new index is built in a staging table at the
  // new width while this one keeps answering queries, and the live table is
  // only ever replaced by a complete, verified generation inside one
  // transaction. So the honest thing to do on a dimension change is nothing at
  // all — record that a rebuild is owed and let `reindex` do it safely.
  if (vecExists && currentDim !== 0 && currentDim !== targetDim) {
    // The marker write below is idempotent, but this notice is for a human and
    // fires on EVERY open. `memesh doctor` opens the database twice in one run
    // (the database check and the hook-activity check each take their own
    // handle), so the same paragraph printed twice back to back and read like
    // a retry loop. Once per process is the right cadence for a notice whose
    // content cannot change between opens.
    if (!dimensionMismatchNoticed) {
      process.stderr.write(
      `MeMesh: this database records ${currentDim}-dim embeddings but the current ` +
        `configuration asks for ${targetDim}. Nothing is deleted — the index is kept ` +
        `so a rebuild can resume — but semantic search is OFF until the rebuild ` +
        `finishes, because a ${targetDim}-dim query cannot be matched against a ` +
        `${currentDim}-dim index; recall is on keyword search alone meanwhile. ` +
        `Run 'memesh reindex' to build the ${targetDim}-dim index alongside it and ` +
        `switch over once it is complete.\n`
      );
      dimensionMismatchNoticed = true;
    }
    // Outside the guard on purpose: the marker is written on EVERY open, the
    // notice only once. A brace edit that moved this line inside survived the
    // whole suite in review — hence the structure, and the test that pins it.
    markReindexOwed(currentDim, targetDim, 'dimension-change', db);
    return;
  }

  // DROP + marker + CREATE + dimension stamp must be one unit. Unwrapped, a
  // kill between the DROP and the marker write destroyed every vector while
  // leaving no `pending_reindex` row — so the next open saw no table at all,
  // skipped this branch entirely, created an empty one and stamped the new
  // dimension. `memesh doctor` then reported a healthy install over a silently
  // emptied index.
  // Only two cases reach here now: no table yet, or a table already at the
  // target width. Both are creation-or-nothing, so there is no DROP left in
  // the open path at all — the branch that used to drop a mismatched table is
  // gone rather than commented out, because the dimension-change case returns
  // above and could never enter it.
  db.transaction(() => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(
        embedding float[${targetDim}]
      );
    `);

    db.prepare(
      "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('embedding_dimension', ?)"
    ).run(String(targetDim));
  }).immediate();
}

// =============================================================================
// Vector index generations — build beside, verify, swap atomically
// =============================================================================
//
// `entities_vec` is a vec0 virtual table keyed only on rowid, with its width
// fixed in the DDL (`float[N]`). Two generations cannot live in one such table,
// which is why changing embedder used to mean dropping every vector first and
// hoping the refill finished: a run that died at 60% left 40% of the graph
// unsearchable, and on a paid provider the completed 60% had to be bought
// again.
//
// A second table is the way out, and three facts were MEASURED against
// sqlite-vec v0.1.9 before this was built rather than assumed:
//
//   1. `ALTER TABLE ... RENAME` does NOT work on a vec0 table. It reports
//      success and leaves the table unreadable — vec0 keeps four shadow tables
//      (`_chunks`, `_info`, `_rowids`, `_vector_chunks00`) and the rename
//      touches none of them, so the first read fails with
//      `no such table: main.<new>_rowids`. Swapping by rename is not available.
//   2. Two vec0 tables of DIFFERENT widths coexist happily. So the new
//      generation can be built at the new dimension while the old one keeps
//      answering every query.
//   3. DROP + CREATE + copy inside one transaction really does roll back: with
//      the swap forced to fail before COMMIT, a FRESH connection still read the
//      original table at its original width with all rows present. (Checked on
//      the data, not on `sqlite_master` — a table NAME returning proves
//      nothing about the vectors.)
//
// So: build into `entities_vec_next`, verify it, then one immediate
// transaction drops the old table, recreates it at the new width, copies the
// rows across and drops the staging table. Every reader keeps the name it
// already hardcodes; none of them needs to know generations exist.

/** Exported so no caller has to repeat the literal. `operations.ts` used to
 *  hardcode its own copy, one module boundary away from the constant, so a
 *  rename here would have surfaced as "no such table" mid-rebuild. */
export const GENERATION_TABLE = 'entities_vec_next';
const GENERATION_HASH_TABLE = 'entities_vec_next_source';
const GENERATION_KEY = 'vector_generation';

/** Ask whether a table is there rather than catching the failure of reading it.
 *  These answers decide whether a finished generation is promoted and which
 *  entities a resume re-buys, so "the read failed" must not be able to arrive as
 *  "nothing is staged" — a locked database or a corrupt vec0 shadow table would
 *  otherwise be laundered into a verdict about work. `view` is included so the
 *  unreachable edge fails toward found: a false negative is what licenses a DROP. */
function tableExists(conn: MemeshDatabase, name: string): boolean {
  return (conn.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = ?"
  ).get(name) as { c: number }).c > 0;
}

/** The width is interpolated into DDL because SQLite cannot parameterise a
 *  type. Every caller passes a value from a fixed table, but the functions that
 *  do the interpolating are exported and a TypeScript annotation is not a
 *  runtime check. */
function assertVectorWidth(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 65536) {
    throw new Error(`Refusing to build a vector index at width ${String(dimension)}.`);
  }
}

/** What a half-built generation records about itself, so a resume can tell
 *  whether it is still resumable. A generation built by a different provider
 *  or at a different width is not a generation to continue — it is one to
 *  discard, because its vectors are not comparable with the ones we would add. */
export interface VectorGenerationInfo {
  dimension: number;
  provider: string;
  startedAt: string;
}

/**
 * Three states, not two.
 *
 * This used to return `info | null`, collapsing "there is no generation" and
 * "the marker exists but I could not read it" into one answer — and the caller
 * treats a null as licence to DROP the staging table. So a `JSON.parse` failure,
 * a field of the wrong type, or any SQLite read error silently threw away every
 * embedding a previous run had already produced (and, on a paid provider, paid
 * for). Absence of a readable answer is not absence of work.
 */
export type VectorGenerationRead =
  | { state: 'none' }
  | { state: 'unreadable'; detail: string }
  | { state: 'open'; info: VectorGenerationInfo };

export function readVectorGeneration(): VectorGenerationRead {
  if (!db) return { state: 'none' };
  try {
    const row = db.prepare(
      'SELECT value FROM memesh_metadata WHERE key = ?'
    ).get(GENERATION_KEY) as { value: string } | undefined;
    if (!row) return { state: 'none' };
    const parsed = JSON.parse(row.value) as Partial<VectorGenerationInfo>;
    if (typeof parsed.dimension !== 'number' || typeof parsed.provider !== 'string') {
      return { state: 'unreadable', detail: 'the marker is missing its dimension or provider' };
    }
    return {
      state: 'open',
      info: {
        dimension: parsed.dimension,
        provider: parsed.provider,
        startedAt: String(parsed.startedAt ?? ''),
      },
    };
  } catch (err) {
    return { state: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Rows already embedded into the staging generation, so a resume asks the
 *  provider only for what it has not paid for yet. */
export function generationRowIds(): Set<number> {
  const out = new Set<number>();
  if (!db) return out;
  if (!tableExists(db, GENERATION_TABLE)) return out;
  const rows = db.prepare(`SELECT rowid AS id FROM ${GENERATION_TABLE}`).all() as Array<{ id: number | bigint }>;
  for (const r of rows) out.add(Number(r.id));
  return out;
}

/**
 * Open a generation at `dimension`, reusing a compatible half-built one.
 *
 * Returns whether the staging table was reused, so the caller can say
 * "resuming" rather than implying a fresh start it did not make.
 */
export function beginVectorGeneration(dimension: number, provider: string): { resumed: boolean } {
  assertVectorWidth(dimension);
  const conn = getDatabase();
  const read = readVectorGeneration();
  const stagingExists = tableExists(conn, GENERATION_TABLE);

  // An unreadable marker over a POPULATED staging table is the one case where
  // neither choice is safe to make silently. Resuming could merge two embedding
  // spaces, which is the exact drift this mechanism exists to prevent; discarding
  // throws away work a previous run already did and, on a paid provider, already
  // paid for. So refuse, say which it is, and hand over the deliberate way out.
  if (read.state === 'unreadable' && stagingExists) {
    throw new Error(
      'A half-built vector index is present but its marker cannot be read '
      + `(${read.detail}). Resuming it risks mixing vectors from two different `
      + 'embedding spaces, and discarding it throws away embeddings a previous run '
      + 'already produced, so neither is done automatically. Run '
      + '`memesh reindex --discard-generation` to throw the half-built index away '
      + 'and start clean.',
    );
  }

  const existing = read.state === 'open' ? read.info : null;
  const compatible = stagingExists && existing !== null
    && existing.dimension === dimension && existing.provider === provider;

  if (stagingExists && !compatible) {
    // A leftover from a different provider or width. Its vectors live in a
    // different space, so mixing them with new ones would be the drift this
    // whole mechanism exists to prevent.
    discardVectorGeneration();
  }

  // `startedAt` is the generation's ORIGINAL start, kept across a resume. It
  // used to be rewritten on every call, including the resume path.
  const startedAt = compatible && existing ? existing.startedAt : new Date().toISOString();

  conn.transaction(() => {
    conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${GENERATION_TABLE} USING vec0(embedding float[${dimension}])`);
    // What each staged row was built FROM. A resume that skips a row because
    // "it is already staged" is only right while the row still matches the
    // entity's current text; without this it promoted a vector for text that no
    // longer existed, and nothing could detect it afterwards because the row was
    // present. Plain table, dropped with the generation it describes.
    conn.exec(
      `CREATE TABLE IF NOT EXISTS ${GENERATION_HASH_TABLE} (`
      + 'rowid_ref INTEGER PRIMARY KEY, text_hash TEXT NOT NULL)',
    );
    conn.prepare(
      'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
    ).run(GENERATION_KEY, JSON.stringify({ dimension, provider, startedAt }));
  }).immediate();

  return { resumed: compatible };
}

/** What each staged row was embedded from, so a resume can tell fresh from stale. */
export function generationRowHashes(): Map<number, string> {
  const out = new Map<number, string>();
  if (!db) return out;
  if (!tableExists(db, GENERATION_HASH_TABLE)) return out;
  const rows = db.prepare(
    `SELECT rowid_ref AS id, text_hash AS h FROM ${GENERATION_HASH_TABLE}`
  ).all() as Array<{ id: number | bigint; h: string }>;
  for (const r of rows) out.set(Number(r.id), r.h);
  return out;
}

/** Record what a row was just embedded from. Called only for staged writes. */
export function recordGenerationRow(entityId: number, textHash: string): void {
  const conn = getDatabase();
  conn.prepare(
    `INSERT OR REPLACE INTO ${GENERATION_HASH_TABLE} (rowid_ref, text_hash) VALUES (?, ?)`
  ).run(BigInt(entityId), textHash);
}

/** Throw away a half-built generation, leaving the live index untouched. */
export function discardVectorGeneration(): void {
  const conn = getDatabase();
  conn.transaction(() => {
    conn.exec(`DROP TABLE IF EXISTS ${GENERATION_TABLE}`);
    conn.exec(`DROP TABLE IF EXISTS ${GENERATION_HASH_TABLE}`);
    conn.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(GENERATION_KEY);
  }).immediate();
}

/**
 * Promote the staging generation to be the live index, or change nothing.
 *
 * One immediate transaction. A failure anywhere rolls the whole thing back and
 * the previous index is still the live one — measured, not assumed (see the
 * header note above).
 *
 * The live table is NOT simply overwritten by the staging table. Two
 * populations exist only in the live index, and a plain
 * `INSERT … SELECT FROM staging` silently discarded both:
 *
 *   1. Rows a concurrent writer added while the rebuild ran. Every writer
 *      except the rebuild loop targets the live table (`embedAndStore`'s
 *      `target` defaults to it), the loop works from an entity list snapshotted
 *      before it started, and the seven capture hooks do not stop for a
 *      rebuild. A memory captured mid-rebuild lost its vector outright; one
 *      whose observations were EDITED mid-rebuild was worse, because the swap
 *      replaced the fresh vector with the staged pre-edit one and
 *      `countMissingVectors` cannot see a row that is present but stale.
 *      So: rows still active and absent from staging are carried across —
 *      but only when the live index is already at this width, because vectors
 *      of a different width are not comparable and there is nothing to carry
 *      (a concurrent write during a width change is refused as
 *      `dimension_mismatch`, so that population is empty by construction).
 *   2. Conversely, a row staged for an entity that has since been archived or
 *      forgotten. `archiveEntity`/`deleteEntity` delete from the live table
 *      only — they do not know a staging table exists — and the rebuild loop
 *      lists `status = 'active'`, so it never revisits the entity to remove it.
 *      Promoting that row resurrected a memory the user deleted. So staging is
 *      pruned of non-active rows FIRST, which is also what lets the caller
 *      compare counts for equality instead of with `>=`: the orphan was the
 *      reason staging could legitimately hold MORE rows than the run owed.
 *
 * `pending_reindex` is deliberately NOT touched here. It has one owner —
 * `reindex()`, which measures the finished index with `countMissingVectors`
 * after this returns and either clears the marker or writes it. Clearing it
 * here pre-empted that decision: on a width change the marker was set at open
 * and this transaction deleted it before the measurement could keep it,
 * leaving `memesh doctor` (whose only vector check reads this row) quiet over
 * a graph that was still owed vectors.
 */
export function swapVectorGeneration(dimension: number): void {
  assertVectorWidth(dimension);
  const conn = getDatabase();
  conn.transaction(() => {
    conn.exec(
      `DELETE FROM ${GENERATION_TABLE} WHERE rowid NOT IN `
      + `(SELECT id FROM entities WHERE status = 'active')`,
    );

    const storedDim = Number(
      (conn.prepare(
        "SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'"
      ).get() as { value: string } | undefined)?.value ?? 0,
    );
    if (storedDim === dimension) {
      conn.exec(
        `INSERT INTO ${GENERATION_TABLE} (rowid, embedding) `
        + `SELECT v.rowid, v.embedding FROM entities_vec v `
        + `WHERE v.rowid IN (SELECT id FROM entities WHERE status = 'active') `
        + `AND v.rowid NOT IN (SELECT rowid FROM ${GENERATION_TABLE})`,
      );
    }

    // The row count is re-read HERE, inside the transaction. The figure the
    // caller printed as "verified (N vectors)" was read outside it, so between
    // the two a second process could have changed the set being installed.
    const staged = (conn.prepare(
      `SELECT COUNT(*) AS c FROM ${GENERATION_TABLE}`
    ).get() as { c: number }).c;

    conn.exec('DROP TABLE IF EXISTS entities_vec');
    conn.exec(`CREATE VIRTUAL TABLE entities_vec USING vec0(embedding float[${dimension}])`);
    conn.exec(`INSERT INTO entities_vec (rowid, embedding) SELECT rowid, embedding FROM ${GENERATION_TABLE}`);

    const installed = (conn.prepare(
      'SELECT COUNT(*) AS c FROM entities_vec'
    ).get() as { c: number }).c;
    // UNPINNED, deliberately: no test covers this branch, because the condition
    // it guards — `INSERT … SELECT` copying fewer rows than the source holds —
    // has no reachable trigger to construct from outside. It is defence in depth
    // for the one step that cannot be undone, kept and labelled rather than
    // dropped for being untestable or given a test that proves nothing.
    if (installed !== staged) {
      // Rolls the whole swap back, previous index intact.
      throw new Error(
        `Vector index swap copied ${installed} of ${staged} staged rows; refusing to publish a short index.`,
      );
    }

    conn.exec(`DROP TABLE ${GENERATION_TABLE}`);
    conn.exec(`DROP TABLE IF EXISTS ${GENERATION_HASH_TABLE}`);
    conn.prepare(
      'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
    ).run('embedding_dimension', String(dimension));
    conn.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(GENERATION_KEY);
  }).immediate();
}

/**
 * The width `entities_vec` was actually built at, or 0 when nothing is
 * recorded. This is the STORED width, not the configured one — the two
 * disagree for the whole window between switching embedder and finishing a
 * rebuild, and that disagreement is exactly what callers need to detect.
 */
export function getStoredEmbeddingDimension(): number {
  if (!db) return 0;
  const row = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'"
  ).get() as { value: string } | undefined;
  return row ? Number(row.value) || 0 : 0;
}

export interface PendingReindexInfo {
  from: number;
  to: number;
  /** When the need was first NOTICED. Nothing is dropped any more — this field
   *  was called `droppedAt` while naming a deletion that no longer happens. */
  noticedAt: string;
  reason: 'dimension-change' | 'vectors-missing';
}

export function getPendingReindexInfo(): PendingReindexInfo | null {
  return readPendingReindex(db);
}

function readPendingReindex(conn: MemeshDatabase | null): PendingReindexInfo | null {
  if (!conn) return null;
  try {
    const row = conn.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'"
    ).get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/**
 * Record that this database is owed a vector rebuild.
 *
 * Written only when the need is new or has changed, for two reasons. Every
 * process that opens a mismatched database used to rewrite this row, which put
 * a write — and therefore the write lock — on the open path of every hook
 * invocation and every MCP handshake. And overwriting it each time meant
 * "since when has this been owed" could never be answered: the timestamp always
 * read as just now.
 */
export function markReindexOwed(
  from: number,
  to: number,
  reason: PendingReindexInfo['reason'],
  conn: MemeshDatabase | null = db,
): void {
  // `conn` defaults to the module singleton, but the open path MUST pass its
  // own handle: `initialiseDatabase` runs before `db = opening` is assigned,
  // so during open the singleton is still null and the old `if (!db) return`
  // silently skipped the write. The marker was therefore never recorded on a
  // dimension change at open — the exact "doctor reports PASS over a database
  // owed a rebuild" defect this function exists to prevent. Measured: 20 opens
  // of a 384-vs-1536 database printed the warning every time and wrote nothing.
  if (!conn) return;
  const existing = readPendingReindex(conn);
  if (existing && existing.from === from && existing.to === to && existing.reason === reason) {
    return;
  }
  conn.prepare(
    "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('pending_reindex', ?)"
  ).run(JSON.stringify({
    from,
    to,
    reason,
    noticedAt: existing?.noticedAt ?? new Date().toISOString(),
  } satisfies PendingReindexInfo));
}

export function clearPendingReindexFlag(): void {
  if (!db) return;
  db.prepare("DELETE FROM memesh_metadata WHERE key = 'pending_reindex'").run();
}

/**
 * Create the dream_proposals staging table (#39 Phase 2).
 *
 * Every consolidation pass writes proposals here BEFORE touching the
 * source entities. The `memesh dream review` flow reads from here to
 * present accept/reject decisions to the user. Once accepted, the
 * dreamer apply path creates the digest entity + soft-archives the
 * sources via metadata.compacted_into. Rejection just deletes the
 * proposal row; sources are never disturbed.
 *
 * Schema notes:
 *   - source_ids: JSON array of entity ids the proposal would compact.
 *   - proposed_digest: JSON with name + type + observations + tags
 *     the dreamer wants to insert as the digest entity.
 *   - status: 'pending' | 'accepted' | 'rejected' | 'applied'.
 *     'applied' means the digest has been created + sources archived;
 *     useful for an audit trail of what consolidations have run.
 *   - llm_model + prompt_version stamped so we can re-run with a new
 *     model later and compare quality without losing the old proposal.
 */
function ensureDreamProposalsTable(db: MemeshDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      proposed_digest TEXT NOT NULL,
      llm_model TEXT,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_status ON dream_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_project ON dream_proposals(project);
  `);

  // source_kind distinguishes where a proposal's raw material came from:
  // 'entities' (the original path — clusters of already-captured KG rows) or
  // 'transcript' (mined directly from a Claude Code session JSONL, which does
  // not depend on any capture hook having fired). Additive with a default so
  // every pre-existing proposal reads as 'entities' — no backfill, no
  // reclassification. Idempotent via the PRAGMA guard, matching the entities
  // ALTER blocks above.
  const dpCols = db.prepare("PRAGMA table_info(dream_proposals)").all() as PragmaColumnRow[];
  if (!dpCols.some((c) => c.name === 'source_kind')) {
    safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'entities'");
  }
  // What accepting the proposal DOES: 'digest' creates an entity (compaction
  // or pattern — those two are discriminated by cluster_key/type, as before);
  // 'relation' creates a RELATION between two existing entities and archives
  // nothing (the conflict pipeline's judge stages these). A column and not a
  // cluster_key convention because the dreamer's pending-proposal scans
  // compare source_ids as entity-id arrays — a relation row's [a,b] pair
  // would read as a two-entity digest and cancel real compaction work.
  if (!dpCols.some((c) => c.name === 'kind')) {
    safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'digest'");
  }
}

/**
 * Pairs the conflict pipeline's LLM judge has already ruled on.
 *
 * Written by P2 (one row per judged pair, whatever the verdict); read by
 * candidate generation (src/core/conflict-candidates.ts) so a pair judged
 * UNRELATED is never re-bought, and by the audit trail. `pair_key` is the
 * sorted entity-id pair ("minId:maxId") — deliberately NOT the dreamer's
 * cluster_key, whose membership drifts between runs.
 */
function ensureConflictJudgedPairsTable(db: MemeshDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conflict_judged_pairs (
      pair_key TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      proposal_id INTEGER,
      judged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Per-call telemetry for every LLM provider attempt across all 5
 * Smart-Mode flows (dreamer, pattern-detector, consolidator,
 * auto-tagger, failure-analyzer). One row PER ATTEMPT, not per call —
 * a single high-level call that fails on Anthropic and falls through
 * to Ollama writes 2 rows so the failover behaviour itself is
 * observable.
 *
 * Schema kept narrow on purpose: prompt content is NEVER recorded
 * (would add a privacy boundary the rest of memesh doesn't carry),
 * and tokens are NULL until/unless the providers expose them in
 * response bodies. Error messages are passed through callLLM's
 * `redactSecrets()` before reaching this table — the persistence
 * here is defence in depth, not the primary safeguard.
 */
function ensureLlmTelemetryTable(db: MemeshDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      flow TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      project TEXT,
      attempt_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error_class TEXT,
      error_message TEXT,
      fallback_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_llm_telemetry_ts ON llm_telemetry(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_telemetry_flow ON llm_telemetry(flow);
    CREATE INDEX IF NOT EXISTS idx_llm_telemetry_status ON llm_telemetry(status);
  `);
}

const TELEMETRY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TELEMETRY_PRUNE_DEFAULT_DAYS = 180;
const TELEMETRY_PRUNE_MARKER = 'last_telemetry_prune_at';

/**
 * Auto-prune `llm_telemetry` rows older than 180 days, throttled to
 * once per 24h via a marker key in `memesh_metadata` (same pattern as
 * `runAutoDecay` and the signal-score backfill). Closes
 * the "no automatic retention" known limitation documented in the
 * v4.2.0 CHANGELOG.
 *
 * Cheap: one indexed DELETE backed by `idx_llm_telemetry_ts`,
 * milliseconds even at 100k rows. Caller can run an explicit prune
 * via `pruneTelemetry()` (or `memesh telemetry --prune <days>`) at
 * any time — this is the no-touch background sweep.
 */
function runAutoTelemetryPrune(db: MemeshDatabase): void {

  const last = db.prepare(
    'SELECT value FROM memesh_metadata WHERE key = ?'
  ).get(TELEMETRY_PRUNE_MARKER) as { value: string } | undefined;

  if (last) {
    const elapsed = Date.now() - new Date(last.value).getTime();
    if (elapsed < TELEMETRY_PRUNE_INTERVAL_MS) return;
  }

  const cutoffIso = new Date(
    Date.now() - TELEMETRY_PRUNE_DEFAULT_DAYS * 86400000
  ).toISOString();
  try {
    db.prepare('DELETE FROM llm_telemetry WHERE ts < ?').run(cutoffIso);
  } catch {
    // If the table is missing for any reason, don't crash openDatabase.
    return;
  }

  db.prepare(
    'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
  ).run(TELEMETRY_PRUNE_MARKER, new Date().toISOString());
}

/**
 * Backfill metadata.signal_score on existing entities (#39 Phase 1).
 *
 * One-time pass keyed by the MARKER constant below. Subsequent
 * openDatabase calls are no-ops. If the scorer rules change materially,
 * or a bug leaves rows unscored, bump the marker's version suffix to
 * trigger a re-scan.
 *
 * The marker is named by pointing at the constant, not by quoting its
 * value: three comments in this file quoted 'v1' and all three still
 * said it after the code moved to v2. A copy of a fact drifts; a
 * pointer cannot.
 *
 * Safe to run on a fresh DB (no entities → no-op) and on a 50k DB
 * (~200ms at rule-based speed). Reads observations + tags per
 * entity to feed the scorer the same inputs createEntity uses.
 */
function backfillSignalScores(db: MemeshDatabase): void {

  // v2 re-runs the scan once. `remember()` used to rebuild an entity's
  // metadata from a snapshot taken before the row was written, discarding the
  // score stamped at creation — so every memory written through `remember`
  // after the v1 backfill has none. Left alone, an upgraded graph is split:
  // old rows scored, remember-written rows not, and the three consumers
  // disagree about what a missing score means (kg-backfill treats it as 1.0,
  // the dreamer as 0.5, the dashboard passes it through). The pass only fills
  // rows that lack a score, so re-running costs one scan and changes nothing
  // that already has one.
  const MARKER = 'signal_score_backfill_v2';
  const done = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = ?"
  ).get(MARKER);
  if (done) return;

  const rows = db.prepare(
    'SELECT id, name, type, metadata FROM entities'
  ).all() as Array<{ id: number; name: string; type: string; metadata: string | null }>;

  if (rows.length === 0) {
    db.prepare(
      "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)"
    ).run(MARKER, new Date().toISOString());
    return;
  }

  const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
  const tagStmt = db.prepare('SELECT tag FROM tags WHERE entity_id = ?');
  const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');

  const tx = db.transaction(() => {
    let scored = 0;
    let skipped = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      if (row.metadata) {
        // Unparseable metadata is LEFT ALONE. The catch used to fall back to
        // `{}`, and the row is written back whole further down — so a column
        // this function could not read was replaced by one holding only a
        // score, destroying whatever was in it. Harmless while the pass ran
        // once on a young graph; not harmless now that it re-runs.
        try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { skipped++; continue; }
        if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) { skipped++; continue; }
      } else {
        metadata = {};
      }
      if (typeof metadata.signal_score === 'number') {
        skipped++;
        continue;
      }
      const observations = (obsStmt.all(row.id) as Array<{ content: string }>).map(o => o.content);
      const tags = (tagStmt.all(row.id) as Array<{ tag: string }>).map(t => t.tag);
      metadata.signal_score = computeSignalScore({
        type: row.type,
        name: row.name,
        observations,
        tags,
      });
      updateStmt.run(JSON.stringify(metadata), row.id);
      scored++;
    }
    db.prepare(
      "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)"
    ).run(MARKER, JSON.stringify({ at: new Date().toISOString(), scored, skipped }));
  });
  tx();
}

// Title cap + truncation come from core/title.ts — the single owner all
// three writers (schemas validation, hook generators via _generated/, this
// backfill) execute. The hand-mirrored copy that lived here is gone.

/**
 * Derive a heuristic title for a pre-title row, or null to leave it
 * untitled. Null is a fine answer: the dashboard's display fallback
 * (pickBestObservation → typeLabel+date) already covers untitled rows,
 * so a title is only written when it says something the fallback cannot.
 * Never derived from `name` — that is the machine key the title exists
 * to hide.
 */
function deriveHeuristicTitle(type: string, observations: string[]): string | null {
  if (observations.length === 0) return null;

  // Failure lessons: the Error line is the story. Strip the label,
  // keep the first line of the description.
  if (type === 'lesson_learned' || type === 'lesson' || type === 'mistake') {
    const errObs = observations.find((o) => /^Error:\s*/.test(o.trim()));
    if (errObs) {
      const firstLine = errObs.trim().replace(/^Error:\s*/, '').split('\n')[0].trim();
      if (firstLine) return truncateTitle(firstLine);
    }
  }

  // Commits: post-commit.js stores the commit subject as the first
  // observation ("Branch: ..." / "Diff stats: ..." follow it).
  if (type === 'commit') {
    const first = observations[0]?.split('\n')[0].trim();
    if (first && !/^(Branch|Diff stats):/.test(first)) return truncateTitle(first);
  }

  // Generic: same selection MemoryRow's preview used pre-title — the
  // longest non-boilerplate observation among the first few — reduced
  // to its first line. Boilerplate list from core/title.ts (the union the
  // dashboard's preview picker also uses), so this backfill can no longer
  // pick a "title" the dashboard would have skipped as noise.
  const nonTrivial = observations.filter(
    (o) => o.length > 30 && !isBoilerplateObservation(o)
  );
  const pool = nonTrivial.length > 0 ? nonTrivial : observations;
  const best = pool.slice(0, 3).reduce((a, b) => (b.length > a.length ? b : a), pool[0]);
  const firstLine = best?.split('\n')[0].trim();
  return firstLine ? truncateTitle(firstLine) : null;
}

/**
 * Backfill `title` on rows created before the column existed (UX-1).
 *
 * Same shape as backfillSignalScores above: one-time pass keyed by the
 * MARKER constant, fill-only (`WHERE title IS NULL` — an existing title is
 * never overwritten, so the pass is idempotent by construction as well as
 * by marker), single transaction, unparseable metadata leaves the row
 * untouched. Every written title is stamped `metadata.title_source =
 * 'heuristic'` so a later LLM titling pass knows it may replace them;
 * an unmarked title is treated as human-provided and permanent.
 *
 * FTS: the title is folded into each entity's FTS feed on index, and these
 * rows were indexed BEFORE they had one — so every titled row must be
 * reindexed here, or the next contentless-FTS delete (issued with the
 * now-current title folded in) would not match what the index holds and
 * would silently corrupt it. Active rows only: archived rows have no FTS
 * entry (archiveEntity removes it), and a contentless delete for text that
 * was never indexed is exactly the corruption this block exists to avoid.
 */
/**
 * Clear the auto-injection block on memories a human accepted.
 *
 * `dream accept` used to stamp `metadata.trust = 'untrusted'` on the entity it
 * created, which `isTrustedForAutoContext` reads as "never inject this
 * unprompted". Measured on a real graph, that inverted the injection channel:
 * 74/74 raw commits were injectable while 29 facts, 11 lessons and 6 decisions
 * — every one of them human-accepted — were not. The write path stopped
 * setting the marker (see dreamer.ts); this releases the rows already carrying
 * it.
 *
 * Scoped by `proposal_id`, which only the two `dream accept` paths write, so
 * this can never touch an import or an auto-learned lesson — those mark
 * themselves untrusted with no human in the loop and must stay blocked.
 *
 * Fill-only and marker-guarded, like the two backfills below it: re-running is
 * a no-op, and an entity whose metadata will not parse is left exactly as it
 * is rather than being rewritten from a guess.
 */
function backfillAcceptedProposalTrust(db: MemeshDatabase): void {
  const MARKER = 'accepted_proposal_trust_v1';
  if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER)) return;

  const stamp = (cleared: number, skipped: number) =>
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
      .run(MARKER, JSON.stringify({ at: new Date().toISOString(), cleared, skipped }));

  // json_extract rather than a LIKE scan: the two markers are structural, and
  // a substring match would also hit an observation that merely quotes them.
  let rows: Array<{ id: number; metadata: string | null }>;
  try {
    rows = db.prepare(
      `SELECT id, metadata FROM entities
        WHERE metadata IS NOT NULL
          AND json_valid(metadata)
          AND json_extract(metadata, '$.trust') = 'untrusted'
          AND json_extract(metadata, '$.proposal_id') IS NOT NULL`,
    ).all() as Array<{ id: number; metadata: string | null }>;
  } catch {
    // A SQLite build without JSON1 cannot run the predicate. Leaving the
    // marker unset means a later open on a JSON1-capable build still does the
    // work — the honest outcome, versus stamping "done" over a pass that
    // never ran.
    return;
  }

  if (rows.length === 0) { stamp(0, 0); return; }

  const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
  const tx = db.transaction(() => {
    let cleared = 0;
    let skipped = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.metadata ?? '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { skipped++; continue; }
        metadata = parsed as Record<string, unknown>;
      } catch { skipped++; continue; }
      delete metadata.trust;
      updateStmt.run(JSON.stringify(metadata), row.id);
      cleared++;
    }
    stamp(cleared, skipped);
  });
  tx();
}

function backfillTitles(db: MemeshDatabase): void {
  const MARKER = 'title_backfill_v1';
  const done = db.prepare(
    'SELECT value FROM memesh_metadata WHERE key = ?'
  ).get(MARKER);
  if (done) return;

  const rows = db.prepare(
    'SELECT id, name, type, status, metadata FROM entities WHERE title IS NULL'
  ).all() as Array<{ id: number; name: string; type: string; status: string; metadata: string | null }>;

  const stamp = (titled: number, skipped: number) =>
    db.prepare(
      'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
    ).run(MARKER, JSON.stringify({ at: new Date().toISOString(), titled, skipped }));

  if (rows.length === 0) {
    stamp(0, 0);
    return;
  }

  const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id');
  const updateStmt = db.prepare('UPDATE entities SET title = ?, metadata = ? WHERE id = ?');

  const tx = db.transaction(() => {
    let titled = 0;
    let skipped = 0;
    for (const row of rows) {
      let metadata: Record<string, unknown>;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          // Skip rows with corrupt metadata — backfill should not overwrite
          // unparseable metadata, as we don't know what was stored there.
          skipped++;
          continue;
        }
        if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
          // Skip non-object metadata for the same reason
          skipped++;
          continue;
        }
      } else {
        metadata = {};
      }

      const observations = (obsStmt.all(row.id) as Array<{ content: string }>).map(o => o.content);
      const title = deriveHeuristicTitle(row.type, observations);
      if (!title) { skipped++; continue; }

      metadata.title_source = 'heuristic';
      updateStmt.run(title, JSON.stringify(metadata), row.id);

      if (row.status === 'active') {
        const obsText = joinIndexedObservations(observations);
        removeFromFts(db, row.id, row.name, obsText); // pre-title index entry: no title folded
        insertFtsRow(db, row.id, row.name, obsText, title);
      }
      titled++;
    }
    db.prepare(
      'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
    ).run(MARKER, JSON.stringify({ at: new Date().toISOString(), titled, skipped }));
  });
  tx();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  // The dimension-mismatch notice is once per DATABASE LIFETIME, not once per
  // process: a process that closes one database and opens another (the test
  // suite does this hundreds of times; a long-lived server could) must be
  // told again. Without this reset, the second database's warning was
  // silently swallowed by the first one's.
  dimensionMismatchNoticed = false;
}

export function getDatabase(): MemeshDatabase {
  if (!db) throw new Error('Database not opened');
  return db;
}

// F16: Used by callers (e.g. doctor) that need to know whether the global
// database is already open before they touch it. The HTTP server opens
// the db at startup and expects it to stay open for the process lifetime;
// any caller that opens-and-closes inside a request handler would close
// the server's shared connection. Such callers must check this flag and
// skip the close if the db was open before they arrived.
export function isDatabaseOpen(): boolean {
  return db !== null;
}
