import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';

// Import the Express app (not startServer, which opens its own DB and binds a port).
// We open our own isolated DB and start the app on a random port.
import { app, startServer, __setRemoteTokenForTest } from '../../src/transports/http/server.js';

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;
let updateCheckPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-'));
  updateCheckPath = path.join(tmpDir, 'update-check.json');
  process.env.MEMESH_UPDATE_CHECK_PATH = updateCheckPath;
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
  delete process.env.MEMESH_UPDATE_CHECK_PATH;
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
    // Recall supplements FTS5 with sqlite-vec when ONNX embeddings are
    // available, so a query that misses FTS5 can still surface near-neighbour
    // entities under the MAX_VECTOR_DISTANCE threshold. Asserting toHaveLength(0)
    // is brittle in that path — the API contract here is "always return a
    // valid JSON array, never a 500" and a generous upper bound on count.
    const res = await req('POST', '/v1/recall', { query: 'no-match-xyz-999' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(20);
    for (const e of res.body.data) {
      expect(typeof e.name).toBe('string');
      expect(typeof e.type).toBe('string');
    }
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

describe('HTTP Transport: GET /v1/update-status', () => {
  it('returns cached update metadata when requested', async () => {
    const now = Date.now();
    const lastSuccessfulCheckAt = new Date(now - 60 * 60 * 1000).toISOString();
    const lastAttemptAt = new Date(now - 45 * 60 * 1000).toISOString();

    // Use the running package's installed version so version-scoped
    // fields (lastError, deprecation) are returned unchanged. With a
    // mismatched currentVersion in the cache, the round-10 fix
    // correctly clears those fields as belonging to a prior install.
    const installedVersion = require(path.resolve('package.json')).version;

    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: installedVersion,
      latestVersion: '9.9.9',
      lastAttemptAt,
      lastSuccessfulCheckAt,
      lastError: 'npm unavailable',
      checkSucceeded: false,
    }));

    const res = await req('GET', '/v1/update-status?cached=1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.currentVersion).toBeDefined();
    expect(res.body.data.latestVersion).toBe('9.9.9');
    expect(res.body.data.updateAvailable).toBe(true);
    expect(res.body.data.checkSucceeded).toBe(false);
    expect(res.body.data.source).toBe('cache');
    expect(res.body.data.checkedAt).toBe(lastAttemptAt);
    expect(res.body.data.lastAttemptAt).toBe(lastAttemptAt);
    expect(res.body.data.lastSuccessfulCheckAt).toBe(lastSuccessfulCheckAt);
    expect(res.body.data.lastError).toBe('npm unavailable');
    expect(res.body.data.freshness).toBe('cached');
    expect(res.body.data.installChannel).toBe('source-checkout');
    expect(res.body.data.canSelfUpdate).toBe(false);
    expect(res.body.data.recommendedCommand).toBeNull();
  });

  it('returns an unavailable state when no successful check has been recorded', async () => {
    const installedVersion = require(path.resolve('package.json')).version;
    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: installedVersion,
      latestVersion: null,
      lastAttemptAt: '2026-04-24T11:00:00.000Z',
      lastSuccessfulCheckAt: null,
      lastError: 'registry offline',
      checkSucceeded: false,
    }));

    const res = await req('GET', '/v1/update-status?cached=1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.currentVersion).toBeDefined();
    expect(res.body.data.latestVersion).toBeNull();
    expect(res.body.data.updateAvailable).toBe(false);
    expect(res.body.data.checkSucceeded).toBe(false);
    expect(res.body.data.source).toBe('cache');
    expect(res.body.data.checkedAt).toBe('2026-04-24T11:00:00.000Z');
    expect(res.body.data.lastAttemptAt).toBe('2026-04-24T11:00:00.000Z');
    expect(res.body.data.lastSuccessfulCheckAt).toBeNull();
    expect(res.body.data.lastError).toBe('registry offline');
    expect(res.body.data.freshness).toBe('unavailable');
    expect(res.body.data.installChannel).toBe('source-checkout');
    expect(res.body.data.canSelfUpdate).toBe(false);
    expect(res.body.data.recommendedCommand).toBeNull();
  });
});

