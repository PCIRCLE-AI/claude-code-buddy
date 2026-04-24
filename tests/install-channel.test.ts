import path from 'path';
import { describe, expect, it } from 'vitest';
import { detectInstallChannel, getInstallChannelSupport } from '../src/core/install-channel.js';

function existsFor(paths: string[]) {
  const normalized = new Set(paths.map((entry) => path.resolve(entry)));
  return (target: string) => normalized.has(path.resolve(target));
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
  });
});
