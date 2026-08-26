// =============================================================================
// schema — THE SQLite schema and its migration chain, in one place
// =============================================================================
//
// A runtime-leaf module (imports only sibling leaves), so
// scripts/generate-hook-core.mjs copies it into scripts/hooks/_generated/ and
// BOTH sides of the F5 boundary — core's openDatabase and the hooks'
// openHookDb — execute the same bytes. Until this module existed, _shared.js
// carried a ~300-line hand-mirror of SCHEMA_SQL + the ALTER chain +
// ensureTagsUniqueIndex + ensureHookRunsSince + the FTS segmentation rebuild,
// each block annotated "keep in lockstep" — a hand discipline, not a CI
// guarantee, and the discipline had already failed once (the P0 FTS bug).
// Every future ALTER lands here ONCE and reaches both sides through the
// generated copy, under the existing `git diff --exit-code` CI gate.

import type { MemeshDatabase } from './sqlite.js';
import { insertFtsRow } from './fts-index.js';
import { parseSqliteUtcMs } from '../core/time-utils.js';

export const SCHEMA_SQL = `
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
-- The tags dedup DELETE + idx_tags_entity_tag_unique creation live in
-- ensureTagsUniqueIndex(), AFTER this exec — the DELETE is a one-time
-- migration, and a DML statement in this string made every open start a
-- write transaction even when it deleted nothing (same reader-breaking
-- pattern as the hook_runs_since note below).
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(type, created_at);

-- Migration markers and small bits of persistent state (index segmentation
-- version, embedding dimension, pending-reindex flags, backfill markers).
--
-- This used to be created ad hoc by each helper that needed it — four inline
-- CREATE TABLE IF NOT EXISTS copies in src/db.ts, none of them visible to
-- schema checks. A column added to one copy would not have been caught. It
-- also meant the hook-side schema had no metadata table at all, so hooks
-- could not participate in migrations even in principle.
CREATE TABLE IF NOT EXISTS memesh_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Local agent messaging core. Messages are immutable, deliveries identify the
-- authorized recipient, events are the wakeup/catch-up surface, cursors keep
-- the internal sequence opaque, and receipts are append-only facts that remain
-- separate from delivery existence.
CREATE TABLE IF NOT EXISTS agent_messages (
  message_id         TEXT PRIMARY KEY,
  project            TEXT NOT NULL,
  sender             TEXT NOT NULL,
  sender_host        TEXT,
  recipient          TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  correlation_id     TEXT,
  reply_to_message_id TEXT,
  privacy            TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  provenance_json    TEXT NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_message_deliveries (
  delivery_id        TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  target_kind        TEXT NOT NULL DEFAULT 'principal' CHECK (target_kind IN ('principal', 'session')),
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  UNIQUE(message_id, project, recipient)
);

CREATE TABLE IF NOT EXISTS agent_message_events (
  event_sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL UNIQUE,
  message_id         TEXT NOT NULL,
  delivery_id        TEXT NOT NULL,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  event_kind         TEXT NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_message_idempotency (
  project            TEXT NOT NULL,
  sender             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  message_id         TEXT NOT NULL UNIQUE,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  PRIMARY KEY(project, sender, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_message_cursors (
  cursor_token       TEXT PRIMARY KEY,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  event_sequence     INTEGER NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_message_receipts (
  receipt_id         TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  receipt_kind       TEXT NOT NULL,
  actor              TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  detail_json        TEXT NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  UNIQUE(project, recipient, message_id, receipt_kind, idempotency_key)
);

-- Host-native push identity and lifecycle. A principal is stable, a session
-- instance is ephemeral, and every connection to that session gets a strictly
-- increasing generation. The activation checkpoint is intentionally created
-- at first principal registration: principal-targeted history at or before it
-- is durable inbox history, but is never replayed as a first-time host push.
CREATE TABLE IF NOT EXISTS agent_principals (
  project                     TEXT NOT NULL,
  principal_id                TEXT NOT NULL,
  activation_event_sequence   INTEGER NOT NULL,
  created_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project, principal_id)
);

CREATE TABLE IF NOT EXISTS agent_session_instances (
  project                  TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  adapter_kind             TEXT NOT NULL,
  last_generation          INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project, session_instance_id),
  FOREIGN KEY (project, principal_id) REFERENCES agent_principals(project, principal_id)
);

CREATE TABLE IF NOT EXISTS agent_session_connections (
  connection_id            TEXT PRIMARY KEY,
  project                  TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  adapter_kind             TEXT NOT NULL,
  router_instance_id       TEXT NOT NULL,
  lease_expires_at_ms      INTEGER NOT NULL,
  connected_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disconnected_at          TIMESTAMP,
  disconnect_reason        TEXT,
  UNIQUE(project, session_instance_id, generation),
  FOREIGN KEY (project, session_instance_id)
    REFERENCES agent_session_instances(project, session_instance_id)
);

CREATE TABLE IF NOT EXISTS agent_presence_facts (
  presence_fact_id          TEXT PRIMARY KEY,
  project                  TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  connection_id            TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  presence_kind            TEXT NOT NULL CHECK (presence_kind IN ('connected', 'heartbeat', 'disconnected', 'superseded')),
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (connection_id) REFERENCES agent_session_connections(connection_id)
);

-- Dispatch is at-least-once across a crash boundary. delivery_id is the stable
-- adapter dispatch key; attempt_id identifies one invocation. A host_accept is
-- a separate fact and never implies an agent acknowledgement or workflow
-- outcome.
CREATE TABLE IF NOT EXISTS agent_dispatch_attempts (
  attempt_id               TEXT PRIMARY KEY,
  delivery_id              TEXT NOT NULL,
  project                  TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  connection_id            TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  router_instance_id       TEXT NOT NULL,
  attempt_number           INTEGER NOT NULL,
  result                   TEXT NOT NULL DEFAULT 'started' CHECK (result IN ('started', 'adapter_returned', 'adapter_rejected', 'adapter_failed', 'stale_generation')),
  failure_code             TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at             TIMESTAMP,
  UNIQUE(delivery_id, attempt_number),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES agent_session_connections(connection_id)
);

CREATE TABLE IF NOT EXISTS agent_host_accepts (
  host_accept_id           TEXT PRIMARY KEY,
  attempt_id               TEXT NOT NULL UNIQUE,
  delivery_id              TEXT NOT NULL UNIQUE,
  adapter_kind             TEXT NOT NULL,
  receipt_json             TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attempt_id) REFERENCES agent_dispatch_attempts(attempt_id),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_ack_facts (
  ack_fact_id              TEXT PRIMARY KEY,
  delivery_id              TEXT NOT NULL,
  host_accept_id           TEXT NOT NULL,
  actor                    TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(delivery_id, actor, idempotency_key),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE,
  FOREIGN KEY (host_accept_id) REFERENCES agent_host_accepts(host_accept_id)
);

CREATE TABLE IF NOT EXISTS agent_workflow_facts (
  workflow_fact_id         TEXT PRIMARY KEY,
  delivery_id              TEXT NOT NULL,
  actor                    TEXT NOT NULL,
  workflow_state           TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(delivery_id, actor, idempotency_key),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_retention_facts (
  retention_fact_id        TEXT PRIMARY KEY,
  message_id               TEXT NOT NULL,
  actor                    TEXT NOT NULL,
  retention_state          TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, actor, idempotency_key),
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_message_events_recipient_sequence
  ON agent_message_events(project, recipient, event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_scope
  ON agent_message_deliveries(project, recipient, message_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_receipts_scope
  ON agent_message_receipts(project, recipient, message_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_cursors_unique_scope_sequence
  ON agent_message_cursors(project, recipient, event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_principals_activation
  ON agent_principals(project, activation_event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_session_connections_active
  ON agent_session_connections(project, principal_id, session_instance_id, lease_expires_at_ms)
  WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_dispatch_attempts_delivery
  ON agent_dispatch_attempts(delivery_id, attempt_number);

-- Proof that a capture hook actually RAN. Nothing else in this schema can
-- give it: every other signal is "a row was written", and "the hook ran and
-- found nothing worth saving" is the healthy case that produces no row at
-- all. So a quiet day and a dead capture loop were byte-identical in the
-- database, and the one doctor message that had to cover both cried wolf on
-- the first and stayed silent on the second.
--
-- Written by the three hooks that hold a read-write handle (Stop, PreCompact,
-- PostToolUse), each calling recordHookRun() at its own SUCCESSFUL exit —
-- after capture, not at open. Stamping at open certified the wrong thing: a
-- hook that opened the database and then died mid-capture looked alive for a
-- day. "Successful" is precise: a completed capture, or a well-formed
-- payload the hook correctly decided not to capture (dedup, low-signal
-- session). A malformed payload (schema-flip shapes) and a write that did
-- not land both leave no stamp — either would make the heartbeat mask the
-- exact dropout it exists to expose. The recall-side hooks open read-only
-- and deliberately do not appear here: their liveness answers a different
-- question, and giving them a write handle would put a lock acquisition on
-- the SessionStart hot path.
--
-- One row per hook, upserted. It does not grow.
CREATE TABLE IF NOT EXISTS hook_runs (
  hook        TEXT PRIMARY KEY,
  last_run_at TIMESTAMP NOT NULL,
  run_count   INTEGER NOT NULL DEFAULT 0
);

-- The 'hook_runs_since' metadata key (when this database first became able
-- to record hook runs) is stamped by ensureHookRunsSince() AFTER this exec,
-- NOT here. It used to be an INSERT OR IGNORE in this string, and that made
-- every open — including opens that only ever read — start a write
-- transaction: an INSERT statement takes the WAL writer lock even when
-- OR IGNORE ends up changing nothing. Two states regressed from "reads work"
-- to "open throws": a peer holding the writer lock past busy_timeout, and a
-- read-only database FILE (measured: "attempt to write a readonly database"
-- killed recall along with capture). The helper SELECTs first and writes
-- only when the key is genuinely absent — once per database lifetime.
`;

