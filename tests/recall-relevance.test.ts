import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { recall } from '../src/core/operations.js';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
  let testDir: string;
  let db: Database.Database;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `memesh-recall-rel-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase(path.join(testDir, 'test.db'));
    kg = new KnowledgeGraph(db);
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
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
    });

    it('finds the memory when the query words are scattered through it', () => {
      // "What"/"did"/"I"/"with" never appear together with the rest in the
      // stored text — under AND semantics this returns nothing.
      const results = kg.search('What degree did I graduate with?');
      expect(results.map((e) => e.name)).toContain('grad-record');
    });

    it('ranks the memory that matches more query terms first', () => {
      const results = kg.search('degree graduated college');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('grad-record');
    });

    it('still returns nothing when no query term appears anywhere', () => {
      // OR must not turn "no match" into "everything".
      expect(kg.search('kubernetes helm chart')).toHaveLength(0);
    });

    it('does not return unrelated memories for a well-matched query', () => {
      const names = kg.search('degree graduated college').map((e) => e.name);
      expect(names).not.toContain('pasta-recipe');
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

    it('returns the most relevant memory even though 40 newer ones also match', () => {
      const results = kg.search('jwt', { limit: 20 });
      expect(results.map((e) => e.name)).toContain('jwt-rotation-decision');
    });

    it('ranks the most relevant memory first, not the newest', () => {
      const results = kg.search('jwt', { limit: 20 });
      expect(results[0].name).toBe('jwt-rotation-decision');
    });

    it('survives the scoring pass in recall() — relevance is not flattened', () => {
      // search() can order correctly and still lose it: if every FTS hit enters
      // the scorer with the same relevance value, rankEntities re-sorts on
      // recency/frequency alone and the newest row wins again.
      const results = recall({ query: 'jwt', limit: 20 });
      expect(results[0].name).toBe('jwt-rotation-decision');
    });
  });

  describe('existing behaviour is preserved', () => {
    it('respects the tag filter', () => {
      kg.createEntity('tagged', 'note', {
        observations: ['deployment pipeline caching strategy'],
        tags: ['project:alpha'],
      });
      kg.createEntity('untagged', 'note', {
        observations: ['deployment pipeline caching strategy'],
      });

      const results = kg.search('deployment caching', { tag: 'project:alpha' });
      expect(results.map((e) => e.name)).toEqual(['tagged']);
    });

    it('respects the namespace filter', () => {
      kg.createEntity('personal-note', 'note', {
        observations: ['quarterly planning notes'],
        namespace: 'personal',
      });
      kg.createEntity('team-note', 'note', {
        observations: ['quarterly planning notes'],
        namespace: 'team',
      });

      const results = kg.search('quarterly planning', { namespace: 'team' });
      expect(results.map((e) => e.name)).toEqual(['team-note']);
    });

    it('honours the limit', () => {
      for (let i = 0; i < 10; i++) {
        kg.createEntity(`doc-${i}`, 'note', { observations: ['shared indexing term'] });
      }
      expect(kg.search('indexing', { limit: 3 })).toHaveLength(3);
    });

    it('excludes archived entities by default', () => {
      kg.createEntity('live-doc', 'note', { observations: ['migration checklist'] });
      kg.createEntity('dead-doc', 'note', { observations: ['migration checklist'] });
      kg.archiveEntity('dead-doc');

      const names = kg.search('migration checklist').map((e) => e.name);
      expect(names).toContain('live-doc');
      expect(names).not.toContain('dead-doc');
    });
  });
});
