/**
 * The local embedding model must not be re-downloaded per isolated HOME.
 *
 * `all-MiniLM-L6-v2` is ~98 MB and is fetched from HuggingFace on first use.
 * It caches at `~/.memesh/models`, which is correct for a real install and
 * wrong for anything that isolates HOME — and six test files spawn the CLI or
 * a hook under a per-test HOME. Measured before the override existed:
 *
 *   first write in a fresh HOME   19.4s wall, 1.21s user, 8% CPU  (network wait)
 *   tests/hooks/hook-output-contract  86.4s     ->  3.1s
 *   tests/cli/remember-quick          52.5s     ->  2.2s
 *   tests/transports/http             18.2s     ->  1.0s
 *   whole suite                      253.6s     -> 56.4s
 *
 * On CI the same cost was paid on every leg of the matrix, and it made every
 * leg depend on HuggingFace being reachable — a third-party outage would have
 * turned the whole matrix red with nothing wrong in the code.
 *
 * Two things have to stay true, and the second is the one that would rot
 * silently: the override must work, AND the two places that set it must keep
 * setting it. Deleting either wiring costs no test failure and no error — the
 * suite just quietly goes back to taking four times as long.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { onnxCacheDir } from '../../src/core/embedder.js';
import { memeshDir } from '../../src/core/paths.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const saved = process.env.MEMESH_MODEL_CACHE_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.MEMESH_MODEL_CACHE_DIR;
  else process.env.MEMESH_MODEL_CACHE_DIR = saved;
});

describe('the ONNX model cache can be shared across isolated HOMEs', () => {
  it('defaults to the per-user directory beside the database', () => {
    delete process.env.MEMESH_MODEL_CACHE_DIR;
    expect(onnxCacheDir()).toBe(path.join(memeshDir(), 'models'));
  });

  it('honours MEMESH_MODEL_CACHE_DIR', () => {
    process.env.MEMESH_MODEL_CACHE_DIR = path.join(repoRoot, 'not-a-real-cache');
    expect(onnxCacheDir()).toBe(path.join(repoRoot, 'not-a-real-cache'));
  });

  it('treats an empty or whitespace override as unset, not as a path', () => {
    // `env.cacheDir = ''` would send transformers.js to the process cwd, which
    // on CI is the checkout — a 98 MB download into the repository.
    for (const blank of ['', '   ']) {
      process.env.MEMESH_MODEL_CACHE_DIR = blank;
      expect(onnxCacheDir(), `"${blank}" was used as a cache path`).toBe(path.join(memeshDir(), 'models'));
    }
  });

  it('is still set by the isolated test runner', () => {
    const runner = fs.readFileSync(path.join(repoRoot, 'scripts/run-tests-isolated.mjs'), 'utf8');
    expect(
      runner,
      'the runner stopped sharing the model cache — the suite will silently go back to ~4x slower'
    ).toContain('MEMESH_MODEL_CACHE_DIR');
  });

  it('is still set by CI', () => {
    const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(
      ci,
      'CI stopped sharing the model cache — every matrix leg goes back to re-downloading ~98 MB per isolated HOME, and back to depending on HuggingFace'
    ).toMatch(/^\s*MEMESH_MODEL_CACHE_DIR:/m);
  });
});
