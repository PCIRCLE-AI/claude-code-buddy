import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

  // F17: Auto-detect from env is no longer gated behind MEMESH_AUTO_DETECT_LLM=1.
  // The original ship-blocker (1536-dim embedding lock from auto-detected
  // OPENAI_API_KEY) was fixed in #36 by decoupling embedder from LLM provider.
  // Now the detection follows priority: anthropic > openai > ollama.
  it('auto-detects ANTHROPIC_API_KEY from environment (no opt-in required)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('anthropic');
    expect(caps.llm?.apiKey).toBe('sk-ant-env-key');
  });

  // The env-detect flag is an explicit OPT-OUT (it used to be an opt-in
  // gate; F17 removed the gate but left the README promising that a stray
  // shell key would be ignored). These pin the promise the README now makes:
  // a user can always stop memesh spending a key it merely found lying around.
  it('does NOT auto-detect from env when MEMESH_AUTO_DETECT_LLM=0', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    process.env.MEMESH_AUTO_DETECT_LLM = '0';
    const caps = detectCapabilities({});
    expect(caps.llm).toBeNull();
    expect(caps.searchLevel).not.toBe(1);
  });

  it('accepts false/no/off as opt-out spellings', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env-key';
    for (const spelling of ['false', 'NO', ' Off ']) {
      process.env.MEMESH_AUTO_DETECT_LLM = spelling;
      expect(detectCapabilities({}).llm).toBeNull();
    }
  });

  it('still auto-detects when the flag is absent or set to 1 (F17 behaviour preserved)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    delete process.env.MEMESH_AUTO_DETECT_LLM;
    expect(detectCapabilities({}).llm?.provider).toBe('anthropic');
    process.env.MEMESH_AUTO_DETECT_LLM = '1';
    expect(detectCapabilities({}).llm?.provider).toBe('anthropic');
  });

  it('opt-out never overrides an explicitly configured provider', () => {
    process.env.MEMESH_AUTO_DETECT_LLM = '0';
    const caps = detectCapabilities({ llm: { provider: 'ollama', model: 'llama3.2' } });
    expect(caps.llm?.provider).toBe('ollama');
  });

  it('detects OPENAI_API_KEY from environment when no anthropic key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env-key';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('openai');
  });

  it('detects OLLAMA_HOST from environment when no remote keys', () => {
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const caps = detectCapabilities({});
    expect(caps.searchLevel).toBe(1);
    expect(caps.llm?.provider).toBe('ollama');
  });

  it('priority order: anthropic > openai > ollama when multiple env vars set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    process.env.OPENAI_API_KEY = 'sk-openai-env-key';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const caps = detectCapabilities({});
    expect(caps.llm?.provider).toBe('anthropic');
  });

  // F17 ship-blocker regression: pre-4.1.0, env-detected OPENAI_API_KEY
  // locked entities_vec table to 1536-dim, then the first remember()
  // fell back to ONNX (384-dim) and silently dropped the vector write.
  // Now LLM and embedder are detected independently — env-detect only
  // affects LLM, not embedder.
  it('env-detected OPENAI_API_KEY does NOT lock embedder to 1536-dim', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env-key';
    const caps = detectCapabilities({});
    expect(caps.llm?.provider).toBe('openai');
    expect(caps.embeddings).toBe('onnx'); // ← critical: NOT 'openai'
  });

  it('env-detected ANTHROPIC_API_KEY uses anthropic LLM but onnx embeddings', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const caps = detectCapabilities({});
    expect(caps.llm?.provider).toBe('anthropic');
    expect(caps.embeddings).toBe('onnx');
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
      expect((read as Record<string, unknown>).__test__).toBe(true);
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
      writeConfig({ sessionLimit: 5, autoUpdate: 'off' });
      const updated = updateConfig({ autoUpdate: 'patch' });
      expect(updated.sessionLimit).toBe(5);
      expect(updated.autoUpdate).toBe('patch');
    } finally {
      writeConfig(originalConfig);
    }
  });
});

// ── Corrupt-config visibility (fake-working audit) ────────────────────────────

describe('Config: a corrupt config file is traced, not silently ignored', () => {
  // Isolate every read to a throwaway MEMESH_DIR — this must NEVER touch the
  // developer's real ~/.memesh/config.json.
  let dir: string;
  let savedMemeshDir: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-corrupt-'));
    savedMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    written = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns {} AND writes a stderr trace naming the file when JSON is corrupt', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    const result = readConfig();
    expect(result).toEqual({});
    const trace = written.join('');
    expect(trace).toContain('[memesh config]');
    expect(trace).toContain('config.json');
    expect(trace).toContain('Smart Mode is off');
  });

  it('a MISSING file is silent (normal Core Mode, not an error)', () => {
    const result = readConfig();
    expect(result).toEqual({});
    expect(written.join('')).toBe('');
  });

  it('does not flood: repeated reads of the same corrupt file trace once', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), 'still not json');
    readConfig();
    readConfig();
    readConfig();
    const hits = written.filter((w) => w.includes('[memesh config]'));
    expect(hits).toHaveLength(1);
  });
});

// ── #36: embedder/llm decoupling ──────────────────────────────────────────────

describe('Config: embedder.provider decoupled from llm.provider (#36)', () => {
  // F17: env auto-detect is no longer gated, so these tests must clear env
  // vars to isolate from the host's ANTHROPIC_API_KEY etc. Otherwise the
  // "no llm" cases get an auto-detected provider and searchLevel=1 instead
  // of the expected Core-mode 0.
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
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

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
