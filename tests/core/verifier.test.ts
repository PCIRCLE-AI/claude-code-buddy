import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { verifyAgentWork } from '../../src/core/verifier.js';

let tmpDbDir: string;
let tmpRepo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepoOnMain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-repo-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@test.local']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function commitFiles(repo: string, files: Record<string, string>, message: string) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(repo, name), content);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', message]);
}

beforeEach(() => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-verifier-'));
  openDatabase(path.join(tmpDbDir, 'test.db'));
  tmpRepo = makeRepoOnMain();
  git(tmpRepo, ['checkout', '-b', 'feat/test-branch']);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe('verifyAgentWork — reality check', () => {
  it('passes when claim matches actual files changed', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n', 'b.txt': 'B\n' }, 'add a and b');

    const result = verifyAgentWork({
      agent_id: 'agent-1',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 2 },
    });

    expect(result.verdict).toBe('pass');
    expect(result.reality_check.match).toBe(true);
    expect(result.reality_check.files_changed).toBe(2);
    expect(result.entity_name).toMatch(/^verification:agent-1:/);
  });

  it('fails when claim says fewer files than actual', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n', 'b.txt': 'B\n' }, 'add a and b');

    const result = verifyAgentWork({
      agent_id: 'fab-claim',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 1 },
    });

    expect(result.verdict).toBe('fail');
    expect(result.reality_check.match).toBe(false);
    expect(result.reality_check.files_changed).toBe(2);
  });

  // This case used to be called "informational mode" and asserted
  // `pass === true`. Recording a snapshot without a claim is still a
  // supported mode — what changed is that it no longer calls itself a pass.
  // Counting files is not checking them against anything, and the old
  // encoding meant `memesh verify` printed PASS and exited 0, stored a memory
  // reading "verification: PASS", and handed an agent `"pass": true` when
  // nothing whatsoever had been verified.
  it('returns unverified — not pass — when there is no claim and no report', () => {
    commitFiles(tmpRepo, { 'x.txt': 'X\n' }, 'add x');

    const result = verifyAgentWork({
      agent_id: 'no-claim',
      workdir: tmpRepo,
      base: 'main',
    });

    expect(result.verdict).toBe('unverified');
    expect(result.reality_check.verdict).toBe('unverified');
    // The informational half still works: it did look, and it says what it saw.
    expect(result.reality_check.match).toBeNull();
    expect(result.reality_check.files_changed).toBe(1);
    expect(result.reality_check.summary).toContain('no claim to check against');
  });

  it('a claim alone is enough to earn a pass', () => {
    commitFiles(tmpRepo, { 'x.txt': 'X\n' }, 'add x');

    const result = verifyAgentWork({
      agent_id: 'claim-only',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 1 },
    });

    expect(result.verdict).toBe('pass');
  });

  it('a report alone is enough to earn a pass, even with no claim to cross-check', () => {
    commitFiles(tmpRepo, { 'x.txt': 'X\n' }, 'add x');

    const result = verifyAgentWork({
      agent_id: 'report-only',
      workdir: tmpRepo,
      base: 'main',
      report: { pass: true, tests: { pass: true, summary: '12/12' } },
    });

    // Something real was checked — just not by the git half.
    expect(result.verdict).toBe('pass');
    expect(result.reality_check.verdict).toBe('unverified');
  });

  it('a failing report still fails when there is no claim', () => {
    commitFiles(tmpRepo, { 'x.txt': 'X\n' }, 'add x');

    const result = verifyAgentWork({
      agent_id: 'report-fail',
      workdir: tmpRepo,
      base: 'main',
      report: { pass: false, tests: { pass: false, summary: '3 failed' } },
    });

    expect(result.verdict).toBe('fail');
  });

  it('tags and observations carry the verdict, because that is what future recall reads', () => {
    commitFiles(tmpRepo, { 'x.txt': 'X\n' }, 'add x');

    const result = verifyAgentWork({
      agent_id: 'tagged',
      workdir: tmpRepo,
      base: 'main',
    });

    const db = getDatabase();
    const row = db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(result.entity_name) as { id: number };
    const tags = db
      .prepare('SELECT tag FROM tags WHERE entity_id = ?')
      .all(row.id)
      .map((t: any) => t.tag);
    const observations = db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(row.id)
      .map((o: any) => o.content);

    expect(tags).toContain('verification:unverified');
    expect(tags).not.toContain('verification:pass');
    expect(observations[0]).toBe('Agent tagged verification: UNVERIFIED');
  });
});

