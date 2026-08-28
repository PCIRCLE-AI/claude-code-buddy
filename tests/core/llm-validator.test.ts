import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pickSuggestedModel,
  probeAnthropic,
  probeOpenAI,
  probeOllama,
  probeProvider,
  type ModelInfo,
} from '../../src/core/llm-validator.js';

describe('pickSuggestedModel', () => {
  it('returns undefined for empty list', () => {
    expect(pickSuggestedModel([])).toBeUndefined();
  });

  it('prefers small-tier hints (mini, nano, haiku, flash, lite)', () => {
    const models: ModelInfo[] = [
      { id: 'big-flagship-300b' },
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o' },
    ];
    expect(pickSuggestedModel(models)).toBe('gpt-4o-mini');
  });

  it('matches haiku for Anthropic naming', () => {
    const models: ModelInfo[] = [
      { id: 'claude-opus-4' },
      { id: 'claude-sonnet-4' },
      { id: 'claude-haiku-4-5' },
    ];
    expect(pickSuggestedModel(models)).toBe('claude-haiku-4-5');
  });

  it('falls back to first model when no small-tier hint matches', () => {
    const models: ModelInfo[] = [
      { id: 'flagship-1' },
      { id: 'flagship-2' },
    ];
    expect(pickSuggestedModel(models)).toBe('flagship-1');
  });

  it('prefers most-recent created when multiple small-tier candidates exist', () => {
    const models: ModelInfo[] = [
      { id: 'gpt-4-mini', created: '2024-01-01' },
      { id: 'gpt-5-mini', created: '2026-01-01' },
      { id: 'gpt-3-mini', created: '2023-01-01' },
    ];
    expect(pickSuggestedModel(models)).toBe('gpt-5-mini');
  });
});

describe('provider probes (mocked fetch)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('probeAnthropic returns models on success', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'claude-opus-4', created_at: '2026-01-15' },
          { id: 'claude-haiku-4-5', created_at: '2026-04-01' },
        ],
      }),
    })) as any;

    const r = await probeAnthropic('sk-ant-fake');
    expect(r.valid).toBe(true);
    expect(r.models).toHaveLength(2);
    expect(r.suggested).toBe('claude-haiku-4-5');
  });

  it('probeAnthropic surfaces 401 with provider message', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    })) as any;

    const r = await probeAnthropic('sk-ant-bad');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('invalid x-api-key');
    expect(r.error).toContain('authentication_error');
  });

  it('probeAnthropic rejects a 200 whose body has no models', async () => {
    // What a corporate proxy or auth-portal interstitial looks like: HTTP 200,
    // parseable JSON, nothing in it. `data.data ?? []` used to turn that into
    // `valid: true, models: []` — "answered with nothing" reading as
    // "verified working" in doctor --probe and the dashboard test button.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as any;

    const r = await probeAnthropic('sk-ant-fake');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('no models');
  });

  it('probeOpenAI rejects a 200 whose body has no models', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as any;

    const r = await probeOpenAI('sk-fake');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('no chat-capable models');
  });

  it('probeAnthropic rejects empty key without calling network', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const r = await probeAnthropic('');
    expect(r.valid).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probeOpenAI filters non-chat models', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gpt-4o-mini', created: 1700000000 },
          { id: 'whisper-1' },
          { id: 'tts-1' },
          { id: 'text-embedding-3-small' },
          { id: 'gpt-5-mini', created: 1750000000 },
        ],
      }),
    })) as any;

    const r = await probeOpenAI('sk-fake');
    expect(r.valid).toBe(true);
    const ids = r.models!.map((m) => m.id);
    expect(ids).toContain('gpt-4o-mini');
    expect(ids).toContain('gpt-5-mini');
    expect(ids).not.toContain('whisper-1');
    expect(ids).not.toContain('tts-1');
    expect(ids).not.toContain('text-embedding-3-small');
  });

  it('probeOllama returns "not reachable" when fetch fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    }) as any;

    const r = await probeOllama('http://localhost:11434');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('not reachable');
  });

  it('probeOllama returns "no models installed" when reachable but empty', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    })) as any;

    const r = await probeOllama('http://localhost:11434');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('no models installed');
  });

  it('probeOllama rejects non-loopback host (SSRF guard)', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const r = await probeOllama('http://10.0.0.5:11434');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('loopback');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probeOllama rejects file:// and other non-http schemes', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const r = await probeOllama('file:///etc/passwd');
    expect(r.valid).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probeOllama allows OLLAMA_HOST env var to override loopback restriction', async () => {
    const original = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://internal-ollama.example:11434';
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'llama3' }] }),
    })) as any;
    try {
      // Pass no host arg — env var path is privileged (operator-controlled)
      const r = await probeOllama();
      expect(r.valid).toBe(true);
    } finally {
      if (original === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = original;
    }
  });

  it('error messages from upstream are stripped of control characters', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              const json = JSON.stringify({
                error: { type: 'auth', message: 'bad\x00key\x07with\x1Bcontrol' },
              });
              return { done: false, value: new TextEncoder().encode(json) };
            },
            cancel: async () => {},
          };
        },
      },
      text: async () => '',
    })) as any;

    const r = await probeAnthropic('sk-ant-bad');
    expect(r.valid).toBe(false);
    expect(r.error).not.toMatch(/[\x00-\x08\x0B-\x1F]/);
    expect(r.error).toContain('bad');
    expect(r.error).toContain('key');
  });

  it('probeProvider requires a real inference response after catalog access', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => url.includes('/v1/models')
          ? { data: [{ id: 'claude-haiku-4-5' }] }
          : { content: [{ text: 'OK' }] },
      };
    }) as any;

    const r = await probeProvider('anthropic', 'sk-ant-fake');
    expect(r.valid).toBe(true);
    expect(r.catalogVerified).toBe(true);
    expect(r.inferenceVerified).toBe(true);
    expect(r.testedModel).toBe('claude-haiku-4-5');

    const bad = await probeProvider('unknown' as any, '');
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain('Unknown provider');
  });

  it('does not present model-list success as readiness when the selected model fails inference', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'gpt-compatible' }, { id: 'gpt-listed-only' }] }),
        };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    });
    global.fetch = fetchSpy as any;

    const r = await probeProvider('openai', 'sk-fixture', undefined, 'gpt-listed-only');
    expect(r.valid).toBe(false);
    expect(r.catalogVerified).toBe(true);
    expect(r.inferenceVerified).toBe(false);
    expect(r.testedModel).toBe('gpt-listed-only');
    expect(r.errorCode).toBe('inference_failed');
    expect(r.error).toContain('gpt-listed-only');
    expect(r.models?.map((entry) => entry.id)).toContain('gpt-compatible');

    const inferenceCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/chat/completions'));
    expect(inferenceCall).toBeDefined();
    expect(JSON.parse(String(inferenceCall?.[1]?.body))).toMatchObject({ model: 'gpt-listed-only' });
  });
});
