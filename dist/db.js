import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { getEmbeddingDimension } from './core/config.js';
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
`;
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, observations, content='',
  tokenize='unicode61 remove_diacritics 1'
);
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
    db = new Database(resolvedPath);
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
    sqliteVec.load(db);
    const targetDim = getEmbeddingDimension();
    ensureVecTable(db, targetDim);
    return db;
}
const FTS_SEGMENTATION_VERSION = 1;
function ensureFtsSegmentation(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
    const stored = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version'").get();
    if (stored && parseInt(stored.value, 10) >= FTS_SEGMENTATION_VERSION)
        return;
    const rows = db.prepare(`SELECT e.id, e.name, COALESCE(group_concat(o.content, ' '), '') AS obs
       FROM entities e
       LEFT JOIN observations o ON o.entity_id = e.id
      WHERE e.status = 'active'
      GROUP BY e.id`).all();
    const rebuild = db.transaction(() => {
        db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
        for (const row of rows)
            insertFtsRow(db, row.id, row.name, row.obs);
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('fts_segmentation_version', ?)").run(String(FTS_SEGMENTATION_VERSION));
    });
    try {
        rebuild();
    }
    catch (err) {
        process.stderr.write(`MeMesh: search index rebuild failed (${err instanceof Error ? err.message : String(err)}). ` +
            `Non-Latin search may be incomplete until it succeeds; it will retry on next start.\n`);
    }
}
function ensureVecTable(db, targetDim) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
    const storedDim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
    const currentDim = storedDim ? parseInt(storedDim.value, 10) : 0;
    const vecExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'").get();
    if (vecExists && currentDim === targetDim) {
        return;
    }
    if (vecExists && currentDim !== targetDim) {
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
    db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
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
    db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
    const MARKER = 'signal_score_backfill_v1';
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
            try {
                metadata = row.metadata ? JSON.parse(row.metadata) : {};
            }
            catch {
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