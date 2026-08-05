import { describe, it, expect, afterEach } from 'vitest';
import {
  isEmbeddingAvailable,
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

  it('isEmbeddingAvailable is false with no embedder configured (keyword-only)', () => {
    // The suite runs under an isolated HOME with no config, so no neural
    // embedder is selected. That MUST resolve to keyword-only (FTS5), not a
    // crash — the graceful-degradation contract after the ONNX removal.
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it('getEmbeddingDimension returns a positive integer', () => {
    const dim = getEmbeddingDimension();
    expect(dim).toBeGreaterThan(0);
    expect(Number.isInteger(dim)).toBe(true);
  });

  it('getEmbeddingDimension returns known dimension value', () => {
    // 384 = keyword-only default (also matches legacy tables), 768 = Ollama,
    // 1536 = OpenAI.
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
      // cos 0.6 -> L2 sqrt(0.8) ≈ 0.894, inside the nomic signal band (real
      // matches measured at 0.858…0.988). Below the 1.00 cut, so it survives.
      const related = vectorAtCosine(0.6, dim);
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
        .run(7n, Buffer.from(related.buffer, related.byteOffset, related.byteLength));

      const hits = vectorSearch(query, 5);
      expect(hits.map((h) => h.id)).toContain(7);
      expect(hits[0].distance).toBeGreaterThan(0.8);
      expect(hits[0].distance).toBeLessThan(MAX_VECTOR_DISTANCE);
    });

    it('drops a hit that is not related at all', () => {
      const db = openTempDb();
      const dim = getEmbeddingDimension();
      const query = vectorAtCosine(1, dim);
      // cos 0.4 -> L2 sqrt(1.2) ≈ 1.095, squarely in the nomic noise band
      // (unrelated queries' nearest neighbours measured at 1.02…1.10). Above
      // the 1.00 cut, so it must not come back as an answer.
      const opposed = vectorAtCosine(0.4, dim);
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
        .run(8n, Buffer.from(opposed.buffer, opposed.byteOffset, opposed.byteLength));

      expect(vectorSearch(query, 5)).toHaveLength(0);
    });

    it('sits between the measured signal and noise bands', () => {
      // Pinned from both sides so neither a regression to the inert cut nor the
      // old loose 1.30 (which on nomic admitted 100% of noise) can be restored
      // quietly. Measured on nomic-embed-text over a real 575-entity graph:
      // signal body ≤ ~0.99, noise body ≥ ~1.02, classes touching near 1.00.
      expect(MAX_VECTOR_DISTANCE).toBeGreaterThan(0.95);
      expect(MAX_VECTOR_DISTANCE).toBeLessThan(1.05);
    });

    it('maps the full 0…2 distance range onto 0…1 similarity', () => {
      expect(vectorSimilarity(0)).toBe(1);
      expect(vectorSimilarity(Math.SQRT2)).toBeCloseTo(0.293, 3);
      // At the 1.00 cut, similarity is exactly 0.5 (1 - 1/2).
      expect(vectorSimilarity(MAX_VECTOR_DISTANCE)).toBeCloseTo(0.5, 2);
      expect(vectorSimilarity(2)).toBe(0);
      // The mapping stays positive across the whole 0…2 range — the previous
      // `1 - d` form returned 0 for everything past 1.0, where real hits live.
      expect(vectorSimilarity(1.187)).toBeGreaterThan(0);
    });
  });
});
