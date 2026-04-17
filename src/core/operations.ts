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
import type {
  RememberInput,
  RememberResult,
  RecallInput,
  ForgetInput,
  ForgetResult,
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
 * Empty query returns recent entities.
 */
export function recall(args: RecallInput): Entity[] {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  return kg.search(args.query, {
    tag: args.tag,
    limit: args.limit,
    includeArchived: args.include_archived,
  });
}

/**
 * Enhanced recall with optional LLM query expansion (async, Level 1).
 * When an LLM is configured, expands the query into related terms before searching.
 * Merges results from all expanded terms, de-duped by entity name.
 * Falls back to regular sync recall if expansion is unavailable or fails.
 */
export async function recallEnhanced(args: RecallInput): Promise<Entity[]> {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  if (args.query && isExpansionAvailable()) {
    try {
      const expandedTerms = await expandQuery(args.query);
      // Search with each expanded term and merge results (de-duped by name)
      const allResults = new Map<string, Entity>();

      for (const term of expandedTerms) {
        const results = kg.search(term, {
          tag: args.tag,
          limit: args.limit,
          includeArchived: args.include_archived,
        });
        for (const entity of results) {
          if (!allResults.has(entity.name)) {
            allResults.set(entity.name, entity);
          }
        }
      }

      return [...allResults.values()].slice(0, args.limit ?? 20);
    } catch {
      // Fallback to regular search on any expansion error
    }
  }

  // Level 0: regular FTS5 search (no LLM expansion)
  return kg.search(args.query, {
    tag: args.tag,
    limit: args.limit,
    includeArchived: args.include_archived,
  });
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
