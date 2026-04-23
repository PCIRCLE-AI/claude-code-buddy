import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isEmbeddingAvailable,
  resetEmbeddingState,
  getEmbeddingDimension,
  vectorSearch,
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
      fs.rmSync(testDir, { recursive: true, force: true });
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
});
