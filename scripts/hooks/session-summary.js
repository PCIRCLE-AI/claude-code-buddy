#!/usr/bin/env node

// Session Auto-Capture — Stop hook
// Extracts knowledge from completed Claude Code sessions
// and stores as session-insight entities in MeMesh.

import { createRequire } from 'module';
import { join, basename, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getMemeshDir, openHookDb } from './_shared.js';

const require = createRequire(import.meta.url);

// Parse a JSONL transcript file.
// Mirrors logic in src/core/extractor.ts parseTranscript().
// Defensive: never throws — malformed lines are silently skipped.
function parseTranscript(transcriptPath) {
  const filesEdited = new Set();
  const bashCommands = [];
  const errorsEncountered = [];
  let toolCallCount = 0;

  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Count tool calls
        if (entry.type === 'tool_use' || entry.tool_name) toolCallCount++;

        // Track file edits (Write, Edit tools)
        if (entry.tool_name === 'Write' || entry.tool_name === 'Edit') {
          const inp = entry.tool_input ?? {};
          const fp = (inp.file_path ?? inp.path);
          if (fp && typeof fp === 'string') filesEdited.add(basename(fp));
        }

        // Track meaningful bash commands
        if (entry.tool_name === 'Bash') {
          const cmd = (entry.tool_input?.command) ?? '';
          if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
            bashCommands.push(cmd.slice(0, 100));
          }
        }

        // Track errors from tool results
        if (entry.type === 'tool_result' && entry.content != null) {
          const text = typeof entry.content === 'string'
            ? entry.content
            : JSON.stringify(entry.content);
          if (text.includes('Error') || text.includes('FAIL') || text.includes('error:')) {
            errorsEncountered.push(text.slice(0, 200));
          }
        }
      } catch {
        // Skip malformed JSONL lines
      }
    }
  } catch {
    // Transcript unreadable — return empty results
  }

  return { filesEdited: [...filesEdited], bashCommands, errorsEncountered, toolCallCount };
}

