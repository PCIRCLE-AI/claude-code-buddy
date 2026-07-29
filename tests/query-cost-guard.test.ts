import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { useTestDatabase } from './helpers/db-fixture.js';

/**
 * The document-frequency guard on query terms.
 *
 * Terms are OR-ed, so the cost of a search is the union of their postings and a
 * single ubiquitous word dominates it. Measured with a 12-term query, including
 * the cost of the vocabulary lookup itself: 0.82ms → 0.20ms at 1,000 rows,
 * 7.82ms → 1.05ms at 10,000, and 80.15ms → 8.57ms at 100,000.
 *
 * The claim that makes it safe is that the dropped terms are ones BM25 already
 * scores near zero — a word in every row has no inverse document frequency — so
 * this removes work rather than signal. On LongMemEval, R@5 is unchanged at
 * cut-offs of 90%, 70% and 50%, and falls at 30%.
 *
 * These cases pin the edges, which is where a frequency filter goes wrong:
 * emptying a query made of common words, and applying corpus statistics to a
 * corpus too small to have any.
 */
describe('Feature: query cost guard', () => {
  useTestDatabase('memesh-df-guard-');

  let kg: KnowledgeGraph;

  beforeEach(() => {
    kg = new KnowledgeGraph(getDatabase());
  });

  /** Enough rows to clear MIN_ROWS_FOR_DF_GUARD, all sharing a common word. */
  function seedCorpus(): void {
    const db = getDatabase();
    db.transaction(() => {
      for (let i = 0; i < 40; i++) {
        kg.createEntity(`standup-${String(i).padStart(3, '0')}`, 'note', {
          observations: [`the service was checked on day ${i} and nothing was blocked`],
        });
      }
    })();
    kg.createEntity('kubernetes-decision', 'decision', {
      observations: ['the service now runs on kubernetes with a rolling deploy'],
    });
  }

  it('still finds the memory when the query mixes a rare word with ubiquitous ones', () => {
    seedCorpus();
    // "the" and "service" are in every row and carry no signal; "kubernetes" is
    // in one. Dropping the first two is what makes this cheap, and it must not
    // change the answer.
    const names = kg.search('what does the service run on with kubernetes').map((e) => e.name);
    expect(names[0]).toBe('kubernetes-decision');
  });

  it('does not empty a query made entirely of ubiquitous words', () => {
    seedCorpus();
    // Every term here is in every row. Dropping them all would return nothing,
    // which is worse than a broad match — the rarest term is kept instead.
    const results = kg.search('the service');
    expect(results.length).toBeGreaterThan(0);
  });

  it('leaves a single-term query alone', () => {
    seedCorpus();
    // Nothing to trade off: there is no cheaper term to fall back to.
    expect(kg.search('service').length).toBeGreaterThan(0);
  });

  it('does not apply corpus statistics to a corpus too small to have any', () => {
    // Four memories, and "deployment" is in three of them — 75%, far over the
    // 50% cut-off. On a corpus this size that is not a stopword, it is the
    // subject. Scanning four rows costs nothing, so the guard stays out.
    kg.createEntity('deploy-a', 'note', { observations: ['deployment pipeline caching'] });
    kg.createEntity('deploy-b', 'note', { observations: ['deployment rollback plan'] });
    kg.createEntity('deploy-c', 'note', { observations: ['deployment window is Tuesday'] });
    kg.createEntity('unrelated', 'note', { observations: ['lunch order for Friday'] });

    const names = kg.search('deployment window').map((e) => e.name);
    expect(names).toContain('deploy-c');
    expect(names).toContain('deploy-a');
  });

  it('keeps working when fts_vocab is missing', () => {
    // Databases created by an older version, or by a caller that built the
    // schema by hand, have no vocabulary view. The guard is an optimisation and
    // must degrade to searching every term rather than failing the query.
    seedCorpus();
    getDatabase().exec('DROP TABLE fts_vocab');

    const names = kg.search('what does the service run on with kubernetes').map((e) => e.name);
    expect(names).toContain('kubernetes-decision');
  });
});
