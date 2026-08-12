import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../src/db.js';
import { handleTool } from '../src/mcp/tools.js';

// recall's MCP payload is an object envelope ({ entities, conflicts? }), never
// a bare array — see the shape contract test in the recall describe block.
const recallEntities = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text).entities;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-tools-'));
  dbPath = path.join(tmpDir, 'test.db');
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    const data = recallEntities(result);
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

    // auth-v2 should be auto-archived — must NOT appear in default recall.
    // (We don't assert []: if a neural embedder is configured, recallEnhanced
    // can supplement with vector hits, e.g. surfacing the related auth-v3.
    // The behavioural guarantee here is "archived rows stay hidden", not
    // "no results at all".)
    const recallOld = await handleTool('recall', { query: 'JWT' });
    const oldNames = recallEntities(recallOld).map((e: any) => e.name);
    expect(oldNames).not.toContain('auth-v2');

    // auth-v3 should be active and surfaced by an OAuth query.
    const recallNew = await handleTool('recall', { query: 'OAuth' });
    const data = recallEntities(recallNew);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.map((e: any) => e.name)).toContain('auth-v3');
    expect(data.map((e: any) => e.name)).not.toContain('auth-v2');

    // Both visible with include_archived
    const recallAll = await handleTool('recall', { include_archived: true });
    const allData = recallEntities(recallAll);
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
    const data = recallEntities(result);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.some((e: any) => e.name === 'auth-pattern')).toBe(true);
  });

  it('payload is an object envelope, never a bare array', async () => {
    // Gemini CLI JSON-parses the first text content item of a tool result and
    // assigns it to the MCP result's structuredContent, which the protocol
    // requires to be an OBJECT. When this payload was a bare array, every
    // recall issued from Gemini CLI failed with "structuredContent: expected
    // record, received array" (its session log pins this) while Claude Code
    // and Codex read the same payload fine.
    const result = await handleTool('recall', { query: 'auth' });
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed), 'bare-array payload breaks Gemini CLI').toBe(false);
    expect(Array.isArray(parsed.entities)).toBe(true);
  });

  it('treats explicit null optional params as absent, the way Gemini CLI sends them', async () => {
    // Gemini CLI fills optional parameters its model leaves blank with null
    // instead of omitting the key. This exact shape failed against the live
    // server ("tag: Invalid input: expected string, received null") while the
    // same recall from Codex, which omits the keys, succeeded.
    const result = await handleTool('recall', {
      query: 'auth',
      tag: null,
      limit: null,
      namespace: null,
    } as Record<string, unknown>);
    expect(result.isError).toBeUndefined();
    const data = recallEntities(result);
    expect(data.some((e: any) => e.name === 'auth-pattern')).toBe(true);
  });

  it('still rejects a null ELEMENT inside an array — that is data, not a blank', async () => {
    const result = await handleTool('remember', {
      name: 'null-element',
      type: 'decision',
      observations: ['fine', null],
    } as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/observations/);
  });

  it('filters by tag', async () => {
    const result = await handleTool('recall', {
      query: 'auth',
      tag: 'project:myapp',
    });
    const data = recallEntities(result);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('auth-pattern');
  });

  it('lists recent when no query provided', async () => {
    const result = await handleTool('recall', {});
    const data = recallEntities(result);
    expect(data.length).toBe(2);
  });

  it('returns empty entities when nothing matches', async () => {
    const result = await handleTool('recall', { query: 'nonexistent-xyz-123' });
    const data = recallEntities(result);
    expect(data).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const result = await handleTool('recall', { limit: 1 });
    const data = recallEntities(result);
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
    expect(recallEntities(recall)).toEqual([]);

    // Visible with include_archived
    const recallAll = await handleTool('recall', { query: 'REST', include_archived: true });
    const allData = recallEntities(recallAll);
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
    expect(recallEntities(recall)).toHaveLength(1);
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

// ── Learn ────────────────────────────────────────────────────────────────────

describe('learn', () => {
  it('creates a lesson_learned entity', async () => {
    const result = await handleTool('learn', { error: 'Bug found', fix: 'Fixed it' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.learned).toBe(true);
    expect(data.type).toBe('lesson_learned');
  });

  it('returns the lesson entity name containing "lesson-"', async () => {
    const result = await handleTool('learn', { error: 'Import missing', fix: 'Added import' });
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toContain('lesson-');
  });

  it('accepts optional root_cause, prevention, and severity', async () => {
    const result = await handleTool('learn', {
      error: 'DB timeout',
      fix: 'Added connection pool',
      root_cause: 'No pooling configured',
      prevention: 'Always configure pool size',
      severity: 'critical',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.learned).toBe(true);
  });

  it('returns validation error when error field is missing', async () => {
    const result = await handleTool('learn', { fix: 'Some fix' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('error');
  });

  it('returns validation error when fix field is missing', async () => {
    const result = await handleTool('learn', { error: 'Some error' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fix');
  });

  it('returns validation error for invalid severity', async () => {
    const result = await handleTool('learn', { error: 'Oops', fix: 'Fixed', severity: 'extreme' });
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
