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

/** Routes the Express app registers, normalised. */
const registered = new Set(
  [...server.matchAll(/^app\.(?:get|post|put|delete|patch)\('([^']+)'/gm)].map(m => normalise(m[1]))
);

/**
 * Routes that exist only to answer `410 Gone`. Reaching one is worse than a 404
 * from the caller's side: the call compiles, the request succeeds in the sense
 * that it gets a response, and only the body says the feature is gone.
 */
const retired = new Set(
  [...server.matchAll(/^app\.(?:get|post|put|delete|patch)\('([^']+)'[\s\S]{0,400}?res\s*\n?\s*\.?\s*status\(410\)/gm)].map(
    m => normalise(m[1])
  )
);

/** Directories that hold a client of the HTTP API. Add one when a client is added. */
const CLIENT_ROOTS = ['dashboard/src'];

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

  const clientFiles = CLIENT_ROOTS.filter(r => fs.existsSync(path.join(repoRoot, r))).flatMap(r => walk(r));

  it('finds client files to check', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it('no client calls a path the server does not register', () => {
    const unknown: string[] = [];
    for (const f of clientFiles) {
      for (const m of read(f).matchAll(/['"`](\/v1\/[^'"`\s]*)['"`]/g)) {
        const raw = m[1].split('?')[0];
        // `/v1/*` appears in prose describing the bearer-auth middleware
        // (`app.use('/v1/', bearerAuth)`), not as a call. A wildcard is never a
        // request path.
        if (raw.includes('*')) continue;
        const p = normalise(raw);
        if (!registered.has(p)) unknown.push(`${f} → ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('no client calls a route that answers 410 Gone', () => {
    const dead: string[] = [];
    for (const f of clientFiles) {
      for (const m of read(f).matchAll(/['"`](\/v1\/[^'"`\s]*)['"`]/g)) {
        const raw = m[1].split('?')[0];
        // `/v1/*` appears in prose describing the bearer-auth middleware
        // (`app.use('/v1/', bearerAuth)`), not as a call. A wildcard is never a
        // request path.
        if (raw.includes('*')) continue;
        const p = normalise(raw);
        if (retired.has(p)) dead.push(`${f} → ${m[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });
});
