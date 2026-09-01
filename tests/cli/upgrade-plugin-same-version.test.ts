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
import { execFileSync, spawn, spawnSync } from 'child_process';
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
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...envOverride },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

function runScriptWithoutHome(): { stdout: string; stderr: string; exitCode: number } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

/**
 * Prepend a shim for one command (`rm`, `mv`, or `mkdir`) to PATH: it fails once its
 * arguments contain `failWhenArgsInclude` (a path or distinctive path
 * fragment the real command would receive) `failOnMatchNumber` times (default 1 — fail every
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
  cmd: 'rm' | 'mv' | 'mkdir',
  failWhenArgsInclude: string,
  failOnMatchNumber = 1,
): { PATH: string } {
  // Avoid Node's DEP0190 by resolving without a shell.
  const realCmd = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
  // Keep shims inside the fixture root so afterEach owns their cleanup.
  const shimDir = fs.mkdtempSync(path.join(home, `.shim-${cmd}-`));
  const counterFile = path.join(shimDir, '.count');
  fs.writeFileSync(counterFile, '0');
  const needle = failWhenArgsInclude.replace(/'/g, `'\\''`);
  fs.writeFileSync(
    path.join(shimDir, cmd),
    [
      '#!/usr/bin/env bash',
      'match=0',
      'for a in "$@"; do',
      `  case "$a" in *'${needle}'*) match=1 ;; esac`,
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

/**
 * Run one real command successfully, then signal its waiting parent before
 * returning. This places the signal after the filesystem mutation itself,
 * which makes the remove-then-restore rollback gap reproducible.
 */
