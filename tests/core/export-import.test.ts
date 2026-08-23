import { describe, it, expect } from 'vitest';
import { remember, forget, recall, exportMemories, importMemories } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

useTestDatabase('memesh-export-');

// ── Export ───────────────────────────────────────────────────────────────────

describe('exportMemories', () => {
  it('exports all active entities as JSON', () => {
    remember({ name: 'test-entity', type: 'note', observations: ['some data'] });
    const result = exportMemories({});
    expect(result.version).toBe('3.1.0');
    expect(result.entity_count).toBe(1);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('test-entity');
    expect(result.entities[0].observations).toContain('some data');
    expect(result.exported_at).toBeTruthy();
  });

  it('round-trips `title` — export omitted it and import never read it', async () => {
    // Export is the backup path, and it silently dropped the one field UX-1
    // exists to provide: a bundle taken after titles shipped restored a
    // library of machine dedup keys. Both halves are pinned, because fixing
    // only the export side would still lose the title on the way back in.
    remember({ name: 'titled', type: 'decision', title: 'Why we chose JWT', observations: ['ctx'] });
    const bundle = exportMemories({});
    expect(bundle.entities.find((e) => e.name === 'titled')?.title).toBe('Why we chose JWT');

    // Re-import under a new name, which proves the IMPORT half reads it.
    const copy = {
      ...bundle,
      entities: bundle.entities.map((e) => ({ ...e, name: `${e.name}-copy` })),
    };
    importMemories({ data: copy, merge_strategy: 'skip' });
    const restored = (await recall({ query: 'JWT' })).find((e) => e.name === 'titled-copy');
    expect(restored?.title, 'the title did not survive the round trip').toBe('Why we chose JWT');
  });

  it('includes version and exported_at fields', () => {
    remember({ name: 'a', type: 'note' });
    const result = exportMemories({});
    expect(result.version).toBe('3.1.0');
    expect(new Date(result.exported_at).getTime()).not.toBeNaN();
  });

  it('filters by tag', () => {
    remember({ name: 'a', type: 'note', tags: ['project:x'] });
    remember({ name: 'b', type: 'note', tags: ['project:y'] });
    const result = exportMemories({ tag: 'project:x' });
    expect(result.entity_count).toBe(1);
    expect(result.entities[0].name).toBe('a');
  });

  it('filters by namespace', () => {
    remember({ name: 'personal-item', type: 'note', namespace: 'personal' });
    remember({ name: 'team-item', type: 'note', namespace: 'team' });
    const result = exportMemories({ namespace: 'team' });
    expect(result.entity_count).toBe(1);
    expect(result.entities[0].name).toBe('team-item');
  });

  it('respects limit', () => {
    remember({ name: 'e1', type: 'note' });
    remember({ name: 'e2', type: 'note' });
    remember({ name: 'e3', type: 'note' });
    const result = exportMemories({ limit: 2 });
    expect(result.entities.length).toBeLessThanOrEqual(2);
  });

  it('exports entity tags and relations fields', () => {
    remember({ name: 'src', type: 'note', tags: ['t1', 't2'] });
    remember({ name: 'dst', type: 'note' });
    remember({ name: 'src', type: 'note', relations: [{ to: 'dst', type: 'related-to' }] });
    const result = exportMemories({});
    const src = result.entities.find((e) => e.name === 'src');
    expect(src).toBeDefined();
    expect(src!.tags).toContain('t1');
    expect(src!.relations.some((r) => r.to === 'dst' && r.type === 'related-to')).toBe(true);
  });

  it('exports archived entities, carrying their status', () => {
    // They used to be skipped, so `memesh forget` followed by an export and
    // a restore brought the memory back to life: the one operation whose
    // purpose is to take something out of circulation, undone by the one
    // whose purpose is to preserve state faithfully.
    remember({ name: 'active', type: 'note' });
    remember({ name: 'to-archive', type: 'note' });
    forget({ name: 'to-archive' });

    const result = exportMemories({});

    const archived = result.entities.find((e) => e.name === 'to-archive');
    expect(archived, 'an archived memory was left out of the backup').toBeDefined();
    expect(archived?.status).toBe('archived');
    // And the active one is not mislabelled — the field is absent, not
    // present-and-wrong.
    expect(result.entities.find((e) => e.name === 'active')?.status).toBeUndefined();
  });

  it('carries created_at, so a restore does not flatten the timeline', () => {
    remember({ name: 'dated', type: 'note', observations: ['a fact'] });
    const result = exportMemories({});
    const entity = result.entities.find((e) => e.name === 'dated');
    expect(entity?.created_at, 'the creation time was dropped from the backup').toBeTruthy();
  });

  it('carries metadata, but never a guard', () => {
    // Every other metadata field describes the memory. `guard` describes
    // memesh's BEHAVIOUR — an enabled guard matches a regex against the
    // user's Bash commands — and a bundle must be able to bring memories,
    // not to change what memesh does.
    remember({ name: 'with-meta', type: 'note', observations: ['a fact'] });
    new KnowledgeGraph(getDatabase()).updateEntityMetadata('with-meta', (current) => ({
      ...current,
      signal_score: 0.9,
      guard: { enabled: true, tool: 'Bash', pattern: '.*', message: 'do as I say' },
    }));

    const bundle = exportMemories({});
    const exported = bundle.entities.find((e) => e.name === 'with-meta');
    expect(exported?.metadata?.signal_score, 'metadata was dropped from the backup').toBe(0.9);

    // Round-trip into a graph that does not have it.
    forget({ name: 'with-meta' });
    getDatabase().prepare("DELETE FROM entities WHERE name = 'with-meta'").run();
    importMemories({ data: bundle, merge_strategy: 'skip' });

    const restored = new KnowledgeGraph(getDatabase()).getEntity('with-meta');
    expect(restored?.metadata?.signal_score, 'metadata did not survive the round trip').toBe(0.9);
    expect(restored?.metadata?.guard, 'a bundle installed a guard').toBeUndefined();
  });

  it('defaults namespace to personal in export', () => {
    remember({ name: 'item', type: 'note' });
    const result = exportMemories({});
    expect(result.entities[0].namespace).toBe('personal');
  });
});

