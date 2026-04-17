export interface ScoringWeights {
  searchRelevance: number;   // default 0.35
  recency: number;           // default 0.25
  frequency: number;         // default 0.20
  confidence: number;        // default 0.15
  temporalValidity: number;  // default 0.05
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  searchRelevance: 0.35,
  recency: 0.25,
  frequency: 0.20,
  confidence: 0.15,
  temporalValidity: 0.05,
};

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
 * Calculate temporal validity score.
 * 1.0 if currently valid (no valid_until or valid_until > now)
 * 0.5 if expired (valid_until < now)
 */
export function temporalValidityScore(validUntil: string | null | undefined): number {
  if (!validUntil) return 1.0; // no expiry = always valid
  return new Date(validUntil).getTime() > Date.now() ? 1.0 : 0.5;
}

/**
 * Score a single entity.
 * searchRelevanceValue is provided by the search engine (FTS5 rank or vector distance).
 */
export function scoreEntity(
  entity: { access_count?: number; last_accessed_at?: string; confidence?: number; valid_until?: string },
  searchRelevanceValue: number,
  maxAccessCount: number,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  const sr = searchRelevanceValue * weights.searchRelevance;
  const rc = recencyScore(entity.last_accessed_at) * weights.recency;
  const fq = frequencyScore(entity.access_count ?? 0, maxAccessCount) * weights.frequency;
  const cf = (entity.confidence ?? 1.0) * weights.confidence;
  const tv = temporalValidityScore(entity.valid_until) * weights.temporalValidity;
  return sr + rc + fq + cf + tv;
}

/**
 * Sort entities by score descending.
 * searchRelevanceValues maps entity name → search relevance (0-1).
 */
export function rankEntities<T extends { name: string; access_count?: number; last_accessed_at?: string; confidence?: number; valid_until?: string }>(
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
