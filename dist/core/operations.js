import { getDatabase, clearPendingReindexFlag } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { rankEntities } from './scoring.js';
import { getProjectName } from './paths.js';
import { createExplicitLesson } from './lesson-engine.js';
import { embedAndStore, isEmbeddingAvailable, embedText, scheduleEmbedAndStore, vectorSearch } from './embedder.js';
import { autoTagAndApply } from './auto-tagger.js';
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
    });
    kg.updateEntityMetadata(args.name, () => buildLocalMetadata(existing?.metadata, {
        trust: args.trustOverride,
        provenance: args.provenanceOverride,
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
        const text = `${args.name} ${args.observations.join(' ')}`;
        scheduleEmbedAndStore(entityId, text);
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
        type: args.type,
        observations: args.observations?.length ?? 0,
        tags: args.tags?.length ?? 0,
        relations: relationsCreated.length,
        ...(superseded.length > 0 ? { superseded } : {}),
        ...(relationErrors.length > 0 ? { relationErrors } : {}),
    };
}
export function recall(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const entities = kg.search(args.query, {
        tag: recallTagFilter(args),
        limit: args.limit,
        includeArchived: args.include_archived,
        namespace: args.namespace,
    });
    const relevanceMap = args.query ? buildRelevanceMap(entities) : new Map();
    return rankEntities(entities, relevanceMap).slice(0, args.limit ?? 20);
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
        const hitIds = vectorHits.map(h => h.id);
        const hitEntities = kg.getEntitiesByIds(hitIds, {
            includeArchived: args.include_archived === true,
            namespace: args.namespace,
            tag: recallTagFilter(args),
        });
        const existingNames = new Set(merged.map(e => e.name));
        for (const entity of hitEntities) {
            if (existingNames.has(entity.name))
                continue;
            merged.push(entity);
            const dist = vectorHits.find(h => h.id === entity.id)?.distance ?? 1;
            relevanceMap.set(entity.name, Math.max(0, 1 - dist));
        }
    }
    catch {
    }
}
export async function recallEnhanced(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const entities = kg.search(args.query, {
        tag: recallTagFilter(args),
        limit: args.limit,
        includeArchived: args.include_archived,
        namespace: args.namespace,
    });
    const relevanceMap = args.query ? buildRelevanceMap(entities) : new Map();
    const mergedEntities = [...entities];
    if (args.query) {
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
export { consolidate } from './consolidator.js';
export { exportMemories, importMemories } from './serializer.js';
export function learn(args) {
    const projectName = getProjectName();
    const result = createExplicitLesson(args.error, args.fix, projectName, {
        rootCause: args.root_cause,
        prevention: args.prevention,
        severity: args.severity,
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
export async function reindex(opts) {
    if (!isEmbeddingAvailable()) {
        throw new Error('No embedding provider available. Configure OpenAI API key, Ollama, or install @huggingface/transformers.');
    }
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
    const params = opts?.namespace ? [opts.namespace] : [];
    const entities = db.prepare(`SELECT id, name FROM entities WHERE status = 'active' ${namespaceFilter} ORDER BY id`).all(...params);
    let processed = 0;
    let embedded = 0;
    let skipped = 0;
    process.stderr.write(`MeMesh: Reindexing ${entities.length} entities...\n`);
    for (const entity of entities) {
        processed++;
        const fullEntity = kg.getEntity(entity.name);
        if (!fullEntity) {
            skipped++;
            continue;
        }
        const text = fullEntity.observations.join(' ');
        try {
            await embedAndStore(entity.id, text);
            embedded++;
            if (processed % 10 === 0) {
                process.stderr.write(`MeMesh: Processed ${processed}/${entities.length} (${embedded} embedded, ${skipped} skipped)\n`);
            }
        }
        catch (err) {
            skipped++;
            process.stderr.write(`MeMesh: Failed to embed entity ${entity.name}: ${err}\n`);
        }
    }
    process.stderr.write(`MeMesh: Reindex complete. ${embedded}/${processed} entities embedded.\n`);
    clearPendingReindexFlag();
    return { processed, embedded, skipped };
}
//# sourceMappingURL=operations.js.map