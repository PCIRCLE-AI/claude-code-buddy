import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import {
  remember,
  recall,
  forget,
  learn,
  exportMemories,
  importMemories,
} from '../../src/core/operations.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-integration-'));
  process.env.MEMESH_DB_PATH = path.join(tmpDir, 'test.db');
  openDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.MEMESH_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── remember → recall → verify observations ────────────────────────────────

describe('Integration: remember → recall', () => {
  it('stores entity with observations and retrieves them via recall', () => {
    remember({
      name: 'auth-decision',
      type: 'decision',
      observations: ['Use JWT for API auth', 'Rotate keys every 90 days'],
      tags: ['project:myapp'],
    });

    const results = recall({ query: 'JWT' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('auth-decision');
    expect(results[0].observations).toContain('Use JWT for API auth');
    expect(results[0].observations).toContain('Rotate keys every 90 days');
    expect(results[0].tags).toContain('project:myapp');
  });
});

// ── remember → forget → recall (archived behavior) ─────────────────────────

describe('Integration: remember → forget → recall', () => {
  it('archived entity is hidden from normal recall but visible with include_archived', () => {
    remember({
      name: 'deprecated-api',
      type: 'pattern',
      observations: ['Old REST endpoint /v1/users'],
    });

    forget({ name: 'deprecated-api' });

    // Normal recall should not find it
    const normal = recall({ query: 'REST endpoint' });
    expect(normal).toHaveLength(0);

    // With include_archived, it should appear
    const archived = recall({ query: 'REST endpoint', include_archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].name).toBe('deprecated-api');
    expect(archived[0].archived).toBe(true);
  });
});

// ── learn → recall lesson by project tag ────────────────────────────────────

describe('Integration: learn → recall lesson', () => {
  it('creates a lesson_learned entity retrievable by project tag', () => {
    learn({
      error: 'CORS headers missing',
      fix: 'Added Access-Control-Allow-Origin header',
      root_cause: 'Express middleware not configured',
      severity: 'major',
    });

    // The learn function uses path.basename(process.cwd()) as project name
    const projectName = path.basename(process.cwd());
    const results = recall({ tag: `project:${projectName}` });
    const lessons = results.filter(e => e.type === 'lesson_learned');
    expect(lessons.length).toBeGreaterThanOrEqual(1);

    // Verify lesson content
    const lesson = lessons[0];
    const allObs = lesson.observations.join(' ');
    expect(allObs).toContain('CORS headers missing');
    expect(allObs).toContain('Access-Control-Allow-Origin');
    expect(allObs).toContain('Express middleware not configured');
  });
});

// ── remember same name twice → observations appended (upsert) ───────────────

describe('Integration: upsert behavior', () => {
  it('appends observations when remembering the same entity name twice', () => {
    remember({
      name: 'db-config',
      type: 'config',
      observations: ['Use PostgreSQL'],
    });
    remember({
      name: 'db-config',
      type: 'config',
      observations: ['Enable connection pooling'],
    });

    const results = recall({ query: 'db-config' });
    expect(results).toHaveLength(1);
    expect(results[0].observations).toContain('Use PostgreSQL');
    expect(results[0].observations).toContain('Enable connection pooling');
  });
});

// ── remember with supersedes → old entity archived ──────────────────────────

describe('Integration: supersedes relation', () => {
  it('auto-archives old entity when superseded by new one', () => {
    remember({
      name: 'config-v1',
      type: 'config',
      observations: ['Use YAML config'],
    });
    remember({
      name: 'config-v2',
      type: 'config',
      observations: ['Use TOML config'],
      relations: [{ to: 'config-v1', type: 'supersedes' }],
    });

    // Old entity should be hidden
    const active = recall({ query: 'YAML config' });
    expect(active).toHaveLength(0);

    // New entity should be visible
    const newResults = recall({ query: 'TOML config' });
    expect(newResults).toHaveLength(1);
    expect(newResults[0].name).toBe('config-v2');

    // Old entity visible with include_archived
    const all = recall({ query: 'YAML config', include_archived: true });
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('config-v1');
    expect(all[0].archived).toBe(true);
  });
});

// ── export → import round-trip ──────────────────────────────────────────────

describe('Integration: export → import round-trip', () => {
  it('exports entities and re-imports them with matching entity count', () => {
    remember({ name: 'entity-a', type: 'note', observations: ['data-a'], tags: ['t1'] });
    remember({ name: 'entity-b', type: 'pattern', observations: ['data-b1', 'data-b2'] });
    remember({ name: 'entity-c', type: 'decision', observations: ['data-c'] });

    const exported = exportMemories({});
    expect(exported.entity_count).toBe(3);

    // Close current DB, open a fresh one for import
    closeDatabase();
    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-import-'));
    process.env.MEMESH_DB_PATH = path.join(importDir, 'import.db');
    openDatabase();

    const importResult = importMemories({ data: exported, merge_strategy: 'skip' });
    expect(importResult.imported).toBe(3);
    expect(importResult.skipped).toBe(0);
    expect(importResult.errors).toHaveLength(0);

    // Verify all entities exist in the new DB
    const allRecalled = recall({});
    const names = allRecalled.map(e => e.name);
    expect(names).toContain('entity-a');
    expect(names).toContain('entity-b');
    expect(names).toContain('entity-c');

    // Verify observations survived the round-trip
    const entityB = allRecalled.find(e => e.name === 'entity-b');
    expect(entityB?.observations).toContain('data-b1');
    expect(entityB?.observations).toContain('data-b2');

    // Clean up import dir
    closeDatabase();
    fs.rmSync(importDir, { recursive: true, force: true });

    // Re-open original DB for afterEach cleanup
    process.env.MEMESH_DB_PATH = path.join(tmpDir, 'test.db');
    openDatabase();
  });

  it('overwrite import replaces observations completely', () => {
    remember({ name: 'overwrite-test', type: 'test', observations: ['old-1', 'old-2', 'old-3'], tags: ['old-tag'] });

    const exported = exportMemories({});
    const entity = exported.entities.find(e => e.name === 'overwrite-test')!;
    entity.observations = ['new-only'];
    entity.tags = ['new-tag'];

    importMemories({ data: exported, merge_strategy: 'overwrite' });

    const result = recall({ query: 'overwrite-test', limit: 1 });
    expect(result[0].observations).toEqual(['new-only']);
    expect(result[0].observations).not.toContain('old-1');
    expect(result[0].tags).toContain('new-tag');
  });
});
