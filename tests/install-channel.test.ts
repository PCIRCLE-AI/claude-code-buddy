import path from 'path';
import type fs from 'fs';
import { describe, expect, it } from 'vitest';
import { detectInstallChannel, getGlobalNpmRoot, getInstallChannelSupport } from '../src/core/install-channel.js';

function existsFor(paths: string[]) {
  const normalized = new Set(paths.map((entry) => path.resolve(entry)));
  return (target: fs.PathLike) => normalized.has(path.resolve(String(target)));
}

describe('install channel detection', () => {
  it('detects source checkouts when the package root contains .git', () => {
    const packageRoot = '/workspace/memesh';
    const channel = detectInstallChannel({
      packageRoot,
      existsSyncImpl: existsFor([path.join(packageRoot, '.git')]),
      globalNpmRoot: null,
    });

    expect(channel).toBe('source-checkout');
  });

  it('detects npm global installs from npm root -g', () => {
    const globalRoot = '/usr/local/lib/node_modules';
    const packageRoot = '/usr/local/lib/node_modules/@pcircle/memesh';

    const channel = detectInstallChannel({
      packageRoot,
      globalNpmRoot: globalRoot,
      existsSyncImpl: existsFor([]),
    });

    expect(channel).toBe('npm-global');
  });

  it('detects project-local installs when the project root has package.json', () => {
    const projectRoot = '/workspace/app';
    const packageRoot = '/workspace/app/node_modules/@pcircle/memesh';

    const channel = detectInstallChannel({
      packageRoot,
      globalNpmRoot: null,
      existsSyncImpl: existsFor([path.join(projectRoot, 'package.json')]),
    });

    expect(channel).toBe('npm-local');
  });

  it('falls back to unknown instead of assuming npm-local without a project package.json', () => {
    const packageRoot = '/opt/custom/node_modules/@pcircle/memesh';

    const channel = detectInstallChannel({
      packageRoot,
      globalNpmRoot: null,
      existsSyncImpl: existsFor([]),
    });

    expect(channel).toBe('unknown');
  });

  it('detects Claude Code plugin-marketplace cache paths', () => {
    const packageRoot = '/Users/alice/.claude/plugins/cache/pcircle-memesh/memesh/4.2.4';

    const channel = detectInstallChannel({
      packageRoot,
      globalNpmRoot: null,
      // Plugin cache is a git clone, so .git exists — but we still want
      // to classify as plugin-marketplace, not source-checkout. The path
      // check runs before the .git check.
      existsSyncImpl: existsFor([path.join(packageRoot, '.git')]),
    });

    expect(channel).toBe('plugin-marketplace');
  });
});

describe('install channel support', () => {
  it('only enables self-update for npm global installs', () => {
    expect(getInstallChannelSupport('npm-global')).toMatchObject({
      canSelfUpdate: true,
      recommendedCommand: 'memesh update',
    });

    expect(getInstallChannelSupport('npm-local')).toMatchObject({
      canSelfUpdate: false,
      recommendedCommand: null,
    });

    expect(getInstallChannelSupport('source-checkout')).toMatchObject({
      canSelfUpdate: false,
      recommendedCommand: null,
    });

    expect(getInstallChannelSupport('plugin-marketplace')).toMatchObject({
      canSelfUpdate: false,
      recommendedCommand: 'memesh upgrade-plugin',
    });
  });
});

describe('the global npm root when npm is not reachable', () => {
  // `npm root -g` is authoritative — it honours `prefix` from `.npmrc`, which
  // nothing derivable can see — but it fails whenever `npm` is not on PATH.
  // That is not exotic: Claude Code launched from a GUI app, or a shell where
  // a version manager's shim has not been sourced, both give a process
  // `node` without `npm`. Detection then fell through to `unknown`, and
  // `memesh update` refused to run on a real npm-global install.
  const throwingNpm = (() => { throw new Error('spawn npm ENOENT'); }) as never;

  it('derives it from the running Node binary when the spawn fails', () => {
    const root = getGlobalNpmRoot({
      execFileSyncImpl: throwingNpm,
      execPathImpl: '/opt/homebrew/bin/node',
    });

    const expected = process.platform === 'win32'
      ? path.join('/opt/homebrew', 'node_modules')
      : path.join('/opt/homebrew', 'lib', 'node_modules');
    expect(root).toBe(expected);
  });

  it('prefers what npm says when npm answers — the anti-vacuity half', () => {
    // A derivation that always won would silently override a custom
    // `prefix` in `.npmrc`, which is the one thing the spawn can see.
    const root = getGlobalNpmRoot({
      execFileSyncImpl: (() => '/custom/prefix/lib/node_modules\n') as never,
      execPathImpl: '/opt/homebrew/bin/node',
    });

    expect(root).toBe('/custom/prefix/lib/node_modules');
  });

  it('classifies a global install as npm-global on the derived root', () => {
    // The end the fix exists for: the same package root that used to come
    // back `unknown`.
    const packageRoot = path.join('/opt/homebrew', 'lib', 'node_modules', '@pcircle', 'memesh');
    const channel = detectInstallChannel({
      packageRoot,
      globalNpmRoot: () => getGlobalNpmRoot({
        execFileSyncImpl: throwingNpm,
        execPathImpl: '/opt/homebrew/bin/node',
      }),
      existsSyncImpl: existsFor([]),
    });

    expect(channel).toBe(process.platform === 'win32' ? 'unknown' : 'npm-global');
  });
});
