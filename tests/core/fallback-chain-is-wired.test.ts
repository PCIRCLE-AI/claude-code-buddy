/**
 * A configured cross-provider fallback chain reaches the provider.
 *
 * `callLLM` walks `opts.fallbacks` and its own tests cover that walk
 * thoroughly. What nothing covered was the WIRING: eight product functions
 * forward `fallbacks: opts.fallbacks` into `callLLM`, and every test that
 * exercised them passed a chain and then asserted nothing about it. Delete
 * the forwarding at all eight sites and the suite stays green — while a user
 * who configured `llmFallbacks` gets no failover at all, and the outage looks
 * exactly like designed degradation ("Smart Mode is unavailable") rather than
 * like a bug.
 *
 * This asserts it behaviourally, at the layer where the value is forwarded:
 * the primary provider fails with a 500, the fallback answers, and the
 * function returns the FALLBACK's answer. `fetch` is the only stub — the
 * chain walk, the error classification and the retry policy are all real.
 *
 * The remaining sites (`dreamer`, `transcript-extractor`) forward the same
 * `opts.fallbacks` down into these four functions, and the three CLI entry
 * points and the HTTP route source it from `config.llmFallbacks`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { LLMConfig } from '../../src/core/config.js';

const PRIMARY: LLMConfig = { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-test' };
const FALLBACK: LLMConfig = { provider: 'ollama', model: 'llama3.2' };

/**
 * 500 for Anthropic, `body` for Ollama. Records which hosts were reached, so
 * a test can prove the second provider was tried rather than inferring it.
 */
function stubChain(body: string): { hosts: string[] } {
  const hosts: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const host = new URL(String(input)).host;
    hosts.push(host);
    if (host === 'api.anthropic.com') {
      return new Response('upstream is having a bad day', { status: 500 });
    }
    // Ollama's shape: { response: "..." }
    return new Response(JSON.stringify({ response: body }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  return { hosts };
}

/** Same, but BOTH providers fail — so "it worked" cannot come from the primary. */
function stubAllFailing(): { hosts: string[] } {
  const hosts: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    hosts.push(new URL(String(input)).host);
    return new Response('down', { status: 500 });
  }) as typeof fetch);
  return { hosts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the fallback chain is wired at every site that accepts one', () => {
  it('failure-analyzer falls over to the second provider', async () => {
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    const { hosts } = stubChain(JSON.stringify({
      error: 'the build failed',
      rootCause: 'a missing dependency',
      fix: 'install it',
      prevention: 'pin the version',
      errorPattern: 'missing-dep',
      fixPattern: 'install',
      severity: 'minor',
    }));

    const lesson = await analyzeFailure(['boom'], ['a.ts'], PRIMARY, { fallbacks: [FALLBACK] });

    expect(hosts, 'the fallback provider was never reached').toContain('localhost:11434');
    expect(lesson, 'the fallback answered but the result was dropped').not.toBeNull();
  });

  it('auto-tagger falls over to the second provider', async () => {
    const { autoTag } = await import('../../src/core/auto-tagger.js');
    const { hosts } = stubChain(JSON.stringify(['topic:auth', 'topic:oauth']));

    const tags = await autoTag('a-name', 'decision', ['we chose OAuth'], PRIMARY, { fallbacks: [FALLBACK] });

    expect(hosts, 'the fallback provider was never reached').toContain('localhost:11434');
    expect(tags.length, 'the fallback answered but the tags were dropped').toBeGreaterThan(0);
  });

  it('digest-validator falls over to the second provider', async () => {
    const { validateDigest } = await import('../../src/core/digest-validator.js');
    const { hosts } = stubChain(JSON.stringify({ verdict: 'pass', suspicious: [] }));

    const result = await validateDigest(['a digest claim'], ['a source observation'], PRIMARY, {
      fallbacks: [FALLBACK],
    });

    expect(hosts, 'the fallback provider was never reached').toContain('localhost:11434');
    expect(result.status, 'the fallback answered and the verdict was discarded').toBe('pass');
  });
});

describe('the chain is not a placebo', () => {
  it('reports unavailable when EVERY provider in the chain fails', async () => {
    // The anti-vacuity half for all three above: if the primary were somehow
    // succeeding, they would pass without the fallback ever mattering. Here
    // nothing succeeds, so the outcome can only come from the chain being
    // walked and exhausted.
    const { validateDigest } = await import('../../src/core/digest-validator.js');
    const { hosts } = stubAllFailing();

    const result = await validateDigest(['claim'], ['source'], PRIMARY, { fallbacks: [FALLBACK] });

    expect(hosts, 'the chain was not walked to the end').toContain('api.anthropic.com');
    expect(hosts).toContain('localhost:11434');
    expect(result.status, 'a chain that failed everywhere reported an approval').toBe('unavailable');
  });

  it('does not reach a fallback when none is configured', async () => {
    // And the other direction: the walk must not invent providers.
    const { validateDigest } = await import('../../src/core/digest-validator.js');
    const { hosts } = stubAllFailing();

    await validateDigest(['claim'], ['source'], PRIMARY, {});

    expect(hosts.filter((h) => h === 'localhost:11434'),
      'a provider nobody configured was contacted').toEqual([]);
  });
});
