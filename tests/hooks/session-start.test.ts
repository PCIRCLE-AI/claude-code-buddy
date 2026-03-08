import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

describe('Feature: Session Start Hook', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-test-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function runHook(input: object): { result: string } {
    const hookPath = path.resolve('scripts/hooks/session-start.js');
    const jsonInput = JSON.stringify(input);
    const result = execFileSync('node', [hookPath], {
      input: jsonInput,
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    return JSON.parse(result.trim());
  }

  function createTestDb(): InstanceType<typeof import('better-sqlite3')> {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSON
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tags_entity ON tags(entity_id);
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
      CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, observations, content='',
        tokenize='unicode61 remove_diacritics 1'
      );
    `);
    return db;
  }

  it('Scenario: No database exists -> welcome message', () => {
    const output = runHook({ cwd: '/tmp/myproject' });
    expect(output.result).toContain('No database found');
  });

  it('Scenario: Empty database (no entities table) -> graceful message', () => {
    // Create an empty db file with no tables
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.close();

    const output = runHook({ cwd: '/tmp/myproject' });
    // Empty db hits the catch block or table check — either way, no crash
    expect(output.result).toBeTruthy();
  });

  it('Scenario: Database with project memories -> recalls them with observations', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('auth-module', 'component');
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(1, 'Handles JWT token validation');
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(1, 'Uses bcrypt for password hashing');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(1, 'project:myproject');
    db.close();

    const output = runHook({ cwd: '/tmp/myproject' });
    expect(output.result).toContain('Project "myproject" memories');
    expect(output.result).toContain('[component] auth-module');
    expect(output.result).toContain('Uses bcrypt for password hashing');
    expect(output.result).toContain('Handles JWT token validation');
  });

  it('Scenario: Database with no matching project -> shows only recent memories', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('some-entity', 'note');
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(1, 'A note about something');
    db.close();

    const output = runHook({ cwd: '/tmp/other-project' });
    expect(output.result).not.toContain('Project "other-project" memories');
    expect(output.result).toContain('Recent memories');
    expect(output.result).toContain('[note] some-entity');
    expect(output.result).toContain('A note about something');
  });

  it('Scenario: Database with both project and global memories -> shows both', () => {
    const db = createTestDb();
    // Project entity
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('project-item', 'feature');
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(1, 'Project specific');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(1, 'project:testproj');
    // Global entity (no project tag)
    db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('global-item', 'note');
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(2, 'Global note');
    db.close();

    const output = runHook({ cwd: '/tmp/testproj' });
    expect(output.result).toContain('Project "testproj" memories');
    expect(output.result).toContain('[feature] project-item');
    expect(output.result).toContain('Recent memories');
    expect(output.result).toContain('[note] global-item');
  });

  it('Scenario: Always exits with valid JSON output on invalid input', () => {
    const hookPath = path.resolve('scripts/hooks/session-start.js');
    const result = execFileSync('node', [hookPath], {
      input: 'not-json',
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    const parsed = JSON.parse(result.trim());
    expect(parsed).toHaveProperty('result');
    expect(typeof parsed.result).toBe('string');
  });
});
