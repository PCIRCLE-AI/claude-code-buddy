/**
 * The packed-upgrade gate used to name both ends of the one path it proved.
 * `expectedPreviousVersion = '4.8.2'` is a fact about the day it was written,
 * and a hand-written fact goes stale silently: the release after 4.8.3 would
 * have kept proving an upgrade nobody performs, in green.
 *
 * These tests drive the selection with fabricated registry documents, so the
 * derivation is pinned without the network and without an npm install. The
 * shapes mirror the real abbreviated packument (`dist-tags`, `versions[v]
 * .dependencies`) that `fetchPackument` returns.
 */
import { describe, it, expect } from 'vitest';
import {
  NATIVE_BUILD_DEPENDENCIES,
  assertEveryPathProven,
  compareReleases,
  needsNativeBuild,
  packumentUrl,
  parseRelease,
  selectUpgradePaths,
} from '../scripts/lib/upgrade-matrix.mjs';

type Packument = {
  'dist-tags': Record<string, string>;
  versions: Record<string, { dependencies?: Record<string, string> }>;
};

/** A registry document shaped like the real one, with a native-build era. */
function packument(latest: string): Packument {
  const native = { 'better-sqlite3': '^12.9.0', zod: '4.4.3' };
  const buildless = { zod: '4.4.3', 'sqlite-vec': '^0.1.9' };
  return {
    'dist-tags': { latest },
    versions: {
      '4.4.0': { dependencies: native },
      '4.5.0': { dependencies: native },
      '4.5.1': { dependencies: buildless },
      '4.6.0': { dependencies: buildless },
      '4.8.2': { dependencies: buildless },
      '4.8.3': { dependencies: buildless },
    },
  };
}

describe('release ordering', () => {
  it('orders plain releases numerically, not as strings', () => {
    expect(['4.2.11', '4.2.9', '4.10.0'].sort(compareReleases)).toEqual(['4.2.9', '4.2.11', '4.10.0']);
  });

  it('refuses anything that is not X.Y.Z rather than sorting it somewhere', () => {
    expect(parseRelease('3.0.0-rc.1')).toBeNull();
    expect(() => compareReleases('4.0.0', '3.0.0-rc.1')).toThrow(/not a plain/);
  });
});

describe('native build detection', () => {
  it('names better-sqlite3 as the dependency that compiles', () => {
    expect(NATIVE_BUILD_DEPENDENCIES).toContain('better-sqlite3');
    expect(needsNativeBuild({ 'better-sqlite3': '^12.9.0' })).toBe(true);
    expect(needsNativeBuild({ 'sqlite-vec': '^0.1.9' })).toBe(false);
    expect(needsNativeBuild(undefined)).toBe(false);
  });
});

describe('selectUpgradePaths', () => {
  it('proves the newest release below the candidate and the oldest buildless one', () => {
    expect(selectUpgradePaths(packument('4.8.3'), '4.8.4')).toEqual(['4.5.1', '4.8.3']);
  });

  it('moves on its own when a new version is published', () => {
    const next = packument('4.8.3');
    next.versions['4.8.4'] = { dependencies: { zod: '4.4.3' } };
    next['dist-tags'].latest = '4.8.4';
    expect(selectUpgradePaths(next, '4.8.5')).toEqual(['4.5.1', '4.8.4']);
  });

  it('never proves an upgrade from the candidate or from a version above it', () => {
    const paths = selectUpgradePaths(packument('4.8.3'), '4.8.3');
    expect(paths).toEqual(['4.5.1', '4.8.2']);
    expect(paths).not.toContain('4.8.3');
  });

  it('adds the latest dist-tag when it points below the highest published version', () => {
    expect(selectUpgradePaths(packument('4.6.0'), '4.8.4')).toEqual(['4.5.1', '4.6.0', '4.8.3']);
  });

  it('skips releases that need a native build for the long-chain row', () => {
    expect(selectUpgradePaths(packument('4.8.3'), '4.8.4')).not.toContain('4.4.0');
  });

  it('fails loudly instead of returning a shorter matrix', () => {
    expect(() => selectUpgradePaths(packument('4.8.3'), '4.4.0')).toThrow(/no published release below/);
    expect(() => selectUpgradePaths(
      { 'dist-tags': { latest: '4.4.0' }, versions: { '4.4.0': { dependencies: { 'better-sqlite3': '^12' } } } },
      '4.5.0',
    )).toThrow(/native build/);
    expect(() => selectUpgradePaths(packument('4.8.3'), 'not-a-version')).toThrow(/plain X\.Y\.Z/);
  });

  it('ignores prereleases published alongside real ones', () => {
    const withPrerelease = packument('4.8.3');
    withPrerelease.versions['4.8.4-rc.1'] = { dependencies: {} };
    expect(selectUpgradePaths(withPrerelease, '4.8.4')).toEqual(['4.5.1', '4.8.3']);
  });
});

describe('the registry URL', () => {
  it('encodes the scope separator', () => {
    expect(packumentUrl('https://registry.npmjs.org/', '@pcircle/memesh'))
      .toBe('https://registry.npmjs.org/@pcircle%2fmemesh');
  });

  // The security fix is the validation, not the `replaceAll`: with a grammar
  // that permits at most one separator, no valid input distinguishes
  // `replaceAll` from `replace`, so a test claiming to catch that would be
  // one nothing can fail. What CAN fail is the grammar, and these are the
  // inputs it must refuse.

  it('adds the missing slash to a registry that has none', () => {
    expect(packumentUrl('https://registry.npmjs.org', 'memesh'))
      .toBe('https://registry.npmjs.org/memesh');
  });

  it('refuses anything that is not an npm package name', () => {
    for (const bad of ['../../etc/passwd', '@scope/a/b', 'name?query=1', 'name#frag', '']) {
      expect(() => packumentUrl('https://registry.npmjs.org/', bad)).toThrow(/not an npm package name/);
    }
  });
});

describe('proving every derived path', () => {
  it('accepts a run that proved exactly what was derived', () => {
    expect(() => assertEveryPathProven(['4.5.1', '4.8.2'], ['4.5.1', '4.8.2'])).not.toThrow();
  });

  it('rejects a matrix that quietly shrank to one row', () => {
    expect(() => assertEveryPathProven(['4.5.1', '4.8.2'], ['4.5.1']))
      .toThrow(/proved 1 of 2 derived paths; never proved: 4\.8\.2/);
  });

  it('rejects a row nobody derived', () => {
    expect(() => assertEveryPathProven(['4.8.2'], ['4.8.2', '4.7.3']))
      .toThrow(/proved but never derived: 4\.7\.3/);
  });
});
