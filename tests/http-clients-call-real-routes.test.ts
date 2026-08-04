/**
 * Every `/v1/...` path an in-repo client calls must be a route the server
 * registers, and must not be one the server has retired.
 *
 * `packages/python-sdk/` shipped a `consolidate()` method that posted to
 * `POST /v1/consolidate` for a full release after that endpoint started
 * answering `410 Gone`. Nothing noticed, because nothing compared the two: no
 * CI job ran the SDK's tests, no gate read its source, and its own README had
 * already been updated to say the method was retired while the code still
 * defined it. The SDK is deleted, and this is the rule that would have caught
 * it — pointed at whatever clients live here now, so the next one cannot drift
 * the same way.
 *
 * Today that is the dashboard, which is the client every `memesh serve` user
 * actually loads.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RETIRED_ROUTES } from '../src/transports/http/retired-routes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

/** `/v1/dream/proposals/:id/accept` and `/v1/dream/proposals/${id}/accept` are the same route. */
const normalise = (p: string) =>
  p
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
    .replace(/\/+$/, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|py)$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

const server = read('src/transports/http/server.ts');

/** Routes the Express app registers, normalised. Either quote style counts. */
const registered = new Set(
  [...server.matchAll(/^app\.(?:get|post|put|delete|patch)\((['"`])([^'"`]+)\1/gm)].map(m => normalise(m[2]))
);

/**
 * Routes that exist only to answer `410 Gone`. Reaching one is worse than a 404
 * from the caller's side: the call compiles, the request succeeds in the sense
 * that it gets a response, and only the body says the feature is gone.
 *
 * Imported from the same module the server registers them from — this used to
 * be re-derived by regexing server.ts through a 400-character window between
 * the path literal and `status(410)`, an input set pinned to nothing but the
 * file's current formatting.
 */
const retired = new Set(Object.keys(RETIRED_ROUTES).map(normalise));

/**
 * Directories that hold a client of the HTTP API. Add one when a client is
 * added — and add its entry to KNOWN_CALLS below, or the addition is
 * decorative: a root that contributes zero matches is indistinguishable from
 * a root the walker silently skipped.
 */
const CLIENT_ROOTS = ['dashboard/src', 'src/cli', 'scripts'];

/**
 * One known call per root, as an existence pin. If the dashboard stops
 * mentioning /v1/stats or view-live stops mentioning /v1/graph, that is a
 * product change worth a failing test; if the extraction regex rots, all
 * three vanish at once and this is what says so.
 */
const KNOWN_CALLS: Record<string, string> = {
  'dashboard/src': '/v1/stats',
  'src/cli': '/v1/graph',
  'scripts': '/v1/health',
};


/**
 * Every `/v1/...` path a file mentions, normalised. The opener class includes
 * `}` as well as the quotes: `\`http://127.0.0.1:${port}/v1/health\`` is a
 * real call whose path begins right after a template interpolation, and the
 * quote-only version of this regex silently skipped every such call — one of
 * the two files this test was widened to cover matched nothing at all.
 */
function v1Mentions(file: string): string[] {
  // `+`, not `*`: a bare '/v1/' is a prefix someone is configuring or
  // filtering on (this repo's own doc gate holds one), never a request path.
  return [...read(file).matchAll(/['"`}](\/v1\/[^'"`\s]+)['"`]/g)]
    .map(m => m[1].split('?')[0])
    .filter(raw => !raw.includes('*'))
    .map(normalise);
}

describe('in-repo HTTP clients call routes that exist', () => {
  it('the route list was actually extracted', () => {
    // A pattern that stops matching would otherwise turn every assertion below
    // into "no client path was missing from an empty set", which passes.
    expect(registered.size).toBeGreaterThan(20);
    expect(registered.has('/v1/health')).toBe(true);
  });

  it('the retired-route list was actually extracted', () => {
    // Same reason. `/v1/consolidate` is the one retirement in the tree; if this
    // set silently empties, the "no client calls a retired route" case below
    // becomes vacuous.
    expect(retired.has('/v1/consolidate')).toBe(true);
  });

  it('every retired route still has a registration to answer 410', () => {
    // An entry in RETIRED_ROUTES whose app.post line was deleted is a silent
    // 404 — exactly the failure the 410 exists to prevent.
    for (const r of retired) {
      expect(registered.has(r), `${r} is retired but no longer registered`).toBe(true);
    }
  });

  const clientFiles = CLIENT_ROOTS.filter(r => fs.existsSync(path.join(repoRoot, r))).flatMap(r => walk(r));

  it('finds client files to check', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it('every client root actually contributes call sites', () => {
    for (const [root, knownPath] of Object.entries(KNOWN_CALLS)) {
      const mentions = walk(root).flatMap(v1Mentions);
      expect(mentions.length, `${root} contributed no /v1 call sites — root drifted or regex rotted`).toBeGreaterThan(0);
      expect(mentions, `${root} should mention ${knownPath}`).toContain(knownPath);
    }
  });

  it('no client calls a path the server does not register', () => {
    const unknown = clientFiles.flatMap(f => v1Mentions(f).filter(p => !registered.has(p)).map(p => `${f} → ${p}`));
    expect(unknown).toEqual([]);
  });

  it('no client calls a route that answers 410 Gone', () => {
    const dead = clientFiles.flatMap(f => v1Mentions(f).filter(p => retired.has(p)).map(p => `${f} → ${p}`));
    expect(dead).toEqual([]);
  });
});
