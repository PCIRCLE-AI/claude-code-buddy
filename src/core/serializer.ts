// =============================================================================
// Serializer — export/import memory snapshots
// Extracted from operations.ts for single-responsibility
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { truncateTitle } from './title.js';
import { parseSqliteUtcMs } from './time-utils.js';
import { NAMESPACES } from './types.js';
import type { ExportInput, ExportResult, ImportInput, ImportResult } from './types.js';

type EntityMetadata = {
  trust?: 'trusted' | 'untrusted';
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

function buildImportedMetadata(
  existingMetadata: EntityMetadata | undefined,
  args: {
    exportedAt: string;
    importVersion: string;
    mergeStrategy: ImportInput['merge_strategy'];
    /** What the BUNDLE said, which is attacker-controlled in the general case. */
    bundled?: Record<string, unknown>;
  }
): EntityMetadata {
  // `guard` is dropped, deliberately and by name.
  //
  // Every other metadata field describes the memory. `guard` describes
  // memesh's BEHAVIOUR: an enabled guard makes `guard-check` match a regex
  // against the user's Bash commands and print a message of the guard
  // author's choosing before the tool runs. A JSON file the user was sent
  // must not be able to install one — that is a different kind of trust from
  // "here are some memories", and importing it would be the one place a
  // bundle could change what memesh DOES rather than what it knows.
  //
  // A denylist of one rather than an allowlist, because the rest of the
  // shape is open-ended by design (`task_state`, `signal_score`, whatever a
  // future release adds) and an allowlist would silently drop it. Anything
  // added later that carries authority has to be added here too — that is
  // the cost, and it is written down rather than left implicit.
  const { guard: _guard, ...bundledSafe } = (args.bundled ?? {}) as Record<string, unknown>;
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

/**
 * Export entities as a portable JSON snapshot for sharing or backup.
 * Optional tag and namespace filters narrow the export set.
 */
export function exportMemories(args: ExportInput): ExportResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const limit = args.limit || 1000;
  const entities = kg.search(undefined, {
    tag: args.tag,
    // One MORE than asked for, so "there is more" is a fact rather than an
    // inference. `entities.length === limit` cannot tell a graph of exactly
    // `limit` memories from one that was cut short, and it is the cut-short
    // case that matters: measured on a real graph of 1272 memories, the
    // default export carried 1000 and reported `✅ Exported 1000 entities`,
    // so a backup was missing 21% of the thing it was taken to preserve and
    // said nothing. The extra row costs one query, not a second copy of the
    // filter.
    limit: limit + 1,
    // Archived memories ARE part of a backup. They were skipped, so
    // `memesh forget` followed by an export and a restore brought the
    // memory back to life — the one operation whose whole purpose is to
    // take something out of circulation, undone by the one operation whose
    // whole purpose is to preserve state faithfully.
    includeArchived: true,
    namespace: args.namespace,
    // A backup is not a use. Without this, `memesh export` bumped
    // `access_count` and stamped `last_accessed_at = now` on up to a
    // thousand memories — 20% of the ranking — so the act of taking a backup
    // re-sorted the graph and made every exported memory look freshly
    // relevant on the day the backup ran. `listByType` draws the same line
    // by simply never calling trackAccess.
    countAsAccess: false,
  });

  const truncated = entities.length > limit;
  const exported = truncated ? entities.slice(0, limit) : entities;

  return {
    version: '3.1.0',
    exported_at: new Date().toISOString(),
    entity_count: exported.length,
    // Carried in the RESULT, not printed by the CLI alone: the MCP and HTTP
    // callers export too, and an agent taking a backup on the user's behalf
    // is exactly who must not be told a truncated bundle is the whole graph.
    truncated,
    entities: exported.map((e) => ({
      name: e.name,
      type: e.type,
      // The bundle carries `title` because without it the round trip is not a
      // round trip: export → import silently dropped every human-readable
      // title, and the import reported the entity as imported while it came
      // back with nothing but its slug-shaped name in every surface that shows
      // a title. Written explicitly as `null` when absent rather than omitted,
      // so a reader can tell "no title" from "this bundle predates titles".
      title: e.title ?? null,
      namespace: e.namespace ?? 'personal',
      // `created_at` is not a detail. It drives recency in ranking, the
      // dreamer's weekly clustering, `memesh why`, and every "what was I
      // doing then" question — and without it a restore stamped every
      // memory with the day of the restore, flattening the whole timeline
      // into one instant.
      created_at: e.created_at,
      // Only when it is not the default, so an ordinary bundle stays the
      // shape a reader already knows.
      ...(e.archived ? { status: 'archived' } : {}),
      // Everything memesh knows that is not the text: provenance,
      // `signal_score`, `task_state`, the demo marker. Import rebuilds
      // trust and provenance for itself and refuses `guard`.
      ...(e.metadata ? { metadata: e.metadata } : {}),
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
  // The namespace a bundle carries per entity places the entities an import
  // CREATES, and it was unchecked while the caller's override became an enum.
  // So a bundle — which over MCP is content an agent may have been handed —
  // could still write memories into a scope no filter selects: invisible to
  // every scoped recall, to `export --namespace`, and to the memory tool,
  // while squatting the name database-wide so a later legitimate create of it
  // is refused. Reported per entity rather than thrown, so one bad row does
  // not cost the whole bundle.
  if (e.namespace !== undefined && !(NAMESPACES as readonly string[]).includes(e.namespace as string)) {
    return `${where}.namespace is ${JSON.stringify(e.namespace)}, which is not one of: ${NAMESPACES.join(', ')}.`;
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

  // The namespace override MOVES entities that already exist, so an
  // unrecognised value does not merely mis-file new rows — it relocates
  // existing memories into a scope no filter matches, and they vanish from
  // every scoped view while the import reports them appended. `ImportSchema`
  // validates this field as `z.string().max(50)` rather than the enum
  // `remember` uses, so MCP and HTTP callers reach here with anything; the CLI
  // is the only transport that checked. Checking in core covers all three.
  if (args.namespace !== undefined && !(NAMESPACES as readonly string[]).includes(args.namespace)) {
    throw new Error(
      `Unknown namespace "${args.namespace}". Use one of: ${NAMESPACES.join(', ')}. ` +
      'Nothing was imported — an unrecognised namespace would move existing memories somewhere nothing queries.'
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
  /** Of `imported`, how many REPLACED an entity that already existed
   *  (merge_strategy 'overwrite' hitting a name already in the graph) —
   *  destructive, versus a genuinely new entity. Both used to increment
   *  the same `imported` counter, so "Imported: 4" printed identically
   *  whether it overwrote four existing memories or created four new
   *  ones from nothing. */
  let overwritten = 0;
  /** (from, to, type) triples held back until every entity exists. */
  const pendingRelations: Array<{ from: string; to: string; type: string }> = [];
  let skipped = 0;
  let appended = 0;
  const errors: string[] = [];
  /** Relations whose target is not in the bundle and not already stored. */
  const skippedRelations: string[] = [];
  /** Compiled once: a restore can create up to `limit` entities (1000). */
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
      // The import never read a title, because the export never wrote one —
      // the two halves of the same gap, and together they made every
      // export→import a silent rename of each memory to its slug-shaped
      // `name`. Read defensively, the way describeInvalidEntity reads the rest
      // of the bundle: this is a FILE, possibly written by a memesh that had
      // no titles at all, so the field is present-or-not rather than
      // guaranteed. Absent, blank or non-string becomes `undefined`, which is
      // createEntity's "leave whatever title is already there alone" — an
      // older bundle's missing title must not wipe one off a memory the
      // importer already had. `truncateTitle` because this is a generator-side
      // writer with nobody to bounce bad input back to (schemas.ts REJECTS
      // over-long titles; createEntity itself caps nothing), and one
      // hand-edited 10,000-character title should not become a stored one.
      const bundledTitle = (entity as Record<string, unknown>).title;
      const title = typeof bundledTitle === 'string' && bundledTitle.trim().length > 0
        ? truncateTitle(bundledTitle)
        : undefined;
      // The caller's `--namespace` override applies to everything, existing
      // entities included — that is what "force all imported entities into
      // this namespace" means. The namespace stored IN the bundle only places
      // entities the import creates: a bundle should not be able to relocate a
      // memory you already had, which for `append` would silently move it out
      // of the scope you keep it in.
      const namespace = args.namespace ?? (existing ? undefined : (entity.namespace || 'personal'));
      const importedMetadata = buildImportedMetadata(existing?.metadata as EntityMetadata | undefined, {
        bundled: (entity as { metadata?: Record<string, unknown> }).metadata,
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
          // Exact-text dedupe against what the entity already has.
          // `createEntity` INSERTs every observation it is handed with no
          // dedupe of its own — correct for `remember`, where a caller
          // stating the same fact again may be a deliberate re-assertion,
          // but wrong for import, whose whole point is merging a bundle
          // that may already have been imported once (the same backup
          // restored twice, or two bundles that share entities). Without
          // this, re-running `import --merge append` on the same file
          // grows every shared entity's observation list without bound —
          // dogfooded: the same sentence duplicated on every re-run.
          const existingText = new Set(existing.observations);
          const newObservations = (entity.observations ?? []).filter((o) => !existingText.has(o));
          // Pass trustOverride directly so the createEntity confidence-
          // bump gate denies the lift on untrusted imports. Codex
          // caught a P1 where the trust value was being set via
          // updateEntityMetadata AFTER createEntity returned, so the
          // gate read undefined → defaulted to trusted → bumped.
          kg.createEntity(entity.name, entity.type, {
            title,
            observations: newObservations,
            tags: entity.tags,
            namespace,
            trustOverride: 'untrusted',
          });
          // MERGE, never replace. An updater that ignores `current` rebuilds the
          // column from a snapshot taken before `createEntity` ran, discarding
          // whatever it just wrote — which now includes the
          // `previous_namespace` breadcrumb recorded when `--namespace` moves an
          // entity that already exists. Import is the one path where losing that
          // matters most: it moves entities in bulk, so a user cannot possibly
          // remember where each one came from.
          kg.updateEntityMetadata(entity.name, (current) => ({ ...current, ...importedMetadata }));
          appended++;
          continue;
        }
        // overwrite: clear existing data, then re-populate below
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

      // Relations are DEFERRED to a second pass. They used to be created
      // here, inside the per-entity loop, with the comment "target may not
      // have been imported yet — skip silently". That is not an edge case,
      // it is the ordinary outcome: `export` writes newest-first
      // (`ORDER BY id DESC`) and a relation almost always points from a
      // newer memory to an older one, so the target is still further down
      // the file. A backup of a graph with relations therefore restored
      // with NONE of them, reporting "Imported: N" and nothing else.
      for (const rel of entity.relations || []) {
        pendingRelations.push({ from: entity.name, to: rel.to, type: rel.type });
      }

      // `created_at` and `status`, restored only for entities this import
      // CREATED. An entity the importer already had keeps its own creation
      // time and its own archived-or-not state: a bundle may bring memories,
      // never rewrite the history of one you already keep.
      //
      // The timestamp is accepted only if `parseSqliteUtcMs` vouches for it.
      // That parser exists because a value it cannot read is a value nothing
      // downstream can order (see `kg-backfill` Rule 5), and it also closes
      // the door on a hand-edited bundle stamping a memory in the future,
      // where a negative age passes every recency check.
      if (!existing) {
        const bundledCreatedAt = (entity as { created_at?: unknown }).created_at;
        const bundledMs = typeof bundledCreatedAt === 'string'
          ? parseSqliteUtcMs(bundledCreatedAt)
          : null;
        if (bundledMs !== null) {
          // Stored in the COLUMN's format, not the bundle's. `parseSqliteUtcMs`
          // accepts either separator, so a bundle carrying `...T...` validates
          // and would be written back verbatim — recreating the two-format
          // column that `demo.ts` was just fixed to stop producing, and that
          // every `datetime(col)` workaround downstream exists to survive.
          // One writer, one format.
          setCreatedAt.run(new Date(bundledMs).toISOString().replace('T', ' ').slice(0, 19), entity.name);
        }
        if ((entity as { status?: unknown }).status === 'archived') {
          kg.archiveEntity(entity.name);
        }
      }

      imported++;
      if (existing) overwritten++;
    } catch (err) {
      errors.push(`${entity.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Second pass: every entity in the bundle now exists, so a relation that
  // still cannot be created is genuinely pointing outside it. That is real
  // information loss and it is REPORTED — the old code could not tell the
  // two cases apart, so it had to swallow both.
  //
  // Reported, but NOT an error. A relation leaving the bundle is a property
  // of the bundle, not a failure of the import: any `--tag`/`--namespace`
  // filter produces them, and so does a bundle cut short by `--limit`. Put
  // in `errors` they set exit 1, which turns the round trip this project
  // documents — `memesh export > b.json && memesh import b.json` — into a
  // failing command on a restore that did exactly what it should. Measured:
  // a full backup of a 1272-memory graph restored 1000 entities and 142 of
  // 151 relations, and exited 1.
  for (const rel of pendingRelations) {
    if (!entityExists.get(rel.to)) {
      skippedRelations.push(`${rel.from} -${rel.type}-> ${rel.to}`);
      continue;
    }
    try {
      kg.createRelation(rel.from, rel.to, rel.type);
    } catch (err) {
      errors.push(
        `${rel.from} -${rel.type}-> ${rel.to}: relation not restored `
        + `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return { imported, overwritten, skipped, appended, errors, skipped_relations: skippedRelations };
}
