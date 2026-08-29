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
import { pathToFileURL } from 'url';
import {
  AUTO_CAPTURE_TAG,
  captureEntity,
  decideAutoUpdateHook,
  extractCitedMemoryIds,
  getMemeshDirFromDbPath,
  getProjectName,
  importFromPluginRoot,
  isAutoCaptureEnabled,
  openHookDb,
  readUpdateCheckCache,
  redactSecrets,
  recordHookRun,
  stampHookRunOnly,
  resolveAutoUpdatePolicy,
  resolvePluginRoot,
  spawnAutoUpdate,
  truncateTitle,
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
 * Run auto-update at Stop hook: reads cache, evaluates policy, and dispatches
 * the detached updater runner if warranted. Runs after all session work
 * completes, avoiding the TOCTOU race where install would overwrite dist/
 * mid-session.
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
      await spawnAutoUpdate(decision.latest, _installChannelMod);
    }
  } catch {
    // Best-effort — never crash the hook.
  }
}

// Parse a JSONL transcript file.
// Handles the current Claude Code transcript format where tool_use/tool_result
// are nested inside assistant/user message entries, not top-level entries.
// Defensive: never throws — malformed lines are silently skipped.
/**
 * File paths a shell command writes in place. Recognises the shapes an
 * agent actually uses to edit without Write/Edit: heredoc redirection
 * (`> path <<'EOF'`, `cat > path`), `sed -i`, `tee`, and `pathlib.Path('x')
 * .write_text(` / `fs.writeFileSync('x'` inside an inline script. Returns
 * basenames' sources; the caller keeps basename() as the stored form.
 */
