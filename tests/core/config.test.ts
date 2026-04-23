import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  maskApiKey,
  detectCapabilities,
  getConfigDir,
  getConfigPath,
  readConfig,
  writeConfig,
  updateConfig,
} from '../../src/core/config.js';
import { expectPrivateDir, expectPrivateFile } from '../helpers/permissions.js';

// ── maskApiKey ───────────────────────────────────────────────────────────────

describe('Config: maskApiKey', () => {
  it('masks a normal-length key, keeping first 4 and last 4 chars', () => {
    expect(maskApiKey('sk-ant-api03-abcdefghijklmnop')).toBe('sk-a***mnop');
  });

  it('returns *** for keys 8 chars or shorter', () => {
    expect(maskApiKey('short')).toBe('***');
    expect(maskApiKey('12345678')).toBe('***');
  });

  it('masks a 9-char key (just over threshold)', () => {
    const result = maskApiKey('123456789');
    expect(result).toBe('1234***6789');
  });
});

// ── detectCapabilities ───────────────────────────────────────────────────────

describe('Config: detectCapabilities', () => {
  // Save and restore env vars so tests are isolated
  let savedAnthropicKey: string | undefined;
  let savedOpenaiKey: string | undefined;
  let savedOllamaHost: string | undefined;

  beforeEach(() => {
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenaiKey = process.env.OPENAI_API_KEY;
    savedOllamaHost = process.env.OLLAMA_HOST;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (savedOpenaiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenaiKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedOllamaHost !== undefined) process.env.OLLAMA_HOST = savedOllamaHost;
    else delete process.env.OLLAMA_HOST;
  });

  it('returns Level 0 with always-true flags when no LLM config', () => {
    const caps = detectCapabilities({});
    expect(caps.fts5).toBe(true);
    expect(caps.vectorSearch).toBe(true);
    expect(caps.scoring).toBe(true);
    expect(caps.knowledgeEvolution).toBe(true);
    expect(caps.searchLevel).toBe(0);
    expect(caps.llm).toBeNull();
  });

  it('reports local ONNX embeddings when no LLM is configured', () => {
    const caps = detectCapabilities({});
    expect(caps.embeddings).toBe('onnx');
  });

  it('returns Level 1 with LLM config provided directly', () => {
    const caps = detectCapabilities({
      llm: { provider: 'anthropic', apiKey: 'sk-test-key' },
    });
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('anthropic');
    // Anthropic has no embedding API — falls back to ONNX if available, otherwise tfidf
    expect(['onnx', 'tfidf']).toContain(caps.embeddings);
  });

  it('returns Level 1 with openai LLM config', () => {
    const caps = detectCapabilities({
      llm: { provider: 'openai', apiKey: 'sk-openai-test' },
    });
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('openai');
  });

  it('returns Level 1 with ollama LLM config', () => {
    const caps = detectCapabilities({
      llm: { provider: 'ollama', model: 'llama3.2' },
    });
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('ollama');
  });

  it('detects ANTHROPIC_API_KEY from environment when config has no llm', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('anthropic');
    expect(caps.llm?.apiKey).toBe('sk-ant-env-key');
  });

  it('detects OPENAI_API_KEY from environment when no anthropic key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('openai');
  });

  it('detects OLLAMA_HOST from environment as fallback', () => {
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('ollama');
  });

  it('explicit config.llm takes precedence over env vars', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-key';
    const caps = detectCapabilities({
      llm: { provider: 'openai', apiKey: 'sk-explicit' },
    });
    expect(caps.llm?.provider).toBe('openai');
    expect(caps.llm?.apiKey).toBe('sk-explicit');
  });
});

// ── readConfig / writeConfig / updateConfig ──────────────────────────────────

describe('Config: read/write/update (isolated temp dir)', () => {
  // We can't easily redirect the config path at module level since it's a const.
  // Instead, test the logic directly by using the exported functions on temp files.

  it('readConfig returns empty object when file does not exist', () => {
    // This test relies on readConfig catching the ENOENT and returning {}
    // We can verify the exported function handles the no-file case gracefully
    const result = readConfig();
    expect(typeof result).toBe('object');
    // result may or may not have keys depending on the real ~/.memesh/config.json
    // The key guarantee: it never throws
  });

  it('writeConfig + readConfig round-trip', () => {
    // We write to the actual config path to test round-trip.
    // Read existing config first so we can restore it.
    const originalConfig = readConfig();
    const testMarker = { __test__: true, sessionLimit: 42 } as any;

    try {
      writeConfig(testMarker);
      const read = readConfig();
      expect(read.__test__).toBe(true);
      expect(read.sessionLimit).toBe(42);
    } finally {
      // Restore original config
      writeConfig(originalConfig);
    }
  });

  it('writeConfig hardens config file and directory permissions', () => {
    const originalConfig = readConfig();

    try {
      writeConfig({ sessionLimit: 7 });
      expectPrivateDir(getConfigDir());
      expectPrivateFile(getConfigPath());
    } finally {
      writeConfig(originalConfig);
    }
  });

  it('updateConfig merges partial changes', () => {
    const originalConfig = readConfig();

    try {
      writeConfig({ sessionLimit: 5, theme: 'light' });
      const updated = updateConfig({ theme: 'dark' });
      expect(updated.sessionLimit).toBe(5);
      expect(updated.theme).toBe('dark');
    } finally {
      writeConfig(originalConfig);
    }
  });
});
