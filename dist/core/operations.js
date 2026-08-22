import { getDatabase, clearPendingReindexFlag, markReindexOwed, getStoredEmbeddingDimension, beginVectorGeneration, generationRowIds, generationRowHashes, recordGenerationRow, swapVectorGeneration, GENERATION_TABLE, } from '../db.js';
import { createHash } from 'node:crypto';
import { hasSearchableTerms } from '../storage/fts-index.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import { embedAndStore, isEmbeddingAvailable, embedText, entityEmbedText, scheduleEmbedAndStore, vectorSearch, vectorSimilarity, MAX_VECTOR_DISTANCE } from './embedder.js';
import { autoTagAndApply } from './auto-tagger.js';
import { hasVectorIndex } from '../storage/vector-index.js';
import { detectCapabilities, getEmbeddingDimension } from './config.js';
function buildLocalMetadata(existingMetadata, overrides) {
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
function recallTagFilter(args) {
    return args.cross_project ? undefined : args.tag;
}
function buildRelevanceMap(entities) {
    return new Map(entities.map((entity, index) => [entity.name, 1 - index / (entities.length + 1)]));
}
export function remember(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const existing = db
        .prepare('SELECT id, namespace FROM entities WHERE name = ?')
        .get(args.name);
    const entityId = kg.createEntity(args.name, args.type, {
        observations: args.observations,
        tags: args.tags,
        namespace: args.namespace,
        trustOverride: args.trustOverride,
        title: args.title,
    });
    kg.updateEntityMetadata(args.name, (current) => buildLocalMetadata(current, {
        trust: args.trustOverride,
        provenance: {
            ...(args.sourceHost && !existing ? { source_host: args.sourceHost } : {}),
            ...(args.provenanceOverride ?? {}),
        },
    }));
    const relationsCreated = [];
    const relationErrors = [];
    if (args.relations) {
        for (const rel of args.relations) {
            try {
                kg.createRelation(args.name, rel.to, rel.type);
                relationsCreated.push(rel);
            }
            catch (err) {
                relationErrors.push(`Relation to "${rel.to}" failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    const superseded = [];
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
    const caps = detectCapabilities();
    if (isEmbeddingAvailable(caps) && args.observations?.length) {
        scheduleEmbedAndStore(entityId, entityEmbedText(args.name, args.observations), caps);
    }
    if ((!args.tags || args.tags.length === 0) && args.observations?.length) {
        if (caps.llm) {
            autoTagAndApply(entityId, args.name, args.type, args.observations, caps.llm, { fallbacks: caps.llmFallbacks }).catch((err) => {
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
        ...(existing && args.namespace !== undefined && (existing.namespace ?? 'personal') !== args.namespace
            ? { movedFromNamespace: existing.namespace ?? 'personal' }
            : {}),
        ...(superseded.length > 0 ? { superseded } : {}),
        ...(relationErrors.length > 0 ? { relationErrors } : {}),
    };
}
export function recall(args) {
    const { entities, relevanceMap } = searchAndScore(args);
    return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
}
function searchAndScore(args) {
    const kg = new KnowledgeGraph(getDatabase());
    const entities = kg.search(args.query, {
        tag: recallTagFilter(args),
        limit: args.limit,
        includeArchived: args.include_archived,
        namespace: args.namespace,
    });
    return {
        kg,
        entities,
        relevanceMap: args.query ? buildRelevanceMap(entities) : new Map(),
    };
}
async function supplementWithVectors(query, args, kg, merged, relevanceMap) {
    const caps = detectCapabilities();
    if (!isEmbeddingAvailable(caps))
        return 'unconfigured';
    try {
        const queryEmb = await embedText(query, caps);
        if (!queryEmb)
            return 'degraded';
        const storedDim = getStoredEmbeddingDimension();
        if (storedDim !== 0 && queryEmb.length !== storedDim)
            return 'degraded';
        const vectorHits = vectorSearch(queryEmb, args.limit ?? 20);
        if (vectorHits.length === 0)
            return 'used';
        const alreadyMerged = new Set(merged.map(e => e.id));
        const hitIds = vectorHits.map(h => h.id).filter(id => !alreadyMerged.has(id));
        if (hitIds.length === 0)
            return 'used';
        const hitEntities = kg.getEntitiesByIds(hitIds, {
            includeArchived: args.include_archived === true,
            namespace: args.namespace,
            tag: recallTagFilter(args),
        });
        const existingNames = new Set(merged.map(e => e.name));
        for (const entity of hitEntities) {
            if (existingNames.has(entity.name))
                continue;
            const dist = vectorHits.find(h => h.id === entity.id)?.distance ?? MAX_VECTOR_DISTANCE;
            const relevance = vectorSimilarity(dist);
            entity.match = { source: 'semantic', relevance };
            merged.push(entity);
            relevanceMap.set(entity.name, relevance);
        }
        return 'used';
    }
    catch {
        return 'degraded';
    }
}
export async function recallEnhanced(args) {
    const { kg, entities, relevanceMap } = searchAndScore(args);
    if (args.query) {
        for (const e of entities) {
            e.match = { source: 'keyword', relevance: relevanceMap.get(e.name) ?? 0 };
        }
    }
    const mergedEntities = [...entities];
    let vectorOutcome = 'unconfigured';
    if (args.query && hasSearchableTerms(args.query)) {
        vectorOutcome = await supplementWithVectors(args.query, args, kg, mergedEntities, relevanceMap);
    }
    const limit = args.limit ?? 20;
    const ranked = rankEntities(mergedEntities, relevanceMap).slice(0, limit);
    return {
        entities: ranked,
        retrieval: {
            mode: vectorOutcome === 'used' ? 'hybrid' : 'fts',
            degraded: vectorOutcome === 'degraded',
            truncated: ranked.length === limit,
        },
    };
}
export async function recallWithConflicts(args) {
    const { entities, retrieval } = await recallEnhanced(args);
    const kg = new KnowledgeGraph(getDatabase());
    const conflicts = kg.findConflicts(entities.map((e) => e.name));
    return { entities, conflicts, retrieval };
}
export { exportMemories, importMemories } from './serializer.js';
export function learn(args) {
    const projectName = getProjectName();
    const result = createExplicitLesson(args.error, args.fix, projectName, {
        rootCause: args.root_cause,
        prevention: args.prevention,
        severity: args.severity,
        sourceHost: args.sourceHost,
    });
    return {
        learned: true,
        name: result.name,
        type: 'lesson_learned',
    };
}
export function forget(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
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
    const result = kg.archiveEntity(args.name);
    if (!result.archived) {
        return { archived: false, message: `Entity "${args.name}" not found` };
    }
    return { archived: true, name: args.name };
}
export function setPinned(name, pinned) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const exists = db.prepare('SELECT 1 FROM entities WHERE name = ?').get(name);
    if (!exists)
        return { name, pinned, found: false };
    kg.updateEntityMetadata(name, (current) => {
        const next = { ...current };
        if (pinned)
            next.pin = true;
        else
            delete next.pin;
        return next;
    });
    return { name, pinned, found: true };
}
function countMissingVectors(db, namespace) {
    if (!hasVectorIndex(db))
        return 0;
    const row = db.prepare(`
    SELECT COUNT(*) AS n FROM entities e
    WHERE e.status = 'active'
      ${namespace ? 'AND e.namespace = ?' : ''}
      AND EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id
                    AND TRIM(o.content, ' ' || char(9) || char(10) || char(13) || char(11) || char(12) || char(160)) <> '')
      AND NOT EXISTS (SELECT 1 FROM entities_vec v WHERE v.rowid = e.id)
  `).get(...(namespace ? [namespace] : []));
    return row.n;
}
export async function reindex(opts) {
    if (!isEmbeddingAvailable()) {
        throw new Error('No embedding provider configured, so there are no vectors to build. Run Ollama (or set an OpenAI API key) and set embedder.provider, then retry. Without an embedder, recall runs on FTS5 keyword search alone.');
    }
    const db = getDatabase();
    if (!hasVectorIndex(db)) {
        throw new Error('sqlite-vec is not loaded, so this database has no vector index to rebuild. Recall is running on FTS5 keyword search alone. Run `memesh doctor` — its "SQLite and vector search" row explains why the extension did not load on this machine.');
    }
    let generation;
    let alreadyStaged = new Set();
    let stagedHashes = new Map();
    if (!opts?.namespace) {
        const targetDim = getEmbeddingDimension();
        const { resumed } = beginVectorGeneration(targetDim, detectCapabilities().embeddings);
        generation = { table: GENERATION_TABLE, dimension: targetDim };
        if (resumed) {
            alreadyStaged = generationRowIds();
            stagedHashes = generationRowHashes();
            process.stderr.write(`MeMesh: resuming an unfinished ${targetDim}-dim rebuild — ${alreadyStaged.size} entities already embedded, `
                + `so the provider is only asked for the rest.\n`);
        }
    }
    const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
    const params = opts?.namespace ? [opts.namespace] : [];
    const entities = db.prepare(`SELECT id, name FROM entities WHERE status = 'active' ${namespaceFilter} ORDER BY id`).all(...params);
    const outcomes = {
        stored: 0,
        removed: 0,
        no_embedding: 0,
        dimension_mismatch: 0,
        write_failed: 0,
        database_closed: 0,
        entity_missing: 0,
        nothing_to_embed: 0,
        already_staged: 0,
        no_vector_index: 0,
    };
    let processed = 0;
    const CONSECUTIVE_FAILURE_LIMIT = 5;
    let consecutiveFailures = 0;
    let abortedAfter = null;
    process.stderr.write(`MeMesh: Reindexing ${entities.length} entities...\n`);
    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id');
    for (const entity of entities) {
        processed++;
        const observations = obsStmt.all(entity.id)
            .map((o) => o.content);
        if (observations.length === 0) {
            const stillThere = db.prepare('SELECT 1 FROM entities WHERE id = ?').get(entity.id);
            if (!stillThere) {
                outcomes.entity_missing++;
                continue;
            }
        }
        if (observations.join('').trim() === '') {
            outcomes.nothing_to_embed++;
            continue;
        }
        const text = entityEmbedText(entity.name, observations);
        const textHash = createHash('sha256').update(text).digest('hex').slice(0, 32);
        try {
            if (alreadyStaged.has(entity.id) && stagedHashes.get(entity.id) === textHash) {
                outcomes.already_staged++;
                continue;
            }
            const outcome = await embedAndStore(entity.id, text, undefined, generation);
            outcomes[outcome]++;
            if (outcome === 'stored' && generation)
                recordGenerationRow(entity.id, textHash);
            if (outcome === 'stored') {
                consecutiveFailures = 0;
            }
            else if (outcome !== 'removed' && ++consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
                abortedAfter = processed;
                process.stderr.write(`MeMesh: stopping after ${CONSECUTIVE_FAILURE_LIMIT} consecutive failures at entity `
                    + `${processed}/${entities.length} — the provider is not answering usefully, and the `
                    + `remaining ${entities.length - processed} would fail the same way. Everything embedded `
                    + `so far is kept; run 'memesh reindex' again to continue from here.\n`);
                break;
            }
            if (processed % 10 === 0) {
                process.stderr.write(`MeMesh: Processed ${processed}/${entities.length} ` +
                    `(${outcomes.stored} embedded, ${processed - outcomes.stored} skipped)\n`);
            }
        }
        catch (err) {
            outcomes.write_failed++;
            process.stderr.write(`MeMesh: Failed to embed entity ${entity.name}: ${err}\n`);
        }
    }
    const embedded = outcomes.stored;
    const skipped = processed - embedded;
    const failed = outcomes.no_embedding +
        outcomes.dimension_mismatch +
        outcomes.write_failed +
        outcomes.database_closed;
    let generationSwapped = null;
    if (generation) {
        const stagedRows = generationRowIds().size;
        const expected = entities.length - outcomes.entity_missing - outcomes.nothing_to_embed - outcomes.removed;
        const complete = failed === 0 && abortedAfter === null && stagedRows >= expected;
        generationSwapped = complete;
        if (complete) {
            swapVectorGeneration(generation.dimension);
            process.stderr.write(`MeMesh: new ${generation.dimension}-dim index verified (${stagedRows} vectors) and switched in. `
                + `The previous index was replaced only after this check passed.\n`);
        }
        else {
            process.stderr.write(`MeMesh: the new index is incomplete (${stagedRows} of ${expected} vectors`
                + `${failed > 0 ? `, ${failed} failures` : ''}), so it was NOT switched in — `
                + `your existing index is untouched and still answering queries. `
                + `Run 'memesh reindex' again to continue from where this stopped; `
                + `the ${stagedRows} embeddings already produced are kept and will not be re-requested.\n`);
        }
    }
    const missingVectors = countMissingVectors(db, opts?.namespace);
    const missingVectorsDatabaseWide = opts?.namespace
        ? countMissingVectors(db)
        : missingVectors;
    process.stderr.write(`MeMesh: processed ${processed} entities; ${embedded} embedded this run.\n`);
    if (outcomes.dimension_mismatch > 0) {
        process.stderr.write(`MeMesh: ${outcomes.dimension_mismatch} entities were skipped because the provider's ` +
            `embedding dimension does not match this database's vector index. Rebuild it by ` +
            `running 'memesh reindex' with no --namespace: a full run builds the new width ` +
            `in a staging index and switches over once it is complete.\n`);
    }
    const pendingReindexCleared = missingVectorsDatabaseWide === 0 && failed === 0;
    if (pendingReindexCleared) {
        clearPendingReindexFlag();
    }
    else if (missingVectorsDatabaseWide > 0) {
        const owedWidth = getStoredEmbeddingDimension();
        markReindexOwed(owedWidth, owedWidth, 'vectors-missing');
        process.stderr.write(`MeMesh: ${missingVectorsDatabaseWide} active memories still have no vector` +
            `${opts?.namespace ? ' (across all namespaces)' : ''}, so the ` +
            `reindex-needed flag was left set.\n`);
    }
    else {
        process.stderr.write(`MeMesh: every memory has a vector, but ${failed} could not be regenerated, ` +
            `so those still hold their previous embedding and the reindex-needed flag ` +
            `was left set.\n`);
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
        generationSwapped,
        abortedAfter,
    };
}
//# sourceMappingURL=operations.js.map