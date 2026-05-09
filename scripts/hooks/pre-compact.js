#!/usr/bin/env node

import { basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getProjectName, isAutoCaptureEnabled, openHookDb } from './_shared.js';

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
    // Opt-out check (env > config > default-on)
    if (!isAutoCaptureEnabled(process.env)) {
      return exit0();
    }

    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const transcriptPath = data.transcript_path || '';
    const cwd = data.cwd || process.cwd();
    const reason = data.reason || 'auto';
    const projectName = getProjectName(cwd);

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
            // Current format: {type:'assistant', message:{content:[{type:'tool_use',...}]}}
            if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
              for (const block of entry.message.content) {
                if (block.type !== 'tool_use') continue;
                toolCallCount++;
                const name = block.name || '';
                if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
                  const filePath = block.input?.file_path || block.input?.path || '';
                  if (filePath) editedFiles.add(basename(filePath));
                }
              }
            }
            // Legacy format: {role:'assistant', content:[{type:'tool_use',...}]}
            if (entry.role === 'assistant' && Array.isArray(entry.content)) {
              for (const block of entry.content) {
                if (block.type !== 'tool_use') continue;
                toolCallCount++;
                const name = block.name || '';
                if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
                  const filePath = block.input?.file_path || block.input?.path || '';
                  if (filePath) editedFiles.add(basename(filePath));
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

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // FTS5 needed for the entity-search index updates below.
    // Returns null on plugin-marketplace cache installs without node_modules;
    // silently skip in that case (sibling registered copy handles it).
    const handle = openHookDb(process.env, { fts: true });
    if (!handle) return;
    const { db } = handle;
    try {
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
