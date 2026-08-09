/**
 * The hook-side FTS segmentation migration.
 *
 * `ensureHookFtsSegmentation` is ~150 lines that run on every hook process that
 * opens the database with `{ fts: true }` — SessionStart, Stop, PreCompact,
 * pre-edit-recall. It had NO test. Deleting its call site entirely
 * (`if (opts.fts) ensureHookFtsSegmentation(db);` in `openHookDb`) left all
 * 1303 tests green, and its own docblock claimed "both halves are pinned by
 * tests" while `tests/hooks/mirror-parity.test.ts` pins only the version
 * CONSTANT and the match expression, not the migration.
 *
 * Why it matters more than most untested code: a user whose memesh activity is
 * entirely hook-driven never runs a core process, so this is the ONLY thing
 * that migrates their index. And core and the hook share one marker key, so a
 * disagreement between them is not two behaviours — it is a race, decided by
 * whichever process opens the database first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

const require = createRequire(import.meta.url);
// `fileURLToPath`, not `new URL(...).pathname` — the latter yields `/D:/...` on
// Windows, which path.join turns into `D:\D:\...`. Pinned by
// tests/release-scripts-safety.test.ts.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Feature: hooks migrate the keyword index too', () => {
  let dir: string;
  let dbPath: string;
  let shared: any;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hookmig-'));
    dbPath = path.join(dir, 'test.db');
    shared = await import('../../scripts/hooks/_shared.js');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Open the way a hook does. */
  function open() {
    return shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
  }

  /**
   * Stage a database an OLDER build left behind: real rows, an index holding
   * whole unsegmented runs, and the marker rolled back.
   */
  function stageOldIndex(text: string, marker = '1'): void {
    const handle = open();
    const db = handle.db;
    db.prepare("INSERT INTO entities (name, type) VALUES ('note-1', 'note')").run();
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'note-1'").get() as any).id;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, text);

    db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(
      id,
      'note-1',
      text
    );
    db.prepare(
      "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('fts_segmentation_version', ?)"
    ).run(marker);
    db.close();
  }

  function terms(db: any): string[] {
    return (db.prepare('SELECT term FROM fts_vocab').all() as { term: string }[]).map((r) => r.term);
  }

  it('rebuilds a stale index when a hook opens the database', () => {
    // The case the deleted call site owns. Without it the marker stays behind
    // and the whole run stays in the index, so no fragment query can reach it.
    stageOldIndex('資料庫遷移前一定要先備份');

    const handle = open();
    const marker = handle.db
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version'")
      .get() as { value: string };
    const after = terms(handle.db);
    handle.db.close();

    expect(marker.value).toBe(String(shared.FTS_SEGMENTATION_VERSION));
    // Segmented: the whole run is gone, bigrams are there.
    expect(after).not.toContain('資料庫遷移前一定要先備份');
    expect(after).toContain('資料');
    expect(after).toContain('備份');
  });

  it('rebuilds the scripts the widened class added, not only CJK', () => {
    // Thai is NFC-stable and was outside the class before version 3, so this is
    // the corpus a normalisation-only shortcut strands. Core had exactly that
    // bug; this asserts the hook side does not grow one.
    stageOldIndex('สำรองข้อมูลก่อนย้ายฐานข้อมูล');

    const handle = open();
    const after = terms(handle.db);
    handle.db.close();

    // BOTH original assertions here are negative, and an empty index
    // satisfies both: a rebuild that deletes the Thai row and writes nothing
    // back used to pass this test — the exact failure it exists to catch.
    // Pin the rebuild's output before asserting what it must not contain.
    expect(after.length, 'the rebuild wrote nothing back for the Thai row').toBeGreaterThan(0);
    expect(after).not.toContain('สำรองข้อมูลก่อนย้ายฐานข้อมูล');
    // No surviving run longer than a bigram, which is what doctor checks for.
    expect(after.filter((t) => [...t].length > 2 && !/^[\x00-\x7F]+$/.test(t))).toEqual([]);
  });

  it('leaves an already-current database completely alone', () => {
    // The migration must be a no-op at the current marker, or every hook
    // process rewrites the whole corpus under a lock seven of them contend for.
    // Observed the way idempotency always is: hand-write a row the rebuild
    // would never produce and check it survives.
    const handle0 = open();
    const db0 = handle0.db;
    db0.prepare("INSERT INTO entities (name, type) VALUES ('note-1', 'note')").run();
    const id = (db0.prepare("SELECT id FROM entities WHERE name = 'note-1'").get() as any).id;
    db0.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, 'hello');
    db0.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    db0.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(
      id,
      'note-1',
      'sentinel-token-the-rebuild-would-not-produce'
    );
    db0.close(); // marker already at the current version from the first open

    const handle = open();
    const after = terms(handle.db);
    handle.db.close();
    expect(after).toContain('sentinel');
  });

  it('does not advance the marker when the rebuild fails', () => {
    // If a failed run stamped the marker, the index would stay broken forever —
    // the marker only moves forward, so nothing would ever retry. The failure
    // is injected in-process rather than by killing anything: a trigger that
    // rejects the marker write aborts the transaction the rebuild runs in.
    stageOldIndex('資料庫遷移前一定要先備份');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TRIGGER block_marker BEFORE INSERT ON memesh_metadata
      WHEN NEW.key = 'fts_segmentation_version'
      BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    `);
    raw.close();

    const handle = open();
    const marker = handle.db
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version'")
      .get() as { value: string };
    const after = terms(handle.db);
    handle.db.close();

    // Rolled back together: marker still behind AND the old index intact.
    expect(marker.value).toBe('1');
    expect(after).toContain('資料庫遷移前一定要先備份');
  });

  it('agrees with core on which errors are transient', () => {
    // Core and the hook share ONE marker key and one 24h backoff key. If one
    // classifies a held write lock as a permanent failure it parks the
    // migration for both, machine-wide, for a day — over a peer that was simply
    // mid-write. The classifier is mirrored, so pin that it stays mirrored.
    const coreSrc = fs.readFileSync(path.join(repoRoot, 'src', 'db.ts'), 'utf8');
    const hookSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'hooks', '_shared.js'), 'utf8');
    const pattern = /SQLITE_BUSY\|SQLITE_LOCKED\|SQLITE_PROTOCOL/;
    expect(coreSrc, 'core lost its transient classifier').toMatch(pattern);
    expect(hookSrc, 'the hook mirror lost its transient classifier').toMatch(pattern);
  });
});
