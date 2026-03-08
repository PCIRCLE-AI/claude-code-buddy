/**
 * ContentHasher Unit Tests
 *
 * Tests content hashing for embedding deduplication.
 * Verifies deterministic hashing behavior for entity content.
 */

import { describe, it, expect } from 'vitest';
import { ContentHasher } from '../ContentHasher.js';

describe('ContentHasher', () => {
  describe('hashEmbeddingSource', () => {
    it('should produce consistent hash for same input', () => {
      const hash1 = ContentHasher.hashEmbeddingSource('Alice', ['works at Acme', 'likes cats']);
      const hash2 = ContentHasher.hashEmbeddingSource('Alice', ['works at Acme', 'likes cats']);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for different entity name', () => {
      const hash1 = ContentHasher.hashEmbeddingSource('Alice', ['works at Acme']);
      const hash2 = ContentHasher.hashEmbeddingSource('Bob', ['works at Acme']);
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hash for different observations', () => {
      const hash1 = ContentHasher.hashEmbeddingSource('Alice', ['works at Acme']);
      const hash2 = ContentHasher.hashEmbeddingSource('Alice', ['works at BigCorp']);
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty observations', () => {
      const hash1 = ContentHasher.hashEmbeddingSource('Alice');
      const hash2 = ContentHasher.hashEmbeddingSource('Alice', []);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should be order-sensitive for observations', () => {
      const hash1 = ContentHasher.hashEmbeddingSource('Alice', ['first', 'second']);
      const hash2 = ContentHasher.hashEmbeddingSource('Alice', ['second', 'first']);
      expect(hash1).not.toBe(hash2);
    });

    it('should return 16-char hex string', () => {
      const hash = ContentHasher.hashEmbeddingSource('Test', ['observation']);
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});
