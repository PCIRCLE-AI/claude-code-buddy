import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember, recall, forget, learn, importMemories } from '../../src/core/operations.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ops-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Remember ────────────────────────────────────────────────────────────────

describe('Core Operations: remember', () => {
  it('stores entity and returns result with stored=true', () => {
    const result = remember({ name: 'test', type: 'note' });
    expect(result.stored).toBe(true);
    expect(result.name).toBe('test');
    expect(result.type).toBe('note');
  });

  it('returns a numeric entityId', () => {
    const result = remember({ name: 'test', type: 'note' });
    expect(typeof result.entityId).toBe('number');
    expect(result.entityId).toBeGreaterThan(0);
  });

  it('counts observations in result', () => {
    const result = remember({ name: 'test', type: 'note', observations: ['a', 'b'] });
    expect(result.observations).toBe(2);
  });

  it('counts tags in result', () => {
    const result = remember({ name: 'test', type: 'note', tags: ['tag:one', 'tag:two'] });
    expect(result.tags).toBe(2);
  });

  it('appends observations on duplicate entity', () => {
    remember({ name: 'test', type: 'note', observations: ['first'] });
    remember({ name: 'test', type: 'note', observations: ['second'] });

    const entities = recall({ query: 'first' });
    expect(entities).toHaveLength(1);
    expect(entities[0].observations).toContain('first');
    expect(entities[0].observations).toContain('second');
  });

  it('stores tags and counts relations', () => {
    remember({ name: 'target', type: 'pattern' });
    const result = remember({
      name: 'source',
      type: 'decision',
      tags: ['project:x'],
      relations: [{ to: 'target', type: 'implements' }],
    });
    expect(result.tags).toBe(1);
    expect(result.relations).toBe(1);
  });

  it('reports relation error without failing overall when target missing', () => {
    const result = remember({
      name: 'source',
      type: 'decision',
      relations: [{ to: 'nonexistent', type: 'related-to' }],
    });
    expect(result.stored).toBe(true);
    expect(result.relations).toBe(0);
    expect(result.relationErrors).toHaveLength(1);
  });

  it('auto-archives on supersedes relation', () => {
    remember({ name: 'old', type: 'decision', observations: ['old way'] });
    const result = remember({
      name: 'new',
      type: 'decision',
      observations: ['new way'],
      relations: [{ to: 'old', type: 'supersedes' }],
    });
    expect(result.superseded).toContain('old');

    // old should be invisible from normal recall
    const results = recall({ query: 'old way' });
    expect(results).toEqual([]);
  });

  it('superseded entity is visible with include_archived', () => {
    remember({ name: 'v1', type: 'decision', observations: ['v1 data'] });
    remember({
      name: 'v2',
      type: 'decision',
      observations: ['v2 data'],
      relations: [{ to: 'v1', type: 'supersedes' }],
    });

    const all = recall({ query: 'v1 data', include_archived: true });
    expect(all.length).toBeGreaterThanOrEqual(1);
    const found = all.find(e => e.name === 'v1');
    expect(found).toBeDefined();
    expect(found?.archived).toBe(true);
  });

  it('promotes imported memories back to trusted after local remember', () => {
    importMemories({
      merge_strategy: 'skip',
      data: {
        version: '3.0.0',
        exported_at: new Date().toISOString(),
        entity_count: 1,
        entities: [{
          name: 'shared-auth-decision',
          type: 'decision',
          namespace: 'team',
          observations: ['Imported bundle entry'],
          tags: ['project:test'],
          relations: [],
        }],
      },
    });

    remember({
      name: 'shared-auth-decision',
      type: 'decision',
      observations: ['Locally confirmed and updated'],
    });

    const entity = recall({ query: 'shared-auth-decision', include_archived: true })
      .find((result) => result.name === 'shared-auth-decision');
    expect(entity?.metadata).toMatchObject({
      trust: 'trusted',
      provenance: expect.objectContaining({ source: 'local' }),
    });
  });
});

// ── Recall ──────────────────────────────────────────────────────────────────

