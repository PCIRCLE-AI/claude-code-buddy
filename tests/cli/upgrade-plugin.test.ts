/**
 * `memesh upgrade-plugin` — the CLI front door to scripts/upgrade-plugin.sh.
 *
 * The README used to tell plugin users to hand-substitute their installed
 * version into
 *   ~/.claude/plugins/cache/pcircle-memesh/memesh/<current-version>/scripts/upgrade-plugin.sh
 * and the script then died mid-run when a required tool was missing. The command's
 * whole contract is the four things pinned here:
 *
 *   1. no Claude plugin cache → helpful npm and Codex-specific next steps
 *      and exit 1, not a stack trace;
 *   2. a cache whose newest version predates the bundled script → an error
 *      that says exactly that, with the npm-global fallback path;
 *   3. the running installation's bundled script wins over a stale cache;
 *      otherwise the HIGHEST semver dir is picked (4.10.0 beats 4.9.0);
 *   4. prerequisites are checked BEFORE the script runs — a missing actual
 *      tool is one plain sentence with the install command, and the script
 *      has not started.
 *
 * Every run uses a throwaway HOME (homeDir() honours HOME first, on every
 * platform, for exactly this reason). The tests that execute the script or
 * probe PATH are POSIX-only — the script itself is bash and the Windows CI
 * runner has no tar — and are skipped on win32; the cache-location tests
 * (1, 2) never reach a spawn and run everywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveUpgradePluginScript } from '../../src/transports/cli/cli.js';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(
  args: string[],
  envOverride: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  try {
    // process.execPath, not 'node': the PATH-restriction test below hands the
    // child an env whose PATH has no real node in it, and POSIX resolves the
    // spawned binary against the CHILD's env. An absolute path sidesteps that.
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, ...envOverride },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

function cacheRoot(configRoot = path.join(home, '.claude')): string {
  return path.join(configRoot, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
}

/** Stage a fake plugin-cache version dir, optionally with an upgrade script. */
function stageVersion(version: string, script?: string, root = cacheRoot()): void {
  const dir = path.join(root, version);
  fs.mkdirSync(dir, { recursive: true });
  if (script !== undefined) {
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'upgrade-plugin.sh'), script, { mode: 0o755 });
  }
}