function shimSignalParentAfterSuccess(
  cmd: 'rm' | 'mv',
  whenArgsInclude: string,
  signal: 'INT' | 'TERM' | 'HUP',
): { PATH: string } {
  const realCmd = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
  const shimDir = fs.mkdtempSync(path.join(home, `.shim-${cmd}-signal-`));
  const needle = whenArgsInclude.replace(/'/g, `'\\''`);
  fs.writeFileSync(path.join(shimDir, cmd), [
    '#!/usr/bin/env bash',
    'match=0',
    'for a in "$@"; do',
    `  case "$a" in *'${needle}'*) match=1 ;; esac`,
    'done',
    `'${realCmd}' "$@"`,
    'status=$?',
    'if [ "$status" = 0 ] && [ "$match" = 1 ]; then',
    `  kill -${signal} "$PPID"`,
    '  sleep 0.05',
    'fi',
    'exit "$status"',
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

/** Pause after moving the live cache aside, so a real signal can hit the swap window. */
function shimMovePauseAfterSuccess(sourcePath: string, markerPath: string): { PATH: string } {
  const realMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
  const shimDir = fs.mkdtempSync(path.join(home, '.shim-mv-pause-'));
  const quotedSource = sourcePath.replace(/'/g, `'\\\\''`);
  const quotedMarker = markerPath.replace(/'/g, `'\\\\''`);
  const quotedMv = realMv.replace(/'/g, `'\\\\''`);
  fs.writeFileSync(path.join(shimDir, 'mv'), [
    '#!/usr/bin/env bash',
    `'${quotedMv}' "$@"`,
    'status=$?',
    `if [ "$status" = 0 ] && [ "$1" = '${quotedSource}' ]; then`,
    `  : > '${quotedMarker}'`,
    '  while :; do sleep 1; done',
    'fi',
    'exit "$status"',
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

/** Make only the marketplace HEAD read return an invalid identifier. */
function shimInvalidMarketplaceSha(): { PATH: string } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = fs.mkdtempSync(path.join(home, '.shim-git-sha-'));
  const quotedGit = realGit.replace(/'/g, `'\\\\''`);
  const quotedMarketplace = marketplace.replace(/'/g, `'\\\\''`);
  fs.writeFileSync(path.join(shimDir, 'git'), [
    '#!/usr/bin/env bash',
    `if [ "$1" = -C ] && [ "$2" = '${quotedMarketplace}' ] && [ "$3" = rev-parse ] && [ "$4" = HEAD ]; then`,
    '  echo not-a-full-commit',
    '  exit 0',
    'fi',
    `exec '${quotedGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

/** Pause after preflight but before the registry's first O_NOFOLLOW read. */
function shimPauseBeforeMarketplaceHead(markerPath: string, releasePath: string): { PATH: string } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = fs.mkdtempSync(path.join(home, '.shim-git-pause-'));
  const quote = (value: string) => value.replace(/'/g, `'\\''`);
  fs.writeFileSync(path.join(shimDir, 'git'), [
    '#!/usr/bin/env bash',
    `if [ "$1" = -C ] && [ "$2" = '${quote(marketplace)}' ] && [ "$3" = rev-parse ] && [ "$4" = HEAD ]; then`,
    `  : > '${quote(markerPath)}'`,
    `  while [ ! -f '${quote(releasePath)}' ]; do sleep 0.05; done`,
    'fi',
    `exec '${quote(realGit)}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

/**
 * Reproduce the old section-6 attack: a PATH wrapper keeps its PID across
 * `exec node`, so it can plant installed_plugins.json.tmp-<node-pid> as a
 * symlink immediately before the registry writer starts.
 */
function shimLegacyRegistryTempSymlink(targetPath: string, markerPath: string): { PATH: string } {
  const realNode = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  const shimDir = fs.mkdtempSync(path.join(home, '.shim-node-registry-temp-'));
  const quote = (value: string) => value.replace(/'/g, `'\\''`);
  fs.writeFileSync(path.join(shimDir, 'node'), [
    '#!/usr/bin/env bash',
    'if [ -n "${ORIGINAL_REGISTRY_SHA256:-}" ]; then',
    '  legacy_temp="$INSTALL_REGISTRY.tmp-$$"',
    `  ln -s '${quote(targetPath)}' "$legacy_temp"`,
    `  printf '%s\\n' "$legacy_temp" > '${quote(markerPath)}'`,
    'fi',
    `exec '${quote(realNode)}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${shimDir}:${process.env.PATH}` };
}

function pathContainingOnly(tools: string[]): string {
  const shimDir = fs.mkdtempSync(path.join(home, '.shim-path-'));
  for (const tool of tools) {
    fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(shimDir, tool));
  }
  return shimDir;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

describe('upgrade-plugin.sh: config-root preflight', () => {
  posixOnly('fails cleanly instead of guessing /.claude when HOME and CLAUDE_CONFIG_DIR are unset', () => {
    const r = runScriptWithoutHome();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('neither CLAUDE_CONFIG_DIR nor HOME is set');
    expect(r.stderr).toContain('Set CLAUDE_CONFIG_DIR');
    expect(r.stderr).not.toContain('/.claude/plugins');
    expect(r.stderr, 'a shell or Node stack frame reached the user').not.toMatch(/unbound variable|\n\s+at\s/);
  });
});

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
    writeRegistry({ installPath: path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2'), version: '4.8.2', gitCommitSha: headSha });
    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('nothing to do');
    expect(r.stdout).toContain(headSha.slice(0, 8));
  });

  posixOnly('honors CLAUDE_CONFIG_DIR for a relocated Claude Code install', () => {
    const relocated = path.join(home, 'relocated-claude-config');
    fs.renameSync(path.join(home, '.claude'), relocated);
    marketplace = path.join(relocated, 'plugins', 'marketplaces', 'pcircle-memesh');
    registry = path.join(relocated, 'plugins', 'installed_plugins.json');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({
      installPath: path.join(relocated, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'),
      version: '4.8.2',
      gitCommitSha: headSha,
    });

    const r = runScript({ CLAUDE_CONFIG_DIR: relocated });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('nothing to do');
    expect(r.stderr).not.toContain(path.join(home, '.claude'));
  });

  posixOnly('repairs a missing canonical cache even when version and commit match', () => {
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });
    fs.rmSync(live, { recursive: true, force: true });

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('path is missing or not a real directory');
    expect(r.stdout).not.toContain('nothing to do');
    expect(fs.existsSync(path.join(live, 'package.json'))).toBe(true);
  });

  posixOnly('repairs a matching record whose installPath names a different version directory', () => {
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    const root = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(root, '4.8.2');
    const recorded = path.join(root, '4.7.9');
    fs.mkdirSync(recorded);
    fs.writeFileSync(path.join(recorded, 'OLD-MARKER.txt'), 'do not delete an unrelated cache\n');
    writeRegistry({ installPath: recorded, version: '4.8.2', gitCommitSha: headSha });

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('noncanonical cache path');
    expect(r.stdout).not.toContain('nothing to do');
    expect(fs.existsSync(path.join(live, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(recorded, 'OLD-MARKER.txt'))).toBe(true);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].installPath).toBe(live);
  });

  posixOnly('replaces a dangling canonical cache symlink instead of treating it as absent', () => {
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });
    fs.rmSync(live, { recursive: true, force: true });
    fs.symlinkSync(path.join(home, 'missing-plugin-cache-target'), live);

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('nothing to do');
    expect(fs.lstatSync(live).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(live, 'package.json'))).toBe(true);
  });

  posixOnly('a registry with no recorded commit is treated as stale, not current', () => {
    writeRegistry({ installPath: path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2'), version: '4.8.2' });
    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('refreshing the cache in place');
    expect(r.stdout).toContain('unknown');
  });

  posixOnly('upgrades the sole legacy registry entry even when it has no installPath yet', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 9;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: legacy registry entry');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    expect(fs.existsSync(path.join(live, 'fix.js'))).toBe(true);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8')).plugins['memesh@pcircle-memesh'][0];
    expect(after.installPath).toBe(live);
    expect(after.gitCommitSha).toBe(headSha);
  });

  posixOnly('refuses a sole registry entry that names a cache outside this user cache root', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const foreign = path.join(home, 'some-project', '.claude', 'plugins', 'cache', 'memesh', '4.8.2');
    writeRegistry({ installPath: foreign, version: '4.8.2', scope: 'project', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 10;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: foreign-scope refusal fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const registryBefore = fs.readFileSync(registry, 'utf8');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/only memesh entry.*outside.*refusing to guess/i);
    expect(fs.readFileSync(registry, 'utf8')).toBe(registryBefore);
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    expect(fs.readdirSync(cacheRoot)).toEqual(['4.8.2']);
  });

  posixOnly('rejects a path-traversal marketplace version before deriving cache paths', () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'must survive an unsafe manifest\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });

    fs.writeFileSync(
      path.join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'memesh', version: '..' }] }),
    );
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'test: unsafe traversal version');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const registryBefore = fs.readFileSync(registry, 'utf8');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('unsafe version string');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.readFileSync(registry, 'utf8')).toBe(registryBefore);
    expect(fs.readdirSync(path.dirname(live)).some(name => name.startsWith('.staging-') || name.startsWith('.previous-'))).toBe(false);
  });

  posixOnly('rejects a numeric prerelease identifier with a leading zero before creating a cache directory', () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'must survive an invalid semver\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });
    fs.writeFileSync(
      path.join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'memesh', version: '4.8.2-01' }] }),
    );
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'test: invalid numeric prerelease');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const registryBefore = fs.readFileSync(registry, 'utf8');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('unsafe version string: 4.8.2-01');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(live), '4.8.2-01'))).toBe(false);
    expect(fs.readFileSync(registry, 'utf8')).toBe(registryBefore);
  });

  posixOnly('refuses an invalid marketplace commit before staging or registry mutation', () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'must survive an invalid commit id\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });
    const registryBefore = fs.readFileSync(registry, 'utf8');

    const r = runScript(shimInvalidMarketplaceSha());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not a full 40-hex commit');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.readFileSync(registry, 'utf8')).toBe(registryBefore);
    expect(fs.readdirSync(path.dirname(live)).some(name => name.startsWith('.staging-') || name.startsWith('.previous-'))).toBe(false);
  });

  posixOnly('refuses before the lock when tar is unavailable', () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'must survive a missing prerequisite\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });

    const r = runScript({ PATH: pathContainingOnly(['bash', 'node', 'npm', 'git']) });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('tar is not on PATH');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.existsSync(`${path.dirname(live)}.lock`)).toBe(false);
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
      description: 'candidate that must be staged before npm fails',
    }));
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: staged install failure fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');

    // Fail locally and immediately. Depending on a registry lookup for a
    // deliberately nonexistent package made this test take the network's
    // timeout path and exceed Vitest's 30s limit on degraded runners.
    const shimDir = fs.mkdtempSync(path.join(home, '.shim-npm-'));
    fs.writeFileSync(path.join(shimDir, 'npm'), '#!/usr/bin/env bash\nexit 42\n', { mode: 0o755 });
    const r = runScript({ PATH: `${shimDir}:${process.env.PATH}` });
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

  posixOnly('a staging-directory creation failure stops before touching the live cache', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 14;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: staging mkdir failure fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const registryBefore = fs.readFileSync(registry, 'utf8');

    const r = runScript(shimCommandFailure('mkdir', '.staging-4.8.2-'));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('could not create the staging directory');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.readFileSync(registry, 'utf8')).toBe(registryBefore);
  });

  posixOnly('a development-file pruning failure stops before touching the live cache', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.mkdirSync(path.join(marketplace, 'tests'));
    fs.writeFileSync(path.join(marketplace, 'tests', 'fixture.txt'), 'must be pruned\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: staging prune failure fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const registryBefore = fs.readFileSync(registry, 'utf8');

    const r = runScript(shimCommandFailure('rm', '/tests'));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('could not remove development-only files');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.readFileSync(registry, 'utf8')).toBe(registryBefore);
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

  posixOnly('reads the target version from the exact archived commit, not a dirty tracked manifest', () => {
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const oldLive = path.join(cacheRoot, '4.8.1');
    fs.rmSync(path.join(cacheRoot, '4.8.2'), { recursive: true, force: true });
    fs.mkdirSync(oldLive, { recursive: true });
    fs.writeFileSync(path.join(oldLive, 'LIVE-MARKER.txt'), 'old cache\n');
    writeRegistry({ installPath: oldLive, version: '4.8.1', gitCommitSha: 'a'.repeat(40) });
    const headSha = git(marketplace, 'rev-parse', 'HEAD');

    const manifest = path.join(marketplace, '.claude-plugin', 'marketplace.json');
    fs.writeFileSync(manifest, JSON.stringify({ plugins: [{ name: 'memesh', version: '9.9.9' }] }));

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    const committedInstall = path.join(cacheRoot, '4.8.2');
    expect(fs.existsSync(path.join(committedInstall, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheRoot, '9.9.9')), 'dirty manifest redirected the install path').toBe(false);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8')).plugins['memesh@pcircle-memesh'][0];
    expect(after.version).toBe('4.8.2');
    expect(after.installPath).toBe(committedInstall);
    expect(after.gitCommitSha).toBe(headSha);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).plugins[0].version).toBe('9.9.9');
  });

  posixOnly('refuses before touching anything when the registry has no memesh entry', () => {
    fs.writeFileSync(registry, JSON.stringify({ plugins: {} }, null, 4));
    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no memesh@pcircle-memesh entry');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    expect(fs.readdirSync(cacheRoot)).toEqual(['4.8.2']); // untouched: only the pre-staged empty dir from beforeEach
  });

  posixOnly('refuses a malformed registry entry before touching the cache', () => {
    fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [null] } }, null, 4));
    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('malformed memesh@pcircle-memesh entry');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    expect(fs.readdirSync(cacheRoot)).toEqual(['4.8.2']);
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
      expect(r.stderr).toContain('failed to update installed_plugins.json');
      expect(r.stderr).toContain('Rollback succeeded: restored the previous cache');
      expect(r.stderr, 'a successful rollback should not print a restore-failed message').not.toContain('could not restore the previous cache');
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

  posixOnly('a second signal after broken-cache removal cannot interrupt restoration', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(cacheRoot, '4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 15;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: signal during rollback fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const registryDir = path.dirname(registry);
    fs.chmodSync(registryDir, 0o555);
    try {
      const r = runScript(shimSignalParentAfterSuccess('rm', live, 'INT'));
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('failed to update installed_plugins.json');
      expect(r.stderr).toContain('Rollback succeeded: restored the previous cache');
    } finally {
      fs.chmodSync(registryDir, 0o755);
    }
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt')), 'the signal stranded the previous cache').toBe(true);
    expect(fs.existsSync(path.join(live, 'fix.js')), 'the failed candidate remained live').toBe(false);
    expect(fs.readdirSync(cacheRoot).filter((name) => name.startsWith('.previous-'))).toEqual([]);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe(bumpSha);
  });

  posixOnly('preserves installed_plugins.json permission bits across the atomic rewrite', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.chmodSync(registry, 0o600);
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 11;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: permission-preservation fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(fs.statSync(registry).mode & 0o777).toBe(0o600);
  });

  posixOnly('ignores a precreated legacy PID-temp symlink and writes the registry through its own private temp', () => {
    const oldSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    const sentinel = path.join(home, 'outside-registry-sentinel');
    const marker = path.join(home, 'legacy-registry-temp-path');
    const sentinelBefore = 'outside data must not change\n';
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: oldSha });
    fs.writeFileSync(sentinel, sentinelBefore);
    fs.writeFileSync(path.join(marketplace, 'secure-fix.js'), 'module.exports = 16;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: secure registry temp fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const newSha = git(marketplace, 'rev-parse', 'HEAD');

    const r = runScript(shimLegacyRegistryTempSymlink(sentinel, marker));
    expect(r.exitCode, r.stderr).toBe(0);
    expect(fs.existsSync(marker), 'the attack wrapper never reached the registry writer').toBe(true);
    const legacyTemp = fs.readFileSync(marker, 'utf8').trim();
    expect(fs.lstatSync(legacyTemp).isSymbolicLink(), 'the old predictable temp symlink was not planted').toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8'), 'the registry writer followed the attacker symlink').toBe(sentinelBefore);
    const registryFd = fs.openSync(registry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(registryFd).isFile(), 'installed_plugins.json is no longer a regular file').toBe(true);
      const entry = JSON.parse(fs.readFileSync(registryFd, 'utf8')).plugins['memesh@pcircle-memesh'][0];
      expect(entry).toMatchObject({ installPath: live, version: '4.8.2', gitCommitSha: newSha });
    } finally {
      fs.closeSync(registryFd);
    }
    expect(fs.existsSync(path.join(live, 'secure-fix.js')), 'the reported upgrade did not install the committed cache').toBe(true);
    expect(r.stdout).toContain(`MeMesh upgraded: 4.8.2 (${oldSha.slice(0, 8)}) -> 4.8.2 (${newSha.slice(0, 8)})`);
    expect(r.stderr).not.toContain('failed to update installed_plugins.json');
    const ownedTemps = fs.readdirSync(path.dirname(registry)).filter(name => name.startsWith('.installed_plugins.json.tmp-'));
    expect(ownedTemps, 'the registry writer left its private temporary directory behind').toEqual([]);
  });

  posixOnly('refuses a symlinked installed_plugins.json instead of replacing the host-owned link', () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
    const target = path.join(home, 'host-owned-installed-plugins.json');
    fs.renameSync(registry, target);
    fs.symlinkSync(target, registry);
    const targetBefore = fs.readFileSync(target, 'utf8');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/installed_plugins\.json is a symlink.*refusing/i);
    expect(fs.lstatSync(registry).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(targetBefore);
    expect(fs.existsSync(`${path.dirname(live)}.lock`)).toBe(false);
  });

  posixOnly('refuses a symlink swap after preflight without exposing a Node stack', async () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    const target = path.join(home, 'host-owned-installed-plugins.json');
    const marker = path.join(home, 'before-marketplace-head');
    const release = path.join(home, 'continue-marketplace-head');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
    const targetBefore = fs.readFileSync(registry, 'utf8');

    const output = { stdout: '', stderr: '' };
    const child = spawn('bash', [SCRIPT], {
      env: { ...process.env, HOME: home, ...shimPauseBeforeMarketplaceHead(marker, release) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output.stderr += chunk.toString(); });
    const completed = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      await waitForFile(marker);
      fs.renameSync(registry, target);
      fs.symlinkSync(target, registry);
      fs.writeFileSync(release, 'continue\n');
      expect(await completed, output.stderr).not.toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    expect(output.stderr).toContain('changed file identity while this upgrade was reading it');
    expect(output.stderr, 'the safe refusal leaked an internal Node stack').not.toMatch(/\n\s+at\s/);
    expect(fs.lstatSync(registry).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(targetBefore);
    expect(fs.existsSync(`${path.dirname(live)}.lock`)).toBe(false);
  });

  posixOnly('refuses a same-content symlink swap during install and restores the previous cache', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(cacheRoot, '4.8.2');
    const target = path.join(home, 'host-owned-installed-plugins.json');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    const registryBefore = fs.readFileSync(registry, 'utf8');
    const swapRegistryPath = [
      'const fs=require("fs");',
      `fs.renameSync(${JSON.stringify(registry)},${JSON.stringify(target)});`,
      `fs.symlinkSync(${JSON.stringify(target)},${JSON.stringify(registry)});`,
    ].join('');
    fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({
      name: 'fake-memesh', version: '4.8.2', private: true,
      scripts: { postinstall: `node -e ${JSON.stringify(swapRegistryPath)}` },
    }));
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 14;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: registry identity race fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('registry file identity changed since this upgrade started');
    expect(fs.lstatSync(registry).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(registryBefore);
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt')), 'the previous cache was not restored').toBe(true);
    expect(fs.existsSync(path.join(live, 'fix.js')), 'the rejected candidate remained live').toBe(false);
    expect(fs.readdirSync(cacheRoot).filter(name => name.startsWith('.staging-') || name.startsWith('.previous-'))).toEqual([]);
    expect(fs.existsSync(`${cacheRoot}.lock`)).toBe(false);
  });

  posixOnly('SIGINT after the live cache moves aside restores it before exit', async () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(cacheRoot, '4.8.2');
    const marker = path.join(home, 'live-moved-aside');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 13;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: signal rollback fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const output = { stdout: '', stderr: '' };
    const child = spawn('bash', [SCRIPT], {
      detached: true,
      env: { ...process.env, HOME: home, ...shimMovePauseAfterSuccess(live, marker) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output.stderr += chunk.toString(); });
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      await waitForFile(marker);
      process.kill(-(child.pid as number), 'SIGINT');
      const result = await completed;
      expect(result.code, `signal=${result.signal}; stderr=${output.stderr}`).toBe(130);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }

    expect(output.stderr).toContain('interrupted during the cache swap');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt')), 'the previous live cache was not restored').toBe(true);
    expect(fs.existsSync(path.join(live, 'fix.js')), 'the interrupted candidate was left live').toBe(false);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe(bumpSha);
    expect(fs.readdirSync(cacheRoot).filter((name) => name.startsWith('.staging-') || name.startsWith('.previous-'))).toEqual([]);
    expect(fs.existsSync(`${cacheRoot}.lock`), 'the signal path left the lock behind').toBe(false);
  });

  posixOnly('a registry addition during install is refused instead of overwriting host state', () => {
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ scope: 'target', installPath: live, version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
    const foreignPath = '/another/plugin/scope/4.7.9';
    const foreign = {
      scope: 'foreign',
      installPath: foreignPath,
      version: '4.7.9',
      gitCommitSha: 'f'.repeat(40),
    };

    const mutateRegistry = [
      'const fs=require("fs");',
      `const p=${JSON.stringify(registry)};`,
      'const j=JSON.parse(fs.readFileSync(p,"utf8"));',
      `j.plugins["memesh@pcircle-memesh"].unshift(${JSON.stringify(foreign)});`,
      'fs.writeFileSync(p,JSON.stringify(j,null,4));',
    ].join('');
    fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({
      name: 'fake-memesh', version: '4.8.2', private: true,
      scripts: { postinstall: `node -e ${JSON.stringify(mutateRegistry)}` },
    }));
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: registry addition during install');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('registry changed since this upgrade started');

    const entries = JSON.parse(fs.readFileSync(registry, 'utf8')).plugins['memesh@pcircle-memesh'];
    const foreignAfter = entries.find((entry: { scope?: string }) => entry.scope === 'foreign');
    const targetAfter = entries.find((entry: { scope?: string }) => entry.scope === 'target');
    expect(foreignAfter).toMatchObject(foreign);
    expect(targetAfter, 'the original entry was rewritten despite concurrent host state').toMatchObject({
      scope: 'target',
      installPath: live,
      version: '4.8.2',
      gitCommitSha: 'a'.repeat(40),
    });
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

  posixOnly('several entries outside this cache root are refused as none matching', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: '/another/scope/4.8.2', version: '4.8.2', gitCommitSha: bumpSha });
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    after.plugins['memesh@pcircle-memesh'].push({
      installPath: '/yet/another/scope/4.7.9',
      version: '4.7.9',
      gitCommitSha: 'e'.repeat(40),
    });
    fs.writeFileSync(registry, JSON.stringify(after, null, 4));

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('none of them lives under');
    expect(r.stderr).not.toContain('several memesh entries under');
  });

  posixOnly('a fresh install (no previous cache) whose rollback cleanup itself fails names the orphaned cache, not a nonexistent previous one', () => {
    // A fresh version has no previous path, so recovery must name the orphan
    // that actually remains instead of inventing a restore command.
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    fs.rmSync(path.join(cacheRoot, '4.8.2'), { recursive: true, force: true }); // beforeEach pre-creates it; this test needs it absent
    writeRegistry({ installPath: path.join(cacheRoot, '4.7.9'), version: '4.7.9', gitCommitSha: 'f'.repeat(40) });
    const registryDir = path.dirname(registry);
    fs.chmodSync(registryDir, 0o555); // forces the registry write in section 6 to fail
    const shim = shimCommandFailure('rm', path.join(cacheRoot, '4.8.2'));
    try {
      const r = runScript(shim);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('could not remove the broken cache');
      expect(r.stderr).toContain('orphaned');
      expect(r.stderr).toContain(`rm -rf "${path.join(cacheRoot, '4.8.2')}"`);
      expect(r.stderr, 'named a previous cache that never existed for this fresh-install case').not.toContain('previous cache');
    } finally {
      fs.chmodSync(registryDir, 0o755);
    }
    // Verify the filesystem and registry postconditions, not only prose.
    expect(fs.existsSync(path.join(cacheRoot, '4.8.2')), 'the orphaned cache should still be on disk, matching what the message says').toBe(true);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].version, 'the registry should still name the old version').toBe('4.7.9');
  });

  posixOnly('a lock already held by another run refuses instead of racing', () => {
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const lockDir = `${cacheRoot}.lock`;
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: path.join(cacheRoot, '4.8.2'), version: '4.8.2', gitCommitSha: headSha });
    fs.mkdirSync(lockDir);
    try {
      const r = runScript();
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('could not acquire the upgrade lock');
      expect(r.stderr).toContain(lockDir);
      expect(r.stderr).toContain(`rmdir "${lockDir}"`);
    } finally {
      fs.rmdirSync(lockDir);
    }
    // Nothing should have mutated after the lock refusal.
    expect(fs.readdirSync(cacheRoot)).toEqual(['4.8.2']); // only beforeEach's pre-staged empty dir
  });

  posixOnly('a missing lock parent is reported as a filesystem problem, not another running upgrade', () => {
    const cacheParent = path.join(home, '.claude/plugins/cache/pcircle-memesh');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: path.join(cacheParent, 'memesh', '4.8.2'), version: '4.8.2', gitCommitSha: headSha });
    fs.rmSync(cacheParent, { recursive: true, force: true });

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('could not create the upgrade lock');
    expect(r.stderr).toContain(cacheParent);
    expect(r.stderr).not.toContain('another upgrade may be running');
  });

  posixOnly('a detached marketplace checkout is refused with a truthful diagnosis', () => {
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: path.join(cacheRoot, '4.8.2'), version: '4.8.2', gitCommitSha: headSha });
    git(marketplace, 'checkout', '--detach', '-q');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/marketplace.*detached HEAD/i);
    expect(r.stderr).not.toContain('local commits');
    expect(fs.existsSync(`${cacheRoot}.lock`), 'the lock was not released after the detached-HEAD refusal').toBe(false);
  });

  posixOnly('a dirty worktree blocking fast-forward is not misdiagnosed as local commits', () => {
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(cacheRoot, '4.8.2');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: headSha });
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');

    const writer = path.join(home, 'remote-writer');
    git(home, 'clone', '-q', path.join(home, 'origin.git'), writer);
    fs.writeFileSync(path.join(writer, 'package.json'), JSON.stringify({ name: 'fake-memesh', version: '4.8.2', private: true, remote: true }));
    git(writer, 'add', 'package.json');
    git(writer, 'commit', '-q', '-m', 'fix: remote package change');
    git(writer, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({ name: 'fake-memesh', version: '4.8.2', private: true, local: true }));

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('fast-forward failed');
    expect(r.stderr).not.toContain('local commits');
    expect(r.stderr).not.toContain('reset --hard');
    expect(fs.readFileSync(path.join(marketplace, 'package.json'), 'utf8')).toContain('"local":true');
    expect(fs.existsSync(path.join(live, 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.existsSync(`${cacheRoot}.lock`), 'the merge failure left the lock behind').toBe(false);
  });

  posixOnly('releases the lock on both success and failure, so a later run is not blocked', () => {
    const headSha = git(marketplace, 'rev-parse', 'HEAD');
    writeRegistry({ installPath: path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2'), version: '4.8.2', gitCommitSha: headSha });
    const r = runScript();
    expect(r.exitCode, r.stderr).toBe(0); // "nothing to do" path — still must release the lock
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    expect(fs.existsSync(`${cacheRoot}.lock`), 'the lock directory was left behind').toBe(false);
  });

  posixOnly('a failed broken-cache removal keeps the previous cache beside it instead of nesting it', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(cacheRoot, '4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 8;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: rollback removal failure');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const registryDir = path.dirname(registry);
    fs.chmodSync(registryDir, 0o555);
    const shim = shimCommandFailure('rm', live);
    try {
      const r = runScript(shim);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(`could not remove the broken cache at ${live}`);
      expect(r.stderr).toContain('previous cache is still intact at');
      expect(r.stderr).toContain(`rm -rf "${live}"`);
      expect(r.stderr).toMatch(/mv ".*\.previous-.*" ".*4\.8\.2"/);
    } finally {
      fs.chmodSync(registryDir, 0o755);
    }

    const previous = fs.readdirSync(cacheRoot).filter((name) => name.startsWith('.previous-4.8.2-'));
    expect(previous).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheRoot, previous[0], 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.existsSync(path.join(live, previous[0])), 'the previous cache was nested below the broken live directory').toBe(false);
    expect(fs.existsSync(path.join(live, 'fix.js')), 'the broken candidate should remain where the recovery message says it is').toBe(true);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe(bumpSha);
  });

  posixOnly('a previous-cache cleanup failure warns after a successful upgrade and names the leftover', () => {
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const cacheRoot = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh');
    const live = path.join(cacheRoot, '4.8.2');
    fs.writeFileSync(path.join(live, 'LIVE-MARKER.txt'), 'previous cache contents\n');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha });
    fs.writeFileSync(path.join(marketplace, 'fix.js'), 'module.exports = 12;\n');
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: successful-cleanup warning fixture');
    git(marketplace, 'push', '-q', 'origin', 'main');
    const headSha = git(marketplace, 'rev-parse', 'HEAD');

    const r = runScript(shimCommandFailure('rm', '.previous-4.8.2-'));
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WARNING: upgrade succeeded.*previous cache/i);
    expect(r.stderr).toMatch(/rm -rf ".*\.previous-4\.8\.2-/);
    const previous = fs.readdirSync(cacheRoot).filter(name => name.startsWith('.previous-4.8.2-'));
    expect(previous).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheRoot, previous[0], 'LIVE-MARKER.txt'))).toBe(true);
    expect(fs.existsSync(path.join(live, 'fix.js'))).toBe(true);
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha).toBe(headSha);
  });

  posixOnly('a field other than installPath changing on the target entry is caught too, not just the entry vanishing', () => {
    // installPath alone is not enough identity: preserve any concurrent
    // change to another field on the same entry.
    const bumpSha = git(marketplace, 'rev-parse', 'HEAD');
    const live = path.join(home, '.claude/plugins/cache/pcircle-memesh/memesh/4.8.2');
    writeRegistry({ installPath: live, version: '4.8.2', gitCommitSha: bumpSha, note: 'original' });
    const mutateRegistry = [
      'const fs=require("fs");',
      `const j=JSON.parse(fs.readFileSync(${JSON.stringify(registry)},"utf8"));`,
      'j.plugins["memesh@pcircle-memesh"][0].note="mutated-mid-run";',
      `fs.writeFileSync(${JSON.stringify(registry)}, JSON.stringify(j, null, 4));`,
    ].join('');
    fs.writeFileSync(path.join(marketplace, 'package.json'), JSON.stringify({
      name: 'fake-memesh', version: '4.8.2', private: true,
      scripts: { postinstall: `node -e ${JSON.stringify(mutateRegistry)}` },
    }));
    git(marketplace, 'add', '-A');
    git(marketplace, 'commit', '-q', '-m', 'fix: unrelated field mutated mid-upgrade');
    git(marketplace, 'push', '-q', 'origin', 'main');

    const r = runScript();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('registry changed since this upgrade started');
    const after = JSON.parse(fs.readFileSync(registry, 'utf8'));
    expect(after.plugins['memesh@pcircle-memesh'][0].note, 'the concurrent mutation was overwritten instead of being detected').toBe('mutated-mid-run');
    expect(after.plugins['memesh@pcircle-memesh'][0].gitCommitSha, 'the write went through despite the entry having changed').toBe(bumpSha);
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
      expect(r.stderr).toContain('could not restore the previous cache');
      expect(r.stderr).toContain('still intact at');
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