// FTS5 virtual table — separate so opens that don't need it stay lean.
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, observations, content='',
  tokenize='unicode61 remove_diacritics 1'
);

-- Term -> document-count view over the index above. Stores nothing of its own;
-- it exists so search() can drop query terms that appear in most of the corpus,
-- which are the ones BM25 already scores near zero. See dropUbiquitousTerms().
CREATE VIRTUAL TABLE IF NOT EXISTS fts_vocab USING fts5vocab(entities_fts, 'row');
`;

/**
 * Run an ALTER TABLE that tolerates exactly one race. Conditional ALTER
 * blocks ARE idempotent within a single process, but two processes (e.g.
 * CLI + HTTP server starting back-to-back, or a hook running concurrently
 * with `memesh recall`) can race: each reads its own PRAGMA snapshot, both
 * see "column missing", both run ALTER, the second one throws SQLITE_ERROR:
 * duplicate column name. That one error is the expected no-op outcome (a
 * peer beat us to it); any other error rethrows so real bugs are not
 * papered over.
 */
export function safeAlter(db: MemeshDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}

/**
 * The entities-table migration chain — every conditional ALTER this schema
 * has ever shipped, applied idempotently from one PRAGMA snapshot. Called by
 * BOTH schema owners (core's migrateToCurrentSchema, the hooks'
 * migrateHookDbToCurrent), which used to each carry their own copy of this
 * list with "keep in lockstep" comments.
 */
export function migrateEntitiesSchema(db: MemeshDatabase): void {
  const entityColumns = new Set(
    (db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>).map((c) => c.name),
  );

  // Each column answers for itself.
  //
  // These used to be grouped: five ALTERs behind `if (!has('access_count'))`,
  // two behind `if (!has('recall_hits'))`. A group is only idempotent if it
  // is also ATOMIC, and it is not — each ALTER commits on its own. So a
  // failure on the second statement (a `SQLITE_BUSY` from any of the seven
  // hooks, a full disk) left `access_count` added and the other four
  // missing, and every run after that read `has('access_count')` as true and
  // skipped the block. The database was then permanently half-migrated, and
  // `getEntity` — whose SELECT names `last_accessed_at`, `confidence`,
  // `recall_hits` — failed forever with no way to heal.
  //
  // Per-column guards make each ALTER independently resumable: the next open
  // adds exactly what is still missing. `safeAlter` swallowing "duplicate
  // column name" is the belt; this is the braces, and it is the half that
  // was load-bearing.
  const addColumn = (column: string, sql: string): void => {
    if (entityColumns.has(column)) return;
    safeAlter(db, sql);
    entityColumns.add(column);
  };

  // v2.11 -> v2.12: status
  addColumn('status', "ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");

  // v2.14 -> v2.15: scoring + temporal-validity columns
  addColumn('access_count', "ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0");
  addColumn('last_accessed_at', "ALTER TABLE entities ADD COLUMN last_accessed_at TIMESTAMP");
  addColumn('confidence', "ALTER TABLE entities ADD COLUMN confidence REAL DEFAULT 1.0");
  addColumn('valid_from', "ALTER TABLE entities ADD COLUMN valid_from TIMESTAMP");
  addColumn('valid_until', "ALTER TABLE entities ADD COLUMN valid_until TIMESTAMP");

  // v3.0.0-rc -> v3.0.0: namespace
  addColumn('namespace', "ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'personal'");

  // v4.0.0: recall effectiveness counters
  addColumn('recall_hits', "ALTER TABLE entities ADD COLUMN recall_hits INTEGER DEFAULT 0");
  addColumn('recall_misses', "ALTER TABLE entities ADD COLUMN recall_misses INTEGER DEFAULT 0");

  // Human-readable titles: nullable, additive only — `name` keeps its
  // machine-key identity semantics (dedup/append), `title` is the display
  // string a human or agent reads first.
  addColumn('title', "ALTER TABLE entities ADD COLUMN title TEXT");

  // Unconditional, because `IF NOT EXISTS` already makes them idempotent and
  // they were the other half of the group problem: an index created inside a
  // conditional that a partial failure skipped never got a second chance.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);
     CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace);`,
  );

  // Host-native push adds target_kind to a table that already shipped as the
  // durable pull inbox. This shared migration helper is also intentionally
  // callable against an entities-only legacy fixture, so do not assume the
  // messaging tables exist. Production opens create them through SCHEMA_SQL
  // before reaching this point; hook and migration tests may not.
  const deliveryTableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_message_deliveries'")
    .get();
  if (!deliveryTableExists) return;

  const deliveryColumns = new Set(
    (db.prepare("PRAGMA table_info(agent_message_deliveries)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!deliveryColumns.has('target_kind')) {
    safeAlter(
      db,
      "ALTER TABLE agent_message_deliveries ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'principal' " +
        "CHECK (target_kind IN ('principal', 'session'))",
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_target
       ON agent_message_deliveries(project, target_kind, recipient, message_id);`,
  );
}

/**
 * One-time tags dedup + unique-index creation, guarded so it never writes
 * once the index exists.
 *
 * The DELETE used to live inside SCHEMA_SQL, which made every open start a
 * write transaction even when it deleted nothing — the index's existence is
 * the proof that duplicates are impossible, so it doubles as the guard.
 * captureEntity's INSERT OR IGNORE tag dedup depends on this index, so this
 * must run before any write path uses the handle.
 */
export function ensureTagsUniqueIndex(db: MemeshDatabase): void {
  try {
    const present = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_tags_entity_tag_unique'")
      .get();
    if (present) return;
    // One IMMEDIATE transaction, not two autocommit statements: exec runs
    // each statement in its own transaction, so a crash or a busy peer
    // between them could commit the DELETE with the index never created —
    // and a concurrent pre-index writer could re-insert a duplicate pair in
    // that window, failing the CREATE with a constraint error. BEGIN
    // IMMEDIATE holds the write lock across both, so the dedup and the
    // index land together or not at all (CREATE INDEX is transactional in
    // SQLite).
    db.exec(
      'BEGIN IMMEDIATE; ' +
        'DELETE FROM tags WHERE id NOT IN (SELECT MIN(id) FROM tags GROUP BY entity_id, tag); ' +
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_entity_tag_unique ON tags(entity_id, tag); ' +
        'COMMIT;',
    );
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction open */ }
    try {
      process.stderr.write(
        `MeMesh: could not create the tags unique index (${err instanceof Error ? err.message : String(err)}). ` +
          `Reads are unaffected; the next open retries the dedup and index together.\n`,
      );
    } catch { /* stderr gone; nothing left to say */ }
  }
}

/**
 * Stamp 'hook_runs_since' once per database lifetime — read-first, so an
 * open that only ever reads stays a reader.
 *
 * This write lived inside SCHEMA_SQL, and that made EVERY open take the WAL
 * writer lock (an INSERT acquires it even when OR IGNORE changes nothing).
 * A read-only database file — the exact botched-sudo state the session-start
 * probe warns about — went from "recall still works" to "every open throws
 * 'attempt to write a readonly database'". The SELECT costs one index probe;
 * the INSERT runs once ever; and a failed INSERT degrades to a stderr trace
 * instead of taking the open down, because a database you can read is
 * strictly better than no database at all.
 */
export function ensureHookRunsSince(db: MemeshDatabase): void {
  try {
    const row = db
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'")
      .get() as { value: string } | undefined;
    if (row) {
      // A marker that exists but cannot be read as a past UTC timestamp
      // (corrupt text, a rolled-over pseudo-date, a wrong clock stamping the
      // future) would grant doctor's "tracking just started" grace FOREVER —
      // a fail-open. Heal it HERE, because this is a write path that runs on
      // every real open; doctor is a reader (reachable via GET /v1/doctor)
      // and must not repair the database it inspects. Same parse as doctor's
      // hoursSince — literally: parseSqliteUtcMs is the single owner of the
      // anchored/UTC/round-tripped rules.
      const then = parseSqliteUtcMs(row.value ?? '');
      if (then !== null && then <= Date.now() + 5 * 60 * 1000) return;
      db
        .prepare("UPDATE memesh_metadata SET value = datetime('now') WHERE key = 'hook_runs_since'")
        .run();
      return;
    }
    db
      .prepare("INSERT OR IGNORE INTO memesh_metadata (key, value) VALUES ('hook_runs_since', datetime('now'))")
      .run();
  } catch (err) {
    try {
      process.stderr.write(
        `MeMesh: could not stamp hook_runs_since (${err instanceof Error ? err.message : String(err)}). ` +
          `Reads are unaffected; doctor's hook-activity tracking starts once the database is writable.\n`,
      );
    } catch { /* stderr gone; nothing left to say */ }
  }
}

