#!/usr/bin/env node

// Session Auto-Capture — Stop hook
// Extracts knowledge from completed Claude Code sessions
// and stores as session-insight entities in MeMesh.

import { createRequire } from 'module';
import { basename, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  decideAutoUpdateHook,
  getMemeshDirFromDbPath,
  getProjectName,
  isAutoCaptureEnabled,
  openHookDb,
  readUpdateCheckCache,
  resolveAutoUpdatePolicy,
  resolvePluginRoot,
  spawnAutoUpdate,
} from './_shared.js';

const require = createRequire(import.meta.url);

// Pre-load dist/core/install-channel.js for auto-update channel detection.
// Same pattern as session-start.js: async ESM import at process init,
// falls back to null if dist is missing (source checkout pre-build).
let _installChannelMod = null;
try {
  const _pluginRootForInit = resolvePluginRoot(import.meta.url);
  const _modPath = join(_pluginRootForInit, 'dist/core/install-channel.js');
  if (existsSync(_modPath)) {
    _installChannelMod = await import(pathToFileURL(_modPath).href);
  }
} catch { /* best-effort */ }

/**
 * Run auto-update at Stop hook: reads cache, evaluates policy, and spawns
 * npm install -g if warranted. Runs after all session work completes,
 * avoiding the TOCTOU race where install would overwrite dist/ mid-session.
 */
async function runAutoUpdateAtStop() {
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    const installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
    if (!installedVersion) return;

    const cache = readUpdateCheckCache(installedVersion);
    const policy = resolveAutoUpdatePolicy(process.env);
    const decision = decideAutoUpdateHook(installedVersion, cache, policy);
    if (decision.run) {
      spawnAutoUpdate(decision.latest, decision.deprecationOverride, _installChannelMod);
    }
  } catch {
    // Best-effort — never crash the hook.
  }
}

