#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { captureEntity, getProjectName, openHookDb } from './_shared.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // tool_name absent is a schema-flip signal (Claude Code has done
    // tool_name renames historically — e.g. tool_use/tool_result
    // nesting). Trace to surface the rename day-1 instead of months
    // of silent dropout (the bug shape that bit `tool_output` and
    // `was_in_agentic_loop`).
    if (data.tool_name === undefined) {
      try { process.stderr.write(`[memesh post-commit] tool_name absent in payload (keys: ${Object.keys(data).join(',')}); skipping\n`); } catch {}
      return exit0();
    }
    if (data.tool_name !== 'Bash') return exit0();

    // Claude Code's PostToolUse hook payload has had two field-name shapes:
    // legacy `tool_output: <string>` and current
    // `tool_response: { stdout, stderr, interrupted, isError }`. Prefer the
    // current shape; fall back to legacy so unit-test fixtures (which use
    // tool_output) keep working. This block existed only as the legacy
    // branch — once Claude Code unified on tool_response the hook silently
    // stopped seeing any output and never wrote commit entities again.
    const tr = data.tool_response;
    let toolOutput = '';
    if (typeof tr === 'string') {
      toolOutput = tr;
    } else if (tr && typeof tr === 'object') {
      const stdout = typeof tr.stdout === 'string' ? tr.stdout : '';
      const stderr = typeof tr.stderr === 'string' ? tr.stderr : '';
      toolOutput = stdout + (stderr ? '\n' + stderr : '');
    } else if (typeof data.tool_output === 'string') {
      toolOutput = data.tool_output;
    } else if (data.tool_output != null) {
      toolOutput = JSON.stringify(data.tool_output);
    }

    // Detect git commit in output
    // Pattern: [branch hash] commit message — with an optional parenthesised
    // note between branch and hash: git prints `[master (root-commit) 32e98b8]`
    // for a repo's FIRST commit, and the old pattern silently skipped exactly
    // that one, so no repository's first commit was ever remembered.
    const commitMatch = toolOutput.match(/\[[\w/.-]+(?: \([\w -]+\))? ([a-f0-9]{7,})\] (.+)/);
    if (!commitMatch) return exit0();

    const branchMatch = commitMatch[0].match(/^\[([^\s]+)\s/);
    const branch = branchMatch ? branchMatch[1] : 'unknown';

    const commitHash = commitMatch[1];
    const commitMsg = commitMatch[2];

    // `data.cwd` MUST be present for project-tag and `git show` below
    // to be correct. If absent, falling through to process.cwd() (the
    // hook process's launch dir, unspecified for PostToolUse Bash)
    // would either run git show against a different repo (silent
    // corruption) or write the wrong project tag. Skip + trace
    // instead — better to miss one commit than to tag it wrong.
    if (!data.cwd) {
      try { process.stderr.write(`[memesh post-commit] data.cwd absent — cannot resolve project / repo; skipping commit ${commitHash}\n`); } catch {}
      return exit0();
    }
    const projectName = getProjectName(data.cwd);

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // Pass fts:true so the FTS5 entity-search index is also available.
    const { db } = openHookDb(process.env, { fts: true });
    try {
      const entityName = `commit-${commitHash}`;

      // Build the observation set: commit message, branch, and — best-effort —
      // richer diff stats (git failures are silently ignored, unchanged behavior).
      const observations = [commitMsg, `Branch: ${branch}`];
      try {
        const stat = execFileSync('git', ['show', '--stat', '--format=', commitHash], {
          cwd: data.cwd || process.cwd(),
          encoding: 'utf8',
          timeout: 5000,
          // stderr captured, not inherited: outside a repo this used to leak
          // a raw `fatal: not a git repository` into the hook's own stderr.
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (stat) {
          // Last non-empty line is the summary, e.g. "3 files changed, 45 insertions(+), 12 deletions(-)"
          const statLines = stat.split('\n').filter(l => l.trim());
          const summary = statLines[statLines.length - 1]?.trim() || '';
          if (summary) observations.push(`Diff stats: ${summary}`);
        }
      } catch {
        // git show failed — no diff stats recorded, existing behavior unchanged
      }

      // Shared write dance — upsert entity + observations + tags AND reindex FTS.
      captureEntity(db, {
        name: entityName,
        type: 'commit',
        observations,
        tags: [`project:${projectName}`],
      });
    } finally {
      db.close();
    }
  } catch (err) {
    // Never crash Claude Code — but leave a trace for debugging
    try { process.stderr.write(`[memesh post-commit] ${err?.message || err}\n`); } catch {}
  }
  console.log(JSON.stringify({ suppressOutput: true }));
  exit0();
});

function exit0() {
  process.exit(0);
}
