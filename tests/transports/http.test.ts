import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';

// Import the Express app (not startServer, which opens its own DB and binds a port).
// We open our own isolated DB and start the app on a random port.
import { app } from '../../src/transports/http/server.js';

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-'));
  openDatabase(path.join(tmpDir, 'test.db'));

  // Bind on port 0 → OS assigns a free port
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper ───────────────────────────────────────────────────────────────────

async function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://127.0.0.1:${port}${urlPath}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
}

// ── Health ───────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await req('GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('includes version and entity_count', async () => {
    const res = await req('GET', '/v1/health');
    expect(typeof res.body.data.version).toBe('string');
    expect(typeof res.body.data.entity_count).toBe('number');
  });
});

// ── Remember ─────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/remember', () => {
  it('stores entity and returns stored=true', async () => {
    const res = await req('POST', '/v1/remember', { name: 'http-alpha', type: 'note' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stored).toBe(true);
    expect(res.body.data.name).toBe('http-alpha');
  });

  it('stores entity with observations', async () => {
    const res = await req('POST', '/v1/remember', {
      name: 'http-beta',
      type: 'decision',
      observations: ['Use TLS everywhere'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.observations).toBe(1);
  });

  it('stores entity with tags', async () => {
    const res = await req('POST', '/v1/remember', {
      name: 'http-gamma',
      type: 'pattern',
      tags: ['env:prod'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.tags).toBe(1);
  });
});

// ── Recall ────────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/recall', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', {
      name: 'recall-target',
      type: 'note',
      observations: ['unique-recall-obs-abc'],
    });
  });

  it('returns matching entities by query', async () => {
    const res = await req('POST', '/v1/recall', { query: 'unique-recall-obs-abc' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const found = res.body.data.find((e: any) => e.name === 'recall-target');
    expect(found).toBeDefined();
  });

  it('returns array (possibly empty) for no-match query', async () => {
    const res = await req('POST', '/v1/recall', { query: 'no-match-xyz-999' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });

  it('lists entities when no query provided', async () => {
    const res = await req('POST', '/v1/recall', {});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

// ── Get single entity ────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/entities/:name', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', { name: 'entity-lookup', type: 'test' });
  });

  it('returns entity by name', async () => {
    const res = await req('GET', '/v1/entities/entity-lookup');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('entity-lookup');
  });

  it('returns 404 for missing entity', async () => {
    const res = await req('GET', '/v1/entities/no-such-entity-xyz');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ── List entities ─────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/entities', () => {
  it('returns list of entities', async () => {
    const res = await req('GET', '/v1/entities');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('respects limit query param', async () => {
    const res = await req('GET', '/v1/entities?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });
});

// ── Forget ────────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/forget', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', { name: 'http-forget-me', type: 'note' });
  });

  it('archives entity and returns archived=true', async () => {
    const res = await req('POST', '/v1/forget', { name: 'http-forget-me' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.archived).toBe(true);
  });

  it('returns archived=false for non-existent entity', async () => {
    const res = await req('POST', '/v1/forget', { name: 'ghost-entity-xyz' });
    expect(res.status).toBe(200);
    expect(res.body.data.archived).toBe(false);
  });
});

// ── Config ────────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/config', () => {
  it('returns config and capabilities', async () => {
    const res = await req('GET', '/v1/config');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.capabilities).toBeDefined();
    expect(res.body.data.capabilities.fts5).toBe(true);
  });
});

describe('HTTP Transport: POST /v1/config', () => {
  it('saves config and returns updated config', async () => {
    const res = await req('POST', '/v1/config', { theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/stats', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', { name: 'stats-test', type: 'note', observations: ['data'] });
  });

  it('returns aggregate counts', async () => {
    const res = await req('GET', '/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalEntities).toBeGreaterThanOrEqual(1);
    expect(res.body.data.typeDistribution).toBeDefined();
  });
});

// ── Graph ─────────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/graph', () => {
  it('returns entities and relations', async () => {
    const res = await req('GET', '/v1/graph');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entities).toBeDefined();
    expect(res.body.data.relations).toBeDefined();
  });
});

// ── Learn ─────────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/learn', () => {
  it('creates a lesson_learned entity and returns learned=true', async () => {
    const res = await req('POST', '/v1/learn', { error: 'NullPointerException', fix: 'Added null guard' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.learned).toBe(true);
    expect(res.body.data.type).toBe('lesson_learned');
    expect(res.body.data.name).toContain('lesson-');
  });

  it('accepts optional fields', async () => {
    const res = await req('POST', '/v1/learn', {
      error: 'DB timeout on write',
      fix: 'Increased write timeout',
      root_cause: 'Default timeout too low',
      prevention: 'Always configure timeouts explicitly',
      severity: 'major',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when error field is missing', async () => {
    const res = await req('POST', '/v1/learn', { fix: 'Some fix' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when fix field is missing', async () => {
    const res = await req('POST', '/v1/learn', { error: 'Some error' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /dashboard', () => {
  it('returns HTML with dashboard content', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('html');
    const html = await res.text();
    expect(html).toContain('MeMesh');
  });

  it('returns no content for browser favicon probes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(res.status).toBe(204);
  });
});
