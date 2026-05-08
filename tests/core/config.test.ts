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
  let savedAutoDetect: string | undefined;

  beforeEach(() => {
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenaiKey = process.env.OPENAI_API_KEY;
    savedOllamaHost = process.env.OLLAMA_HOST;
    savedAutoDetect = process.env.MEMESH_AUTO_DETECT_LLM;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_HOST;
    // Env-var auto-detection is opt-in by default to keep fresh installs
    // local-only. Tests that exercise the env-detection path set this flag
    // explicitly; other tests get the default (local-only) behavior.
    delete process.env.MEMESH_AUTO_DETECT_LLM;
  });

  afterEach(() => {
    if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (savedOpenaiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenaiKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedOllamaHost !== undefined) process.env.OLLAMA_HOST = savedOllamaHost;
    else delete process.env.OLLAMA_HOST;
    if (savedAutoDetect !== undefined) process.env.MEMESH_AUTO_DETECT_LLM = savedAutoDetect;
    else delete process.env.MEMESH_AUTO_DETECT_LLM;
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

  it('does NOT auto-detect ANTHROPIC_API_KEY without explicit MEMESH_AUTO_DETECT_LLM=1', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(0);
    expect(caps.llm).toBeNull();
  });

  it('detects ANTHROPIC_API_KEY from environment when MEMESH_AUTO_DETECT_LLM=1', () => {
    process.env.MEMESH_AUTO_DETECT_LLM = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('anthropic');
    expect(caps.llm?.apiKey).toBe('sk-ant-env-key');
  });

  it('detects OPENAI_API_KEY from environment when MEMESH_AUTO_DETECT_LLM=1 and no anthropic key', () => {
    process.env.MEMESH_AUTO_DETECT_LLM = '1';
    process.env.OPENAI_API_KEY = 'sk-openai-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('openai');
  });

  it('detects OLLAMA_HOST from environment when MEMESH_AUTO_DETECT_LLM=1', () => {
    process.env.MEMESH_AUTO_DETECT_LLM = '1';
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

// ── #36: embedder/llm decoupling ──────────────────────────────────────────────

describe('Config: embedder.provider decoupled from llm.provider (#36)', () => {
  it('explicit embedder.provider=onnx wins even when llm.provider=ollama', () => {
    // Pre-#36 this combination would have routed embeddings to
    // ollama (768-dim), invalidating any 384-dim ONNX vectors.
    // The fix: embedder.provider takes precedence.
    const caps = detectCapabilities({
      llm: { provider: 'ollama', model: 'gemma4:e4b' },
      embedder: { provider: 'onnx' },
    });
    expect(caps.embeddings).toBe('onnx');
  });

  it('explicit embedder.provider=openai works with llm.provider=anthropic', () => {
    const caps = detectCapabilities({
      llm: { provider: 'anthropic', apiKey: 'sk-ant-test' },
      embedder: { provider: 'openai' },
    });
    expect(caps.embeddings).toBe('openai');
  });

  it('back-compat: pre-#36 config with llm.provider=ollama and NO embedder field still uses ollama embeddings', () => {
    // Existing installs that haven't been migrated to set
    // embedder.provider keep their old behavior — entities_vec
    // dimension matches what they already have on disk.
    const caps = detectCapabilities({
      llm: { provider: 'ollama', model: 'gemma4:e4b' },
    });
    expect(caps.embeddings).toBe('ollama');
  });

  it('embedder.provider=onnx + no llm = ONNX embeddings, Level 0', () => {
    const caps = detectCapabilities({
      embedder: { provider: 'onnx' },
    });
    expect(caps.embeddings).toBe('onnx');
    expect(caps.searchLevel).toBe(0);
    expect(caps.llm).toBeNull();
  });
});

// ── #36: getEmbeddingDimension respects embedder.provider ─────────────────────

describe('Config: getEmbeddingDimension follows embedder.provider (#36)', () => {
  // Re-import to pick up the fresh impl after the test above writes
  // config — these tests are pure (just call with an explicit config).

  it('returns 384 for embedder.provider=onnx regardless of llm.provider', async () => {
    const { getEmbeddingDimension } = await import('../../src/core/config.js');
    expect(getEmbeddingDimension({
      llm: { provider: 'ollama', model: 'gemma4:e4b' },
      embedder: { provider: 'onnx' },
    })).toBe(384);
  });

  it('returns 768 for embedder.provider=ollama', async () => {
    const { getEmbeddingDimension } = await import('../../src/core/config.js');
    expect(getEmbeddingDimension({
      embedder: { provider: 'ollama' },
    })).toBe(768);
  });

  it('returns 1536 for embedder.provider=openai', async () => {
    const { getEmbeddingDimension } = await import('../../src/core/config.js');
    expect(getEmbeddingDimension({
      embedder: { provider: 'openai' },
    })).toBe(1536);
  });

  it('back-compat: returns 768 for legacy llm.provider=ollama with no embedder set', async () => {
    const { getEmbeddingDimension } = await import('../../src/core/config.js');
    expect(getEmbeddingDimension({
      llm: { provider: 'ollama', model: 'gemma4:e4b' },
    })).toBe(768);
  });
});
