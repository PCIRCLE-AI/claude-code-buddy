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

  it('probeProvider routes to the right probe function', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'claude-haiku-4-5' }] }),
    })) as any;

    const r = await probeProvider('anthropic', 'sk-ant-fake');
    expect(r.valid).toBe(true);

    const bad = await probeProvider('unknown' as any, '');
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain('Unknown provider');
  });
});
