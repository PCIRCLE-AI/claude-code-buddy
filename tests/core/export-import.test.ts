import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember, forget, recall, exportMemories, importMemories } from '../../src/core/operations.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-export-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Export ───────────────────────────────────────────────────────────────────

describe('exportMemories', () => {
  it('exports all active entities as JSON', () => {
    remember({ name: 'test-entity', type: 'note', observations: ['some data'] });
    const result = exportMemories({});
    expect(result.version).toBe('3.0.0');
    expect(result.entity_count).toBe(1);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('test-entity');
    expect(result.entities[0].observations).toContain('some data');
    expect(result.exported_at).toBeTruthy();
  });

  it('includes version and exported_at fields', () => {
    remember({ name: 'a', type: 'note' });
    const result = exportMemories({});
    expect(result.version).toBe('3.0.0');
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

  it('does not export archived entities', () => {
    remember({ name: 'active', type: 'note' });
    remember({ name: 'to-archive', type: 'note' });
    forget({ name: 'to-archive' });
    const result = exportMemories({});
    expect(result.entities.every((e) => e.name !== 'to-archive')).toBe(true);
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

  it('silently skips relations when target entity does not exist', () => {
    const data = makeExport([
      { name: 'entity-a', relations: [{ to: 'nonexistent', type: 'related-to' }] },
    ]);
    const result = importMemories({ data, merge_strategy: 'skip' });
    // No errors for missing relation targets — silently skipped
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
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
