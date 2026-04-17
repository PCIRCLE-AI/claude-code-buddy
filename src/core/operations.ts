// =============================================================================
// Core Operations — pure business logic, no MCP/transport dependencies
// Imported by: transports/mcp, transports/http, transports/cli
//
// Contracts:
//   - No Zod validation (transports handle that)
//   - No ToolResult wrapping (transports handle that)
//   - No top-level try/catch (transports handle errors)
//   - Returns typed results directly
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { expandQuery, isExpansionAvailable } from './query-expander.js';
import { rankEntities } from './scoring.js';
import { createExplicitLesson } from './lesson-engine.js';
import path from 'path';
import type {
  RememberInput,
  RememberResult,
  RecallInput,
  ForgetInput,
  ForgetResult,
  ExportInput,
  ExportResult,
  ImportInput,
  ImportResult,
  LearnInput,
  LearnResult,
  Entity,
} from './types.js';

/**
 * Store knowledge as an entity with observations, tags, and relations.
 * If entity exists, appends observations and dedupes tags.
 * If any relation has type "supersedes", auto-archives the target entity.
 */
export function remember(args: RememberInput): RememberResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const entityId = kg.createEntity(args.name, args.type, {
    observations: args.observations,
    tags: args.tags,
    namespace: args.namespace,
  });

  // Create relations (target entities must already exist)
  const relationsCreated: Array<{ to: string; type: string }> = [];
  const relationErrors: string[] = [];

  if (args.relations) {
    for (const rel of args.relations) {
      try {
        kg.createRelation(args.name, rel.to, rel.type);
        relationsCreated.push(rel);
      } catch (err: any) {
        relationErrors.push(`Relation to "${rel.to}" failed: ${err.message}`);
      }
    }
  }

  // Auto-archive entities that are superseded
  const superseded: string[] = [];
  if (args.relations) {
    for (const rel of relationsCreated) {
      if (rel.type === 'supersedes') {
        const archiveResult = kg.archiveEntity(rel.to);
        if (archiveResult.archived) {
          superseded.push(rel.to);
        }
      }
    }
  }

  return {
    stored: true,
    entityId,
    name: args.name,
    type: args.type,
    observations: args.observations?.length ?? 0,
    tags: args.tags?.length ?? 0,
    relations: relationsCreated.length,
    ...(superseded.length > 0 ? { superseded } : {}),
    ...(relationErrors.length > 0 ? { relationErrors } : {}),
  };
}

/**
 * Search and retrieve stored knowledge.
 * Uses FTS5 full-text search with optional tag filtering.
 * Results are ranked by multi-factor score (recency, frequency, confidence, temporal validity).
 * Empty query returns recent entities.
 */
export function recall(args: RecallInput): Entity[] {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  // cross_project=true means don't filter by project tag — pass no tag to search all projects
  const entities = kg.search(args.query, {
    tag: args.cross_project ? undefined : args.tag,
    limit: args.limit,
    includeArchived: args.include_archived,
    namespace: args.namespace,
  });

  // Build relevance map: FTS results get 1.0 relevance, recent-list gets 0.5
  const relevanceMap = new Map<string, number>();
  for (const e of entities) {
    relevanceMap.set(e.name, args.query ? 1.0 : 0.5);
  }

  return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}

/**
 * Enhanced recall with optional LLM query expansion (async, Level 1).
 * When an LLM is configured, expands the query into related terms before searching.
 * Merges results from all expanded terms, de-duped by entity name.
 * Results are ranked by multi-factor score (relevance, recency, frequency, confidence, temporal validity).
 * Falls back to regular sync recall if expansion is unavailable or fails.
 */
export async function recallEnhanced(args: RecallInput): Promise<Entity[]> {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  if (args.query && isExpansionAvailable()) {
    try {
      const expandedTerms = await expandQuery(args.query);
      // Search with each expanded term and merge results (de-duped by name).
      // First term (original query) gets 1.0 relevance, expanded terms get 0.7.
      const allResults = new Map<string, Entity>();
      const relevanceMap = new Map<string, number>();

      for (let i = 0; i < expandedTerms.length; i++) {
        const termRelevance = i === 0 ? 1.0 : 0.7;
        // cross_project=true means don't filter by project tag
        const results = kg.search(expandedTerms[i], {
          tag: args.cross_project ? undefined : args.tag,
          limit: args.limit,
          includeArchived: args.include_archived,
          namespace: args.namespace,
        });
        for (const entity of results) {
          if (!allResults.has(entity.name)) {
            allResults.set(entity.name, entity);
          }
          // Keep the highest relevance if found by multiple terms
          const existing = relevanceMap.get(entity.name) ?? 0;
          if (termRelevance > existing) {
            relevanceMap.set(entity.name, termRelevance);
          }
        }
      }

      const merged = [...allResults.values()];
      return rankEntities(merged, relevanceMap).slice(0, args.limit ?? 20);
    } catch {
      // Fallback to regular search on any expansion error
    }
  }

  // Level 0: regular FTS5 search (no LLM expansion)
  // cross_project=true means don't filter by project tag
  const entities = kg.search(args.query, {
    tag: args.cross_project ? undefined : args.tag,
    limit: args.limit,
    includeArchived: args.include_archived,
    namespace: args.namespace,
  });

  // Build relevance map: FTS results get 1.0, recent-list gets 0.5
  const relevanceMap = new Map<string, number>();
  for (const e of entities) {
    relevanceMap.set(e.name, args.query ? 1.0 : 0.5);
  }

  return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}

