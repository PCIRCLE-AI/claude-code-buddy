/**
 * `memesh doctor` had no row for the runtime it was running on.
 *
 * A user below the supported Node floor saw hooks misbehaving, a red native
 * binding, and nothing anywhere connecting either to their Node version — the
 * one fact that explains both. This row states it.
 *
 * Two things it must NOT do, and both are pinned here:
 *
 *   1. Fail on a healthy install. The row is allowed to FAIL, so a version
 *      comparison that guesses at a range it does not understand would tell a
 *      correct setup it is broken. It reports "not checked" instead — the
 *      true statement — for anything outside the `>=X.Y.Z` form this package
 *      actually publishes.
 *
 *   2. Print to stderr. `node:sqlite` emits an `ExperimentalWarning` on Node
 *      22 when it is IMPORTED, and seven hooks parse process output. A
 *      diagnostic that caused the breakage it exists to diagnose would be its
 *      own kind of joke, so the probe resolves rather than imports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  satisfiesMinimumNodeRange,
  inspectNodeRuntime,
  hasBuiltInSqlite,
} from '../../src/core/doctor.js';

describe('satisfiesMinimumNodeRange', () => {
  it('compares numerically, not lexically', () => {
    // The trap a string compare falls into: '9' > '20' as text.
    expect(satisfiesMinimumNodeRange('v9.11.2', '>=20.0.0')).toBe(false);
    expect(satisfiesMinimumNodeRange('v20.0.0', '>=20.0.0')).toBe(true);
    expect(satisfiesMinimumNodeRange('v24.15.0', '>=20.0.0')).toBe(true);
    expect(satisfiesMinimumNodeRange('v100.0.0', '>=20.0.0')).toBe(true);
  });

  it('compares minor and patch, not just major', () => {
    // `node:sqlite` landed in 22.5.0, so a `>=22.5.0` floor is a range this
    // project may plausibly adopt — and 22.4 must not satisfy it.
    expect(satisfiesMinimumNodeRange('v22.4.0', '>=22.5.0')).toBe(false);
    expect(satisfiesMinimumNodeRange('v22.5.0', '>=22.5.0')).toBe(true);
    expect(satisfiesMinimumNodeRange('v22.5.1', '>=22.5.0')).toBe(true);
    expect(satisfiesMinimumNodeRange('v22.13.0', '>=22.5.0')).toBe(true);
    // 13 > 5 numerically; lexically '13' < '5'.
    expect(satisfiesMinimumNodeRange('v22.13.0', '>=22.9.0')).toBe(true);
  });

  it('tolerates the shorthand forms of a minimum', () => {
    expect(satisfiesMinimumNodeRange('v20.1.0', '>=20')).toBe(true);
    expect(satisfiesMinimumNodeRange('v19.9.0', '>=20')).toBe(false);
    expect(satisfiesMinimumNodeRange('v20.0.0', '>= 20.0')).toBe(true);
  });

  it('answers null — not a guess — for a range it does not understand', () => {
    // Every one of these is a real npm engines spelling, and every one means
    // something this comparison cannot express. Guessing would let the row
    // fail a healthy install.
    for (const range of ['^20.0.0', '>=20 <22', '20.x', '18 || 20', '*', '']) {
      expect(satisfiesMinimumNodeRange('v20.0.0', range), `guessed at "${range}"`).toBeNull();
    }
    expect(satisfiesMinimumNodeRange('not-a-version', '>=20.0.0')).toBeNull();
  });
});

describe('doctor: Node runtime row', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nodert-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real package.json on disk — the row reads a file, so give it one. */
  function writePackage(engines?: unknown): void {
    const pkg: Record<string, unknown> = { name: 'p', version: '1.0.0' };
    if (engines !== undefined) pkg.engines = engines;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  }

  function row(nodeVersion: string) {
    return inspectNodeRuntime(dir, fs.existsSync, fs.readFileSync, nodeVersion, '137', () => true);
  }

  it('fails when the runtime is below the declared floor', () => {
    writePackage({ node: '>=20.0.0' });

    const check = row('v18.20.8');

    expect(check.status).toBe('fail');
    expect(check.informational).toBeFalsy();
    expect(check.summary).toContain('v18.20.8');
    expect(check.summary).toContain('>=20.0.0');
    // A fix the user can act on, not just a diagnosis.
    expect(check.fix).toContain('20.0.0');
  });

  it('passes on a supported runtime, and says what it checked against', () => {
    writePackage({ node: '>=20.0.0' });

    const check = row('v24.15.0');

    expect(check.status).toBe('pass');
    expect(check.informational).toBeFalsy();
    expect(check.summary).toContain('v24.15.0');
    expect(check.summary).toContain('>=20.0.0');
  });

  it('reports the facts a feedback issue needs, and nothing personal', () => {
    // `memesh feedback` copies this summary verbatim into a PUBLIC GitHub
    // issue body. Machine facts are the point; a path or a name would not be.
    writePackage({ node: '>=20.0.0' });

    const check = inspectNodeRuntime(dir, fs.existsSync, fs.readFileSync, 'v22.23.2', '127', () => true);

    expect(check.summary).toContain('ABI 127');
    expect(check.summary).toContain('node:sqlite: available');
    expect(check.summary).not.toContain(dir);
    expect(check.summary).not.toContain(os.homedir());
  });

  it('reports node:sqlite as absent when it is', () => {
    writePackage({ node: '>=20.0.0' });

    const check = inspectNodeRuntime(dir, fs.existsSync, fs.readFileSync, 'v20.20.2', '115', () => false);

    expect(check.summary).toContain('node:sqlite: not available');
    // Absent built-in SQLite is not a failure — nothing requires it today.
    expect(check.status).toBe('pass');
  });

  it('does not fail an install whose engines range it cannot parse', () => {
    writePackage({ node: '^20.0.0 || ^22.0.0' });

    const check = row('v18.0.0'); // below both, but the range is unparseable

    expect(check.status).toBe('pass');
    expect(check.informational, 'an unchecked row must not count toward Overall').toBe(true);
    expect(check.summary).toContain('not checked');
  });

  it('does not fail when package.json declares no engines at all', () => {
    writePackage(undefined);

    const check = row('v18.0.0');

    expect(check.informational).toBe(true);
    expect(check.summary).toContain('no engines.node');
    // The facts still get reported — that is the part a feedback issue needs.
    expect(check.summary).toContain('v18.0.0');
  });

  it('does not fail when package.json is missing or unreadable', () => {
    // No package.json written at all.
    const missing = row('v24.15.0');
    expect(missing.informational).toBe(true);

    fs.writeFileSync(path.join(dir, 'package.json'), '{ "engines": { "node');
    const broken = row('v24.15.0');
    expect(broken.informational, 'a truncated package.json must not read as a bad runtime').toBe(true);
  });
});

