/**
 * What the swap must carry, and what it must not.
 *
 * `swapVectorGeneration` used to be `DROP live; CREATE live; INSERT … SELECT
 * FROM staging`, which makes the new live index EXACTLY the staging table. Two
 * populations exist only in the live index, and that shape discarded both
 * silently:
 *
 *   1. Rows a concurrent writer added while the rebuild ran. Every writer
 *      except the rebuild loop targets the live table, and the loop works from
 *      an entity list snapshotted before it started — so a memory captured
 *      mid-rebuild lost its vector, and one whose text was EDITED mid-rebuild
 *      had its fresh vector replaced by the staged pre-edit one, which
 *      `countMissingVectors` cannot see because the row is present.
 *   2. Conversely, a row staged for an entity since archived or forgotten.
 *      `archiveEntity`/`deleteEntity` delete from the live table only, and the
 *      loop lists `status='active'` so it never revisits the entity — the swap
 *      resurrected a memory the user had deleted.
 *
 * The third test pins the flag ownership. `swapVectorGeneration` used to delete
 * `pending_reindex` itself, which pre-empted the decision `reindex()` makes
 * afterwards from the finished index — so on a width change the marker was set
 * at open, deleted by the swap, and `memesh doctor` (whose only vector check
 * reads that row) went quiet over a graph still owed vectors.
 *
 * Every assertion here is on DATA — row presence and the vector bytes — not on
 * a table name. A table name returning proves nothing about the vectors.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openDatabase,
  closeDatabase,
  getDatabase,
  beginVectorGeneration,
  swapVectorGeneration,
  generationRowIds,
  getPendingReindexInfo,
  markReindexOwed,
} from '../src/db.js';

const DIM = 768;

/** A vector whose first float is `tag`, so provenance is checkable per row. */
function vec(tag: number): Buffer {
  const b = Buffer.alloc(DIM * 4);
  b.writeFloatLE(tag, 0);
  return b;
}

describe('Feature: the swap carries the live index forward, and prunes what is gone', () => {
  let dir: string;
  let dbPath: string;
  let savedMemeshDir: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-swap-sem-'));
    dbPath = path.join(dir, 'test.db');
    savedMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ embedder: { provider: 'ollama' } }),
    );
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    stderrSpy.mockRestore();
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Seed an active entity and return its id. */
  function seed(name: string): number {
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type) VALUES (?, 'note')").run(name);
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number };
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(row.id, 'a memory');
    return Number(row.id);
  }

  function putLive(id: number, tag: number): void {
    const db = getDatabase();
    db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(id));
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(id), vec(tag));
  }

  function putStaged(id: number, tag: number): void {
    getDatabase()
      .prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(id), vec(tag));
  }

  function liveTag(id: number): number | null {
    const row = getDatabase()
      .prepare('SELECT embedding FROM entities_vec WHERE rowid = ?')
      .get(BigInt(id)) as { embedding: Uint8Array } | undefined;
    return row ? Buffer.from(row.embedding).readFloatLE(0) : null;
  }

  function liveCount(): number {
    return (getDatabase().prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c;
  }

  it('keeps a vector a concurrent writer put in the live index during the build', () => {
    const staged = seed('was-in-the-snapshot');
    const concurrent = seed('remembered-mid-rebuild');

    // The rebuild stages only what its snapshot contained.
    beginVectorGeneration(DIM, 'ollama');
    putStaged(staged, 11);
    // A hook / remember() writes the live table while the rebuild runs. No
    // `target`, so it lands in `entities_vec`, not in the generation.
    putLive(concurrent, 22);

    // Anti-vacuity: prove the fixture is real before asserting on the result.
    // Without this a setup that staged nothing would satisfy the assertions
    // below for the wrong reason.
    expect(generationRowIds().has(staged), 'fixture: the staged row exists').toBe(true);
    expect(generationRowIds().has(concurrent), 'fixture: the live-only row is NOT staged').toBe(false);

    swapVectorGeneration(DIM);

    expect(liveTag(staged), 'the staged vector was not promoted').toBe(11);
    expect(
      liveTag(concurrent),
      'the swap discarded a vector written while the rebuild ran',
    ).toBe(22);
    expect(liveCount()).toBe(2);
  });

  it('does not resurrect a staged vector for an entity that is no longer active', () => {
    const kept = seed('still-here');
    const forgotten = seed('forgotten-mid-rebuild');

    beginVectorGeneration(DIM, 'ollama');
    putStaged(kept, 11);
    putStaged(forgotten, 99);

    // `forget` archives the entity and clears the LIVE row; it does not know a
    // staging table exists.
    getDatabase().prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(forgotten);
    getDatabase().prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(forgotten));

    // Anti-vacuity: the staged row for the archived entity really is there, so
    // "it is gone afterwards" cannot pass by never having existed.
    expect(generationRowIds().has(forgotten), 'fixture: the orphan row is staged').toBe(true);

    swapVectorGeneration(DIM);

    expect(liveTag(kept)).toBe(11);
    expect(
      liveTag(forgotten),
      "a forgotten memory's vector came back through the swap",
    ).toBeNull();
    expect(liveCount()).toBe(1);
  });

  it('leaves pending_reindex alone — the swap is not its owner', () => {
    const id = seed('alpha');
    beginVectorGeneration(DIM, 'ollama');
    putStaged(id, 11);

    // A width change recorded that a rebuild is owed. Only a measurement of the
    // FINISHED index may retire that, and the swap is not that measurement.
    markReindexOwed(1536, DIM, 'dimension-change');
    expect(getPendingReindexInfo()).not.toBeNull();

    swapVectorGeneration(DIM);

    expect(
      getPendingReindexInfo(),
      'the swap deleted the reindex-owed marker before anything measured the result',
    ).not.toBeNull();
  });

  it('does not carry live rows across when the width changed — they are not comparable', () => {
    const id = seed('alpha');
    const other = seed('beta');
    // Live index is at DIM and stamped as such by openDatabase.
    putLive(other, 77);

    // A generation at a DIFFERENT width. `beta` has no staged row, and its
    // 768-dim live vector must not be copied into a 1536-dim index.
    beginVectorGeneration(1536, 'ollama');
    getDatabase()
      .prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(id), Buffer.alloc(1536 * 4));

    swapVectorGeneration(1536);

    const row = getDatabase()
      .prepare('SELECT embedding FROM entities_vec WHERE rowid = ?')
      .get(BigInt(id)) as { embedding: Uint8Array } | undefined;
    expect(row, 'the staged row was not promoted').toBeDefined();
    expect(row!.embedding.length / 4, 'the new index is not at the new width').toBe(1536);
    expect(
      liveCount(),
      'a vector of the old width was carried into an index of the new width',
    ).toBe(1);
    expect(generationRowIds().size, 'the staging table survived the swap').toBe(0);
  });

  it('refuses a width that is not a positive integer instead of interpolating it into DDL', () => {
    expect(() => swapVectorGeneration('768); DROP TABLE entities--' as unknown as number)).toThrow(
      /Refusing to build a vector index at width/,
    );
    expect(() => beginVectorGeneration(0, 'ollama')).toThrow(/Refusing/);
    // The point of the guard: the schema is still there.
    const n = (getDatabase()
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='entities'")
      .get() as { c: number }).c;
    expect(n, 'the guard let a crafted width reach the DDL').toBe(1);
  });
});
