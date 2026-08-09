/**
 * memesh must open, store and recall when sqlite-vec is not there.
 *
 * `sqlite-vec` ships its engine as a per-platform loadable file through
 * `optionalDependencies`. On a platform it does not publish, npm installs the
 * JS wrapper, installs no binary, and says nothing. `openDatabase` loaded the
 * extension with no catch, so on those platforms `memesh remember` died with a
 * raw ERR_MODULE_NOT_FOUND stack trace — measured, by hiding
 * `sqlite-vec-darwin-arm64` and running the CLI: exit 1, unhandled, on both
 * `remember` and `recall`.
 *
 * That contradicted memesh's own design, which the README, `reindex()`'s error
 * text and the doctor rows all state: vector search SUPPLEMENTS FTS5 keyword
 * recall. A supplement must not be able to stop the database from opening.
 *
 * These tests drive the real `openDatabase` against a database whose
 * `entities_vec` table does not exist — the end state a failed extension load
 * produces — and check that the whole keyword path still works. The extension
 * load itself cannot be un-done inside this process (sqlite-vec is genuinely
 * installed on the machine running the suite), so the table is dropped after
 * open, which is the same condition every guarded call site actually reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { remember, recall, reindex } from '../../src/core/operations.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { hasVectorIndex } from '../../src/storage/vector-index.js';

describe('Feature: sqlite-vec is optional', () => {
  let dir: string;
  let savedMemeshDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-novec-'));
    savedMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try { closeDatabase(); } catch { /* none open */ }
    openDatabase(path.join(dir, 'test.db'));
    // The state a failed extension load leaves: no vector table.
    getDatabase().exec('DROP TABLE IF EXISTS entities_vec');
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('hasVectorIndex reports the absence — and the presence', () => {
    // The pin for every guard below. If this ever answered `true`
    // unconditionally the other tests would pass while checking nothing.
    expect(hasVectorIndex(getDatabase()), 'the dropped table was still reported present').toBe(false);
    getDatabase().exec('CREATE TABLE entities_vec (rowid INTEGER PRIMARY KEY, embedding BLOB)');
    expect(hasVectorIndex(getDatabase()), 'a present table was reported absent').toBe(true);
  });

  it('remember and recall still work through FTS5', () => {
    remember({ name: 'novec-alpha', type: 'note', observations: ['keyword search still works'], tags: ['t'] });
    const hits = recall({ query: 'keyword search' });
    expect(hits.map((e) => e.name)).toContain('novec-alpha');
  });

  it('archiving does not throw on the missing vector table', () => {
    // `archiveEntity` deletes the entity's vector. That DELETE used to sit in a
    // bare try/catch, which swallowed "no such table" together with every real
    // delete failure; it now asks first.
    remember({ name: 'novec-archive', type: 'note', observations: ['to be archived'], tags: ['t'] });
    const kg = new KnowledgeGraph(getDatabase());
    expect(kg.archiveEntity('novec-archive')).toMatchObject({ archived: true });
    // Read the column rather than trusting the return value — the point of the
    // test is that the write reached the database with the vector table gone.
    expect(
      getDatabase().prepare("SELECT status FROM entities WHERE name = 'novec-archive'").get(),
    ).toMatchObject({ status: 'archived' });
  });

  it('deleting an entity does not throw on the missing vector table', () => {
    remember({ name: 'novec-delete', type: 'note', observations: ['to be deleted'], tags: ['t'] });
    const kg = new KnowledgeGraph(getDatabase());
    expect(kg.deleteEntity('novec-delete')).toMatchObject({ deleted: true });
    expect(kg.getEntity('novec-delete')).toBeNull();
  });

  it('reindex refuses with a sentence that names the real problem', async () => {
    // Not a generic "no embedder" message: the embedder may be configured
    // perfectly well and there still be no index to write into. A user given
    // the wrong sentence goes and reconfigures a provider that was never the
    // problem.
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ llm: { provider: 'openai', apiKey: 'test-key' }, embedder: { provider: 'openai' } }),
    );
    await expect(reindex()).rejects.toThrow(/sqlite-vec is not loaded/);
  });
});
