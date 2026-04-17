#!/usr/bin/env node

import { createRequire } from 'module';
import { homedir } from 'os';
import { join, basename } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';

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
DELETE FROM tags
WHERE id NOT IN (
  SELECT MIN(id)
  FROM tags
  GROUP BY entity_id, tag
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_entity_tag_unique ON tags(entity_id, tag);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, observations, content='',
  tokenize='unicode61 remove_diacritics 1'
);
`;

// Timeout guard: always exit within 10 seconds
const TIMEOUT_MS = 10000;
const timeoutHandle = setTimeout(() => {
  try { process.stderr.write('[memesh pre-compact] Timed out after 10s\n'); } catch {}
  process.exit(0);
}, TIMEOUT_MS);
timeoutHandle.unref();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Opt-out check
    if (process.env.MEMESH_AUTO_CAPTURE === 'false') {
      return exit0();
    }

    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const transcriptPath = data.transcript_path || '';
    const cwd = data.cwd || process.cwd();
    const reason = data.reason || 'auto';
    const projectName = basename(cwd);

    // Parse transcript to gather insights
    let toolCallCount = 0;
    const editedFiles = new Set();

    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        const lines = readFileSync(transcriptPath, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            // Count tool uses from assistant message content blocks
            if (entry.role === 'assistant' && Array.isArray(entry.content)) {
              for (const block of entry.content) {
                if (block.type === 'tool_use') {
                  toolCallCount++;
                  // Track file edits
                  const name = block.name || '';
                  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
                    const filePath = block.input?.file_path || block.input?.path || '';
                    if (filePath) editedFiles.add(basename(filePath));
                  }
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Transcript read failed — proceed with zero counts
      }
    }

    const insightCount = editedFiles.size + (toolCallCount > 0 ? 1 : 0);
    const entityName = `pre-compact-${sessionId}`;

    // Build observation content
    const obsLines = [`Compaction reason: ${reason}`, `Tool calls: ${toolCallCount}`];
    if (editedFiles.size > 0) {
      obsLines.push(`Files edited: ${Array.from(editedFiles).join(', ')}`);
    }

    // Open (or create) database
    const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
    const dbDir = process.env.MEMESH_DB_PATH
      ? join(process.env.MEMESH_DB_PATH, '..')
      : join(homedir(), '.memesh');
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);

      // Upsert entity
      const insertResult = db.prepare('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)').run(entityName, 'session-summary');
      const isNew = insertResult.changes > 0;
      const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(entityName);

      if (entity) {
        // Capture existing observations for FTS delete
        const prevObs = isNew
          ? []
          : db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entity.id);
        const prevObsText = isNew ? undefined : prevObs.map(o => o.content).join(' ');

        // Insert each observation line
        for (const line of obsLines) {
          db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.id, line);
        }

        // Add tags
        const tags = ['source:auto-capture', 'urgency:pre-compact', `project:${projectName}`];
        for (const tag of tags) {
          db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(entity.id, tag);
        }

        // Update FTS
        if (prevObsText !== undefined) {
          db.prepare("INSERT INTO entities_fts(entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)").run(entity.id, entityName, prevObsText);
        }
        const allObs = db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entity.id);
        const allObsText = allObs.map(o => o.content).join(' ');
        db.prepare('INSERT INTO entities_fts(rowid, name, observations) VALUES(?, ?, ?)').run(entity.id, entityName, allObsText);
      }
    } finally {
      db.close();
    }

    const hookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: `Saved ${insightCount} insights to MeMesh before compaction`,
      },
    };
    console.log(JSON.stringify(hookOutput));
  } catch (err) {
    // Hooks must never crash Claude Code — exit cleanly
    try { process.stderr.write(`[memesh pre-compact] ${err?.message || err}\n`); } catch {}
  }
  exit0();
});

function exit0() {
  process.exit(0);
}
