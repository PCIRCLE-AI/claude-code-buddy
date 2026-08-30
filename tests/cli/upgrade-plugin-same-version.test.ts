/**
 * scripts/upgrade-plugin.sh used to decide "nothing to do" from the version
 * string alone. Claude Code keys its plugin cache by version too, so a cache
 * staged from an earlier commit under the same version was never refreshed by
 * either — on 2026-08-30 that was a "4.8.2" MCP server missing 19 commits,
 * including the repair the release existed for. The script now compares the
 * commit recorded in installed_plugins.json with the marketplace checkout's
 * HEAD. This runs the REAL script against a throwaway HOME holding a real
 * (tiny) git marketplace with its own bare origin, because a bash predicate
 * cannot be unit-tested any other way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'upgrade-plugin.sh');
const posixOnly = it.skipIf(process.platform === 'win32');

let home: string;
let marketplace: string;
let registry: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', HOME: home },
  }).trim();
}

function runScript(envOverride: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, HOME: home, ...envOverride } });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', exitCode: e.status ?? 1 };
  }
}

/**
 * Prepend a shim for one command (`rm` or `mv`) to PATH: it fails once its
 * arguments have matched `failWhenArgsInclude` (a single path the real
 * command would receive) `failOnMatchNumber` times (default 1 — fail every
 * time), and delegates to the real command — found via `command -v` before
 * the shim directory is on PATH, so the shim cannot find itself — for every
 * other invocation, including earlier matches. `failOnMatchNumber: 2` is
 * what makes a genuine forward-then-rollback sequence testable: the section
 * 5 swap and a later rollback both `mv` to the same NEW_INSTALL_PATH
 * destination, so only "fail the SECOND time this destination is seen", not
 * "fail this destination", lets the swap succeed and the rollback fail.
 * This is how upgrade-plugin.sh's failure-recovery paths get exercised for
 * real: no chmod timing games (a chmod applied before the script starts can
 * only block operations that happen to fall after it in the script's own
 * sequence, and rollback_swap runs after several steps that also need
 * filesystem access), no test-only hook added to the shipped script — the
 * shim only ever sees what `rm`/`mv` would have seen anyway.
 */
