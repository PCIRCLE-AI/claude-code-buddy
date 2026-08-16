/**
 * `memesh upgrade-plugin` — the CLI front door to scripts/upgrade-plugin.sh.
 *
 * The README used to tell plugin users to hand-substitute their installed
 * version into
 *   ~/.claude/plugins/cache/pcircle-memesh/memesh/<current-version>/scripts/upgrade-plugin.sh
 * and the script then died mid-run when rsync was missing. The command's
 * whole contract is the four things pinned here:
 *
 *   1. no plugin cache → one helpful sentence (naming `memesh update` for
 *      npm installs) and exit 1, not a stack trace;
 *   2. a cache whose newest version predates the bundled script → an error
 *      that says exactly that, with the npm-global fallback path;
 *   3. the HIGHEST semver dir is picked (4.10.0 beats 4.9.0 — a plain
 *      string sort gets this wrong) and the script's exit code is passed
 *      through unchanged;
 *   4. prerequisites are checked BEFORE the script runs — a missing rsync
 *      is one plain sentence with the install command, and the script has
 *      not started.
 *
 * Every run uses a throwaway HOME (homeDir() honours HOME first, on every
 * platform, for exactly this reason). The tests that execute the script or
 * probe PATH are POSIX-only — the script itself is bash and the Windows CI
 * runner has no rsync — and are skipped on win32; the cache-location tests
 * (1, 2) never reach a spawn and run everywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function cacheRoot(): string {
  return path.join(home, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh');
}

/** Stage a fake plugin-cache version dir, optionally with an upgrade script. */
function stageVersion(version: string, script?: string): void {
  const dir = path.join(cacheRoot(), version);
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
  it('says where it looked, points npm users at `memesh update`, exits 1', () => {
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No Claude Code plugin install found');
    expect(r.stderr).toContain('~/.claude/plugins/cache/pcircle-memesh');
    expect(r.stderr).toContain('memesh update');
    expect(r.stderr, 'a stack frame reached the user').not.toMatch(/\n\s+at\s/);
  });

  it('treats a cache dir with no version-shaped subdirectory the same way', () => {
    // A stray non-version directory must not be mistaken for an install.
    fs.mkdirSync(path.join(cacheRoot(), 'not-a-version'), { recursive: true });
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No Claude Code plugin install found');
  });
});

describe('upgrade-plugin: version dir without the bundled script', () => {
  it('names the missing script and the npm-global fallback, exits 1', () => {
    stageVersion('4.2.4'); // pre-4.2.5 installs genuinely lack the script
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('scripts/upgrade-plugin.sh');
    expect(r.stderr).toContain('4.2.4');
    expect(r.stderr).toContain('npm prefix -g');
  });
});

describe('upgrade-plugin: locating and running the script', () => {
  posixOnly('runs the script from the HIGHEST semver dir and passes exit 0 through', () => {
    stageVersion('4.9.0', '#!/usr/bin/env bash\necho "ran-from 4.9.0"\nexit 0\n');
    stageVersion('4.10.0', '#!/usr/bin/env bash\necho "ran-from 4.10.0"\nexit 0\n');
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode, r.stderr).toBe(0);
    // 4.10.0, not 4.9.0: a plain string sort would pick 4.9.0.
    expect(r.stdout).toContain('ran-from 4.10.0');
    expect(r.stdout).not.toContain('ran-from 4.9.0');
  });

  posixOnly("exits with the script's own exit code on failure", () => {
    stageVersion('4.5.1', '#!/usr/bin/env bash\necho "boom" >&2\nexit 7\n');
    const r = runCli(['upgrade-plugin']);
    expect(r.exitCode).toBe(7);
    expect(r.stderr).toContain('boom');
  });
});

describe('upgrade-plugin: prerequisite check happens before the script runs', () => {
  posixOnly('a missing rsync is one plain sentence with the install command, and the script never started', () => {
    // The script writes a sentinel if it runs; the whole point is that it must not.
    const sentinel = path.join(home, 'script-ran');
    stageVersion('4.5.1', `#!/usr/bin/env bash\ntouch "${sentinel}"\nexit 0\n`);

    // A PATH with node and npm present but rsync absent. The shims only need
    // to EXIST as executables — the check asks the same question the script's
    // own `command -v` does, it does not run them.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-path-'));
    for (const tool of ['node', 'npm']) {
      fs.writeFileSync(path.join(shimDir, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    try {
      const r = runCli(['upgrade-plugin'], { PATH: shimDir });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('rsync is required by the upgrade script');
      expect(r.stderr).toContain('sudo apt install rsync');
      // node and npm were found — only the genuinely missing tool is named.
      expect(r.stderr).not.toContain('node is required');
      expect(r.stderr).not.toContain('npm is required');
      expect(fs.existsSync(sentinel), 'the upgrade script ran despite a failed prerequisite check').toBe(false);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
