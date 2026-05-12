export const DEFAULT_WEIGHTS = {
    searchRelevance: 0.30,
    recency: 0.25,
    frequency: 0.18,
    confidence: 0.17,
    impact: 0.10,
};
export const SESSION_START_WEIGHT_RATIO = (() => {
    const sub = DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.frequency + DEFAULT_WEIGHTS.confidence;
    return {
        recency: DEFAULT_WEIGHTS.recency / sub,
        frequency: DEFAULT_WEIGHTS.frequency / sub,
        confidence: DEFAULT_WEIGHTS.confidence / sub,
    };
})();
export function recencyScore(lastAccessedAt) {
    if (!lastAccessedAt)
        return 0.5;
    const days = (Date.now() - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
    return Math.exp(-days / 30);
}
export function frequencyScore(accessCount, maxAccessCount) {
    if (maxAccessCount <= 0)
        return 0;
    return Math.log(accessCount + 1) / Math.log(maxAccessCount + 1);
}
export function impactScore(recallHits, recallMisses) {
    return (recallHits + 1) / (recallHits + recallMisses + 2);
}
export function scoreEntity(entity, searchRelevanceValue, maxAccessCount, weights = DEFAULT_WEIGHTS) {
    const sr = searchRelevanceValue * weights.searchRelevance;
    const rc = recencyScore(entity.last_accessed_at) * weights.recency;
    const fq = frequencyScore(entity.access_count ?? 0, maxAccessCount) * weights.frequency;
    const cf = (entity.confidence ?? 1.0) * weights.confidence;
    const im = impactScore(entity.recall_hits ?? 0, entity.recall_misses ?? 0) * weights.impact;
    return sr + rc + fq + cf + im;
}
export function rankEntities(entities, searchRelevanceValues, weights) {
    const maxAccess = Math.max(...entities.map(e => e.access_count ?? 0), 1);
    return [...entities].sort((a, b) => {
        const scoreA = scoreEntity(a, searchRelevanceValues.get(a.name) ?? 0.5, maxAccess, weights);
        const scoreB = scoreEntity(b, searchRelevanceValues.get(b.name) ?? 0.5, maxAccess, weights);
        return scoreB - scoreA;
    });
}
//# sourceMappingURL=scoring.js.map