function shimCommandFailure(
  cmd: 'rm' | 'mv',
  failWhenArgsInclude: string,
  failOnMatchNumber = 1,
): { PATH: string } {
  const realCmd = execFileSync('command', ['-v', cmd], { shell: '/bin/bash', encoding: 'utf8' }).trim();
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), `memesh-shim-${cmd}-`));
  const counterFile = path.join(shimDir, '.count');
  fs.writeFileSync(counterFile, '0');
  const needle = failWhenArgsInclude.replace(/'/g, `'\\''`);
  fs.writeFileSync(
    path.join(shimDir, cmd),
    [
      '#!/usr/bin/env bash',
      'match=0',
      'for a in "$@"; do',
      `  if [ "$a" = '${needle}' ]; then match=1; fi`,
      'done',
      'if [ "$match" = 1 ]; then',
      `  n=$(( $(cat '${counterFile}') + 1 ))`,
      `  echo "$n" > '${counterFile}'`,
      `  if [ "$n" -eq ${failOnMatchNumber} ]; then`,
      `    echo "shimmed ${cmd}: refusing on match #$n of '${needle}'" >&2`,
      '    exit 1',
      '  fi',
      'fi',
      `exec '${realCmd}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

function writeRegistry(entry: Record<string, unknown>): void {
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [entry] } }, null, 4));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-upgrade-sha-'));
  const origin = path.join(home, 'origin.git');
  fs.mkdirSync(origin, { recursive: true });
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  marketplace = path.join(home, '.claude', 'plugins', 'marketplaces', 'pcircle-memesh');
  fs.mkdirSync(marketplace, { recursive: true });
  git(marketplace, 'init', '-q', '-b', 'main');
  git(marketplace, 'remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(marketplace, '.claude-plugin'));
  fs.writeFileSync(path.join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'memesh', version: '4.8.2' }] }));
  fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({ name: 'fake-memesh', version: '4.8.2', private: true }));
  git(marketplace, 'add', '-A');
  git(marketplace, 'commit', '-q', '-m', 'release: prepare v4.8.2');
  git(marketplace, 'push', '-q', '-u', 'origin', 'main');
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'), { recursive: true });
  registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('upgrade-plugin.sh: same version, different commit', () => {
  posixOnly('refreshes the cache in place and records the marketplace commit', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2'), version: '4.8.2', gitCommitSha: bumpSha });
    // A fix lands under the same version — the 4.8.2 shape.
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 1;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: after the bump');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    expect(headSha).not.toBe(bumpSha);

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('refreshing the cache in place');
    expect(r.stdout).not.toContain('nothing to do');
    const staged = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    expect(fs.existsSync(path.join(staged, 'fix.js')), 'the post-bump file reached the cache').toBe(true);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe(headSha);
  });

  posixOnly('still says nothing to do when the commit matches', () => {
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: '/x', version: '4.8.2', gitCommitSha: headSha });
    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('nothing to do');
    expect(r.stdout).toContain(headSha.slice(0, 8));
  });

  posixOnly('a registry with no recorded commit is treated as stale, not current', () => {
    writeRegistry({ installPath: '/x', version: '4.8.2' });
    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('refreshing the cache in place');
    expect(r.stdout).toContain('unknown');
  });

  posixOnly('a failed npm install leaves the live cache and the registry untouched', () => {
    // Same-version refresh targets the directory Claude Code is running from.
    // The staged copy must be built next to it and swapped in only after
    // npm install succeeded; otherwise a failure leaves new code with old deps.
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'the cache Claude Code is running\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({
      name: 'fake-memesh', version: '4.8.2', private: true,
      dependencies: { '@pcircle/this-package-does-not-exist-9f3a': '1.0.0' },
    }));
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: with an uninstallable dependency');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('npm install failed');
    expect(r.stderr).toContain('was not touched');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt')), 'live cache was replaced').toBe(true);
    expect(fs.existsSync(path.join(live, 'package.json')), 'live cache received staged files').toBe(false);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe(bumpSha);
    const leftovers = fs.readdirSync(path.dirname(live)).filter((n) => n.startsWith('.staging-') || n.startsWith('.previous-'));
    expect(leftovers, 'staging directory was not cleaned up').toEqual([]);
  });

  posixOnly('patches the registry entry that lives under this cache root, not entries[0]', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [
      { installPath: path.join(home, 'some-project', '.claude', 'plugins', 'cache', 'memesh', '4.8.2'), version: '4.8.2', scope: 'project', gitCommitSha: 'f'.repeat(40) },
      { installPath: live, version: '4.8.2', scope: 'user', gitCommitSha: bumpSha },
    ] } }, null, 4));
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 2;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: second scope');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8')).plugins['memesh@pcircle-memesh'];
    expect(after[0].gitCommitSha, 'the project-scope entry was rewritten').toBe('f'.repeat(40));
    expect(after[1].gitCommitSha).toBe(headSha);
    expect(after[1].installPath).toBe(live);
  });

  posixOnly('an untracked file in the marketplace checkout never reaches the cache', () => {
    // rsync of the working tree would copy this; git archive of the exact
    // recorded commit must not.
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2'), version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 3;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: committed change');
    git(marketplace, 'push', '-q', 'origin', 'main');
    // Uncommitted, never staged, never pushed — must not appear in the cache.
    fs.writeFileSync(path.join(marketplace, 'UNTRACKED-POISON.js'), 'module.exports = "poison";\n');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    const staged = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    expect(fs.existsSync(path.join(staged, 'fix.js')), 'the committed change reached the cache').toBe(true);
    expect(fs.existsSync(path.join(staged, 'UNTRACKED-POISON.js')), 'an untracked file reached the cache').toBe(false);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha, 'recorded sha matches what was actually staged').toBe(headSha);
  });

  posixOnly('refuses before touching anything when the registry has no memesh entry', () => {
    fs.writeFileSync(registry, JSON.stringify({ plugins: {} }, null, 4));
    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no memesh@pcircle-memesh entry');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    expect(fs.readdirSync(cacheRoot)).toEqual(['4.8.2']); // untouched: only the pre-staged empty dir from beforeEach
  });

  posixOnly('two entries under this cache root are ambiguous, not "pick the first"', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const root = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    writeRegistry({ installPath: path.join(root, '4.8.2'), version: '4.8.2', gitCommitSha: bumpSha });
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    after.plugins['memesh@pcircle-memesh'].push({ installPath: path.join(root, '4.7.9-leftover'), version: '4.7.9', gitCommitSha: 'e'.repeat(40) });
    fs.writeFileSync(registry, JSON.stringify(after, null, 4));
    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('refusing to guess');
  });

  posixOnly('a registry-write failure after the swap restores the previous cache and leaves the registry untouched', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 4;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: forced registry-write failure');
    git(marketplace, 'push', '-q', 'origin', 'main');
    // installed_plugins.json's own permissions don't matter (mv doesn't need
    // them); it's the CONTAINING directory that must allow creating the temp
    // file the write goes through. Strip write+execute there.
    const registryDir = path.dirname(registry);
    fs.chmodSync(registryDir, 0o555);
    try {
      const r = runScript();
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('restored the previous cache; nothing changed');
    } finally {
      fs.chmodSync(registryDir, 0o755);
    }
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt')), 'the previous cache was not restored').toBe(true);
    expect(fs.existsSync(path.join(live, 'fix.js')), 'the failed upgrade left new files behind').toBe(false);
    const after2 = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after2.plugins['memesh@pcircle-memesh'][0].gitCommitSha, 'registry sha changed despite the write failing').toBe(bumpSha);
    const leftovers = fs.readdirSync(path.dirname(live)).filter((n) => n.startsWith('.staging-') || n.startsWith('.previous-') || n.endsWith('.tmp-') || /\.tmp-\d+$/.test(n));
    expect(leftovers, 'staging or previous-cache leftovers after rollback').toEqual([]);
    const registryLeftovers = fs.readdirSync(registryDir).filter((n) => n.includes('.tmp-'));
    expect(registryLeftovers, 'registry temp file leftover after rollback').toEqual([]);
  });

  posixOnly('when a concurrent process replaces the original entry with a lone unrelated one mid-run, the write refuses instead of adopting it', () => {
    // The actual TOCTOU: section 2 resolves and records ORIGINAL_INSTALL_PATH
    // BEFORE npm install runs; if the registry changes while npm install is
    // in flight and exactly one OTHER entry (different scope, unrelated
    // record) happens to remain, section 6 must not silently adopt it — it
    // was never part of this upgrade. `npm install` runs the staged
    // package's own `postinstall` life-cycle script by default, which is the
    // one point in this script where injected code genuinely runs mid-flow —
    // used here, not to fail the install, but to perform the concurrent
    // mutation a real second process would.
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    const mutateRegistry = [
      'const fs=require("fs");',
      `fs.writeFileSync(${JSON.stringify(registry)}, JSON.stringify({plugins:{"memesh@pcircle-memesh":[{installPath:"/some/unrelated/scope/4.8.2",version:"4.8.2",gitCommitSha:"${'d'.repeat(40)}"}]}}, null, 4));`,
    ].join('');
    fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({
      name: 'fake-memesh', version: '4.8.2', private: true,
      scripts: { postinstall: `node -e ${JSON.stringify(mutateRegistry)}` },
    }));
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: entry replaced mid-upgrade');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('registry changed since this upgrade started');
    // Proof the mutation actually ran (not a no-op postinstall failing silently):
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].installPath, 'the unrelated entry was rewritten instead of being left alone').toBe('/some/unrelated/scope/4.8.2');
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe('d'.repeat(40));
  });

  posixOnly('several entries under this cache root are refused as "several", not misreported as "none"', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const root = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    writeRegistry({ installPath: path.join(root, '4.8.2'), version: '4.8.2', gitCommitSha: bumpSha });
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    after.plugins['memesh@pcircle-memesh'].push({ installPath: path.join(root, '4.7.9-leftover'), version: '4.7.9', gitCommitSha: 'e'.repeat(40) });
    fs.writeFileSync(registry, JSON.stringify(after, null, 4));
    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('several memesh entries under');
    expect(r.stderr, 'wrongly claimed none of them lives under the cache root when two of them do').not.toContain('none of them lives under');
  });

  posixOnly('a fresh install (no previous cache) whose rollback cleanup itself fails is reported as failed, not "nothing changed"', () => {
    // rollback_swap's early `rm -rf "$NEW_INSTALL_PATH"` used to run
    // unchecked; when there is no PREVIOUS_PATH to restore (a genuine
    // version bump, not a same-version refresh — nothing pre-existed at the
    // new version's path), the function returned success regardless of
    // whether that removal actually worked.
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    fs.rmSync(path.join(cacheRoot, '4.8.2'), { recursive: true, force: true }); // beforeEach pre-creates it; this test needs it absent
    writeRegistry({ installPath: path.join(cacheRoot, '4.7.9'), version: '4.7.9', gitCommitSha: 'f'.repeat(40) });
    const registryDir = path.dirname(registry);
    fs.chmodSync(registryDir, 0o555); // forces the registry write in section 6 to fail
    const shim = shimCommandFailure('rm', path.join(cacheRoot, '4.8.2'));
    try {
      const r = runScript(shim);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('restoring the previous cache also failed');
      expect(r.stderr).toContain('may now be MISSING');
    } finally {
      fs.chmodSync(registryDir, 0o755);
    }
  });

  posixOnly('when the swap succeeds but the registry write AND the restore both fail, the error says so and the live install is left missing, not silently wrong', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 7;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: double failure via shim');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const registryDir = path.dirname(registry);
    fs.chmodSync(registryDir, 0o555); // registry write fails
    // Three `mv` calls touch `live` in order: (1) section 5 moving the live
    // cache aside to PREVIOUS_PATH — source arg; (2) section 5's forward
    // swap, STAGE_PATH -> live — destination arg; (3) rollback_swap's
    // restore, PREVIOUS_PATH -> live — destination arg. Let the first two
    // (the real, successful upgrade swap) through; fail only the third
    // (the rollback this test is about).
    const shim = shimCommandFailure('mv', live, 3);
    try {
      const r = runScript(shim);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('restoring the previous cache also failed');
      expect(r.stderr).toContain('may now be MISSING');
      expect(r.stderr).toMatch(/mv ".*\.previous-.*" ".*4\.8\.2"/);
    } finally {
      fs.chmodSync(registryDir, 0o755);
    }
    expect(fs.existsSync(live), 'the live install should be missing, not silently left in some other state').toBe(false);
    const leftovers = fs.readdirSync(path.dirname(live)).filter((n) => n.startsWith('.previous-'));
    expect(leftovers.length, 'the previous cache must still be on disk for the manual recovery command to work').toBe(1);
    expect(fs.existsSync(path.join(path.dirname(live), leftovers[0], 'LIVE-MARKER.txt')), 'the previous cache itself was corrupted, not just left in place').toBe(true);
  });
});
