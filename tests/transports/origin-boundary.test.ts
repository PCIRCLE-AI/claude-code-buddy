/**
 * The loopback listener has no authentication — `bearerAuth` returns
 * immediately for it, by design — so until now "only this machine can reach
 * it" was the entire security boundary. A browser is on this machine.
 *
 * A page on any site the user visits while `memesh serve` is running could
 * auto-submit
 *
 *     <form method="POST" action="http://127.0.0.1:3737/v1/demo/reset">
 *
 * which needs no preflight (it is a CORS "simple request"), so the handler
 * ran and replaced the user's knowledge graph with demo seed data. The same
 * reach covered `POST /v1/dream/run` and the proposal accept/reject routes.
 * The browser blocks the attacking page from reading the reply, which hid
 * the damage rather than preventing it.
 *
 * What is pinned here:
 *   1. a cross-site request is refused (403), by `Sec-Fetch-Site` and, for a
 *      browser that does not send it, by `Origin`
 *   2. the request the DASHBOARD makes still works — the check is worthless
 *      if it also breaks the one browser client there is
 *   3. a non-browser client (CLI, MCP, curl: no Origin, no Sec-Fetch-Site)
 *      still works
 *   4. a rebound Host is refused, because DNS rebinding is precisely how an
 *      attacker turns "cross-site" into "same-origin" and passes check 1
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { app } from '../../src/transports/http/server.js';

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-origin-'));
  process.env.MEMESH_UPDATE_CHECK_PATH = path.join(tmpDir, 'update-check.json');
  openDatabase(path.join(tmpDir, 'test.db'));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  closeDatabase();
  delete process.env.MEMESH_UPDATE_CHECK_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function call(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers });
}

function entityCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM entities').get() as { c: number }).c;
}

describe('cross-site requests are refused', () => {
  it('refuses the demo reset a malicious page could submit', async () => {
    // The exact shape a `<form>` on another site produces: Sec-Fetch-Site
    // cross-site, Origin the attacker, no preflight required.
    const res = await call('POST', '/v1/demo/reset', {
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    });

    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('auth.cross-origin');
  });

  it('refuses it by Origin alone, for a browser that sends no Sec-Fetch-Site', async () => {
    const res = await call('POST', '/v1/demo/reset', { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('refuses a same-site-but-not-same-origin request', async () => {
    // `same-site` covers a sibling subdomain. It is not this origin, and on
    // a server with no auth that distinction is the whole boundary.
    const res = await call('GET', '/v1/entities', { 'sec-fetch-site': 'same-site' });
    expect(res.status).toBe(403);
  });

  it('refuses cross-site reads too, because a read here writes', async () => {
    // `GET /v1/export` runs kg.search, which bumps access_count and stamps
    // last_accessed_at. Unreadable cross-origin is not the same as harmless.
    const res = await call('GET', '/v1/export', { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('leaves the database untouched when it refuses', async () => {
    // The assertion that matters. A 403 that arrived after the handler ran
    // would satisfy every status check above. `demo/reset` deletes rows, so
    // there have to BE rows for the check to mean anything.
    await call('POST', '/v1/demo/seed', { 'sec-fetch-site': 'same-origin' });
    const before = entityCount();
    expect(before, 'fixture: nothing was seeded, so nothing could be destroyed').toBeGreaterThan(0);

    await call('POST', '/v1/demo/reset', { 'sec-fetch-site': 'cross-site' });
    expect(entityCount(), 'the refused reset deleted the rows anyway').toBe(before);
  });
});

describe('the clients that must keep working, do', () => {
  it('accepts the dashboard — same-origin', async () => {
    const res = await call('GET', '/v1/health', {
      'sec-fetch-site': 'same-origin',
      origin: `http://127.0.0.1:${port}`,
    });
    expect(res.status).toBe(200);
  });

  it('accepts a typed URL or bookmark — Sec-Fetch-Site: none', async () => {
    const res = await call('GET', '/v1/health', { 'sec-fetch-site': 'none' });
    expect(res.status).toBe(200);
  });

  it('accepts a non-browser client that sends neither header', async () => {
    // The CLI, the MCP server, curl. This is the anti-vacuity half of the
    // whole file: a middleware that rejected everything would pass every
    // refusal test above.
    const res = await call('GET', '/v1/health');
    expect(res.status).toBe(200);
  });

  it('accepts the same destructive POST when it is same-origin', async () => {
    // The route the attack targets, from the origin that is allowed to use
    // it. Without this the middleware could be rejecting everything and
    // every refusal test above would still pass.
    await call('POST', '/v1/demo/seed', { 'sec-fetch-site': 'same-origin' });
    const before = entityCount();
    expect(before, 'fixture: nothing seeded').toBeGreaterThan(0);

    const res = await call('POST', '/v1/demo/reset', {
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    });
    expect(res.status).toBe(200);
    expect(entityCount(), 'the allowed reset removed nothing').toBeLessThan(before);
  });
});

describe('a rebound Host is refused', () => {
  /**
   * `Host` is a forbidden header name: `fetch` silently drops any attempt to
   * set it, so a fetch-based test would send `127.0.0.1` and pass no matter
   * what the middleware did. This writes the request itself.
   */
  function rawGet(hostHeader: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/health',
          method: 'GET',
          headers: { Host: hostHeader, 'sec-fetch-site': 'same-origin' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('rejects a request whose Host is not a loopback name', async () => {
    // DNS rebinding: evil.example resolves to 127.0.0.1, so the browser
    // reports same-origin and every check above passes. The Host header is
    // the one thing that still names the attacker.
    const res = await rawGet(`evil.example:${port}`);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).errorCode).toBe('auth.cross-origin');
  });

  it('accepts localhost, not just the literal 127.0.0.1', async () => {
    // Anti-vacuity: a Host check that rejected everything would pass the
    // test above while breaking the URL most users actually type.
    const res = await rawGet(`localhost:${port}`);
    expect(res.status).toBe(200);
  });

  it('accepts the literal loopback address', async () => {
    const res = await rawGet(`127.0.0.1:${port}`);
    expect(res.status).toBe(200);
  });
});