function bashEditedPaths(cmd) {
  if (typeof cmd !== 'string') return [];
  const found = new Set();
  const add = (m) => { if (m && m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/')) found.add(m[1]); };
  for (const re of [
    /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/g,   // > file <<'EOF'
    /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/g,                            // cat > file
    /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/g,                      // tee file
    /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/g, // sed -i '...' file
    /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/g,           // pathlib write_text
    /writeFileSync\(\s*['"]([^'"]+)['"]/g,                        // fs.writeFileSync
  ]) {
    let m; while ((m = re.exec(cmd)) !== null) add(m);
  }
  return [...found];
}

function parseTranscript(transcriptPath) {
  const filesEdited = new Set();
  const bashCommands = [];
  const errorsEncountered = [];
  let toolCallCount = 0;
  let readFailed = false;
  // The raw file content, returned so downstream consumers (the
  // recall-effectiveness block) reuse this single read instead of a second
  // readFileSync — real transcripts reach 47MB, so a second full read plus
  // re-parse doubles the Stop hook's dominant I/O cost.
  let rawText = '';

  try {
    rawText = readFileSync(transcriptPath, 'utf8');
    const lines = rawText.split('\n').filter(l => l.trim());
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
              // A session that edits through Bash — heredocs, sed -i, a
              // short python script — never produces a Write/Edit block, so
              // `filesEdited` stayed empty and the summary asserted "0 files
              // edited" for a session that edited a dozen. The count also
              // drives the re-capture guard below, so the same gap made the
              // -summary entity re-append on every Stop (#240). Recognise the
              // common in-place write shapes; anything not matched is simply
              // uncounted, which is honest — it is not asserted as zero.
              for (const fp of bashEditedPaths(cmd)) filesEdited.add(basename(fp));
              if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
                // Redact BEFORE truncating. A bash command line is the single
                // most likely place a credential appears in a transcript
                // (`export ANTHROPIC_API_KEY=sk-...`, `curl -H "Authorization:
                // Bearer ..."`), and this text is stored verbatim as an
                // observation — a permanent, searchable, exportable copy.
                // Truncating first would cut a token in half and leave the
                // fragment unmatched by every pattern.
                bashCommands.push(redactSecrets(cmd).slice(0, 100));
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
            // Same reason as the bash branch, and one more: this array is
            // ALSO the payload `analyzeFailure` sends to the configured LLM
            // provider. A failed request that echoes its own Authorization
            // header — the ordinary shape of an auth error — would be stored
            // and then transmitted off the machine. Redacted once here, at
            // the point the text enters the process, so every downstream use
            // inherits it.
            errorsEncountered.push(redactSecrets(text).slice(0, 200));
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
    // zero. Left unflagged, those zeros are indistinguishable from a
    // genuinely quiet session, and the light-session bail downstream would
    // STAMP the heartbeat — repeated permission/I-O failures keeping doctor
    // green while every session's capture is lost. `readFailed` is the
    // distinct signal: capture was lost, not skipped. An absent file
    // (ENOENT) is the vanished-transcript race, which the caller already
    // treats as a correct nothing-to-do decision.
    if (err?.code !== 'ENOENT') {
      readFailed = true;
      try {
        process.stderr.write(
          `[memesh session-summary] transcript ${transcriptPath} unreadable ` +
            `(${err?.message || err}); session capture skipped this run.\n`,
        );
      } catch { /* stderr must never throw */ }
    }
  }

  return { filesEdited: [...filesEdited], bashCommands, errorsEncountered, toolCallCount, readFailed, rawText };
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
    // From here down the payload is well-formed and attributable — every
    // bail is the hook deciding "nothing worth saving", which is a
    // successful run and stamps the heartbeat. The bails ABOVE this line
    // (empty stdin, malformed JSON, missing cwd) are schema-flip shapes: if
    // Claude Code's payload changed under us, capture is effectively dead,
    // and a heartbeat would mask exactly that.
    if (!wasAgenticLoop) { stampHookRunOnly(process.env, 'session-summary'); return exit0(); }
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
      // The payload named a transcript and the FILE is gone (log rotation
      // race) — the hook itself ran fine, so this stamps. A payload that
      // never carried the field at all (schema flip) bails above, unstamped.
      stampHookRunOnly(process.env, 'session-summary');
      return exit0();
    }

    // Parse transcript (single read — rawText is reused by the
    // recall-effectiveness block below)
    const { filesEdited, bashCommands, errorsEncountered, toolCallCount, readFailed, rawText: transcriptRawText } = parseTranscript(transcriptPath);

    // An unreadable transcript is NOT a quiet session: the capture was
    // LOST (permissions, I/O), and a heartbeat here would keep doctor green
    // through exactly the repeated failure it exists to expose. No stamp —
    // parseTranscript already traced the fault to stderr.
    if (readFailed) return exit0();

    // Skip sessions with too little activity — the single most common
    // healthy exit, so it MUST stamp (see stampHookRunOnly).
    if (toolCallCount < 3) { stampHookRunOnly(process.env, 'session-summary'); return exit0(); }

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
    let writeFailed = false;
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
      // Guard on ANY of this session's three entities, not only `-files`.
      // A Bash-only session created no `-files` row, so the guard never
      // tripped and `-summary` was re-appended on every Stop — measured: 56
      // observations, 16 unique, three commands stored fourteen times each.
      const alreadyCaptured = db.prepare(
        "SELECT id FROM entities WHERE name IN (?, ?, ?) LIMIT 1",
      ).get(`session-${sessionId}-files`, `session-${sessionId}-fixes`, `session-${sessionId}-summary`);
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
      function storeMemory(name, type, observations, tags, title) {
        // null = the entity row could not be resolved = this write did NOT
        // happen (captureEntity's contract). A run with a failed write must
        // not stamp the heartbeat below — "alive" would be a lie about the
        // exact thing the heartbeat certifies.
        if (!captureEntity(db, { name, type, observations, tags, title })) writeFailed = true;
      }

      // No free-form human text exists for these three entities the way a
      // commit subject does — title is synthesized from the same structured
      // counts the observations already report. date+project+verb, per the
      // heuristic the design settled on for hooks with no natural title source.
      const titleDate = new Date().toISOString().slice(0, 10);
      const titlePrefix = `${titleDate} ${projectName}`;

      // Rule 1: File editing session summary
      if (filesEdited.length > 0) {
        storeMemory(
          `session-${sessionId}-files`,
          'session-insight',
          [
            `Session edited ${filesEdited.length} file(s): ${filesEdited.join(', ')}`,
            `Total tool calls: ${toolCallCount}`,
          ],
          [...baseTags, ...fileTagsFor(filesEdited)],
          truncateTitle(`${titlePrefix}: edited ${filesEdited.length} file(s)`)
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
          [...baseTags, 'type:bugfix', ...fileTagsFor(filesEdited)],
          truncateTitle(`${titlePrefix}: fixed ${errorsEncountered.length} error(s)`)
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
          [...baseTags, 'type:heavy-session'],
          truncateTitle(`${titlePrefix}: significant session (${toolCallCount} tool calls)`)
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
          const { entityIds } = injectedData;

          if (entityIds && entityIds.length > 0) {
            // Check if recall_hits column exists (v4.0+ migration)
            const colCheck = db.prepare("PRAGMA table_info(entities)").all();
            if (colCheck.some(c => c.name === 'recall_hits')) {
              // Drop the records Claude Code created FROM our own hook
              // output before scanning: the injected block itself prints a
              // `[mem:id]` handle on every line, and counting those would
              // score every injection as a hit. Structural removal is
              // copy-count and encoding independent. Reuse the raw text
              // parseTranscript already read — a second readFileSync
              // doubles the Stop hook's I/O on 47MB transcripts.
              const sessionText = stripHookEchoes(transcriptRawText);

              // Citation accounting. A hit is an EXPLICIT `[mem:id]` marker
              // the agent wrote for an id this session injected — the
              // instruction line session-start appends after the fenced
              // block. Literal-content matching (the previous accounting)
              // was retired after measuring 0% signal across ten real
              // sessions and three matching strategies: every injected
              // memory drifted toward an unearned recall_miss, and misses
              // feed the impact factor in core ranking.
              //
              // Markers are self-reported: an agent that used a memory
              // silently earns it nothing, so the signal UNDERCOUNTS and
              // never overcounts. That asymmetry is why misses are FROZEN —
              // recall_misses stays untouched until measured marker
              // compliance (the counters below) justifies reading silence
              // as non-use. The mode stamp keeps the two eras of numbers
              // apart.
              const cited = extractCitedMemoryIds(sessionText);
              const updateHit = db.prepare(
                'UPDATE entities SET recall_hits = COALESCE(recall_hits, 0) + 1 WHERE id = ?'
              );
              // Counted here, not recomputed below. The compliance
              // numerator and `recall_hits` have to be the SAME
              // measurement: `cited.size > 0` asked "did this transcript
              // contain any [mem:N] at all", which counts a marker for an id
              // this session never injected — one carried over from an
              // earlier turn, or a number the agent invented — as compliance.
              // The denominator counts sessions that received an injection,
              // so the two halves of the rate were answering different
              // questions.
              let injectedAndCited = 0;
              for (const id of entityIds) {
                if (cited.has(id)) {
                  updateHit.run(id);
                  injectedAndCited++;
                }
              }

              // Accounting-mode stamp (constant value, rewritten every
              // session so it survives DB restores from either era) plus
              // the compliance denominators: sessions that HAD an injection
              // vs sessions whose transcript carried any citation marker.
              db.prepare(
                'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
              ).run('recall_accounting_mode', 'citation-v1 since 2026-08-16');
              const bump = db.prepare(
                `INSERT INTO memesh_metadata (key, value) VALUES (?, '1')
                 ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
              );
              bump.run('citation_sessions_total');
              // Initialised unconditionally, then bumped. Writing it only on
              // a citation made "zero sessions cited" and "this code never
              // ran" the same absent key — and that is exactly what a real
              // database showed on 2026-08-24: total=4, cited absent, with
              // no way to tell a 0% compliance rate from a dead counter.
              db.prepare(
                `INSERT INTO memesh_metadata (key, value) VALUES ('citation_sessions_cited', '0')
                 ON CONFLICT(key) DO NOTHING`
              ).run();
              if (injectedAndCited > 0) bump.run('citation_sessions_cited');
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
      // completed", not "a database handle existed". A throw above skips it,
      // and so does a captureEntity null return (writeFailed) — a run whose
      // write did not land must not read as alive. (The recall-effectiveness
      // block catches its own errors — session memories were already stored
      // by then, so the run still counts.)
      if (!writeFailed) recordHookRun(db, 'session-summary');
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

  // Dispatch auto-update if policy + cache permit. Runs after all session work
  // so the runner cannot overwrite dist/ while peer hooks are reading it.
  await runAutoUpdateAtStop();

  // Emit NOTHING on success — not `{"suppressOutput": true}`.
  //
  // That field is valid Claude Code hook output, and it was doing no work:
  // this hook writes nothing else to stdout, so there was never any output
  // to suppress. But Codex CLI validates hook output per event against its
  // own schema, and rejects the field on Stop — reported from a live
  // Codex session as "hook returned invalid stop hook JSON output",
  // once per turn, with the capture itself having already succeeded.
  //
  // Empty stdout with exit 0 is the "no opinion" signal in BOTH contracts,
  // and it is what `validateHookOutput` already classifies as `kind: 'empty'`.
  // So the portable answer is silence, and the field's only remaining effect
  // was to fail one host for no benefit on the other.
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
  // The helper IS the precedence (MEMESH_DB_PATH > MEMESH_DIR > home).
  // A hand-rolled version here inverted it (MEMESH_DIR won over
  // MEMESH_DB_PATH), so with both set, dream history landed in a different
  // directory than every sibling state file — plus a dead home-fallback
  // branch, since the helper always returns a string.
  const dir = getMemeshDirFromDbPath();
  dreamTrigTrace('resolve', {
    src: process.env.MEMESH_DB_PATH ? 'db-path' : (process.env.MEMESH_DIR ? 'env' : 'home'),
    MEMESH_DIR: process.env.MEMESH_DIR,
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
 * window. Only issues a SELECT, but the handle is openHookDb's ordinary
 * read-write one (it runs the schema/migration chain) — there is no
 * read-only variant on the hook side, and this call site must not stamp
 * the heartbeat (recordHookRun is per-hook-exit, never per-open).
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
