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
  writePrivateJson,
  hookMatchExpression,
} from './_shared.js';
import { MemeshDatabase } from './_generated/sqlite.js';

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

    // `readOnly`, not `readonly`: node:sqlite ignores the lowercase spelling
    // and hands back a WRITABLE handle. This hook only reads.
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    try {

      // Check if entities table exists
      // Both tables, not just `entities`. Strategy 2 below joins entities_fts,
      // and this hook opens the database READ-ONLY without going through
      // openHookDb, so it never creates that table. Checking only `entities`
      // meant a structurally-absent index reached the query and failed there —
      // which, now that the failure is no longer swallowed, would print on
      // every single Edit.
      const tables = new Set(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','entities_fts')"
        ).all().map((r) => r.name)
      );
      if (!tables.has('entities')) return pass();
      const hasFts = tables.has('entities_fts');

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
      if (hasFts && results.length < MAX_RESULTS && fileNameNoExt.length >= 4) {
        // Built by the same function core uses, so this query asks for the
        // tokens the index actually holds. Quoting the raw basename here meant
        // a CJK or decomposed-Unicode filename matched nothing at all against
        // the segmented index — and the catch below made that invisible.
        const matchExpr = hookMatchExpression(fileNameNoExt);
        try {
          // ORDER BY rank is load-bearing now that terms are OR-ed.
          //
          // The match expression used to be a single phrase, so `LIMIT` picked
          // from a handful of rows that all genuinely contained the basename and
          // arbitrary selection was tolerable. `hookMatchExpression` now emits
          // `"knowledge" OR "graph"` for `knowledge-graph.ts` — necessary,
          // because a CJK basename has to be reachable by its bigrams — which
          // makes the match set large and unranked selection IS the result:
          // editing that file in a project whose memories merely mention
          // "graph" injected whatever the scan happened to reach first, where
          // the old code correctly injected nothing. BM25 is what makes the OR
          // safe; without it the fix trades a CJK miss for an ASCII false hit.
          const ftsResults = matchExpr === null ? [] : db.prepare(`
            SELECT DISTINCT e.id, e.name, e.type, e.metadata
            FROM entities e
            JOIN entities_fts fts ON fts.rowid = e.id
            JOIN tags t ON t.entity_id = e.id
            WHERE entities_fts MATCH ?
              AND t.tag = ?
            ${statusFilter}
            ORDER BY fts.rank, e.id DESC
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
          //
          // Throttled, because PreToolUse fires a fresh process per Edit/Write
          // and a persistent fault would otherwise print on every keystroke's
          // worth of tool calls. Once per distinct message per day is enough to
          // be noticed without becoming noise the user learns to ignore.
          reportOnce(`fts:${err?.message || err}`, `filename search failed: ${err?.message || err}`);
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

/**
 * Write a warning to stderr at most once per distinct message per day.
 *
 * A hook that says nothing when it breaks is this project's signature failure;
 * a hook that says the same thing on every tool call is noise the user filters
 * out, which ends in the same place. The marker file lives beside the throttle
 * file this hook already maintains.
 */
function reportOnce(key, message) {
  try {
    const markerPath = join(memeshDir, 'hook-warnings.json');
    let seen = {};
    try {
      if (existsSync(markerPath)) seen = JSON.parse(readFileSync(markerPath, 'utf8')) || {};
    } catch { seen = {}; }

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (typeof seen[key] === 'number' && now - seen[key] < DAY) return;

    seen[key] = now;
    // Bound the file: keep the 20 most recent keys.
    const trimmed = Object.fromEntries(
      Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 20)
    );
    ensurePrivateDir(memeshDir);
    writePrivateJson(markerPath, trimmed);
    process.stderr.write(`[memesh pre-edit-recall] ${message}\n`);
  } catch { /* a warning must never break the user's edit */ }
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
