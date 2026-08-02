/**
 * Two pre-existing defects a review of the v4.2.11 branch surfaced. Neither was
 * introduced by that work; both were found while auditing it, and both are the
 * same shape as the rest of the release — a failure that leaves the system
 * reporting normally.
 *
 *   1. `openDatabase` published its module singleton BEFORE finishing
 *      initialisation, so a throw part-way left every later caller in the
 *      process holding a handle with no schema, no migrations and no
 *      sqlite-vec.
 *
 *   2. `search({includeArchived:true})` matched NFC-normalised terms against
 *      raw storage, so a memory stored decomposed was findable while active and
 *      unfindable the moment it was archived.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';

const require = createRequire(import.meta.url);

describe('Feature: a failed open does not poison the process', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-openfail-'));
    dbPath = path.join(dir, 'test.db');
    try { closeDatabase(); } catch { /* none open */ }
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed open leaves nothing behind, and the retry is fully initialised', () => {
    // The reproduction, in-process and deterministic. Before the fix the
    // singleton was assigned before initialisation finished, so `if (db) return
    // db` handed the half-built handle to every later caller — measured with a
    // peer holding BEGIN EXCLUSIVE as the retry throwing "no such table:
    // memesh_metadata" with sqlite-vec never loaded.
    //
    // Worth stating why it is not merely untidy: the migration machinery has a
    // careful transient-error backoff precisely so a held lock is retried
    // later. A poisoned singleton means the retry never happens, and writes go
    // through the current segmentation rules into an index that was never
    // migrated — the contentless-FTS delete mismatch this release exists to
    // remove.
    //
    // A read-only file rather than that held lock: it fails in ~2ms at exactly
    // the same stage — `new Database()` SUCCEEDS and `db.exec(SCHEMA_SQL)`
    // throws — where waiting out SQLite's 5s busy timeout costs five seconds
    // per case for the same coverage.
    const Database = require('better-sqlite3');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE IF NOT EXISTS placeholder (x)');
    seed.close();
    fs.chmodSync(dbPath, 0o444);

    expect(() => openDatabase(dbPath)).toThrow(/readonly|read-only/i);

    fs.chmodSync(dbPath, 0o644);

    // The retry gets a REAL database, not the wreck of the first attempt.
    const db = openDatabase(dbPath);
    const marker = db
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version'")
      .get() as { value: string } | undefined;
    expect(marker?.value, 'migrations did not run on the retry').toBeDefined();
    // sqlite-vec is loaded by the same initialisation the first attempt aborted.
    expect(() => db.prepare('SELECT count(*) FROM entities_vec').get()).not.toThrow();
    // ...and it actually works.
    const kg = new KnowledgeGraph(db);
    kg.createEntity('after-retry', 'note', { observations: ['it works'] });
    expect(kg.search('works').map((e) => e.name)).toContain('after-retry');
  });

  it('closes the handle it is abandoning', () => {
    // Otherwise a process that retries in a loop leaks a file descriptor and a
    // WAL reader per attempt.
    const Database = require('better-sqlite3');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE IF NOT EXISTS placeholder (x)');
    seed.close();
    fs.chmodSync(dbPath, 0o444);
    expect(() => openDatabase(dbPath)).toThrow();
    fs.chmodSync(dbPath, 0o644);

    // If the abandoned handle were still open, this exclusive lock would be
    // refused.
    const after = new Database(dbPath);
    expect(() => after.exec('BEGIN EXCLUSIVE')).not.toThrow();
    after.exec('COMMIT');
    after.close();
  });
});

describe('Feature: archived search answers the same question as active search', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-archnfc-'));
    try { closeDatabase(); } catch { /* none open */ }
    openDatabase(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a decomposed memory after it is archived', () => {
    // Archived rows leave FTS5, so that branch matches with LIKE against the
    // RAW columns — while its terms come from `tokenizeQuery`, which
    // NFC-normalises. So the two halves of one `search()` call disagreed about
    // normalisation, and the disagreement only showed up after archiving.
    //
    // NFD is not exotic: macOS filesystem APIs, Finder, and several Korean and
    // Vietnamese IMEs emit it, and the hooks capture file paths.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('nfd-note', 'note', { observations: ['dữ liệu'.normalize('NFD')] });
    kg.createEntity('nfc-note', 'note', { observations: ['dữ liệu'.normalize('NFC')] });

    // Both reachable while active — the FTS side already normalised both ends.
    const active = kg.search('dữ liệu').map((e) => e.name);
    expect(active).toContain('nfd-note');
    expect(active).toContain('nfc-note');

    kg.archiveEntity('nfd-note');
    kg.archiveEntity('nfc-note');

    const archived = kg.search('dữ liệu', { includeArchived: true }).map((e) => e.name);
    expect(archived, 'the NFC twin regressed').toContain('nfc-note');
    expect(archived, 'decomposed text is unfindable once archived').toContain('nfd-note');
  });

  it('finds an archived memory by a decomposed QUERY too', () => {
    // The other direction: stored composed, searched decomposed. Both sides
    // normalise, so which spelling the user types must not matter.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('stored-nfc', 'note', { observations: ['dữ liệu'.normalize('NFC')] });
    kg.archiveEntity('stored-nfc');

    expect(
      kg.search('dữ liệu'.normalize('NFD'), { includeArchived: true }).map((e) => e.name)
    ).toContain('stored-nfc');
  });

  it('still escapes LIKE metacharacters after normalising', () => {
    // The normalising wrapper must not undo the escaping: `%` is a wildcard in
    // this branch (unlike the FTS branch, where the tokeniser discards it), so
    // an unescaped `a%` would enumerate archived rows far past what was asked.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('literal-pct', 'note', { observations: ['growth of 50% year on year'] });
    kg.createEntity('unrelated', 'note', { observations: ['nothing to do with it'] });
    kg.archiveEntity('literal-pct');
    kg.archiveEntity('unrelated');

    const hits = kg.search('50%', { includeArchived: true }).map((e) => e.name);
    expect(hits).toContain('literal-pct');
    expect(hits).not.toContain('unrelated');
  });
});
