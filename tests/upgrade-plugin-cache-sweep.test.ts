/**
 * `sweep_stale_cache_versions` in scripts/upgrade-plugin.sh (D9).
 *
 * Measured on a real machine: 9 stale version directories under
 * `~/.claude/plugins/cache/pcircle-memesh/memesh/`, 1.2 GB, with nothing
 * ever removing them — the script's own swap logic only ever deletes the
 * ONE version it just replaced, so a directory left behind by an
 * interrupted or pre-swap-mechanism upgrade had no path back to zero.
 *
 * The test sources the real script with `MEMESH_UPGRADE_PLUGIN_SOURCE_ONLY=1`
 * (a guard defined at the top of the script, before anything that touches a
 * real Claude Code marketplace checkout) and calls the function directly —
 * exercising the shipped code, not a hand-copied reimplementation of it.
 * POSIX-only: the script is bash and the Windows CI runner has no bash
 * shell in the sense this script needs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const scriptPath = path.resolve(__dirname, '../scripts/upgrade-plugin.sh');
const posixOnly = it.skipIf(process.platform === 'win32');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cache-sweep-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sweep(keepVersion: string, alsoKeep?: string): void {
  execFileSync(
    'bash',
    ['-c', `source "${scriptPath}"; sweep_stale_cache_versions "$1" "$2" "$3"`, '--', root, keepVersion, alsoKeep ?? ''],
    { env: { ...process.env, MEMESH_UPGRADE_PLUGIN_SOURCE_ONLY: '1' } },
  );
}

function makeDir(name: string, withFile = false): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withFile) fs.writeFileSync(path.join(dir, 'marker'), 'x');
}

describe('sweep_stale_cache_versions (D9)', () => {
  posixOnly('removes every semver-named directory except the one being kept', () => {
    makeDir('4.8.1', true);
    makeDir('4.8.2', true);
    makeDir('4.8.3', true);
    makeDir('4.8.4', true);

    sweep('4.8.4');

    const remaining = fs.readdirSync(root).sort();
    expect(remaining).toEqual(['4.8.4']);
    expect(fs.existsSync(path.join(root, '4.8.4', 'marker'))).toBe(true);
  });

  posixOnly('leaves a non-semver entry alone', () => {
    makeDir('4.8.3');
    makeDir('4.8.4');
    makeDir('not-a-version');

    sweep('4.8.4');

    expect(fs.readdirSync(root).sort()).toEqual(['4.8.4', 'not-a-version']);
  });

  posixOnly('leaves an in-flight .staging-*/.previous-* marker alone', () => {
    makeDir('4.8.3');
    makeDir('4.8.4');
    makeDir('.staging-4.8.5-12345');
    makeDir('.previous-4.8.5-12345');

    sweep('4.8.4');

    const remaining = fs.readdirSync(root, { withFileTypes: true })
      .map((e) => e.name)
      .sort();
    expect(remaining).toEqual(['.previous-4.8.5-12345', '.staging-4.8.5-12345', '4.8.4']);
  });

  posixOnly('does nothing, without error, when the cache root does not exist yet', () => {
    const missing = path.join(root, 'does-not-exist');
    expect(() =>
      execFileSync(
        'bash',
        ['-c', `source "${scriptPath}"; sweep_stale_cache_versions "$1" "$2"`, '--', missing, '4.8.4'],
        { env: { ...process.env, MEMESH_UPGRADE_PLUGIN_SOURCE_ONLY: '1' } },
      ),
    ).not.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  posixOnly('is a no-op on an empty cache root', () => {
    sweep('4.8.4');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  posixOnly('keeps a version that happens to equal the only entry present', () => {
    makeDir('4.8.4', true);
    sweep('4.8.4');
    expect(fs.readdirSync(root)).toEqual(['4.8.4']);
    expect(fs.existsSync(path.join(root, '4.8.4', 'marker'))).toBe(true);
  });

  posixOnly('the optional third argument protects a second, non-semver-shaped name too', () => {
    // The registry's own recorded install path — upgrade-plugin.sh's
    // "noncanonical … repairing it" path deliberately leaves this exact
    // directory alone for a human to inspect, whatever it is named.
    makeDir('4.7.9', true);
    makeDir('4.8.3');
    makeDir('4.8.4', true);

    sweep('4.8.4', '4.7.9');

    const remaining = fs.readdirSync(root).sort();
    expect(remaining).toEqual(['4.7.9', '4.8.4']);
    expect(fs.existsSync(path.join(root, '4.7.9', 'marker'))).toBe(true);
  });

  posixOnly('an empty third argument protects nothing extra', () => {
    makeDir('4.8.3');
    makeDir('4.8.4');

    sweep('4.8.4', '');

    expect(fs.readdirSync(root)).toEqual(['4.8.4']);
  });
});
