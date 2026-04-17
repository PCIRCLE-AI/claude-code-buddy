import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase, getDatabase } from '../src/db.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Feature: Database Management', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `memesh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    testDbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    try { closeDatabase(); } catch {}
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Scenario: Open database for first time', () => {
    it('Given no database exists, When I open, Then it creates all tables', () => {
      const db = openDatabase(testDbPath);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map((r: any) => r.name);
      expect(tables).toContain('entities');
      expect(tables).toContain('observations');
      expect(tables).toContain('relations');
      expect(tables).toContain('tags');
    });

    it('Given no database exists, When I open, Then FTS5 virtual table exists', () => {
      const db = openDatabase(testDbPath);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map((r: any) => r.name);
      expect(tables).toContain('entities_fts');
    });

    it('Given no database exists, When I open, Then WAL mode is enabled', () => {
      const db = openDatabase(testDbPath);
      const mode = db.prepare('PRAGMA journal_mode').get() as any;
      expect(mode.journal_mode).toBe('wal');
    });

    it('Given no database exists, When I open, Then foreign keys are enabled', () => {
      const db = openDatabase(testDbPath);
      const fk = db.prepare('PRAGMA foreign_keys').get() as any;
      expect(fk.foreign_keys).toBe(1);
    });
  });

  describe('Scenario: Open existing database', () => {
    it('Given db already open, When I call openDatabase again, Then returns same instance', () => {
      const db1 = openDatabase(testDbPath);
      const db2 = openDatabase(testDbPath);
      expect(db1).toBe(db2);
    });
  });

  describe('Scenario: Close database', () => {
    it('Given open db, When I close, Then getDatabase throws', () => {
      openDatabase(testDbPath);
      closeDatabase();
      expect(() => getDatabase()).toThrow('Database not opened');
    });

    it('Given no db open, When I close, Then no error', () => {
      expect(() => closeDatabase()).not.toThrow();
    });
  });

  describe('Scenario: getDatabase', () => {
    it('Given db is open, When I call getDatabase, Then returns connection', () => {
      openDatabase(testDbPath);
      const db = getDatabase();
      expect(db).toBeDefined();
      const result = db.prepare('SELECT 1 as val').get() as any;
      expect(result.val).toBe(1);
    });
  });

  describe('Scenario: Database path from env', () => {
    it('Given MEMESH_DB_PATH is set, When I open, Then uses that path', () => {
      const customPath = path.join(testDir, 'custom.db');
      const origEnv = process.env.MEMESH_DB_PATH;
      process.env.MEMESH_DB_PATH = customPath;
      try {
        openDatabase();
        expect(fs.existsSync(customPath)).toBe(true);
      } finally {
        closeDatabase();
        process.env.MEMESH_DB_PATH = origEnv;
      }
    });
  });

  describe('Scenario: Indexes exist', () => {
    it('Given db is open, Then indexes on tags, observations, relations exist', () => {
      const db = openDatabase(testDbPath);
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
      ).all().map((r: any) => r.name);
      expect(indexes).toContain('idx_tags_entity');
      expect(indexes).toContain('idx_tags_tag');
      expect(indexes).toContain('idx_tags_entity_tag_unique');
      expect(indexes).toContain('idx_observations_entity');
      expect(indexes).toContain('idx_relations_from');
      expect(indexes).toContain('idx_relations_to');
    });
  });

  describe('Scenario: Status column migration', () => {
    it('should have status column on entities table with default active', () => {
      const db = openDatabase(testDbPath);
      const info = db.prepare("PRAGMA table_info(entities)").all() as any[];
      const statusCol = info.find((col: any) => col.name === 'status');
      expect(statusCol).toBeDefined();
      expect(statusCol.dflt_value).toBe("'active'");
    });

    it('should have index on entities status column', () => {
      const db = openDatabase(testDbPath);
      const indexes = db.prepare("PRAGMA index_list(entities)").all() as any[];
      const statusIdx = indexes.find((idx: any) => idx.name === 'idx_entities_status');
      expect(statusIdx).toBeDefined();
    });
  });

  describe('Scenario: Vector table setup', () => {
    it('should have entities_vec virtual table', () => {
      const db = openDatabase(testDbPath);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'"
      ).all();
      expect(tables).toHaveLength(1);
    });
  });
});
