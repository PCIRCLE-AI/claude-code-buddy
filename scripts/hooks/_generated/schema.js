// ============================================================================
// AUTO-GENERATED from src/storage/schema.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { insertFtsRow } from './fts-index.js';
import { parseSqliteUtcMs } from './time-utils.js';
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

CREATE INDEX IF NOT EXISTS idx_agent_message_events_recipient_sequence
  ON agent_message_events(project, recipient, event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_scope
  ON agent_message_deliveries(project, recipient, message_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_receipts_scope
  ON agent_message_receipts(project, recipient, message_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_cursors_unique_scope_sequence
  ON agent_message_cursors(project, recipient, event_sequence);

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
export function safeAlter(db, sql) {
    try {
        db.exec(sql);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/duplicate column name/i.test(msg))
            throw e;
    }
}
export function migrateEntitiesSchema(db) {
    const entityColumns = new Set(db.prepare("PRAGMA table_info(entities)").all().map((c) => c.name));
    const addColumn = (column, sql) => {
        if (entityColumns.has(column))
            return;
        safeAlter(db, sql);
        entityColumns.add(column);
    };
    addColumn('status', "ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    addColumn('access_count', "ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0");
    addColumn('last_accessed_at', "ALTER TABLE entities ADD COLUMN last_accessed_at TIMESTAMP");
    addColumn('confidence', "ALTER TABLE entities ADD COLUMN confidence REAL DEFAULT 1.0");
    addColumn('valid_from', "ALTER TABLE entities ADD COLUMN valid_from TIMESTAMP");
    addColumn('valid_until', "ALTER TABLE entities ADD COLUMN valid_until TIMESTAMP");
    addColumn('namespace', "ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'personal'");
    addColumn('recall_hits', "ALTER TABLE entities ADD COLUMN recall_hits INTEGER DEFAULT 0");
    addColumn('recall_misses', "ALTER TABLE entities ADD COLUMN recall_misses INTEGER DEFAULT 0");
    addColumn('title', "ALTER TABLE entities ADD COLUMN title TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);
     CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace);`);
}
export function ensureTagsUniqueIndex(db) {
    try {
        const present = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_tags_entity_tag_unique'")
            .get();
        if (present)
            return;
        db.exec('BEGIN IMMEDIATE; ' +
            'DELETE FROM tags WHERE id NOT IN (SELECT MIN(id) FROM tags GROUP BY entity_id, tag); ' +
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_entity_tag_unique ON tags(entity_id, tag); ' +
            'COMMIT;');
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch { }
        try {
            process.stderr.write(`MeMesh: could not create the tags unique index (${err instanceof Error ? err.message : String(err)}). ` +
                `Reads are unaffected; the next open retries the dedup and index together.\n`);
        }
        catch { }
    }
}
export function ensureHookRunsSince(db) {
    try {
        const row = db
            .prepare("SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'")
            .get();
        if (row) {
            const then = parseSqliteUtcMs(row.value ?? '');
            if (then !== null && then <= Date.now() + 5 * 60 * 1000)
                return;
            db
                .prepare("UPDATE memesh_metadata SET value = datetime('now') WHERE key = 'hook_runs_since'")
                .run();
            return;
        }
        db
            .prepare("INSERT OR IGNORE INTO memesh_metadata (key, value) VALUES ('hook_runs_since', datetime('now'))")
            .run();
    }
    catch (err) {
        try {
            process.stderr.write(`MeMesh: could not stamp hook_runs_since (${err instanceof Error ? err.message : String(err)}). ` +
                `Reads are unaffected; doctor's hook-activity tracking starts once the database is writable.\n`);
        }
        catch { }
    }
}
export function isTransientDbError(err) {
    const code = err?.code ?? '';
    const msg = err?.message ?? '';
    return (/SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL/.test(code) ||
        /database is locked|database table is locked|locking protocol/i.test(msg));
}
export const MIGRATION_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;
export function runOnceMigration(db, opts) {
    const { key, version, describe, migrate } = opts;
    const attemptKey = `${key}_last_attempt`;
    const readMarker = (k) => db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(k)?.value;
    const stored = readMarker(key);
    if (stored && parseInt(stored, 10) >= version)
        return false;
    const lastAttempt = readMarker(attemptKey);
    if (lastAttempt && Date.now() - parseInt(lastAttempt, 10) < MIGRATION_RETRY_BACKOFF_MS) {
        return false;
    }
    try {
        db.transaction(() => {
            const current = readMarker(key);
            if (current && parseInt(current, 10) >= version)
                return;
            migrate(db, current ? parseInt(current, 10) : 0);
            db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(key, String(version));
            db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(attemptKey);
        }).immediate();
        return true;
    }
    catch (err) {
        if (isTransientDbError(err)) {
            process.stderr.write(`MeMesh: ${describe} deferred (${err instanceof Error ? err.message : String(err)}). ` +
                `Another process holds the database; it will run on the next start.\n`);
            return false;
        }
        try {
            db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(attemptKey, String(Date.now()));
        }
        catch { }
        process.stderr.write(`MeMesh: ${describe} failed (${err instanceof Error ? err.message : String(err)}). ` +
            `Your memories are unaffected — this rebuilds a derived index. ` +
            `It will retry in 24h, or run 'memesh reindex --fts' to retry now.\n`);
        return false;
    }
}
export const FTS_SEGMENTATION_VERSION = 3;
export const FTS_REBUILD_PAGE_SIZE = 500;
export function rebuildFtsIndex(db) {
    db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    const page = db.prepare(`SELECT e.id, e.name, e.title, COALESCE(group_concat(o.content, ' ' ORDER BY o.id), '') AS obs
       FROM entities e
       LEFT JOIN observations o ON o.entity_id = e.id
      WHERE e.status = 'active' AND e.id > ?
      GROUP BY e.id
      ORDER BY e.id
      LIMIT ?`);
    let afterId = 0;
    for (;;) {
        const rows = page.all(afterId, FTS_REBUILD_PAGE_SIZE);
        if (rows.length === 0)
            break;
        for (const row of rows)
            insertFtsRow(db, row.id, row.name, row.obs, row.title);
        afterId = rows[rows.length - 1].id;
        if (rows.length < FTS_REBUILD_PAGE_SIZE)
            break;
    }
}
export function ensureFtsSegmentation(db) {
    runOnceMigration(db, {
        key: 'fts_segmentation_version',
        version: FTS_SEGMENTATION_VERSION,
        describe: 'search index rebuild',
        migrate: rebuildFtsIndex,
    });
}
