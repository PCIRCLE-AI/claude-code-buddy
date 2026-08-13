#!/usr/bin/env node

// Session Auto-Capture — Stop hook
// Extracts knowledge from completed Claude Code sessions
// and stores as session-insight entities in MeMesh.
//
// THIS HOOK STAYS, and that was an open question rather than an assumption.
// `dream run --from-transcripts` reads the same sessions from their raw JSONL
// and does not depend on this hook having fired, so the obvious next step was
// to retire the hook as redundant. Measured first, on a real graph
// (2026-08-09, 214 active entities, ollama nomic-embed-text, L2 over the same
// `name + observations` text the runtime embeds):
//
//   every transcript-mined memory -> its nearest hook-captured entity
//     min 0.784   p25 0.821   p50 0.865   max 0.946
//     within 0.55: 0 of 47.   within 0.70: 0 of 47.
//
// Nothing the transcript miner produced came within 0.78 of anything this hook
// recorded. They are not two views of the same material: this hook records what
// HAPPENED (files touched, commands run, commits), the miner extracts what was
// DECIDED and what was LEARNED. Retiring either one loses a whole category.

import { createRequire } from 'module';
import { basename, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { spawn } from 'child_process';
import os from 'os';
import { pathToFileURL } from 'url';
import {
  AUTO_CAPTURE_TAG,
  captureEntity,
  decideAutoUpdateHook,
  getMemeshDirFromDbPath,
  getProjectName,
  importFromPluginRoot,
  isAutoCaptureEnabled,
  openHookDb,
  readUpdateCheckCache,
  recordHookRun,
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
        // Skip malformed JSONL lines — benign, per-line, deliberately not traced.
      }
    }
  } catch (err) {
    // The transcript file itself could not be read, which empties this
    // session's entire capture — filesEdited/errors/toolCallCount all return
    // zero, so downstream `toolCallCount < 3` bails and no session insight,
    // failure analysis or lesson is produced. An absent file is the normal
    // "not written yet" case; anything else is a real fault worth a trace.
    if (err?.code !== 'ENOENT') {
      try {
        process.stderr.write(
          `[memesh session-summary] transcript ${transcriptPath} unreadable ` +
            `(${err?.message || err}); session capture skipped this run.\n`,
        );
      } catch { /* stderr must never throw */ }
    }
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

    // `cwd` decides the project tag, and the project tag decides which
    // sessions `session-start` injects and which memories `pre-edit-recall`
    // surfaces. Falling back to `process.cwd()` — the hook process's launch
    // directory, which is unspecified for a Stop hook — tagged the session with
    // whatever happened to be current. Measured: a payload with no `cwd` filed
    // the whole session under `project:memesh-llm-memory`, a project it had
    // nothing to do with, silently. That leaks one project's file names, bash
    // commands and error text into another project's context.
    //
    // `post-commit` refuses this exact case and says why: better to miss one
    // capture than to file it under the wrong project. Same rule here.
    if (!inputData.cwd) {
      try { process.stderr.write(`[memesh session-summary] cwd absent in payload (keys: ${Object.keys(inputData).join(',')}); cannot resolve project, skipping capture\n`); } catch {}
      return exit0();
    }
    const cwd = inputData.cwd;
    // Default-allow: when Claude Code's Stop payload omits
    // `was_in_agentic_loop` (it has been silently absent in production
    // for an unknown number of releases — symptom: zero session-insight
    // entities written despite hooks otherwise wired correctly), fall
    // back to "treat as agentic" so the toolCallCount<3 guard below is
    // the real low-signal filter. Earlier this field was a hard gate
    // (default-deny) and the hook silently never captured anything.
    const wasAgenticLoop = inputData.was_in_agentic_loop !== false;

    // Guards: skip low-signal sessions.
    //
    // A `stop_reason === 'user_interrupt'` guard used to live here, but
    // Claude Code's Stop payload carries no `stop_reason` field — verified
    // against the shipped cli.js bundle, whose Stop input is
    // `{...base, hook_event_name:"Stop", stop_hook_active}` with no such key
    // (the `stop_reason` that appears in the bundle is the Anthropic API
    // message field, not a hook input). So the guard read `undefined`, was
    // always false, and never skipped anything — a filter that looked active
    // but did nothing, the exact sibling of the `was_in_agentic_loop` absence
    // above. Removed; the `toolCallCount < 3` check below is the real
    // low-signal filter.
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
    // { fts: true } guarantees the entities_fts table exists so captureEntity()
    // can keep it in sync — session-insight memories must be FTS-recallable.
    //
    // sqlite-vec is NOT loaded here, and used to be. The comment said it was
    // needed "for embedding-aware recall-effectiveness tracking" — but this
    // hook runs exactly two statements, `PRAGMA table_info(entities)` and
    // `SELECT id FROM entities WHERE name = ?`, and `captureEntity` in
    // _shared.js touches no vectors either. Nothing here has ever used the
    // extension.
    //
    // It was not free. sqlite-vec ships its engine as a per-platform file
    // through optionalDependencies, and on a platform it does not publish the
    // load threw — past the `require` guard, which never fired because the JS
    // wrapper resolves fine and the throw happens later inside
    // `sqliteVec.load()`. Measured with the platform binary hidden: the whole
    // Stop capture vanished (0 entities against a control run's 1) and the
    // user got a `Require stack:` dump on stderr. An extension nobody calls
    // was silently costing every session on those platforms its memory.
    const { db } = openHookDb(process.env, { fts: true });
    try {
      // Duplicate detection: if we already captured this session, bail.
      //
      // Use the FULL session_id rather than the first 8 chars: real
      // Claude Code UUIDs collide on 8 chars only with cosmically small
      // probability, but artificial test IDs (verify-fix-001 vs -002)
      // share the prefix and silently skipped the second session
      // entirely. The contract is one stored capture per distinct
      // session_id, so the dedup key has to be the full id.
      //
      // A dedup bail is a SUCCESSFUL run — the loop executed and correctly
      // decided there was nothing to do — so it stamps the heartbeat like
      // the capture path below does. Only a throw leaves no stamp.
      const alreadyCaptured = db.prepare("SELECT id FROM entities WHERE name = ?").get(`session-${sessionId}-files`);
      if (alreadyCaptured) {
        recordHookRun(db, 'session-summary');
        return exit0();
      }

      // Build and store session memories
      const baseTags = [AUTO_CAPTURE_TAG, `session:${sessionId}`, `project:${projectName}`];

      // Producer for pre-edit-recall's Strategy 1 (`file:<name>` tag lookup).
      // That read path queries both the full basename and the extension-less
      // form (`file:auth.ts` OR `file:auth`), but nothing ever WROTE these
      // tags — on every real DB the query returned zero rows and the strategy
      // was dead. Emitting both forms here lights it up: a memory captured while
      // editing a file becomes findable the next time that file is edited.
      // filesEdited already holds basenames (see parseTranscript).
      function fileTagsFor(files) {
        const tags = new Set();
        for (const f of files) {
          if (!f) continue;
          tags.add(`file:${f}`);
          const noExt = f.replace(/\.[^.]+$/, '');
          if (noExt && noExt !== f) tags.add(`file:${noExt}`);
        }
        return [...tags];
      }

      // Delegate the write to the shared captureEntity() so entities land in
      // entities_fts too. This copy used to insert entity + observations + tags
      // only, skipping the FTS reindex the sibling hooks did — which left every
      // session-insight memory unrecallable via the FTS keyword path.
      function storeMemory(name, type, observations, tags) {
        captureEntity(db, { name, type, observations, tags });
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
          [...baseTags, ...fileTagsFor(filesEdited)]
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
          [...baseTags, 'type:bugfix', ...fileTagsFor(filesEdited)]
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
              // Drop the records Claude Code created FROM our own hook
              // output before matching. One SessionStart injection lands in
              // the transcript 2+ times (hook_success + hook_additional_context),
              // so any count-based discount depends on guessing an
              // undocumented internal — get it wrong and every entity scores
              // a hit instead of a miss. Structural removal is copy-count
              // and encoding independent.
              const sessionText = stripHookEchoes(readFileSync(transcriptPath, 'utf8')).toLowerCase();

              // Hit/miss decision lives in `isRecallHit` (exported, unit-tested).

              const updateHit = db.prepare(
                'UPDATE entities SET recall_hits = COALESCE(recall_hits, 0) + 1 WHERE id = ?'
              );
              const updateMiss = db.prepare(
                'UPDATE entities SET recall_misses = COALESCE(recall_misses, 0) + 1 WHERE id = ?'
              );

              for (let i = 0; i < entityIds.length; i++) {
                const name = (entityNames[i] || '').toLowerCase();
                // Skip names that carry no recall signal: too short, or a
                // machine identifier (auto-capture entities) that can never
                // substring-match prose. Scoring those would be a guaranteed
                // unearned miss — see isMeasurableRecallName.
                if (!isMeasurableRecallName(name)) continue;
                if (isRecallHit(sessionText, name)) {
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

      // Heartbeat AFTER capture, so the stamp certifies "the capture loop
      // completed", not "a database handle existed". A throw above skips it.
      // (The recall-effectiveness block catches its own errors — session
      // memories were already stored by then, so the run still counts.)
      recordHookRun(db, 'session-summary');
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
        const configMod = await importFromPluginRoot(pluginRoot, 'dist/core/config.js');
        const config = configMod.readConfig();

        if (config.llm) {
          const { openDatabase, closeDatabase } = await importFromPluginRoot(pluginRoot, 'dist/db.js');
          const { analyzeFailure } = await importFromPluginRoot(pluginRoot, 'dist/core/failure-analyzer.js');
          const { createLesson } = await importFromPluginRoot(pluginRoot, 'dist/core/lesson-engine.js');

          openDatabase();
          try {
            // Pass cross-provider failover chain so a stale Anthropic key
            // doesn't silently disable Stop-hook lesson generation.
            const lesson = await analyzeFailure(errorsEncountered, filesEdited, config.llm, { fallbacks: config.llmFallbacks });
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

    // Auto-trigger dream — solves the "Insights tab is empty for users
    // who don't know `memesh dream run` exists" problem. Throttled to
    // once per project per 24h, gated by minimum activity threshold.
    // Background-detached spawn so the hook exits immediately even if
    // the LLM call takes 30-60s. See `maybeTriggerDream` for the gate
    // logic and dream-history.json schema.
    try {
      const pluginRoot = resolvePluginRoot(import.meta.url);
      const configMod = await importFromPluginRoot(pluginRoot, 'dist/core/config.js');
      const config = configMod.readConfig();
      maybeTriggerDream(projectName, config, pluginRoot);
    } catch (dreamErr) {
      try { process.stderr.write(`[memesh] dream auto-trigger skipped: ${dreamErr?.message || dreamErr}\n`); } catch {}
    }
  } catch (err) {
    // Never crash Claude Code — leave a trace for debugging.
    //
    // Every error is traced now. There used to be a suppression branch for a
    // `skip-session-capture:` sentinel, thrown when sqlite-vec was missing —
    // an extension this hook never used. The thrower is gone, so the branch
    // could only ever hide a real error from here on.
    try { process.stderr.write(`[memesh session-summary] ${err?.message || err}\n`); } catch {}
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

// =============================================================================
// Dream auto-trigger (Phase 2 / Phase 3 background runner)
// =============================================================================
//
// Without an automated trigger, `memesh dream` only runs when the user
// types it into a terminal — and most users never read the docs that
// far. Result: Insights tab stays empty and the KG accumulates 89.7%
// orphan rate (the maintainer's own observation on this DB).
//
// This trigger fires at the END of every Stop hook (after rule-based
// session capture + optional LLM failure analysis). It:
//   1. Loads ~/.memesh/dream-history.json — a per-project record of
//      the last dream run timestamp + outcome.
//   2. Throttles: skip if < THROTTLE_HOURS since the project's last
//      run, even if the previous run produced zero proposals.
//   3. Activity gate: skip if the project has < MIN_EPISODIC episodic
//      entities to draw from in the last WINDOW_DAYS days.
//   4. LLM gate: skip if no LLM provider configured (Phase 2 needs
//      Smart Mode — Phase 3 patterns same).
//   5. Spawns `node <pluginRoot>/dist/transports/cli/cli.js dream run
//      --project <name> --max-llm-calls 2 --window-days 14` as a
//      detached child process. Stdout/stderr go to a per-project log
//      under ~/.memesh/dream-runs/ so the user can `tail -f` to see
//      progress without the hook blocking.
//   6. Records the run start in dream-history.json BEFORE spawning so
//      a long-running spawn doesn't get re-triggered on the next
//      Stop within the same window.
//
// The spawned process inherits config from disk, including the
// `llmFallbacks` chain wired in commit 883abd4d, so a primary
// outage falls through to Ollama automatically.

const DREAM_THROTTLE_HOURS = 24;
const DREAM_MIN_EPISODIC = 10;
const DREAM_WINDOW_DAYS = 14;
const DREAM_MAX_LLM_CALLS = 2;
const DREAM_HISTORY_BASENAME = 'dream-history.json';
const DREAM_LOG_DIRNAME = 'dream-runs';

const DREAM_EPISODIC_TYPES = [
  'commit',
  'session_keypoint',
  'session-insight',
  'workflow_checkpoint',
  'weekly-summary',
  'weekly_summary',
];

// Debug-trace gate. Set MEMESH_DREAM_TRIGGER_DEBUG=1 to emit a stderr
// breadcrumb at every gate decision in maybeTriggerDream. Contract:
//   [memesh dream-trigger] <stage>=<value>...
// Matches one line per stage (resolve, llm-gate, throttle-gate,
// activity-gate, history-write, spawn). Stable across releases — if
// you rename a stage, update the matching test fixture too.
function dreamTrigTrace(stage, fields) {
  if (process.env.MEMESH_DREAM_TRIGGER_DEBUG !== '1') return;
  try {
    const parts = Object.entries(fields || {}).map(([k, v]) => {
      if (v === undefined) return `${k}=<undef>`;
      if (v === null) return `${k}=<null>`;
      return `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`;
    });
    process.stderr.write(`[memesh dream-trigger] ${stage} ${parts.join(' ')}\n`);
  } catch {}
}

function dreamHistoryPath() {
  // Test isolation: tests set MEMESH_DB_PATH to a tmp file, expecting
  // sibling state (history, logs) to land beside it. Without honouring
  // that, real-home `~/.memesh/dream-history.json` would be polluted
  // by every test run. Same precedence as memesh's other state files —
  // see `getMemeshDirFromDbPath` in `_shared.js`.
  //
  // Windows note: on Windows under execFileSync, env vars propagate as
  // plain strings (no canonicalisation). If a caller passed MEMESH_DIR
  // with mixed separators (e.g. `C:/Users/.../tmp/.memesh`), join() will
  // happily mix `/` and `\`. Node fs accepts either — the only divergence
  // is in pure string comparisons, which we don't do here. The trace
  // below shows the resolved value verbatim so a Windows diagnosis run
  // can confirm what actually arrived.
  const fromEnv = process.env.MEMESH_DIR;
  const fromDbPath = !fromEnv ? getMemeshDirFromDbPath() : null;
  const fromHome = (!fromEnv && !fromDbPath)
    ? join(os.homedir() || (os.userInfo()?.homedir ?? '.'), '.memesh')
    : null;
  const dir = fromEnv || fromDbPath || fromHome;
  dreamTrigTrace('resolve', {
    src: fromEnv ? 'env' : (fromDbPath ? 'db-path' : 'home'),
    MEMESH_DIR: fromEnv,
    MEMESH_DB_PATH: process.env.MEMESH_DB_PATH,
    dir,
    platform: process.platform,
  });
  return { dir, historyFile: join(dir, DREAM_HISTORY_BASENAME), logDir: join(dir, DREAM_LOG_DIRNAME) };
}

function readDreamHistory() {
  try {
    const { historyFile } = dreamHistoryPath();
    if (!existsSync(historyFile)) return {};
    const raw = readFileSync(historyFile, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

function writeDreamHistory(history) {
  try {
    const { dir, historyFile } = dreamHistoryPath();
    mkdirSync(dir, { recursive: true });
    writeFileSync(historyFile, JSON.stringify(history, null, 2));
    dreamTrigTrace('history-write', { historyFile, ok: true, projects: Object.keys(history) });
  } catch (err) {
    dreamTrigTrace('history-write', { ok: false, err: err?.message || String(err) });
    try { process.stderr.write(`[memesh dream-history write] ${err?.message || err}\n`); } catch {}
  }
}

/**
 * Count episodic entities for the given project over the configured
 * window. Read-only — uses the hook's _shared openHookDb helper which
 * is already on the import path.
 */
function countEpisodicEntities(projectName) {
  let handle;
  try {
    handle = openHookDb();
    // { db, dbPath } — don't call db.prepare() on the wrapper itself (an
    // earlier version did, and silently skipped the gate, defeating the
    // trigger's whole purpose).
    const db = handle.db;
    const since = new Date(Date.now() - DREAM_WINDOW_DAYS * 86400000).toISOString();
    const types = DREAM_EPISODIC_TYPES.map(() => '?').join(',');
    // Project-membership is determined by the `project:<name>` tag only.
    // The previous implementation also OR'd on `e.name LIKE 'project-%'`
    // as a fallback for legacy entities, but that branch over-counts when
    // two projects share a name prefix (e.g. counting `memesh` would
    // sweep in `memesh-cloud-keypoint-*` entities). Post-v3.0 episodic
    // entities all carry the project tag — the auto-tagger writes it on
    // every session_keypoint / commit / session_insight / session_lesson
    // / failure_pattern / decision_anchor — so the tag-only path is the
    // accurate signal. See v4.2.1 CHANGELOG known-limitations note.
    const sql = `SELECT COUNT(DISTINCT e.id) AS n
                 FROM entities e
                 INNER JOIN tags t ON t.entity_id = e.id AND t.tag = ?
                 WHERE e.status = 'active'
                   AND e.type IN (${types})
                   AND e.created_at >= ?`;
    const projectTag = `project:${projectName}`;
    const row = db.prepare(sql).get(projectTag, ...DREAM_EPISODIC_TYPES, since);
    return row?.n ?? 0;
  } catch (err) {
    try { process.stderr.write(`[memesh dream-trigger count] ${err?.message || err}\n`); } catch {}
    return 0;
  } finally {
    try { handle?.db?.close(); } catch {}
  }
}

/**
 * Decide whether to fire dream for `projectName` and, if so, spawn
 * the detached background runner. Pure side effect — no return value
 * used by callers.
 */
/**
 * Attachment record types Claude Code uses to persist a hook's own output
 * into the transcript. Anything memesh injected reaches the transcript
 * through one of these, so they must be removed before asking "did the
 * session reference this memory?".
 *
 * Verified against Claude Code v2.1.19: ONE SessionStart injection lands in
 * the transcript at least twice — once as `hook_success` (carrying the raw
 * hook stdout) and once as `hook_additional_context` (the parsed payload).
 */
const HOOK_ECHO_ATTACHMENT_TYPES = new Set([
  'hook_success',
  'hook_additional_context',
  'hook_system_message',
]);

/**
 * Remove memesh's own injected text from a raw JSONL transcript.
 *
 * Counting occurrences and subtracting the injected copies does NOT work:
 * it depends on knowing exactly how many times Claude Code echoes a hook
 * payload, which is an undocumented internal that has already been observed
 * at 2+ copies (and 16 in one real transcript). Guessing that constant is
 * how "every entity is a miss" becomes "every entity is a hit" — equally
 * useless, and invisible to a hand-built test fixture.
 *
 * Dropping the hook-echo records structurally is independent of both the
 * copy count and the JSON escaping.
 */
export function stripHookEchoes(rawTranscript) {
  const kept = [];
  for (const line of String(rawTranscript ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Unparseable line: keep it. Losing a line can only cause a false
      // MISS (we under-count references), which is the safe direction —
      // it never manufactures a hit the session did not earn.
      kept.push(line);
      continue;
    }
    const type = entry?.attachment?.type ?? entry?.type;
    if (typeof type === 'string' && HOOK_ECHO_ATTACHMENT_TYPES.has(type)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Did the session actually USE the memory named `name`, or does the name only
 * appear because memesh injected it at session start?
 *
 * The caller passes `sessionText` with memesh's own SessionStart injection
 * already stripped structurally (see `stripHookEchoes` — matches on
 * `attachment.type`, so it is independent of JSON escaping and of how many
 * times Claude Code echoes one injection). That removal is what stops an
 * injected name from scoring a false hit; once the echo is gone, a plain
 * substring match is the whole test.
 *
 * (This replaced an earlier `transcript.replace(injectedBlob, '')` + match,
 * which silently failed on JSON-encoded transcripts and scored every entity a
 * hit — see the callsite comment.)
 *
 * Self-contained for its unit tests: lowercases both sides and ignores names
 * shorter than 4 chars (too generic to match reliably).
 */
export function isRecallHit(sessionText, name) {
  if (!name || name.length < 4) return false;
  return String(sessionText ?? '').toLowerCase().includes(String(name).toLowerCase());
}

/**
 * Whether an injected entity's NAME can serve as a recall-effectiveness signal.
 *
 * Recall-effectiveness decides "was this injected memory used?" by substring-
 * matching the entity NAME in the session transcript (isRecallHit). That only
 * works for names a human might type. Auto-capture entities are named with
 * machine identifiers — `session-<pid>-<ts>-files`, `commit-<hash>`,
 * `pre-compact-<id>` — which never appear verbatim in conversation prose, so
 * they take a `recall_miss` they didn't earn on every injection. Over repeated
 * sessions that drags their Laplace-smoothed impact factor (scoring.ts, 10%
 * weight) down and quietly suppresses auto-captured memories from future recall.
 *
 * We can't measure their usefulness by name, so we don't count them either way —
 * they keep the neutral 0.5 impact. The prefix set is coupled to the auto-capture
 * producers' `<kind>-<id>` naming (post-commit / session-summary / pre-compact);
 * a new auto-capture producer should add its prefix here.
 */
export function isMeasurableRecallName(name) {
  if (!name || name.length < 4) return false;
  return !/^(session-|commit-|pre-compact-)/i.test(name);
}

export function maybeTriggerDream(projectName, config, pluginRoot) {
  dreamTrigTrace('enter', { projectName, hasLlm: Boolean(config?.llm) });
  if (!projectName || projectName === 'unknown') {
    dreamTrigTrace('exit', { reason: 'no-project-name', projectName });
    return;
  }

  // Phase 2 & 3 both need a configured LLM. Without it the dreamer's
  // first action is to push `{reason: 'no LLM configured'}` into
  // skipped[] and exit, which would still bump our throttle clock
  // for no value — so gate here.
  if (!config?.llm) {
    dreamTrigTrace('exit', { reason: 'llm-gate-fail' });
    return;
  }
  dreamTrigTrace('llm-gate', { ok: true });

  const history = readDreamHistory();
  const last = history[projectName];
  if (last?.last_run_iso) {
    const ageMs = Date.now() - new Date(last.last_run_iso).getTime();
    if (Number.isFinite(ageMs) && ageMs < DREAM_THROTTLE_HOURS * 3600 * 1000) {
      dreamTrigTrace('exit', { reason: 'throttle-gate-fail', ageMs, last_run_iso: last.last_run_iso });
      return; // throttled
    }
  }
  dreamTrigTrace('throttle-gate', { ok: true, prior_last_run_iso: last?.last_run_iso });

  const episodicCount = countEpisodicEntities(projectName);
  if (episodicCount < DREAM_MIN_EPISODIC) {
    dreamTrigTrace('exit', { reason: 'activity-gate-fail', episodicCount, threshold: DREAM_MIN_EPISODIC });
    return;
  }
  dreamTrigTrace('activity-gate', { ok: true, episodicCount });

  // Activity gate passed — record start BEFORE spawning so we don't
  // re-trigger on any subsequent Stop within the window even if the
  // child takes 30-60s.
  history[projectName] = {
    last_run_iso: new Date().toISOString(),
    last_episodic_count: episodicCount,
    last_window_days: DREAM_WINDOW_DAYS,
  };
  writeDreamHistory(history);

  // Spawn detached so the hook exits immediately. Stdio routes to a
  // per-project log file so the user can inspect dream output without
  // the hook blocking on the LLM call.
  try {
    const { dir, logDir } = dreamHistoryPath();
    mkdirSync(logDir, { recursive: true });
    const safeProj = projectName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFile = join(logDir, `${safeProj}-${ts}.log`);

    // Append a header so a tail -f shows context for the run.
    appendFileSync(logFile, `[memesh dream] ${new Date().toISOString()} project=${projectName} episodic_count=${episodicCount} window=${DREAM_WINDOW_DAYS}d max_llm_calls=${DREAM_MAX_LLM_CALLS}\n`);

    const cliPath = join(pluginRoot, 'dist/transports/cli/cli.js');
    if (!existsSync(cliPath)) {
      appendFileSync(logFile, `[memesh dream] cli.js missing at ${cliPath}, skipping\n`);
      return;
    }

    const args = [
      cliPath, 'dream', 'run',
      '--project', projectName,
      '--max-llm-calls', String(DREAM_MAX_LLM_CALLS),
      '--window-days', String(DREAM_WINDOW_DAYS),
    ];

    const logFd = require('fs').openSync(logFile, 'a');
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, MEMESH_DIR: dir },
    });
    child.unref();
    dreamTrigTrace('spawn', { ok: true, pid: child.pid, logFile, MEMESH_DIR: dir });
  } catch (err) {
    dreamTrigTrace('spawn', { ok: false, err: err?.message || String(err) });
    try { process.stderr.write(`[memesh dream-trigger spawn] ${err?.message || err}\n`); } catch {}
  }
}
