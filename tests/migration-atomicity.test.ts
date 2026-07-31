/**
 * The index migration has to be safe against the other processes that share
 * the database.
 *
 * Seven hooks, the MCP server, the HTTP server and the CLI all call
 * `openDatabase()`, so "another process is writing right now" is the normal
 * case, not an edge one. The original rebuild read its source rows BEFORE
 * `db.transaction()` opened, and better-sqlite3's default transaction is
 * BEGIN DEFERRED — no write lock existed until the first statement inside it.
 * An entity committed in that window was wiped by `delete-all` and never
 * reinserted, because the row list predated it. The version marker then
 * committed, so it never retried: the memory stayed in `entities` and was
 * unreachable by search, permanently and silently.
 *
 * These cases pin the three properties that fix it — the read happens under
 * the write lock, a failure backs off instead of re-scanning the corpus on
 * every process start, and the marker is not advanced by a failed run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, getDatabase, reindexFts, runOnceMigration } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';

describe('Feature: index migration atomicity', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-migration-'));
    dbPath = path.join(dir, 'test.db');
    try { closeDatabase(); } catch { /* none open */ }
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Put the database back into the pre-segmentation state. */
  function makeLegacy(): void {
    const db = openDatabase(dbPath);
    const id = new KnowledgeGraph(db).createEntity('existing-note', 'note', {
      observations: ['資料庫遷移前一定要先備份'],
    });
    db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(
      id,
      'existing-note',
      '資料庫遷移前一定要先備份'
    );
    db.prepare("DELETE FROM memesh_metadata WHERE key = 'fts_segmentation_version'").run();
    closeDatabase();
  }

  /**
   * Make the rebuild throw.
   *
   * Dropping `entities_fts` does NOT work: `openDatabase()` runs FTS_SQL with
   * CREATE VIRTUAL TABLE IF NOT EXISTS and simply puts it back, so the rebuild
   * succeeds and the failure path is never exercised. Replacing it with a
   * table that has the wrong columns survives that CREATE (IF NOT EXISTS sees
   * a table and leaves it), and the reinsert then fails on the missing
   * `observations` column.
   */
  function breakFtsIndex(): void {
    const broken = new Database(dbPath);
    broken.exec('DROP TABLE entities_fts');
    broken.exec("CREATE VIRTUAL TABLE entities_fts USING fts5(name, content='')");
    broken.close();
  }

  it('holds the write lock for the whole migration, so no writer can slip in', () => {
    // This is the property, tested directly, because the race itself cannot be
    // scheduled deterministically from one process.
    //
    // The migration reads the corpus and empties the index. If another
    // connection can commit a row between those two moments, that row is
    // deleted from the index and never reinserted — it stays in `entities`,
    // so no count-based check notices, and the marker commits so it never
    // retries. BEGIN IMMEDIATE is what closes the window: it takes the write
    // lock at BEGIN rather than at the first write inside the transaction.
    //
    // A first attempt at this test wrote from the second connection BEFORE
    // openDatabase() and asserted the memory survived. That passes against
    // the buggy implementation too — the write had already committed, so the
    // pre-lock read saw it. Verified by mutation: restoring the old
    // read-before-delete-all shape left all cases green. Observing the lock
    // is what actually distinguishes the two.
    const db = openDatabase(dbPath);
    new KnowledgeGraph(db).createEntity('existing-note', 'note', {
      observations: ['資料庫遷移前一定要先備份'],
    });

    let writeWasRejected: boolean | null = null;

    runOnceMigration(db, {
      key: 'test_lock_probe',
      version: 1,
      describe: 'lock probe',
      migrate: () => {
        // Inside the migration, before it has written anything. Under BEGIN
        // IMMEDIATE the lock is already held; under BEGIN DEFERRED it is not.
        const other = new Database(dbPath);
        other.pragma('busy_timeout = 0');
        try {
          other.prepare("INSERT INTO entities (name, type) VALUES ('sneaked-in', 'note')").run();
          writeWasRejected = false;
        } catch (err) {
          writeWasRejected = /busy|locked/i.test(err instanceof Error ? err.message : String(err));
        } finally {
          other.close();
        }
      },
    });

    expect(writeWasRejected).toBe(true);
  });

  it('rebuilds every active memory, including ones added since the last index write', () => {
    makeLegacy();

    // Committed by another connection while the index is still stale. It has
    // no FTS row at all, so only a rebuild that re-derives from `entities`
    // reaches it.
    const other = new Database(dbPath);
    other.pragma('journal_mode = WAL');
    other.prepare("INSERT INTO entities (name, type) VALUES ('written-elsewhere', 'note')").run();
    const otherId = other
      .prepare("SELECT id FROM entities WHERE name = 'written-elsewhere'")
      .get() as { id: number };
    other
      .prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)')
      .run(otherId.id, 'a memory saved by a concurrent process');
    other.close();

    openDatabase(dbPath);
    const kg = new KnowledgeGraph(getDatabase());

    expect(kg.search('資料庫遷移').map((e) => e.name)).toContain('existing-note');
    expect(kg.search('concurrent process').map((e) => e.name)).toContain('written-elsewhere');
  });

  it('does not advance the version marker when the rebuild fails', () => {
    makeLegacy();

    breakFtsIndex();

    // Opening must still succeed — entities and observations are the source of
    // truth and an index rebuild cannot endanger them.
    const db = openDatabase(dbPath);
    expect(db.prepare('SELECT count(*) AS c FROM entities').get()).toEqual({ c: 1 });

    // The marker must NOT read as migrated, or the retry never happens.
    const marker = db
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version'")
      .get();
    expect(marker).toBeUndefined();
  });

  it('backs off after a failure instead of retrying on every open', () => {
    makeLegacy();

    breakFtsIndex();

    openDatabase(dbPath);
    const attempt = getDatabase()
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version_last_attempt'")
      .get() as { value: string } | undefined;
    closeDatabase();

    // An attempt timestamp is what stops a permanently broken index from
    // re-scanning the whole corpus on every CLI call and every hook fire —
    // the same 24h throttle its neighbours runAutoDecay and
    // runAutoTelemetryPrune already use.
    expect(attempt).toBeDefined();
    expect(Number(attempt!.value)).toBeGreaterThan(0);
  });

  it('reindexFts rebuilds even when the marker says there is nothing to do', () => {
    // The marker only moves forward, so it cannot describe "migrated, then
    // written to by an older build". This is the escape hatch from that state,
    // and it has to ignore the marker to be one.
    const db = openDatabase(dbPath);
    const id = new KnowledgeGraph(db).createEntity('stale-note', 'note', {
      observations: ['資料庫遷移前一定要先備份'],
    });

    // Simulate an old build's write: unsegmented row, marker left untouched.
    db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(
      id,
      'stale-note',
      '資料庫遷移前一定要先備份'
    );

    const kg = new KnowledgeGraph(db);
    expect(kg.search('資料庫遷移').map((e) => e.name)).not.toContain('stale-note');

    const { entities } = reindexFts();
    expect(entities).toBe(1);
    expect(kg.search('資料庫遷移').map((e) => e.name)).toContain('stale-note');
  });
});
