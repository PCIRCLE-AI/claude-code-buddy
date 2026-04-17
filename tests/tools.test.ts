import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../src/db.js';
import { handleTool } from '../src/mcp/tools.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-tools-'));
  dbPath = path.join(tmpDir, 'test.db');
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Remember ────────────────────────────────────────────────────────────

describe('remember', () => {
  it('stores an entity and returns confirmation', () => {
    const result = handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.stored).toBe(true);
    expect(data.name).toBe('auth-decision');
    expect(data.type).toBe('decision');
  });

  it('stores tags and relations', () => {
    // Create target entity first so relation can be established
    handleTool('remember', { name: 'jwt-pattern', type: 'pattern' });

    const result = handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
      tags: ['project:myapp', 'type:decision'],
      relations: [{ to: 'jwt-pattern', type: 'implements' }],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.tags).toBe(2);
    expect(data.relations).toBe(1);
  });

  it('returns validation error when name is missing', () => {
    const result = handleTool('remember', { type: 'decision' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('name');
  });

  it('returns validation error when name is empty', () => {
    const result = handleTool('remember', { name: '', type: 'decision' });

    expect(result.isError).toBe(true);
  });

  it('stores observations that are searchable', () => {
    handleTool('remember', {
      name: 'jwt-lesson',
      type: 'lesson',
      observations: ['Use RS256 for JWT signing', 'Rotate keys quarterly'],
    });

    const result = handleTool('recall', { query: 'RS256' });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('jwt-lesson');
    expect(data[0].observations).toContain('Use RS256 for JWT signing');
  });

  it('reports relation errors without failing overall', () => {
    const result = handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
      relations: [{ to: 'nonexistent-entity', type: 'related-to' }],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.stored).toBe(true);
    expect(data.relations).toBe(0);
    expect(data.relationErrors).toHaveLength(1);
  });
});

// ── Recall ──────────────────────────────────────────────────────────────

describe('recall', () => {
  beforeEach(() => {
    handleTool('remember', {
      name: 'auth-pattern',
      type: 'pattern',
      observations: ['JWT tokens for stateless auth'],
      tags: ['project:myapp'],
    });
    handleTool('remember', {
      name: 'db-decision',
      type: 'decision',
      observations: ['Use PostgreSQL for persistence'],
      tags: ['project:other'],
    });
  });

  it('finds entities by query', () => {
    const result = handleTool('recall', { query: 'auth' });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.some((e: any) => e.name === 'auth-pattern')).toBe(true);
  });

  it('filters by tag', () => {
    const result = handleTool('recall', {
      query: 'auth',
      tag: 'project:myapp',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('auth-pattern');
  });

  it('lists recent when no query provided', () => {
    const result = handleTool('recall', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(2);
  });

  it('returns empty array when nothing matches', () => {
    const result = handleTool('recall', { query: 'nonexistent-xyz-123' });
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([]);
  });

  it('respects limit parameter', () => {
    const result = handleTool('recall', { limit: 1 });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(1);
  });

  it('rejects recall with limit=0', () => {
    const result = handleTool('recall', { limit: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit');
  });

  it('rejects recall with limit=101', () => {
    const result = handleTool('recall', { limit: 101 });
    expect(result.isError).toBe(true);
  });
});

// ── Forget ──────────────────────────────────────────────────────────────

describe('forget', () => {
  it('deletes an existing entity', () => {
    handleTool('remember', { name: 'temp-note', type: 'note' });

    const result = handleTool('forget', { name: 'temp-note' });
    const data = JSON.parse(result.content[0].text);
    expect(data.deleted).toBe(true);

    // Verify it's gone
    const recall = handleTool('recall', { query: 'temp-note' });
    const recallData = JSON.parse(recall.content[0].text);
    expect(recallData).toEqual([]);
  });

  it('returns not-found message for non-existent entity', () => {
    const result = handleTool('forget', { name: 'does-not-exist' });
    const data = JSON.parse(result.content[0].text);
    expect(data.deleted).toBe(false);
    expect(data.message).toContain('not found');
  });

  it('returns validation error when name is missing', () => {
    const result = handleTool('forget', {});
    expect(result.isError).toBe(true);
  });

  it('rejects forget with empty name', () => {
    const result = handleTool('forget', { name: '' });
    expect(result.isError).toBe(true);
  });
});

// ── Unknown tool ────────────────────────────────────────────────────────

describe('unknown tool', () => {
  it('returns error for unknown tool name', () => {
    const result = handleTool('nonexistent', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
