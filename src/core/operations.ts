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

import { getDatabase, clearPendingReindexFlag } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import { embedAndStore, isEmbeddingAvailable, embedText, scheduleEmbedAndStore, vectorSearch } from './embedder.js';
import { autoTagAndApply } from './auto-tagger.js';
import { detectCapabilities } from './config.js';
import path from 'path';
import type {
  RememberInput,
  RememberResult,
  RecallInput,
  ForgetInput,
  ForgetResult,
  LearnInput,
  LearnResult,
  Entity,
} from './types.js';

type EntityMetadata = {
  trust?: 'trusted' | 'untrusted';
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

function buildLocalMetadata(
  existingMetadata: EntityMetadata | undefined,
  overrides?: { trust?: 'trusted' | 'untrusted'; provenance?: Record<string, unknown> }
): EntityMetadata {
  return {
    ...(existingMetadata ?? {}),
    trust: overrides?.trust ?? 'trusted',
    provenance: {
      ...(existingMetadata?.provenance ?? {}),
      source: 'local',
      reviewed_at: new Date().toISOString(),
      ...(overrides?.provenance ?? {}),
    },
  };
}

function recallTagFilter(args: RecallInput): string | undefined {
  return args.cross_project ? undefined : args.tag;
}

/**
 * Store knowledge as an entity with observations, tags, and relations.
 * If entity exists, appends observations and dedupes tags.
 * If any relation has type "supersedes", auto-archives the target entity.
 */
export function remember(args: RememberInput): RememberResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);
  const existing = kg.getEntity(args.name);

  // Trust signal MUST arrive at createEntity time so the confidence-
  // bump gate (knowledge-graph.ts) can deny it for untrusted callers.
  // Codex review caught a P1 where the trust was being written via
  // updateEntityMetadata AFTER createEntity returned, leaving the gate
  // looking at undefined and defaulting to trusted.
  const entityId = kg.createEntity(args.name, args.type, {
    observations: args.observations,
    tags: args.tags,
    namespace: args.namespace,
    trustOverride: args.trustOverride,
  });
  kg.updateEntityMetadata(args.name, () => buildLocalMetadata(
    existing?.metadata as EntityMetadata | undefined,
    {
      trust: args.trustOverride,
      provenance: args.provenanceOverride,
    }
  ));

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

  // Fire-and-forget: generate embedding asynchronously (don't block sync remember)
  if (isEmbeddingAvailable() && args.observations?.length) {
    const text = `${args.name} ${args.observations.join(' ')}`;
    scheduleEmbedAndStore(entityId, text);
  }

  // Fire-and-forget: auto-generate tags if none provided and LLM is configured
  if ((!args.tags || args.tags.length === 0) && args.observations?.length) {
    const caps = detectCapabilities();
    if (caps.llm) {
      autoTagAndApply(entityId, args.name, args.type, args.observations, caps.llm).catch((err) => {
        // Log but don't fail the main operation - auto-tagging is optional
        console.warn('[memesh] Auto-tagging failed (non-critical):', err?.message ?? String(err));
      });
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
    tag: recallTagFilter(args),
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
 * Supplement an existing result set with vector-search hits.
 *
 * Shared by both recall paths (LLM-expanded and FTS5-only). Mutates
 * `merged` and `relevanceMap` in place. Skips entities already present
 * by name. Silently no-ops if embeddings are unavailable or the query
 * cannot be embedded — FTS5 results stay valid.
 *
 * Returns nothing; caller continues with the mutated arrays.
 */
async function supplementWithVectors(
  query: string,
  args: RecallInput,
  kg: KnowledgeGraph,
  merged: Entity[],
  relevanceMap: Map<string, number>,
): Promise<void> {
  if (!isEmbeddingAvailable()) return;
  try {
    const queryEmb = await embedText(query);
    if (!queryEmb) return;
    const vectorHits = vectorSearch(queryEmb, args.limit ?? 20);
    if (vectorHits.length === 0) return;

    const hitIds = vectorHits.map(h => h.id);
    const hitEntities = kg.getEntitiesByIds(hitIds, {
      includeArchived: args.include_archived === true,
      namespace: args.namespace,
      tag: recallTagFilter(args),
    });

    const existingNames = new Set(merged.map(e => e.name));
    for (const entity of hitEntities) {
      if (existingNames.has(entity.name)) continue;
      merged.push(entity);
      // Convert cosine distance to similarity (0=identical, 2=opposite).
      const dist = vectorHits.find(h => h.id === entity.id)?.distance ?? 1;
      relevanceMap.set(entity.name, Math.max(0, 1 - dist));
    }
  } catch {
    // Vector search failed — FTS5 + expanded results still valid.
  }
}

/**
 * Recall: FTS5 + sqlite-vec, no LLM in the hot path.
 *
 * The LLM-augmented variant (query expansion via `expandQuery`) was retired
 * after the LongMemEval-S benchmark confirmed Mode A (FTS5 + vector
 * supplement) holds at 95.40% R@5 — within 1.2pp of vendor-reported
 * MemPalace's vector+reranker stack — at 18ms/query. The query-expander
 * was paying ~500-10000ms per call (LLM round-trip + ollama fallback)
 * for an estimated 1-2pp ceiling lift, which lost decisively on the
 * UX axis given recall is the hot path for hooks (pre-edit-recall,
 * session-start) and MCP agent calls. Async/analysis LLM flows
 * (dreamer, consolidator, failure-analyzer, auto-tagger, llm-validator)
 * are unaffected.
 */
export async function recallEnhanced(args: RecallInput): Promise<Entity[]> {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  // cross_project=true means don't filter by project tag
  const entities = kg.search(args.query, {
    tag: recallTagFilter(args),
    limit: args.limit,
    includeArchived: args.include_archived,
    namespace: args.namespace,
  });

  // Build relevance map: FTS results get 1.0, recent-list gets 0.5
  const relevanceMap = new Map<string, number>();
  for (const e of entities) {
    relevanceMap.set(e.name, args.query ? 1.0 : 0.5);
  }

  const mergedEntities = [...entities];
  if (args.query) {
    await supplementWithVectors(args.query, args, kg, mergedEntities, relevanceMap);
  }
  return rankEntities(mergedEntities, relevanceMap).slice(0, args.limit ?? 20);
}

// --- Consolidation (extracted to consolidator.ts) ---
export { consolidate } from './consolidator.js';

// --- Serialization (extracted to serializer.ts) ---
export { exportMemories, importMemories } from './serializer.js';

// Noise compression (compressWeeklyNoise) is consumed only by
// session-start.js via dynamic import from dist/core/lifecycle.js, and
// by tests/core/lifecycle.test.ts which imports from lifecycle.js
// directly. No transport calls it. Re-exporting here was dead weight.

/**
 * Create a structured lesson_learned entity from explicit user input.
 * Does not require an LLM — the user provides the structured fields directly.
 * Uses createExplicitLesson from lesson-engine to build and store the entity.
 */
export function learn(args: LearnInput): LearnResult {
  const projectName = getProjectName();

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

/**
 * Regenerate embeddings for all active entities.
 * Use after changing embedding provider or when vectors were lost during dimension migration.
 * Progress is logged to stderr.
 */
export async function reindex(opts?: { namespace?: string }): Promise<{
  processed: number;
  embedded: number;
  skipped: number;
}> {
  if (!isEmbeddingAvailable()) {
    throw new Error('No embedding provider available. Configure OpenAI API key, Ollama, or install @huggingface/transformers.');
  }

  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  // Get all active entities (optionally filtered by namespace)
  const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
  const params = opts?.namespace ? [opts.namespace] : [];

  const entities = db.prepare(
    `SELECT id, name FROM entities WHERE status = 'active' ${namespaceFilter} ORDER BY id`
  ).all(...params) as Array<{ id: number; name: string }>;

  let processed = 0;
  let embedded = 0;
  let skipped = 0;

  process.stderr.write(`MeMesh: Reindexing ${entities.length} entities...\n`);

  for (const entity of entities) {
    processed++;

    // Get full entity with observations
    const fullEntity = kg.getEntity(entity.name);
    if (!fullEntity) {
      skipped++;
      continue;
    }

    // Concatenate all observations as embedding text
    const text = fullEntity.observations.join(' ');

    try {
      await embedAndStore(entity.id, text);
      embedded++;

      // Progress logging every 10 entities
      if (processed % 10 === 0) {
        process.stderr.write(`MeMesh: Processed ${processed}/${entities.length} (${embedded} embedded, ${skipped} skipped)\n`);
      }
    } catch (err) {
      skipped++;
      process.stderr.write(`MeMesh: Failed to embed entity ${entity.name}: ${err}\n`);
    }
  }

  process.stderr.write(`MeMesh: Reindex complete. ${embedded}/${processed} entities embedded.\n`);

  // Clear the dimension-change flag now that vectors are regenerated.
  clearPendingReindexFlag();

  return { processed, embedded, skipped };
}
