import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import {
  getProjectName,
  slugFromRemoteUrl,
  _clearProjectNameCache,
} from '../../src/core/paths.js';

const require = createRequire(import.meta.url);
// The hook-side mirror. Loading the JS module directly lets us assert the two
// implementations agree — a divergence would silently split project identity
// between the writers (hooks) and readers (core).
// _shared.js is plain JS with no type declarations
const shared = require('../../scripts/hooks/_shared.js');

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function makeRepo(remoteUrl?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-proj-'));
  // Real fs paths on macOS tmp are symlinked (/var → /private/var); resolve so
  // `git rev-parse --show-toplevel` and our basename comparisons line up.
  const real = fs.realpathSync(dir);
  git(real, ['init']);
  git(real, ['config', 'user.email', 'test@example.com']);
  git(real, ['config', 'user.name', 'Test']);
  if (remoteUrl) git(real, ['remote', 'add', 'origin', remoteUrl]);
  return real;
}

describe('slugFromRemoteUrl', () => {
  const cases: [string, string][] = [
    ['https://github.com/PCIRCLE-AI/memesh-llm-memory.git', 'memesh-llm-memory'],
    ['https://github.com/PCIRCLE-AI/memesh-llm-memory', 'memesh-llm-memory'],
    ['git@github.com:PCIRCLE-AI/memesh-llm-memory.git', 'memesh-llm-memory'],
    ['git@github.com:PCIRCLE-AI/memesh-llm-memory', 'memesh-llm-memory'],
    ['ssh://git@github.com/owner/Repo.git', 'Repo'],
    ['https://gitlab.com/group/subgroup/proj.git', 'proj'],
    ['https://host/owner/repo/', 'repo'],
  ];
  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => {
      expect(slugFromRemoteUrl(url)).toBe(expected);
    });
  }
  it('returns null for an empty/whitespace url', () => {
    expect(slugFromRemoteUrl('')).toBeNull();
    expect(slugFromRemoteUrl('   ')).toBeNull();
  });

  it('the hook mirror produces identical slugs', () => {
    for (const [url, expected] of cases) {
      expect(shared.slugFromRemoteUrl(url)).toBe(expected);
    }
  });
});

describe('getProjectName — layered git identity', () => {
  const created: string[] = [];
  beforeEach(() => _clearProjectNameCache());
  afterEach(() => {
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('uses the git remote slug, not the directory name (location-independent)', () => {
    const repo = makeRepo('git@github.com:PCIRCLE-AI/canonical-name.git');
    created.push(repo);
    // The directory basename is a random tmp name, NOT "canonical-name".
    expect(path.basename(repo)).not.toBe('canonical-name');
    expect(getProjectName(repo)).toBe('canonical-name');
  });

  it('a subdirectory resolves to the SAME identity as the repo root (fixes the split)', () => {
    const repo = makeRepo('https://github.com/x/whole-repo.git');
    created.push(repo);
    const sub = path.join(repo, 'backend', 'src');
    fs.mkdirSync(sub, { recursive: true });
    _clearProjectNameCache();
    expect(getProjectName(sub)).toBe('whole-repo');
    expect(getProjectName(repo)).toBe('whole-repo');
  });

  it('falls back to the repo root basename when there is no remote', () => {
    const repo = makeRepo(); // no remote
    created.push(repo);
    expect(getProjectName(repo)).toBe(path.basename(repo));
  });

  it('a non-git directory gets basename plus a hash of its real path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nogit-'));
    const real = fs.realpathSync(dir);
    created.push(real);
    const name = getProjectName(real);
    // `<basename>-<8 hex>` — bare basename collided across same-named dirs.
    expect(name).toMatch(new RegExp(`^${path.basename(real)}-[0-9a-f]{8}$`));
  });

  it('two same-named non-git directories resolve to TWO identities', () => {
    // ~/a/notes vs ~/b/notes — the collision this layer exists to close. The
    // symptom of the old bare-basename rule was the other directory's
    // memories appearing in recall.
    const parentA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pa-')));
    const parentB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pb-')));
    created.push(parentA, parentB);
    const notesA = path.join(parentA, 'notes');
    const notesB = path.join(parentB, 'notes');
    fs.mkdirSync(notesA);
    fs.mkdirSync(notesB);
    const idA = getProjectName(notesA);
    const idB = getProjectName(notesB);
    expect(idA).not.toBe(idB);
    // Both still carry the human-readable basename up front.
    expect(idA.startsWith('notes-')).toBe(true);
    expect(idB.startsWith('notes-')).toBe(true);
  });

  it('the same non-git directory resolves to ONE identity, even via a symlink', () => {
    // Codex, Claude Code and Gemini all spawn against the same directory —
    // possibly through different path spellings. realpath collapses them.
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-same-')));
    created.push(real);
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    created.push(link);
    const direct = getProjectName(real);
    _clearProjectNameCache();
    const viaLink = getProjectName(link);
    expect(viaLink).toBe(direct);
  });

  it('the hook mirror resolves identically for every layer', () => {
    const withRemote = makeRepo('git@github.com:o/mirror-check.git');
    const noRemote = makeRepo();
    const nonGit = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ng-')));
    created.push(withRemote, noRemote, nonGit);
    for (const cwd of [withRemote, noRemote, nonGit]) {
      _clearProjectNameCache();
      const core = getProjectName(cwd);
      expect(shared.getProjectName(cwd)).toBe(core);
    }
  });
});
