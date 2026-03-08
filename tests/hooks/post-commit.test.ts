import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

describe('Feature: Post-Commit Hook', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-test-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function runHook(input: object): void {
    const hookPath = path.resolve('scripts/hooks/post-commit.js');
    const jsonInput = JSON.stringify(input);
    execFileSync('node', [hookPath], {
      input: jsonInput,
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  function openDb(): InstanceType<typeof import('better-sqlite3')> {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true });
  }

  it('Scenario: Bash output with git commit -> entity created', () => {
    const input = {
      tool_name: 'Bash',
      cwd: '/tmp/myproject',
      tool_input: { command: 'git commit -m "fix: resolve login bug"' },
      tool_output: '[main abc1234] fix: resolve login bug\n 2 files changed, 15 insertions(+), 3 deletions(-)',
    };

    runHook(input);

    // Verify entity was created
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('commit-abc1234');
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('commit');

    // Verify observation
    const obs = db.prepare('SELECT * FROM observations WHERE entity_id = ?').get(entity.id);
    expect(obs).toBeTruthy();
    expect(obs.content).toBe('fix: resolve login bug');

    // Verify tag
    const tag = db.prepare('SELECT * FROM tags WHERE entity_id = ? AND tag = ?').get(entity.id, 'project:myproject');
    expect(tag).toBeTruthy();

    // Verify FTS
    const fts = db.prepare("SELECT * FROM entities_fts WHERE entities_fts MATCH 'login'").all();
    expect(fts.length).toBeGreaterThan(0);

    db.close();
  });

  it('Scenario: Bash output without git commit -> no entity created', () => {
    const input = {
      tool_name: 'Bash',
      cwd: '/tmp/myproject',
      tool_input: { command: 'ls -la' },
      tool_output: 'total 32\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 .',
    };

    runHook(input);

    // Database should not even exist (no commit detected)
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Non-Bash tool -> exits cleanly without action', () => {
    const input = {
      tool_name: 'Read',
      cwd: '/tmp/myproject',
      tool_input: { file_path: '/tmp/test.txt' },
      tool_output: 'file contents',
    };

    runHook(input);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Database does not exist -> creates it and stores commit', () => {
    expect(fs.existsSync(dbPath)).toBe(false);

    const input = {
      tool_name: 'Bash',
      cwd: '/tmp/newproject',
      tool_input: { command: 'git commit -m "initial commit"' },
      tool_output: '[main def5678] initial commit\n 1 file changed, 1 insertion(+)',
    };

    runHook(input);

    expect(fs.existsSync(dbPath)).toBe(true);
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('commit-def5678');
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('commit');
    db.close();
  });

  it('Scenario: Branch name with slashes -> commit detected correctly', () => {
    const input = {
      tool_name: 'Bash',
      cwd: '/tmp/myproject',
      tool_input: { command: 'git commit -m "feat: add feature"' },
      tool_output: '[feature/v3-hooks 9a8b7c6] feat: add feature\n 3 files changed',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('commit-9a8b7c6');
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ?').get(entity.id);
    expect(obs.content).toBe('feat: add feature');
    db.close();
  });

  it('Scenario: Duplicate commit -> no duplicate entities', () => {
    const input = {
      tool_name: 'Bash',
      cwd: '/tmp/myproject',
      tool_input: { command: 'git commit -m "same commit"' },
      tool_output: '[main aaa1111] same commit\n 1 file changed',
    };

    runHook(input);
    runHook(input);

    const db = openDb();
    const entities = db.prepare('SELECT * FROM entities WHERE name = ?').all('commit-aaa1111');
    expect(entities).toHaveLength(1);
    // But observations may be duplicated (each hook run adds one)
    const obs = db.prepare('SELECT * FROM observations WHERE entity_id = ?').all(entities[0].id);
    expect(obs.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('Scenario: Invalid JSON input -> exits cleanly', () => {
    const hookPath = path.resolve('scripts/hooks/post-commit.js');
    // Should not throw
    execFileSync('node', [hookPath], {
      input: 'not-json',
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
  });
});
