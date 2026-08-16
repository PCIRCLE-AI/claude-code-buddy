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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each([['???'], ['@#$%'], ['🎉'], ['...']])(
    'does not embed %s, and returns nothing',
    async (query) => {
      const out = await recallEnhanced({ query });
      expect(out.entities).toEqual([]);
      // Honest metadata: the vector side never ran, so this is not "hybrid".
      expect(out.retrieval).toEqual({ mode: 'fts', degraded: false, truncated: false });
      // The gate is upstream of the embedder, so it is never asked.
      expect(embedText).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Thai sara-am (U+0E4D)', '\u0E4D'],
    ['combining acute (U+0301)', '\u0301'],
    ['Devanagari udatta (U+0951)', '\u0951'],
    ['Arabic damma (U+064F)', '\u064F'],
    ['kana voiced mark (U+3099)', '\u3099'],
  ])('treats a %s-only query as unsearchable', async (_label, query) => {
    // A term of combining marks alone is not a word. `unicode61
    // remove_diacritics 1` treats those marks as SEPARATORS for non-Latin
    // scripts, so the MATCH phrase built from one tokenises to nothing and can
    // never hit a row — but `tokenizeQuery` used to accept `[\p{L}\p{N}\p{M}]+`,
    // which matches a mark-only run. So `hasSearchableTerms` answered true,
    // `search()` returned 0, and the vector supplement ran anyway: the caller
    // got semantically-nearest memories for a query the keyword side had
    // correctly found nothing for.
    //
    // Measured before the fix, all five: hasSearchableTerms=true, search()->0.
    const out = await recallEnhanced({ query });
    expect(out.entities).toEqual([]);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('still keeps marks that belong to a word', async () => {
    // The other half. Requiring a leading letter or number must not drop the
    // marks that FOLLOW one — Thai tone marks, Devanagari matras, Arabic
    // harakat all live mid-word, and dropping them would break those languages
    // rather than fix them.
    const { tokenizeQuery } = await import('../src/storage/fts-index.js');

    // Spaced scripts keep their mark-bearing word whole.
    expect(tokenizeQuery('काम')).toEqual(['काम']); // Devanagari matra
    expect(tokenizeQuery('مُحَمَّد')).toEqual(['مُحَمَّد']); // Arabic harakat
    expect(tokenizeQuery('שָׁלוֹם')).toEqual(['שָׁלוֹם']); // Hebrew niqqud
    expect(tokenizeQuery('café'.normalize('NFD'))).toEqual(['café'.normalize('NFC')]);

    // Thai is a spaceless script, so it bigrams — and the tone mark rides along
    // on its base character rather than being dropped or split off alone.
    expect(tokenizeQuery('ก่อน')).toEqual(['ก่', 'อ', 'อน']);
    expect(tokenizeQuery('สำรอง')).toEqual(['สำ', 'ำร', 'รอ', 'อง']);

    // And nothing anywhere produces a term that is only marks.
    for (const word of ['ก่อน', 'สำรอง', 'काम', 'مُحَمَّد', 'שָׁלוֹם']) {
      for (const term of tokenizeQuery(word)) {
        expect(term, `${word} produced a mark-only term`).toMatch(/^[\p{L}\p{N}]/u);
      }
    }
  });

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
    expect(out.entities.map((e) => e.name)).toContain('auth-decision');
    expect(embedText).not.toHaveBeenCalled();
  });
});