describe('the row reaches the report a user actually sees', () => {
  it('appears in `memesh doctor` output', () => {
    // Every assertion above tests the function. This one tests that anything
    // calls it: a row nobody pushes is a row nobody reads, and unit tests of
    // an unwired function pass forever.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-e2e-'));
    try {
      let out = '';
      try {
        out = execFileSync('node', [path.resolve('dist/transports/cli/cli.js'), 'doctor'], {
          env: { ...process.env, HOME: home, MEMESH_DIR: path.join(home, '.memesh') },
          encoding: 'utf8',
        });
      } catch (err) {
        // doctor exits non-zero when it finds problems; the output is what
        // matters here, not the verdict.
        out = (err as { stdout?: string }).stdout ?? '';
      }

      expect(out).toContain('Node runtime');
      expect(out).toContain(`Node ${process.version}`);
      expect(out).toContain('node:sqlite');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the node:sqlite probe stays silent', () => {
  it('emits nothing on stderr', () => {
    // On Node 22 an `await import('node:sqlite')` prints
    //   ExperimentalWarning: SQLite is an experimental feature ...
    // to stderr — measured on v22.23.2. Seven hooks parse process output, so
    // a probe that warned would break the thing it is diagnosing. Resolving
    // instead of importing avoids it.
    //
    // Honest about coverage: on Node 24 and 26 this assertion is vacuous
    // (nothing warns there either way). It bites on the Node 22 leg of the CI
    // matrix, which is why that leg exists.
    // `pathToFileURL`, not the bare path: on Windows a dynamic `import()` of
    // `D:\a\...` throws ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol
    // 'd:'"), because the loader reads the drive letter as a URL scheme.
    const moduleUrl = pathToFileURL(path.resolve('dist/core/doctor.js')).href;
    const stderr = execFileSync(
      'node',
      [
        '-e',
        `import(${JSON.stringify(moduleUrl)})` +
          `.then(m => { if (typeof m.hasBuiltInSqlite() !== 'boolean') process.exit(3); })`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );

    expect(stderr).toBe('');
  });

  it('agrees with what this runtime actually is', () => {
    // Guards against the probe degrading into a constant, which would make the
    // silence assertion above pass for the wrong reason.
    //
    // Asserted against the runtime rather than as a universal truth: this used
    // to be `toBe(true)`, which is false on Node 20 — `node:sqlite` arrived in
    // 22.5.0 — and it turned every Node 20 CI leg red the first time those
    // legs ran on a stacked PR. Written this way the assertion is meaningful
    // on BOTH sides of the boundary: false below 22.5, true at or above it.
    expect(hasBuiltInSqlite()).toBe(satisfiesMinimumNodeRange(process.version, '>=22.5.0'));
  });
});
