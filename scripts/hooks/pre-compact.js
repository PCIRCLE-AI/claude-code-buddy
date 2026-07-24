#!/usr/bin/env node

import { basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import { captureEntity, getProjectName, isAutoCaptureEnabled, openHookDb } from './_shared.js';

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
      // Shared write dance — upsert entity + observations + tags AND reindex FTS
      // so the pre-compact memory is recallable via the FTS keyword path.
      captureEntity(db, {
        name: entityName,
        type: 'session-summary',
        observations: obsLines,
        tags: ['source:auto-capture', 'urgency:pre-compact', `project:${projectName}`],
      });
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
    const hookOutput = {
      systemMessage: `Saved ${insightCount} insights to MeMesh before compaction`,
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