const posixOnly = it.skipIf(process.platform === 'win32');

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-upgrade-plugin-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('upgrade-plugin: no plugin install', () => {
  it('says where it looked and gives npm and Codex users the right next step', () => {
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No Claude Code plugin install found');
    expect(r.stderr).toContain(cacheRoot());
    expect(r.stderr).toContain('memesh update');
    expect(r.stderr).toContain('Codex');
    expect(r.stderr).toContain('memesh doctor');
    expect(r.stderr, 'a stack frame reached the user').not.toMatch(/\n\s+at\s/);
  });

  it('treats a cache dir with no version-shaped subdirectory the same way', () => {
    // A stray non-version directory must not be mistaken for an install.
    fs.mkdirSync(path.join(cacheRoot(), 'not-a-version'), { recursive: true });
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No Claude Code plugin install found');
  });

  it('reports the relocated CLAUDE_CONFIG_DIR instead of a hardcoded ~/.claude path', () => {
    const configRoot = path.join(home, 'relocated-claude');
    const r = runCli(['upgrade-plugin'], { CLAUDE_CONFIG_DIR: configRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(cacheRoot(configRoot));
    expect(r.stderr).not.toContain('~/.claude/plugins/cache');
  });
});

describe('upgrade-plugin: version dir without the bundled script', () => {
  it('resolves the cache script path so the command can report a truthful fallback error', () => {
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-running-install-'));
    stageVersion('4.2.4'); // pre-4.2.5 installs genuinely lack the script
    const resolved = resolveUpgradePluginScript(bundledRoot, cacheRoot());
    expect(resolved?.script).toBe(path.join(cacheRoot(), '4.2.4', 'scripts', 'upgrade-plugin.sh'));
    expect(fs.existsSync(resolved!.script)).toBe(false);
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });
});

describe('upgrade-plugin: locating and running the script', () => {
  posixOnly('prefers the running installation script over a stale cache sentinel', () => {
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-running-install-'));
    const sentinel = path.join(home, 'stale-cache-script-ran');
    const bundledSentinel = path.join(home, 'running-install-script-ran');
    stageVersion('4.10.0', `#!/usr/bin/env bash\ntouch "${sentinel}"\nexit 0\n`);
    fs.mkdirSync(path.join(bundledRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(bundledRoot, 'scripts', 'upgrade-plugin.sh'), `#!/usr/bin/env bash\ntouch "${bundledSentinel}"\n`, { mode: 0o755 });
    const resolved = resolveUpgradePluginScript(bundledRoot, cacheRoot());
    expect(resolved?.script).toBe(path.join(bundledRoot, 'scripts', 'upgrade-plugin.sh'));
    expect(resolved?.script).not.toContain('4.10.0');
    execFileSync('bash', [resolved!.script]);
    expect(fs.existsSync(bundledSentinel)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });

  it('falls back to the HIGHEST semver cache script when the running install lacks one', () => {
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-running-install-'));
    stageVersion('4.9.0', '#!/usr/bin/env bash\n');
    stageVersion('4.10.0', '#!/usr/bin/env bash\n');
    const resolved = resolveUpgradePluginScript(bundledRoot, cacheRoot());
    expect(resolved?.script).toBe(path.join(cacheRoot(), '4.10.0', 'scripts', 'upgrade-plugin.sh'));
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });

  it('prefers a stable release over its prerelease and ignores prefix-only version names', () => {
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-running-install-'));
    stageVersion('4.8.2-rc.1', '#!/usr/bin/env bash\n');
    stageVersion('4.8.2', '#!/usr/bin/env bash\n');
    stageVersion('4.8.2garbage', '#!/usr/bin/env bash\n');
    const resolved = resolveUpgradePluginScript(bundledRoot, cacheRoot());
    expect(resolved?.newest).toBe('4.8.2');
    expect(resolved?.script).toBe(path.join(cacheRoot(), '4.8.2', 'scripts', 'upgrade-plugin.sh'));
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });

  posixOnly('uses the bundled repair script when the registry survives but every cache directory is missing', () => {
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [{ installPath: path.join(cacheRoot(), '4.8.2') }] } }));
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-path-'));
    for (const tool of ['node', 'npm', 'git']) {
      fs.writeFileSync(path.join(shimDir, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    try {
      const r = runCli(['upgrade-plugin'], { PATH: shimDir });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('tar is required by the upgrade script');
      expect(r.stderr).not.toContain('No Claude Code plugin install found');
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  posixOnly('finds a plugin beneath relocated CLAUDE_CONFIG_DIR before checking prerequisites', () => {
    const configRoot = path.join(home, 'relocated-claude');
    const relocatedCache = cacheRoot(configRoot);
    stageVersion('4.8.2', '#!/usr/bin/env bash\nexit 0\n', relocatedCache);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-path-'));
    for (const tool of ['node', 'npm', 'git']) {
      fs.writeFileSync(path.join(shimDir, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    try {
      const r = runCli(['upgrade-plugin'], { CLAUDE_CONFIG_DIR: configRoot, PATH: shimDir });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('tar is required by the upgrade script');
      expect(r.stderr).not.toContain('No Claude Code plugin install found');
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

describe('upgrade-plugin: prerequisite check happens before the script runs', () => {
  posixOnly('a missing tar is one plain sentence with the install command, and the script never started', () => {
    // The script writes a sentinel if it runs; the whole point is that it must not.
    const sentinel = path.join(home, 'script-ran');
    stageVersion('4.5.1', `#!/usr/bin/env bash\ntouch "${sentinel}"\nexit 0\n`);

    // A PATH with node, npm and git present but tar absent. The shims only need
    // to EXIST as executables — the check asks the same question the script's
    // own `command -v` does, it does not run them.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-path-'));
    for (const tool of ['node', 'npm', 'git']) {
      fs.writeFileSync(path.join(shimDir, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    try {
      const r = runCli(['upgrade-plugin'], { PATH: shimDir });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('tar is required by the upgrade script');
      expect(r.stderr).toContain('sudo apt install tar');
      // node, npm and git were found — only the genuinely missing tool is named.
      expect(r.stderr).not.toContain('node is required');
      expect(r.stderr).not.toContain('npm is required');
      expect(r.stderr).not.toContain('git is required');
      expect(fs.existsSync(sentinel), 'the upgrade script ran despite a failed prerequisite check').toBe(false);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  posixOnly('does not require rsync when all actual script prerequisites exist', () => {
    stageVersion('4.5.1', '#!/usr/bin/env bash\ntouch "$HOME/cache-script-ran"\nexit 0\n');
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-path-'));
    for (const tool of ['node', 'npm', 'git', 'tar']) {
      fs.writeFileSync(path.join(shimDir, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    fs.symlinkSync(execFileSync('which', ['bash'], { encoding: 'utf8' }).trim(), path.join(shimDir, 'bash'));
    try {
      const r = runCli(['upgrade-plugin'], { PATH: shimDir });
      expect(r.stderr).not.toContain('rsync is required');
      // The bundled script is selected and reaches its own marketplace check;
      // rsync is absent but is not a prerequisite anymore.
      expect(r.stderr).toContain('marketplace cache not found');
      expect(fs.existsSync(path.join(home, 'cache-script-ran'))).toBe(false);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