/**
 * Is this a "someone else is using the database right now" error?
 *
 * These resolve on their own; treating them as permanent would park a
 * migration for 24h over a moment of contention.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  const msg = (err as { message?: string })?.message ?? '';
  return (
    /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL/.test(code) ||
    /database is locked|database table is locked|locking protocol/i.test(msg)
  );
}

/** How long a failed migration waits before trying again. */
export const MIGRATION_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Run a versioned migration at most once, atomically, with a retry backoff.
 *
 * Three properties, each of which was missing and each of which cost
 * something:
 *
 * **The version check happens inside the write transaction.** The FTS rebuild
 * used to read its source rows before `db.transaction()` opened, and
 * the default transaction is BEGIN DEFERRED, so no write lock
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
 *
 * **A failure is never fatal.** The database still opens. Entities and
 * observations are the source of truth and are untouched by an index rebuild,
 * so a failed migration degrades retrieval rather than losing anything.
 *
 * @returns true if the migration ran and committed
 */
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

/**
 * The segmentation version this build knows how to produce.
 *
 * v3: code-point-aware bigrams over ALL unspaced scripts (see
 * UNSPACED_SCRIPT_RANGES in fts-index.ts) — v2 covered only CJK/kana/hangul,
 * leaving Thai, Lao, half-width katakana and Extension B unfindable by any
 * fragment of themselves, and building bigrams over UTF-16 code units would
 * have indexed half-surrogates.
 */
