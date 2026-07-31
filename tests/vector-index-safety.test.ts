/**
 * The vector index must survive a config the process cannot read.
 *
 * `ensureVecTable()` drops and recreates `entities_vec` whenever the configured
 * embedding dimension differs from the stored one. The dimension comes from
 * `~/.memesh/config.json`, and `readConfig()` used to return `{}` for BOTH "the
 * user configured nothing" and "the file could not be read" — so a config that
 * was truncated mid-write, or briefly unreadable, resolved to the 384-dim ONNX
 * default and DROPPED a BYOK user's entire 1536-dim index. No backup, no
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
import { openDatabase, closeDatabase } from '../src/db.js';

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
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('still rebuilds on a genuine, readable dimension change', () => {
    // The guard must not become "never migrate". An ABSENT config is a real
    // answer (Core Mode, 384-dim), so switching to it from a readable 1536-dim
    // config is a change the user made and the rebuild should happen.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    openDatabase(dbPath);
    expect(storedDimension()).toBe(1536);
    closeDatabase();

    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    written.length = 0;

    expect(storedDimension()).toBe(768);
    expect(written.join('')).toContain('Embedding dimension changed');
  });
});
