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
import { openDatabase, closeDatabase, allowVectorIndexRebuild } from '../src/db.js';
import { isEmbeddingAvailable, canRefillVectorIndex, resetEmbeddingState } from '../src/core/embedder.js';

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

  /** Open at 1536 with one real vector stored, then close. */
  function seedByokIndex(): number {
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const db = openDatabase(dbPath);
    expect(storedDimension()).toBe(1536);
    db.prepare("INSERT INTO entities (name, type) VALUES ('embedded-note', 'note')").run();
    const id = (
      db.prepare("SELECT id FROM entities WHERE name = 'embedded-note'").get() as { id: number }
    ).id;
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(id),
      Buffer.from(new Float32Array(1536).fill(0.5).buffer)
    );
    closeDatabase();
    return id;
  }

  it('a READABLE dimension change is refused too, until the user asks for it', () => {
    // The guard used to be gated on the config being ABSENT, on the argument
    // that an absent config is weak evidence for destroying data. It is — but
    // so is a present one. `configDir()` follows MEMESH_DIR/HOME while
    // `getDbPath()` follows MEMESH_DB_PATH, so a process under a foreign HOME
    // that HAPPENS to contain a config file (a container image's default
    // config.json, a second machine profile, an unrelated edit that dropped
    // the embedder key) was treated as authoritative for a database it had
    // never seen — and took the DROP branch on exactly the evidence the guard
    // exists to distrust.
    //
    // So the refusal follows the consequence instead of the evidence: keeping
    // a stale index is recoverable by fixing the config, dropping one is not.
    seedByokIndex();

    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    written.length = 0;

    // The 1536-dim index is still there, still 1536, still holding its vector.
    expect(storedDimension()).toBe(1536);
    const after = openDatabase(dbPath);
    expect(
      (after.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c
    ).toBe(1);
    expect(
      after.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get()
    ).toBeUndefined();

    // And the message has to name a command that can actually finish the job.
    // It used to say `memesh reindex`, which cannot change the table's
    // dimension — so following the instruction landed the user right back at
    // this same refusal, for as many times as they were willing to try.
    expect(written.join('')).toContain('memesh reindex --vectors');
  });

  it('rebuilds when the rebuild is explicitly consented to', async () => {
    // The guard must not become "never migrate". `memesh reindex --vectors`
    // grants consent before opening the database, which is the only moment
    // early enough — the drop happens inside `openDatabase`.
    seedByokIndex();

    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    written.length = 0;

    await allowVectorIndexRebuild(dbPath, async () => true);
    const after = openDatabase(dbPath);

    expect(storedDimension()).toBe(768);
    expect(
      (after.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c
    ).toBe(0);
    expect(written.join('')).toContain('Embedding dimension changed');
    // The drop is recorded so `memesh doctor` can still see it after the
    // process that did it has exited.
    expect(
      after.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get()
    ).toBeDefined();
  });

  it('consent is spent by the open that uses it', async () => {
    // A long-lived process — the HTTP server — opens the database more than
    // once. Consent given for one deliberate rebuild must not authorise a
    // second one later in the same process, when nobody asked.
    seedByokIndex();

    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    await allowVectorIndexRebuild(dbPath, async () => true);
    openDatabase(dbPath);
    expect(storedDimension()).toBe(768);
    closeDatabase();

    // Config switched again. No new consent.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    written.length = 0;

    expect(storedDimension()).toBe(768);
    expect(written.join('')).toContain('memesh reindex --vectors');
  });

  it('refuses to record consent when nothing could refill the index', async () => {
    // The command offered as the safe way through a dimension change must not
    // become the cause of the loss it exists to prevent. Dropping the table
    // with no embedding provider available destroys every vector AND leaves
    // nothing able to regenerate them — strictly worse than the refusal.
    //
    // `allowVectorIndexRebuild` takes the check as an argument for this
    // reason: as two adjacent statements in the CLI the ordering would hold
    // only until someone moved one of them, and this is not a mistake that
    // shows up in testing — it shows up in somebody's database.
    seedByokIndex();

    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    written.length = 0;

    expect(await allowVectorIndexRebuild(dbPath, async () => false)).toBe(false);

    // Consent was not recorded, so the open that follows still refuses.
    expect(storedDimension()).toBe(1536);
    expect(
      (openDatabase(dbPath).prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c
    ).toBe(1);
    expect(written.join('')).toContain('memesh reindex --vectors');
  });

  it('a configured provider that cannot actually embed does not authorise the drop', async () => {
    // The precondition has to be a proof, not a claim.
    //
    // `isEmbeddingAvailable()` answers "which provider does the config name",
    // and for openai and ollama it answers yes without checking a key,
    // reaching an endpoint, or comparing a dimension. Passing THAT as the
    // consent precondition means an expired key, a typo'd key, or a stopped
    // Ollama all authorise dropping every embedding in the database — and then
    // nothing can write one back. The refusal exists to prevent exactly that
    // loss, and the claim-based check hands it to the user through the command
    // documented as the safe way through.
    fs.writeFileSync(configPath, BYOK_CONFIG); // openai, 1536-dim
    resetEmbeddingState();

    // No OPENAI_API_KEY, and the network is refused outright. The claim still
    // says yes.
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.openai.com'));
    try {
      expect(isEmbeddingAvailable(), 'setup: the claim-based check should say yes').toBe(true);

      // The proof says no, so the grant is refused...
      expect(await canRefillVectorIndex()).toBe(false);
      expect(await allowVectorIndexRebuild(dbPath, canRefillVectorIndex)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
      resetEmbeddingState();
    }

    // ...and the index the config would have rebuilt is still there, vector
    // and all. Reading the end state, not the return value: the return value
    // being wrong is the whole reason this test exists.
    seedByokIndex();
    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    written.length = 0;
    expect(storedDimension()).toBe(1536);
    expect(
      (openDatabase(dbPath).prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c
    ).toBe(1);
  });

  it('consent granted for one database does not authorise dropping another', async () => {
    // The consent used to be a bare module-level boolean. In any process that
    // opens more than one database — the HTTP server, a library embedding
    // this — a grant recorded for A could be spent by an `openDatabase(B)`
    // that ran first, and B's vectors, never consented to and never asked
    // about, would be the ones dropped. Authorisation as wide as the process
    // for an action as narrow as one file.
    const otherPath = path.join(dir, 'other.db');

    // B is a real BYOK database with a real vector in it.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    const other = openDatabase(otherPath);
    other.prepare("INSERT INTO entities (name, type) VALUES ('other-note', 'note')").run();
    const id = (
      other.prepare("SELECT id FROM entities WHERE name = 'other-note'").get() as { id: number }
    ).id;
    other.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(id),
      Buffer.from(new Float32Array(1536).fill(0.5).buffer)
    );
    closeDatabase();

    // Consent is granted for A. Nobody said anything about B.
    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    expect(await allowVectorIndexRebuild(dbPath, async () => true)).toBe(true);
    written.length = 0;

    // B opens first.
    const reopened = openDatabase(otherPath);

    expect(
      (reopened.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as { value: string }).value
    ).toBe('1536');
    expect(
      (reopened.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c,
      "another database's vectors were dropped on A's consent"
    ).toBe(1);
    expect(written.join('')).toContain('memesh reindex --vectors');
  });

  it('consent left unused does not leak into an unrelated later open', async () => {
    // Granting consent and then not needing it (the dimensions matched after
    // all) must not leave the flag armed for the next open, which could be a
    // different database entirely.
    fs.writeFileSync(configPath, BYOK_CONFIG);
    await allowVectorIndexRebuild(dbPath, async () => true);
    openDatabase(dbPath); // dimensions agree — consent is not consumed here
    expect(storedDimension()).toBe(1536);
    closeDatabase();

    fs.writeFileSync(configPath, JSON.stringify({ embedder: { provider: 'ollama' } }));
    written.length = 0;

    expect(storedDimension()).toBe(1536);
    expect(written.join('')).toContain('memesh reindex --vectors');
  });
});
