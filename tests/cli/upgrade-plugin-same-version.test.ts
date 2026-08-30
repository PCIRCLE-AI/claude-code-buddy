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

function runScript(): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', exitCode: e.status ?? 1 };
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
});
