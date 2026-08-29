import { describe, expect, it } from 'vitest';
import { detectCapabilities, getEmbeddingDimension } from '../../src/core/config.js';

const describeProbe = process.env.MEMESH_PROVIDER_ISOLATION_PROBE === '1'
  ? describe
  : describe.skip;

describeProbe('isolated provider environment probe', () => {
  it('starts from the deterministic provider-free defaults', () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OLLAMA_HOST).toBeUndefined();
    expect(process.env.MEMESH_PROVIDER_ISOLATION_PROBE).toBe('1');

    const capabilities = detectCapabilities({});
    expect(capabilities.llm).toBeNull();
    expect(capabilities.llmSource).toBe('none');
    expect(capabilities.embeddings).toBe('tfidf');
    expect(getEmbeddingDimension({})).toBe(384);
  });

  it('still permits an intentional in-test provider fixture', () => {
    process.env.OPENAI_API_KEY = 'explicit-test-fixture';
    try {
      const capabilities = detectCapabilities({});
      expect(capabilities.llm?.provider).toBe('openai');
      expect(capabilities.llmSource).toBe('environment');
      expect(capabilities.embeddings).toBe('tfidf');
      expect(getEmbeddingDimension({})).toBe(384);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
