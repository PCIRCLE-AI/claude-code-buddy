/**
 * "Nothing matched" must not become "here is what matched" — on the vector
 * path too.
 *
 * `KnowledgeGraph.search()` correctly returns `[]` for a query that is
 * non-empty but tokenises to nothing (`"???"`, `"@#$%"`, a lone emoji), and
 * `tests/recall-relevance.test.ts` covers that. But `recallEnhanced()` sits one
 * layer above it and used to gate the vector supplement on nothing more than a
 * truthy string — so with embeddings enabled the caller still received up to
 * `limit` semantically-nearest memories for a query that matched nothing.
 *
 * That is the exact confusion the behaviour change was made to remove, on the
 * one path the change did not cover. Reverting the gate to `if (args.query)`
 * left all 1303 tests green.
 *
 * These assert on whether the EMBEDDER IS REACHED rather than on returned rows:
 * `supplementWithVectors` is module-private and bails at
 * `isEmbeddingAvailable()`, so a test that merely checked for an empty result
 * would pass in any environment without embeddings configured — which is to say
 * it would pass for the wrong reason, everywhere, forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const embedText = vi.fn(async (_text: string) => new Float32Array(384));
const isEmbeddingAvailable = vi.fn(() => true);
const vectorSearch = vi.fn(
  (_vec: Float32Array, _k: number) => [] as Array<{ id: number; distance: number }>
);

vi.mock('../src/core/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/embedder.js')>();
  return {
    ...actual,
    isEmbeddingAvailable: () => isEmbeddingAvailable(),
    embedText: (t: string) => embedText(t),
    vectorSearch: (v: Float32Array, k: number) => vectorSearch(v, k),
  };
});

describe('Feature: an unsearchable query reaches no vector supplement', () => {
  let dir: string;
  let openDatabase: typeof import('../src/db.js').openDatabase;
  let closeDatabase: typeof import('../src/db.js').closeDatabase;
  let getDatabase: typeof import('../src/db.js').getDatabase;
  let recallEnhanced: typeof import('../src/core/operations.js').recallEnhanced;
  let KnowledgeGraph: typeof import('../src/knowledge-graph.js').KnowledgeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-vecgate-'));
    ({ openDatabase, closeDatabase, getDatabase } = await import('../src/db.js'));
    ({ recallEnhanced } = await import('../src/core/operations.js'));
    ({ KnowledgeGraph } = await import('../src/knowledge-graph.js'));

    try { closeDatabase(); } catch { /* none open */ }
    openDatabase(path.join(dir, 'test.db'));
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('auth-decision', 'decision', { observations: ['Use OAuth 2.0 with PKCE'] });

    embedText.mockClear();
    isEmbeddingAvailable.mockClear();
    vectorSearch.mockClear();
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([['???'], ['@#$%'], ['🎉'], ['...']])(
    'does not embed %s, and returns nothing',
    async (query) => {
      const out = await recallEnhanced({ query });
      expect(out).toEqual([]);
      // The gate is upstream of the embedder, so it is never asked.
      expect(embedText).not.toHaveBeenCalled();
    }
  );

  it('DOES embed a query that has real terms', async () => {
    // The contrast that gives the cases above their meaning. Without it, a gate
    // hard-wired to `false` would satisfy every assertion here.
    await recallEnhanced({ query: 'oauth' });
    expect(embedText).toHaveBeenCalledWith('oauth');
  });

  it('an EMPTY query still lists recent memories without embedding', async () => {
    // `""` means "show me what you have" and is served by search()'s recent
    // branch — which is why the gate tests for searchable TERMS rather than for
    // emptiness. Getting this backwards would break the no-argument recall the
    // SessionStart hook depends on.
    const out = await recallEnhanced({});
    expect(out.map((e) => e.name)).toContain('auth-decision');
    expect(embedText).not.toHaveBeenCalled();
  });
});
