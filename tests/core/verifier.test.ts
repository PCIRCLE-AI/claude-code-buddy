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

    expect(result.pass).toBe(true);
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

    expect(result.pass).toBe(false);
    expect(result.reality_check.match).toBe(false);
    expect(result.reality_check.files_changed).toBe(2);
  });

  it('reports without claim and still passes (informational mode)', () => {
    commitFiles(tmpRepo, { 'x.txt': 'X\n' }, 'add x');

    const result = verifyAgentWork({
      agent_id: 'no-claim',
      workdir: tmpRepo,
      base: 'main',
    });

    expect(result.pass).toBe(true);
    expect(result.reality_check.match).toBeNull();
    expect(result.reality_check.files_changed).toBe(1);
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

    expect(result.pass).toBe(true);
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

    expect(result.pass).toBe(false);
    expect(result.reality_check.pass).toBe(true);
  });
});

describe('verifyAgentWork — persistence', () => {
  it('produces distinct entity names for two consecutive calls', async () => {
    commitFiles(tmpRepo, { 'a.txt': 'A\n' }, 'add a');
    const r1 = verifyAgentWork({ agent_id: 'twice', workdir: tmpRepo, base: 'main' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r2 = verifyAgentWork({ agent_id: 'twice', workdir: tmpRepo, base: 'main' });
    expect(r1.entity_name).not.toBe(r2.entity_name);
  });

  it('stores the report as a verification_record entity tagged pass/fail', () => {
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
  it('handles a non-git directory gracefully', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const result = verifyAgentWork({
        agent_id: 'no-git',
        workdir: nonGit,
      });
      expect(result.pass).toBe(false);
      expect(result.reality_check.base).toBeNull();
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
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
