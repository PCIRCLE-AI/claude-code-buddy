#!/usr/bin/env node

import { createRequire } from 'module';
import { homedir } from 'os';
import { dirname, join, basename } from 'path';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
const memeshDir = process.env.MEMESH_DB_PATH ? dirname(process.env.MEMESH_DB_PATH) : join(homedir(), '.memesh');
const throttlePath = join(memeshDir, 'session-recalled-files.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    const projectName = basename(data.cwd || process.cwd());

    // Clear pre-edit recall throttle from previous session
    try {
      if (existsSync(throttlePath)) {
        unlinkSync(throttlePath);
      }
    } catch {
      // Non-critical
    }

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

      // Inspect available columns for backward compat
      const columns = db.prepare("PRAGMA table_info(entities)").all();
      const colNames = new Set(columns.map(col => col.name));

      const hasStatus = colNames.has('status');
      const hasScoringCols = colNames.has('access_count') && colNames.has('last_accessed_at') && colNames.has('confidence');

      const statusFilter = hasStatus ? "AND e.status = 'active'" : '';
      const recentStatusFilter = hasStatus ? "WHERE status = 'active'" : '';

      // Configurable limit: how many top-N entities to load per section
      const sessionLimit = parseInt(process.env.MEMESH_SESSION_LIMIT || '10', 10);

      // Build scoring ORDER BY clause (or fallback to insertion order)
      const scoringOrderBy = hasScoringCols
        ? `ORDER BY
            CASE WHEN e.confidence IS NULL THEN 0.5 ELSE e.confidence END * 0.4
            + CASE WHEN e.access_count IS NULL THEN 0
                   ELSE MIN(CAST(e.access_count AS REAL) / 50.0, 1.0) END * 0.3
            + CASE WHEN e.last_accessed_at IS NULL THEN 0.3
                   ELSE MIN(1.0, 1.0 / (1.0 + (julianday('now') - julianday(e.last_accessed_at)) / 30.0)) END * 0.3
            DESC`
        : 'ORDER BY e.id DESC';

      const recentScoringOrderBy = hasScoringCols
        ? `ORDER BY
            CASE WHEN confidence IS NULL THEN 0.5 ELSE confidence END * 0.4
            + CASE WHEN access_count IS NULL THEN 0
                   ELSE MIN(CAST(access_count AS REAL) / 50.0, 1.0) END * 0.3
            + CASE WHEN last_accessed_at IS NULL THEN 0.3
                   ELSE MIN(1.0, 1.0 / (1.0 + (julianday('now') - julianday(last_accessed_at)) / 30.0)) END * 0.3
            DESC`
        : 'ORDER BY id DESC';

      // Query project-specific top-N entities by relevance score
      const projectTag = `project:${projectName}`;
      const projectEntities = db.prepare(`
        SELECT DISTINCT e.id, e.name, e.type, e.created_at
        FROM entities e
        JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ?
        ${statusFilter}
        ${scoringOrderBy}
        LIMIT ?
      `).all(projectTag, sessionLimit);

      // Fetch the first observation for each entity (for concise summary)
      const getFirstObservation = db.prepare(
        'SELECT content FROM observations WHERE entity_id = ? ORDER BY id ASC LIMIT 1'
      );

      // Query global recent/top entities (exclude project-tagged ones for this project)
      const recentEntities = db.prepare(`
        SELECT id, name, type, created_at
        FROM entities
        ${recentStatusFilter}
        ${recentScoringOrderBy}
        LIMIT 5
      `).all();

      // Format entity as concise bullet: "• name (type): first observation (truncated)"
      function formatEntity(entity) {
        const obs = getFirstObservation.get(entity.id);
        const snippet = obs ? obs.content.slice(0, 100) : '';
        return snippet
          ? `• ${entity.name} (${entity.type}): ${snippet}`
          : `• ${entity.name} (${entity.type})`;
      }

      // Build recall message
      const lines = [];
      if (projectEntities.length > 0) {
        const label = hasScoringCols ? `top ${projectEntities.length} by relevance` : `${projectEntities.length}`;
        lines.push(`Project "${projectName}" memories (${label}):`);
        for (const e of projectEntities) {
          lines.push(formatEntity(e));
        }
      }
      if (recentEntities.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Recent memories:');
        for (const e of recentEntities) {
          lines.push(formatEntity(e));
        }
      }

      // No memories at all — output nothing (don't clutter session)
      if (lines.length === 0) {
        return;
      }

      let memorySummary = lines.join('\n');

      // --- Proactive lesson warnings ---
      try {
        const lessonEntities = db.prepare(`
          SELECT DISTINCT e.id, e.name, e.confidence
          FROM entities e
          JOIN tags t ON t.entity_id = e.id
          WHERE e.type = 'lesson_learned'
            AND e.status = 'active'
            AND t.tag = ?
          ORDER BY CASE WHEN e.confidence IS NULL THEN 0.5 ELSE e.confidence END DESC,
                   CASE WHEN e.access_count IS NULL THEN 0 ELSE e.access_count END DESC
          LIMIT 5
        `).all(projectTag);

        if (lessonEntities.length > 0) {
          memorySummary += '\n\n⚠️ Known lessons for this project:\n';
          for (const lesson of lessonEntities) {
            // Load ALL observations per lesson (not fragile LIKE pattern)
            const allObs = db.prepare(
              'SELECT content FROM observations WHERE entity_id = ? ORDER BY id'
            ).all(lesson.id);

            // Find the Prevention line
            const prevention = allObs.find(o => o.content.startsWith('Prevention:'));
            const display = prevention
              ? prevention.content.replace(/^Prevention:\s*/, '')
              : (allObs[allObs.length - 1]?.content || lesson.name);

            const conf = typeof lesson.confidence === 'number' ? lesson.confidence.toFixed(1) : '1.0';
            memorySummary += `• ${display} (confidence: ${conf})\n`;
          }
        }
      } catch {
        // Lesson query failed — don't break session start
      }

      // --- Record injected entity IDs for recall effectiveness tracking ---
      try {
        // CRITICAL: Deduplicate by entity ID (entity may appear in both project and recent lists)
        const seenIds = new Set();
        const allInjected = [...projectEntities, ...recentEntities].filter(e => {
          if (seenIds.has(e.id)) return false;
          seenIds.add(e.id);
          return true;
        });

        if (allInjected.length > 0) {
          const sessionsDir = join(memeshDir, 'sessions');
          if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

          // FIX: Use session-scoped file with unique ID (pid + timestamp)
          const sessionId = `${process.pid}-${Date.now()}`;
          writeFileSync(
            join(sessionsDir, `${sessionId}.json`),
            JSON.stringify({
              injectedAt: new Date().toISOString(),
              project: projectName,
              entityIds: allInjected.map(e => e.id),
              entityNames: allInjected.map(e => e.name),
              // FIX: Save injected context text to exclude from hit detection
              injectedContext: memorySummary,
            }),
            'utf8'
          );

          // Clean up old session files (>24h)
          try {
            const files = require('fs').readdirSync(sessionsDir);
            const now = Date.now();
            for (const file of files) {
              if (!file.endsWith('.json')) continue;
              const filePath = join(sessionsDir, file);
              const stats = require('fs').statSync(filePath);
              if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
                require('fs').unlinkSync(filePath);
              }
            }
          } catch {}
        }
      } catch {
        // Non-critical — don't break session start
      }

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
    // ── Noise compression (after readonly DB is closed) ──────────────
    // Opens a separate read-write connection via the core module.
    // Throttled to once per 24h inside compressWeeklyNoise().
    try {
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
        || dirname(dirname(fileURLToPath(import.meta.url)));
      const dbMod = await import(join(pluginRoot, 'dist/db.js'));
      const lifecycleMod = await import(join(pluginRoot, 'dist/core/lifecycle.js'));
      dbMod.openDatabase();
      try {
        lifecycleMod.compressWeeklyNoise(dbMod.getDatabase());
      } finally {
        dbMod.closeDatabase();
      }
    } catch {
      // Non-critical — noise compression failed, will retry next session
    }
  } catch (err) {
    // Hooks must never crash Claude Code — but report honestly
    console.log(JSON.stringify({ systemMessage: `MeMesh: Session start failed (${err?.message || 'unknown error'}). Memories not loaded.` }));
  }
});

function output(text) {
  console.log(JSON.stringify({ systemMessage: text }));
}
