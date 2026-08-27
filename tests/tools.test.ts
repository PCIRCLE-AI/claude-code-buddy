import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../src/db.js';
import { handleTool, TOOL_DEFINITIONS } from '../src/mcp/tools.js';
import { normalizeClientHost } from '../src/transports/mcp/handlers.js';

// recall's MCP payload is an object envelope ({ entities, conflicts? }), never
// a bare array — see the shape contract test in the recall describe block.
const recallEntities = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text).entities;

let tmpDir: string;
let dbPath: string;
let previousMemeshDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-tools-'));
  dbPath = path.join(tmpDir, 'test.db');
  previousMemeshDir = process.env.MEMESH_DIR;
  // Tool tests must never inherit the developer's real embedder/LLM config.
  // A configured Ollama instance otherwise schedules network work from
  // `remember`, making a focused offline replay slow or non-terminating.
  process.env.MEMESH_DIR = tmpDir;
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  if (previousMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousMemeshDir;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Remember ────────────────────────────────────────────────────────────

describe('source_host provenance', () => {
  it('stamps the MCP client name the transport hands over', async () => {
    // The third argument is the client's self-declared initialize name,
    // threaded by src/mcp/server.ts — NOT a tool parameter the model can set.
    await handleTool('remember', { name: 'prov-mcp', type: 'decision', observations: ['from codex'] }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-mcp' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'prov-mcp');
    expect(hit.metadata.provenance.source_host).toBe('codex');
  });

  it('records no source_host when the transport does not know one', async () => {
    await handleTool('remember', { name: 'prov-anon', type: 'decision', observations: ['origin unknown'] });
    const recall = await handleTool('recall', { query: 'prov-anon' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'prov-anon');
    expect(hit.metadata.provenance.source_host).toBeUndefined();
  });

  it('the model cannot smuggle source_host in as a tool argument', async () => {
    // Since every schema went strict, a spoofed sourceHost is REJECTED
    // outright — stronger than the old silent strip, and it names the key.
    // If this ever starts being accepted (a .passthrough() refactor),
    // provenance is no longer provenance.
    const result = await handleTool('remember', {
      name: 'prov-spoof', type: 'decision', observations: ['spoof attempt'],
      sourceHost: 'gemini-cli',
    } as Record<string, unknown>, 'codex');
    expect(JSON.stringify(result)).toMatch(/sourceHost|unrecognized/i);

    // And nothing was stored under the spoofed call.
    const recall = await handleTool('recall', { query: 'prov-spoof' });
    expect(recallEntities(recall).find((e: any) => e.name === 'prov-spoof')).toBeUndefined();
  });

  it('a smuggled sourceHost with NO transport name is rejected the same way', async () => {
    const result = await handleTool('remember', {
      name: 'prov-anon-spoof', type: 'decision', observations: ['anon spoof'],
      sourceHost: 'gemini-cli',
    } as Record<string, unknown>);
    expect(JSON.stringify(result)).toMatch(/sourceHost|unrecognized/i);
    const recall = await handleTool('recall', { query: 'prov-anon-spoof' });
    expect(recallEntities(recall).find((e: any) => e.name === 'prov-anon-spoof')).toBeUndefined();
  });

  it('re-remember from another host does NOT overwrite the first writer', async () => {
    // First-writer-wins, the same invariant the hook path enforces with
    // INSERT OR IGNORE and the CHANGELOG promises. Before the fix this
    // returned 'codex': buildLocalMetadata spreads overrides over the stored
    // provenance, so every cross-host append rewrote the attribution.
    await handleTool('remember', { name: 'prov-first', type: 'decision', observations: ['created here'] }, 'claude-code');
    await handleTool('remember', { name: 'prov-first', type: 'decision', observations: ['appended elsewhere'] }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-first' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'prov-first');
    expect(hit.metadata.provenance.source_host).toBe('claude-code');
  });

  it('learn threads the transport name through to the lesson entity', async () => {
    // learn → createExplicitLesson → remember is a two-hop pass-through —
    // exactly the kind of line a refactor silently drops. Without this test,
    // deleting `sourceHost:` in lesson-engine.ts or in operations.ts learn()
    // leaves the whole suite green.
    await handleTool('learn', { error: 'prov-lesson-unique-boom', fix: 'restart the flux capacitor' }, 'codex');
    const recall = await handleTool('recall', { query: 'prov-lesson-unique-boom' });
    const hit = recallEntities(recall).find((e: any) => e.name.startsWith('lesson-'));
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

  it('rejects a whitespace-only observation instead of storing an empty memory (M-05)', async () => {
    const result = await handleTool('remember', {
      name: 'blank-mcp-test', type: 'note', observations: ['   '],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/whitespace-only/i);

    const recall = await handleTool('recall', { query: 'blank-mcp-test' });
    expect(recallEntities(recall)).toEqual([]);
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
    // R2: the envelope always says HOW it was answered — mode (fts|hybrid),
    // degraded (configured vector side could not run), truncated (window
    // filled). A caller must never have to guess whether keyword-only
    // results are the configured behaviour or a silent degradation.
    expect(['fts', 'hybrid']).toContain(parsed.retrieval.mode);
    expect(typeof parsed.retrieval.degraded).toBe('boolean');
    expect(typeof parsed.retrieval.truncated).toBe('boolean');
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
  it('refuses the plural typo instead of archiving the whole entity', async () => {
    // `remember` calls the field `observations`; `forget` calls it
    // `observation`. Zod strips unknown keys by default, and `forget` branches
    // on whether `observation` is PRESENT — absent means "archive everything".
    // So the natural plural silently turned "remove one fact" into "archive
    // this memory", and answered `{"archived": true}`. Measured before the
    // fix: status became `archived`, both observations still there, and the
    // entity dropped out of recall and out of session-start injection.
    await handleTool('remember', {
      name: 'keeper', type: 'decision', observations: ['fact A', 'fact B'],
    });

    const result = await handleTool('forget', { name: 'keeper', observations: 'fact A' });
    expect(JSON.stringify(result)).toMatch(/observations|unrecognized|invalid/i);

    // The entity is untouched — still active, still recallable, both facts.
    const recall = await handleTool('recall', { query: 'fact' });
    const hit = recallEntities(recall).find((e: any) => e.name === 'keeper');
    expect(hit).toBeTruthy();
    expect(hit.observations).toHaveLength(2);
  });

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

  it('returns not-found for non-existent entity, as an error the CLI already reports as one', async () => {
    // The CLI's `forget` command has always exited 1 for this (a forget
    // that forgot nothing) — MCP's `ok()` reported `isError: false`
    // regardless, so a caller checking `isError` alone could not tell a
    // typo'd name from a real removal. M-17.
    const result = await handleTool('forget', { name: 'ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('MCP forget reports isError for a mistyped observation, same as a missing entity (M-17)', async () => {
    await handleTool('remember', {
      name: 'typo-target', type: 'decision', observations: ['the real text'],
    });
    const result = await handleTool('forget', { name: 'typo-target', observation: 'text that is not there' });
    expect(result.isError, 'a mistyped observation reported success').toBe(true);
    expect(result.content[0].text).toContain('no observation matching that text');

    // Anti-vacuity: the entity's own untouched observation is still there —
    // this is a caller-mistake report, not a partial success.
    const recall = await handleTool('recall', { query: 'the real text' });
    expect(recallEntities(recall)).toHaveLength(1);
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

// ── Improvement ──────────────────────────────────────────────────────────────

describe('improvement', () => {
  const input = {
    action: 'propose',
    project: 'memesh',
    source_names: ['improvement-source-a', 'improvement-source-b'],
    title: 'Coordinate shared research ownership',
    problem: 'Agents can unknowingly duplicate the same research.',
    proposed_change: 'Add visible claims with leases and expiry recovery.',
    verification_scenario: 'Start two agents on the same topic; the second must see the first claim.',
    success_criteria: ['The second agent does not start duplicate work.'],
    priority: 'p1',
  };

  async function seedSources(): Promise<void> {
    await handleTool('remember', {
      name: 'improvement-source-a',
      type: 'lesson_learned',
      observations: ['Duplicate work was observed.'],
      tags: ['project:memesh'],
      namespace: 'team',
    });
    await handleTool('remember', {
      name: 'improvement-source-b',
      type: 'feedback',
      observations: ['Claims need ownership and expiry.'],
      tags: ['project:memesh'],
      namespace: 'team',
    });
  }

  it('is advertised with proposal-only authority', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(11);
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'improvement');
    expect(tool?.description).toMatch(/Agents may only propose and read status/);
    expect(tool?.inputSchema.properties.action.enum).toEqual(['propose', 'status']);
  });

  it('stages idempotently, attributes the transport host, and reads status', async () => {
    await seedSources();
    const first = await handleTool('improvement', input, 'codex');
    const retry = await handleTool('improvement', input, 'claude-code');
    expect(first.isError).toBeUndefined();
    expect(retry.isError).toBeUndefined();
    const created = JSON.parse(first.content[0].text);
    const duplicate = JSON.parse(retry.content[0].text);
    expect(created).toMatchObject({ created: true, status: 'pending' });
    expect(duplicate).toMatchObject({ created: false, proposal_id: created.proposal_id });
    expect(created.review).toMatchObject({ authority: 'human', state: 'pending' });

    const statusResult = await handleTool('improvement', {
      action: 'status',
      proposal_id: created.proposal_id,
    });
    expect(JSON.parse(statusResult.content[0].text)).toMatchObject({
      proposal_id: created.proposal_id,
      status: 'pending',
      accepted_entity_name: null,
    });

    const row = openDatabase(dbPath).prepare(
      'SELECT proposed_digest FROM dream_proposals WHERE id = ?',
    ).get(created.proposal_id) as { proposed_digest: string };
    expect(JSON.parse(row.proposed_digest).improvement.source_host).toBe('codex');
  });

  it('rejects accept/reject actions and writes nothing', async () => {
    await seedSources();
    const before = openDatabase(dbPath).prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'product_improvement'").get() as { n: number };
    for (const action of ['accept', 'reject']) {
      const result = await handleTool('improvement', { action, proposal_id: 1 });
      expect(result.isError).toBe(true);
    }
    const after = openDatabase(dbPath).prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'product_improvement'").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('rejects blank, missing, archived, or spoofed proposal evidence', async () => {
    await seedSources();
    expect((await handleTool('improvement', { ...input, title: '   ' })).isError).toBe(true);
    expect((await handleTool('improvement', { ...input, source_names: ['does-not-exist'] })).isError).toBe(true);
    expect((await handleTool('improvement', { ...input, sourceHost: 'spoof' } as Record<string, unknown>, 'codex')).isError).toBe(true);

    openDatabase(dbPath).prepare("UPDATE entities SET status = 'archived' WHERE name = 'improvement-source-a'").run();
    expect((await handleTool('improvement', input)).isError).toBe(true);
  });
});

// ── Durable local messages ──────────────────────────────────────────────────

describe('message', () => {
  it('is advertised as one lifecycle tool with explicit receipt axes', () => {
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'message');
    expect(TOOL_DEFINITIONS).toHaveLength(11);
    expect(tool?.inputSchema.properties.action.enum).toEqual([
      'send', 'poll', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts',
    ]);
    expect(tool?.description).toMatch(/Polling or fetching never acknowledges/);
  });

  it('routes exactly, keeps headers payload-free, and writes receipts only when asked', async () => {
    const sentResult = await handleTool('message', {
      action: 'send',
      project: 'memesh',
      sender: 'codex-agent',
      recipient: 'claude-agent',
      idempotency_key: 'send-1',
      payload: { text: 'review this', private_detail: 'payload-only' },
      content_type: 'application/json',
      privacy: 'private',
      correlation_id: 'review-42',
    }, 'codex');
    expect(sentResult.isError).toBeUndefined();
    const sent = JSON.parse(sentResult.content[0].text);

    const control = await handleTool('message', {
      action: 'poll', project: 'memesh', recipient: 'gemini-agent', wait_ms: 0,
    });
    expect(JSON.parse(control.content[0].text).events).toEqual([]);

    const polled = await handleTool('message', {
      action: 'poll', project: 'memesh', recipient: 'claude-agent', wait_ms: 0,
    });
    const pollData = JSON.parse(polled.content[0].text);
    expect(pollData.events).toHaveLength(1);
    expect(pollData.events[0]).toMatchObject({
      message_id: sent.message_id,
      sender: 'codex-agent',
      sender_host: 'codex',
      recipient: 'claude-agent',
      correlation_id: 'review-42',
    });
    expect(JSON.stringify(pollData.events[0])).not.toContain('payload-only');

    const fetched = await handleTool('message', {
      action: 'fetch', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
    });
    expect(JSON.parse(fetched.content[0].text)).toMatchObject({
      payload: { text: 'review this', private_detail: 'payload-only' },
      provenance: { transport: 'mcp', source_host: 'codex' },
    });

    const beforeReceipts = await handleTool('message', {
      action: 'receipts', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
    });
    expect(JSON.parse(beforeReceipts.content[0].text)).toEqual([]);

    await handleTool('message', {
      action: 'intake', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
      idempotency_key: 'intake-1', intake_state: 'ingested',
    }, 'claude-code');
    await handleTool('message', {
      action: 'activation', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
      idempotency_key: 'activation-1', activation: 'manual_resume_required',
    }, 'claude-code');

    const receipts = await handleTool('message', {
      action: 'receipts', project: 'memesh', recipient: 'claude-agent', message_id: sent.message_id,
    });
    expect(JSON.parse(receipts.content[0].text).map((receipt: { receipt_kind: string }) => receipt.receipt_kind))
      .toEqual(['intake', 'host_activation']);
  });

  it('rejects provenance spoofing and cancels a bounded wait', async () => {
    const spoofed = await handleTool('message', {
      action: 'send',
      project: 'memesh',
      sender: 'codex-agent',
      recipient: 'claude-agent',
      idempotency_key: 'send-1',
      payload: 'hello',
      sender_host: 'spoofed-host',
    } as Record<string, unknown>, 'codex');
    expect(spoofed.isError).toBe(true);
    expect(spoofed.content[0].text).toMatch(/sender_host|unrecognized/i);

    const controller = new AbortController();
    const waiting = handleTool('message', {
      action: 'poll', project: 'memesh', recipient: 'claude-agent', wait_ms: 30_000,
    }, 'claude-code', controller.signal);
    setTimeout(() => controller.abort(), 20);
    const cancelled = await waiting;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content[0].text).toMatch(/aborted/i);
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
