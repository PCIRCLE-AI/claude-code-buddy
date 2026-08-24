/**
 * Status derived from git, checked against git.
 *
 * Every case here builds a real repository and compares the derived value with
 * what `git` itself answers, rather than with a number written into the test.
 * A fixture that asserts `uncommitted === 2` passes just as well when the
 * derivation is broken and the fixture happens to agree; asking git twice does
 * not.
 *
 * The module exists because the alternative — storing status — produced a
 * session that opened with "Just finished: v4.6.0" while 38 PRs had merged and
 * npm served 4.7.3. Derivation cannot go stale, so these tests are mostly
 * about the honesty of the *failure* cases: a directory that is not a
 * repository, a missing tag, a version with no tag. Each has to answer "I
 * don't know" distinguishably from "the answer is zero".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readRepoState, repoStateLines } from '../../src/core/repo-state.js';
import { removeTempDir } from '../helpers/temp-dir.js';

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function commit(message: string, file = 'a.txt', body = 'x'): void {
  fs.writeFileSync(path.join(repo, file), `${body}\n`);
  git('add', file);
  git('commit', '-m', message);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-repo-state-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
});

afterEach(() => {
  removeTempDir(repo);
});

describe('readRepoState', () => {
  it('reports the branch git reports', () => {
    commit('first');
    git('checkout', '-q', '-b', 'feature/some-work');

    const state = readRepoState(repo);

    expect(state).not.toBeNull();
    expect(state!.branch, 'derived branch disagrees with git').toBe(git('rev-parse', '--abbrev-ref', 'HEAD'));
    expect(state!.branch).toBe('feature/some-work');
  });

  it('counts what git counts, staged and unstaged and untracked alike', () => {
    commit('first');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'edited\n');
    git('add', 'tracked.txt');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

    const expected = git('status', '--porcelain').split('\n').filter(l => l.trim() !== '').length;
    const state = readRepoState(repo);

    expect(expected, 'the fixture produced no changes — this test would pass vacuously').toBe(3);
    expect(state!.uncommitted).toBe(expected);
  });

  it('is zero, not null, on a clean tree — those are different answers', () => {
    commit('first');

    expect(readRepoState(repo)!.uncommitted).toBe(0);
  });

  it('counts commits since the last tag', () => {
    commit('first');
    git('tag', 'v1.0.0');
    commit('second', 'b.txt');
    commit('third', 'c.txt');

    const state = readRepoState(repo);

    expect(state!.lastTag).toBe('v1.0.0');
    expect(state!.commitsSinceTag).toBe(Number(git('rev-list', '--count', 'v1.0.0..HEAD')));
    expect(state!.commitsSinceTag).toBe(2);
  });

  it('says null for the tag when the repository has none', () => {
    commit('first');

    const state = readRepoState(repo);

    expect(state!.lastTag).toBeNull();
    expect(state!.commitsSinceTag, 'a count with no tag to count from is not zero').toBeNull();
  });

  it('flags a declared version that has no tag — the window where main claims what npm cannot serve', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
    commit('add package.json', 'package.json', JSON.stringify({ name: 'x', version: '9.9.9' }));

    const state = readRepoState(repo);

    expect(state!.declaredVersion).toBe('9.9.9');
    expect(state!.declaredVersionIsTagged).toBe(false);

    git('tag', 'v9.9.9');
    expect(readRepoState(repo)!.declaredVersionIsTagged).toBe(true);
  });

  it('says null for the version question when there is no package.json to ask about', () => {
    commit('first');

    const state = readRepoState(repo);

    expect(state!.declaredVersion).toBeNull();
    expect(state!.declaredVersionIsTagged, 'no version to check is not the same as "not tagged"').toBeNull();
  });

  it('returns null outside a repository rather than throwing', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-not-a-repo-'));
    try {
      expect(readRepoState(plain)).toBeNull();
    } finally {
      removeTempDir(plain);
    }
  });

  it('returns null for a path that does not exist rather than throwing', () => {
    expect(readRepoState('/definitely/not/here/at/all')).toBeNull();
  });
});

describe('repoStateLines', () => {
  it('says nothing when there is no repository', () => {
    expect(repoStateLines(null)).toEqual([]);
  });

  it('renders the facts a session needs, and stays quiet about the normal case', () => {
    commit('first');
    git('tag', 'v1.0.0');

    const lines = repoStateLines(readRepoState(repo));

    expect(lines.length, 'rendered nothing for a real repository').toBeGreaterThan(1);
    expect(lines[0]).toContain('read just now');
    expect(lines.join('\n')).toContain('working tree clean');
    expect(lines.join('\n')).toContain('at tag v1.0.0');
    // A declared-and-tagged version is the quiet case: saying so every session
    // is noise, and only the untagged window is worth a line.
    expect(lines.join('\n'), 'reported the uninteresting version case').not.toContain('has no tag yet');
  });

  it('speaks up when the declared version has no tag', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
    commit('add package.json', 'package.json', JSON.stringify({ name: 'x', version: '9.9.9' }));

    expect(repoStateLines(readRepoState(repo)).join('\n')).toContain('9.9.9, which has no tag yet');
  });
});
