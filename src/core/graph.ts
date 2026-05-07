// =============================================================================
// Graph — entities + relations for the dashboard graph view
// =============================================================================

import type Database from 'better-sqlite3';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { Entity } from './types.js';
import { NOISE_TYPES } from './analytics.js';

export interface GraphRelation {
  from: string;
  to: string;
  type: string;
}

export interface GraphResult {
  entities: Entity[];
  relations: GraphRelation[];
  /** Noise type names the server filtered low-priority — clients should default-hide these. */
  noiseTypes: string[];
}

export function computeGraph(db: Database.Database): GraphResult {
  const kg = new KnowledgeGraph(db);
  const noiseList = Array.from(NOISE_TYPES);
  const placeholders = noiseList.map(() => '?').join(',');

  // All signal entities (non-noise) — typically <500, always include all
  const signalRows = db.prepare(
    `SELECT name FROM entities WHERE type NOT IN (${placeholders}) ORDER BY COALESCE(last_accessed_at, created_at) DESC`,
  ).all(...noiseList) as { name: string }[];

  // Recent noise entities — fill up to cap of 200 for those who want to see them
  const noiseRows = db.prepare(
    `SELECT name FROM entities WHERE type IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`,
  ).all(...noiseList) as { name: string }[];

  const allNames = [...signalRows, ...noiseRows].map((r) => r.name);
  const entities = allNames.map((n) => kg.getEntity(n)).filter(Boolean) as Entity[];

  const relations = db.prepare(`
    SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
  `).all() as GraphRelation[];

  return { entities, relations, noiseTypes: noiseList };
}
