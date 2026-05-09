import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  recencyScore,
  frequencyScore,
  impactScore,
  rankEntities,
  SESSION_START_WEIGHT_RATIO,
  DEFAULT_WEIGHTS,
} from '../../src/core/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Scoring Engine', () => {
  describe('recencyScore', () => {
    it('returns 1.0 for just-accessed entity', () => {
      expect(recencyScore(new Date().toISOString())).toBeCloseTo(1.0, 1);
    });

    it('returns ~0.37 for 30-day-old access', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      expect(recencyScore(thirtyDaysAgo)).toBeCloseTo(0.37, 1);
    });

    it('returns 0.5 for null access', () => {
      expect(recencyScore(null)).toBe(0.5);
    });
  });

  describe('frequencyScore', () => {
    it('returns 0 for zero access', () => {
      expect(frequencyScore(0, 100)).toBeCloseTo(0, 1);
    });

    it('returns 1.0 for max access', () => {
      expect(frequencyScore(100, 100)).toBeCloseTo(1.0, 1);
    });

    it('returns ~0.5 for sqrt(max) access', () => {
      expect(frequencyScore(10, 100)).toBeGreaterThan(0.3);
      expect(frequencyScore(10, 100)).toBeLessThan(0.7);
    });
  });

  describe('impactScore', () => {
    it('returns 0.5 for new entity (0 hits, 0 misses) — Laplace smoothing', () => {
      expect(impactScore(0, 0)).toBeCloseTo(0.5, 2);
    });

    it('returns high score for entity with many hits', () => {
      expect(impactScore(10, 0)).toBeCloseTo(11 / 12, 2); // ~0.917
    });

    it('returns low score for entity with many misses', () => {
      expect(impactScore(0, 10)).toBeCloseTo(1 / 12, 2); // ~0.083
    });

    it('returns ~0.5 for balanced hits and misses', () => {
      expect(impactScore(5, 5)).toBeCloseTo(0.5, 2);
    });
  });

  describe('rankEntities', () => {
    it('ranks frequently accessed higher', () => {
      const entities = [
        { name: 'rare', access_count: 1, confidence: 1.0 },
        { name: 'popular', access_count: 50, confidence: 1.0 },
      ];
      const relevance = new Map([['rare', 0.5], ['popular', 0.5]]);
      const ranked = rankEntities(entities, relevance);
      expect(ranked[0].name).toBe('popular');
    });

    it('ranks high-impact entities higher when other factors are equal', () => {
      const entities = [
        { name: 'ignored', access_count: 5, confidence: 1.0, recall_hits: 0, recall_misses: 10 },
        { name: 'effective', access_count: 5, confidence: 1.0, recall_hits: 10, recall_misses: 0 },
      ];
      const relevance = new Map([['ignored', 0.5], ['effective', 0.5]]);
      const ranked = rankEntities(entities, relevance);
      expect(ranked[0].name).toBe('effective');
    });

    it('ranks recent higher when access is equal', () => {
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const entities = [
        { name: 'old', access_count: 5, last_accessed_at: old, confidence: 1.0 },
        { name: 'recent', access_count: 5, last_accessed_at: now, confidence: 1.0 },
      ];
      const relevance = new Map([['old', 0.5], ['recent', 0.5]]);
      const ranked = rankEntities(entities, relevance);
      expect(ranked[0].name).toBe('recent');
    });
  });

  describe('SESSION_START_WEIGHT_RATIO', () => {
    it('renormalises recency/frequency/confidence to sum to 1.0', () => {
      const sum = SESSION_START_WEIGHT_RATIO.recency
        + SESSION_START_WEIGHT_RATIO.frequency
        + SESSION_START_WEIGHT_RATIO.confidence;
      expect(sum).toBeCloseTo(1.0, 6);
    });

    it('preserves the proportions of DEFAULT_WEIGHTS', () => {
      const subTotal = DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.frequency + DEFAULT_WEIGHTS.confidence;
      expect(SESSION_START_WEIGHT_RATIO.recency).toBeCloseTo(DEFAULT_WEIGHTS.recency / subTotal, 6);
      expect(SESSION_START_WEIGHT_RATIO.frequency).toBeCloseTo(DEFAULT_WEIGHTS.frequency / subTotal, 6);
      expect(SESSION_START_WEIGHT_RATIO.confidence).toBeCloseTo(DEFAULT_WEIGHTS.confidence / subTotal, 6);
    });

    // Drift guard: the session-start hook hard-codes these weights inside a
    // SQL ORDER BY string (no module imports cross the F5 boundary). If
    // DEFAULT_WEIGHTS changes the ratios, the hook SQL must be updated
    // too. This test fails loudly so a maintainer cannot silently shift
    // session-start ranking out of sync with core ranking.
    it('matches the hard-coded magic numbers in scripts/hooks/session-start.js', () => {
      const hookSrc = readFileSync(
        resolve(__dirname, '../../scripts/hooks/session-start.js'),
        'utf8',
      );
      const recencyStr = SESSION_START_WEIGHT_RATIO.recency.toFixed(4);
      const frequencyStr = SESSION_START_WEIGHT_RATIO.frequency.toFixed(4);
      const confidenceStr = SESSION_START_WEIGHT_RATIO.confidence.toFixed(4);
      expect(hookSrc).toContain(`* ${recencyStr}`);
      expect(hookSrc).toContain(`* ${frequencyStr}`);
      expect(hookSrc).toContain(`* ${confidenceStr}`);
    });
  });
});
