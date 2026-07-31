#!/usr/bin/env node

// Continuous Recall — PreToolUse hook for Edit/Write
// When editing a file, checks if MeMesh has relevant memories
// and injects them as context. Throttled: max 1 recall per file per session.

import { basename, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  buildReferenceContext,
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  isTrustedForAutoContext,
  tryRequireBetterSqlite,
  writePrivateJson,
  hookMatchExpression,
} from './_shared.js';

const dbPath = getDbPath();
const memeshDir = getMemeshDirFromDbPath();
const THROTTLE_FILE = join(memeshDir, 'session-recalled-files.json');
const MAX_RESULTS = 3;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (!data.tool_input) {
      // Schema-flip signal — Claude Code has renamed `tool_input` for
      // transcript blocks before. Trace so the rename surfaces day-1.
      try { process.stderr.write(`[memesh pre-edit-recall] tool_input absent (keys: ${Object.keys(data).join(',')}); skipping\n`); } catch {}
      return pass();
    }
    const toolInput = data.tool_input;
    const filePath = toolInput.file_path || toolInput.path || '';

    // Only process if we have a file path
    if (!filePath || typeof filePath !== 'string') {
      return pass();
    }

    // Get project name from cwd for project-scoped filtering
    const projectName = getProjectName(data.cwd);

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

    if (!existsSync(dbPath)) return pass();

    // tryRequireBetterSqlite() returns null on plugin-marketplace cache
    // installs that ship without node_modules; pass-through silently in
    // that case so a sibling registered hook copy can still inject
    // recall context.
    const Database = tryRequireBetterSqlite();
    if (!Database) return pass();
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
        SELECT DISTINCT e.id, e.name, e.type, e.metadata
        FROM entities e
        JOIN tags t1 ON t1.entity_id = e.id
        JOIN tags t2 ON t2.entity_id = e.id
        WHERE (t1.tag = ? OR t1.tag = ?)
          AND t2.tag = ?
        ${statusFilter}
        LIMIT ?
      `).all(`file:${fileName}`, `file:${fileNameNoExt}`, projectTag, MAX_RESULTS * 3);
      results.push(...tagResults.filter((row) => isTrustedForAutoContext(row.metadata)));

      // Strategy 2: FTS5 search on file name (if not enough results)
      // CRITICAL: Filter by project to prevent cross-project memory injection
      if (results.length < MAX_RESULTS && fileNameNoExt.length >= 4) {
        // Built by the same function core uses, so this query asks for the
        // tokens the index actually holds. Quoting the raw basename here meant
        // a CJK or decomposed-Unicode filename matched nothing at all against
        // the segmented index — and the catch below made that invisible.
        const matchExpr = hookMatchExpression(fileNameNoExt);
        try {
          const ftsResults = matchExpr === null ? [] : db.prepare(`
            SELECT DISTINCT e.id, e.name, e.type, e.metadata
            FROM entities e
            JOIN entities_fts fts ON fts.rowid = e.id
            JOIN tags t ON t.entity_id = e.id
            WHERE entities_fts MATCH ?
              AND t.tag = ?
            ${statusFilter}
            LIMIT ?
          `).all(matchExpr, projectTag, (MAX_RESULTS - results.length) * 3);
          // Deduplicate
          for (const r of ftsResults) {
            if (!isTrustedForAutoContext(r.metadata)) continue;
            if (!results.some(existing => existing.id === r.id)) {
              results.push(r);
            }
          }
        } catch (err) {
          // Never fail the user's edit over a recall miss, but do not pretend
          // nothing happened either: a silently-skipped FTS query is how this
          // hook injected zero memories for months without anyone noticing.
          try {
            process.stderr.write(
              `[memesh pre-edit-recall] filename search failed: ${err?.message || err}\n`
            );
          } catch { /* stderr must never throw */ }
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
      for (const r of results.slice(0, MAX_RESULTS)) {
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
          additionalContext: buildReferenceContext(lines),
        },
      }));
    } finally {
      db.close();
    }
  } catch (err) {
    // Never crash Claude Code, but trace — peer hooks (post-commit,
    // pre-compact, session-summary) all stderr-trace their outer
    // catches. Without a trace here, a typo in any prepare statement
    // would silently break continuous recall on every Edit/Write
    // tool call indefinitely.
    try { process.stderr.write(`[memesh pre-edit-recall] ${err?.message || err}\n`); } catch {}
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
    ensurePrivateDir(memeshDir);
    writePrivateJson(THROTTLE_FILE, seenFiles);
  } catch {
    // Non-critical
  }
}
