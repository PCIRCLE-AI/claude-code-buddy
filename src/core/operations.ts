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
import { hasSearchableTerms } from '../storage/fts-index.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import { embedAndStore, isEmbeddingAvailable, embedText, entityEmbedText, scheduleEmbedAndStore, vectorSearch, vectorSimilarity, MAX_VECTOR_DISTANCE } from './embedder.js';
import type { EmbedOutcome } from './embedder.js';
import { autoTagAndApply } from './auto-tagger.js';
import { hasVectorIndex } from '../storage/vector-index.js';
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
 * signal: first hit 1.0, last just above 0. Handing every hit the same value
 * instead would tie them on the 0.30 relevance factor and let `rankEntities`
 * re-sort purely on recency/frequency/confidence, discarding the ordering the
 * search just computed. Callers with no query pass an empty map — there is no
 * relevance signal on the recent-list path, and `rankEntities` already treats a
 * missing entry as the neutral 0.5.
 */
function buildRelevanceMap(entities: Entity[]): Map<string, number> {
  return new Map(entities.map((entity, index) => [entity.name, 1 - index / (entities.length + 1)]));
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
    title: args.title,
  });
  // `current`, not the snapshot taken before `createEntity`. The updater used
  // to ignore what it was handed and rebuild from `existing?.metadata`, which
  // silently discarded everything `createEntity` had just written — the
  // `previous_namespace` breadcrumb that makes a namespace move undoable, and
  // the `signal_score` every new entity is stamped with.
  //
  // No `?? existing?.metadata` fallback: `updateEntityMetadata` hands over
  // `parseMetadata(row.metadata)`, which returns `{}` for null, for non-object
  // JSON and for a parse failure — so `current` is never nullish, and a
  // fallback there would read as a safety net that cannot fire.
  kg.updateEntityMetadata(args.name, (current) => buildLocalMetadata(
    current as EntityMetadata,
    {
      trust: args.trustOverride,
      // source_host is stamped on FIRST insert only — `!existing` — because
      // buildLocalMetadata spreads these overrides over the stored provenance,
      // so stamping on every call would let host B's re-remember of host A's
      // entity silently rewrite the attribution this field exists to preserve.
      // Same invariant as the hook path (captureEntity's INSERT OR IGNORE),
      // and the one the CHANGELOG promises. source_host first so an explicit
      // provenanceOverride stays authoritative.
      provenance: {
        ...(args.sourceHost && !existing ? { source_host: args.sourceHost } : {}),
        ...(args.provenanceOverride ?? {}),
      },
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
    scheduleEmbedAndStore(entityId, entityEmbedText(args.name, args.observations));
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
    ...(args.title !== undefined ? { title: args.title } : {}),
    type: args.type,
    observations: args.observations?.length ?? 0,
    tags: args.tags?.length ?? 0,
    relations: relationsCreated.length,
    ...(relationsCreated.length > 0 ? { relationsCreated } : {}),
    // Only when it actually moved: same-scope re-remembers say nothing.
    ...(existing && args.namespace !== undefined && (existing.namespace ?? 'personal') !== args.namespace
      ? { movedFromNamespace: existing.namespace ?? 'personal' }
      : {}),
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
  const { entities, relevanceMap } = searchAndScore(args);
  return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}

/**
 * The half of recall that both entry points share: run the search, and turn its
 * output into the relevance input for `rankEntities`.
 *
 * `recall()` and `recallEnhanced()` differ only by the vector supplement, and
 * they had drifted apart before — the same one-line relevance change had to be
 * made twice, which is the signature of a copy waiting to diverge.
 */
function searchAndScore(args: RecallInput): { kg: KnowledgeGraph; entities: Entity[]; relevanceMap: Map<string, number> } {
  const kg = new KnowledgeGraph(getDatabase());
  // cross_project=true means don't filter by project tag — pass no tag to search all projects
  const entities = kg.search(args.query, {
    tag: recallTagFilter(args),
    limit: args.limit,
    includeArchived: args.include_archived,
    namespace: args.namespace,
  });
  return {
    kg,
    entities,
    relevanceMap: args.query ? buildRelevanceMap(entities) : new Map<string, number>(),
  };
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
 *
 * **A vector hit cannot outrank the best FTS hit, however certain it is.**
 * The two relevance values are not on the same scale: FTS relevance is
 * *positional* — `buildRelevanceMap` gives the top FTS row 1.0 no matter how
 * weak the match — while a vector hit's relevance is *absolute*, and a genuinely
 * good semantic match sits near 0.4. So this stays a supplement in the literal
 * sense: it can add rows the keyword search missed, and they will rank below
 * every strong keyword row.
 *
 * That is a real limit, not a tuning parameter. Measured over 100 LongMemEval
 * questions: of the 5 the keyword search missed, the vector index ranked the
 * correct session **#1** in three of them — and none surfaced in the top 5 at
 * any distance threshold. The fix for that is rank fusion (score both sides by
 * position, e.g. RRF), which was evaluated and NOT adopted here: on this corpus
 * it recovered 4 of the 5 misses and cost more elsewhere, R@5 95% → 92%.
 * LongMemEval's haystack is padded with generic public Q&A that scores high on
 * semantic similarity while being nobody's memory (METHODOLOGY.md §4.1), so it
 * is the wrong corpus to tune fusion on. Revisiting needs a set of personal
 * notes where the question's vocabulary differs from the note's.
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

    // Drop the overlap BEFORE hydrating. getEntitiesByIds issues four batched
    // queries per call (entities, observations, tags, relations), and FTS and
    // the vector index are searching the same query, so the overlap is the
    // common case — this used to fully hydrate up to `limit` rows complete
    // with observations and relations only for the next line to discard them.
    // Raising MAX_VECTOR_DISTANCE made it worse: the old threshold discarded
    // almost every hit before this loop, so it received nearly nothing and now
    // receives the full k.
    const alreadyMerged = new Set(merged.map(e => e.id));
    const hitIds = vectorHits.map(h => h.id).filter(id => !alreadyMerged.has(id));
    if (hitIds.length === 0) return;

    const hitEntities = kg.getEntitiesByIds(hitIds, {
      includeArchived: args.include_archived === true,
      namespace: args.namespace,
      tag: recallTagFilter(args),
    });

    // Still checked by name: two ids can carry the same entity name, and the
    // name is what relevanceMap is keyed on.
    const existingNames = new Set(merged.map(e => e.name));
    for (const entity of hitEntities) {
      if (existingNames.has(entity.name)) continue;
      const dist = vectorHits.find(h => h.id === entity.id)?.distance ?? MAX_VECTOR_DISTANCE;
      const relevance = vectorSimilarity(dist);
      // Provenance travels with the entity: a semantic-only hit cannot be
      // certified relevant (the junk/genuine distance distributions overlap
      // — see Entity.match), so every consumer gets to say HOW this row was
      // found instead of presenting geometry's best guess as a match.
      entity.match = { source: 'semantic', relevance };
      merged.push(entity);
      relevanceMap.set(entity.name, relevance);
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
 * (dreamer, failure-analyzer, auto-tagger, llm-validator)
 * are unaffected.
 */
export async function recallEnhanced(args: RecallInput): Promise<Entity[]> {
  const { kg, entities, relevanceMap } = searchAndScore(args);

  // Keyword provenance for the FTS side; the vector supplement below tags
  // its own additions as `semantic`. Only meaningful when there was a query
  // — the empty-query recent-list is a listing, not a match.
  if (args.query) {
    for (const e of entities) {
      e.match = { source: 'keyword', relevance: relevanceMap.get(e.name) ?? 0 };
    }
  }

  const mergedEntities = [...entities];
  // `hasSearchableTerms`, not merely a truthy string. A query like "???" is
  // truthy, so the vector supplement used to run for it and return up to
  // `limit` semantically-nearest memories even though the keyword side had
  // correctly found nothing — dressing "nothing matched" as "here is what
  // matched" on the one path the fix did not cover. An EMPTY query still means
  // "show me what you have" and is handled by search()'s recent-list branch,
  // which is why the check is on searchable terms rather than on emptiness.
  if (args.query && hasSearchableTerms(args.query)) {
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
      sourceHost: args.sourceHost,
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
      entity_found: result.entityFound,
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

export interface ReindexResult {
  processed: number;
  /** Entities that now have a vector because this run wrote one. */
  embedded: number;
  /** Every processed entity that did not get a vector written. */
  skipped: number;
  /** Why each one was skipped. The counts sum to `processed`. */
  outcomes: Record<EmbedOutcome | 'entity_missing' | 'nothing_to_embed', number>;
  /**
   * Entities this run tried to embed and could not: the provider produced no
   * vector, produced one of the wrong width, or the write failed.
   *
   * Separate from {@link missingVectors} because the two answer different
   * questions and only together answer the user's. `missingVectors` asks
   * "does every entity have A vector" — which a full index satisfies with the
   * OLD rows, so a run whose every write was refused reported itself complete
   * and exited 0. That is the case a provider switch produces, which is the
   * case the command exists for.
   *
   * Excludes `entity_missing` (deleted mid-run, owed nothing) and
   * `nothing_to_embed` (no text to embed, so no vector is owed — counting
   * those would hold `pending_reindex` open for the life of the database).
   */
  failed: number;
  /**
   * Entities THIS RUN was responsible for that have observation text but no
   * row in entities_vec, counted from the database after the run. The end
   * state, not a tally of what the loop believes it did — the loop's belief
   * being wrong is the whole reason this field exists.
   *
   * Scoped to the run's namespace, because it is what the caller is told about
   * and what the CLI's exit code is built on. A run that did everything it was
   * asked must not report failure because some OTHER namespace is unrelatedly
   * behind.
   */
  missingVectors: number;
  /**
   * The same count across the whole database, whatever namespace was asked
   * for. This is what decides the flag, and it is reported so that "I asked
   * for one namespace, it succeeded, and the flag is still set" has a visible
   * explanation instead of looking like a bug.
   */
  missingVectorsDatabaseWide: number;
  /** Whether `pending_reindex` was cleared. False means work remains. */
  pendingReindexCleared: boolean;
}

/**
 * Count active entities that ought to have a vector and do not.
 *
 * "Ought to" excludes entities whose observations are all blank: they can
 * never produce an embedding, so requiring one would keep `pending_reindex`
 * set forever and make `memesh doctor` nag about work that cannot be done.
 *
 * Called twice per run, and the two answers do different jobs. Scoped by
 * namespace, it is the verdict on what the caller actually asked for.
 * Unscoped, it decides `pending_reindex`, which describes the whole database —
 * reindexing one namespace must not clear a flag the others still justify.
 */
function countMissingVectors(
  db: ReturnType<typeof getDatabase>,
  namespace?: string
): number {
  // No sqlite-vec, no entities_vec, so no entity is OWED a vector — and the
  // query below would fail on the missing table rather than answer.
  if (!hasVectorIndex(db)) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM entities e
    WHERE e.status = 'active'
      ${namespace ? 'AND e.namespace = ?' : ''}
      AND EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND TRIM(o.content) <> '')
      AND NOT EXISTS (SELECT 1 FROM entities_vec v WHERE v.rowid = e.id)
  `).get(...(namespace ? [namespace] : [])) as { n: number };
  return row.n;
}

/**
 * Regenerate embeddings for all active entities.
 * Use after changing embedding provider or when vectors were lost during dimension migration.
 * Progress is logged to stderr.
 *
 * Note for callers: a returned `embedded` count is a count of vectors actually
 * written. It used to be a count of calls that did not throw, which is not the
 * same thing — `embedAndStore` returns normally when the provider gives back
 * nothing and when the dimension does not match, so a run that wrote zero
 * vectors reported every entity as embedded, cleared the flag, and printed a
 * tick. See {@link EmbedOutcome}.
 */
export async function reindex(opts?: { namespace?: string }): Promise<ReindexResult> {
  if (!isEmbeddingAvailable()) {
    throw new Error('No embedding provider configured, so there are no vectors to build. Run Ollama (or set an OpenAI API key) and set embedder.provider, then retry. Without an embedder, recall runs on FTS5 keyword search alone.');
  }

  const db = getDatabase();

  // An embedder without an index is still nothing to rebuild, and it is a
  // different problem with a different fix — so it gets its own sentence
  // rather than being folded into the message above.
  if (!hasVectorIndex(db)) {
    throw new Error('sqlite-vec is not loaded, so this database has no vector index to rebuild. Recall is running on FTS5 keyword search alone. Run `memesh doctor` — its "SQLite and vector search" row explains why the extension did not load on this machine.');
  }

  const kg = new KnowledgeGraph(db);

  // Get all active entities (optionally filtered by namespace)
  const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
  const params = opts?.namespace ? [opts.namespace] : [];

  const entities = db.prepare(
    `SELECT id, name FROM entities WHERE status = 'active' ${namespaceFilter} ORDER BY id`
  ).all(...params) as Array<{ id: number; name: string }>;

  const outcomes: ReindexResult['outcomes'] = {
    stored: 0,
    removed: 0,
    no_embedding: 0,
    dimension_mismatch: 0,
    write_failed: 0,
    database_closed: 0,
    entity_missing: 0,
    nothing_to_embed: 0,
    // reindex() refuses to start without an index, so this counter stays 0
    // here. It is in the map because the type is the full EmbedOutcome set and
    // a missing key would be a silent hole the next time an outcome is added.
    no_vector_index: 0,
  };
  let processed = 0;

  process.stderr.write(`MeMesh: Reindexing ${entities.length} entities...\n`);

  for (const entity of entities) {
    processed++;

    // Get full entity with observations
    const fullEntity = kg.getEntity(entity.name);
    if (!fullEntity) {
      outcomes.entity_missing++;
      continue;
    }

    // An entity with nothing but whitespace can never produce a vector, and
    // `countMissingVectors` already excludes it from what the database is owed.
    // Recognising it HERE too is what keeps the two halves of the verdict
    // asking the same question: without this the entity comes back as a
    // provider failure, and once failures block the flag that would leave
    // `pending_reindex` set forever for work nobody can do.
    //
    // The question is asked of the OBSERVATIONS alone, deliberately. The text
    // embedded below now carries the name too, and a name is never blank — so
    // testing the embedded text would answer "yes, embeddable" for every
    // entity, quietly re-owing exactly the rows `countMissingVectors` excludes.
    if (fullEntity.observations.join('').trim() === '') {
      outcomes.nothing_to_embed++;
      continue;
    }

    // Same text every other writer embeds — see entityEmbedText. This used to
    // be observations-only, which made an entity's vector depend on whether
    // remember() or reindex() wrote it last.
    const text = entityEmbedText(fullEntity.name, fullEntity.observations);

    try {
      outcomes[await embedAndStore(entity.id, text)]++;

      // Progress logging every 10 entities
      if (processed % 10 === 0) {
        process.stderr.write(
          `MeMesh: Processed ${processed}/${entities.length} ` +
          `(${outcomes.stored} embedded, ${processed - outcomes.stored} skipped)\n`
        );
      }
    } catch (err) {
      outcomes.write_failed++;
      process.stderr.write(`MeMesh: Failed to embed entity ${entity.name}: ${err}\n`);
    }
  }

  const embedded = outcomes.stored;
  const skipped = processed - embedded;

  // Every outcome that means "this entity was owed a vector and did not get
  // one". Named one by one rather than derived as `processed - stored -
  // benign`: a subtraction would sweep any future outcome into "failed"
  // whether or not it is one, and this number decides whether the user is told
  // the run worked.
  const failed =
    outcomes.no_embedding +
    outcomes.dimension_mismatch +
    outcomes.write_failed +
    outcomes.database_closed;

  // The database has the final say. If a vector is missing here, it is missing
  // regardless of what the loop counted.
  const missingVectors = countMissingVectors(db, opts?.namespace);
  const missingVectorsDatabaseWide = opts?.namespace
    ? countMissingVectors(db)
    : missingVectors;

  process.stderr.write(`MeMesh: Reindex complete. ${embedded}/${processed} entities embedded.\n`);
  if (outcomes.dimension_mismatch > 0) {
    process.stderr.write(
      `MeMesh: ${outcomes.dimension_mismatch} entities were skipped because the provider's ` +
      `embedding dimension does not match this database's vector index. Rebuild it with ` +
      `'memesh reindex --vectors'.\n`
    );
  }

  // Clear the dimension-change flag only once every entity that can have a
  // vector has one — database-wide, since that is what the flag describes —
  // AND nothing failed on the way. Clearing it after a run that wrote nothing
  // is what let a silently emptied index look healthy to `memesh doctor`, and
  // the row check alone cannot see that case when the index is already full:
  // the vectors it counts are the stale ones the run was meant to replace.
  const pendingReindexCleared = missingVectorsDatabaseWide === 0 && failed === 0;
  if (pendingReindexCleared) {
    clearPendingReindexFlag();
  } else if (missingVectorsDatabaseWide > 0) {
    process.stderr.write(
      `MeMesh: ${missingVectorsDatabaseWide} active memories still have no vector` +
      `${opts?.namespace ? ' (across all namespaces)' : ''}, so the ` +
      `reindex-needed flag was left set.\n`
    );
  } else {
    // Every entity holds a vector, yet embeds failed — so the ones on disk are
    // the stale vectors this run was asked to replace. Say that, rather than
    // "0 memories still have no vector", which reads as success.
    process.stderr.write(
      `MeMesh: every memory has a vector, but ${failed} could not be regenerated, ` +
      `so those still hold their previous embedding and the reindex-needed flag ` +
      `was left set.\n`
    );
  }

  return {
    processed,
    embedded,
    skipped,
    outcomes,
    failed,
    missingVectors,
    missingVectorsDatabaseWide,
    pendingReindexCleared,
  };
}
