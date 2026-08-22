/**
 * The vector index must survive a config the process cannot read.
 *
 * `ensureVecTable()` no longer drops anything at all — that is the point of the
 * generation mechanism, and the second half of this file pins it. What it used
 * to do, and what the first test still guards, is drop and recreate
 * `entities_vec` whenever the configured embedding dimension differed from the
 * stored one. The dimension comes from
 * `~/.memesh/config.json`, and `readConfig()` used to return `{}` for BOTH "the
 * user configured nothing" and "the file could not be read" — so a config that
 * was truncated mid-write, or briefly unreadable, resolved to the 384-dim
 * keyword-only default and DROPPED a BYOK user's entire 1536-dim index. No backup, no
 * confirmation, and regenerating it means re-running the whole embedding
 * pipeline and paying an API provider for it a second time.
 *
 * The fix is two lines in two files, and they only work as a pair:
 *
 *   - `config.ts`  `resolveEmbeddingDimension()` reports `confident: false`
 *                  when the read state is `unreadable` (an ABSENT config is a
 *                  real answer — Core Mode — and stays confident).
 *   - `db.ts`      `ensureVecTable()` returns early rather than dropping when
 *                  `dimensionKnown` is false.
 *
 * This file exists because the fix shipped measured but unpinned: a mutation
 * sweep found that reverting EITHER line left the whole suite green.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openDatabase,
  closeDatabase,
  beginVectorGeneration,
  swapVectorGeneration,
  discardVectorGeneration,
  readVectorGeneration,
  generationRowIds,
  getPendingReindexInfo,
} from '../src/db.js';

describe('Feature: an unreadable config does not delete embeddings', () => {
  let dir: string;
  let dbPath: string;
  let configPath: string;
  let savedMemeshDir: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string[];

  /** Config selecting OpenAI embeddings — 1536 dimensions, not the 384 default. */
  const BYOK_CONFIG = JSON.stringify({ embedder: { provider: 'openai' } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-vec-safety-'));
    dbPath = path.join(dir, 'test.db');
    configPath = path.join(dir, 'config.json');
    savedMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    written = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try { closeDatabase(); } catch { /* none open */ }
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    stderrSpy.mockRestore();
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function storedDimension(): number | undefined {
    const row = openDatabase(dbPath)
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : undefined;
  }

  it('keeps a 1536-dim index — and its vectors — when the config becomes unreadable', () => {
    fs.writeFileSync(configPath, BYOK_CONFIG);

    const db = openDatabase(dbPath);
    expect(storedDimension()).toBe(1536);

    // Seed a real vector. "The table still exists" is too weak a claim — the
    // failure being pinned destroys CONTENT, and a dropped-then-recreated
    // table is also a table that exists.
    db.prepare("INSERT INTO entities (name, type) VALUES ('embedded-note', 'note')").run();
    const id = (
      db.prepare("SELECT id FROM entities WHERE name = 'embedded-note'").get() as { id: number }
    ).id;
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(id), // sqlite-vec rejects a JS number for a vec0 primary key
      Buffer.from(new Float32Array(1536).fill(0.5).buffer)
    );
    closeDatabase();

    // A truncated write — the shape a crashed or half-flushed editor leaves.
    // Valid JSON is not required to reach the bug; unreadable is enough.
    fs.writeFileSync(configPath, '{ "embedder": { "provi');
    written.length = 0;

    expect(storedDimension()).toBe(1536);

    const after = openDatabase(dbPath);
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'").get()
    ).toBeDefined();
    expect(
      (after.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c
    ).toBe(1);

    // No `pending_reindex` row: nothing was dropped, so nothing needs rebuilding.
    expect(
      after.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get()
    ).toBeUndefined();

    // Silence would be its own bug — the user needs to know their config is
    // broken, even though their data survived it.
    expect(written.join('')).toContain('left untouched');
  });


  it('a dimension change keeps every vector — the open path has no destructive branch left', () => {
    // This used to require consent, and the consent existed because the open
    // path dropped the index. Generations removed the drop, so the answer is
    // now unconditional: a readable, deliberate dimension change deletes
    // nothing, records that a rebuild is owed, and leaves the index answering
    // queries at its old width until a complete new one is ready.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    expect(storedDimension()).toBe(1536);
    db.prepare("INSERT INTO entities (name, type) VALUES ('kept', 'note')").run();
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(1536 * 4));
    closeDatabase();

    // Switch to ollama: 768 dim, readable config, unambiguous intent.
    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    const reopened = openDatabase(dbPath);

    const rows = (reopened.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c;
    expect(rows, 'a dimension change deleted stored vectors').toBe(1);
    expect(storedDimension(), 'the stamp moved before a new index existed').toBe(1536);
    expect(written.join(''), 'the user was not told a rebuild is owed').toContain('reindex');

    // The marker is the ONLY thing `memesh doctor` reads to know a rebuild is
    // owed. It used to be skipped on open: `markReindexOwed` guarded on the
    // module-level singleton, which is assigned only AFTER `initialiseDatabase`
    // returns, so during open it was still null and the write silently returned.
    // The warning printed every time; the marker was never written; doctor said
    // PASS. This assertion is what would have caught that.
    const owed = getPendingReindexInfo();
    expect(owed, 'a dimension change left no reindex-owed marker, so doctor cannot see it').not.toBeNull();
    expect(owed).toMatchObject({ from: 1536, to: 768, reason: 'dimension-change' });
  });

  it('the mismatch notice fires once per database, not once per process', () => {
    // The notice is de-duplicated so `memesh doctor` (which opens the database
    // twice) does not print it twice. The de-dup flag lives at module scope, so
    // without a reset on close a process that opens a SECOND mismatched
    // database — the test suite, or a long-lived server — would never be told
    // about it: the second warning was swallowed by the first. Vitest's
    // per-file process isolation hid this from every other test here.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    openDatabase(dbPath); closeDatabase();                       // stamped 1536
    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));

    // Earlier tests in this file may already have tripped the de-dup flag in
    // this process, so the FIRST open here is not the discriminating one and
    // is not asserted on. The close that follows it is what the test is about.
    openDatabase(dbPath); closeDatabase();

    // A second, different database in the same process, same mismatch.
    const dbPath2 = path.join(dir, 'second.db');
    fs.writeFileSync(configPath, BYOK_CONFIG);
    openDatabase(dbPath2); closeDatabase();                      // stamped 1536
    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));

    written.length = 0;
    openDatabase(dbPath2);
    expect(
      written.join(''),
      'the second database\'s warning was swallowed by the first one\'s de-dup flag',
    ).toContain('records 1536-dim');
  });

  it('the marker write sits OUTSIDE the once-only notice guard', () => {
    // "Notice once, marker always." In review, a brace edit that moved the
    // marker write INSIDE the once-only guard survived the whole suite. Two
    // behavioural tests were written to catch it and BOTH passed for the wrong
    // reason: the scenario — a fresh open while the notice flag is already
    // set — is unreachable in one process. `openDatabase` returns the existing
    // singleton (`if (db) return db`), and the only way to get a new open,
    // `closeDatabase`, resets the flag. So the guard is carried by STRUCTURE,
    // and structure is what this pins: the call must not be inside the guard.
    const src = fs.readFileSync(path.resolve(__dirname, '../src/db.ts'), 'utf8');
    const guardStart = src.indexOf('if (!dimensionMismatchNoticed) {');
    expect(guardStart, 'the once-only guard is gone or renamed').toBeGreaterThan(0);
    const guardEnd = src.indexOf('\n    }\n', guardStart);
    const guardBody = src.slice(guardStart, guardEnd);
    expect(guardBody, 'the marker write was moved inside the once-only guard').not.toContain('markReindexOwed(');
    const after = src.slice(guardEnd, guardEnd + 600);
    expect(after, 'the marker write no longer follows the guard').toContain("markReindexOwed(currentDim, targetDim, 'dimension-change', db)");
  });

  it('a generation is built beside the live index, not in place', () => {
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('live', 'note')").run();
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(1536 * 4));

    beginVectorGeneration(768, 'ollama');
    db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(768 * 4));

    // Both alive at once, at different widths — the property the whole design
    // rests on, and one that was measured against sqlite-vec before it was
    // designed on.
    expect((db.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c).toBe(1);
    expect(generationRowIds().has(1)).toBe(true);
    expect(readVectorGeneration()).toMatchObject({ state: 'open', info: { dimension: 768, provider: 'ollama' } });
  });

  it('a discarded generation leaves the live index untouched', () => {
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('live', 'note')").run();
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(1536 * 4));
    beginVectorGeneration(768, 'ollama');
    db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(768 * 4));

    discardVectorGeneration();

    expect((db.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c).toBe(1);
    expect(readVectorGeneration()).toEqual({ state: 'none' });
    expect(generationRowIds().size).toBe(0);
  });

  it('an incompatible half-built generation is discarded rather than continued', () => {
    // Resuming across a provider or width change would mix vectors from two
    // different spaces into one index — the drift the mechanism exists to stop.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    beginVectorGeneration(768, 'ollama');
    db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(768 * 4));
    expect(generationRowIds().size).toBe(1);

    const again = beginVectorGeneration(1536, 'openai');
    expect(again.resumed, 'a 768-dim ollama generation was resumed as 1536-dim openai').toBe(false);
    expect(generationRowIds().size, 'incompatible staged vectors survived').toBe(0);
    expect(readVectorGeneration()).toMatchObject({ state: 'open', info: { dimension: 1536, provider: 'openai' } });
  });

  it('a compatible half-built generation IS resumed, so paid embeddings are not re-bought', () => {
    fs.writeFileSync(configPath, BYOK_CONFIG);
    openDatabase(dbPath);
    beginVectorGeneration(1536, 'openai');
    openDatabase(dbPath).prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(1536 * 4));

    const again = beginVectorGeneration(1536, 'openai');
    expect(again.resumed).toBe(true);
    expect(generationRowIds().has(1), 'a resume threw away an embedding already paid for').toBe(true);
  });

  it('a swap that fails mid-transaction leaves the previous index intact', () => {
    // The crash-injection test this path never had. `swapVectorGeneration`
    // drops the live table, recreates it at the new width and copies the
    // staged rows — all inside one transaction, precisely so a failure part
    // way cannot publish a half-built index. A trigger that refuses the
    // metadata write forces the failure at the last step, after the drop and
    // the copy have already happened, which is the worst moment for it.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('live', 'note')").run();
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(1536 * 4));
    beginVectorGeneration(768, 'ollama');
    db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(768 * 4));

    db.exec(`
      CREATE TRIGGER refuse_dim_stamp BEFORE INSERT ON memesh_metadata
      WHEN NEW.key = 'embedding_dimension'
      BEGIN SELECT RAISE(ABORT, 'injected swap failure'); END;
    `);
    expect(() => swapVectorGeneration(768)).toThrow(/injected swap failure/);
    db.exec('DROP TRIGGER refuse_dim_stamp');

    // The live index is still the OLD one: same row, same width, and the
    // dimension stamp never moved. Checked on the DATA, not on the table
    // name — a recreated empty table is also a table that exists.
    const row = db.prepare('SELECT embedding FROM entities_vec WHERE rowid = 1').get() as { embedding: Uint8Array };
    expect(row.embedding.length / 4, 'the swap published a half-built index').toBe(1536);
    expect(storedDimension()).toBe(1536);
    expect(generationRowIds().has(1), 'the staged work was lost to a failed swap').toBe(true);

    // Re-read from a FRESH connection, which is the bar db.ts's own header sets
    // ("a FRESH connection still read the original table") and the weaker
    // same-connection read cannot meet. vec0 keeps four shadow tables and
    // per-connection module state, so the handle that ran the failed swap is
    // exactly the one most likely to answer from memory a reopen would not
    // reproduce. A rollback that only holds inside the connection that failed is
    // not a rollback.
    closeDatabase();
    const fresh = openDatabase(dbPath);
    const reread = fresh.prepare('SELECT embedding FROM entities_vec WHERE rowid = 1')
      .get() as { embedding: Uint8Array } | undefined;
    expect(reread, 'the previous index is gone when read from a new connection').toBeDefined();
    expect(
      reread!.embedding.length / 4,
      'the rollback only held inside the connection that failed',
    ).toBe(1536);
    expect(
      (fresh.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c,
      'the row count did not survive a reopen',
    ).toBe(1);
    expect(generationRowIds().has(1), 'the staged work did not survive a reopen').toBe(true);
  });

  it('a completed swap promotes the generation and clears its marker', () => {
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('live', 'note')").run();
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(1536 * 4));
    beginVectorGeneration(768, 'ollama');
    db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(1n, Buffer.alloc(768 * 4));

    swapVectorGeneration(768);

    const row = db.prepare('SELECT embedding FROM entities_vec WHERE rowid = 1').get() as { embedding: Uint8Array };
    expect(row.embedding.length / 4, 'the new generation was not switched in').toBe(768);
    expect(storedDimension()).toBe(768);
    expect(readVectorGeneration(), 'the generation marker outlived its generation').toEqual({ state: 'none' });
    expect(generationRowIds().size, 'the staging table survived the swap').toBe(0);
  });
});
