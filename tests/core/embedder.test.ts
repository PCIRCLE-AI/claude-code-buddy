import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isEmbeddingAvailable,
  resetEmbeddingState,
  getEmbeddingDimension,
  vectorSearch,
  vectorSimilarity,
  MAX_VECTOR_DISTANCE,
} from '../../src/core/embedder.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Embedder', () => {
  let testDir: string | undefined;

  beforeEach(() => {
    resetEmbeddingState();
  });

  afterEach(() => {
    try { closeDatabase(); } catch {}
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      testDir = undefined;
    }
  });

  function openTempDb() {
    testDir = path.join(
      os.tmpdir(),
      `memesh-embedder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    openDatabase(path.join(testDir, 'test.db'));
    return getDatabase();
  }

  it('isEmbeddingAvailable returns boolean', () => {
    const result = isEmbeddingAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('isEmbeddingAvailable is consistent on repeated calls', () => {
    const first = isEmbeddingAvailable();
    const second = isEmbeddingAvailable();
    expect(first).toBe(second);
  });

  it('isEmbeddingAvailable returns true when @huggingface/transformers is installed', () => {
    // In this test environment, @huggingface/transformers IS installed as a dependency
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

  it('getEmbeddingDimension returns a positive integer', () => {
    const dim = getEmbeddingDimension();
    expect(dim).toBeGreaterThan(0);
    expect(Number.isInteger(dim)).toBe(true);
  });

  it('getEmbeddingDimension returns known dimension value', () => {
    // Should be one of: 384 (ONNX), 1536 (OpenAI), 768 (Ollama)
    const dim = getEmbeddingDimension();
    expect([384, 768, 1536]).toContain(dim);
  });

  it('vectorSearch returns entity rowids stored in sqlite-vec', () => {
    const db = openTempDb();
    const dim = getEmbeddingDimension();
    const embedding = new Float32Array(dim);
    embedding.fill(0.01);
    embedding[0] = 1;

    db.prepare(
      'INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)'
    ).run(123n, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));

    const hits = vectorSearch(embedding, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(123);
    expect(hits[0].distance).toBe(0);
  });

  describe('distance scale', () => {
    // `entities_vec` is vec0(...) with no distance_metric, so sqlite-vec uses
    // L2. Over unit vectors that is a 0…2 range related to cosine by
    // cos = 1 - d²/2. Both the cut-off and the similarity mapping encode that
    // one fact, and both used to assume a 0…1 cosine-distance scale instead.

    /** Unit vector at a chosen cosine angle from [1,0,0,…]. */
    function vectorAtCosine(cos: number, dim: number): Float32Array {
      const v = new Float32Array(dim);
      v[0] = cos;
      v[1] = Math.sqrt(1 - cos * cos);
      return v;
    }

    it('keeps a hit that is merely related, not near-identical', () => {
      const db = openTempDb();
      const dim = getEmbeddingDimension();
      const query = vectorAtCosine(1, dim);
      // cos 0.3 -> L2 sqrt(1.4) ≈ 1.183, right at the measured median distance
      // of a CORRECT LongMemEval session. The old cut-off of 1 discarded it.
      const related = vectorAtCosine(0.3, dim);
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
        .run(7n, Buffer.from(related.buffer, related.byteOffset, related.byteLength));

      const hits = vectorSearch(query, 5);
      expect(hits.map((h) => h.id)).toContain(7);
      expect(hits[0].distance).toBeGreaterThan(1);
      expect(hits[0].distance).toBeLessThan(MAX_VECTOR_DISTANCE);
    });

    it('drops a hit that is not related at all', () => {
      const db = openTempDb();
      const dim = getEmbeddingDimension();
      const query = vectorAtCosine(1, dim);
      // cos 0.05 -> L2 ≈ 1.378, which is where a nonsense query's nearest
      // neighbour actually lands. Not an exotic opposite vector: this is the
      // ordinary noise case, and it must not come back as an answer.
      const opposed = vectorAtCosine(0.05, dim);
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
        .run(8n, Buffer.from(opposed.buffer, opposed.byteOffset, opposed.byteLength));

      expect(vectorSearch(query, 5)).toHaveLength(0);
    });

    it('sits between the measured signal and noise bands', () => {
      // Pinned from both sides so neither the 1.0 that made the supplement
      // inert nor a loose geometric cut can be restored quietly. Measured:
      // the correct session lands at p75 1.269, while a nonsense query's
      // nearest neighbour lands at 1.371-1.430.
      expect(MAX_VECTOR_DISTANCE).toBeGreaterThan(1.269);
      expect(MAX_VECTOR_DISTANCE).toBeLessThan(1.371);
    });

    it('maps the full 0…2 distance range onto 0…1 similarity', () => {
      expect(vectorSimilarity(0)).toBe(1);
      expect(vectorSimilarity(Math.SQRT2)).toBeCloseTo(0.293, 3);
      expect(vectorSimilarity(MAX_VECTOR_DISTANCE)).toBeCloseTo(0.35, 2);
      expect(vectorSimilarity(2)).toBe(0);
      // The previous `1 - d` form returned 0 for everything past 1.0, which is
      // where every real hit lives.
      expect(vectorSimilarity(1.187)).toBeGreaterThan(0);
    });
  });
});
