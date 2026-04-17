#!/usr/bin/env node

import { createRequire } from 'module';
import { homedir } from 'os';
import { join, basename } from 'path';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const projectName = basename(data.cwd || process.cwd());

    // Find database
    const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
    if (!existsSync(dbPath)) {
      output('MeMesh: No database found. Memories will be created as you work.');
      return;
    }

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      db.pragma('journal_mode = WAL');

      // Check if tables exist (db may exist but be empty)
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
      ).get();
      if (!tableCheck) {
        output('MeMesh: Database exists but no memories stored yet.');
        return;
      }

      // Query project-specific recent entities with their observations
      const projectTag = `project:${projectName}`;
      const projectEntities = db.prepare(`
        SELECT DISTINCT e.id, e.name, e.type, e.created_at
        FROM entities e
        JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ?
        ORDER BY e.id DESC
        LIMIT 10
      `).all(projectTag);

      // Fetch observations for each entity (up to 3 per entity)
      const getObservations = db.prepare(
        'SELECT content FROM observations WHERE entity_id = ? ORDER BY id DESC LIMIT 3'
      );

      // Query global recent entities
      const recentEntities = db.prepare(`
        SELECT id, name, type, created_at
        FROM entities
        ORDER BY id DESC
        LIMIT 5
      `).all();

      // Build recall message
      const lines = [];
      if (projectEntities.length > 0) {
        lines.push(`Project "${projectName}" memories (${projectEntities.length}):`);
        for (const e of projectEntities) {
          lines.push(`  - [${e.type}] ${e.name}`);
          const obs = getObservations.all(e.id);
          for (const o of obs) {
            lines.push(`    ${o.content}`);
          }
        }
      }
      if (recentEntities.length > 0) {
        lines.push('');
        lines.push('Recent memories:');
        for (const e of recentEntities) {
          lines.push(`  - [${e.type}] ${e.name}`);
          const obs = getObservations.all(e.id);
          for (const o of obs) {
            lines.push(`    ${o.content}`);
          }
        }
      }
      if (lines.length === 0) {
        lines.push('MeMesh: No memories found yet. Use remember tool to store knowledge.');
      }

      const memorySummary = lines.join('\n');
      const hookOutput = {
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: memorySummary,
        },
      };
      console.log(JSON.stringify(hookOutput));
    } finally {
      db.close();
    }
  } catch (err) {
    // Hooks must never crash Claude Code — but report honestly
    console.log(JSON.stringify({ systemMessage: `MeMesh: Session start failed (${err?.message || 'unknown error'}). Memories not loaded.` }));
  }
});

function output(text) {
  console.log(JSON.stringify({ systemMessage: text }));
}
