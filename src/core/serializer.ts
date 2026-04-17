// =============================================================================
// Serializer — export/import memory snapshots
// Extracted from operations.ts for single-responsibility
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { ExportInput, ExportResult, ImportInput, ImportResult } from './types.js';

/**
 * Export entities as a portable JSON snapshot for sharing or backup.
 * Optional tag and namespace filters narrow the export set.
 */
export function exportMemories(args: ExportInput): ExportResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  let entities = kg.search(undefined, {
    tag: args.tag,
    limit: args.limit || 1000,
    includeArchived: false,
  });

  // Filter by namespace if specified (search() doesn't filter by namespace)
  if (args.namespace) {
    entities = entities.filter((e) => (e.namespace ?? 'personal') === args.namespace);
  }

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

/**
 * Import entities from a JSON export snapshot.
 * merge_strategy controls how existing entities are handled:
 *   - 'skip': leave existing entities untouched, only create new ones
 *   - 'append': add observations to existing entities
 *   - 'overwrite': archive existing, then create fresh
 */
export function importMemories(args: ImportInput): ImportResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  let imported = 0;
  let skipped = 0;
  let appended = 0;
  const errors: string[] = [];

  for (const entity of args.data.entities) {
    try {
      const existing = kg.getEntity(entity.name);
      const namespace = args.namespace || entity.namespace || 'personal';

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
          });
          appended++;
          continue;
        }
        // overwrite: archive existing, then create fresh below
        kg.archiveEntity(entity.name);
      }

      kg.createEntity(entity.name, entity.type, {
        observations: entity.observations,
        tags: entity.tags,
        namespace,
      });

      // Create relations — target entity must exist; silently skip if not
      for (const rel of entity.relations || []) {
        try {
          kg.createRelation(entity.name, rel.to, rel.type);
        } catch {
          // Target may not have been imported yet or doesn't exist — skip silently
        }
      }

      imported++;
    } catch (err: any) {
      errors.push(`${entity.name}: ${err.message}`);
    }
  }

  return { imported, skipped, appended, errors };
}
