#!/usr/bin/env node

import { basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import { AUTO_CAPTURE_TAG, captureEntity, getProjectName, isAutoCaptureEnabled, openHookDb, recordHookRun, truncateTitle } from './_shared.js';

// There is no in-process timeout guard, and its absence is deliberate.
//
// This file used to arm `setTimeout(() => process.exit(0), 10_000).unref()`.
// It could not fire. Everything after `stdin`'s `end` event is one
// synchronous block — no `await`, no callback — so the event loop never gets
// a turn between the handler starting and the process exiting, and a JS
// timer cannot interrupt a blocking SQLite call. The one window where it
// COULD have run is while stdin is still open, which is not where a hook
// hangs.
//
// The timeout that does work is external: `hooks/hooks.json` declares
// `"timeout": 10` for PreCompact, and the harness enforces it on the
// process. `openHookDb` additionally caps the SQLite lock wait at 2s so
// contention ends in a skipped capture rather than in that kill.

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
    // A payload with NEITHER a session id NOR a transcript is not a
    // PreCompact event — it used to fall through anyway, write a junk entity
    // whose only content was "Compaction reason: auto", report "Saved 2
    // observations", and that junk then surfaced in the next session's
    // context as a recent memory. A real session_id without a transcript
    // still records (that contract is pinned by the basic-scenario test).
    if (!data.session_id && !transcriptPath) {
      process.exit(0);
    }
    const cwd = data.cwd || process.cwd();
    // Claude Code's PreCompact payload names this field `trigger` ('manual' |
    // 'auto'), not `reason` — verified against the shipped cli.js bundle
    // (`hook_event_name:"PreCompact",trigger:A.trigger,custom_instructions:...`).
    // Reading `data.reason` silently recorded "Compaction reason: auto" for
    // every compaction, manual and automatic alike. `reason` is kept as a
    // defensive fallback in case an older CLI used it.
    const reason = data.trigger || data.reason || 'auto';
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
            // Claude Code transcript format: {type:'assistant', message:{content:[{type:'tool_use',...}]}}
            // The earlier legacy branch (entry.role === 'assistant', entry.content
            // at top level) was confirmed dead code via real-transcript audit:
            // no entry in production transcripts ever shipped that shape.
            // Removed to avoid confusion between two parsers that read
            // different fields for the same logical event.
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
          } catch {
            // Skip malformed lines — benign, per-line, deliberately not traced.
          }
        }
      } catch (err) {
        // existsSync passed above, so this is a REAL read failure (permission,
        // I/O, deleted mid-read), not a missing file. Left untraced, the hook
        // still reports "Saved 0 insights" — a success-shaped message hiding
        // that the whole pre-compaction capture was lost. Mirrors the trace
        // added to session-summary.js / extractor.ts for the same pattern.
        try {
          process.stderr.write(
            `[memesh pre-compact] transcript ${transcriptPath} unreadable ` +
              `(${err?.message || err}); saved 0 insights this compaction.\n`,
          );
        } catch { /* stderr must never throw */ }
      }
    }

    const entityName = `pre-compact-${sessionId}`;

    // Build observation content
    const obsLines = [`Compaction reason: ${reason}`, `Tool calls: ${toolCallCount}`];

    // No free-form human text exists for a pre-compact save (unlike a commit
    // subject) — same date+project+verb heuristic as session-summary.js.
    // This hook was the one missed by the original design (it hand-rolls the
    // same captureEntity dance as its two siblings but was overlooked as a
    // "write hook" until a code audit found it), so its entities were the
    // clearest case of a raw machine key (`pre-compact-<sessionId>`) with a
    // terse observation ("Compaction reason: manual") standing in as the
    // display label.
    const titleDate = new Date().toISOString().slice(0, 10);
    const title = truncateTitle(`${titleDate} ${projectName}: ${reason} compaction (${toolCallCount} tool calls)`);
    if (editedFiles.size > 0) {
      obsLines.push(`Files edited: ${Array.from(editedFiles).join(', ')}`);
    }

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // FTS5 needed for the entity-search index updates below.
    const { db } = openHookDb(process.env, { fts: true });
    let written = null;
    try {
      // Shared write dance — upsert entity + observations + tags AND reindex FTS
      // so the pre-compact memory is recallable via the FTS keyword path.
      written = captureEntity(db, {
        name: entityName,
        type: 'session-summary',
        observations: obsLines,
        tags: [AUTO_CAPTURE_TAG, 'urgency:pre-compact', `project:${projectName}`],
        title,
      });

      // Heartbeat AFTER capture, so the stamp certifies "the capture loop
      // completed", not "a database handle existed". A throw above skips it,
      // and so does a null return — captureEntity's null means the write did
      // not land, and this very hook tells the user "could not save" below;
      // stamping would say "alive" to doctor about the same failed run.
      if (written) recordHookRun(db, 'pre-compact');
    } finally {
      db.close();
    }

    // Claude Code defines `hookSpecificOutput` variants for a fixed set of
    // events only — PreToolUse, PostToolUse, PostToolUseFailure,
    // PermissionRequest, UserPromptSubmit, SessionStart, Setup,
    // SubagentStart, Notification. There is no PreCompact variant, so
    // emitting one fails schema validation at the root and shows the user a
    // "Hook JSON output validation failed" error on *every* compaction —
    // even though the save above already succeeded (#53).
    //
    // `systemMessage` is a valid top-level field for any event and carries
    // the same information to the user. The contract is asserted in
    // tests/helpers/hook-output-contract.ts; do not hand-roll a shape here.
    // Report what was WRITTEN, not what was counted. The old message printed a
    // count derived from the transcript, unconditionally, and discarded
    // `captureEntity`'s null return — the entity row could not be resolved — so
    // it announced a save that may not have happened, with a number that never
    // matched the one entity and handful of observations actually written.
    //
    // `written.observationsWritten` is the honest count, NOT `obsLines.length`:
    // a session compacts more than once, and the second compaction's lines are
    // usually word-for-word the first's ("Compaction reason: auto", "Tool
    // calls: 0"), which captureEntity now declines to store twice. Reporting
    // the built count would announce "Saved 2 observations" on a run that
    // stored none — the same success-shaped lie this comment block exists to
    // stop. Zero written is still a successful run: the memory is already
    // there.
    const stored = written ? written.observationsWritten : 0;
    const hookOutput = {
      systemMessage: written
        ? (stored > 0
          ? `Saved ${stored} observations to MeMesh before compaction`
          : 'MeMesh: this compaction added nothing new (already captured)')
        : 'MeMesh: could not save pre-compaction insights (see stderr)',
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
