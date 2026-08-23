/**
 * Three defects that shared one cause: FIVE things write entity text, and
 * only the vector index was left out of the accounting.
 *
 *   `clearEntityData` deleted the observations, the tags and the FTS text and
 *   left the VECTOR. Both callers — `--merge overwrite` on import and the
 *   memory tool's `rewriteObservations` — therefore left the entity
 *   semantically matching its OLD text. A memory edited to say the opposite
 *   of what it used to say still came back for the old query, with the new
 *   text attached.
 *
 *   `memesh task` went through `remember`, which SCHEDULES the embedding and
 *   returns. `remember` and `dream accept` await `flushPendingEmbeddings`;
 *   `task` did not, so the CLI process exited before the write and every
 *   task-state memory reached the graph with no vector.
 *
 *   `memesh doctor`'s Vector Index row read `pending_reindex`, a marker whose
 *   only writer is `reindex()`. Nothing else that creates a vector-less
 *   entity sets it — not the seven capture hooks, not import, not this fix.
 *   Measured on a real graph on 2026-08-24: 344 of 499 active memories had no
 *   vector, the marker was unset, and doctor reported the database healthy.
 *
 * The deliberate choice under all of it: a cleared entity's vector is
 * DELETED, not re-embedded. Embedding is a network call and these are
 * synchronous graph mutations. "No vector" is a state the system can already
 * see (`countMissingVectors`) and already knows how to fix (`memesh
 * reindex`); "wrong vector" is neither.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { countMissingVectors } from '../../src/core/operations.js';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

const require = createRequire(import.meta.url);

let dir: string;
let dbPath: string;
let saved: string | undefined;

/** Open with sqlite-vec loaded, the same two-gate dance `src/db.ts` does. */
function loadVec(db: InstanceType<typeof Database>): void {
  const sqliteVec = require('sqlite-vec');
  db.enableLoadExtension(true);
  try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stalevec-'));
  dbPath = path.join(dir, 'kg.db');
  saved = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(dbPath);
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (saved === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Give an entity a vector directly, standing in for the embedder.
 *
 * The width is read from the table `openDatabase` already created rather
 * than chosen here: a hand-picked width throws `Dimension mismatch`, and the
 * whole point of the fixture is that these rows are the real thing.
 */
function putVector(id: number): void {
  const db = getDatabase();
  loadVec(db);
  const dimension = Number(
    (db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as
      { value?: string } | undefined)?.value ?? 384,
  );
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[${dimension}])`);
  const v = new Float32Array(dimension).fill(1 / Math.sqrt(dimension));
  db.prepare('INSERT OR REPLACE INTO entities_vec (rowid, embedding) VALUES (?, ?)')
    .run(BigInt(id), Buffer.from(v.buffer));
}

function vectorCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM entities_vec').get() as { c: number }).c;
}

function idOf(name: string): number {
  return (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
}

describe('clearing an entity clears its vector', () => {
  it('removes the vector row whose text no longer exists', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('reversed-decision', 'note', { observations: ['we will use Postgres'] });
    const id = idOf('reversed-decision');
    putVector(id);
    // Fixture: there has to BE a vector for its removal to mean anything.
    expect(vectorCount(), 'fixture: no vector was stored').toBe(1);

    kg.clearEntityData('reversed-decision');

    expect(vectorCount(), 'the vector for deleted text survived').toBe(0);
  });

  it('leaves other entities\' vectors alone — the anti-vacuity half', () => {
    // `entities_vec` is ONE table for the whole database. A delete that took
    // the table, or forgot its WHERE, would pass the test above.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('edited', 'note', { observations: ['old text'] });
    kg.createEntity('untouched', 'note', { observations: ['other text'] });
    putVector(idOf('edited'));
    putVector(idOf('untouched'));
    expect(vectorCount()).toBe(2);

    kg.clearEntityData('edited');

    expect(vectorCount(), 'clearing one entity took another entity\'s vector').toBe(1);
    const survivor = (getDatabase()
      .prepare('SELECT rowid AS id FROM entities_vec')
      .get() as { id: number }).id;
    expect(survivor).toBe(idOf('untouched'));
  });

  it('works on a database that has no vector index at all', () => {
    // The keyword-only install: no sqlite-vec, no entities_vec. Clearing must
    // not throw looking for a table that was never created.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('plain', 'note', { observations: ['some text'] });
    expect(() => kg.clearEntityData('plain')).not.toThrow();
  });
});

describe('doctor measures the gap instead of reading a marker', () => {
  it('counts memories that have no vector while pending_reindex is unset', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('has-one', 'note', { observations: ['embedded text'] });
    kg.createEntity('has-none', 'note', { observations: ['unembedded text'] });
    putVector(idOf('has-one'));

    // The exact live shape: the marker is absent, so the old row said
    // nothing.
    const marker = getDatabase()
      .prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'")
      .get();
    expect(marker, 'fixture: a marker is set, so this proves nothing').toBeUndefined();

    expect(countMissingVectors(getDatabase()), 'the gap was not measured').toBe(1);
  });

  it('counts zero when every memory has a vector', () => {
    // Anti-vacuity: a counter hardwired to a positive number would make
    // doctor warn forever on a healthy graph.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('complete', 'note', { observations: ['embedded text'] });
    putVector(idOf('complete'));

    expect(countMissingVectors(getDatabase())).toBe(0);
    // …of a graph that actually holds something. A count over zero active
    // entities is 0 too, and would satisfy this without proving anything.
    expect(vectorCount(), 'fixture: the graph is empty').toBeGreaterThan(0);
  });

  it('does not owe a vector for an entity with no text to embed', () => {
    // An observation-less entity can never produce an embedding, so counting
    // it would leave the warning permanently on with no way to clear it.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('empty', 'note', { observations: [] });
    putVector(1); // create the table so the count runs at all
    getDatabase().prepare('DELETE FROM entities_vec').run();

    expect(countMissingVectors(getDatabase())).toBe(0);
  });
});
