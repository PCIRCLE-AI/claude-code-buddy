export interface ScoringWeights {
  searchRelevance: number;   // default 0.30
  recency: number;           // default 0.25
  frequency: number;         // default 0.18
  confidence: number;        // default 0.17
  impact: number;            // default 0.10
}

// Removed temporalValidity (5 %) in 2026-05: the underlying valid_from /
// valid_until columns were never written by any code path, so the score
// it produced was a constant 1.0 for every entity — a no-op factor. The
// 5 % is reabsorbed by frequency (+0.03) and confidence (+0.02) which
// are the non-decay quality signals.
export const DEFAULT_WEIGHTS: ScoringWeights = {
  searchRelevance: 0.30,
  recency: 0.25,
  frequency: 0.18,
  confidence: 0.17,
  impact: 0.10,
};

/**
 * Weights as used by `scripts/hooks/session-start.js` SQL ORDER BY.
 *
 * Session-start ranks the project's auto-context entities in pure SQL
 * (no FTS query → no searchRelevance, and impact is folded into core's
 * ranking pass instead). The three remaining factors (recency, frequency,
 * confidence) are renormalised so they sum to 1.0 and preserve the
 * proportions of `DEFAULT_WEIGHTS`.
 *
 * If you change `DEFAULT_WEIGHTS`, recompute these and update the SQL in
 * `session-start.js` to match (the `0.4167 / 0.3000 / 0.2833` magic
 * numbers in the ORDER BY clause). The values are exported here so a
 * future test (or eslint rule) can assert the SQL stays in sync.
 */
export const SESSION_START_WEIGHT_RATIO = (() => {
  const sub = DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.frequency + DEFAULT_WEIGHTS.confidence;
  return {
    recency: DEFAULT_WEIGHTS.recency / sub,
    frequency: DEFAULT_WEIGHTS.frequency / sub,
    confidence: DEFAULT_WEIGHTS.confidence / sub,
  };
})();

/**
 * Calculate recency score using exponential decay.
 * Score = e^(-days_since_access / 30)
 * Recent = 1.0, 30 days = 0.37, 60 days = 0.14, 90 days = 0.05
 */
export function recencyScore(lastAccessedAt: string | null | undefined): number {
  if (!lastAccessedAt) return 0.5; // neutral if never accessed
  const days = (Date.now() - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-days / 30);
}

/**
 * Calculate frequency score using log normalization.
 * Score = log(access_count + 1) / log(maxAccess + 1)
 */
export function frequencyScore(accessCount: number, maxAccessCount: number): number {
  if (maxAccessCount <= 0) return 0;
  return Math.log(accessCount + 1) / Math.log(maxAccessCount + 1);
}

/**
 * Calculate impact score using Laplace-smoothed recall effectiveness.
 * Score = (recall_hits + 1) / (recall_hits + recall_misses + 2)
 * Laplace smoothing gives new entities (0 hits, 0 misses) a neutral 0.5.
 * Entities with high hit rate rise; ignored entities fade.
 */
export function impactScore(recallHits: number, recallMisses: number): number {
  return (recallHits + 1) / (recallHits + recallMisses + 2);
}

/**
 * Score a single entity.
 * searchRelevanceValue is provided by the search engine (FTS5 rank or vector distance).
 */
export function scoreEntity(
  entity: { access_count?: number; last_accessed_at?: string; confidence?: number; recall_hits?: number; recall_misses?: number },
  searchRelevanceValue: number,
  maxAccessCount: number,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  const sr = searchRelevanceValue * weights.searchRelevance;
  const rc = recencyScore(entity.last_accessed_at) * weights.recency;
  const fq = frequencyScore(entity.access_count ?? 0, maxAccessCount) * weights.frequency;
  const cf = (entity.confidence ?? 1.0) * weights.confidence;
  const im = impactScore(entity.recall_hits ?? 0, entity.recall_misses ?? 0) * weights.impact;
  return sr + rc + fq + cf + im;
}

/**
 * Sort entities by score descending.
 * searchRelevanceValues maps entity name → search relevance (0-1).
 */
export function rankEntities<T extends { name: string; access_count?: number; last_accessed_at?: string; confidence?: number; recall_hits?: number; recall_misses?: number }>(
  entities: T[],
  searchRelevanceValues: Map<string, number>,
  weights?: ScoringWeights
): T[] {
  const maxAccess = Math.max(...entities.map(e => e.access_count ?? 0), 1);

  return [...entities].sort((a, b) => {
    const scoreA = scoreEntity(a, searchRelevanceValues.get(a.name) ?? 0.5, maxAccess, weights);
    const scoreB = scoreEntity(b, searchRelevanceValues.get(b.name) ?? 0.5, maxAccess, weights);
    return scoreB - scoreA;
  });
}
