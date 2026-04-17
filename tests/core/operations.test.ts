import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember, recall, forget } from '../../src/core/operations.js';

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
