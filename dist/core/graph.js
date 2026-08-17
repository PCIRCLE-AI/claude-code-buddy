import { KnowledgeGraph } from '../knowledge-graph.js';
import { NOISE_TYPES } from './analytics.js';
import { WORK_LAYER_TYPES } from './work-topology.js';
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
export function computeWorkGraph(db) {
    const kg = new KnowledgeGraph(db);
    const workTypes = Array.from(WORK_LAYER_TYPES);
    const placeholders = workTypes.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id FROM entities WHERE type IN (${placeholders}) AND status = 'active'
     ORDER BY COALESCE(last_accessed_at, created_at) DESC`).all(...workTypes);
    const entities = kg.getEntitiesByIds(rows.map((r) => r.id));
    const relations = db.prepare(`
    SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
    WHERE e_from.type IN (${placeholders}) AND e_to.type IN (${placeholders})
  `).all(...workTypes, ...workTypes);
    const countRows = db.prepare(`
    SELECT e_to.name AS name, COUNT(*) AS n
    FROM relations r
    JOIN entities e_to ON r.to_entity_id = e_to.id
    JOIN entities e_from ON r.from_entity_id = e_from.id
    WHERE r.relation_type = 'evidences'
      AND e_to.type IN (${placeholders})
      AND e_from.status = 'active'
    GROUP BY e_to.name
  `).all(...workTypes);
    const evidenceCounts = {};
    for (const row of countRows)
        evidenceCounts[row.name] = row.n;
    return { entities, relations, evidenceCounts };
}
const EVIDENCE_CAP = 200;
export function computeNodeEvidence(db, nodeName) {
    const node = db.prepare('SELECT id, name FROM entities WHERE name = ?').get(nodeName);
    if (!node)
        return null;
    const kg = new KnowledgeGraph(db);
    const rows = db.prepare(`
    SELECT e.id
    FROM relations r
    JOIN entities e ON r.from_entity_id = e.id
    WHERE r.relation_type = 'evidences' AND r.to_entity_id = ?
      AND e.status = 'active'
    ORDER BY e.created_at DESC
    LIMIT ${EVIDENCE_CAP + 1}
  `).all(node.id);
    const truncated = rows.length > EVIDENCE_CAP;
    const entities = kg.getEntitiesByIds(rows.slice(0, EVIDENCE_CAP).map((r) => r.id));
    const relations = entities.map((e) => ({
        from: e.name,
        to: node.name,
        type: 'evidences',
    }));
    return { entities, relations, truncated };
}
//# sourceMappingURL=graph.js.map