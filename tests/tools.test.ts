import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../src/db.js';
import { handleTool } from '../src/mcp/tools.js';
import { normalizeClientHost } from '../src/transports/mcp/handlers.js';

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

describe('source_host provenance', () => {
  it('stamps the MCP client name the transport hands over', async () => {
    // The third argument is the client's self-declared initialize name,
    // threaded by src/mcp/server.ts — NOT a tool parameter the model can set.
    await handleTool('remember', { name: 'prov-mcp', type: 'decision', observations: ['from codex'] }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-mcp' });
    const hit = JSON.parse(recall.content[0].text).find((e: any) => e.name === 'prov-mcp');
    expect(hit.metadata.provenance.source_host).toBe('codex');
  });

  it('records no source_host when the transport does not know one', async () => {
    await handleTool('remember', { name: 'prov-anon', type: 'decision', observations: ['origin unknown'] });
    const recall = await handleTool('recall', { query: 'prov-anon' });
    const hit = JSON.parse(recall.content[0].text).find((e: any) => e.name === 'prov-anon');
    expect(hit.metadata.provenance.source_host).toBeUndefined();
  });

  it('the model cannot smuggle source_host in as a tool argument', async () => {
    // RememberSchema strips unknown keys, so a spoofed sourceHost never
    // reaches core. If this ever starts passing through, provenance is no
    // longer provenance.
    await handleTool('remember', {
      name: 'prov-spoof', type: 'decision', observations: ['spoof attempt'],
      sourceHost: 'gemini-cli',
    } as Record<string, unknown>, 'codex');
    const recall = await handleTool('recall', { query: 'prov-spoof' });
    const hit = JSON.parse(recall.content[0].text).find((e: any) => e.name === 'prov-spoof');
    expect(hit.metadata.provenance.source_host).toBe('codex');
  });

  it('a smuggled sourceHost with NO transport name still stamps nothing', async () => {
    // The anonymous-transport variant of the spoof: today this is blocked by
    // two independent lines (zod strip + the dispatch spreading an explicit
    // undefined last), and a refactor to a conditional spread plus a schema
    // .passthrough() would silently reopen it. Pin the observable outcome.
    await handleTool('remember', {
      name: 'prov-anon-spoof', type: 'decision', observations: ['anon spoof'],
      sourceHost: 'gemini-cli',
    } as Record<string, unknown>);
    const recall = await handleTool('recall', { query: 'prov-anon-spoof' });
    const hit = JSON.parse(recall.content[0].text).find((e: any) => e.name === 'prov-anon-spoof');
    expect(hit.metadata.provenance.source_host).toBeUndefined();
  });

  it('re-remember from another host does NOT overwrite the first writer', async () => {
    // First-writer-wins, the same invariant the hook path enforces with
    // INSERT OR IGNORE and the CHANGELOG promises. Before the fix this
    // returned 'codex': buildLocalMetadata spreads overrides over the stored
    // provenance, so every cross-host append rewrote the attribution.
    await handleTool('remember', { name: 'prov-first', type: 'decision', observations: ['created here'] }, 'claude-code');
    await handleTool('remember', { name: 'prov-first', type: 'decision', observations: ['appended elsewhere'] }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-first' });
    const hit = JSON.parse(recall.content[0].text).find((e: any) => e.name === 'prov-first');
    expect(hit.metadata.provenance.source_host).toBe('claude-code');
  });

  it('learn threads the transport name through to the lesson entity', async () => {
    // learn → createExplicitLesson → remember is a two-hop pass-through —
    // exactly the kind of line a refactor silently drops. Without this test,
    // deleting `sourceHost:` in lesson-engine.ts or in operations.ts learn()
    // leaves the whole suite green.
    await handleTool('learn', { error: 'prov-lesson-unique-boom', fix: 'restart the flux capacitor' }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-lesson-unique-boom' });
    const hit = JSON.parse(recall.content[0].text).find((e: any) => e.name.startsWith('lesson-'));
    expect(hit.metadata.provenance.source_host).toBe('codex');
  });
});

describe('normalizeClientHost', () => {
  // The initialize name is the one string that reaches metadata without a zod
  // schema; this is its entire validation surface.
  it('passes a normal client name through untouched', () => {
    expect(normalizeClientHost('codex')).toBe('codex');
  });
  it('preserves non-ASCII names (clamping is not ASCII-folding)', () => {
    expect(normalizeClientHost('克勞德')).toBe('克勞德');
  });
  it('strips control characters (ANSI escapes, newlines)', () => {
    expect(normalizeClientHost('bad\u001b[31mname\nhere')).toBe('bad[31mnamehere');
  });
  it('caps at 64 characters', () => {
    expect(normalizeClientHost('x'.repeat(1000))).toHaveLength(64);
  });
  it('empty string falls back to mcp — `?? "mcp"` alone missed this', () => {
    expect(normalizeClientHost('')).toBe('mcp');
  });
  it('undefined falls back to mcp', () => {
    expect(normalizeClientHost(undefined)).toBe('mcp');
  });
  it('an all-control-character name falls back to mcp, not empty string', () => {
    expect(normalizeClientHost('\u0000\u001f\u007f')).toBe('mcp');
  });
});

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

    // auth-v2 should be auto-archived — must NOT appear in default recall.
    // (We don't assert []: if a neural embedder is configured, recallEnhanced
    // can supplement with vector hits, e.g. surfacing the related auth-v3.
    // The behavioural guarantee here is "archived rows stay hidden", not
    // "no results at all".)
    const recallOld = await handleTool('recall', { query: 'JWT' });
    const oldNames = JSON.parse(recallOld.content[0].text).map((e: any) => e.name);
    expect(oldNames).not.toContain('auth-v2');

    // auth-v3 should be active and surfaced by an OAuth query.
    const recallNew = await handleTool('recall', { query: 'OAuth' });
    const data = JSON.parse(recallNew.content[0].text);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.map((e: any) => e.name)).toContain('auth-v3');
    expect(data.map((e: any) => e.name)).not.toContain('auth-v2');

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
