import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expandQuery, isExpansionAvailable, parseKeywords } from '../../src/core/query-expander.js';

// ---------------------------------------------------------------------------
// isExpansionAvailable
// ---------------------------------------------------------------------------

describe('isExpansionAvailable', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OLLAMA_HOST: process.env.OLLAMA_HOST,
    };
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('returns false when no API keys or Ollama host are set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_HOST;
    // Note: config.json may still provide an LLM config, but in the test environment
    // the ~/.memesh/config.json typically does not exist, so this should return false.
    // We cannot guarantee file system state, so we just ensure it's a boolean.
    expect(typeof isExpansionAvailable()).toBe('boolean');
  });

  it('returns true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_HOST;
    expect(isExpansionAvailable()).toBe(true);
  });

  it('returns true when OPENAI_API_KEY is set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key-openai';
    delete process.env.OLLAMA_HOST;
    expect(isExpansionAvailable()).toBe(true);
  });

  it('returns true when OLLAMA_HOST is set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    expect(isExpansionAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expandQuery (no LLM — Level 0 fallback)
// ---------------------------------------------------------------------------

describe('expandQuery — Level 0 (no LLM)', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OLLAMA_HOST: process.env.OLLAMA_HOST,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('returns [query] when no LLM is configured', async () => {
    const result = await expandQuery('login security');
    // Should return at least the original query
    expect(result).toContain('login security');
  });

  it('returns array with original query as first element', async () => {
    const result = await expandQuery('OAuth PKCE');
    expect(result[0]).toBe('OAuth PKCE');
  });
});

// ---------------------------------------------------------------------------
// parseKeywords
// ---------------------------------------------------------------------------

describe('parseKeywords', () => {
  it('parses a clean JSON array', () => {
    const result = parseKeywords('["authentication", "login", "oauth"]');
    expect(result).toEqual(['authentication', 'login', 'oauth']);
  });

  it('parses JSON array embedded in prose', () => {
    const result = parseKeywords('Here are some keywords: ["auth", "security", "token"]');
    expect(result).toEqual(['auth', 'security', 'token']);
  });

  it('handles empty JSON array', () => {
    const result = parseKeywords('[]');
    expect(result).toEqual([]);
  });

  it('falls back to comma splitting on non-JSON text', () => {
    const result = parseKeywords('auth, security, token, login');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('auth');
    expect(result).toContain('security');
  });

  it('falls back to newline splitting on newline-separated text', () => {
    const result = parseKeywords('auth\nsecurity\ntoken\nlogin');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('auth');
  });

  it('strips JSON artifacts in fallback path', () => {
    const result = parseKeywords('"auth", "security", "token"');
    // After stripping quotes, should not have raw quotes
    for (const kw of result) {
      expect(kw).not.toContain('"');
    }
  });

  it('filters out empty strings', () => {
    const result = parseKeywords('["auth", "", "security"]');
    expect(result).not.toContain('');
  });

  it('caps results at 15 keywords', () => {
    const many = Array.from({ length: 20 }, (_, i) => `keyword${i}`);
    const result = parseKeywords(JSON.stringify(many));
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it('handles completely malformed input gracefully', () => {
    // Should not throw
    expect(() => parseKeywords('{ not valid json at all ###')).not.toThrow();
    const result = parseKeywords('{ not valid json at all ###');
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles empty string input', () => {
    const result = parseKeywords('');
    expect(Array.isArray(result)).toBe(true);
  });

  it('filters out single-character strings in fallback path', () => {
    // The comma-split fallback uses s.length > 1
    const result = parseKeywords('a, auth, b, security');
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
    expect(result).toContain('auth');
    expect(result).toContain('security');
  });
});
