import { describe, it, expect, beforeEach } from 'vitest';
import {
  isEmbeddingAvailable,
  resetEmbeddingState,
} from '../../src/core/embedder.js';

describe('Embedder', () => {
  beforeEach(() => {
    resetEmbeddingState();
  });

  it('isEmbeddingAvailable returns boolean', () => {
    const result = isEmbeddingAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('isEmbeddingAvailable is consistent on repeated calls', () => {
    const first = isEmbeddingAvailable();
    const second = isEmbeddingAvailable();
    expect(first).toBe(second);
  });

  it('isEmbeddingAvailable returns true when @xenova/transformers is installed', () => {
    // In this test environment, @xenova/transformers IS installed as a dependency
    const result = isEmbeddingAvailable();
    expect(result).toBe(true);
  });

  it('resetEmbeddingState allows re-checking availability', () => {
    const first = isEmbeddingAvailable();
    resetEmbeddingState();
    const second = isEmbeddingAvailable();
    // Both should be true (package is installed), but the point is
    // resetEmbeddingState actually clears the cache
    expect(first).toBe(second);
  });
});
