/**
 * `memesh reindex` reported success for work it had not done.
 *
 * `embedAndStore()` has six exits and exactly one of them leaves a vector in
 * the table, but it returned `void` from all six — so the only signal a caller
 * got was "it didn't throw". `reindex()` read that as success:
 *
 *     await embedAndStore(entity.id, text);
 *     embedded++;                              // every outcome, including none
 *
 * The consequences compound. `clearPendingReindexFlag()` then ran
 * unconditionally, erasing the one piece of state that told `memesh doctor` the
 * vector index still needed refilling; the CLI printed `✅ Reindex complete`
 * with a full `Embedded:` count and exited 0. A user whose provider had changed
 * dimension could run the command, be told it worked, and have an empty index
 * with nothing left to say so.
 *
 * The tests below drive the real `embedAndStore` — real dimension check, real
 * SQLite writes — with the OpenAI provider's `fetch` stubbed so the returned
 * vector's length is the thing under control. Nothing here asserts on a
 * counter alone: the flag and the vector rows are read back from the database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../src/db.js';
import { reindex } from '../src/core/operations.js';

/** Dimension of OpenAI's text-embedding-3-small, which the config below selects. */
const OPENAI_DIM = 1536;

describe('Feature: reindex reports what it actually wrote', () => {
  let dir: string;
  let dbPath: string;
  let savedMemeshDir: string | undefined;
  let savedKey: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Serve embeddings of a chosen length.
   *
   * `embedText` falls through to the local ONNX model when the API provider
   * returns null, and that would download ~90 MB in CI — so every stub here
   * answers OK. The dimension is the variable, not the availability.
   */
  function serveEmbeddings(lengthFor: (input: string) => number): void {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}'));
      const n = lengthFor(String(body.input ?? ''));
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: Array.from({ length: n }, () => 0.1) }] }),
      } as unknown as Response;
    });
  }

  /** An active entity with one observation. Raw SQL so no write path embeds it for us. */
  function seedEntity(name: string, observation: string, namespace = 'personal'): void {
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type, namespace) VALUES (?, 'note', ?)")
      .run(name, namespace);
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, observation);
  }

  /** The state a dimension migration leaves behind: index emptied, flag set. */
  function markReindexPending(): void {
    getDatabase()
      .prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('pending_reindex', ?)")
      .run(JSON.stringify({ from: 384, to: OPENAI_DIM, droppedAt: '2026-01-01T00:00:00.000Z' }));
  }

  function pendingReindexRow(): unknown {
    return getDatabase()
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'")
      .get();
  }

  function vectorCount(): number {
    return (getDatabase().prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-reindex-'));
    dbPath = path.join(dir, 'test.db');
    savedMemeshDir = process.env.MEMESH_DIR;
    savedKey = process.env.OPENAI_API_KEY;
    process.env.MEMESH_DIR = dir;
    // Both halves: `embedText` only passes a key through when the LLM provider
    // matches the embedding provider, and `embedWithOpenAI` falls back to the
    // environment. Without a key it returns null and ONNX takes over.
    process.env.OPENAI_API_KEY = 'test-key-not-used-over-the-network';
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        llm: { provider: 'openai', apiKey: 'test-key-not-used-over-the-network' },
        embedder: { provider: 'openai' },
      })
    );
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try { closeDatabase(); } catch { /* none open */ }
    openDatabase(dbPath);
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fetchSpy?.mockRestore();
    stderrSpy.mockRestore();
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a run that writes nothing is not reported as a run that embedded everything', async () => {
    // The provider answers with the WRONG dimension — a fallback firing, or a
    // provider switched without rebuilding the index. `embedAndStore` refuses
    // the write, on purpose, and returns normally. That return used to be
    // counted as an embed.
    seedEntity('alpha', 'first memory');
    seedEntity('beta', 'second memory');
    markReindexPending();
    serveEmbeddings(() => 8);

    const result = await reindex();

    expect(result.processed).toBe(2);
    expect(result.embedded, 'counted writes that never happened').toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.outcomes.dimension_mismatch).toBe(2);

    // The database agrees, which is the point — the counters are checked
    // against the end state rather than trusted.
    expect(vectorCount()).toBe(0);
    expect(result.missingVectors).toBe(2);

    // And the flag that tells `memesh doctor` there is still work to do
    // survives. Clearing it here is what made an empty index look healthy.
    expect(result.pendingReindexCleared).toBe(false);
    expect(pendingReindexRow(), 'the reindex-needed flag was erased').toBeDefined();
  });

  it('a run that writes everything clears the flag', async () => {
    // The guard must not become "never finish". A complete run is still a
    // complete run.
    seedEntity('alpha', 'first memory');
    seedEntity('beta', 'second memory');
    markReindexPending();
    serveEmbeddings(() => OPENAI_DIM);

    const result = await reindex();

    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.outcomes.stored).toBe(2);
    expect(vectorCount()).toBe(2);
    expect(result.missingVectors).toBe(0);
    expect(result.pendingReindexCleared).toBe(true);
    expect(pendingReindexRow()).toBeUndefined();
  });

  it('a partial run keeps the flag', async () => {
    // Half the corpus embedded is not the same as all of it, and it is the
    // case most likely to happen for real: a provider that rate-limits or
    // drops connections part way through a long run.
    seedEntity('alpha', 'first memory');
    seedEntity('beta', 'second memory');
    markReindexPending();
    serveEmbeddings((input) => (input.includes('first') ? OPENAI_DIM : 8));

    const result = await reindex();

    expect(result.embedded).toBe(1);
    expect(result.outcomes.dimension_mismatch).toBe(1);
    expect(vectorCount()).toBe(1);
    expect(result.missingVectors).toBe(1);
    expect(result.pendingReindexCleared).toBe(false);
    expect(pendingReindexRow()).toBeDefined();
  });

  it('an entity with nothing to embed does not hold the flag open forever', async () => {
    // The mirror-image failure. "Every active entity must have a vector" is
    // too strong: an entity whose observations are all whitespace can never
    // produce one, so requiring it would leave `pending_reindex` set for the
    // life of the database and make `memesh doctor` nag about work nobody can
    // do. `countMissingVectors` excludes those, and this pins that exclusion.
    seedEntity('alpha', 'first memory');
    seedEntity('blank', '   ');
    markReindexPending();
    serveEmbeddings((input) => (input.trim() === '' ? 8 : OPENAI_DIM));

    const result = await reindex();

    expect(vectorCount(), 'the blank entity should not have a vector').toBe(1);
    expect(result.missingVectors, 'a blank entity was counted as missing').toBe(0);
    expect(result.pendingReindexCleared).toBe(true);
    expect(pendingReindexRow()).toBeUndefined();
  });

  it('a namespace run that succeeds is not reported as a failure', async () => {
    // The mirror of the defect this file exists for, and the one a fix like it
    // invites: `pending_reindex` describes the whole database, so the count
    // that decides it must be unscoped — but the verdict the CALLER is given,
    // and the exit code built on it, must be about what the caller asked for.
    // Sharing one number makes `memesh reindex --namespace personal` report
    // failure for a run in which everything it was asked to do worked.
    seedEntity('mine', 'first memory', 'personal');
    seedEntity('theirs', 'someone else', 'team');
    markReindexPending();
    serveEmbeddings(() => OPENAI_DIM);

    const result = await reindex({ namespace: 'personal' });

    expect(result.processed, 'the other namespace was reindexed too').toBe(1);
    expect(result.embedded).toBe(1);
    // Scoped: this run did everything it was asked.
    expect(result.missingVectors, 'a complete run reported as incomplete').toBe(0);
    // Unscoped: `team` still has none, so the database-wide flag must stay.
    expect(result.missingVectorsDatabaseWide).toBe(1);
    expect(result.pendingReindexCleared).toBe(false);
    expect(pendingReindexRow()).toBeDefined();
  });

  it('an unscoped run still answers for the whole database', async () => {
    // The guard must not become "always report success". With no namespace
    // asked for, the two counts are the same number and a genuine shortfall
    // still shows.
    seedEntity('mine', 'first memory', 'personal');
    seedEntity('theirs', 'someone else', 'team');
    markReindexPending();
    serveEmbeddings((input) => (input.includes('first') ? OPENAI_DIM : 8));

    const result = await reindex();

    expect(result.missingVectors).toBe(1);
    expect(result.missingVectorsDatabaseWide).toBe(1);
    expect(result.pendingReindexCleared).toBe(false);
  });

  it('a run that regenerated nothing is not complete just because the old vectors survive', async () => {
    // The end-state check answers "does every entity have A vector". The user
    // asked "regenerate the vectors". Those are different questions, and when
    // the index is already full the first one hides the answer to the second:
    // every `embedAndStore` refuses the write, the pre-existing rows stay put,
    // `countMissingVectors` returns 0, and a run that changed nothing reports
    // itself complete and exits 0. Stale vectors are exactly the case a user
    // runs this command to fix — a provider switch — so the masking happens
    // precisely when the command matters.
    seedEntity('alpha', 'first memory');
    seedEntity('beta', 'second memory');
    serveEmbeddings(() => OPENAI_DIM);
    await reindex();
    expect(vectorCount(), 'setup: the index should start full').toBe(2);

    // Now the provider answers at the wrong width — a fallback firing, a model
    // swapped under the same provider name.
    fetchSpy.mockRestore();
    serveEmbeddings(() => 8);
    markReindexPending();

    const result = await reindex();

    expect(result.embedded).toBe(0);
    expect(result.outcomes.dimension_mismatch).toBe(2);
    // The old rows are still there, so the end-state check is satisfied...
    expect(vectorCount()).toBe(2);
    expect(result.missingVectors).toBe(0);
    // ...and the verdict must therefore come from the outcomes as well.
    expect(result.failed, 'a run that wrote nothing reported no failures').toBe(2);
    expect(result.pendingReindexCleared).toBe(false);
    expect(pendingReindexRow(), 'the reindex-needed flag was erased').toBeDefined();
  });

  it('counts a vanished entity separately from a failed embed', async () => {
    // `reindex` selects ids, then re-reads each entity by name. An entity
    // deleted in between is not an embedding failure, and lumping the two
    // together is how the old `skipped` counter hid the failures inside the
    // benign case.
    seedEntity('alpha', 'first memory');
    seedEntity('doomed', 'about to be deleted');
    serveEmbeddings(() => OPENAI_DIM);

    const db = getDatabase();
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes("status = 'active'") && sql.includes('ORDER BY id')) {
        const realAll = stmt.all.bind(stmt);
        // Hand back the list, then delete one of them — the race, made exact.
        return Object.assign(stmt, {
          all: (...args: unknown[]) => {
            const rows = realAll(...args);
            realPrepare("DELETE FROM entities WHERE name = 'doomed'").run();
            return rows;
          },
        });
      }
      return stmt;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const result = await reindex();
    spy.mockRestore();

    expect(result.processed).toBe(2);
    expect(result.outcomes.entity_missing).toBe(1);
    expect(result.outcomes.stored).toBe(1);
    // The deleted entity is gone from `entities` too, so it is not owed a vector.
    expect(result.missingVectors).toBe(0);
  });
});
