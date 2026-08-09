import { MemeshDatabase } from './storage/sqlite.js';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { resolveEmbeddingDimension } from './core/config.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { getDbPath } from './core/paths.js';
import { insertFtsRow } from './storage/fts-index.js';
import type { PragmaColumnRow } from './core/types.js';

let db: MemeshDatabase | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSON
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL,
  to_entity_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_entity ON tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
DELETE FROM tags
WHERE id NOT IN (
  SELECT MIN(id)
  FROM tags
  GROUP BY entity_id, tag
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_entity_tag_unique ON tags(entity_id, tag);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(type, created_at);

-- Migration markers and small bits of persistent state (index segmentation
-- version, embedding dimension, pending-reindex flags, backfill markers).
--
-- This used to be created ad hoc by each helper that needed it — four inline
-- CREATE TABLE IF NOT EXISTS copies in src/db.ts, none of them visible to
-- scripts/check-schema-drift.mjs, which only extracts SCHEMA_SQL and FTS_SQL.
-- A column added to one copy would not have been caught. It also meant the
-- hook-side schema had no metadata table at all, so hooks could not
-- participate in migrations even in principle.
CREATE TABLE IF NOT EXISTS memesh_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, observations, content='',
  tokenize='unicode61 remove_diacritics 1'
);

