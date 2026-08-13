import { MemeshDatabase } from './storage/sqlite.js';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { resolveEmbeddingDimension } from './core/config.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { getDbPath } from './core/paths.js';
import { insertFtsRow } from './storage/fts-index.js';
let db = null;
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
-- day. The recall-side hooks open read-only and deliberately do not appear
-- here: their liveness answers a different question, and giving them a write
-- handle would put a lock acquisition on the SessionStart hot path.
--
-- One row per hook, upserted. It does not grow.
CREATE TABLE IF NOT EXISTS hook_runs (
  hook        TEXT PRIMARY KEY,
  last_run_at TIMESTAMP NOT NULL,
  run_count   INTEGER NOT NULL DEFAULT 0
);

-- When this database first became able to record hook runs. Without it, an
-- empty \`hook_runs\` is ambiguous on exactly the day it matters: every
-- existing database has one the moment this ships, and reporting that as
-- "hooks are dead" would recreate the crying-wolf problem in a louder voice.
-- INSERT OR IGNORE runs on every open from both src and hooks, and stamps
-- once.
INSERT OR IGNORE INTO memesh_metadata (key, value)
VALUES ('hook_runs_since', datetime('now'));
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
export function openDatabase(dbPath) {
    if (db)
        return db;
    const resolvedPath = dbPath ?? getDbPath();
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.chmodSync(dir, 0o700);
    }
    catch { }
    const opening = new MemeshDatabase(resolvedPath, { allowExtension: true });
    try {
        initialiseDatabase(opening, resolvedPath);
    }
    catch (err) {
        try {
            opening.close();
        }
        catch { }
        throw err;
    }
    db = opening;
    return db;
}
function initialiseDatabase(db, resolvedPath) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    db.exec(FTS_SQL);
    try {
        process.umask(0o077);
    }
    catch { }
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            fs.chmodSync(`${resolvedPath}${suffix}`, 0o600);
        }
        catch { }
    }
    const safeAlter = (sql) => {
        try {
            db.exec(sql);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/duplicate column name/i.test(msg))
                throw e;
        }
    };
    const columns = db.prepare("PRAGMA table_info(entities)").all();
    if (!columns.some((c) => c.name === 'status')) {
        safeAlter("ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
        db.exec("CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)");
    }
    const scoringCols = db.prepare("PRAGMA table_info(entities)").all();
    if (!scoringCols.some((c) => c.name === 'access_count')) {
        safeAlter("ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0");
        safeAlter("ALTER TABLE entities ADD COLUMN last_accessed_at TIMESTAMP");
        safeAlter("ALTER TABLE entities ADD COLUMN confidence REAL DEFAULT 1.0");
        safeAlter("ALTER TABLE entities ADD COLUMN valid_from TIMESTAMP");
        safeAlter("ALTER TABLE entities ADD COLUMN valid_until TIMESTAMP");
    }
    if (!scoringCols.some((c) => c.name === 'namespace')) {
        safeAlter("ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'personal'");
        db.exec("CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace)");
    }
    const recallCols = db.prepare("PRAGMA table_info(entities)").all();
    if (!recallCols.some((c) => c.name === 'recall_hits')) {
        safeAlter("ALTER TABLE entities ADD COLUMN recall_hits INTEGER DEFAULT 0");
        safeAlter("ALTER TABLE entities ADD COLUMN recall_misses INTEGER DEFAULT 0");
    }
    runAutoDecay(db);
    backfillSignalScores(db);
    ensureDreamProposalsTable(db);
    ensureLlmTelemetryTable(db);
    runAutoTelemetryPrune(db);
    ensureFtsSegmentation(db);
    let vectorIndexAvailable = true;
    db.enableLoadExtension(true);
    try {
        sqliteVec.load(db);
    }
    catch (err) {
        vectorIndexAvailable = false;
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`MeMesh: sqlite-vec could not be loaded (${detail}).\n` +
            'MeMesh: recall will use FTS5 keyword search only. `memesh doctor` explains this row.\n');
    }
    finally {
        db.enableLoadExtension(false);
    }
    if (vectorIndexAvailable) {
        const { dimension: targetDim, confident: dimensionKnown } = resolveEmbeddingDimension();
        ensureVecTable(db, resolvedPath, targetDim, dimensionKnown);
    }
    return db;
}
export const FTS_SEGMENTATION_VERSION = 3;
const MIGRATION_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;
function isTransientDbError(err) {
    const code = err?.code ?? '';
    const msg = err?.message ?? '';
    return (/SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL/.test(code) ||
        /database is locked|database table is locked|locking protocol/i.test(msg));
}
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
function ensureFtsSegmentation(db) {
    runOnceMigration(db, {
        key: 'fts_segmentation_version',
        version: FTS_SEGMENTATION_VERSION,
        describe: 'search index rebuild',
        migrate: rebuildFtsIndex,
    });
}
const FTS_REBUILD_PAGE_SIZE = 500;
function rebuildFtsIndex(db) {
    db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    const page = db.prepare(`SELECT e.id, e.name, COALESCE(group_concat(o.content, ' '), '') AS obs
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
            insertFtsRow(db, row.id, row.name, row.obs);
        afterId = rows[rows.length - 1].id;
        if (rows.length < FTS_REBUILD_PAGE_SIZE)
            break;
    }
}
export function reindexFts() {
    const database = getDatabase();
    database.transaction(() => {
        rebuildFtsIndex(database);
        database
            .prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
            .run('fts_segmentation_version', String(FTS_SEGMENTATION_VERSION));
        database.prepare('DELETE FROM memesh_metadata WHERE key = ?').run('fts_segmentation_version_last_attempt');
    }).immediate();
    const { c } = database
        .prepare("SELECT count(*) AS c FROM entities WHERE status = 'active'")
        .get();
    return { entities: c };
}
let vectorRebuildConsentFor = null;
export async function allowVectorIndexRebuild(dbPath, canRefill) {
    if (!(await canRefill()))
        return false;
    vectorRebuildConsentFor = path.resolve(dbPath);
    return true;
}
function consumeVectorRebuildConsent(resolvedPath) {
    const granted = vectorRebuildConsentFor;
    vectorRebuildConsentFor = null;
    return granted !== null && granted === path.resolve(resolvedPath);
}
function ensureVecTable(db, resolvedPath, targetDim, dimensionKnown = true) {
    const rebuildConsented = consumeVectorRebuildConsent(resolvedPath);
    const storedDim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
    const currentDim = storedDim ? parseInt(storedDim.value, 10) : 0;
    const vecExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'").get();
    if (vecExists && currentDim === targetDim) {
        return;
    }
    if (vecExists && !dimensionKnown) {
        process.stderr.write(`MeMesh: embedding dimension could not be determined (config unreadable), so the ` +
            `existing ${currentDim}-dim vector index was left untouched rather than rebuilt. ` +
            `Fix ~/.memesh/config.json to change embedders.\n`);
        return;
    }
    if (vecExists &&
        currentDim !== 0 &&
        currentDim !== targetDim &&
        !rebuildConsented) {
        process.stderr.write(`MeMesh: this database records ${currentDim}-dim embeddings but the current ` +
            `configuration asks for ${targetDim}. Keeping the existing vector index rather ` +
            `than rebuilding it, because rebuilding deletes every stored vector. ` +
            `If the configuration is wrong, fix it. If you meant to switch embedders, run ` +
            `'memesh reindex --vectors' to rebuild the index at ${targetDim} and regenerate.\n`);
        return;
    }
    db.transaction(() => {
        if (vecExists) {
            process.stderr.write(`MeMesh: Embedding dimension changed (${currentDim} → ${targetDim}). Rebuilding vector index.\n` +
                `MeMesh: Old embeddings deleted. Run 'memesh reindex' to regenerate vectors for all entities.\n` +
                `MeMesh: Without reindex, only newly accessed entities will be embedded.\n`);
            db.exec('DROP TABLE entities_vec');
            db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('pending_reindex', ?)").run(JSON.stringify({ from: currentDim, to: targetDim, droppedAt: new Date().toISOString() }));
        }
        db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(
        embedding float[${targetDim}]
      );
    `);
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('embedding_dimension', ?)").run(String(targetDim));
    }).immediate();
}
export function getPendingReindexInfo() {
    if (!db)
        return null;
    try {
        const row = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get();
        return row ? JSON.parse(row.value) : null;
    }
    catch {
        return null;
    }
}
export function clearPendingReindexFlag() {
    if (!db)
        return;
    db.prepare("DELETE FROM memesh_metadata WHERE key = 'pending_reindex'").run();
}
function ensureDreamProposalsTable(db) {
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
    const dpCols = db.prepare("PRAGMA table_info(dream_proposals)").all();
    if (!dpCols.some((c) => c.name === 'source_kind')) {
        try {
            db.exec("ALTER TABLE dream_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'entities'");
        }
        catch (err) {
            if (!String(err.message).includes('duplicate column name'))
                throw err;
        }
    }
}
function ensureLlmTelemetryTable(db) {
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
const TELEMETRY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_PRUNE_DEFAULT_DAYS = 180;
const TELEMETRY_PRUNE_MARKER = 'last_telemetry_prune_at';
function runAutoTelemetryPrune(db) {
    const last = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(TELEMETRY_PRUNE_MARKER);
    if (last) {
        const elapsed = Date.now() - new Date(last.value).getTime();
        if (elapsed < TELEMETRY_PRUNE_INTERVAL_MS)
            return;
    }
    const cutoffIso = new Date(Date.now() - TELEMETRY_PRUNE_DEFAULT_DAYS * 86400000).toISOString();
    try {
        db.prepare('DELETE FROM llm_telemetry WHERE ts < ?').run(cutoffIso);
    }
    catch {
        return;
    }
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(TELEMETRY_PRUNE_MARKER, new Date().toISOString());
}
function backfillSignalScores(db) {
    const MARKER = 'signal_score_backfill_v2';
    const done = db.prepare("SELECT value FROM memesh_metadata WHERE key = ?").get(MARKER);
    if (done)
        return;
    const rows = db.prepare('SELECT id, name, type, metadata FROM entities').all();
    if (rows.length === 0) {
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)").run(MARKER, new Date().toISOString());
        return;
    }
    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
    const tagStmt = db.prepare('SELECT tag FROM tags WHERE entity_id = ?');
    const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    const tx = db.transaction(() => {
        let scored = 0;
        let skipped = 0;
        for (const row of rows) {
            let metadata;
            if (row.metadata) {
                try {
                    metadata = JSON.parse(row.metadata);
                }
                catch {
                    skipped++;
                    continue;
                }
                if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
                    skipped++;
                    continue;
                }
            }
            else {
                metadata = {};
            }
            if (typeof metadata.signal_score === 'number') {
                skipped++;
                continue;
            }
            const observations = obsStmt.all(row.id).map(o => o.content);
            const tags = tagStmt.all(row.id).map(t => t.tag);
            metadata.signal_score = computeSignalScore({
                type: row.type,
                name: row.name,
                observations,
                tags,
            });
            updateStmt.run(JSON.stringify(metadata), row.id);
            scored++;
        }
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)").run(MARKER, JSON.stringify({ at: new Date().toISOString(), scored, skipped }));
    });
    tx();
}
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}
export function getDatabase() {
    if (!db)
        throw new Error('Database not opened');
    return db;
}
export function isDatabaseOpen() {
    return db !== null;
}
//# sourceMappingURL=db.js.map