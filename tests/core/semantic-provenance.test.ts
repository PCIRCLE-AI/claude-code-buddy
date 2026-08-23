/**
 * `match.source === 'semantic'` had zero effective coverage on every machine.
 *
 * Two tests claimed it. Both were structural no-ops:
 *
 *   `tests/recall-provenance.test.ts:58` asserts inside
 *       `for (const e of nonsense) { … }`
 *   and `nonsense` is the vector supplement's output. On a throwaway HOME no
 *   embedder is configured, `isEmbeddingAvailable` returns false, the
 *   supplement never runs, the array is empty, and the loop body never
 *   executes. The test passes by asserting nothing.
 *
 *   `tests/cli/recall-presentation.test.ts:75` early-returns on
 *       `if (r.stdout.includes('No results found.')) return;`
 *   which is exactly what that same machine produces.
 *
 * Both are honest about the branch they take — each has a comment saying an
 * absent embedder is an acceptable outcome — and both are therefore incapable
 * of failing. Nothing anywhere asserted that a vector-surfaced row is LABELLED
 * semantic, which is the whole point of `Entity.match`: a semantic-only hit
 * cannot be certified relevant, so every consumer has to be told HOW the row
 * was found rather than shown geometry's best guess as a match.
 *
 * The seam here is `embedText` alone — the one network call. `vectorSearch`,
 * `getStoredEmbeddingDimension`, the merge and the labelling are all the real
 * implementations, and the vectors in `entities_vec` are real rows at the
 * database's real width.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** The stubbed query vector, set per test before `recallEnhanced` runs. */
let queryVector: Float32Array | null = null;

vi.mock('../../src/core/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/embedder.js')>();
  return {
    ...actual,
    // Only the network call is replaced. Everything the assertions depend on
    // — the vec0 KNN search, the distance-to-relevance conversion, the
    // width check — stays the real code.
    embedText: async () => queryVector,
  };
});

let dir: string;
let dbPath: string;
const saved: Record<string, string | undefined> = {};

/** Unit vector that points at one axis, so two of them can be far apart. */
function axisVector(dimension: number, axis: number): Float32Array {
  const v = new Float32Array(dimension);
  v[axis % dimension] = 1;
  return v;
}

/**
 * A unit vector NEAR an axis but not on it.
 *
 * Deliberately not identical to the stored one. An exact match scores
 * `relevance === 1`, and the untested assertion this file replaces required
 * `relevance < 1` — a condition a perfect match legitimately breaks. A
 * realistic hit sits strictly inside the interval, which is what the range
 * assertion is actually about.
 */
function nearAxisVector(dimension: number, axis: number): Float32Array {
  const v = new Float32Array(dimension);
  v[axis % dimension] = 0.9;
  v[(axis + 1) % dimension] = Math.sqrt(1 - 0.81);
  return v;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-semprov-'));
  dbPath = path.join(dir, 'kg.db');
  for (const k of ['MEMESH_DIR', 'MEMESH_DB_PATH', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.MEMESH_DIR = dir;
  // A configured embedder, so `isEmbeddingAvailable` is true and the
  // supplement actually runs. Nothing reaches Ollama: `embedText` is stubbed.
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ embedder: { provider: 'ollama', model: 'nomic-embed-text' } }),
  );
  queryVector = null;
});

afterEach(async () => {
  const { closeDatabase } = await import('../../src/db.js');
  try { closeDatabase(); } catch { /* already closed */ }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Give an entity a real vector row at the database's own width. */
async function putVector(name: string, axis: number): Promise<number> {
  const { getDatabase } = await import('../../src/db.js');
  const db = getDatabase();
  const sqliteVec = require('sqlite-vec');
  db.enableLoadExtension(true);
  try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
  const dimension = Number(
    (db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as
      { value?: string } | undefined)?.value ?? 384,
  );
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[${dimension}])`);
  const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
  const v = axisVector(dimension, axis);
  db.prepare('INSERT OR REPLACE INTO entities_vec (rowid, embedding) VALUES (?, ?)')
    .run(BigInt(id), Buffer.from(v.buffer));
  return dimension;
}

describe('a vector-surfaced row says it was found by meaning', () => {
  it('labels a semantic-only hit `semantic`, with a relevance strictly between 0 and 1', async () => {
    const { openDatabase, getDatabase } = await import('../../src/db.js');
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const { recallEnhanced } = await import('../../src/core/operations.js');

    openDatabase(dbPath);
    new KnowledgeGraph(getDatabase()).createEntity('the-caching-decision', 'decision', {
      observations: ['we keep the parser split across two files'],
    });
    const dimension = await putVector('the-caching-decision', 0);
    queryVector = nearAxisVector(dimension, 0);

    // A query with no lexical overlap at all, so the FTS side contributes
    // nothing and every row in the result came from the vector index.
    const { entities, retrieval } = await recallEnhanced({ query: 'xyzzyplughfrobozz quux' });

    expect(entities, 'fixture: the vector supplement surfaced nothing — the seam is not wired')
      .toHaveLength(1);
    expect(entities[0].name).toBe('the-caching-decision');
    expect(entities[0].match?.source, 'a vector-surfaced row was not labelled semantic')
      .toBe('semantic');
    // Strictly inside (0, 1). The vector is near the stored one but not
    // identical; an EXACT match scores 1, which is why the fixture does not
    // use one — the assertion this file replaces required `< 1` and would
    // have failed the first time it ever ran against a perfect hit.
    expect(entities[0].match!.relevance).toBeGreaterThan(0);
    expect(entities[0].match!.relevance).toBeLessThan(1);
    expect(retrieval.mode, 'the envelope did not report the vector side as used').toBe('hybrid');
  });

  it('labels a keyword hit `keyword`, even when a vector exists for it', async () => {
    // The anti-vacuity half. A labeller hardwired to 'semantic' would satisfy
    // the test above and mislabel every ordinary recall — which is worse than
    // no label, because the CLI prints "may be unrelated" for a semantic hit.
    const { openDatabase, getDatabase } = await import('../../src/db.js');
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const { recallEnhanced } = await import('../../src/core/operations.js');

    openDatabase(dbPath);
    new KnowledgeGraph(getDatabase()).createEntity('the-parser-decision', 'decision', {
      observations: ['we keep the parser split across two files'],
    });
    const dimension = await putVector('the-parser-decision', 0);
    queryVector = axisVector(dimension, 0);

    const { entities } = await recallEnhanced({ query: 'parser' });

    expect(entities, 'fixture: the keyword search found nothing').toHaveLength(1);
    expect(entities[0].match?.source, 'a keyword match was labelled semantic').toBe('keyword');
  });

  it('does not surface a row whose vector points elsewhere', async () => {
    // Without this, a supplement that returned everything regardless of
    // distance would satisfy the first test.
    const { openDatabase, getDatabase } = await import('../../src/db.js');
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const { recallEnhanced } = await import('../../src/core/operations.js');

    openDatabase(dbPath);
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('near-the-query', 'decision', { observations: ['alpha content'] });
    kg.createEntity('far-from-the-query', 'decision', { observations: ['beta content'] });
    const dimension = await putVector('near-the-query', 0);
    await putVector('far-from-the-query', 1);   // orthogonal — the maximum distance
    queryVector = axisVector(dimension, 0);

    const { entities } = await recallEnhanced({ query: 'xyzzyplughfrobozz quux' });

    expect(entities.map((e) => e.name), 'an orthogonal vector was returned as a match')
      .toEqual(['near-the-query']);
  });
});
