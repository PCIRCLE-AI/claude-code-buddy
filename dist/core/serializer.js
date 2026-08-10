import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
function buildImportedMetadata(existingMetadata, args) {
    return {
        ...(existingMetadata ?? {}),
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
    const entities = kg.search(undefined, {
        tag: args.tag,
        limit: args.limit || 1000,
        includeArchived: false,
        namespace: args.namespace,
    });
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
    return null;
}
export function importMemories(args) {
    if (!MERGE_STRATEGIES.includes(args.merge_strategy)) {
        throw new Error(`Unknown merge strategy "${args.merge_strategy}". Use one of: ${MERGE_STRATEGIES.join(', ')}. ` +
            'Nothing was imported — refusing rather than guessing, because the wrong guess overwrites existing memories.');
    }
    const bundleEntities = args.data?.entities;
    if (!Array.isArray(bundleEntities)) {
        throw new Error(`This file has no "entities" array (found ${bundleEntities === undefined ? 'nothing' : typeof bundleEntities}). ` +
            'Nothing was imported. memesh import expects a file produced by `memesh export`.');
    }
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    let imported = 0;
    let skipped = 0;
    let appended = 0;
    const errors = [];
    for (const [index, entity] of args.data.entities.entries()) {
        const invalid = describeInvalidEntity(entity, index);
        if (invalid) {
            errors.push(invalid);
            continue;
        }
        try {
            const existing = kg.getEntity(entity.name);
            const namespace = args.namespace ?? (existing ? undefined : (entity.namespace || 'personal'));
            const importedMetadata = buildImportedMetadata(existing?.metadata, {
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
                    kg.createEntity(entity.name, entity.type, {
                        observations: entity.observations,
                        tags: entity.tags,
                        namespace,
                        trustOverride: 'untrusted',
                    });
                    kg.updateEntityMetadata(entity.name, () => importedMetadata);
                    appended++;
                    continue;
                }
                kg.clearEntityData(entity.name);
            }
            kg.createEntity(entity.name, entity.type, {
                observations: entity.observations,
                tags: entity.tags,
                metadata: importedMetadata,
                namespace,
                trustOverride: 'untrusted',
            });
            if (existing) {
                kg.updateEntityMetadata(entity.name, () => importedMetadata);
            }
            for (const rel of entity.relations || []) {
                try {
                    kg.createRelation(entity.name, rel.to, rel.type);
                }
                catch {
                }
            }
            imported++;
        }
        catch (err) {
            errors.push(`${entity.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { imported, skipped, appended, errors };
}
//# sourceMappingURL=serializer.js.map