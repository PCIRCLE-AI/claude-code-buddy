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
 * Turn search results into the relevance input for `rankEntities`.
 *
 * `search()` returns FTS5 hits in BM25 order, so position carries the relevance
 * signal: first hit 1.0, last hit just above 0. Handing every hit the same 1.0
 * instead would tie them on the 0.30 relevance factor and let `rankEntities`
 * re-sort purely on recency/frequency/confidence — silently discarding the
 * ordering the search just computed. In a fresh database every other factor is
 * equal, so ties preserve order and the flattening is invisible; in an aged
 * memory base the newest match wins again. Empty queries take the recent-list
 * path, where there is no relevance signal at all, so they stay at a flat 0.5.
 */
function buildRelevanceMap(entities: Entity[], hasQuery: boolean): Map<string, number> {
  const relevanceMap = new Map<string, number>();
  entities.forEach((entity, index) => {
    relevanceMap.set(entity.name, hasQuery ? 1 - index / (entities.length + 1) : 0.5);
  });
  return relevanceMap;
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
      } catch (err) {
        relationErrors.push(`Relation to "${rel.to}" failed: ${err instanceof Error ? err.message : String(err)}`);
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
      autoTagAndApply(entityId, args.name, args.type, args.observations, caps.llm, { fallbacks: caps.llmFallbacks }).catch((err) => {
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
 * Results are ranked by multi-factor score: relevance (0.30, the BM25 position
 * `search()` returned them in), recency (0.25), access frequency (0.18),
 * confidence (0.17), recall-effectiveness impact (0.10).
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

  const relevanceMap = buildRelevanceMap(entities, Boolean(args.query));

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
    // Vector search failed — FTS5 results still valid.
  }
}

/**
 * Recall: FTS5 + sqlite-vec, no LLM in the hot path.
 *
 * The LLM-augmented variant (query expansion via `expandQuery`) was retired
 * after the LongMemEval-S benchmark showed FTS5 + vector supplement carries
 * the load without it. Note the 95.40% figure quoted elsewhere comes from
 * `benchmarks/longmemeval/run.mjs`, which re-implements retrieval and does not
 * call this function; measured through THIS function on the same 500 questions
 * the result is 95.60% R@5 (and was 5.20% before the retrieval fixes landed).
 * The query-expander
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

  const relevanceMap = buildRelevanceMap(entities, Boolean(args.query));

  const mergedEntities = [...entities];
  if (args.query) {
    await supplementWithVectors(args.query, args, kg, mergedEntities, relevanceMap);
  }
  return rankEntities(mergedEntities, relevanceMap).slice(0, args.limit ?? 20);
}

/**
 * recallEnhanced + conflict annotation. The MCP, HTTP, and CLI transports each
 * hand-rolled `recall → new KnowledgeGraph → findConflicts → wrap`; lifting it
 * here makes "recall results carry conflict annotations" a single core rule the
 * transports can't drift on. Always returns `conflicts` (possibly empty) — how
 * to present them (omit when empty, render inline, etc.) stays a transport call.
 */
export async function recallWithConflicts(args: RecallInput) {
  const entities = await recallEnhanced(args);
  const kg = new KnowledgeGraph(getDatabase());
  const conflicts = kg.findConflicts(entities.map((e) => e.name));
  return { entities, conflicts };
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
 * Pin or unpin an entity so the dreamer's compactor leaves it alone.
 *
 * The dreamer reads `metadata.pin === true` and skips pinned entities from
 * LLM compaction (`dreamer.ts`). That read existed with NO writer — nothing
 * could ever set the flag, so the "protected from compaction" guarantee was
 * inert and every entity was compactable regardless. This is the writer that
 * makes the guarantee real. Uses `updateEntityMetadata` so the rest of the
 * metadata (trust, provenance, signal_score) is preserved.
 */
export function setPinned(name: string, pinned: boolean): { name: string; pinned: boolean; found: boolean } {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const exists = db.prepare('SELECT 1 FROM entities WHERE name = ?').get(name);
  if (!exists) return { name, pinned, found: false };

  kg.updateEntityMetadata(name, (current) => {
    const next = { ...current };
    if (pinned) next.pin = true;
    else delete next.pin;
    return next;
  });

  return { name, pinned, found: true };
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
