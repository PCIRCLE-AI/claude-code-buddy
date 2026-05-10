import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callLLM, classifyError, type LLMAttempt } from '../../src/core/llm-client.js';

// Cross-provider failover behaviour pinned by these tests. Live API
// calls are stubbed via fetch mocking — none of these tests touch
// network, so they're safe to run in CI without secrets. Pattern:
// build a queue of fake responses, shift one per fetch call, assert
// that the chain walks them in order until success or exhaustion.

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}
function makeFetch(queue: FakeResponse[]) {
  return vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error('test bug: fetch queue exhausted');
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  });
}

describe('callLLM — cross-provider failover', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => { /* set per-test */ });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('uses primary when primary succeeds (no fallback consulted)', async () => {
    globalThis.fetch = makeFetch([
      { ok: true, status: 200, body: { content: [{ text: 'primary-said-hi' }] } },
    ]);
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'sk-ant-test' }, {
      fallbacks: [{ provider: 'ollama', model: 'gemma4:e4b' }],
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('primary-said-hi');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider: 'anthropic', status: 'ok', index: 0 });
  });

  it('falls through to ollama when anthropic 401s (the maintainer\'s scenario)', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 401, body: { error: { message: 'invalid x-api-key' } } },
      { ok: true, status: 200, body: { response: 'ollama-rescue' } },
    ]);
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'dead-key' }, {
      fallbacks: [{ provider: 'ollama', model: 'gemma4:e4b' }],
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('ollama-rescue');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ provider: 'anthropic', status: 'fail', errorClass: 'auth', index: 0 });
    expect(attempts[1]).toMatchObject({ provider: 'ollama', status: 'ok', index: 1 });
  });

  it('walks a 3-link chain when primary + first fallback both die', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 401, body: { error: { message: 'invalid x-api-key' } } },  // anthropic
      { ok: false, status: 401, body: { error: { message: 'invalid_api_key' } } },     // openai
      { ok: true, status: 200, body: { response: 'ollama-last-resort' } },             // ollama
    ]);
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'dead' }, {
      fallbacks: [
        { provider: 'openai', apiKey: 'also-dead' },
        { provider: 'ollama', model: 'gemma4:e4b' },
      ],
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('ollama-last-resort');
    expect(attempts.map(a => a.provider)).toEqual(['anthropic', 'openai', 'ollama']);
    expect(attempts.map(a => a.status)).toEqual(['fail', 'fail', 'ok']);
  });

  it('throws the LAST error if every link in the chain fails', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 401, body: {} },
      { ok: false, status: 500, body: {} },
    ]);
    const attempts: LLMAttempt[] = [];
    await expect(
      callLLM('hi', { provider: 'anthropic', apiKey: 'dead' }, {
        fallbacks: [{ provider: 'ollama', model: 'gemma4:e4b' }],
        onAttempt: (a) => { attempts.push(...a); },
      })
    ).rejects.toThrow(/Ollama error: 500/);
    expect(attempts).toHaveLength(2);
    expect(attempts.every(a => a.status === 'fail')).toBe(true);
  });

  it('does NOT walk fallbacks on a 400 bad-request — same prompt will fail everywhere', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 400, body: { error: { message: 'context window exceeded' } } },
      // ollama mock NOT consumed because failover halts
    ]);
    const attempts: LLMAttempt[] = [];
    await expect(
      callLLM('hi', { provider: 'anthropic', apiKey: 'good-key' }, {
        fallbacks: [{ provider: 'ollama', model: 'gemma4:e4b' }],
        onAttempt: (a) => { attempts.push(...a); },
      })
    ).rejects.toThrow(/400/);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider: 'anthropic', status: 'fail', errorClass: 'bad_request' });
  });

  it('falls through on 429 rate-limit (treats as transient)', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 429, body: { error: { message: 'rate_limit_error' } } },
      { ok: true, status: 200, body: { response: 'ollama-handled-it' } },
    ]);
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'rate-limited' }, {
      fallbacks: [{ provider: 'ollama' }],
    });
    expect(out).toBe('ollama-handled-it');
  });

  it('falls through on 5xx upstream (treats as transient)', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 503, body: { error: { message: 'service unavailable' } } },
      { ok: true, status: 200, body: { response: 'ollama-handled-outage' } },
    ]);
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'good' }, {
      fallbacks: [{ provider: 'ollama' }],
    });
    expect(out).toBe('ollama-handled-outage');
  });

  it('redacts credential-shaped tokens in onAttempt errorMessage', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 401, body: { error: { message: 'Incorrect API key provided: sk-proj-AAAAAAAAAAAAAAAAAAAA' } } },
      { ok: true, status: 200, body: { response: 'rescued' } },
    ]);
    const attempts: LLMAttempt[] = [];
    await callLLM('hi', { provider: 'openai', apiKey: 'sk-proj-AAAAAAAAAAAAAAAAAAAA' }, {
      fallbacks: [{ provider: 'ollama' }],
      onAttempt: (a) => { attempts.push(...a); },
    });
    // The error message that came back included a key-shaped token in
    // OpenAI's response body — but the version we ship to the
    // telemetry callback should be redacted. callLLM only sees the
    // wrapped error from callSingle ("OpenAI API error: 401") so the
    // redaction is mostly defensive — confirm the wrapper message at
    // least never contains a raw `sk-` token.
    expect(attempts[0].errorMessage).not.toMatch(/sk-proj-[A-Za-z0-9_-]+/);
  });

  it('preserves single-provider behaviour when no fallbacks supplied', async () => {
    globalThis.fetch = makeFetch([
      { ok: false, status: 401, body: {} },
    ]);
    await expect(
      callLLM('hi', { provider: 'anthropic', apiKey: 'dead' })
    ).rejects.toThrow(/Anthropic API error: 401/);
  });
});

describe('classifyError', () => {
  it.each([
    ['Anthropic API error: 401', 'auth'],
    ['OpenAI API error: 403', 'auth'],
    ['invalid x-api-key', 'auth'],
    ['no API key configured', 'auth'],
    ['rate_limit_error: 429', 'rate_limit'],
    ['quota exceeded', 'rate_limit'],
    ['Anthropic API error: 503', 'upstream'],
    ['service unavailable', 'upstream'],
    ['bad gateway', 'upstream'],
    ['Anthropic API error: 400', 'bad_request'],
    ['fetch failed', 'network'],
    ['ECONNREFUSED 127.0.0.1:11434', 'network'],
    ['ETIMEDOUT', 'network'],
    ['something completely unexpected', 'unknown'],
  ])('classifies %s -> %s', (msg, expected) => {
    expect(classifyError(new Error(msg))).toBe(expected);
  });
});
