import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { getEmbeddingDimension } from './core/config.js';
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

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);

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
