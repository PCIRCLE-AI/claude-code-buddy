#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { AUTO_CAPTURE_TAG, captureEntity, getProjectName, isAutoCaptureEnabled, openHookDb, recordHookRun } from './_shared.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Opt-out check (env > config > default-on). This hook skipped it for
    // years while its two siblings honoured it — with capture disabled it
    // kept writing commit entities AND stamping the heartbeat, which made
    // doctor's "capture is off, hook silence is expected" message false.
    if (!isAutoCaptureEnabled(process.env)) return exit0();

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

    // The OUTPUT looking like a commit is not evidence that a commit happened.
    // This hook stopped at the regex above, so any Bash output containing a
    // commit-shaped line produced a permanent memory. Measured: a payload whose
    // command was `cat docs/release-notes.md` wrote entity `commit-9f3c2a1`
    // for a hash `git cat-file -t` rejects as "Not a valid object name".
    // Reading a changelog, tailing a build log, or quoting a commit line was
    // enough — and the fake then surfaced through session-start and
    // pre-edit-recall as if it had happened.
    const issuedCommand = typeof data.tool_input?.command === 'string' ? data.tool_input.command : '';
    if (!/\bgit\b[^|;&]*\bcommit\b/.test(issuedCommand)) {
      try { process.stderr.write(`[memesh post-commit] output looks like a commit but the command was not a git commit; skipping ${commitMatch[1]}\n`); } catch {}
      return exit0();
    }

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
    // And the commit has to actually be in THIS repository.
    //
    // `cat-file -e <hash>^{commit}` answers exactly one question — does this
    // resolve to a commit object here — in milliseconds, before anything is
    // written. Deliberately separate from the `git show` below, whose failure
    // (git absent, timeout on a huge diff) says nothing about the commit and
    // must NOT veto.
    try {
      execFileSync('git', ['-C', data.cwd, 'cat-file', '-e', `${commitHash}^{commit}`], {
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      try { process.stderr.write(`[memesh post-commit] ${commitHash} is not a commit in ${data.cwd}; nothing written\n`); } catch {}
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
      //
      // `source:auto-capture` is the provenance marker every capture hook
      // writes (session-summary, pre-compact and the extractor already did;
      // this one did not). `memesh doctor` counts it to answer "is the
      // auto-capture loop alive" — a question it used to answer from entity
      // TYPE, which a hand-typed `memesh learn` satisfied all by itself.
      const written = captureEntity(db, {
        name: entityName,
        type: 'commit',
        observations,
        tags: [AUTO_CAPTURE_TAG, `project:${projectName}`],
      });

      // Heartbeat AFTER capture, so the stamp certifies "the capture loop
      // completed", not "a database handle existed". A throw above skips it,
      // and so does a null return (the write did not land).
      if (written) recordHookRun(db, 'post-commit');
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