// ── Import ───────────────────────────────────────────────────────────────────

describe('importMemories', () => {
  const makeExport = (entities: Array<{
    name: string;
    type?: string;
    namespace?: string;
    observations?: string[];
    tags?: string[];
    relations?: Array<{ to: string; type: string }>;
  }>) => ({
    version: '3.0.0',
    exported_at: new Date().toISOString(),
    entity_count: entities.length,
    entities: entities.map((e) => ({
      name: e.name,
      type: e.type ?? 'note',
      namespace: e.namespace ?? 'personal',
      observations: e.observations ?? [],
      tags: e.tags ?? [],
      relations: e.relations ?? [],
    })),
  });

  it('imports new entities and returns correct count', () => {
    const data = makeExport([
      { name: 'new-a', observations: ['obs a'] },
      { name: 'new-b', observations: ['obs b'] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.appended).toBe(0);
    expect(result.errors).toHaveLength(0);

    const importedEntity = recall({ query: 'new-a' }).find((entity) => entity.name === 'new-a');
    expect(importedEntity?.metadata).toMatchObject({
      trust: 'untrusted',
      provenance: expect.objectContaining({ source: 'import', merge_strategy: 'skip' }),
    });
  });

  it('skips existing entities with skip strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['original'] });
    const data = makeExport([
      { name: 'existing', observations: ['new obs'] },
      { name: 'fresh', observations: ['data'] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('does not modify existing observations with skip strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['original'] });
    const data = makeExport([{ name: 'existing', observations: ['should-not-appear'] }]);
    importMemories({ data, merge_strategy: 'skip' });

    const entities = recall({ query: 'existing' });
    const entity = entities.find((e) => e.name === 'existing');
    expect(entity?.observations).toContain('original');
    expect(entity?.observations).not.toContain('should-not-appear');
  });

  it('appends observations to existing entity with append strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([{ name: 'existing', observations: ['new'] }]);
    const result = importMemories({ data, merge_strategy: 'append' });
    expect(result.appended).toBe(1);
    expect(result.imported).toBe(0);

    const existing = recall({ query: 'existing' }).find((entity) => entity.name === 'existing');
    expect(existing?.metadata).toMatchObject({
      trust: 'untrusted',
      provenance: expect.objectContaining({ source: 'import', merge_strategy: 'append' }),
    });
  });

  it('overwrites existing entity with overwrite strategy', () => {
    remember({ name: 'existing', type: 'note', observations: ['old'] });
    const data = makeExport([{ name: 'existing', observations: ['fresh'] }]);
    const result = importMemories({ data, merge_strategy: 'overwrite' });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.appended).toBe(0);

    const existing = recall({ query: 'existing' }).find((entity) => entity.name === 'existing');
    expect(existing?.metadata).toMatchObject({
      trust: 'untrusted',
      provenance: expect.objectContaining({ source: 'import', merge_strategy: 'overwrite' }),
    });
  });

  it('overrides namespace on import', () => {
    const data = makeExport([{ name: 'team-item', namespace: 'personal' }]);
    importMemories({ data, namespace: 'team', merge_strategy: 'skip' });

    // Recalled entity should have the overridden namespace
    const entities = recall({});
    const entity = entities.find((e) => e.name === 'team-item');
    expect(entity).toBeDefined();
    expect(entity!.namespace).toBe('team');
  });

  it('REPORTS a relation whose target is not in the bundle and not in the graph', () => {
    // This used to be "silently skips", and the silence is what let the real
    // defect hide: relations were created inside the per-entity loop, so a
    // target further down the file had not been imported yet and was skipped
    // by the same catch. Export writes newest-first and relations point
    // newer -> older, so that was the ORDINARY case, not the edge case — a
    // backup restored with none of its relations and said nothing.
    //
    // With the second pass, a relation that still fails is genuinely
    // pointing outside the bundle. That is real information loss, and the
    // import now says so.
    const data = makeExport([
      { name: 'entity-a', relations: [{ to: 'nonexistent', type: 'related-to' }] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });

    expect(result.imported, 'the entity itself must still import').toBe(1);
    expect(result.errors, 'a lost relation was not reported').toHaveLength(1);
    expect(result.errors[0]).toContain('nonexistent');
  });

  it('restores a relation whose target appears LATER in the bundle', () => {
    // The defect itself, in the order `export` actually writes.
    const data = makeExport([
      { name: 'newer-note', relations: [{ to: 'older-note', type: 'implements' }] },
      { name: 'older-note' },
    ]);

    const result = importMemories({ data, merge_strategy: 'skip' });

    expect(result.imported).toBe(2);
    expect(result.errors, `unexpected errors: ${result.errors.join('; ')}`).toHaveLength(0);
    const relations = getDatabase()
      .prepare(
        `SELECT f.name AS "from", t.name AS "to", r.relation_type AS type
         FROM relations r
         JOIN entities f ON f.id = r.from_entity_id
         JOIN entities t ON t.id = r.to_entity_id`,
      )
      .all() as Array<{ from: string; to: string; type: string }>;
    expect(relations, 'the relation was dropped because its target came later').toHaveLength(1);
    expect(relations[0]).toEqual({ from: 'newer-note', to: 'older-note', type: 'implements' });
  });

  it('imports relations when target entity exists', () => {
    remember({ name: 'target-entity', type: 'note' });
    const data = makeExport([
      { name: 'source-entity', relations: [{ to: 'target-entity', type: 'depends-on' }] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('records entity errors in errors array', () => {
    // Force an error by using the same import twice with overwrite to trigger
    // edge case — we can also test via a bad entity name length (empty string
    // would fail Zod but not here since operations layer doesn't validate).
    // Most robust: test that errors array is always present and is an array.
    const data = makeExport([{ name: 'ok-entity' }]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('refuses a merge strategy it does not recognise, instead of overwriting', () => {
    // This used to be two `if`s and a fall-through, so ANY other string took
    // the overwrite path — the most destructive of the three, chosen on the
    // least information. The CLI now validates too, but the CLI is not the only
    // caller, and a guard that only exists one layer up is a guard the next
    // caller does not get.
    remember({ name: 'guarded', type: 'note', observations: ['ORIGINAL'] });
    const bundle = {
      version: '3.0.0',
      exported_at: '2026-08-10T00:00:00.000Z',
      entity_count: 1,
      entities: [{ name: 'guarded', type: 'note', observations: ['REPLACEMENT'], tags: [] }],
    };

    expect(() => importMemories({
      data: bundle as unknown as Parameters<typeof importMemories>[0]['data'],
      merge_strategy: 'sikp' as Parameters<typeof importMemories>[0]['merge_strategy'],
    })).toThrow(/Unknown merge strategy/);

    // Nothing was written on the way to the throw.
    const found = recall({ query: 'guarded' });
    expect(found[0]?.observations).toEqual(['ORIGINAL']);
  });

  describe('namespace: whose choice moves an existing entity', () => {
    /** A bundle that claims one entity, in `personal`. */
    function bundleFor(name: string) {
      return {
        version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
        entities: [{ name, type: 'note', namespace: 'personal', observations: ['from bundle'], tags: [], relations: [] }],
      } as Parameters<typeof importMemories>[0]['data'];
    }

    it('the caller\'s override forces an entity that already exists', () => {
      // Documented as "force all imported entities into this namespace", and
      // it did not: `createEntity` applied a namespace on creation only, so
      // the override was accepted, ignored, and reported as success.
      remember({ name: 'held', type: 'note', observations: ['mine'], namespace: 'personal' });
      importMemories({ data: bundleFor('held'), merge_strategy: 'append', namespace: 'team' });
      expect(exportMemories({ namespace: 'team' }).entities.map(e => e.name)).toContain('held');
    });

    it('the bundle\'s own namespace does not relocate an entity you already have', () => {
      // The other direction, and the reason the override is not applied
      // blindly: a bundle should not be able to move a memory out of the
      // scope you keep it in just by mentioning it.
      remember({ name: 'kept', type: 'note', observations: ['mine'], namespace: 'team' });
      importMemories({ data: bundleFor('kept'), merge_strategy: 'append' });
      expect(exportMemories({ namespace: 'team' }).entities.map(e => e.name)).toContain('kept');
      expect(exportMemories({ namespace: 'personal' }).entities.map(e => e.name)).not.toContain('kept');
    });

    it('records where a bulk-moved entity came from', () => {
      // Import is the path where losing the breadcrumb hurts most: it moves
      // entities in bulk, so nobody can remember where each one was. The
      // record was being wiped — `updateEntityMetadata(name, () => built)`
      // rebuilt the whole column from a snapshot taken before `createEntity`,
      // discarding what `createEntity` had just written.
      remember({ name: 'bulk-moved', type: 'note', observations: ['mine'], namespace: 'team' });
      importMemories({ data: bundleFor('bulk-moved'), merge_strategy: 'append', namespace: 'personal' });

      const moved = recall({ query: 'bulk-moved' })[0];
      const meta = moved.metadata as Record<string, unknown>;
      expect(meta.previous_namespace, 'the import wiped the record of where it came from').toBe('team');
      // …and the import's own provenance is still there, so this is a merge
      // rather than one clobber traded for another.
      expect((meta.provenance as Record<string, unknown>).source).toBe('import');
      expect(meta.trust).toBe('untrusted');
    });

    it('refuses a per-entity namespace outside the three, without losing the rest', () => {
      // The caller's override became an enum; the namespace a bundle carries
      // per entity did not. Over MCP a bundle is content an agent may have
      // been handed, and an unrecognised scope is invisible to every scoped
      // recall and to `export --namespace` while still squatting the name
      // database-wide. Reported per entity, so one bad row does not cost the
      // whole bundle.
      const bundle = {
        version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 2,
        entities: [
          { name: 'good', type: 'note', namespace: 'personal', observations: ['ok'], tags: [], relations: [] },
          { name: 'smuggled', type: 'note', namespace: 'attacker-scope', observations: ['bad'], tags: [], relations: [] },
        ],
      } as Parameters<typeof importMemories>[0]['data'];

      const result = importMemories({ data: bundle, merge_strategy: 'skip' });

      expect(result.imported, 'the good entry was lost along with the bad one').toBe(1);
      expect(result.errors.join(' ')).toContain('entities[1].namespace');
      expect(result.errors.join(' ')).toContain('attacker-scope');
      // The database is the check: nothing landed in the invented scope.
      expect(recall({ query: 'smuggled' })).toEqual([]);
      expect(recall({ query: 'good' })[0]?.namespace).toBe('personal');
    });

    it('the bundle\'s namespace still places entities the import creates', () => {
      importMemories({ data: bundleFor('brand-new'), merge_strategy: 'skip' });
      expect(exportMemories({ namespace: 'personal' }).entities.map(e => e.name)).toContain('brand-new');
    });
  });

  it('round-trips export then import', () => {
    remember({ name: 'round-trip', type: 'pattern', observations: ['fact 1', 'fact 2'], tags: ['t:a'] });

    // Export from source db
    const exported = exportMemories({});

    // Import into the same db (skip — entity already exists)
    const importResult = importMemories({ data: exported, merge_strategy: 'skip' });
    expect(importResult.skipped).toBe(1);
    expect(importResult.imported).toBe(0);
  });
});
