import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember, recall, consolidate } from '../../src/core/operations.js';
import { readConfig, writeConfig } from '../../src/core/config.js';

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;
let savedConfig: any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-consolidate-'));
  openDatabase(path.join(tmpDir, 'test.db'));

  // Snapshot and clear all LLM-related env vars so tests are hermetic
  savedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OLLAMA_HOST: process.env.OLLAMA_HOST,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_HOST;

  // Also clear config.json LLM settings for hermetic tests
  savedConfig = readConfig();
  const cleanConfig = { ...savedConfig };
  delete cleanConfig.llm;
  writeConfig(cleanConfig);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Restore env
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  // Restore config
  writeConfig(savedConfig);

  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// No LLM configured
// ---------------------------------------------------------------------------

describe('consolidate — no LLM configured', () => {
  it('returns error message when no LLM provider is configured', async () => {
    const result = await consolidate({});
    expect(result.error).toContain('LLM provider');
    expect(result.error).toContain('memesh setup');
    expect(result.consolidated).toBe(0);
    expect(result.entities_processed).toEqual([]);
    expect(result.observations_before).toBe(0);
    expect(result.observations_after).toBe(0);
  });

  it('returns error for specific entity when no LLM configured', async () => {
    remember({ name: 'entity-a', type: 'note', observations: ['a', 'b', 'c', 'd', 'e'] });
    const result = await consolidate({ name: 'entity-a' });
    expect(result.error).toBeDefined();
    expect(result.consolidated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// min_observations threshold
// ---------------------------------------------------------------------------

describe('consolidate — min_observations threshold', () => {
  beforeEach(() => {
    // Provide a fake LLM key so detectCapabilities sees an LLM
    process.env.ANTHROPIC_API_KEY = 'test-key-fake';
  });

  it('skips entities with fewer observations than default threshold (5)', async () => {
    remember({ name: 'small', type: 'note', observations: ['a', 'b'] });

    // No real API call should happen — mock fetch to catch if it does
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const result = await consolidate({ name: 'small' });

    // Entity has 2 obs < 5 threshold → nothing to consolidate
    expect(result.consolidated).toBe(0);
    expect(result.entities_processed).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips entity when observations exactly equal threshold minus one', async () => {
    remember({ name: 'borderline', type: 'note', observations: ['a', 'b', 'c', 'd'] }); // 4 obs

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
    } as any);

    const result = await consolidate({ name: 'borderline', min_observations: 5 });
    expect(result.consolidated).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('processes entity when observation count equals min_observations exactly', async () => {
    remember({
      name: 'exact-threshold',
      type: 'note',
      observations: ['obs1', 'obs2', 'obs3'],
    });

    // Mock a successful LLM response that compresses 3 obs into 1
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: '["Compressed summary of all three observations."]' }],
      }),
    } as any);

    const result = await consolidate({ name: 'exact-threshold', min_observations: 3 });
    expect(result.consolidated).toBe(1);
    expect(result.entities_processed).toContain('exact-threshold');
    expect(result.observations_before).toBe(3);
    expect(result.observations_after).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Successful consolidation
// ---------------------------------------------------------------------------

describe('consolidate — successful LLM compression', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key-fake';
  });

  it('replaces observations with compressed result', async () => {
    remember({
      name: 'verbose-entity',
      type: 'decision',
      observations: ['fact one', 'fact two', 'fact three', 'fact four', 'fact five'],
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: '["Dense summary of all facts."]' }],
      }),
    } as any);

    const result = await consolidate({ name: 'verbose-entity' });

    expect(result.consolidated).toBe(1);
    expect(result.entities_processed).toContain('verbose-entity');
    expect(result.observations_before).toBe(5);
    expect(result.observations_after).toBe(1);

    // Entity should now have the compressed observation
    const entities = recall({ query: 'Dense summary' });
    expect(entities).toHaveLength(1);
    expect(entities[0].observations).toContain('Dense summary of all facts.');
  });

  it('leaves entity unchanged when LLM returns same count or more', async () => {
    remember({
      name: 'unchanged-entity',
      type: 'note',
      observations: ['a', 'b', 'c', 'd', 'e'],
    });

    // LLM returns 5 items — no compression gain
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: '["a", "b", "c", "d", "e"]' }],
      }),
    } as any);

    const result = await consolidate({ name: 'unchanged-entity' });

    // Same count: no compression
    expect(result.consolidated).toBe(0);
    expect(result.observations_before).toBe(5);
    expect(result.observations_after).toBe(5);

    // Original observations still present
    const entities = recall({ query: 'a' });
    expect(entities).toHaveLength(1);
    expect(entities[0].observations).toHaveLength(5);
  });

  it('leaves entity unchanged when LLM call fails', async () => {
    remember({
      name: 'fail-entity',
      type: 'note',
      observations: ['x', 'y', 'z', 'w', 'v'],
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const result = await consolidate({ name: 'fail-entity' });

    expect(result.consolidated).toBe(0);
    expect(result.observations_before).toBe(5);
    expect(result.observations_after).toBe(5);

    // Original observations still present
    const entity = recall({ query: 'x' });
    expect(entity).toHaveLength(1);
    expect(entity[0].observations).toHaveLength(5);
  });

  it('leaves entity unchanged when LLM returns malformed JSON', async () => {
    remember({
      name: 'malformed-entity',
      type: 'note',
      observations: ['p', 'q', 'r', 's', 't'],
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: 'not valid json at all' }],
      }),
    } as any);

    const result = await consolidate({ name: 'malformed-entity' });

    expect(result.consolidated).toBe(0);
    expect(result.observations_before).toBe(5);
    expect(result.observations_after).toBe(5);
  });

  it('reports consolidated=0 when entity does not exist', async () => {
    const result = await consolidate({ name: 'nonexistent-entity' });
    expect(result.consolidated).toBe(0);
    expect(result.entities_processed).toEqual([]);
    expect(result.observations_before).toBe(0);
    expect(result.observations_after).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tag-based consolidation
// ---------------------------------------------------------------------------

describe('consolidate — tag filtering', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key-fake';
  });

  it('consolidates multiple entities sharing a tag', async () => {
    remember({
      name: 'entity-tagged-1',
      type: 'note',
      observations: ['a1', 'a2', 'a3', 'a4', 'a5'],
      tags: ['project:x'],
    });
    remember({
      name: 'entity-tagged-2',
      type: 'note',
      observations: ['b1', 'b2', 'b3', 'b4', 'b5'],
      tags: ['project:x'],
    });
    remember({
      name: 'entity-no-tag',
      type: 'note',
      observations: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          content: [{ text: '["Compressed."]' }],
        }),
      } as any;
    });

    const result = await consolidate({ tag: 'project:x' });

    // Only entities with the tag should be processed
    expect(result.consolidated).toBe(2);
    expect(result.entities_processed).toContain('entity-tagged-1');
    expect(result.entities_processed).toContain('entity-tagged-2');
    expect(result.entities_processed).not.toContain('entity-no-tag');
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Result totals accounting
// ---------------------------------------------------------------------------

describe('consolidate — totals', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key-fake';
  });

  it('sums observations_before and observations_after correctly across multiple entities', async () => {
    remember({ name: 'e1', type: 'note', observations: ['a', 'b', 'c', 'd', 'e'] }); // 5 obs
    remember({ name: 'e2', type: 'note', observations: ['1', '2', '3', '4', '5', '6'] }); // 6 obs

    let callIndex = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callIndex++;
      // First entity compressed to 2, second to 3
      const result = callIndex === 1
        ? '["Summary A.", "Summary B."]'
        : '["Sum 1.", "Sum 2.", "Sum 3."]';
      return {
        ok: true,
        json: async () => ({ content: [{ text: result }] }),
      } as any;
    });

    const result = await consolidate({});
    expect(result.observations_before).toBe(11); // 5 + 6
    expect(result.observations_after).toBe(5);   // 2 + 3
    expect(result.consolidated).toBe(2);
  });
});
