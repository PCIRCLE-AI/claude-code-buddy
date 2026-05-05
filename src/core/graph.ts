// =============================================================================
// Graph — entities + relations for the dashboard graph view
// =============================================================================

import type Database from 'better-sqlite3';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { Entity } from './types.js';

export interface GraphRelation {
  from: string;
  to: string;
  type: string;
}

export interface GraphResult {
  entities: Entity[];
  relations: GraphRelation[];
}

export function computeGraph(db: Database.Database): GraphResult {
  const kg = new KnowledgeGraph(db);
  const entities = kg.listRecent(500, true); // include archived

  const relations = db.prepare(`
    SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
  `).all() as GraphRelation[];

  return { entities, relations };
}
