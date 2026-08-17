/**
 * `providerFetch` shipped with zero tests, and it is the whole reason a rebuild
 * is bounded at all.
 *
 * Before it, the two provider calls used a bare `fetch`: no timeout, so a
 * provider that accepted the connection and never answered hung a rebuild
 * indefinitely; and no status inspection, so a 429 was indistinguishable from a
 * 500 or a 401 — a rate limit produced the same silent `null` as a bad key while
 * the run kept spending entities that would all fail the same way.
 *
 * Every branch below was reachable and unexercised. Two shapes matter when
 * writing more of these:
 *
 *   - An `ok: false` stub MUST supply `headers` (a real `Headers`), because the
 *     retry path reads `res.headers.get('retry-after')`. Omit it and the test
 *     throws inside the catch and "passes" for the wrong reason.
 *   - `PROVIDER_TIMEOUT_MS` is 30_000 and vitest's own testTimeout is 30_000, so
 *     the timeout branch can never be reached by waiting. It is provoked by
 *     rejecting with an Error named `TimeoutError`, which is what
 *     `AbortSignal.timeout` produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { embedText } from '../../src/core/embedder.js';

const OPENAI_DIM = 1536;

/** A successful embedding response of the width OpenAI's model returns. */
const okEmbedding = (n = OPENAI_DIM) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ data: [{ embedding: Array.from({ length: n }, () => 0.1) }] }),
}) as unknown as Response;

/** A failure response. `headers` is not optional — the retry path reads it. */
const fail = (status: number, headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
}) as unknown as Response;

describe('Feature: provider embedding requests are bounded and classified', () => {
  let dir: string;
  let savedMemeshDir: string | undefined;
  let savedKey: string | undefined;
  let written: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pfetch-'));
    savedMemeshDir = process.env.MEMESH_DIR;
    savedKey = process.env.OPENAI_API_KEY;
    process.env.MEMESH_DIR = dir;
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ embedder: { provider: 'openai' } }),
    );
    written = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stderrSpy.mockRestore();
    vi.useRealTimers();
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops immediately on a 401 instead of spending the rate budget on a certainty', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401));

    expect(await embedText('anything')).toBeNull();

    expect(f, 'a bad API key was retried — configuration is not weather').toHaveBeenCalledTimes(1);
    expect(written.join(''), 'the status the user needs in order to act was not named')
      .toContain('HTTP 401');
  });

  it('retries a 429 and succeeds, honouring Retry-After rather than guessing', async () => {
    vi.useFakeTimers();
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(okEmbedding());

    const pending = embedText('anything');

    await vi.advanceTimersByTimeAsync(1_999);
    expect(f, 'retried before the server said it could').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(result, 'the retry that the server permitted did not produce a vector').not.toBeNull();
    expect(result!.length).toBe(OPENAI_DIM);
  });

  it('caps an absurd Retry-After instead of sleeping for as long as it asks', async () => {
    vi.useFakeTimers();
    // 86400s = one day. The cap is PROVIDER_MAX_BACKOFF_MS (30s).
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(429, { 'retry-after': '86400' }))
      .mockResolvedValueOnce(okEmbedding());

    const pending = embedText('anything');
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(pending).resolves.not.toBeNull();
    expect(f, 'a provider-supplied delay was allowed to stall the run').toHaveBeenCalledTimes(2);
  });

  it('gives up after three attempts on a 5xx and names the status', async () => {
    vi.useFakeTimers();
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(503));

    const pending = embedText('anything');
    // Exponential: 500ms then 1000ms. Advance past both.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await pending).toBeNull();
    expect(f, 'the attempt budget was not three').toHaveBeenCalledTimes(3);
    expect(written.join('')).toContain('after 3 attempts');
    expect(written.join('')).toContain('HTTP 503');
  });

  it('reports a timeout AS a timeout, not as a generic failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );

    const pending = embedText('anything');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await pending).toBeNull();
    expect(
      written.join(''),
      'a hung provider and a broken one were reported identically',
    ).toContain('timed out after 30000ms');
  });

  it('retries a body that fails AFTER the headers arrived', async () => {
    // The regression this pins: `res.json()` used to be awaited in the caller,
    // outside the retry. A provider that returned 200 headers and then stalled
    // or truncated the body threw from there — no retry, no attempt counter, and
    // an indistinguishable null. Which is exactly the failure the timeout exists
    // to catch.
    vi.useFakeTimers();
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
      } as unknown as Response)
      .mockResolvedValueOnce(okEmbedding());

    const pending = embedText('anything');
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result, 'a body-phase failure was not retried').not.toBeNull();
    expect(f, 'the second attempt never happened').toHaveBeenCalledTimes(2);
  });

  it('refuses to follow a redirect, so the memory text cannot be sent elsewhere', async () => {
    // undici strips Authorization across origins but a 307 forwards the POST
    // body, and OLLAMA_HOST is an unvalidated env var. The request is made with
    // redirect: 'error', so the assertion is on what fetch was ASKED to do —
    // the alternative would be asserting undici's behaviour, not ours.
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okEmbedding());

    await embedText('a private memory');

    const init = f.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect, 'the provider request may follow a redirect').toBe('error');
  });

  it('does not log the request body or the API key', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(500));

    const pending = embedText('a private memory that must not be logged');
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    const all = written.join('');
    expect(all, 'the memory text reached stderr').not.toContain('a private memory');
    expect(all, 'the API key reached stderr').not.toContain('sk-test-not-a-real-key');
  });
});