describe('Core Operations: recall', () => {
  beforeEach(() => {
    remember({ name: 'auth', type: 'decision', observations: ['Use OAuth'] });
    remember({ name: 'db', type: 'decision', observations: ['Use PostgreSQL'] });
  });

  it('searches by query text', () => {
    const results = recall({ query: 'OAuth' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('auth');
  });

  it('lists recent when no query provided', () => {
    const results = recall({});
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array when nothing matches', () => {
    const results = recall({ query: 'nonexistent-xyz-999' });
    expect(results).toEqual([]);
  });

  it('filters by tag', () => {
    remember({ name: 'a', type: 'test', tags: ['project:x'] });
    remember({ name: 'b', type: 'test', tags: ['project:y'] });
    const results = recall({ tag: 'project:x' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('a');
  });

  it('respects limit parameter', () => {
    const results = recall({ limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('excludes archived by default', () => {
    remember({ name: 'active', type: 'test', observations: ['keep'] });
    remember({ name: 'gone', type: 'test', observations: ['keep'] });
    forget({ name: 'gone' });

    const active = recall({ query: 'keep' });
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('active');
  });

  it('includes archived with include_archived=true', () => {
    remember({ name: 'archived-item', type: 'test', observations: ['unique-obs-xyz'] });
    forget({ name: 'archived-item' });

    expect(recall({ query: 'unique-obs-xyz' })).toHaveLength(0);
    expect(recall({ query: 'unique-obs-xyz', include_archived: true })).toHaveLength(1);
  });
});

// ── Forget ──────────────────────────────────────────────────────────────────

describe('Core Operations: forget', () => {
  it('archives entity and returns archived=true', () => {
    remember({ name: 'temp', type: 'note' });
    const result = forget({ name: 'temp' });
    expect(result.archived).toBe(true);
    expect(result.name).toBe('temp');
  });

  it('archived entity is hidden from normal recall', () => {
    remember({ name: 'hidden', type: 'note', observations: ['secret'] });
    forget({ name: 'hidden' });
    expect(recall({ query: 'secret' })).toEqual([]);
  });

  it('removes specific observation without archiving entity', () => {
    remember({ name: 'test', type: 'note', observations: ['keep', 'remove'] });
    const result = forget({ name: 'test', observation: 'remove' });
    expect(result.observation_removed).toBe(true);
    expect(result.remaining_observations).toBe(1);
  });

  it('entity stays active after observation removal', () => {
    remember({ name: 'test', type: 'note', observations: ['keep', 'remove'] });
    forget({ name: 'test', observation: 'remove' });

    const results = recall({ query: 'keep' });
    expect(results).toHaveLength(1);
    expect(results[0].observations).toContain('keep');
    expect(results[0].observations).not.toContain('remove');
  });

  it('returns not-found for missing entity', () => {
    const result = forget({ name: 'ghost' });
    expect(result.archived).toBe(false);
    expect(result.message).toContain('not found');
  });
});

// ── Learn ────────────────────────────────────────────────────────────────────

describe('Core Operations: learn', () => {
  it('creates a lesson_learned entity and returns learned=true', () => {
    const result = learn({ error: 'TypeError: null', fix: 'Added null check' });
    expect(result.learned).toBe(true);
    expect(result.type).toBe('lesson_learned');
  });

  it('returns a name containing "lesson-"', () => {
    const result = learn({ error: 'Import missing', fix: 'Added import' });
    expect(result.name).toContain('lesson-');
  });

  it('stores the lesson so it is recallable', () => {
    learn({ error: 'Build fails with tsc error', fix: 'Fixed tsconfig paths' });
    const entities = recall({ query: 'tsc error' });
    expect(entities.length).toBeGreaterThanOrEqual(1);
    expect(entities[0].type).toBe('lesson_learned');
  });

  it('stores optional root_cause and prevention in observations', () => {
    learn({
      error: 'DB connection dropped',
      fix: 'Added retry logic',
      root_cause: 'No connection pooling',
      prevention: 'Always use a connection pool',
      severity: 'major',
    });
    const entities = recall({ query: 'connection pooling' });
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const obs = entities[0].observations.join(' ');
    expect(obs).toContain('No connection pooling');
    expect(obs).toContain('Always use a connection pool');
  });

  it('upserts on same error pattern — does not create duplicates', () => {
    learn({ error: 'TypeError: null', fix: 'First fix' });
    learn({ error: 'TypeError: null', fix: 'Refined fix' });
    const entities = recall({ query: 'null-reference' });
    // Both calls should hit the same entity (upsert by name)
    const lessonEntities = entities.filter(e => e.type === 'lesson_learned');
    expect(lessonEntities.length).toBe(1);
  });
});

// ── Namespace ────────────────────────────────────────────────────────────────

describe('Core Operations: namespace', () => {
  it('remember stores entity with specified namespace', () => {
    remember({ name: 'team-doc', type: 'doc', namespace: 'team' });
    const results = recall({ query: 'team-doc', namespace: 'team' });
    expect(results).toHaveLength(1);
    expect(results[0].namespace).toBe('team');
  });

  it('remember defaults to personal namespace when omitted', () => {
    remember({ name: 'my-note', type: 'note' });
    const results = recall({ query: 'my-note' });
    expect(results).toHaveLength(1);
    expect(results[0].namespace).toBe('personal');
  });

  it('recall with namespace filters to matching namespace only', () => {
    remember({ name: 'p-note', type: 'note', observations: ['shared term'], namespace: 'personal' });
    remember({ name: 't-note', type: 'note', observations: ['shared term'], namespace: 'team' });

    const personal = recall({ query: 'shared term', namespace: 'personal' });
    expect(personal).toHaveLength(1);
    expect(personal[0].name).toBe('p-note');

    const team = recall({ query: 'shared term', namespace: 'team' });
    expect(team).toHaveLength(1);
    expect(team[0].name).toBe('t-note');
  });

  it('recall without namespace returns all namespaces', () => {
    remember({ name: 'cross-a', type: 'note', observations: ['xns data'], namespace: 'personal' });
    remember({ name: 'cross-b', type: 'note', observations: ['xns data'], namespace: 'team' });

    const all = recall({ query: 'xns data' });
    const names = all.map((e) => e.name);
    expect(names).toContain('cross-a');
    expect(names).toContain('cross-b');
  });

  it('cross_project=true ignores tag filter and searches all projects', () => {
    remember({ name: 'proj-a-entity', type: 'note', observations: ['cross proj obs'], tags: ['project:alpha'] });
    remember({ name: 'proj-b-entity', type: 'note', observations: ['cross proj obs'], tags: ['project:beta'] });

    // Without cross_project, tag filter restricts results
    const limited = recall({ query: 'cross proj obs', tag: 'project:alpha' });
    expect(limited).toHaveLength(1);
    expect(limited[0].name).toBe('proj-a-entity');

    // With cross_project=true, tag filter is ignored — both should be found
    const all = recall({ query: 'cross proj obs', tag: 'project:alpha', cross_project: true });
    const names = all.map((e) => e.name);
    expect(names).toContain('proj-a-entity');
    expect(names).toContain('proj-b-entity');
  });
});
