import path from 'path';
import type fs from 'fs';
import { describe, expect, it } from 'vitest';
import { detectInstallChannel, detectPluginHost, getGlobalNpmRoot, getInstallChannelSupport } from '../src/core/install-channel.js';

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

  it('detects Codex CLI plugin-marketplace cache paths', () => {
    // Codex adopted the same plugin manifest and the same cache layout one
    // directory over. Matching only `.claude` classified these as `unknown`,
    // and `memesh update` told a real user it "does not support this install
    // method (unknown)" on an install it fully supports.
    const packageRoot = '/Users/alice/.codex/plugins/cache/pcircle-memesh/memesh/4.7.1';

    const channel = detectInstallChannel({
      packageRoot,
      globalNpmRoot: null,
      existsSyncImpl: existsFor([path.join(packageRoot, '.git')]),
    });

    expect(channel).toBe('plugin-marketplace');
  });
});

const CLAUDE_PLUGIN_ROOT = '/Users/alice/.claude/plugins/cache/pcircle-memesh/memesh/4.7.1';
const CODEX_PLUGIN_ROOT = '/Users/alice/.codex/plugins/cache/pcircle-memesh/memesh/4.7.1';

describe('install channel support', () => {
  it('only enables self-update for npm global installs', () => {
    expect(getInstallChannelSupport('npm-global', '/usr/local/lib/node_modules/@pcircle/memesh')).toMatchObject({
      canSelfUpdate: true,
      recommendedCommand: 'memesh update',
    });

    expect(getInstallChannelSupport('npm-local', '/repo/node_modules/@pcircle/memesh')).toMatchObject({
      canSelfUpdate: false,
      recommendedCommand: null,
    });

    expect(getInstallChannelSupport('source-checkout', '/workspace/memesh')).toMatchObject({
      canSelfUpdate: false,
      recommendedCommand: null,
    });

    expect(getInstallChannelSupport('plugin-marketplace', CLAUDE_PLUGIN_ROOT)).toMatchObject({
      canSelfUpdate: false,
      recommendedCommand: 'memesh upgrade-plugin',
    });
  });

  it('does NOT prescribe upgrade-plugin to a Codex-hosted install', () => {
    // `scripts/upgrade-plugin.sh` reads ~/.claude/plugins/marketplaces and
    // patches ~/.claude/plugins/installed_plugins.json. Codex creates
    // neither, so that command aborts with "marketplace cache not found".
    // Prescribing it would be a confidently wrong instruction.
    const support = getInstallChannelSupport('plugin-marketplace', CODEX_PLUGIN_ROOT);

    expect(support.recommendedCommand, 'a Codex user was handed the Claude Code upgrade command')
      .not.toBe('memesh upgrade-plugin');
    expect(support.guidance).not.toMatch(/memesh upgrade-plugin/);
    expect(support.recommendedCommand).toBe('codex plugin marketplace upgrade pcircle-memesh');
    expect(support.guidance, 'the guidance never says how to install the refreshed version')
      .toMatch(/codex plugin add memesh@pcircle-memesh/);
    expect(support.label).toMatch(/Codex/);
  });

  it('still prescribes upgrade-plugin to a Claude Code install', () => {
    // The other half: the Codex branch must not swallow the majority case.
    const support = getInstallChannelSupport('plugin-marketplace', CLAUDE_PLUGIN_ROOT);

    expect(support.recommendedCommand).toBe('memesh upgrade-plugin');
    expect(support.guidance).not.toMatch(/codex plugin/);
  });
});

describe('plugin host detection', () => {
  it('tells the two runtimes apart', () => {
    expect(detectPluginHost(CLAUDE_PLUGIN_ROOT)).toBe('claude-code');
    expect(detectPluginHost(CODEX_PLUGIN_ROOT)).toBe('codex');
  });

  it('is null for anything that is not a plugin cache', () => {
    expect(detectPluginHost('/workspace/memesh')).toBeNull();
    expect(detectPluginHost('/usr/local/lib/node_modules/@pcircle/memesh')).toBeNull();
  });

  it('does not fire on a user path that merely contains plugins/cache', () => {
    // The anchor is `<runtime-dir>/plugins/cache/`, not the bare substring.
    expect(detectPluginHost('/home/bob/projects/plugins/cache/thing')).toBeNull();
    expect(detectPluginHost('/home/bob/.claudex/plugins/cache/x/y/1.0.0')).toBeNull();
  });

  it('normalises the path the same way detectInstallChannel does', () => {
    // detectInstallChannel matches against path.resolve(packageRoot), and
    // runDoctor takes packageRoot from its caller. If this helper matched the
    // raw string instead, the two would disagree on any unnormalised path —
    // the channel would say `plugin-marketplace` while the host came back
    // null, and a Codex user would be handed `memesh upgrade-plugin`, the one
    // command that aborts for them.
    // A raw literal, NOT path.join — join already collapses `..`, so a joined
    // path is normalised before it ever reaches the helper and would pass with
    // or without the resolve. Only an unnormalised string tells them apart.
    const messy = '/Users/alice/.codex/plugins/other/../cache/pcircle-memesh/memesh/4.7.1';

    expect(detectPluginHost(messy)).toBe('codex');
    expect(
      detectInstallChannel({ packageRoot: messy, globalNpmRoot: null, existsSyncImpl: existsFor([]) }),
      'the two disagree on the same path',
    ).toBe('plugin-marketplace');
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
