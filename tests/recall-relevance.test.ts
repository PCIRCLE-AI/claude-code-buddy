import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { recall } from '../src/core/operations.js';
import { useTestDatabase } from './helpers/db-fixture.js';
import Database from 'better-sqlite3';

/**
 * Regression suite for the recall-quality class the existing tests structurally
 * could not catch.
 *
 * The pre-existing `search()` tests always queried with the *exact literal
 * string that was stored* (`observations: ['shared query terms']` then
 * `search('shared query terms')`), so FTS5's implicit AND could never fail and
 * relevance ordering was never exercised. These cases pin the two properties a
 * memory layer actually has to hold:
 *
 *   1. A question phrased in the user's own words finds the memory, even though
 *      the words are scattered through it and mixed with words that appear
 *      nowhere.
 *   2. The most RELEVANT memory wins, not the most RECENT one — including when
 *      more memories match than `limit`, i.e. when the SQL has to choose what
 *      survives to the scorer.
 */
describe('Feature: recall relevance', () => {
  useTestDatabase('memesh-recall-rel-');

  let db: Database.Database;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    db = getDatabase();
    kg = new KnowledgeGraph(db);
  });

  describe('a natural-language question finds the memory', () => {
    beforeEach(() => {
      kg.createEntity('grad-record', 'note', {
        observations: [
          'I finished college in 2011. The degree was in Business Administration and I graduated with honours.',
        ],
      });
      kg.createEntity('pasta-recipe', 'note', {
        observations: ['Tomato pasta: garlic, basil, olive oil, simmer for twenty minutes.'],
      });
      // Matches ONE of the three terms in the ranking test below. Without a
      // partial matcher in the fixture, only one row is ever returned and
      // "ranks first" is true no matter what the ordering does.
      kg.createEntity('college-trip', 'note', {
        observations: ['Drove past my old college on the way to the airport.'],
      });
    });

    it('finds the memory when the query words are scattered through it', () => {
      // "What"/"did"/"I"/"with" never appear together with the rest in the
      // stored text — under AND semantics this returns nothing.
      const results = kg.search('What degree did I graduate with?');
      expect(results.map((e) => e.name)).toContain('grad-record');
    });

    it('ranks the memory that matches more query terms first', () => {
      const results = kg.search('degree graduated college');
      const names = results.map((e) => e.name);
      // Both memories match; grad-record matches all three terms and
      // college-trip only one, so BM25 must put grad-record first.
      expect(names).toContain('grad-record');
      expect(names).toContain('college-trip');
      expect(names.indexOf('grad-record')).toBeLessThan(names.indexOf('college-trip'));
      // OR widens the net; it must not drag in a memory sharing no term.
      expect(names).not.toContain('pasta-recipe');
    });

    it('still returns nothing when no query term appears anywhere', () => {
      // OR must not turn "no match" into "everything".
      expect(kg.search('kubernetes helm chart')).toHaveLength(0);
    });
  });

  describe('relevance beats recency when more memories match than the limit', () => {
    beforeEach(() => {
      // The genuinely relevant memory is written FIRST, so it holds the lowest
      // id. Every newer memory mentions "jwt" once, in passing.
      kg.createEntity('jwt-rotation-decision', 'decision', {
        observations: [
          'We rotate the jwt signing key every 90 days. jwt refresh tokens live 30 days. Never log a jwt.',
        ],
      });
      for (let i = 0; i < 40; i++) {
        kg.createEntity(`standup-${String(i).padStart(3, '0')}`, 'note', {
          observations: [`Standup ${i}: fixed a flaky test, touched the jwt middleware import order.`],
        });
      }
    });

    it('ranks the most relevant memory first, not the newest', () => {
      const results = kg.search('jwt', { limit: 20 });
      const names = results.map((e) => e.name);
      // Two separate failures, two separate messages: `toContain` fails when
      // LIMIT dropped it before scoring, `[0]` fails when the ordering is wrong.
      expect(names).toContain('jwt-rotation-decision');
      expect(names[0]).toBe('jwt-rotation-decision');
    });

    it('the ordering survives recall()’s scoring pass', () => {
      // Guards the search() → rankEntities() handoff: the BM25 winner must
      // still be first after scoring. NOTE this case does NOT pin the
      // graded-relevance fix — with a flat relevance map every other factor
      // ties and the tie-break preserves order, so it stays green either way.
      // The case below is the one that pins it; do not delete it as redundant.
      const results = recall({ query: 'jwt', limit: 20 });
      expect(results[0].name).toBe('jwt-rotation-decision');
    });

    it('relevance outweighs a much weaker match that has been accessed far more often', () => {
      // The case a fresh database cannot expose. With every other factor equal,
      // a flat relevance value still leaves the BM25 order intact through the
      // tie-break, so flattening looks harmless. Give a far-down match a large
      // access_count and the 0.18 frequency factor decides the winner — unless
      // relevance is graded, in which case the 0.30 relevance gap between rank
      // 1 and rank 19 outweighs it.
      //
      // Pick the victim from the page the query actually returns, at runtime.
      // The 40 standups tie on BM25 and only 19 of them survive `limit: 20`;
      // which 19 depends on FTS5 doclist iteration order, which is unspecified.
      // Hard-coding a name would make this vacuous the day that order shifts.
      // The LAST row is used so the relevance gap against rank 1 is widest.
      const returned = kg.search('jwt', { limit: 20 }).map((e) => e.name);
      const victim = returned[returned.length - 1];
      expect(victim).not.toBe('jwt-rotation-decision');
      db.prepare('UPDATE entities SET access_count = 500 WHERE name = ?').run(victim);

      const results = recall({ query: 'jwt', limit: 20 });
      expect(results[0].name).toBe('jwt-rotation-decision');
    });
  });

  describe('punctuation inside a word does not become a phrase requirement', () => {
    it('matches a memory that spells the word without the apostrophe', () => {
      kg.createEntity('kitchen-tips', 'note', {
        observations: ['Wipe the kitchen counters before the oil dries.'],
      });
      // Quoting the raw whitespace token makes "kitchen's" the PHRASE
      // kitchen + s, which only matches those tokens adjacent and in order.
      expect(kg.search("kitchen's").map((e) => e.name)).toContain('kitchen-tips');
    });

    it('matches either half of a hyphenated query word', () => {
      kg.createEntity('garden-log', 'note', {
        observations: ['Spent Sunday on gardening: repotted the tomatoes.'],
      });
      expect(kg.search('gardening-related activity').map((e) => e.name)).toContain('garden-log');
    });

    it('keeps combining marks attached to their base character', () => {
      // A decomposed (NFD) query is ordinary input — macOS filesystem APIs and
      // several IMEs emit it. If the split treated combining marks as
      // separators, "naïve" would tokenise as ["nai","ve"] and match nothing,
      // while the visually identical NFC form matched. Same word, same screen,
      // different result.
      kg.createEntity('naive-note', 'note', {
        observations: ['a naïve approach to cache invalidation'],
      });

      const nfc = 'naïve'.normalize('NFC');
      const nfd = 'naïve'.normalize('NFD');
      expect(nfc).not.toBe(nfd); // the two encodings really do differ

      expect(kg.search(nfc).map((e) => e.name)).toContain('naive-note');
      expect(kg.search(nfd).map((e) => e.name)).toContain('naive-note');
    });

    it('does not shatter scripts whose marks have no precomposed form', () => {
      // NFC cannot compose Arabic harakat or Hebrew niqqud, so normalisation
      // alone would not save these — the \p{M} class is what keeps the word
      // whole. Without it "مَرحَبا" tokenises to three single letters and ORs
      // together the most common letters in the script.
      const arabic = 'مَرحَبا';
      kg.createEntity('arabic-note', 'note', { observations: [`${arabic} everyone`] });
      kg.createEntity('other-note', 'note', { observations: ['unrelated english text'] });

      const names = kg.search(arabic).map((e) => e.name);
      expect(names).toContain('arabic-note');
      expect(names).not.toContain('other-note');
    });

    it('does not erase non-Latin queries', () => {
      // Splitting on [^a-zA-Z0-9] would reduce this query to nothing and
      // silently fall through to the recent-list path, which looks like a
      // successful search returning wrong rows. \p{L} keeps the token.
      kg.createEntity('cjk-note', 'note', { observations: ['資料庫 遷移 備份'] });
      kg.createEntity('other-note', 'note', { observations: ['unrelated english text'] });

      const names = kg.search('備份').map((e) => e.name);
      expect(names).toContain('cjk-note');
      expect(names).not.toContain('other-note');
    });

    it('finds part of an unbroken CJK run', () => {
      // This case used to assert the opposite, as a documented limitation:
      // unicode61 indexes an unbroken CJK run as ONE token, so only the exact
      // stored string matched. `segmentUnspacedScripts()` now cuts those runs
      // into overlapping bigrams on both the index and the query side.
      // Full coverage lives in tests/cjk-recall.test.ts.
      kg.createEntity('cjk-run', 'note', { observations: ['資料庫遷移前一定要先備份'] });

      expect(kg.search('資料庫遷移前一定要先備份').map((e) => e.name)).toContain('cjk-run');
      expect(kg.search('資料庫遷移').map((e) => e.name)).toContain('cjk-run');
      expect(kg.search('備份').map((e) => e.name)).toContain('cjk-run');
    });

    it('treats FTS5 operator words as plain search terms', () => {
      kg.createEntity('or-note', 'note', { observations: ['choose redis or postgres'] });
      // Unquoted, OR / NOT / NEAR are FTS5 syntax; the tokens stay quoted so a
      // user asking about them searches for the word.
      expect(() => kg.search('redis or postgres')).not.toThrow();
      expect(kg.search('redis or postgres').map((e) => e.name)).toContain('or-note');
    });

    it('returns nothing when a non-empty query has no searchable terms', () => {
      // BEHAVIOUR CHANGE. This used to fall back to the recent list, which
      // handed back memories that matched nothing and labelled them results.
      // A caller — especially an LLM consuming `recall` output — cannot tell
      // "here is what matched" from "I found no terms in your query, have
      // these instead", so unrelated memories get treated as relevant.
      //
      // Empty is the honest answer. The genuinely empty query still lists
      // recent, which is its documented behaviour and is checked below.
      kg.createEntity('anything', 'note', { observations: ['some content'] });
      expect(kg.search('?!...')).toEqual([]);
      expect(kg.search('@#$%^&*()')).toEqual([]);
    });

    it('still lists recent memories for a genuinely empty query', () => {
      // The distinction the change above depends on: "" means "show me what
      // you have", "?!..." means "search for this". They must not collapse.
      kg.createEntity('anything', 'note', { observations: ['some content'] });
      expect(kg.search('').map((e) => e.name)).toContain('anything');
      expect(kg.search('   ').map((e) => e.name)).toContain('anything');
    });
  });

  describe('determinism', () => {
    it('returns the same memories in the same order for the same query', () => {
      // BM25 ties are common: every row matching only the same single term
      // scores identically. LIMIT then decides which of them reach the
      // multi-factor scorer, so without a tiebreaker the surviving set — and
      // therefore the final answer — is whatever order SQLite happened to
      // produce. Recall that changes run to run is not debuggable.
      for (let i = 0; i < 30; i++) {
        kg.createEntity(`tied-${String(i).padStart(2, '0')}`, 'note', {
          observations: ['deployment notes for the service'],
        });
      }

      const first = kg.search('deployment').map((e) => e.name);
      for (let run = 0; run < 5; run++) {
        expect(kg.search('deployment').map((e) => e.name)).toEqual(first);
      }
      expect(first.length).toBeGreaterThan(0);
    });
  });

  describe('documented limits', () => {
    it('uses only the first MAX_QUERY_TERMS (32) terms, head-first', () => {
      kg.createEntity('tail-match', 'note', { observations: ['a note about zebras'] });
      const filler = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

      // Truncation takes the head, so a matching term past position 32 is
      // dropped. Pinned so the cap and its direction cannot change silently.
      expect(kg.search(`${filler} zebras`).map((e) => e.name)).not.toContain('tail-match');
      expect(kg.search(`zebras ${filler}`).map((e) => e.name)).toContain('tail-match');
    });

    it('applies the same terms to archived-only matches', () => {
      // include_archived pulls archived rows from a separate LIKE scan — they
      // are removed from FTS5 on archive — but that scan now matches the same
      // tokens the FTS branch does. This case used to assert the opposite, as a
      // documented asymmetry: a scattered-word question found the active copy
      // and missed the archived one because the raw query string was matched as
      // a literal substring.
      kg.createEntity('active-grad', 'note', {
        observations: ['I finished college in 2011 with a Business degree.'],
      });
      kg.createEntity('archived-grad', 'note', {
        observations: ['I finished college in 2011 with a Business degree.'],
      });
      kg.archiveEntity('archived-grad');

      const q = 'What degree did I graduate with?';
      expect(kg.search(q).map((e) => e.name)).toContain('active-grad');
      expect(kg.search(q, { includeArchived: true }).map((e) => e.name)).toContain('archived-grad');
    });

    it('cannot let a LIKE wildcard widen an archived match', () => {
      // `%` and `_` ARE wildcards in the archived branch's LIKE. They cannot
      // reach it: the tokeniser emits only [\p{L}\p{N}\p{M}]+, so a query of
      // `planning%` searches for the word and the `%` never survives — the same
      // guarantee the FTS branch relies on for its operators. The escaping in
      // archivedLikeTerms() is defence for the raw-query fallback, which
      // search() cannot reach because a query with no terms returns the recent
      // list before this branch runs.
      kg.createEntity('archived-planning', 'note', { observations: ['quarterly planning notes'] });
      kg.createEntity('archived-budget', 'note', { observations: ['budget review meeting'] });
      kg.archiveEntity('archived-planning');
      kg.archiveEntity('archived-budget');

      const names = kg.search('planning%', { includeArchived: true }).map((e) => e.name);
      expect(names).toContain('archived-planning');
      expect(names).not.toContain('archived-budget');
    });
  });

  describe('filters still apply', () => {
    // Single-filter coverage (tag alone, namespace alone, limit, archived
    // excluded by default) lives in tests/knowledge-graph.test.ts and is not
    // repeated here. This is the case that file does not have: both filters at
    // once, which is what pins the positional parameter order.
    it('applies tag and namespace filters together', () => {
      // One statement builds MATCH ? → tag ? → namespace ? → limit ? from
      // optional fragments, so a mis-ordered `params.push` binds the tag as the
      // namespace and silently returns nothing (or the wrong row).
      kg.createEntity('both', 'note', {
        observations: ['release checklist'],
        tags: ['project:alpha'],
        namespace: 'team',
      });
      kg.createEntity('wrong-namespace', 'note', {
        observations: ['release checklist'],
        tags: ['project:alpha'],
        namespace: 'personal',
      });
      kg.createEntity('wrong-tag', 'note', {
        observations: ['release checklist'],
        tags: ['project:beta'],
        namespace: 'team',
      });

      const names = kg
        .search('release checklist', { tag: 'project:alpha', namespace: 'team' })
        .map((e) => e.name);
      expect(names).toEqual(['both']);
    });
  });
});
