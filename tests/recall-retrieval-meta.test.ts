/**
 * R2 — honest retrieval metadata.
 *
 * The silent shape this pins away: embeddings configured, sqlite-vec missing
 * or the provider down → recall silently served keyword-only results, and a
 * `limit`-full window was indistinguishable from a complete answer. Every
 * recall now reports HOW it was answered: `mode` (fts | hybrid), `degraded`
 * (configured vector side could not run), `truncated` (window filled).
 *
 * Same embedder mock seam as recall-empty-query-vectors.test.ts — these
 * tests steer the vector half through all three outcomes deliberately, so
 * they cannot pass vacuously in an environment without embeddings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const embedText = vi.fn(async (_text: string): Promise<Float32Array | null> => new Float32Array(384));
const isEmbeddingAvailable = vi.fn(() => true);
const vectorSearch = vi.fn(
  (_vec: Float32Array, _k: number) => [] as Array<{ id: number; distance: number }>,
);

vi.mock('../src/core/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/embedder.js')>();
  return {
    ...actual,
    isEmbeddingAvailable: () => isEmbeddingAvailable(),
    embedText: (t: string) => embedText(t),
    vectorSearch: (v: Float32Array, k: number) => vectorSearch(v, k),
  };
});

let dir: string;
let closeDatabase: typeof import('../src/db.js').closeDatabase;
let recallEnhanced: typeof import('../src/core/operations.js').recallEnhanced;
let remember: typeof import('../src/core/operations.js').remember;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-retrieval-meta-'));
  const db = await import('../src/db.js');
  closeDatabase = db.closeDatabase;
  db.openDatabase(path.join(dir, 'test.db'));
  ({ recallEnhanced, remember } = await import('../src/core/operations.js'));
  remember({ name: 'auth-decision', type: 'decision', observations: ['Use OAuth PKCE for the auth flow'] });
  remember({ name: 'auth-lesson', type: 'lesson_learned', observations: ['Validate the OAuth state parameter'] });
  remember({ name: 'db-note', type: 'note', observations: ['SQLite WAL mode for concurrent auth reads'] });
  embedText.mockClear();
  isEmbeddingAvailable.mockClear();
  vectorSearch.mockClear();
  embedText.mockImplementation(async () => new Float32Array(384));
  isEmbeddingAvailable.mockImplementation(() => true);
  vectorSearch.mockImplementation(() => []);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Feature: recall reports how it was answered', () => {
  it('vector side ran -> hybrid, not degraded (even with zero vector hits)', async () => {
    const { retrieval } = await recallEnhanced({ query: 'auth' });
    expect(embedText).toHaveBeenCalled();
    expect(retrieval).toEqual({ mode: 'hybrid', degraded: false, truncated: false });
  });

  it('embeddings unconfigured -> fts and NOT degraded (keyword-only is the configured behaviour)', async () => {
    isEmbeddingAvailable.mockImplementation(() => false);
    const { retrieval } = await recallEnhanced({ query: 'auth' });
    expect(retrieval.mode).toBe('fts');
    expect(retrieval.degraded).toBe(false);
  });

  it('vector search THROWS (the missing-sqlite-vec shape) -> fts + degraded, results still served', async () => {
    vectorSearch.mockImplementation(() => { throw new Error('no such module: vec0'); });
    const { entities, retrieval } = await recallEnhanced({ query: 'auth' });
    expect(entities.length).toBeGreaterThan(0); // FTS half still answers
    expect(retrieval.mode).toBe('fts');
    expect(retrieval.degraded).toBe(true);
  });

  it('embed provider returns null -> degraded too (configured but could not run)', async () => {
    embedText.mockImplementation(async () => null);
    const { retrieval } = await recallEnhanced({ query: 'auth' });
    expect(retrieval).toMatchObject({ mode: 'fts', degraded: true });
  });

  it('a limit-full window says truncated; a roomy window does not', async () => {
    const tight = await recallEnhanced({ query: 'auth', limit: 2 });
    expect(tight.entities).toHaveLength(2);
    expect(tight.retrieval.truncated).toBe(true);

    const roomy = await recallEnhanced({ query: 'auth', limit: 10 });
    expect(roomy.entities.length).toBeLessThan(10);
    expect(roomy.retrieval.truncated).toBe(false);
  });

  it('the empty-query listing reports honestly too: fts mode, truncation still meaningful', async () => {
    const listed = await recallEnhanced({ limit: 2 });
    expect(listed.retrieval.mode).toBe('fts');
    expect(listed.retrieval.degraded).toBe(false);
    expect(listed.retrieval.truncated).toBe(true); // 3 entities, window of 2
    expect(embedText).not.toHaveBeenCalled();
  });
});