describe('verifyAgentWork — external report integration', () => {
  it('passes overall when both reality and external report pass', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');

    const result = verifyAgentWork({
      agent_id: 'agent-2',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 1 },
      report: {
        pass: true,
        typecheck: { pass: true },
        tests: { pass: true, summary: '77/77 pass' },
      },
    });

    expect(result.verdict).toBe('pass');
    expect(result.external_report?.tests?.summary).toBe('77/77 pass');
  });

  it('fails overall when external report fails even if reality matches', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');

    const result = verifyAgentWork({
      agent_id: 'agent-3',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 1 },
      report: {
        pass: false,
        tests: { pass: false, summary: '5 failed' },
      },
    });

    expect(result.verdict).toBe('fail');
    expect(result.reality_check.verdict).toBe('pass');
  });
});

describe('verifyAgentWork — persistence', () => {
  it('produces distinct entity names for two consecutive calls (no sleep needed)', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');
    const r1 = verifyAgentWork({ agent_id: 'twice', workdir: tmpRepo, base: 'main' });
    const r2 = verifyAgentWork({ agent_id: 'twice', workdir: tmpRepo, base: 'main' });
    expect(r1.entity_name).not.toBe(r2.entity_name);
  });

  it('produces distinct entity names even when called in tight burst (no race)', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = verifyAgentWork({ agent_id: 'burst', workdir: tmpRepo, base: 'main' });
      names.add(r.entity_name);
    }
    expect(names.size).toBe(20);
  });

  it('stores the report as a verification_record entity tagged with its verdict', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');
    const result = verifyAgentWork({
      agent_id: 'tagged',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 1 },
    });

    const db = getDatabase();
    const row = db
      .prepare("SELECT type FROM entities WHERE name = ?")
      .get(result.entity_name) as { type: string } | undefined;
    expect(row?.type).toBe('verification_record');

    const tags = db
      .prepare(
        "SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ?",
      )
      .all(result.entity_name) as Array<{ tag: string }>;
    const names = tags.map((t) => t.tag);
    expect(names).toContain('verification');
    expect(names).toContain('verification:pass');
  });
});

describe('verifyAgentWork — error paths', () => {
  it('rejects a non-git directory loudly (F8: workdir validation)', () => {
    // F8 fix: previously a non-git workdir silently produced
    // pass=false with base=null. That was indistinguishable from a
    // genuine "no merge base found" run, which made it possible for a
    // caller (or prompt-injected LLM) to pass arbitrary filesystem
    // paths and observe git behaviour. Now we throw before shelling
    // out to git so the caller sees a clear validation error.
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      expect(() => verifyAgentWork({
        agent_id: 'no-git',
        workdir: nonGit,
      })).toThrow(/not a git working tree/);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('rejects a non-existent workdir (F8)', () => {
    const ghost = path.join(os.tmpdir(), `definitely-not-here-${Date.now()}-${process.pid}`);
    expect(() => verifyAgentWork({
      agent_id: 'ghost',
      workdir: ghost,
    })).toThrow(/does not exist/);
  });

  it('rejects a relative workdir (F8)', () => {
    expect(() => verifyAgentWork({
      agent_id: 'rel',
      workdir: 'relative/path',
    })).toThrow(/absolute path/);
  });

  it('rejects a workdir that is a file, not a directory (F8)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-not-dir-'));
    const filePath = path.join(tmp, 'plain-file');
    fs.writeFileSync(filePath, 'hi');
    try {
      expect(() => verifyAgentWork({
        agent_id: 'file',
        workdir: filePath,
      })).toThrow(/not a directory/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sanitises agent_id with non-alphanumeric chars in entity name', () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');
    const result = verifyAgentWork({
      agent_id: 'agent/with spaces & symbols',
      workdir: tmpRepo,
      base: 'main',
    });
    expect(result.entity_name).toMatch(/^verification:agent-with-spaces---symbols:/);
  });
});

