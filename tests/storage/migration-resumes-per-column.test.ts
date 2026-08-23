/**
 * A grouped migration guard is only idempotent if the group is also atomic,
 * and these were not.
 *
 * `migrateEntitiesSchema` had five `ALTER TABLE` statements behind
 * `if (!entityColumns.has('access_count'))` and two behind
 * `if (!entityColumns.has('recall_hits'))`. Each ALTER commits on its own, so
 * a failure on the SECOND statement — a `SQLITE_BUSY` from any of the seven
 * hooks, a full disk, a lock held by the HTTP server — left `access_count`
 * added and `last_accessed_at`, `confidence`, `valid_from`, `valid_until`
 * missing.
 *
 * And then it never recovered: every subsequent open read
 * `has('access_count')` as true and skipped the whole block. The database was
 * permanently half-migrated, and `getEntity` — whose SELECT names
 * `last_accessed_at`, `confidence`, `recall_hits` — failed forever with no way
 * to heal short of deleting the file.
 *
 * Each column answers for itself now, so the next open adds exactly what is
 * still missing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { migrateEntitiesSchema } from '../../src/storage/schema.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-migresume-'));
  dbPath = path.join(dir, 'kg.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The `entities` table as it stood before any of these ALTERs shipped. */
function openAncientDatabase(): InstanceType<typeof Database> {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    );
  `);
  return db;
}

function columnsOf(db: InstanceType<typeof Database>): Set<string> {
  return new Set(
    (db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>).map((c) => c.name),
  );
}

const EXPECTED = [
  'status', 'access_count', 'last_accessed_at', 'confidence',
  'valid_from', 'valid_until', 'namespace', 'recall_hits', 'recall_misses', 'title',
];

describe('the entities migration resumes from a partial application', () => {
  it('adds every column on a clean run — the anti-vacuity half', () => {
    // First, because every assertion below is about recovery and this is the
    // one that says the migration does anything at all.
    const db = openAncientDatabase();
    try {
      migrateEntitiesSchema(db);
      const columns = columnsOf(db);
      const missing = EXPECTED.filter((c) => !columns.has(c));
      expect(missing, 'the migration did not complete on a clean database').toEqual([]);
    } finally {
      db.close();
    }
  });

  it('completes a database left with only the FIRST column of a group', () => {
    // The exact wreckage a mid-group failure leaves: `access_count` present,
    // its four siblings absent. Under the old grouped guard this state was
    // terminal.
    const db = openAncientDatabase();
    try {
      db.exec('ALTER TABLE entities ADD COLUMN access_count INTEGER DEFAULT 0');
      const before = columnsOf(db);
      expect(before.has('access_count'), 'fixture: the half-migrated state was not created').toBe(true);
      expect(before.has('last_accessed_at'), 'fixture: the state is not actually partial').toBe(false);

      migrateEntitiesSchema(db);

      const columns = columnsOf(db);
      const missing = EXPECTED.filter((c) => !columns.has(c));
      expect(missing, 'the migration skipped the group its first column belongs to').toEqual([]);
    } finally {
      db.close();
    }
  });

  it('completes a database left mid-way through the second group too', () => {
    const db = openAncientDatabase();
    try {
      db.exec('ALTER TABLE entities ADD COLUMN recall_hits INTEGER DEFAULT 0');

      migrateEntitiesSchema(db);

      expect(columnsOf(db).has('recall_misses'), 'recall_misses was skipped').toBe(true);
    } finally {
      db.close();
    }
  });

  it('is safe to run twice', () => {
    // `safeAlter` swallows "duplicate column name", but a second full run
    // must also not throw on the index creations that moved out of the
    // conditionals.
    const db = openAncientDatabase();
    try {
      migrateEntitiesSchema(db);
      expect(() => migrateEntitiesSchema(db), 'a second migration threw').not.toThrow();
      expect(columnsOf(db).size).toBeGreaterThan(EXPECTED.length);
    } finally {
      db.close();
    }
  });

  it('creates the indexes even when the columns already exist', () => {
    // The other half of the group problem: `CREATE INDEX` sat INSIDE the
    // conditional, so a database that gained the column and lost the index
    // never got a second chance at it.
    const db = openAncientDatabase();
    try {
      db.exec("ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      db.exec("ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'personal'");

      migrateEntitiesSchema(db);

      const indexes = (db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities'")
        .all() as Array<{ name: string }>).map((r) => r.name);
      expect(indexes, 'the status index was never created').toContain('idx_entities_status');
      expect(indexes, 'the namespace index was never created').toContain('idx_entities_namespace');
    } finally {
      db.close();
    }
  });
});
