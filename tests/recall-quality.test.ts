import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { recall } from '../src/core/operations.js';
import { useTestDatabase } from './helpers/db-fixture.js';

/**
 * Aggregate retrieval-quality gate.
 *
 * The individual guards in `recall-relevance.test.ts` pin one mechanism each.
 * This one asks the question a user asks: over a set of questions phrased in
 * their own words, how often does the right memory come back? It exists because
 * the LongMemEval benchmark could not answer that — until 2026-07 the benchmark
 * ran its own copy of retrieval, so the shipped path scored 5.20% while the
 * published figure said 95.40%.
 *
 * The real dataset is deliberately NOT used here: it is a 278 MB download, and
 * committing a slice is dataset redistribution. This corpus is synthetic, tiny
 * and deterministic, and its job is to catch collapse, not to reproduce the
 * published number. Every defect fixed in PR #78 drops it below the floor —
 * there is a break matrix in the PR proving that, and any future change to the
 * gate should re-prove it rather than trusting this comment.
 */

// Written first, so they hold the LOWEST ids. Anything that ranks by recency
// instead of relevance will bury them under the noise created afterwards.
const MEMORIES: Array<[string, string]> = [
  ['auth-decision', 'We chose passwordless magic links over OAuth for the customer portal, because support cannot reset third-party accounts.'],
  ['migration-lesson', 'Running the alembic migration on production without a dump lost two hours of orders. Always dump the database first.'],
  ['queue-decision', 'Background jobs run on Redis streams rather than Celery, because the team already operates Redis.'],
  ['cache-incident', 'The CDN served stale pricing for forty minutes after a deploy. Add a cache-busting query parameter to price assets.'],
  ['frontend-decision', 'Preact instead of React for the dashboard, to keep the single-file bundle small.'],
  ['timezone-bug', 'Scheduled reports fired an hour late every spring because the cron used local time instead of UTC.'],
  ['review-preference', 'Pull requests should stay under four hundred changed lines. Anything bigger gets split.'],
  ['secrets-lesson', "An API key leaked through a debug log line. Never log the whole config object, and rotate the key when it happens."],
  ['storage-decision', 'Postgres over MySQL for the analytics service, because we need window functions and JSONB.'],
  ['kitchen-note', "The kitchen rota is posted on Mondays; whoever cooks does not wash up."],
];

// Questions phrased the way a person asks them — full sentences, with words the
// memory does not contain. Under FTS5's implicit AND these match nothing.
const QUESTIONS: Array<[string, string]> = [
  ['Why did we pick magic links for the customer portal?', 'auth-decision'],
  ['What went wrong when we ran the alembic migration?', 'migration-lesson'],
  ['Which queue are background jobs running on these days?', 'queue-decision'],
  ['How long did the CDN serve stale pricing for?', 'cache-incident'],
  ['What did we use for the dashboard instead of React?', 'frontend-decision'],
  ['Why were the scheduled reports an hour late?', 'timezone-bug'],
  ['How many changed lines should a pull request stay under?', 'review-preference'],
  ['What happened with the leaked API key in the logs?', 'secrets-lesson'],
  ['Why did we choose Postgres for the analytics service?', 'storage-decision'],
  // Apostrophe and hyphen: quoting a whitespace-split token turns these into
  // phrase requirements that no memory satisfies.
  ["What's the kitchen rota rule about washing-up?", 'kitchen-note'],
];

// Enough noise sharing the questions' function words that a recency-ordered
// LIMIT fills up entirely before it reaches any of the memories above.
const NOISE_COUNT = 30;

/** The floor. Measured at 100% on the shipped path; set with margin so this
 *  guards against collapse rather than tracking drift. */
const R_AT_5_FLOOR = 0.8;

describe('Feature: recall quality gate', () => {
  useTestDatabase('memesh-recall-quality-');

  let kg: KnowledgeGraph;

  beforeEach(() => {
    const db = getDatabase();
    kg = new KnowledgeGraph(db);

    for (const [name, text] of MEMORIES) {
      kg.createEntity(name, 'note', { observations: [text] });
    }
    db.transaction(() => {
      for (let i = 0; i < NOISE_COUNT; i++) {
        kg.createEntity(`standup-${String(i).padStart(3, '0')}`, 'note', {
          // Function words only. They are what makes every question match all
          // 30 rows — so `limit: 5` has to choose — while carrying almost no
          // BM25 weight, because a term present in every row has no IDF.
          observations: [`Standup ${i}: what we did for the day, and what is left.`],
        });
      }
    })();
    // Deliberately no access_count skew here. Frequency carries 0.18 of the
    // score while adjacent BM25 positions differ by far less, so one
    // heavily-read note legitimately outranks a better match — that is the
    // scorer working as designed, and it is pinned precisely (rank 1 vs rank 19)
    // in recall-relevance.test.ts. Repeating it here would make this gate fail
    // for a reason that has nothing to do with retrieval quality.
  });

  it(`answers at least ${R_AT_5_FLOOR * 100}% of natural-language questions in the top 5`, () => {
    const misses: string[] = [];

    for (const [question, expected] of QUESTIONS) {
      // limit 5 so the SQL has to choose which rows survive to the scorer —
      // the condition under which ordering by id instead of relevance loses.
      const top5 = recall({ query: question, limit: 5 }).map((e) => e.name);
      if (!top5.includes(expected)) misses.push(`${expected} <- "${question}" (got: ${top5.join(', ') || 'nothing'})`);
    }

    const rAt5 = (QUESTIONS.length - misses.length) / QUESTIONS.length;
    expect(rAt5, `R@5 ${(rAt5 * 100).toFixed(0)}% below floor. Missed:\n  ${misses.join('\n  ')}`).toBeGreaterThanOrEqual(
      R_AT_5_FLOOR
    );
  });

  it('puts the right memory first on an untouched database', () => {
    // Only the FIRST query of the run is measured. `search()` increments
    // access_count on every row it returns, so by question two the noise rows
    // touched by question one carry a frequency bonus (0.18 of the score, and
    // `frequencyScore` normalises against the max in the candidate set, so a
    // single prior access is worth most of it). Whether that self-reinforcement
    // is desirable is an open design question, tracked separately; what matters
    // here is not to bake it into a gate, because a rank-1 rate measured across
    // a sequence measures the ratchet, not retrieval.
    const [question, expected] = QUESTIONS[0];
    const results = recall({ query: question, limit: 5 });
    expect(results[0]?.name).toBe(expected);
  });

  it('does not answer a question about something never stored', () => {
    // The floor must not be reachable by returning everything for everything.
    const results = recall({ query: 'Which Kubernetes ingress controller did we deploy?', limit: 5 });
    expect(results.map((e) => e.name)).not.toContain('auth-decision');
  });
});