// --- Consolidation (extracted to consolidator.ts) ---
export { consolidate } from './consolidator.js';

/**
 * Export entities as a portable JSON snapshot for sharing or backup.
 * Optional tag and namespace filters narrow the export set.
 */
export function exportMemories(args: ExportInput): ExportResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  let entities = kg.search(undefined, {
    tag: args.tag,
    limit: args.limit || 1000,
    includeArchived: false,
  });

  // Filter by namespace if specified (search() doesn't filter by namespace)
  if (args.namespace) {
    entities = entities.filter((e) => (e.namespace ?? 'personal') === args.namespace);
  }

  return {
    version: '3.0.0',
    exported_at: new Date().toISOString(),
    entity_count: entities.length,
    entities: entities.map((e) => ({
      name: e.name,
      type: e.type,
      namespace: e.namespace ?? 'personal',
      observations: e.observations,
      tags: e.tags,
      relations: (e.relations || []).map((r) => ({ to: r.to, type: r.type })),
    })),
  };
}

/**
 * Import entities from a JSON export snapshot.
 * merge_strategy controls how existing entities are handled:
 *   - 'skip': leave existing entities untouched, only create new ones
 *   - 'append': add observations to existing entities
 *   - 'overwrite': archive existing, then create fresh
 */
export function importMemories(args: ImportInput): ImportResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  let imported = 0;
  let skipped = 0;
  let appended = 0;
  const errors: string[] = [];

  for (const entity of args.data.entities) {
    try {
      const existing = kg.getEntity(entity.name);
      const namespace = args.namespace || entity.namespace || 'personal';

      if (existing) {
        if (args.merge_strategy === 'skip') {
          skipped++;
          continue;
        }
        if (args.merge_strategy === 'append') {
          kg.createEntity(entity.name, entity.type, {
            observations: entity.observations,
            tags: entity.tags,
            namespace,
          });
          appended++;
          continue;
        }
        // overwrite: archive existing, then create fresh below
        kg.archiveEntity(entity.name);
      }

      kg.createEntity(entity.name, entity.type, {
        observations: entity.observations,
        tags: entity.tags,
        namespace,
      });

      // Create relations — target entity must exist; silently skip if not
      for (const rel of entity.relations || []) {
        try {
          kg.createRelation(entity.name, rel.to, rel.type);
        } catch {
          // Target may not have been imported yet or doesn't exist — skip silently
        }
      }

      imported++;
    } catch (err: any) {
      errors.push(`${entity.name}: ${err.message}`);
    }
  }

  return { imported, skipped, appended, errors };
}

/**
 * Create a structured lesson_learned entity from explicit user input.
 * Does not require an LLM — the user provides the structured fields directly.
 * Uses createExplicitLesson from lesson-engine to build and store the entity.
 */
export function learn(args: LearnInput): LearnResult {
  const projectName = path.basename(process.cwd());

  const result = createExplicitLesson(
    args.error,
    args.fix,
    projectName,
    {
      rootCause: args.root_cause,
      prevention: args.prevention,
      severity: args.severity,
    }
  );

  return {
    learned: true,
    name: result.name,
    type: 'lesson_learned',
  };
}

/**
 * Archive an entity (soft-delete) or remove a specific observation.
 * Never permanently deletes data.
 */
export function forget(args: ForgetInput): ForgetResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  // Observation-level forget: remove specific observation, keep entity active
  if (args.observation) {
    const result = kg.removeObservation(args.name, args.observation);
    return {
      observation_removed: result.removed,
      name: args.name,
      observation: args.observation,
      remaining_observations: result.remainingObservations,
    };
  }

  // Entity-level forget: archive (soft-delete)
  const result = kg.archiveEntity(args.name);

  if (!result.archived) {
    return { archived: false, message: `Entity "${args.name}" not found` };
  }

  return { archived: true, name: args.name };
}
