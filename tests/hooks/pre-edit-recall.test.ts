import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

describe('Feature: Pre-Edit Recall Hook', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-test-'));
    dbPath = path.join(testDir, 'test.db');
    // Create .memesh dir for throttle file
    fs.mkdirSync(path.join(testDir, '.memesh'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function runHook(input: object): string {
    const hookPath = path.resolve('scripts/hooks/pre-edit-recall.js');
    const jsonInput = JSON.stringify(input);
    try {
      return execFileSync('node', [hookPath], {
        input: jsonInput,
        env: { ...process.env, MEMESH_DB_PATH: dbPath, HOME: testDir },
        encoding: 'utf8',
        timeout: 10000,
      }).trim();
    } catch {
      return '';
    }
  }

  function createTestDb() {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSON,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_entity_tag_unique ON tags(entity_id, tag);
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, observations, content='',
        tokenize='unicode61 remove_diacritics 1'
      );
    `);
    return db;
  }

  it('should return empty when no database exists', () => {
    const result = runHook({ tool_input: { file_path: '/some/file.ts' } });
    expect(result).toBe('');
  });

  it('should return empty when no relevant memories found', () => {
    createTestDb().close();
    const result = runHook({ tool_input: { file_path: '/some/unknown-file.ts' } });
    expect(result).toBe('');
  });

  it('should return memories matching file tag', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('auth-decision', 'decision');
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get('auth-decision') as any;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(row.id, 'Use OAuth 2.0');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(row.id, 'file:auth');
    // Add project tag (hook derives from cwd basename)
    const projectName = path.basename(process.cwd());
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(row.id, `project:${projectName}`);
    db.close();

    const result = runHook({ tool_input: { file_path: '/src/auth.ts' } });
    expect(result).toContain('auth-decision');
    expect(result).toContain('Use OAuth 2.0');
  });

  it('should throttle: second call for same file returns empty', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('auth-decision', 'decision');
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get('auth-decision') as any;
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(row.id, 'Use OAuth 2.0');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(row.id, 'file:auth');
    // Add project tag (hook derives from cwd basename)
    const projectName = path.basename(process.cwd());
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(row.id, `project:${projectName}`);
    db.close();

    const result1 = runHook({ tool_input: { file_path: '/src/auth.ts' } });
    expect(result1).toContain('auth-decision');

    const result2 = runHook({ tool_input: { file_path: '/src/auth.ts' } });
    expect(result2).toBe('');
  });

  it('should return empty when no file_path in tool_input', () => {
    createTestDb().close();
    const result = runHook({ tool_input: { command: 'ls' } });
    expect(result).toBe('');
  });
});
