#!/usr/bin/env node

// Continuous Recall — PreToolUse hook for Edit/Write
// When editing a file, checks if MeMesh has relevant memories
// and injects them as context. Throttled: max 1 recall per file per session.

import { createRequire } from 'module';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const require = createRequire(import.meta.url);

const THROTTLE_FILE = join(homedir(), '.memesh', 'session-recalled-files.json');
const MAX_RESULTS = 3;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolInput = data.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || '';

    // Only process if we have a file path
    if (!filePath || typeof filePath !== 'string') {
      return pass();
    }

    // Get project name from cwd for project-scoped filtering
    const projectName = basename(data.cwd || process.cwd());

    // Throttle: skip if we already recalled for this file
    const fileKey = filePath.toLowerCase();
    let seenFiles = [];
    try {
      if (existsSync(THROTTLE_FILE)) {
        const raw = JSON.parse(readFileSync(THROTTLE_FILE, 'utf8'));
        seenFiles = Array.isArray(raw) ? raw : [];
      }
    } catch {
      seenFiles = [];
    }

    if (seenFiles.includes(fileKey)) {
      return pass();
    }

    // Find database
    const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
    if (!existsSync(dbPath)) return pass();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {

      // Check if entities table exists
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
      ).get();
      if (!tableCheck) return pass();

      const hasStatus = db.prepare("PRAGMA table_info(entities)").all()
        .some(c => c.name === 'status');
      const statusFilter = hasStatus ? "AND e.status = 'active'" : '';

      // Search strategies:
      // 1. Entities tagged with the file's basename (e.g., "file:auth.ts")
      // 2. Entities with name matching the file's basename (without extension)
      // 3. FTS5 search on the basename (without extension)
      const fileName = basename(filePath);
      const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');

      const results = [];

      // Strategy 1: Tag-based search (file:name or mentions of the file)
      // CRITICAL: Filter by project to prevent cross-project memory injection
      const projectTag = `project:${projectName}`;
      const tagResults = db.prepare(`
        SELECT DISTINCT e.id, e.name, e.type
        FROM entities e
        JOIN tags t1 ON t1.entity_id = e.id
        JOIN tags t2 ON t2.entity_id = e.id
        WHERE (t1.tag = ? OR t1.tag = ?)
          AND t2.tag = ?
        ${statusFilter}
        LIMIT ?
      `).all(`file:${fileName}`, `file:${fileNameNoExt}`, projectTag, MAX_RESULTS);
      results.push(...tagResults);

      // Strategy 2: FTS5 search on file name (if not enough results)
      // CRITICAL: Filter by project to prevent cross-project memory injection
      if (results.length < MAX_RESULTS && fileNameNoExt.length >= 4) {
        try {
          const ftsResults = db.prepare(`
            SELECT DISTINCT e.id, e.name, e.type
            FROM entities e
            JOIN entities_fts fts ON fts.rowid = e.id
            JOIN tags t ON t.entity_id = e.id
            WHERE entities_fts MATCH ?
              AND t.tag = ?
            ${statusFilter}
            LIMIT ?
          `).all('"' + fileNameNoExt.replace(/"/g, '""') + '"', projectTag, MAX_RESULTS - results.length);
          // Deduplicate
          for (const r of ftsResults) {
            if (!results.some(existing => existing.id === r.id)) {
              results.push(r);
            }
          }
        } catch {
          // FTS query failed — skip silently
        }
      }

      if (results.length === 0) {
        // Record as seen even with no results (avoid re-querying)
        recordSeen(seenFiles, fileKey);
        return pass();
      }

      // Fetch first observation for each result
      const getObs = db.prepare(
        'SELECT content FROM observations WHERE entity_id = ? ORDER BY id ASC LIMIT 1'
      );

      const lines = [`Relevant memories for ${fileName}:`];
      for (const r of results) {
        const obs = getObs.get(r.id);
        const snippet = obs ? obs.content.slice(0, 120) : '';
        lines.push(snippet
          ? `• ${r.name} (${r.type}): ${snippet}`
          : `• ${r.name} (${r.type})`
        );
      }

      // Record as seen
      recordSeen(seenFiles, fileKey);

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: lines.join('\n'),
        },
      }));
    } finally {
      db.close();
    }
  } catch {
    // Never crash Claude Code
    pass();
  }
});

function pass() {
  // Empty output = no additional context
  process.exit(0);
}

function recordSeen(seenFiles, fileKey) {
  try {
    seenFiles.push(fileKey);
    // Cap at 100 to prevent unbounded growth
    if (seenFiles.length > 100) seenFiles = seenFiles.slice(-50);
    const memeshDir = join(homedir(), '.memesh');
    if (!existsSync(memeshDir)) mkdirSync(memeshDir, { recursive: true });
    writeFileSync(THROTTLE_FILE, JSON.stringify(seenFiles), 'utf8');
  } catch {
    // Non-critical
  }
}
