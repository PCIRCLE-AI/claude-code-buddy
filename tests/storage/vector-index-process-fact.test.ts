/**
 * `hasVectorIndex` answers a question about THIS PROCESS, not about the file.
 *
 * The catalogue row for `entities_vec` persists in the database file. A graph
 * created on a machine where sqlite-vec loaded, then opened on one where the
 * platform binary is missing — musl/Alpine, an unusual arch, `npm ci
 * --omit=optional`, a container image — passed the old
 * `SELECT … FROM sqlite_master` check and then threw `no such module: vec0`
 * on first touch.
 *
 * `conflict-candidates.ts` documents that exact trap and catches it. It was
 * caught at one of six call sites. The two that were not are the two that
 * mutate user rows:
 *
 *   archiveEntity  removeFromFts committed → DELETE FROM entities_vec threw →
 *                  `UPDATE … SET status='archived'` never ran. The memory was
 *                  left ACTIVE and unindexed: keyword search could not find it
 *                  (gone from FTS), the archived-supplement branch could not
 *                  find it (status is not 'archived'), and `includeArchived`
 *                  returned nothing. Retrying threw again, forever.
 *   deleteEntity   identical shape, leaving a row nothing could reach.
 *
 * Two independent things are pinned here, because either alone would let the
 * defect back:
 *   1. the probe answers the process question (this file's first describe)
 *   2. the mutations are atomic, so a future throw between the FTS delete and
 *      the status update cannot leave the same wreckage (second describe)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { hasVectorIndex } from '../../src/storage/vector-index.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

const require = createRequire(import.meta.url);

let dir: string;
let dbPath: string;
let savedMemeshDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-vecprocess-'));
  dbPath = path.join(dir, 'kg.db');
  savedMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedMemeshDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Open with sqlite-vec loaded — the same two-gate dance `src/db.ts` does. */
function openWithVec(p: string): InstanceType<typeof Database> {
  const sqliteVec = require('sqlite-vec');
  const db = new Database(p, { allowExtension: true });
  db.enableLoadExtension(true);
  try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
  return db;
}

describe('the probe answers the PROCESS question, not the file question', () => {
  it('is false on a database whose entities_vec row exists but whose module is not loaded', () => {
    // The exact shape a user carries between machines.
    const withVec = openWithVec(dbPath);
    withVec.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[384])');
    withVec.close();

    // A plain handle: the extension is NOT loaded in this process.
    const plain = new Database(dbPath);
    const catalogueSaysPresent = (plain
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'entities_vec'")
      .get() as { c: number }).c;

    // Fixture assertion: the catalogue row really is still there, which is
    // what made the old check return true.
    expect(catalogueSaysPresent, 'fixture: the catalogue row is missing, so this proves nothing').toBe(1);

    expect(hasVectorIndex(plain), 'a file fact was used to answer a process question').toBe(false);
    plain.close();
  });

  it('is true when the module IS loaded and the table exists', () => {
    // The half that gives the false meaning: a probe hardwired to false
    // would pass the test above and silently disable vector search for
    // everyone.
    const withVec = openWithVec(dbPath);
    withVec.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[384])');
    expect(hasVectorIndex(withVec)).toBe(true);
    withVec.close();
  });

  it('is false when there is no table at all', () => {
    const plain = new Database(dbPath);
    plain.exec('CREATE TABLE IF NOT EXISTS unrelated (id INTEGER PRIMARY KEY)');
    expect(hasVectorIndex(plain)).toBe(false);
    plain.close();
  });

  it('does NOT swallow an unrelated failure as "no index"', () => {
    // Reporting a corrupt database as "no vector index" would downgrade
    // recall to keyword-only and look like a configuration choice. Only the
    // two absence errors are absence.
    const closed = new Database(dbPath);
    closed.close();
    expect(() => hasVectorIndex(closed), 'a real fault was reported as absence').toThrow();
  });
});

describe('archive and delete cannot leave a half-applied memory', () => {
  function seed(name: string): void {
    new KnowledgeGraph(getDatabase()).createEntity(name, 'note', {
      observations: ['a memory worth keeping'],
    });
  }

  function statusOf(name: string): string | undefined {
    return (getDatabase()
      .prepare('SELECT status FROM entities WHERE name = ?')
      .get(name) as { status?: string } | undefined)?.status;
  }

  function findableByKeyword(term: string): string[] {
    return (getDatabase()
      .prepare(`SELECT e.name FROM entities_fts f JOIN entities e ON e.id = f.rowid WHERE entities_fts MATCH ?`)
      .all(term) as Array<{ name: string }>).map((r) => r.name);
  }

  it('archives cleanly on a database where the vector module is unavailable', () => {
    // Before the fix this threw between the FTS delete and the status update,
    // stranding the row: active, and gone from the index.
    openDatabase(dbPath);
    seed('carried-between-machines');
    closeDatabase();

    // Give the file a vec0 catalogue row without the module being loadable
    // later — the machine-to-machine carry.
    const withVec = openWithVec(dbPath);
    withVec.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[384])');
    withVec.close();

    openDatabase(dbPath);
    const kg = new KnowledgeGraph(getDatabase());
    expect(() => kg.archiveEntity('carried-between-machines'), 'archive threw on a vec-less process').not.toThrow();

    // The two halves must agree. Stranded meant: status active AND absent
    // from the index.
    expect(statusOf('carried-between-machines'), 'status was not updated — the memory is stranded').toBe('archived');
    expect(findableByKeyword('keeping'), 'archived memory is still keyword-searchable').toEqual([]);
  });

  it('deletes cleanly on the same database', () => {
    openDatabase(dbPath);
    seed('to-be-deleted');
    closeDatabase();

    const withVec = openWithVec(dbPath);
    withVec.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[384])');
    withVec.close();

    openDatabase(dbPath);
    const kg = new KnowledgeGraph(getDatabase());
    expect(() => kg.deleteEntity('to-be-deleted')).not.toThrow();

    const row = getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get('to-be-deleted');
    expect(row, 'the entity row survived a delete').toBeUndefined();
    expect(findableByKeyword('keeping'), 'a deleted memory left tokens in the index').toEqual([]);
  });

  it('leaves a searchable memory searchable — the anti-vacuity half', () => {
    // Every assertion above is about absence. Without this one, an
    // archiveEntity that deleted everything, or an FTS index that was never
    // populated, would satisfy them all.
    openDatabase(dbPath);
    seed('left-alone');

    const found = findableByKeyword('keeping');
    // Size first, then identity. Every other assertion in this file is
    // `toEqual([])`, and an index that was never populated satisfies all of
    // them — this is the one that says the index can hold anything at all.
    expect(found, 'the FTS index is empty, so every absence assertion here is vacuous').toHaveLength(1);
    expect(found).toEqual(['left-alone']);
    expect(statusOf('left-alone')).toBe('active');
  });
});
