import { hasVectorIndex } from '../storage/vector-index.js';
export const CONFLICT_SIGNAL_TYPES = [
    'decision',
    'lesson_learned',
    'lesson',
    'fact',
    'architecture',
    'architecture_decision',
    'pattern',
    'note',
];
export const CONFLICT_MAX_COSINE_DISTANCE = 0.35;
export const CONFLICT_NEIGHBORS_PER_ENTITY = 3;
export function pairKey(idA, idB) {
    return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}
export function findConflictCandidates(db, opts = {}) {
    const maxCos = opts.maxCosineDistance ?? CONFLICT_MAX_COSINE_DISTANCE;
    const k = opts.neighborsPerEntity ?? CONFLICT_NEIGHBORS_PER_ENTITY;
    if (!hasVectorIndex(db))
        return [];
    const typePlaceholders = CONFLICT_SIGNAL_TYPES.map(() => '?').join(',');
    const signal = db.prepare(`SELECT v.rowid AS id, v.embedding AS emb, e.name, e.type
     FROM entities_vec v
     JOIN entities e ON e.id = v.rowid
     WHERE e.status = 'active' AND e.type IN (${typePlaceholders})`).all(...CONFLICT_SIGNAL_TYPES);
    if (signal.length < 2)
        return [];
    const byId = new Map(signal.map((s) => [s.id, s]));
    const excluded = new Set();
    for (const r of db.prepare(`SELECT from_entity_id AS a, to_entity_id AS b FROM relations
     WHERE relation_type IN ('supersedes', 'contradicts')`).all()) {
        excluded.add(pairKey(r.a, r.b));
    }
    for (const r of db.prepare('SELECT pair_key FROM conflict_judged_pairs').all()) {
        excluded.add(r.pair_key);
    }
    const maxL2 = Math.sqrt(2 * maxCos);
    const knn = db.prepare('SELECT rowid AS id, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?');
    const seen = new Set();
    const out = [];
    for (const s of signal) {
        const hits = knn.all(s.emb, k + 1);
        for (const hit of hits) {
            if (hit.id === s.id)
                continue;
            if (hit.distance > maxL2)
                continue;
            const other = byId.get(hit.id);
            if (!other)
                continue;
            const key = pairKey(s.id, hit.id);
            if (seen.has(key) || excluded.has(key))
                continue;
            seen.add(key);
            out.push({
                aId: Math.min(s.id, other.id),
                aName: s.id < other.id ? s.name : other.name,
                aType: s.id < other.id ? s.type : other.type,
                bId: Math.max(s.id, other.id),
                bName: s.id < other.id ? other.name : s.name,
                bType: s.id < other.id ? other.type : s.type,
                cosineDistance: (hit.distance * hit.distance) / 2,
            });
        }
    }
    out.sort((x, y) => x.cosineDistance - y.cosineDistance);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}
//# sourceMappingURL=conflict-candidates.js.map