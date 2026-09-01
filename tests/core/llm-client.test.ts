import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callLLM, classifyError, LLMResponseParseError, type LLMAttempt } from '../../src/core/llm-client.js';

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

  // ---------------------------------------------------------------------------
  // Response shape validation — the historical pitfall was that a 2xx body
  // with missing/renamed fields silently extracted '' and the failover loop
  // treated that as success, so a malformed provider response would block
  // the fallback chain. With LLMResponseParseError, drift now classifies as
  // 'parse' and the next provider is tried.
  // ---------------------------------------------------------------------------

  it('falls through to fallback when anthropic returns a malformed 2xx body', async () => {
    globalThis.fetch = makeFetch([
      { ok: true, status: 200, body: { unexpected: 'shape' } }, // no content[]
      { ok: true, status: 200, body: { response: 'ollama-rescued-drift' } },
    ]);
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'sk-ant-test' }, {
      fallbacks: [{ provider: 'ollama', model: 'gemma4:e4b' }],
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('ollama-rescued-drift');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ provider: 'anthropic', status: 'fail', errorClass: 'parse', index: 0 });
    expect(attempts[1]).toMatchObject({ provider: 'ollama', status: 'ok', index: 1 });
  });

  it('classifies a 2xx OpenAI body with renamed top-level fields as parse', async () => {
    globalThis.fetch = makeFetch([
      { ok: true, status: 200, body: { results: [{ text: 'wrong shape' }] } },
      { ok: true, status: 200, body: { response: 'ollama-rescued' } },
    ]);
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'openai', apiKey: 'sk-test' }, {
      fallbacks: [{ provider: 'ollama' }],
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('ollama-rescued');
    expect(attempts[0]).toMatchObject({ provider: 'openai', status: 'fail', errorClass: 'parse' });
  });

  it('an empty string from the provider is NOT a parse error (provider replied "" intentionally)', async () => {
    globalThis.fetch = makeFetch([
      { ok: true, status: 200, body: { content: [{ text: '' }] } },
    ]);
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'sk-ant-test' }, {
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('');
    expect(attempts[0]).toMatchObject({ provider: 'anthropic', status: 'ok' });
  });

  it('non-JSON 2xx body classifies as parse and walks to fallback', async () => {
    const queue = [
      { ok: true, status: 200, body: { response: 'ollama-rescued' } },
    ];
    // Custom fetch: anthropic responds 200 with a body that throws on .json().
    // Route by exact hostname (not substring) — substring matching against
    // 'anthropic.com' would also match attacker-controlled hosts like
    // anthropic.com.evil.example, which is exactly the CodeQL
    // "incomplete URL substring sanitization" anti-pattern.
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      let hostname = '';
      try { hostname = typeof url === 'string' ? new URL(url).hostname : ''; } catch { /* not a URL */ }
      if (hostname === 'api.anthropic.com') {
        return {
          ok: true, status: 200,
          json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
          text: async () => '<html>cdn error page</html>',
        } as unknown as Response;
      }
      const r = queue.shift()!;
      return {
        ok: r.ok, status: r.status,
        json: async () => r.body, text: async () => JSON.stringify(r.body),
      } as unknown as Response;
    });
    const attempts: LLMAttempt[] = [];
    const out = await callLLM('hi', { provider: 'anthropic', apiKey: 'sk-ant-test' }, {
      fallbacks: [{ provider: 'ollama' }],
      onAttempt: (a) => { attempts.push(...a); },
    });
    expect(out).toBe('ollama-rescued');
    expect(attempts[0]).toMatchObject({ status: 'fail', errorClass: 'parse' });
  });
});

describe('callLLM — a config that names no provider', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  /**
   * `memesh config set llm.apiKey sk-…` without `llm.provider` writes
   * `{ apiKey: "sk-…" }`. The dispatcher used to fall off the end of its
   * provider chain and `return ''`, which the failover loop records as
   * `status: 'ok'`. Every LLM-backed feature then did nothing and reported
   * success: `dream patterns` counted a call that never happened, auto-tagging
   * produced no tags, `doctor` said PASS. Absence of a failure signal is not
   * success.
   */
  it('fails instead of returning an empty string', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const attempts: LLMAttempt[] = [];
    await expect(
      callLLM('hi', { apiKey: 'sk-test' } as never, { onAttempt: (a) => { attempts.push(...a); } })
    ).rejects.toThrow(/llm\.provider/);

    // No HTTP call was even attempted, and the attempt is recorded as a
    // failure — a row saying `status: 'ok'` is what made this invisible.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(attempts[0]).toMatchObject({ status: 'fail' });
  });

  it('still walks on to a fallback that IS configured', async () => {
    globalThis.fetch = makeFetch([
      { ok: true, status: 200, body: { response: 'ollama-rescued' } },
    ]);
    const out = await callLLM('hi', { apiKey: 'sk-test' } as never, {
      fallbacks: [{ provider: 'ollama' }],
    });
    expect(out).toBe('ollama-rescued');
  });
});

describe('callLLM — Ollama host trust boundary', () => {
  const originalFetch = globalThis.fetch;
  const originalOllamaHost = process.env.OLLAMA_HOST;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalOllamaHost;
  });

  it.each([
    'http://attacker.example:11434',
    'http://0.0.0.0:11434',
  ])('rejects persisted non-loopback host %s before sending the prompt', async (host) => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(callLLM('private memory', {
      provider: 'ollama',
      host,
    })).rejects.toThrow(/must be loopback/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not let OLLAMA_HOST disable validation of a persisted host', async () => {
    process.env.OLLAMA_HOST = 'http://operator-ollama.example:11434';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(callLLM('private memory', {
      provider: 'ollama',
      host: 'http://attacker.example:11434',
    })).rejects.toThrow(/must be loopback/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not send the prompt to a fallback after rejecting an unsafe host', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(callLLM('private memory', {
      provider: 'ollama',
      host: 'http://attacker.example:11434',
    }, {
      fallbacks: [{ provider: 'anthropic', apiKey: 'sk-ant-test' }],
    })).rejects.toThrow(/must be loopback/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses an operator-controlled remote host only when config does not supply one', async () => {
    process.env.OLLAMA_HOST = 'http://operator-ollama.example:11434/';
    globalThis.fetch = makeFetch([
      { ok: true, status: 200, body: { response: 'operator-host-ok' } },
    ]);

    await expect(callLLM('private memory', { provider: 'ollama' }))
      .resolves.toBe('operator-host-ok');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://operator-ollama.example:11434/api/generate',
      expect.any(Object),
    );
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

  it('classifies an LLMResponseParseError instance as parse regardless of message', () => {
    expect(classifyError(new LLMResponseParseError('anthropic', 'missing content'))).toBe('parse');
    expect(classifyError(new LLMResponseParseError('openai', 'body is not valid JSON'))).toBe('parse');
  });
});
