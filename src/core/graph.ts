// =============================================================================
// Graph — entities + relations for the dashboard graph view
// =============================================================================

import type { MemeshDatabase } from '../storage/sqlite.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { Entity } from './types.js';
import { NOISE_TYPES } from './analytics.js';

export type GraphRelation = {
  from: string;
  to: string;
  type: string;
};

export interface GraphResult {
  entities: Entity[];
  relations: GraphRelation[];
  /** Noise type names the server filtered low-priority — clients should default-hide these. */
  noiseTypes: string[];
}

export function computeGraph(db: MemeshDatabase): GraphResult {
  const kg = new KnowledgeGraph(db);
  const noiseList = Array.from(NOISE_TYPES);
  const placeholders = noiseList.map(() => '?').join(',');

  // All signal entities (non-noise) — typically <500, always include all
  const signalRows = db.prepare(
    `SELECT id FROM entities WHERE type NOT IN (${placeholders}) ORDER BY COALESCE(last_accessed_at, created_at) DESC`,
  ).all(...noiseList) as { id: number }[];

  // Recent noise entities — fill up to cap of 200 for those who want to see them
  const noiseRows = db.prepare(
    `SELECT id FROM entities WHERE type IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`,
  ).all(...noiseList) as { id: number }[];

  // Batch-hydrate in one shot instead of getEntity()-in-a-loop (which fired
  // 4 queries per row — ~2800 on a 700-entity graph). getEntitiesByIds
  // preserves input order, so the signal-then-noise ordering above is kept.
  const allIds = [...signalRows, ...noiseRows].map((r) => r.id);
  const entities = kg.getEntitiesByIds(allIds);

  const relations = db.prepare(`
    SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
  `).all() as GraphRelation[];

  return { entities, relations, noiseTypes: noiseList };
}