// Parse a JSONL transcript file.
// Handles the current Claude Code transcript format where tool_use/tool_result
// are nested inside assistant/user message entries, not top-level entries.
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

        // Current format: assistant entries contain tool_use blocks in message.content
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type !== 'tool_use') continue;
            toolCallCount++;

            if (block.name === 'Write' || block.name === 'Edit') {
              const fp = block.input?.file_path ?? block.input?.path;
              if (fp && typeof fp === 'string') filesEdited.add(basename(fp));
            }
            if (block.name === 'Bash') {
              const cmd = block.input?.command ?? '';
              if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
                bashCommands.push(cmd.slice(0, 100));
              }
            }
          }
        }

        // Current format: user entries contain tool_result blocks in message.content.
        //
        // Use the explicit `is_error` flag the transcript records on each
        // tool_result instead of substring-matching the result text. The
        // earlier substring approach treated any Read/Bash output that
        // happened to contain the word "Error" (READMEs documenting errors,
        // CHANGELOG entries, source files mentioning "Error", grep over docs)
        // as a real error, drowning analyzeFailure() in noise — a 47MB
        // transcript reported 315 "errors" against ~28 real ones. The flag
        // is the canonical signal Claude Code itself uses to mark a tool as
        // having failed.
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type !== 'tool_result') continue;
            if (block.is_error !== true) continue;
            const text = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            errorsEncountered.push(text.slice(0, 200));
          }
        }

        // The legacy branch (top-level entry.tool_use / entry.tool_name /
        // entry.tool_result with entry.content) was confirmed dead code
        // via real-transcript audit: no Claude Code transcript ever
        // shipped that shape — current production wraps every block
        // under entry.message.content. Removed because the
        // dead branch had a confusing empty if/else (lines 133-138 of
        // the prior version) that signalled review fatigue more than
        // working logic.
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

    // Opt-out check (env > config > default-on)
    if (!isAutoCaptureEnabled(process.env)) return exit0();

    let inputData;
    try {
      inputData = JSON.parse(input);
    } catch (parseErr) {
      // Schema mismatch / Claude Code payload-shape flip would land here.
      // Trace so the next 24h of dev surfaces it instead of months of
      // silent dropout. Mirrors user-prompt-intent.js's logError pattern.
      try {
        const preview = (input || '').slice(0, 80).replace(/\n/g, ' ');
        process.stderr.write(`[memesh session-summary] malformed stdin JSON (len=${input.length}): ${parseErr?.message || parseErr}; preview="${preview}"\n`);
      } catch {}
      return exit0();
    }

    const sessionId = inputData.session_id || 'unknown';
    const transcriptPath = inputData.transcript_path;
    const cwd = inputData.cwd || process.cwd();
    const stopReason = inputData.stop_reason || 'unknown';
    // Default-allow: when Claude Code's Stop payload omits
    // `was_in_agentic_loop` (it has been silently absent in production
    // for an unknown number of releases — symptom: zero session-insight
    // entities written despite hooks otherwise wired correctly), fall
    // back to "treat as agentic" so the toolCallCount<3 guard below is
    // the real low-signal filter. Earlier this field was a hard gate
    // (default-deny) and the hook silently never captured anything.
    const wasAgenticLoop = inputData.was_in_agentic_loop !== false;

    // Guards: skip low-signal sessions
    if (stopReason === 'user_interrupt') return exit0();
    if (!wasAgenticLoop) return exit0();
    // Trace why we're skipping. Two failure modes:
    //   (a) transcript_path absent — schema flip, Claude Code stopped
    //       sending the field. Same bug shape as `was_in_agentic_loop`
    //       (PR #39); without a trace it's invisible for months.
    //   (b) transcript_path present but file vanished — race with
    //       Claude Code's own log rotation, or a permissions issue.
    // Either way, no transcript means no extractable session knowledge,
    // so the silent-no-op is the right behaviour — but we leave a
    // breadcrumb so a schema flip doesn't ship undetected again.
    if (!transcriptPath) {
      try { process.stderr.write(`[memesh session-summary] transcript_path absent in payload (keys: ${Object.keys(inputData).join(',')}); skipping capture\n`); } catch {}
      return exit0();
    }
    if (!existsSync(transcriptPath)) {
      try { process.stderr.write(`[memesh session-summary] transcript_path ${transcriptPath} does not exist; skipping capture\n`); } catch {}
      return exit0();
    }

    // Parse transcript
    const { filesEdited, bashCommands, errorsEncountered, toolCallCount } = parseTranscript(transcriptPath);

    // Skip sessions with too little activity
    if (toolCallCount < 3) return exit0();

    // Hoisted to outer-try scope so the LLM failure-analysis block
    // below (which runs AFTER db.close()) can reference it. Earlier
    // version defined projectName inside the inner try-finally and the
    // LLM path threw `projectName is not defined` silently — caught by
    // the LLM try/catch but logged to stderr. Result: lesson_learned
    // creation never actually happened in production.
    const projectName = getProjectName(cwd);

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // sqlite-vec is loaded separately because only this hook needs it
    // (for embedding-aware recall-effectiveness tracking).
    const handle = openHookDb(process.env);
    if (!handle) {
      // Native module unavailable (plugin-marketplace cache install with no
      // node_modules). Skip session-capture work, but still let the
      // auto-update tail below run — auto-update is a separate concern from
      // session-capture, and a transient DB-availability blip should not
      // mask a security-override patch upgrade. Throwing this sentinel
      // routes through the existing catch, which already stderr-traces;
      // execution then falls through to runAutoUpdateAtStop().
      throw new Error('skip-session-capture: better-sqlite3 unavailable');
    }
    const { db } = handle;
    // sqlite-vec is also a native module; same plugin-cache scenario applies
    // (the cache tarball ships neither node_module). Resolve through a
    // try/require here so a missing vec module degrades the same way as a
    // missing better-sqlite3 instead of throwing into the outer catch as a
    // bug-shaped error.
    let sqliteVec;
    try {
      sqliteVec = require('sqlite-vec');
    } catch {
      throw new Error('skip-session-capture: sqlite-vec unavailable');
    }
    try {
      sqliteVec.load(db);

      // Duplicate detection: if we already captured this session, bail.
      //
      // Use the FULL session_id rather than the first 8 chars: real
      // Claude Code UUIDs collide on 8 chars only with cosmically small
      // probability, but artificial test IDs (verify-fix-001 vs -002)
      // share the prefix and silently skipped the second session
      // entirely. The contract is one stored capture per distinct
      // session_id, so the dedup key has to be the full id.
      const alreadyCaptured = db.prepare("SELECT id FROM entities WHERE name = ?").get(`session-${sessionId}-files`);
      if (alreadyCaptured) return exit0();

      // Build and store session memories
      const baseTags = ['source:auto-capture', `session:${sessionId}`, `project:${projectName}`];

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
          `session-${sessionId}-files`,
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
          `session-${sessionId}-fixes`,
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
          `session-${sessionId}-summary`,
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
        const sessionsDir = join(getMemeshDirFromDbPath(), 'sessions');
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
              } catch (err) {
                // statSync threw — file vanished between readdir and stat,
                // or perms changed mid-scan. Skip but trace.
                try { process.stderr.write(`[memesh session-summary] sessions-stat ${path}: ${err?.message || err}\n`); } catch {}
                return null;
              }
            })
            .filter(f => f && Date.now() - f.mtime < 60 * 60 * 1000) // within 1 hour
            .sort((a, b) => b.mtime - a.mtime); // newest first

          // Try to find matching project, otherwise use most recent
          for (const { path } of recentFiles) {
            try {
              const data = JSON.parse(readFileSync(path, 'utf8'));
              // Project match must be exact. The earlier
              // `|| recentFiles.length === 1` fallback caused
              // cross-project recall-effectiveness leakage: with two
              // concurrent Claude Code sessions in two repos, a
              // project-mismatched Stop hook would pick up the OTHER
              // project's entityIds and update THEIR hits/misses
              // against this transcript. Lose one session's tracking
              // rather than corrupt another's.
              if (data.project === projectName) {
                injectedData = data;
                // Delete after reading to prevent reuse
                require('fs').unlinkSync(path);
                break;
              }
            } catch (err) {
              // Three failure modes share this catch: JSON.parse on a
              // corrupt session file, readFileSync on a perm-changed file,
              // unlinkSync after read. Trace each so a silent unlink
              // failure (which would re-count the same session) is
              // visible. Loop continues to the next file regardless.
              try { process.stderr.write(`[memesh session-summary] sessions-read ${path}: ${err?.message || err}\n`); } catch {}
            }
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
      } catch (err) {
        // Recall-effectiveness DB write failed. Silently dropping this
        // converges impact scores to 0.5 (neutral) for every entity, which
        // is the main signal core/scoring.ts uses to demote ignored
        // memories — a real-world UX issue. Trace to stderr so a typo or
        // missing-column failure is visible without crashing the hook.
        try { process.stderr.write(`[memesh session-summary] recall-effectiveness write: ${err?.message || err}\n`); } catch {}
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
        // See `resolvePluginRoot` for the full reasoning.
        const pluginRoot = resolvePluginRoot(import.meta.url);
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
      } catch (llmErr) {
        // LLM analysis failed — rule-based extraction already captured the session.
        // Log to stderr so config issues (e.g. invalid API key) are visible.
        try { process.stderr.write(`[memesh] LLM failure analysis skipped: ${llmErr?.message || llmErr}\n`); } catch {}
      }
    }
  } catch (err) {
    // Never crash Claude Code — leave a trace for debugging.
    // Suppress the expected "skip-session-capture" sentinel (raised when
    // better-sqlite3 is unavailable in a marketplace-cache install). All
    // other errors are real bugs and deserve a trace.
    if (!String(err?.message || '').startsWith('skip-session-capture:')) {
      try { process.stderr.write(`[memesh session-summary] ${err?.message || err}\n`); } catch {}
    }
  }

  // Spawn auto-update if policy + cache permit. Runs after all session work
  // so npm install -g doesn't overwrite dist/ while peer hooks are reading it.
  await runAutoUpdateAtStop();

  // Silent output — don't clutter Claude's response
  console.log(JSON.stringify({ suppressOutput: true }));
  exit0();
});

function exit0() {
  process.exit(0);
}
