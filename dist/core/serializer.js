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
export function importMemories(args) {
    if (!MERGE_STRATEGIES.includes(args.merge_strategy)) {
        throw new Error(`Unknown merge strategy "${args.merge_strategy}". Use one of: ${MERGE_STRATEGIES.join(', ')}. ` +
            'Nothing was imported — refusing rather than guessing, because the wrong guess overwrites existing memories.');
    }
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    let imported = 0;
    let skipped = 0;
    let appended = 0;
    const errors = [];
    for (const entity of args.data.entities) {
        try {
            const existing = kg.getEntity(entity.name);
            const namespace = args.namespace || entity.namespace || 'personal';
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