// 2026-05-05 codex review/challenge regressions:
//   - Subdirectories of a git working tree must be accepted (review P2)
//   - Symlinks must be resolved before validation (challenge #5)
describe('verifyAgentWork — workdir handling (subdir + symlink, codex 2026-05-05)', () => {
  it('accepts a subdirectory of a git working tree (monorepo support)', () => {
    // Pre-fix: validateWorkdir checked for `.git` directly inside
    // workdir, so any subdirectory of a repo (e.g. /repo/packages/app)
    // was rejected even though `git -C <subdir>` works fine.
    const subdir = path.join(tmpRepo, 'packages', 'app');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'index.ts'), 'export const x = 1;\n');
    git(tmpRepo, ['add', '.']);
    git(tmpRepo, ['commit', '-m', 'add subdir']);

    const result = verifyAgentWork({
      agent_id: 'subdir',
      workdir: subdir,
      base: 'main',
    });
    // Reaches realityCheck without throwing — that's the regression.
    expect(result.entity_name).toMatch(/^verification:subdir:/);
  });

  it('canonicalises symlinks via realpath, not just resolve()', () => {
    // Pre-fix: validateWorkdir used path.resolve() which only normalises
    // ./.. — symlinks survived. A symlink to repo A could be passed and
    // the validation would silently operate on a different on-disk path
    // than the caller likely thought. Now realpathSync collapses
    // symlinks; the recorded observation cites the realpath, and a
    // pre-realpath note appears so a future reader spots the redirection.
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-link-'));
    const linkPath = path.join(linkParent, 'aliased-repo');
    try {
      fs.symlinkSync(tmpRepo, linkPath, 'dir');
      commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');

      const result = verifyAgentWork({
        agent_id: 'symlink',
        workdir: linkPath,
        base: 'main',
      });
      // No claim and no report here, so the verdict is unverified. What this
      // case is really asserting is that resolving the symlink did not throw
      // and did not silently bypass the git-working-tree check.
      expect(result.verdict).toBe('unverified');
      // The recorded entity should know the canonical path. We can't
      // read observations directly here without DB access, but the
      // entity name persists through remember(); the assertion that
      // matters is that this didn't throw and didn't silently bypass
      // anything. realpath's correctness is exercised because the
      // symlink path is NOT a git working tree on its own (no .git
      // entry in linkParent), only via realpath does the git check
      // succeed.
      expect(result.entity_name).toMatch(/^verification:symlink:/);
    } finally {
      try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });
});

describe('a claim that could not be evaluated is not a pass', () => {
  /**
   * `realityCheck` returns early when no git base is discoverable — BEFORE
   * `expected_files` is ever compared. The caller asked for two checks, one
   * silently did not run, and the tool reported an unqualified pass on the
   * strength of the other. That is the same "absence read as evidence" shape
   * the rest of this release removes, in the tool whose entire job is to say
   * whether something was actually checked.
   *
   * Measured before the fix: expected_files 99 against a single-commit repo on
   * a branch with no discoverable base returned match: null, base: null,
   * verdict: "pass".
   */
  function repoWithNoDiscoverableBase(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-lonely-'));
    // Not main, not develop, no remote, and only one commit — so every
    // candidate in resolveBase fails, including HEAD~1.
    git(dir, ['init', '-b', 'detached-work']);
    git(dir, ['config', 'user.email', 'test@test.local']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'only commit']);
    return dir;
  }

  it('does not report pass when the file claim never ran', () => {
    const repo = repoWithNoDiscoverableBase();
    try {
      const result = verifyAgentWork({
        agent_id: 'probe',
        workdir: repo,
        claim: { expected_files: 99 },
        report: { pass: true },
      });

      // The claim was supplied and demonstrably not evaluated.
      expect(result.reality_check.match).toBeNull();
      expect(result.reality_check.base).toBeNull();
      // So the answer is "I could not check that", not "it passed".
      expect(result.verdict).toBe('unverified');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still passes when the caller supplied no file claim at all', () => {
    // No claim means nothing went unchecked — the report alone is a real,
    // sufficient answer. Without this case the fix above could be "return
    // unverified whenever there is no base", which would be too broad.
    const repo = repoWithNoDiscoverableBase();
    try {
      const result = verifyAgentWork({
        agent_id: 'probe',
        workdir: repo,
        report: { pass: true },
      });
      expect(result.verdict).toBe('pass');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the deprecated `pass` alias', () => {
  /**
   * `pass: boolean` was removed outright in favour of `verdict`, which made a
   * patch release break every consumer reading `result.pass` on the MCP tool
   * result, the HTTP /v1/verify body and `memesh verify --json`. It is back as
   * a derived alias for one minor cycle.
   *
   * The point of the alias is that it does NOT reintroduce the bug: it mirrors
   * `verdict === 'pass'`, so an unverified run reads as false rather than
   * true, which is what the old boolean got wrong.
   */
  it('mirrors verdict for a genuine pass', () => {
    commitFiles(tmpRepo, { 'a.ts': 'export const a = 1;\n' }, 'add a');
    const result = verifyAgentWork({
      agent_id: 'agent-1',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 1 },
    });
    expect(result.verdict).toBe('pass');
    expect(result.pass).toBe(true);
  });

  it('is false — not true — when nothing was checked', () => {
    const result = verifyAgentWork({ agent_id: 'agent-1', workdir: tmpRepo, base: 'main' });
    expect(result.verdict).toBe('unverified');
    expect(result.pass).toBe(false);
  });

  it('is false when the claim did not hold', () => {
    commitFiles(tmpRepo, { 'a.ts': 'export const a = 1;\n' }, 'add a');
    const result = verifyAgentWork({
      agent_id: 'agent-1',
      workdir: tmpRepo,
      base: 'main',
      claim: { expected_files: 9 },
    });
    expect(result.verdict).toBe('fail');
    expect(result.pass).toBe(false);
  });
});
