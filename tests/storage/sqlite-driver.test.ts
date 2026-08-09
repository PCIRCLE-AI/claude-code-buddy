/**
 * The driver swap, tested where it can silently go wrong.
 *
 * Replacing better-sqlite3 with node:sqlite is mostly a like-for-like change —
 * `prepare/run/all/get/exec` behave the same. The parts that do NOT are the
 * parts that fail quietly:
 *
 *   - `{readonly: true}` is better-sqlite3's spelling. node:sqlite's is
 *     `readOnly`, and it does not reject the other one — it ignores it and
 *     opens the database WRITABLE. A test that only proves "the handle opens"
 *     passes either way, which is why every read-only test here writes.
 *   - `db.transaction()` does not exist in node:sqlite at all. Its rollback and
 *     its SAVEPOINT-on-nesting are behaviours the rest of the codebase relies
 *     on without restating; if the re-implementation gets them wrong, the
 *     symptom is lost data or a runtime error in a write path, not a type
 *     error.
 *   - `PRAGMA journal_mode = WAL` is issued through `exec()`, which discards
 *     result rows. The pragma returning a row it never reads is fine; the
 *     pragma not TAKING EFFECT is not, because concurrent hooks depend on WAL.
 *     So it is read back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

describe('Feature: the SQLite driver', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-driver-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A database with one table, closed again. */
  function seed(): void {
    const db = new MemeshDatabase(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('seeded');
    db.close();
  }

  describe('read-only handles', () => {
    it('rejects a write — not merely opens', () => {
      // The whole point. better-sqlite3's `{readonly: true}` is silently
      // ignored by node:sqlite, so "it opened" proves nothing: an unprotected
      // handle opens too. Only an attempted write separates them.
      seed();
      const db = new MemeshDatabase(dbPath, { readOnly: true });
      try {
        expect(() => db.exec("INSERT INTO t (v) VALUES ('smuggled')")).toThrow();
        // And the write really did not land.
        expect(db.prepare('SELECT count(*) AS c FROM t').get()).toMatchObject({ c: 1 });
      } finally {
        db.close();
      }
    });

    it('still reads', () => {
      // The guard must not become "read-only means useless".
      seed();
      const db = new MemeshDatabase(dbPath, { readOnly: true });
      try {
        expect(db.prepare('SELECT v FROM t').get()).toMatchObject({ v: 'seeded' });
      } finally {
        db.close();
      }
    });
  });

  describe('pragma()', () => {
    it('journal_mode = WAL takes effect, not just executes', () => {
      // `exec()` throws away the row this PRAGMA returns. That is fine; what is
      // not fine is the mode never changing, because two hooks and the CLI can
      // hold the database at once and WAL is what lets a reader run during a
      // write. Read it back rather than trusting that the call returned.
      const db = new MemeshDatabase(dbPath);
      try {
        db.pragma('journal_mode = WAL');
        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      } finally {
        db.close();
      }
    });

    it('foreign_keys = ON actually enforces a foreign key', () => {
      // Same shape of check one level up: the setting is only worth having if
      // a violating write fails.
      const db = new MemeshDatabase(dbPath);
      try {
        db.pragma('foreign_keys = ON');
        db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
        db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id))');
        expect(() => db.prepare('INSERT INTO child (p) VALUES (?)').run(999)).toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe('transaction()', () => {
    let db: MemeshDatabase;
    const rows = () => db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => (r as { v: string }).v);

    beforeEach(() => {
      db = new MemeshDatabase(dbPath);
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    });
    afterEach(() => { db.close(); });

    it('commits when the callback returns', () => {
      db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('a'); })();
      expect(rows()).toEqual(['a']);
    });

    it('rolls back when the callback throws, and re-throws', () => {
      // Pin first: the same INSERT, committed, really does leave one row. An
      // empty-table assertion on its own passes just as happily when the
      // statement never ran at all — proving the write CAN land is what makes
      // the rollback below mean something.
      db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('pin'); })();
      expect(rows().length).toBe(1);
      db.exec('DELETE FROM t');

      expect(() => db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('doomed');
        throw new Error('boom');
      })()).toThrow('boom');
      expect(rows(), 'a rolled-back write survived').toEqual([]);
      // The connection is usable afterwards — a rollback that leaves the
      // transaction open would poison every later write with "cannot start a
      // transaction within a transaction".
      expect(db.isTransaction).toBe(false);
      db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('after'); })();
      expect(rows()).toEqual(['after']);
    });

    it('passes arguments through and returns the callback result', () => {
      expect(db.transaction((n: number) => n * 2)(21)).toBe(42);
    });

    it('.immediate() takes the write lock at BEGIN', () => {
      // Behaviour under contention is not reproducible in-process; what is
      // testable is that the immediate form is a working transaction and not a
      // silently-different code path. Four production call sites use it.
      db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('imm'); }).immediate();
      expect(rows()).toEqual(['imm']);
      expect(() => db.transaction(() => { throw new Error('nope'); }).immediate()).toThrow('nope');
      expect(db.isTransaction).toBe(false);
    });

    describe('nesting', () => {
      it('an inner failure leaves the outer transaction intact', () => {
        // SQLite rejects a nested BEGIN outright, so this is the case that
        // proves SAVEPOINT is being used. better-sqlite3 callers swallow an
        // inner throw and expect their own writes to survive.
        db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
          try {
            db.transaction(() => {
              db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
              throw new Error('inner boom');
            })();
          } catch { /* swallowed on purpose */ }
        })();
        expect(rows()).toEqual(['outer']);
      });

      it('an outer failure discards the inner transaction too', () => {
        // The mirror. A committed SAVEPOINT is not durable on its own — it is
        // still inside the outer BEGIN, and must go with it.
        expect(() => db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
          db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('inner'); })();
          throw new Error('outer boom');
        })()).toThrow('outer boom');
        expect(rows()).toEqual([]);
      });

      it('a fully successful nest commits both', () => {
        db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
          db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('inner'); })();
        })();
        expect(rows()).toEqual(['outer', 'inner']);
        expect(db.isTransaction).toBe(false);
      });

      it('recovers to a usable connection after a nested failure', () => {
        // Depth bookkeeping is the thing that can drift: get it wrong and the
        // NEXT top-level transaction opens a SAVEPOINT with no BEGIN around
        // it, and nothing is ever durable again.
        expect(() => db.transaction(() => {
          db.transaction(() => { throw new Error('deep'); })();
        })()).toThrow('deep');
        expect(db.isTransaction).toBe(false);
        db.transaction(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run('later'); })();
        db.close();
        const reopened = new MemeshDatabase(dbPath);
        try {
          expect(
            reopened.prepare('SELECT v FROM t').all().map((r) => (r as { v: string }).v),
            'the write after a nested failure was not durable',
          ).toEqual(['later']);
        } finally {
          reopened.close();
          db = new MemeshDatabase(dbPath); // afterEach closes this
        }
      });
    });
  });

  describe('the experimental-feature warning', () => {
    it('is not printed when the driver is loaded, and nothing else is silenced', async () => {
      // Node 22.5+ prints "SQLite is an experimental feature…" on first load of
      // node:sqlite, and memesh supports the whole Node 22 LTS line — so
      // without the suppression every CLI run, every hook and every MCP
      // handshake emits a line the user cannot act on. Node 24 and 26 print
      // nothing, so on those runtimes this asserts the absence of something
      // that was already absent; the Node 22 leg of CI is what gives it teeth.
      //
      // It has to run in a SUBPROCESS: the warning fires once per process, and
      // this test file has already imported the driver. And it has to load the
      // BUILT module rather than a copy of the shim pasted into a fixture — a
      // test that re-implements the thing it is checking passes no matter what
      // the real module does.
      const { spawnSync } = await import('node:child_process');
      const built = path.resolve('dist/storage/sqlite.js');
      expect(
        fs.existsSync(built),
        `dist/storage/sqlite.js is missing — run \`npm run build\`. This test loads the built driver on purpose; it cannot check the shim by re-declaring it.`,
      ).toBe(true);

      const entry = path.join(dir, 'load.mjs');
      fs.writeFileSync(
        entry,
        `await import(${JSON.stringify(pathToFileURL(built).href)});\n` +
        // A second, unrelated warning proves the patch was surgical rather
        // than "warnings were turned off", and that emitWarning was restored.
        `process.emitWarning('a different warning');\n`,
      );

      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
      expect(result.error, String(result.error)).toBeUndefined();
      expect(result.status, `driver failed to load: ${result.stderr}`).toBe(0);
      expect(result.stderr, 'the SQLite experimental warning reached stderr')
        .not.toContain('SQLite is an experimental feature');
      expect(result.stderr, 'suppression leaked to unrelated warnings')
        .toContain('a different warning');
    });
  });
});
