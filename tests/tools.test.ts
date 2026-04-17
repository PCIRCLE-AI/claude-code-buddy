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
  it('stores an entity and returns confirmation', async () => {
    const result = await handleTool('remember', {
      name: 'auth-decision',
      type: 'decision',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.stored).toBe(true);
    expect(data.name).toBe('auth-decision');
    expect(data.type).toBe('decision');
  });

  it('stores tags and relations', async () => {
    // Create target entity first so relation can be established
    await handleTool('remember', { name: 'jwt-pattern', type: 'pattern' });

    const result = await handleTool('remember', {
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

  it('returns validation error when name is missing', async () => {
    const result = await handleTool('remember', { type: 'decision' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('name');
  });

  it('returns validation error when name is empty', async () => {
    const result = await handleTool('remember', { name: '', type: 'decision' });

    expect(result.isError).toBe(true);
  });

  it('stores observations that are searchable', async () => {
    await handleTool('remember', {
      name: 'jwt-lesson',
      type: 'lesson',
      observations: ['Use RS256 for JWT signing', 'Rotate keys quarterly'],
    });

    const result = await handleTool('recall', { query: 'RS256' });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('jwt-lesson');
    expect(data[0].observations).toContain('Use RS256 for JWT signing');
  });

  it('auto-archives entity when superseded by new remember', async () => {
    await handleTool('remember', { name: 'auth-v2', type: 'decision', observations: ['Use JWT'] });
    await handleTool('remember', {
      name: 'auth-v3', type: 'decision', observations: ['Use OAuth 2.0'],
      relations: [{ to: 'auth-v2', type: 'supersedes' }],
    });

    // auth-v2 should be auto-archived
    const recallOld = await handleTool('recall', { query: 'JWT' });
    expect(JSON.parse(recallOld.content[0].text)).toEqual([]);

    // auth-v3 should be active
    const recallNew = await handleTool('recall', { query: 'OAuth' });
    const data = JSON.parse(recallNew.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('auth-v3');

    // Both visible with include_archived
    const recallAll = await handleTool('recall', { include_archived: true });
    const allData = JSON.parse(recallAll.content[0].text);
    const names = allData.map((e: any) => e.name);
    expect(names).toContain('auth-v2');
    expect(names).toContain('auth-v3');
  });

  it('reports relation errors without failing overall', async () => {
    const result = await handleTool('remember', {
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
  beforeEach(async () => {
    await handleTool('remember', {
      name: 'auth-pattern',
      type: 'pattern',
      observations: ['JWT tokens for stateless auth'],
      tags: ['project:myapp'],
    });
    await handleTool('remember', {
      name: 'db-decision',
      type: 'decision',
      observations: ['Use PostgreSQL for persistence'],
      tags: ['project:other'],
    });
  });

  it('finds entities by query', async () => {
    const result = await handleTool('recall', { query: 'auth' });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.some((e: any) => e.name === 'auth-pattern')).toBe(true);
  });

  it('filters by tag', async () => {
    const result = await handleTool('recall', {
      query: 'auth',
      tag: 'project:myapp',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('auth-pattern');
  });

  it('lists recent when no query provided', async () => {
    const result = await handleTool('recall', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(2);
  });

  it('returns empty array when nothing matches', async () => {
    const result = await handleTool('recall', { query: 'nonexistent-xyz-123' });
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const result = await handleTool('recall', { limit: 1 });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBe(1);
  });

  it('rejects recall with limit=0', async () => {
    const result = await handleTool('recall', { limit: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit');
  });

  it('rejects recall with limit=101', async () => {
    const result = await handleTool('recall', { limit: 101 });
    expect(result.isError).toBe(true);
  });
});

// ── Forget ──────────────────────────────────────────────────────────────

describe('forget', () => {
  it('archives an entity instead of deleting it', async () => {
    await handleTool('remember', {
      name: 'old-design', type: 'decision', observations: ['Use REST'],
    });

    const result = await handleTool('forget', { name: 'old-design' });
    const data = JSON.parse(result.content[0].text);
    expect(data.archived).toBe(true);
    expect(data.name).toBe('old-design');

    // Hidden from normal recall
    const recall = await handleTool('recall', { query: 'REST' });
    expect(JSON.parse(recall.content[0].text)).toEqual([]);

    // Visible with include_archived
    const recallAll = await handleTool('recall', { query: 'REST', include_archived: true });
    const allData = JSON.parse(recallAll.content[0].text);
    expect(allData).toHaveLength(1);
    expect(allData[0].archived).toBe(true);
  });

  it('removes a specific observation without archiving', async () => {
    await handleTool('remember', {
      name: 'design', type: 'decision', observations: ['Use JWT', 'Use RS256'],
    });

    const result = await handleTool('forget', { name: 'design', observation: 'Use JWT' });
    const data = JSON.parse(result.content[0].text);
    expect(data.observation_removed).toBe(true);
    expect(data.remaining_observations).toBe(1);

    // Entity still active and searchable
    const recall = await handleTool('recall', { query: 'RS256' });
    expect(JSON.parse(recall.content[0].text)).toHaveLength(1);
  });

  it('returns not-found for non-existent entity', async () => {
    const result = await handleTool('forget', { name: 'ghost' });
    const data = JSON.parse(result.content[0].text);
    expect(data.archived).toBe(false);
    expect(data.message).toContain('not found');
  });

  it('rejects forget with empty name', async () => {
    const result = await handleTool('forget', { name: '' });
    expect(result.isError).toBe(true);
  });
});

// ── Unknown tool ────────────────────────────────────────────────────────

describe('unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const result = await handleTool('nonexistent', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
