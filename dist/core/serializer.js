import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { truncateTitle } from './title.js';
import { parseSqliteUtcMs } from './time-utils.js';
import { NAMESPACES } from './types.js';
function buildImportedMetadata(existingMetadata, args) {
    const { guard: _guard, ...bundledSafe } = (args.bundled ?? {});
    void _guard;
    return {
        ...(existingMetadata ?? {}),
        ...bundledSafe,
        trust: 'untrusted',
        provenance: {
            ...(existingMetadata?.provenance ?? {}),
            source: 'import',
            imported_at: new Date().toISOString(),
            exported_at: args.exportedAt,
            export_version: args.importVersion,
            merge_strategy: args.mergeStrategy,
        },
    };
}
export function exportMemories(args) {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const limit = args.limit || 1000;
    const entities = kg.search(undefined, {
        tag: args.tag,
        limit: limit + 1,
        includeArchived: true,
        namespace: args.namespace,
        countAsAccess: false,
    });
    const truncated = entities.length > limit;
    const exported = truncated ? entities.slice(0, limit) : entities;
    return {
        version: '3.1.0',
        exported_at: new Date().toISOString(),
        entity_count: exported.length,
        truncated,
        entities: exported.map((e) => ({
            name: e.name,
            type: e.type,
            title: e.title ?? null,
            namespace: e.namespace ?? 'personal',
            created_at: e.created_at,
            ...(e.archived ? { status: 'archived' } : {}),
            ...(e.metadata ? { metadata: e.metadata } : {}),
            observations: e.observations,
            tags: e.tags,
            relations: (e.relations || []).map((r) => ({ to: r.to, type: r.type })),
        })),
    };
}
const MERGE_STRATEGIES = ['skip', 'overwrite', 'append'];
function describeInvalidEntity(entity, index) {
    const where = `entities[${index}]`;
    if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
        return `${where} is ${Array.isArray(entity) ? 'an array' : typeof entity}, not an object with "name" and "type".`;
    }
    const e = entity;
    for (const field of ['name', 'type']) {
        if (typeof e[field] !== 'string' || e[field] === '') {
            return `${where} has no usable "${field}" (found ${e[field] === undefined ? 'nothing' : JSON.stringify(e[field])}).`;
        }
    }
    for (const field of ['observations', 'tags', 'relations']) {
        if (e[field] !== undefined && !Array.isArray(e[field])) {
            return `${where}.${field} is ${typeof e[field]}, not an array.`;
        }
    }
    if (e.namespace !== undefined && !NAMESPACES.includes(e.namespace)) {
        return `${where}.namespace is ${JSON.stringify(e.namespace)}, which is not one of: ${NAMESPACES.join(', ')}.`;
    }
    return null;
}
export function importMemories(args) {
    if (!MERGE_STRATEGIES.includes(args.merge_strategy)) {
        throw new Error(`Unknown merge strategy "${args.merge_strategy}". Use one of: ${MERGE_STRATEGIES.join(', ')}. ` +
            'Nothing was imported — refusing rather than guessing, because the wrong guess overwrites existing memories.');
    }
    if (args.namespace !== undefined && !NAMESPACES.includes(args.namespace)) {
        throw new Error(`Unknown namespace "${args.namespace}". Use one of: ${NAMESPACES.join(', ')}. ` +
            'Nothing was imported — an unrecognised namespace would move existing memories somewhere nothing queries.');
    }
    const bundleEntities = args.data?.entities;
    if (!Array.isArray(bundleEntities)) {
        throw new Error(`This file has no "entities" array (found ${bundleEntities === undefined ? 'nothing' : typeof bundleEntities}). ` +
            'Nothing was imported. memesh import expects a file produced by `memesh export`.');
    }
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    let imported = 0;
    let overwritten = 0;
    const pendingRelations = [];
    let skipped = 0;
    let appended = 0;
    const errors = [];
    const skippedRelations = [];
    const setCreatedAt = db.prepare('UPDATE entities SET created_at = ? WHERE name = ?');
    const entityExists = db.prepare('SELECT 1 FROM entities WHERE name = ?');
    for (const [index, entity] of args.data.entities.entries()) {
        const invalid = describeInvalidEntity(entity, index);
        if (invalid) {
            errors.push(invalid);
            continue;
        }
        try {
            const existing = kg.getEntity(entity.name);
            const bundledTitle = entity.title;
            const title = typeof bundledTitle === 'string' && bundledTitle.trim().length > 0
                ? truncateTitle(bundledTitle)
                : undefined;
            const namespace = args.namespace ?? (existing ? undefined : (entity.namespace || 'personal'));
            const importedMetadata = buildImportedMetadata(existing?.metadata, {
                bundled: entity.metadata,
                exportedAt: args.data.exported_at,
                importVersion: args.data.version,
                mergeStrategy: args.merge_strategy,
            });
            if (existing) {
                if (args.merge_strategy === 'skip') {
                    skipped++;
                    continue;
                }
                if (args.merge_strategy === 'append') {
                    const existingText = new Set(existing.observations);
                    const newObservations = (entity.observations ?? []).filter((o) => !existingText.has(o));
                    kg.createEntity(entity.name, entity.type, {
                        title,
                        observations: newObservations,
                        tags: entity.tags,
                        namespace,
                        trustOverride: 'untrusted',
                    });
                    kg.updateEntityMetadata(entity.name, (current) => ({ ...current, ...importedMetadata }));
                    appended++;
                    continue;
                }
                kg.clearEntityData(entity.name);
            }
            kg.createEntity(entity.name, entity.type, {
                title,
                observations: entity.observations,
                tags: entity.tags,
                metadata: importedMetadata,
                namespace,
                trustOverride: 'untrusted',
            });
            if (existing) {
                kg.updateEntityMetadata(entity.name, (current) => ({ ...current, ...importedMetadata }));
            }
            for (const rel of entity.relations || []) {
                pendingRelations.push({ from: entity.name, to: rel.to, type: rel.type });
            }
            if (!existing) {
                const bundledCreatedAt = entity.created_at;
                const bundledMs = typeof bundledCreatedAt === 'string'
                    ? parseSqliteUtcMs(bundledCreatedAt)
                    : null;
                if (bundledMs !== null) {
                    setCreatedAt.run(new Date(bundledMs).toISOString().replace('T', ' ').slice(0, 19), entity.name);
                }
                if (entity.status === 'archived') {
                    kg.archiveEntity(entity.name);
                }
            }
            imported++;
            if (existing)
                overwritten++;
        }
        catch (err) {
            errors.push(`${entity.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    for (const rel of pendingRelations) {
        if (!entityExists.get(rel.to)) {
            skippedRelations.push(`${rel.from} -${rel.type}-> ${rel.to}`);
            continue;
        }
        try {
            kg.createRelation(rel.from, rel.to, rel.type);
        }
        catch (err) {
            errors.push(`${rel.from} -${rel.type}-> ${rel.to}: relation not restored `
                + `(${err instanceof Error ? err.message : String(err)})`);
        }
    }
    return { imported, overwritten, skipped, appended, errors, skipped_relations: skippedRelations };
}
//# sourceMappingURL=serializer.js.map