describe('HTTP Transport: POST /v1/config', () => {
  it('saves config and the value is actually persisted (read-back)', async () => {
    // Was asserting only status 200 + success:true, so a silent write-drop
    // still passed. Assert the written value survives a GET round-trip, using
    // a real read-back field (sessionLimit — theme was removed as dead).
    const res = await req('POST', '/v1/config', { sessionLimit: 33 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const check = await req('GET', '/v1/config');
    expect(check.status).toBe(200);
    expect(check.body.data.config.sessionLimit).toBe(33);
  });

  it('POST response masks apiKey across the whole fallback chain, not just llm', async () => {
    // Regression (security): the POST response used to mask only llm.apiKey, so
    // a saved llmFallbacks[].apiKey was echoed back to the SPA in plaintext.
    const res = await req('POST', '/v1/config', {
      llm: { provider: 'anthropic', apiKey: 'sk-primary-should-be-masked' },
      llmFallbacks: [
        { provider: 'openai', apiKey: 'sk-fallback-should-be-masked' },
        { provider: 'ollama' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.llm.apiKey).toBe('***');
    expect(res.body.data.llmFallbacks[0].apiKey).toBe('***');
    // No plaintext secret anywhere in the response body.
    expect(JSON.stringify(res.body)).not.toContain('should-be-masked');

    // Reset to Core Mode so the fake credentials don't leak into other tests'
    // capability detection.
    await req('POST', '/v1/config', { llm: null, llmFallbacks: [] });
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

// ── Body limit ────────────────────────────────────────────────────────────────

describe('HTTP Transport: 1MB request body limit', () => {
  it('rejects oversized JSON with a structured 413 (not an HTML error page)', async () => {
    // Build a JSON body > 1MB. The simplest path: a string field whose
    // value is 1.5 MB of repeated characters. JSON.stringify wraps with
    // quotes + the field name; the resulting body comfortably exceeds the cap.
    const filler = 'x'.repeat(1.5 * 1024 * 1024);
    const url = `http://127.0.0.1:${port}/v1/remember`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'oversize', type: 'note', observations: [filler] }),
    });
    expect(res.status).toBe(413);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/application\/json/);
    const body = await res.json() as { success: boolean; code?: string; limit?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.limit).toBe('1mb');
  });

  it('accepts a small JSON payload (control — confirms 1MB cap is not too aggressive)', async () => {
    const res = await req('POST', '/v1/remember', {
      name: 'tiny',
      type: 'note',
      observations: ['short observation'],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
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

describe('HTTP Transport: startServer host guard', () => {
  it('rejects non-loopback binds without explicit opt-in', () => {
    expect(() => startServer('0.0.0.0', 0)).toThrow(/Refusing to bind MeMesh HTTP server/);
  });

  it('allows non-loopback binds when explicit opt-in is provided, and demands a bearer token (F3)', async () => {
    const remoteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-remote-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    const previousToken = process.env.MEMESH_REMOTE_TOKEN;
    process.env.MEMESH_DB_PATH = path.join(remoteTmpDir, 'test.db');
    // Inject a known token so the test doesn't need to read the
    // generated file under the temp dir.
    process.env.MEMESH_REMOTE_TOKEN = 'test-token-deadbeefcafef00d';

    let remoteServer: ReturnType<typeof app.listen> | undefined;
    try {
      remoteServer = startServer('0.0.0.0', 0, { allowRemote: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(remoteServer.listening).toBe(true);

      const remotePort = (remoteServer.address() as any).port;

      // F3: without bearer token → 401 even on /v1/health.
      const noAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`);
      expect(noAuth.status).toBe(401);

      // F3: with the right bearer token → 200.
      const withAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: 'Bearer test-token-deadbeefcafef00d' },
      });
      expect(withAuth.status).toBe(200);

      // F3: with a wrong token → 401, and timing-safe compare doesn't
      // leak length (we don't assert timing here, just that it rejects).
      const wrongAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(wrongAuth.status).toBe(401);

      // F3 ordering regression: auth must run BEFORE the rate limiter.
      // If a 401 also returned RateLimit-* headers, the limiter is
      // counting unauthed traffic against legitimate clients sharing
      // an IP — a trivial DoS. After the fix the 401 response must
      // NOT include RateLimit-Limit / RateLimit-Remaining headers
      // (rate limiter never ran).
      expect(wrongAuth.headers.get('ratelimit-limit')).toBeNull();
      expect(wrongAuth.headers.get('ratelimit-remaining')).toBeNull();
      expect(wrongAuth.headers.get('x-ratelimit-limit')).toBeNull();

      // Codex challenge regression: auth must also run BEFORE the JSON
      // body parser. If express.json() runs first, an unauthenticated
      // attacker can force up to 1 MB of JSON parsing per request before
      // getting a 401 — pre-auth CPU/memory DoS primitive. Proof:
      // sending a malformed JSON body without auth must return 401
      // (auth rejection), not 400 (body parse error). If the parser
      // ran first it would emit a 400 "invalid JSON" before auth ever
      // saw the request.
      const malformedNoAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{this is not valid json',
      });
      expect(malformedNoAuth.status).toBe(401);

      // And a valid (but unauthorized) JSON body still gets 401 —
      // proving the JSON parser is gated, not just the schema validator.
      const validJsonNoAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'unauthed', type: 'note' }),
      });
      expect(validJsonNoAuth.status).toBe(401);

      // CodeQL js/polynomial-redos regression: the previous header
      // parser used a regex where both quantifiers could match
      // whitespace, so an attacker-controlled header that is all
      // whitespace forced the regex engine to enumerate every split
      // between the two quantifiers (quadratic in input length). The
      // replacement single-pass parser must answer in bounded time
      // even for a 10k-char whitespace header. We measure the latency
      // for that pathological case and assert it returns 401 quickly
      // — no exponential hang.
      const pathological = 'Bearer ' + ' '.repeat(10_000);
      const t0 = Date.now();
      const redosProbe = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: pathological },
      });
      const elapsed = Date.now() - t0;
      expect(redosProbe.status).toBe(401);
      // Generous bound — actual cost is microseconds; anything over
      // 500ms would indicate the old quadratic pattern is back.
      expect(elapsed).toBeLessThan(500);
    } finally {
      if (remoteServer) {
        await new Promise<void>((resolve, reject) => {
          remoteServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      closeDatabase();
      // Reset module-level remoteToken so subsequent loopback-only
      // tests in the same suite are not auth-gated.
      __setRemoteTokenForTest(null);
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      if (previousToken === undefined) delete process.env.MEMESH_REMOTE_TOKEN;
      else process.env.MEMESH_REMOTE_TOKEN = previousToken;
      fs.rmSync(remoteTmpDir, { recursive: true, force: true });
    }
  });

  // Codex challenge regression: previously a second startServer() call
  // bound to loopback would clobber the module-global `remoteToken` to
  // null, silently de-authenticating any already-running remote
  // listener attached to the same app. Auth is now gated per-request
  // by the connection's local address, so a loopback listener cannot
  // break a peer remote listener.
  it('dual-listener safety: loopback start does not de-auth a running remote listener', async () => {
    const remoteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-dual-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    const previousToken = process.env.MEMESH_REMOTE_TOKEN;
    process.env.MEMESH_DB_PATH = path.join(remoteTmpDir, 'test.db');
    process.env.MEMESH_REMOTE_TOKEN = 'test-token-dual-0123456789abcdef';

    let remoteServer: ReturnType<typeof app.listen> | undefined;
    let loopbackServer: ReturnType<typeof app.listen> | undefined;
    try {
      remoteServer = startServer('0.0.0.0', 0, { allowRemote: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const remotePort = (remoteServer.address() as any).port;

      // Now start a loopback listener on the SAME app — pre-fix this
      // would set remoteToken = null and break the remote listener.
      loopbackServer = startServer('127.0.0.1', 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const loopbackPort = (loopbackServer.address() as any).port;

      // Remote still requires the token (loopback start did not break it).
      const remoteNoAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`);
      // 127.0.0.1 connecting to a 0.0.0.0-bound socket has the local
      // address of the bound socket; per-request loopback detection
      // sees this as remote-bound and demands auth.
      expect(remoteNoAuth.status).toBe(401);

      const remoteWithAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: 'Bearer test-token-dual-0123456789abcdef' },
      });
      expect(remoteWithAuth.status).toBe(200);

      // And the loopback listener is still no-auth (process-owner trust).
      const loopback = await fetch(`http://127.0.0.1:${loopbackPort}/v1/health`);
      expect(loopback.status).toBe(200);
    } finally {
      const closes: Promise<void>[] = [];
      if (remoteServer) closes.push(new Promise<void>((res, rej) => remoteServer!.close((err) => err ? rej(err) : res())));
      if (loopbackServer) closes.push(new Promise<void>((res, rej) => loopbackServer!.close((err) => err ? rej(err) : res())));
      await Promise.all(closes);
      closeDatabase();
      __setRemoteTokenForTest(null);
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      if (previousToken === undefined) delete process.env.MEMESH_REMOTE_TOKEN;
      else process.env.MEMESH_REMOTE_TOKEN = previousToken;
      fs.rmSync(remoteTmpDir, { recursive: true, force: true });
    }
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

// ── Startup Validation (F15) ──────────────────────────────────────────────────

describe('HTTP Transport: Startup validation', () => {
  it('throws with actionable error if database cannot be opened', () => {
    // Create a path that fails on both POSIX and Windows: take a regular
    // file, then ask SQLite to open a "child" of that file. Files can't
    // have children, so mkdir-recursive (which db.ts calls) will fail
    // with EEXIST/ENOTDIR. /dev/null worked on POSIX but Windows has no
    // /dev/null analogue, so we make our own.
    const badTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-bad-'));
    const blockingFile = path.join(badTmpDir, 'iamafile.txt');
    fs.writeFileSync(blockingFile, 'I am a regular file, not a directory.');
    const badDbPath = path.join(blockingFile, 'cannot-write-here.db');
    const previousDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = badDbPath;

    // The beforeAll opened a db at tmpDir/test.db. Close it so startServer's
    // openDatabase() actually tries to open badDbPath instead of returning
    // the cached connection (openDatabase is idempotent: returns existing).
    closeDatabase();

    try {
      expect(() => startServer('127.0.0.1', 0)).toThrow(/Database initialization failed/);
    } finally {
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      fs.rmSync(badTmpDir, { recursive: true, force: true });
      // Reopen the original db so subsequent tests in afterAll can closeDatabase
      // and so other concurrent tests are not affected.
      openDatabase(path.join(tmpDir, 'test.db'));
    }
  });

  it('shows actual bound port instead of input port (F15 port display fix)', async () => {
    const portTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-port-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = path.join(portTmpDir, 'test.db');

    let testServer: ReturnType<typeof app.listen> | undefined;
    try {
      // Start with port=0 (random port)
      testServer = startServer('127.0.0.1', 0);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const actualPort = (testServer.address() as any).port;
      expect(actualPort).toBeGreaterThan(0);
      expect(actualPort).not.toBe(0); // Should not show ":0" in logs

      // Verify server is actually listening on the reported port
      const res = await fetch(`http://127.0.0.1:${actualPort}/v1/health`);
      expect(res.status).toBe(200);
    } finally {
      if (testServer) await new Promise<void>((res, rej) => testServer!.close((err) => err ? rej(err) : res()));
      closeDatabase();
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      fs.rmSync(portTmpDir, { recursive: true, force: true });
    }
  });
});
