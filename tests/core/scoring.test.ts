import { describe, it, expect } from 'vitest';
import { recencyScore, frequencyScore, temporalValidityScore, scoreEntity, rankEntities, DEFAULT_WEIGHTS } from '../../src/core/scoring.js';

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

  describe('temporalValidityScore', () => {
    it('returns 1.0 for no expiry', () => {
      expect(temporalValidityScore(null)).toBe(1.0);
    });

    it('returns 1.0 for future expiry', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      expect(temporalValidityScore(future)).toBe(1.0);
    });

    it('returns 0.5 for past expiry', () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      expect(temporalValidityScore(past)).toBe(0.5);
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
});
