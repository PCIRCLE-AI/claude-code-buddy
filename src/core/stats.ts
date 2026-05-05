// =============================================================================
// Stats — entity/observation/relation counts + distributions
// =============================================================================
//
// Pure read-only aggregation. Takes a Database, returns a typed shape.
// Used by the HTTP /v1/stats route. CLI/MCP can call it directly when a
// `memesh stats` command is added (currently only HTTP exposes this).

import type Database from 'better-sqlite3';
import type { CountRow } from './types.js';

export interface StatsResult {
  totalEntities: number;
  totalObservations: number;
  totalRelations: number;
  totalTags: number;
  typeDistribution: unknown[];
  tagDistribution: unknown[];
  statusDistribution: unknown[];
}

export function computeStats(db: Database.Database): StatsResult {
  const entities = db.prepare('SELECT COUNT(*) as c FROM entities').get() as CountRow;
  const observations = db.prepare('SELECT COUNT(*) as c FROM observations').get() as CountRow;
  const relations = db.prepare('SELECT COUNT(*) as c FROM relations').get() as CountRow;
  const tags = db.prepare('SELECT COUNT(DISTINCT tag) as c FROM tags').get() as CountRow;

  const typeDistribution = db.prepare(
    'SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC LIMIT 50',
  ).all();
  const tagDistribution = db.prepare(
    'SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC LIMIT 30',
  ).all();
  const statusDistribution = db.prepare(
    "SELECT status, COUNT(*) as count FROM entities GROUP BY status",
  ).all();

  return {
    totalEntities: entities.c,
    totalObservations: observations.c,
    totalRelations: relations.c,
    totalTags: tags.c,
    typeDistribution,
    tagDistribution,
    statusDistribution,
  };
}