// Main: read stdin, extract insights, store in DB
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    if (!input.trim()) return exit0();

    // Opt-out check
    if (process.env.MEMESH_AUTO_CAPTURE === 'false') return exit0();

    let inputData;
    try {
      inputData = JSON.parse(input);
    } catch {
      return exit0();
    }

    const sessionId = inputData.session_id || 'unknown';
    const transcriptPath = inputData.transcript_path;
    const cwd = inputData.cwd || process.cwd();
    const stopReason = inputData.stop_reason || 'unknown';
    const wasAgenticLoop = inputData.was_in_agentic_loop === true;

    // Guards: skip low-signal sessions
    if (stopReason === 'user_interrupt') return exit0();
    if (!wasAgenticLoop) return exit0();
    if (!transcriptPath || !existsSync(transcriptPath)) return exit0();

    // Parse transcript
    const { filesEdited, bashCommands, errorsEncountered, toolCallCount } = parseTranscript(transcriptPath);

    // Skip sessions with too little activity
    if (toolCallCount < 3) return exit0();

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // sqlite-vec is loaded separately because only this hook needs it
    // (for embedding-aware recall-effectiveness tracking).
    const sqliteVec = require('sqlite-vec');
    const { db } = openHookDb(process.env);
    try {
      sqliteVec.load(db);

      // Duplicate detection: if we already captured this session, bail
      const shortId = sessionId.slice(0, 8);
      const alreadyCaptured = db.prepare("SELECT id FROM entities WHERE name = ?").get(`session-${shortId}-files`);
      if (alreadyCaptured) return exit0();

      // Build and store session memories
      const projectName = basename(cwd);
      const baseTags = ['source:auto-capture', `session:${shortId}`, `project:${projectName}`];

      const insertEntity = db.prepare('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)');
      const selectEntity = db.prepare('SELECT id FROM entities WHERE name = ?');
      const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');

      function storeMemory(name, type, observations, tags) {
        insertEntity.run(name, type);
        const row = selectEntity.get(name);
        if (!row) return;
        for (const obs of observations) insertObs.run(row.id, obs);
        for (const tag of tags) insertTag.run(row.id, tag);
      }

      // Rule 1: File editing session summary
      if (filesEdited.length > 0) {
        storeMemory(
          `session-${shortId}-files`,
          'session-insight',
          [
            `Session edited ${filesEdited.length} file(s): ${filesEdited.join(', ')}`,
            `Total tool calls: ${toolCallCount}`,
          ],
          baseTags
        );
      }

      // Rule 2: Error -> Fix pattern detection
      if (errorsEncountered.length > 0 && filesEdited.length > 0) {
        storeMemory(
          `session-${shortId}-fixes`,
          'session-insight',
          [
            `Fixed ${errorsEncountered.length} error(s) by editing ${filesEdited.join(', ')}`,
            ...errorsEncountered.slice(0, 3).map(e => `Error: ${e.slice(0, 100)}`),
          ],
          [...baseTags, 'type:bugfix']
        );
      }

      // Rule 3: Heavy session summary (20+ tool calls = significant work)
      if (toolCallCount >= 20) {
        storeMemory(
          `session-${shortId}-summary`,
          'session-insight',
          [
            `Significant session: ${toolCallCount} tool calls, ${filesEdited.length} files edited`,
            ...bashCommands.slice(0, 3).map(c => `Command: ${c}`),
          ],
          [...baseTags, 'type:heavy-session']
        );
      }

      // ── Recall effectiveness tracking ────────────────────────────────
      // Read which entities were injected at session start, check if
      // their names appear in the transcript, update hits/misses.
      try {
        // FIX: Find the most recent session file for this project (within last hour)
        const sessionsDir = join(getMemeshDir(process.env), 'sessions');
        let injectedData = null;

        if (existsSync(sessionsDir)) {
          const files = require('fs').readdirSync(sessionsDir);
          const recentFiles = files
            .filter(f => f.endsWith('.json'))
            .map(f => {
              const path = join(sessionsDir, f);
              try {
                const stats = require('fs').statSync(path);
                return { path, mtime: stats.mtimeMs };
              } catch {
                return null;
              }
            })
            .filter(f => f && Date.now() - f.mtime < 60 * 60 * 1000) // within 1 hour
            .sort((a, b) => b.mtime - a.mtime); // newest first

          // Try to find matching project, otherwise use most recent
          for (const { path } of recentFiles) {
            try {
              const data = JSON.parse(readFileSync(path, 'utf8'));
              if (data.project === projectName || recentFiles.length === 1) {
                injectedData = data;
                // Delete after reading to prevent reuse
                require('fs').unlinkSync(path);
                break;
              }
            } catch {}
          }
        }

        if (injectedData) {
          const { entityIds, entityNames } = injectedData;

          if (entityIds && entityIds.length > 0) {
            // Check if recall_hits column exists (v4.0+ migration)
            const colCheck = db.prepare("PRAGMA table_info(entities)").all();
            if (colCheck.some(c => c.name === 'recall_hits')) {
              // Build a lowercase transcript text for matching
              let transcriptText = readFileSync(transcriptPath, 'utf8').toLowerCase();

              // FIX: Exclude injected context from hit detection to avoid pollution
              // Remove the memorySummary that was injected at session start
              const injectedContext = (injectedData.injectedContext || '').toLowerCase();
              if (injectedContext) {
                transcriptText = transcriptText.replace(injectedContext, '');
              }

              const updateHit = db.prepare(
                'UPDATE entities SET recall_hits = COALESCE(recall_hits, 0) + 1 WHERE id = ?'
              );
              const updateMiss = db.prepare(
                'UPDATE entities SET recall_misses = COALESCE(recall_misses, 0) + 1 WHERE id = ?'
              );

              for (let i = 0; i < entityIds.length; i++) {
                const name = (entityNames[i] || '').toLowerCase();
                // Skip very short names to avoid false positives
                if (name.length < 4) continue;
                if (transcriptText.includes(name)) {
                  updateHit.run(entityIds[i]);
                } else {
                  updateMiss.run(entityIds[i]);
                }
              }
            }
          }
        }
      } catch {
        // Non-critical — don't break session summary
      }
    } finally {
      db.close();
    }

    // ── LLM-powered failure analysis (Level 1 only) ──────────────────────
    // Runs AFTER the hook's own DB is closed.
    // Uses the core module's DB singleton (openDatabase/closeDatabase).
    // Wrapped in its own try/catch — never blocks rule-based extraction.
    if (errorsEncountered.length > 0 && filesEdited.length > 0) {
      try {
        // F5: derive pluginRoot strictly from this file's location.
        // CLAUDE_PLUGIN_ROOT env-var fallback removed because a malicious
        // project's .envrc could redirect dynamic imports to attacker
        // code that gets executed inside the user's Claude Code process.
        const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
        const configMod = await import(join(pluginRoot, 'dist/core/config.js'));
        const config = configMod.readConfig();

        if (config.llm) {
          const { openDatabase, closeDatabase } = await import(join(pluginRoot, 'dist/db.js'));
          const { analyzeFailure } = await import(join(pluginRoot, 'dist/core/failure-analyzer.js'));
          const { createLesson } = await import(join(pluginRoot, 'dist/core/lesson-engine.js'));

          openDatabase();
          try {
            const lesson = await analyzeFailure(errorsEncountered, filesEdited, config.llm);
            if (lesson) {
              createLesson(lesson, projectName);
            }
          } finally {
            closeDatabase();
          }
        }
      } catch {
        // LLM analysis failed — rule-based extraction already captured the session
      }
    }
  } catch (err) {
    // Never crash Claude Code — leave a trace for debugging
    try { process.stderr.write(`[memesh session-summary] ${err?.message || err}\n`); } catch {}
  }

  // Silent output — don't clutter Claude's response
  console.log(JSON.stringify({ suppressOutput: true }));
  exit0();
});

function exit0() {
  process.exit(0);
}
