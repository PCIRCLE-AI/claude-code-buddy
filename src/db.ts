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
 * One-shot permission to destroy the vector index.
 *
 * `ensureVecTable` runs inside `openDatabase`, long before any command-line
 * flag can be consulted, so the consent has to be recorded before the database
 * is opened and read once when the decision is made. `memesh reindex --vectors`
 * is the only thing that grants it, and only after confirming an embedding
 * provider is actually available — granting it without one would drop the
 * index and then have nothing to refill it with.
 *
 * One-shot on purpose: a long-lived process (the HTTP server) that opened the
 * database once with consent must not carry it to a later reopen.
 */
let vectorRebuildConsentFor: string | null = null;

/**
 * Grant it, for ONE database. Returns whether the grant took.
 *
 * `canRefill` is a required argument rather than a check the caller is trusted
 * to have already made, because the ordering is the whole safety property:
 * dropping the index without a working embedding provider destroys every vector
 * and leaves nothing able to regenerate them — the exact unrecoverable loss the
 * refusal exists to prevent, caused by the command offered as the safe way
 * through it. Two adjacent statements in the CLI would enforce that ordering
 * only until someone moved one of them. Passed in rather than imported because
 * `embedder.ts` imports this module. It is async because the only honest form
 * of the check is to produce an embedding and measure it — see
 * `canRefillVectorIndex`.
 *
 * `dbPath` narrows the grant to the database the caller meant. Without it the
 * consent was a bare module-level boolean: in the HTTP server, or any process
 * that opens more than one database, a grant recorded for A could be spent by
 * an unrelated `openDatabase(B)` that happened to run first, and B's vectors —
 * never consented to, never asked about — would be the ones dropped.
 * Authorisation as wide as the process, for an action as narrow as one file.
 */
export async function allowVectorIndexRebuild(
  dbPath: string,
  canRefill: () => Promise<boolean>
): Promise<boolean> {
  if (!(await canRefill())) return false;
  vectorRebuildConsentFor = path.resolve(dbPath);
  return true;
}

/**
 * Spend it. True only for the database it was granted for; cleared either way,
 * so a grant never survives the open it was meant for.
 */
function consumeVectorRebuildConsent(resolvedPath: string): boolean {
  const granted = vectorRebuildConsentFor;
  vectorRebuildConsentFor = null;
  return granted !== null && granted === path.resolve(resolvedPath);
}

/**
 * Ensure entities_vec table exists with the correct dimension.
 *
 * A dimension change drops and recreates the table, destroying every stored
 * vector, so it happens only with explicit consent — see
 * {@link allowVectorIndexRebuild}. Without it the existing table is kept and
 * the mismatch is reported.
 */
function ensureVecTable(
  db: MemeshDatabase,
  resolvedPath: string,
  targetDim: number,
  dimensionKnown = true
): void {
  // Spend the consent here, before any early return, so it is scoped to ONE
  // open rather than to one rebuild. Consuming it only on the branch that uses
  // it would leave it armed whenever the dimensions happened to agree — and
  // the next open in that process could be a different database.
  const rebuildConsented = consumeVectorRebuildConsent(resolvedPath);

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
  // has to be paid for a second time. Anything unrecoverable needs consent, and
  // `memesh reindex --vectors` is where that consent is given — it drops and
  // recreates the table at the new dimension and immediately refills it.
  if (
    vecExists &&
    currentDim !== 0 &&
    currentDim !== targetDim &&
    !rebuildConsented
  ) {
    process.stderr.write(
      `MeMesh: this database records ${currentDim}-dim embeddings but the current ` +
        `configuration asks for ${targetDim}. Keeping the existing vector index rather ` +
        `than rebuilding it, because rebuilding deletes every stored vector. ` +
        `If the configuration is wrong, fix it. If you meant to switch embedders, run ` +
        `'memesh reindex --vectors' to rebuild the index at ${targetDim} and regenerate.\n`
    );
    return;
  }

  // DROP + marker + CREATE + dimension stamp must be one unit. Unwrapped, a
  // kill between the DROP and the marker write destroyed every vector while
  // leaving no `pending_reindex` row — so the next open saw no table at all,
  // skipped this branch entirely, created an empty one and stamped the new
  // dimension. `memesh doctor` then reported a healthy install over a silently
  // emptied index.
  db.transaction(() => {
    if (vecExists) {
      process.stderr.write(
        `MeMesh: Embedding dimension changed (${currentDim} → ${targetDim}). Rebuilding vector index.\n` +
        `MeMesh: Old embeddings deleted. Run 'memesh reindex' to regenerate vectors for all entities.\n` +
        `MeMesh: Without reindex, only newly accessed entities will be embedded.\n`
      );
      db.exec('DROP TABLE entities_vec');
      // Persist the reindex-needed state so `memesh doctor` can surface it
      // even after the process that dropped the table has exited.
      db.prepare(
        "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('pending_reindex', ?)"
      ).run(JSON.stringify({ from: currentDim, to: targetDim, droppedAt: new Date().toISOString() }));
    }

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

export function getPendingReindexInfo(): { from: number; to: number; droppedAt: string } | null {
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'"
    ).get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
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
