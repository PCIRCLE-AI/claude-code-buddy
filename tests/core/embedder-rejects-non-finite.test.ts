/**
 * A provider can hand back a vector with `NaN` in it, and nothing downstream
 * treats that as an error.
 *
 * `new Float32Array([...])` coerces silently, and not the way you would guess.
 * Measured, for the value at one position:
 *
 *   undefined → NaN        "NaN"  → NaN        {} → NaN        "abc" → NaN
 *   null      → 0          ""     → 0          [1] → 1         1e999 → Infinity
 *
 * The first draft of this file used `null` for the corrupt component, on the
 * assumption that a missing value becomes NaN. It becomes 0 — a legitimate
 * number — so that test could never have gone red, whatever the guard did.
 *
 * sqlite-vec then stores a non-finite value and reads it back unchanged —
 * measured: `[0.1, NaN, 0.3]` survives a round trip.
 * And `NaN` breaks every comparison meant to bound it: `NaN >= limit` is false,
 * so a distance test written as an early exit runs off the end and calls the
 * pair a match. One corrupt vector then matches EVERYTHING it is compared
 * against, in clustering and in search alike.
 *
 * So the refusal belongs in `embedText`, before the value can be stored or used
 * as a query — and it has to be loud, because a provider emitting NaN is broken
 * and staying quiet about it is how the corrupt vector got in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('embedText refuses a vector with a non-finite component', () => {
  let dir: string;
  let savedMemeshDir: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string[];
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nonfinite-'));
    savedMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    // Ollama, so `embedText` actually calls a provider instead of returning
    // null for keyword-only — which would pass this test for the wrong reason.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ embedder: { provider: 'ollama' } }));
    written = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    stderrSpy.mockRestore();
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.resetModules();
  });

  /**
   * An ollama `/api/embed` response carrying exactly these components.
   *
   * The shape is `{ embeddings: [[...]] }` — a LIST of vectors, one per input.
   * Written as `{ embedding: [...] }` first, from memory rather than from
   * `embedWithOllama`, and every test here went green-looking-red: the reader
   * found nothing at `embeddings[0]`, returned null before the guard ran, and
   * all three assertions failed for a reason that had nothing to do with the
   * guard. A fixture built from an assumed shape tests the fixture.
   */
  function stubProvider(embedding: unknown[]): void {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [embedding] }),
      text: async () => '',
    })) as unknown as typeof fetch;
  }

  it('returns null instead of a NaN vector, and says why', async () => {
    const { embedText } = await import('../../src/core/embedder.js');
    // A stringified `NaN`: what a Python-backed embedding server emits when it
    // serialises with `allow_nan=True` and something downstream turns the bare
    // token into a string to keep the JSON parseable.
    stubProvider([0.1, 'NaN', 0.3]);

    expect(await embedText('some text'), 'a NaN vector was handed to callers').toBeNull();
    expect(
      written.join(''),
      'the vector was refused silently — the operator never learns the embedder is broken'
    ).toMatch(/non-finite/);
  });

  it('returns null instead of an Infinity vector', async () => {
    const { embedText } = await import('../../src/core/embedder.js');
    // Infinity fails differently downstream (it exits the distance loop early
    // rather than running off the end), so it is not caught by the same guard
    // there and has to be refused here.
    stubProvider([0.1, 1e999, 0.3]);
    expect(await embedText('some text')).toBeNull();
    expect(written.join('')).toMatch(/non-finite/);
  });

  it('still returns a good vector unchanged', async () => {
    // Without this the fix reads as "always return null", which would pass both
    // assertions above while removing embeddings from the product entirely.
    const { embedText } = await import('../../src/core/embedder.js');
    stubProvider([0.1, 0.2, 0.3]);
    const out = await embedText('some text');
    expect(out, 'a finite vector was refused').not.toBeNull();
    expect(Array.from(out as Float32Array)).toHaveLength(3);
    expect(written.join(''), 'a good vector produced a warning').not.toMatch(/non-finite/);
  });
});
