// =============================================================================
// Graph — entities + relations for the dashboard graph view
// =============================================================================

import type { MemeshDatabase } from '../storage/sqlite.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { Entity } from './types.js';
import { NOISE_TYPES } from './analytics.js';
import { WORK_LAYER_TYPES } from './work-topology.js';

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

// =============================================================================
// Two-layer view (UX-4): the work layer up front, evidence on demand
// =============================================================================

export interface WorkGraphResult {
  /** Work-layer entities only (`WORK_LAYER_TYPES` — the single whitelist). */
  entities: Entity[];
  /** Relations whose BOTH endpoints are work-layer entities. */
  relations: GraphRelation[];
  /**
   * Work-node name → count of incoming `evidences` edges. Only nodes with
   * at least one edge appear; absence means zero, and zero is an honest
   * answer — `memesh kg backfill` is what draws these edges.
   */
  evidenceCounts: Record<string, number>;
}

export function computeWorkGraph(db: MemeshDatabase): WorkGraphResult {
  const kg = new KnowledgeGraph(db);
  const workTypes = Array.from(WORK_LAYER_TYPES);
  const placeholders = workTypes.map(() => '?').join(',');

  const rows = db.prepare(
    `SELECT id FROM entities WHERE type IN (${placeholders}) AND status = 'active'
     ORDER BY COALESCE(last_accessed_at, created_at) DESC`,
  ).all(...workTypes) as { id: number }[];
  const entities = kg.getEntitiesByIds(rows.map((r) => r.id));

  const relations = db.prepare(`
    SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
    WHERE e_from.type IN (${placeholders}) AND e_to.type IN (${placeholders})
  `).all(...workTypes, ...workTypes) as GraphRelation[];

  const countRows = db.prepare(`
    SELECT e_to.name AS name, COUNT(*) AS n
    FROM relations r
    JOIN entities e_to ON r.to_entity_id = e_to.id
    JOIN entities e_from ON r.from_entity_id = e_from.id
    WHERE r.relation_type = 'evidences'
      AND e_to.type IN (${placeholders})
      AND e_from.status = 'active'
    GROUP BY e_to.name
  `).all(...workTypes) as Array<{ name: string; n: number }>;
  const evidenceCounts: Record<string, number> = {};
  for (const row of countRows) evidenceCounts[row.name] = row.n;

  return { entities, relations, evidenceCounts };
}

/** Drill-down page size. Large enough for every real node measured so far;
 *  the flag says when it was not. */
const EVIDENCE_CAP = 200;

export interface NodeEvidenceResult {
  /** Evidence entities carrying an `evidences` edge to the node, newest first. */
  entities: Entity[];
  /** The `evidences` relations connecting them to the node. */
  relations: GraphRelation[];
  /** True when more evidence exists than the cap returned (R2 honesty rule). */
  truncated: boolean;
}

/** Returns null when the node itself does not exist (a 404, not an empty list). */
export function computeNodeEvidence(db: MemeshDatabase, nodeName: string): NodeEvidenceResult | null {
  const node = db.prepare('SELECT id, name FROM entities WHERE name = ?').get(nodeName) as
    | { id: number; name: string }
    | undefined;
  if (!node) return null;

  const kg = new KnowledgeGraph(db);
  // Fetch cap+1 so `truncated` reports observed overflow, not a guess.
  const rows = db.prepare(`
    SELECT e.id
    FROM relations r
    JOIN entities e ON r.from_entity_id = e.id
    WHERE r.relation_type = 'evidences' AND r.to_entity_id = ?
      AND e.status = 'active'
    ORDER BY e.created_at DESC
    LIMIT ${EVIDENCE_CAP + 1}
  `).all(node.id) as { id: number }[];

  const truncated = rows.length > EVIDENCE_CAP;
  const entities = kg.getEntitiesByIds(rows.slice(0, EVIDENCE_CAP).map((r) => r.id));
  const relations: GraphRelation[] = entities.map((e) => ({
    from: e.name,
    to: node.name,
    type: 'evidences',
  }));

  return { entities, relations, truncated };
}
