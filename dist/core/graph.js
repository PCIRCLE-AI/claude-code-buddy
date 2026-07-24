import { KnowledgeGraph } from '../knowledge-graph.js';
import { NOISE_TYPES } from './analytics.js';
export function computeGraph(db) {
    const kg = new KnowledgeGraph(db);
    const noiseList = Array.from(NOISE_TYPES);
    const placeholders = noiseList.map(() => '?').join(',');
    const signalRows = db.prepare(`SELECT id FROM entities WHERE type NOT IN (${placeholders}) ORDER BY COALESCE(last_accessed_at, created_at) DESC`).all(...noiseList);
    const noiseRows = db.prepare(`SELECT id FROM entities WHERE type IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`).all(...noiseList);
    const allIds = [...signalRows, ...noiseRows].map((r) => r.id);
    const entities = kg.getEntitiesByIds(allIds);
    const relations = db.prepare(`
    SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
  `).all();
    return { entities, relations, noiseTypes: noiseList };
}
//# sourceMappingURL=graph.js.map