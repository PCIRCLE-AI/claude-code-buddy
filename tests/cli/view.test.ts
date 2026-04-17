import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateDashboardHtml } from '../../src/cli/view.js';

const SCHEMA_SQL = `
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
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL,
  to_entity_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
`;

describe('Feature: MeMesh View Dashboard', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `memesh-view-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    testDbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Scenario: Generate dashboard with empty database', () => {
    it('Given an empty database, When I generate the dashboard, Then it returns valid HTML', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
      expect(html).toContain('MeMesh LLM Memory');
      expect(html).toContain('d3.js');
    });

    it('Given an empty database, When I generate the dashboard, Then statistics show zeros', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('"totalEntities":0');
      expect(html).toContain('"totalObservations":0');
      expect(html).toContain('"totalRelations":0');
    });
  });

  describe('Scenario: Generate dashboard with entity data', () => {
    it('Given a database with entities, When I generate the dashboard, Then HTML includes entity data', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'TypeScript',
        'technology'
      );
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Vitest',
        'tool'
      );
      db.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      ).run(1, 'A typed superset of JavaScript');
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(
        1,
        'language'
      );
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('TypeScript');
      expect(html).toContain('Vitest');
      expect(html).toContain('technology');
      expect(html).toContain('A typed superset of JavaScript');
      expect(html).toContain('"totalEntities":2');
      expect(html).toContain('"totalObservations":1');
    });
  });

  describe('Scenario: Generate dashboard with relations as graph edges', () => {
    it('Given entities with relations, When I generate the dashboard, Then relations appear as edges', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Alice',
        'person'
      );
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Bob',
        'person'
      );
      db.prepare(
        'INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      ).run(1, 2, 'knows');
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('"totalRelations":1');
      expect(html).toContain('Alice');
      expect(html).toContain('Bob');
      expect(html).toContain('knows');
    });
  });

  describe('Scenario: Generate dashboard includes statistics section', () => {
    it('Given a populated database, When I generate the dashboard, Then statistics are accurate', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Node.js',
        'runtime'
      );
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Express',
        'framework'
      );
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Fastify',
        'framework'
      );
      db.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      ).run(1, 'Server-side JavaScript');
      db.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      ).run(1, 'V8 engine');
      db.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      ).run(2, 'Minimalist web framework');
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(
        1,
        'backend'
      );
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(
        2,
        'backend'
      );
      db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(
        3,
        'backend'
      );
      db.prepare(
        'INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      ).run(2, 1, 'runs_on');
      db.prepare(
        'INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      ).run(3, 1, 'runs_on');
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('"totalEntities":3');
      expect(html).toContain('"totalObservations":3');
      expect(html).toContain('"totalRelations":2');
      expect(html).toContain('"totalTags":3');
    });
  });

  describe('Scenario: Handle missing database gracefully', () => {
    it('Given no database file exists, When I generate the dashboard, Then it returns empty dashboard', () => {
      const missingPath = path.join(testDir, 'nonexistent.db');
      const html = generateDashboardHtml(missingPath);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('"totalEntities":0');
      expect(html).toContain('"totalObservations":0');
    });

    it('Given a database without tables, When I generate the dashboard, Then it returns empty dashboard', () => {
      const db = new Database(testDbPath);
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('"totalEntities":0');
    });
  });

  describe('Scenario: Archived entity visual distinction in dashboard', () => {
    it('Given an archived entity, When I generate the dashboard, Then HTML contains archived indicator', () => {
      const db = new Database(testDbPath);
      db.prepare('CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, metadata JSON, status TEXT NOT NULL DEFAULT \'active\')').run();
      db.prepare('CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE)').run();
      db.prepare('CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER NOT NULL, tag TEXT NOT NULL, FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE)').run();
      db.prepare("INSERT INTO entities (name, type, status) VALUES (?, ?, 'active')").run('ActiveThing', 'concept');
      db.prepare("INSERT INTO entities (name, type, status) VALUES (?, ?, 'archived')").run('ArchivedThing', 'concept');
      db.close();

      const html = generateDashboardHtml(testDbPath);

      // Both entities should be present in the data
      expect(html).toContain('ActiveThing');
      expect(html).toContain('ArchivedThing');
      // Archived status should be embedded in the data payload
      expect(html).toContain('"status":"archived"');
      expect(html).toContain('"status":"active"');
      // Dashboard JavaScript includes archived indicator logic
      expect(html).toContain('[archived]');
      expect(html).toContain('opacity');
    });

    it('Given a DB without status column, When I generate the dashboard, Then it still works', () => {
      const db = new Database(testDbPath);
      db.prepare('CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
      db.prepare("INSERT INTO entities (name, type) VALUES (?, ?)").run('LegacyThing', 'note');
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('LegacyThing');
      expect(html).toContain('"status":"active"');
    });
  });

  describe('Scenario: XSS prevention in embedded data', () => {
    it('Given entity names with HTML characters, When I generate the dashboard, Then they are escaped', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        '<script>alert("xss")</script>',
        'malicious'
      );
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).not.toContain('<script>alert("xss")</script>');
      expect(html).toContain('\\u003c');
    });
  });

  describe('Scenario: D3.js graph visualization', () => {
    it('Given the generated HTML, Then it bundles D3.js locally', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('bundled d3.js');
      expect(html).not.toContain('<script src="https://d3js.org/d3.v7.min.js">');
      expect(html).toContain('d3.forceSimulation');
    });

    it('Given entities with observations, Then node size calculation is included', () => {
      const db = new Database(testDbPath);
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(
        'Test',
        'thing'
      );
      db.close();

      const html = generateDashboardHtml(testDbPath);

      expect(html).toContain('Math.min');
    });
  });
});
