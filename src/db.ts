import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { getEmbeddingDimension } from './core/config.js';
import { computeSignalScore } from './core/signal-scorer.js';
import type { PragmaColumnRow } from './core/types.js';

let db: Database.Database | null = null;

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
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, observations, content='',
  tokenize='unicode61 remove_diacritics 1'
);
`;

export function openDatabase(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath
    ?? process.env.MEMESH_DB_PATH
    ?? path.join(os.homedir(), '.memesh', 'knowledge-graph.db');

  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }

  db = new Database(resolvedPath);
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
  //      better-sqlite3 already created them.
  try { process.umask(0o077); } catch { /* non-POSIX */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(`${resolvedPath}${suffix}`, 0o600); }
    catch { /* sidecar may not exist yet, or non-POSIX */ }
  }

  // Migrate: add status column if missing (v2.11 -> v2.12)
  const columns = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
  if (!columns.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status)");
  }

  // Migrate: add scoring columns if missing (v2.14 -> v2.15)
  const scoringCols = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
  if (!scoringCols.some((c) => c.name === 'access_count')) {
    db.exec("ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0");
    db.exec("ALTER TABLE entities ADD COLUMN last_accessed_at TIMESTAMP");
    db.exec("ALTER TABLE entities ADD COLUMN confidence REAL DEFAULT 1.0");
    db.exec("ALTER TABLE entities ADD COLUMN valid_from TIMESTAMP");
    db.exec("ALTER TABLE entities ADD COLUMN valid_until TIMESTAMP");
  }

  // Migrate: add namespace column if missing (v3.0.0-rc -> v3.0.0)
  if (!scoringCols.some((c) => c.name === 'namespace')) {
    db.exec("ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'personal'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace)");
  }

  // Migrate: add recall effectiveness columns if missing (v4.0.0)
  const recallCols = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
  if (!recallCols.some((c) => c.name === 'recall_hits')) {
    db.exec("ALTER TABLE entities ADD COLUMN recall_hits INTEGER DEFAULT 0");
    db.exec("ALTER TABLE entities ADD COLUMN recall_misses INTEGER DEFAULT 0");
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

  // Load sqlite-vec extension for vector similarity search
  sqliteVec.load(db);

  // Create/migrate vector table for entity embeddings
  // Dimension depends on embedding provider (384=ONNX, 1536=OpenAI, 768=Ollama)
  const targetDim = getEmbeddingDimension();
  ensureVecTable(db, targetDim);

  return db;
}

/**
 * Ensure entities_vec table exists with the correct dimension.
 * If dimension changed (provider switch), drops and recreates the table.
 * Old embeddings are lost — new ones regenerated as entities are accessed.
 */
function ensureVecTable(db: Database.Database, targetDim: number): void {
  // Ensure metadata table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const storedDim = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'"
  ).get() as { value: string } | undefined;

  const currentDim = storedDim ? parseInt(storedDim.value, 10) : 0;

  // Check if vec table exists
  const vecExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'"
  ).get();

  if (vecExists && currentDim === targetDim) {
    return; // table exists with correct dimension
  }

  // Drop old table if dimension changed — embeddings will be regenerated
  if (vecExists && currentDim !== targetDim) {
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

  // Create with target dimension
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(
      embedding float[${targetDim}]
    );
  `);

  // Store current dimension
  db.prepare(
    "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('embedding_dimension', ?)"
  ).run(String(targetDim));
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
function ensureDreamProposalsTable(db: Database.Database): void {
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
function backfillSignalScores(db: Database.Database): void {
  // Ensure memesh_metadata exists — same migration the vec table
  // does, hoisted up so this runs even before ensureVecTable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

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
      let metadata: Record<string, unknown> = {};
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

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not opened');
  return db;
}
