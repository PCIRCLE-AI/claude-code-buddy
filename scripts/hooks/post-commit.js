#!/usr/bin/env node

import { createRequire } from 'module';
import { homedir } from 'os';
import { join, basename } from 'path';
import { existsSync, mkdirSync } from 'fs';

const require = createRequire(import.meta.url);

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

CREATE INDEX IF NOT EXISTS idx_tags_entity ON tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, observations, content='',
  tokenize='unicode61 remove_diacritics 1'
);
`;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Only process Bash tool outputs
    if (data.tool_name !== 'Bash') return exit0();
    const toolOutput = typeof data.tool_output === 'string'
      ? data.tool_output
      : JSON.stringify(data.tool_output || '');

    // Detect git commit in output
    // Pattern: [branch hash] commit message
    const commitMatch = toolOutput.match(/\[[\w/.-]+ ([a-f0-9]{7,})\] (.+)/);
    if (!commitMatch) return exit0();

    const commitHash = commitMatch[1];
    const commitMsg = commitMatch[2];
    const projectName = basename(data.cwd || process.cwd());

    // Open database (create dir if needed)
    const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
    const dbDir = process.env.MEMESH_DB_PATH
      ? join(process.env.MEMESH_DB_PATH, '..')
      : join(homedir(), '.memesh');
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Ensure schema exists
    db.exec(SCHEMA_SQL);

    const entityName = `commit-${commitHash}`;

    // Insert entity
    db.prepare('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)').run(entityName, 'commit');
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(entityName);
    if (entity) {
      // Add observation
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, commitMsg);

      // Add project tag (check first since no unique constraint)
      const projectTag = `project:${projectName}`;
      const existingTag = db.prepare('SELECT id FROM tags WHERE entity_id = ? AND tag = ?').get(entity.id, projectTag);
      if (!existingTag) {
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(entity.id, projectTag);
      }

      // Update FTS index
      try {
        db.prepare("INSERT INTO entities_fts(entities_fts, rowid, name, observations) VALUES('delete', ?, ?, '')").run(entity.id, entityName);
      } catch {
        // Ignore if no previous entry
      }
      db.prepare('INSERT INTO entities_fts(rowid, name, observations) VALUES(?, ?, ?)').run(entity.id, entityName, commitMsg);
    }

    db.close();
  } catch (err) {
    // Never crash Claude Code
  }
  exit0();
});

function exit0() {
  process.exit(0);
}
