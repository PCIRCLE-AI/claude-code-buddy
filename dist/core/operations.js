import { getDatabase, clearPendingReindexFlag } from '../db.js';
import { hasSearchableTerms } from '../storage/fts-index.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import { embedAndStore, isEmbeddingAvailable, embedText, entityEmbedText, scheduleEmbedAndStore, vectorSearch, vectorSimilarity, MAX_VECTOR_DISTANCE } from './embedder.js';
import { autoTagAndApply } from './auto-tagger.js';
import { hasVectorIndex } from '../storage/vector-index.js';
import { detectCapabilities } from './config.js';
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
    const existing = kg.getEntity(args.name);
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
    if (isEmbeddingAvailable() && args.observations?.length) {
        scheduleEmbedAndStore(entityId, entityEmbedText(args.name, args.observations));
    }
    if ((!args.tags || args.tags.length === 0) && args.observations?.length) {
        const caps = detectCapabilities();
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
    if (!isEmbeddingAvailable())
        return;
    try {
        const queryEmb = await embedText(query);
        if (!queryEmb)
            return;
        const vectorHits = vectorSearch(queryEmb, args.limit ?? 20);
        if (vectorHits.length === 0)
            return;
        const alreadyMerged = new Set(merged.map(e => e.id));
        const hitIds = vectorHits.map(h => h.id).filter(id => !alreadyMerged.has(id));
        if (hitIds.length === 0)
            return;
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
    }
    catch {
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
    if (args.query && hasSearchableTerms(args.query)) {
        await supplementWithVectors(args.query, args, kg, mergedEntities, relevanceMap);
    }
    return rankEntities(mergedEntities, relevanceMap).slice(0, args.limit ?? 20);
}
export async function recallWithConflicts(args) {
    const entities = await recallEnhanced(args);
    const kg = new KnowledgeGraph(getDatabase());
    const conflicts = kg.findConflicts(entities.map((e) => e.name));
    return { entities, conflicts };
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
      AND EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND TRIM(o.content) <> '')
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
    const kg = new KnowledgeGraph(db);
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
        no_vector_index: 0,
    };
    let processed = 0;
    process.stderr.write(`MeMesh: Reindexing ${entities.length} entities...\n`);
    for (const entity of entities) {
        processed++;
        const fullEntity = kg.getEntity(entity.name);
        if (!fullEntity) {
            outcomes.entity_missing++;
            continue;
        }
        if (fullEntity.observations.join('').trim() === '') {
            outcomes.nothing_to_embed++;
            continue;
        }
        const text = entityEmbedText(fullEntity.name, fullEntity.observations);
        try {
            outcomes[await embedAndStore(entity.id, text)]++;
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
    const missingVectors = countMissingVectors(db, opts?.namespace);
    const missingVectorsDatabaseWide = opts?.namespace
        ? countMissingVectors(db)
        : missingVectors;
    process.stderr.write(`MeMesh: Reindex complete. ${embedded}/${processed} entities embedded.\n`);
    if (outcomes.dimension_mismatch > 0) {
        process.stderr.write(`MeMesh: ${outcomes.dimension_mismatch} entities were skipped because the provider's ` +
            `embedding dimension does not match this database's vector index. Rebuild it with ` +
            `'memesh reindex --vectors'.\n`);
    }
    const pendingReindexCleared = missingVectorsDatabaseWide === 0 && failed === 0;
    if (pendingReindexCleared) {
        clearPendingReindexFlag();
    }
    else if (missingVectorsDatabaseWide > 0) {
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
    };
}
//# sourceMappingURL=operations.js.map