-- Term -> document-count view over the index above. Stores nothing of its own;
-- it exists so search() can drop query terms that appear in most of the corpus,
-- which are the ones BM25 already scores near zero. See dropUbiquitousTerms().
CREATE VIRTUAL TABLE IF NOT EXISTS fts_vocab USING fts5vocab(entities_fts, 'row');
`;

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
function initialiseDatabase(db: MemeshDatabase, resolvedPath: string): MemeshDatabase {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);

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

  // Migrate: add status column if missing (v2.11 -> v2.12)
  // Conditional ALTER TABLE blocks ARE idempotent within a single
  // process, but two processes (e.g. CLI + HTTP server starting back-
  // to-back, or a hook running concurrently with `memesh recall`) can
  // race: each reads its own PRAGMA snapshot, both see "column missing",
  // both run ALTER, the second one throws SQLITE_ERROR: duplicate column
  // name. `safeAlter` treats that one error as the expected no-op
  // outcome (a peer beat us to it). Any other error rethrows so we
  // don't paper over real bugs. Mirrors `scripts/hooks/_shared.js`'s
  // openHookDb exactly — the bug shape was caught there first; the
  // core side was untreated until a reviewer flagged the asymmetry.
  const safeAlter = (sql: string): void => {
    try {
      db.exec(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  };

  const columns = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
  if (!columns.some((c) => c.name === 'status')) {
    safeAlter("ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)");
  }

  // Migrate: add scoring columns if missing (v2.14 -> v2.15)
  const scoringCols = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
  if (!scoringCols.some((c) => c.name === 'access_count')) {
    safeAlter("ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0");
    safeAlter("ALTER TABLE entities ADD COLUMN last_accessed_at TIMESTAMP");
    safeAlter("ALTER TABLE entities ADD COLUMN confidence REAL DEFAULT 1.0");
    safeAlter("ALTER TABLE entities ADD COLUMN valid_from TIMESTAMP");
    safeAlter("ALTER TABLE entities ADD COLUMN valid_until TIMESTAMP");
  }

  // Migrate: add namespace column if missing (v3.0.0-rc -> v3.0.0)
  if (!scoringCols.some((c) => c.name === 'namespace')) {
    safeAlter("ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'personal'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace)");
  }

  // Migrate: add recall effectiveness columns if missing (v4.0.0)
  const recallCols = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
  if (!recallCols.some((c) => c.name === 'recall_hits')) {
    safeAlter("ALTER TABLE entities ADD COLUMN recall_hits INTEGER DEFAULT 0");
    safeAlter("ALTER TABLE entities ADD COLUMN recall_misses INTEGER DEFAULT 0");
  }

  // Run auto-decay: reduce confidence for stale entities (throttled to once per 24h)
  runAutoDecay(db);

  // Phase-1 of #39: backfill metadata.signal_score on any entity
  // that doesn't already have one. One-time scan per install (the
  // marker key 'signal_score_backfill_v1' guards against repeats).
  // Rule-based scorer is fast — 3000 entities cost ~50ms. Future
  // schema-version bumps to the scorer can re-run by changing the
  // marker key.
  backfillSignalScores(db);

  // Phase-2 of #39 (LLM cluster compactor): proposed digests live in
  // a staging table, written by the dreamer and reviewed by the user
  // before any source entities are archived. Mirrors Mem0's 4-op
  // tool-call constraint + Graphiti's invalidate-don't-delete +
  // claude-mem dream-skill's safety promise.
  ensureDreamProposalsTable(db);

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
  db.enableLoadExtension(true);
  try {
    sqliteVec.load(db);
  } finally {
    db.enableLoadExtension(false);
  }

  // Create/migrate vector table for entity embeddings
  // Dimension depends on embedding provider (768=Ollama, 1536=OpenAI;
  // 384 is the keyword-only default that also matches legacy tables)
  // `confident` is false only when the config file exists but could not be
  // read. ensureVecTable DROPs on a dimension mismatch, so acting on a
  // fallback dimension derived from an unreadable config would delete a BYOK
  // user's entire vector index because of a truncated write.
  const { dimension: targetDim, confident: dimensionKnown } = resolveEmbeddingDimension();
  ensureVecTable(db, resolvedPath, targetDim, dimensionKnown);

  return db;
}

/**
 * Version of the text segmentation applied to `entities_fts`. Bump this and the
 * index is rebuilt once, on the next open, for every existing database.
 *
 *   2 — text is NFC-normalised BEFORE segmentation, on both the index and the
 *       query side, via `toIndexForm`. Version 1 normalised on the query side
 *       only, and after segmenting: decomposed text was indexed under
 *       different code points than the same text composed, and a decomposed
 *       query was never split into bigrams at all.
 *
 *   1 — CJK / kana / hangul runs split into overlapping character bigrams
 *       (`segmentUnspacedScripts` in src/storage/fts-index.ts). Before this,
 *       `unicode61` indexed an unbroken run as a single token, so a Chinese
 *       memory was reachable only by searching the exact stored string.
 *
 *   3 — the same treatment for every OTHER spaceless script. Version 2 listed
 *       the scripts that had come up rather than the property that matters, so
 *       Thai, Lao, half-width katakana and CJK Extension B kept the exact
 *       defect version 1 fixed — measured on a fresh database, each stored
 *       fine and was unfindable by any fragment of itself. Segmentation is
 *       also code-point aware now; Extension B is above the BMP, and building
 *       bigrams over UTF-16 code units would have indexed half-surrogates.
 */
export const FTS_SEGMENTATION_VERSION = 3;

/**
 * Rebuild `entities_fts` when the segmentation rules have changed.
 *
 * Follows the `embedding_dimension` idiom above: a marker in `memesh_metadata`,
 * compared on open, migrating in place. The difference is that this one can
 * always finish its work — the source text lives in `entities` + `observations`,
 * so nothing is lost and there is no `pending_reindex` flag to raise. Measured
 * at 19ms for 5,000 entities, so it runs inline rather than being deferred.
 *
 * Archived entities are deliberately not reindexed: `archiveEntity()` removes
 * them from FTS5 by design, and `search()` reaches them through a separate LIKE
 * scan.
 */
/** How long a failed migration waits before trying again. */
const MIGRATION_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Run a versioned migration at most once, atomically, with a retry backoff.
 *
 * Three properties, each of which was missing and each of which cost
 * something:
 *
 * **The version check happens inside the write transaction.** The FTS rebuild
 * used to read its source rows before `db.transaction()` opened, and
 * The default transaction is BEGIN DEFERRED, so no write lock
 * existed until the first statement inside it. Seven hooks, the MCP server,
 * the HTTP server and the CLI all open this database; an entity committed by
 * any of them between the read and the `delete-all` was wiped from the index
 * and never reinserted, because the in-memory row list predated it. The marker
 * then committed, so it never retried. Measured: the entity row survives, the
 * index has no trace of it, and the marker reads 1.
 *
 * `.immediate()` takes the write lock at BEGIN, so a concurrent writer either
 * finishes before the migration reads or waits until after it commits.
 *
 * **Failure backs off.** The old catch deliberately left the marker unset so
 * the next open would retry — but with no throttle, a persistently failing
 * rebuild re-paid a full corpus scan on every single process start, forever.
 * Its two neighbours in `openDatabase`, `runAutoDecay` and
 * `runAutoTelemetryPrune`, are both throttled to once per 24h; this now
 * matches them.
 *
 * **A failure is never fatal.** The database still opens. Entities and
 * observations are the source of truth and are untouched by an index rebuild,
 * so a failed migration degrades retrieval rather than losing anything.
 *
 * @returns true if the migration ran and committed
 */
/**
 * Is this a "someone else is using the database right now" error?
 *
 * These resolve on their own; treating them as permanent would park a
 * migration for 24h over a moment of contention.
 */
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  const msg = (err as { message?: string })?.message ?? '';
  return (
    /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL/.test(code) ||
    /database is locked|database table is locked|locking protocol/i.test(msg)
  );
}

export function runOnceMigration(
  db: MemeshDatabase,
  opts: {
    key: string;
    version: number;
    describe: string;
    migrate: (db: MemeshDatabase, fromVersion: number) => void;
  }
): boolean {
  const { key, version, describe, migrate } = opts;
  const attemptKey = `${key}_last_attempt`;

  const readMarker = (k: string): string | undefined =>
    (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(k) as
      | { value: string }
      | undefined)?.value;

  // Cheap pre-check outside the lock: the overwhelmingly common case is
  // "already migrated", and taking a write lock on every open to discover
  // that would serialise every process that touches the database.
  const stored = readMarker(key);
  if (stored && parseInt(stored, 10) >= version) return false;

  const lastAttempt = readMarker(attemptKey);
  if (lastAttempt && Date.now() - parseInt(lastAttempt, 10) < MIGRATION_RETRY_BACKOFF_MS) {
    return false;
  }

  try {
    db.transaction(() => {
      // Re-read under the write lock. Another process may have completed this
      // same migration between the pre-check and BEGIN IMMEDIATE.
      const current = readMarker(key);
      if (current && parseInt(current, 10) >= version) return;

      migrate(db, current ? parseInt(current, 10) : 0);

      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(
        key,
        String(version)
      );
      db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(attemptKey);
    }).immediate();
    return true;
  } catch (err) {
    // A lock held by a peer is not a broken migration. Backing off 24h for one
    // would leave the database on the old index for a day while write paths use
    // the new rules — and on a contentless FTS5 table that mismatch makes every
    // delete fail with "database disk image is malformed". Retry those on the
    // next open instead; reserve the backoff for failures that will still be
    // failures tomorrow.
    if (isTransientDbError(err)) {
      process.stderr.write(
        `MeMesh: ${describe} deferred (${err instanceof Error ? err.message : String(err)}). ` +
          `Another process holds the database; it will run on the next start.\n`
      );
      return false;
    }

    // Record the attempt so a permanently failing migration does not re-run on
    // every process start. Best-effort: if even this write fails the database
    // is in no state to be helped by another try.
    try {
      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(
        attemptKey,
        String(Date.now())
      );
    } catch { /* nothing useful to do */ }

    process.stderr.write(
      `MeMesh: ${describe} failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Your memories are unaffected — this rebuilds a derived index. ` +
        `It will retry in 24h, or run 'memesh reindex --fts' to retry now.\n`
    );
    return false;
  }
}

function ensureFtsSegmentation(db: MemeshDatabase): void {
  runOnceMigration(db, {
    key: 'fts_segmentation_version',
    version: FTS_SEGMENTATION_VERSION,
    describe: 'search index rebuild',
    migrate: rebuildFtsIndex,
  });
}

/**
 * Delete and re-derive every active row in `entities_fts` from its source.
 *
 * Rows are read a page at a time rather than all at once. The previous
 * `.all()` built the entire corpus — every name plus all of its concatenated
 * observations — as a JS array before writing anything, which is roughly
 * 80 MB of Node heap at 100k entities, inside processes as short-lived as a
 * hook invocation.
 *
 * Paging rather than `.iterate()`: writing while an iterator is open on the
 * same connection is not something to rely on, and the whole point here is to
 * write as we read. Keyset pagination on `e.id` keeps memory bounded to one
 * page, keeps the order deterministic, and leaves the connection free between
 * pages.
 *
 * Archived entities are deliberately not reindexed: `archiveEntity()` removes
 * them from FTS5 by design, and `search()` reaches them through a separate
 * LIKE scan.
 *
 * MUST be called inside a write transaction — `delete-all` empties the index,
 * so an interrupted rebuild that is not rolled back leaves search blank.
 */
const FTS_REBUILD_PAGE_SIZE = 500;

function rebuildFtsIndex(db: MemeshDatabase): void {
  // This ALWAYS rebuilds. There used to be a skip here, and removing it is a
  // bug fix, not a performance regression accepted for simplicity.
  //
  // The skip read `if (fromVersion === 1 && !hasDecomposedText(db)) return;`,
  // justified by "v2 differs from v1 ONLY by NFC-normalising before
  // segmenting". That was true when the target was 2. Version 3 also WIDENS
  // `UNSPACED_SCRIPT_RANGES` (Thai, Lao, Khmer, half-width katakana, CJK Ext
  // B), and none of those scripts has a canonical decomposition — so
  // `hasDecomposedText` is false for exactly the corpora the widening exists
  // to fix. Measured: a v1 database holding Thai and half-width katakana came
  // out of the upgrade with its marker stamped 3, its index still holding v1
  // whole-run tokens, and every fragment query returning nothing. The marker
  // only moves forward, so it never self-heals. Worse, the query side DOES
  // segment, so half-width katakana and Ext B lost the exact-full-string
  // query that worked before the upgrade.
  //
  // A version-keyed skip is only sound while the sole delta is normalisation,
  // and nothing forces the next author to re-derive that. `_shared.js`'s
  // hook-side twin never had the skip, so the two also disagreed: the same
  // database ended up in one of two index states depending on which process
  // opened it first, and doctor's own stale-index check called one of them
  // damaged. Rebuilding unconditionally is what makes the two halves agree.
  //
  // The cost it bought back was 140ms against 13ms on a 20k-entity database,
  // once per database per version bump. That is not worth a class of bug that
  // silently makes memories unreachable.
  db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");

  const page = db.prepare(
    `SELECT e.id, e.name, COALESCE(group_concat(o.content, ' '), '') AS obs
       FROM entities e
       LEFT JOIN observations o ON o.entity_id = e.id
      WHERE e.status = 'active' AND e.id > ?
      GROUP BY e.id
      ORDER BY e.id
      LIMIT ?`
  );

  let afterId = 0;
  for (;;) {
    const rows = page.all(afterId, FTS_REBUILD_PAGE_SIZE) as Array<{
      id: number;
      name: string;
      obs: string;
    }>;
    if (rows.length === 0) break;

    for (const row of rows) insertFtsRow(db, row.id, row.name, row.obs);
    afterId = rows[rows.length - 1].id;

    if (rows.length < FTS_REBUILD_PAGE_SIZE) break;
  }
}

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
    try {
      db.exec("ALTER TABLE dream_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'entities'");
    } catch (err) {
      // Concurrent opener won the race and added it first — the only
      // tolerable error here is the duplicate-column one.
      if (!String((err as Error).message).includes('duplicate column name')) throw err;
    }
  }
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
 * `runAutoDecay` and the `signal_score_backfill_v1` backfill). Closes
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
 * One-time pass keyed by 'signal_score_backfill_v1' in
 * memesh_metadata. Subsequent openDatabase calls are no-ops. If the
 * scorer rules change materially, bump the marker key (v2, v3…) to
 * trigger a re-scan against the new rules.
 *
 * Safe to run on a fresh DB (no entities → no-op) and on a 50k DB
 * (~200ms at rule-based speed). Reads observations + tags per
 * entity to feed the scorer the same inputs createEntity uses.
 */
function backfillSignalScores(db: MemeshDatabase): void {

  const MARKER = 'signal_score_backfill_v1';
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
      try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { metadata = {}; }
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
