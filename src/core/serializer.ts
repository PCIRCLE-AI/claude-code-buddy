// =============================================================================
// Serializer — export/import memory snapshots
// Extracted from operations.ts for single-responsibility
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { ExportInput, ExportResult, ImportInput, ImportResult } from './types.js';

type EntityMetadata = {
  trust?: 'trusted' | 'untrusted';
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

function buildImportedMetadata(
  existingMetadata: EntityMetadata | undefined,
  args: { exportedAt: string; importVersion: string; mergeStrategy: ImportInput['merge_strategy'] }
): EntityMetadata {
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

/**
 * Export entities as a portable JSON snapshot for sharing or backup.
 * Optional tag and namespace filters narrow the export set.
 */
export function exportMemories(args: ExportInput): ExportResult {
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

/**
 * Import entities from a JSON export snapshot.
 * merge_strategy controls how existing entities are handled:
 *   - 'skip': leave existing entities untouched, only create new ones
 *   - 'append': add observations to existing entities
 *   - 'overwrite': clear existing data, then re-populate
 *
 * An unrecognised strategy is REFUSED, not defaulted. This used to be two
 * `if`s and a fall-through, so any other string — a typo like `sikp`, or
 * `safe` — took the overwrite path: the most destructive of the three, on the
 * least information. Measured: `--merge bogus` against an existing entity
 * reported "Imported: 1", exit 0, replaced the observation and archived
 * nothing to restore it from.
 */
const MERGE_STRATEGIES = ['skip', 'overwrite', 'append'] as const;

/**
 * What is wrong with one entry of a bundle, in words, or null if nothing is.
 *
 * The import path used to hand whatever it found straight to SQLite. An entry
 * missing `type` produced `Provided value cannot be bound to SQLite parameter
 * 2` — a message about the storage layer's argument list, for a user who has a
 * JSON file in front of them and no way to map one to the other.
 */
function describeInvalidEntity(entity: unknown, index: number): string | null {
  const where = `entities[${index}]`;
  if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
    return `${where} is ${Array.isArray(entity) ? 'an array' : typeof entity}, not an object with "name" and "type".`;
  }
  const e = entity as Record<string, unknown>;
  for (const field of ['name', 'type'] as const) {
    if (typeof e[field] !== 'string' || e[field] === '') {
      return `${where} has no usable "${field}" (found ${e[field] === undefined ? 'nothing' : JSON.stringify(e[field])}).`;
    }
  }
  for (const field of ['observations', 'tags', 'relations'] as const) {
    if (e[field] !== undefined && !Array.isArray(e[field])) {
      return `${where}.${field} is ${typeof e[field]}, not an array.`;
    }
  }
  return null;
}

export function importMemories(args: ImportInput): ImportResult {
  if (!(MERGE_STRATEGIES as readonly string[]).includes(args.merge_strategy)) {
    throw new Error(
      `Unknown merge strategy "${args.merge_strategy}". Use one of: ${MERGE_STRATEGIES.join(', ')}. ` +
      'Nothing was imported — refusing rather than guessing, because the wrong guess overwrites existing memories.'
    );
  }

  // A bundle whose `entities` is not an array cannot be imported at all, and
  // the loop below would not have said so: `for…of` over a STRING iterates its
  // characters, so `"oops"` became four entities named `undefined`, and the
  // report came back as four `undefined: …` lines. A string is the likely
  // shape here — someone JSON-encoded the array twice.
  const bundleEntities = (args.data as { entities?: unknown } | null | undefined)?.entities;
  if (!Array.isArray(bundleEntities)) {
    throw new Error(
      `This file has no "entities" array (found ${bundleEntities === undefined ? 'nothing' : typeof bundleEntities}). ` +
      'Nothing was imported. memesh import expects a file produced by `memesh export`.'
    );
  }

  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  let imported = 0;
  let skipped = 0;
  let appended = 0;
  const errors: string[] = [];

  for (const [index, entity] of args.data.entities.entries()) {
    const invalid = describeInvalidEntity(entity, index);
    if (invalid) {
      errors.push(invalid);
      continue;
    }
    try {
      const existing = kg.getEntity(entity.name);
      // The caller's `--namespace` override applies to everything, existing
      // entities included — that is what "force all imported entities into
      // this namespace" means. The namespace stored IN the bundle only places
      // entities the import creates: a bundle should not be able to relocate a
      // memory you already had, which for `append` would silently move it out
      // of the scope you keep it in.
      const namespace = args.namespace ?? (existing ? undefined : (entity.namespace || 'personal'));
      const importedMetadata = buildImportedMetadata(existing?.metadata as EntityMetadata | undefined, {
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
          // Pass trustOverride directly so the createEntity confidence-
          // bump gate denies the lift on untrusted imports. Codex
          // caught a P1 where the trust value was being set via
          // updateEntityMetadata AFTER createEntity returned, so the
          // gate read undefined → defaulted to trusted → bumped.
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
        // overwrite: clear existing data, then re-populate below
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

      // Create relations — target entity must exist; silently skip if not
      for (const rel of entity.relations || []) {
        try {
          kg.createRelation(entity.name, rel.to, rel.type);
        } catch {
          // Target may not have been imported yet or doesn't exist — skip silently
        }
      }

      imported++;
    } catch (err) {
      errors.push(`${entity.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported, skipped, appended, errors };
}