export const FTS_SEGMENTATION_VERSION = 3;

/** Rows re-indexed per page during a full FTS rebuild. */
export const FTS_REBUILD_PAGE_SIZE = 500;

/**
 * Delete and re-derive every active row in `entities_fts` from its source.
 * Runs unconditionally when called — version gating is the caller's job
 * (ensureFtsSegmentation / reindexFts).
 *
 * Rows are read a page at a time rather than all at once. A `.all()` here
 * built the entire corpus — every name plus all of its concatenated
 * observations — as a JS array before writing anything, roughly 80 MB of
 * Node heap at 100k entities, inside processes as short-lived as a hook
 * invocation. Paging rather than `.iterate()`: writing while an iterator is
 * open on the same connection is not something to rely on. Keyset pagination
 * on `e.id` keeps memory bounded to one page.
 *
 * Archived entities are deliberately not reindexed: `archiveEntity()`
 * removes them from FTS5 by design, and `search()` reaches them through a
 * separate LIKE scan.
 *
 * MUST be called inside a write transaction — `delete-all` empties the
 * index, so an interrupted rebuild that is not rolled back leaves search
 * blank.
 */
export function rebuildFtsIndex(db: MemeshDatabase): void {
  // This ALWAYS rebuilds. There used to be a skip here, and removing it is a
  // bug fix, not a performance regression accepted for simplicity.
  //
  // The skip read `if (fromVersion === 1 && !hasDecomposedText(db)) return;`,
  // justified by "v2 differs from v1 ONLY by NFC-normalising before
  // segmenting". That was true when the target was 2. Version 3 also WIDENS
  // `UNSPACED_SCRIPT_RANGES` (Thai, Lao, Khmer, half-width katakana, CJK Ext
  // B), and none of those scripts has a canonical decomposition — so
  // `hasDecomposedText` was false for exactly the corpora the widening exists
  // to fix. Measured: a v1 database holding Thai and half-width katakana came
  // out of the upgrade with its marker stamped 3, its index still holding v1
  // whole-run tokens, and every fragment query returning nothing. The marker
  // only moves forward, so it never self-heals.
  //
  // A version-keyed skip is only sound while the sole delta is normalisation,
  // and nothing forces the next author to re-derive that. The hook-side twin
  // never had the skip, so the two also disagreed: the same database ended up
  // in one of two index states depending on which process opened it first.
  // Rebuilding unconditionally — from ONE shared implementation — is what
  // makes every opener agree. Cost: 140ms against 13ms on a 20k-entity
  // database, once per database per version bump.
  db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");

  // ORDER BY o.id inside the aggregate: the text inserted here must be
  // byte-identical to what indexedObservationText (fts-index.ts, ORDER BY
  // id) will later compose for the contentless delete. An order-unspecified
  // group_concat left that agreement to SQLite's scan order. (ORDER BY in
  // aggregates: SQLite >= 3.44; Node 22's bundled SQLite is well past that.)
  const page = db.prepare(
    `SELECT e.id, e.name, e.title, COALESCE(group_concat(o.content, ' ' ORDER BY o.id), '') AS obs
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
      title: string | null;
      obs: string;
    }>;
    if (rows.length === 0) break;

    for (const row of rows) insertFtsRow(db, row.id, row.name, row.obs, row.title);
    afterId = rows[rows.length - 1].id;

    if (rows.length < FTS_REBUILD_PAGE_SIZE) break;
  }
}

/**
 * Rebuild `entities_fts` when the segmentation rules have changed.
 *
 * A marker in `memesh_metadata`, compared on open, migrating in place. This
 * one can always finish its work — the source text lives in `entities` +
 * `observations`, so nothing is lost. Measured at 19ms for 5,000 entities,
 * so it runs inline rather than being deferred.
 *
 * Archived entities are deliberately not reindexed: `archiveEntity()` removes
 * them from FTS5 by design, and `search()` reaches them through a separate
 * LIKE scan.
 *
 * Both sides of the F5 boundary run THIS function (the hook side used to
 * carry its own near-twin, which was already missing the ORDER BY fix), so
 * the shared `fts_segmentation_version` marker always means the same bytes.
 */
export function ensureFtsSegmentation(db: MemeshDatabase): void {
  runOnceMigration(db, {
    key: 'fts_segmentation_version',
    version: FTS_SEGMENTATION_VERSION,
    describe: 'search index rebuild',
    migrate: rebuildFtsIndex,
  });
}
