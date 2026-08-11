import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { app } from '../../src/transports/http/server.js';

// dream-http — exercises POST /v1/dream/run, the HTTP entry point that
// closes the v4.2.0 known limitation ("Dashboard wiring for the
// validator is planned for a follow-up release"). The validator-on
// path can't be asserted end-to-end here without spinning up a real
// LLM, so the validate-true scenario only confirms the route accepts
// the field and routes through `runDreamer` without 400ing — the
// digest-validator unit tests cover the validator's own behaviour.

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-dream-http-'));
  // Isolate update-check + config files so this suite cannot collide
  // with `tests/transports/http.test.ts` running in the same fork.
  process.env.MEMESH_UPDATE_CHECK_PATH = path.join(tmpDir, 'update-check.json');
  openDatabase(path.join(tmpDir, 'test.db'));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeDatabase();
  delete process.env.MEMESH_UPDATE_CHECK_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function req(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}${urlPath}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
}

describe('HTTP Transport: POST /v1/dream/run', () => {
  it('accepts the body and returns DreamerResult shape', async () => {
    // No LLM configured in the test environment → runDreamer short-
    // circuits with a "no LLM configured" skip. We surface that as a
    // 400 in server.ts (config error, not a runtime failure), so the
    // success path here is the route accepting the body and the
    // server returning a *structured* response — not a raw 500 or a
    // routing 404.
    const res = await req('POST', '/v1/dream/run', {
      windowDays: 14,
      maxLlmCalls: 1,
    });
    // Either 200 (LLM configured locally) or 400 (no-llm fast path)
    // is acceptable; what we're guarding against is a 404/500 that
    // would mean the route isn't wired or threw unexpectedly.
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      // DreamerResult shape — see src/core/dreamer.ts.
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.proposalsCreated).toBe('number');
      expect(typeof res.body.data.clustersScanned).toBe('number');
      expect(typeof res.body.data.llmCalls).toBe('number');
      expect(typeof res.body.data.durationMs).toBe('number');
      expect(Array.isArray(res.body.data.skipped)).toBe(true);
    } else {
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error).toBe('string');
      // Body must be parsed and reach handler — error must be the
      // no-LLM message, not a Zod validation failure.
      expect(res.body.error.toLowerCase()).toContain('llm');
    }
  });

  it('accepts validate=true without 400 (route plumbing check)', async () => {
    // We can't assert validator LLM calls without a real provider, so
    // the contract here is narrower: the route MUST accept the
    // `validate` field as part of the body schema. Earlier wiring
    // attempts dropped unknown fields silently via .strip() and the
    // CLI was the only path with the flag — this test catches a
    // regression where the field gets dropped at the HTTP boundary.
    const res = await req('POST', '/v1/dream/run', {
      maxLlmCalls: 1,
      validate: true,
    });
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) {
      // 400 is acceptable ONLY for the no-LLM-configured path. A Zod
      // failure on the `validate` field would be a regression.
      expect(res.body.error.toLowerCase()).not.toContain('validate:');
    }
  });

  it('returns 400 for out-of-bounds windowDays', async () => {
    const res = await req('POST', '/v1/dream/run', {
      windowDays: 999, // > 90 max
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/windowDays/);
  });

  it('returns 400 for out-of-bounds maxLlmCalls', async () => {
    const res = await req('POST', '/v1/dream/run', {
      maxLlmCalls: 100, // > 20 max
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/maxLlmCalls/);
  });

  it('returns 400 for non-boolean validate', async () => {
    const res = await req('POST', '/v1/dream/run', {
      // Wrong type — should fail Zod validation rather than coerce.
      validate: 'yes' as unknown as boolean,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('HTTP Transport: POST /v1/dream/proposals/:id/accept', () => {
  it('answers an empty-claim proposal with 400 operation.failed, not 500', async () => {
    // NothingToClaimError is the server resolving the proposal, not the server
    // breaking. As a 500 `server.internal` a dashboard's generic retry logic
    // retried it, and the retry — the proposal now being rejected — got a 404:
    // two contradictory errors for one click. The contract is one answer that
    // names the outcome.
    const { getDatabase } = await import('../../src/db.js');
    const db = getDatabase();
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version)
      VALUES ('memesh', '2026-W19', ?, ?, 'ollama/fake', 'v1')
    `).run(
      JSON.stringify([999901, 999902]), // no such entities — the digest can claim nothing
      JSON.stringify({ name: 'http-empty-digest', type: 'digest', observations: ['s'], tags: ['digest'] })
    );
    const id = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;

    const res = await req('POST', `/v1/dream/proposals/${id}/accept`);
    expect(res.status, 'an empty-claim proposal surfaced as a server failure').toBe(400);
    expect(res.body.errorCode).toBe('operation.failed');
    expect(res.body.error).toMatch(/claimed nothing/);

    // And the server really did resolve it: rejected, not still pending.
    const row = db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('rejected');
  });
});
