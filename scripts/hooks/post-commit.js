#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { AUTO_CAPTURE_TAG, captureEntity, getProjectName, isAutoCaptureEnabled, openHookDb, recordHookRun, truncateTitle } from './_shared.js';

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

      // Commit → session linkage, the hop `memesh why` walks. The payload has
      // carried session_id all along; this hook just never recorded it, so
      // every commit entity was an island (no file list, no session, no
      // relations). Recorded as METADATA, not tags, on purpose: a `file:*`
      // tag here would make pre-edit-recall inject commit noise into every
      // edit of a touched file (Strategy 1 joins on exactly that tag).
      const whyMetadata = {};
      if (typeof data.session_id === 'string' && data.session_id) {
        whyMetadata.session_id = data.session_id;
      }
      try {
        const nameOnly = execFileSync('git', ['-C', data.cwd, 'show', '--name-only', '--format=', commitHash], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (nameOnly) {
          // Repo-relative paths, capped: a lockfile-churn commit can touch
          // thousands of files and metadata rides every entity read.
          const files = nameOnly.split('\n').map(l => l.trim()).filter(Boolean);
          if (files.length > 0) whyMetadata.files = files.slice(0, 50);
        }
      } catch {
        // Best-effort like the diff stats above — no file list recorded.
      }

      // Shared write dance — upsert entity + observations + tags AND reindex FTS.
      //
      // `source:auto-capture` is the provenance marker every capture hook
      // writes (session-summary, pre-compact and the extractor already did;
      // this one did not). `memesh doctor` counts it to answer "is the
      // auto-capture loop alive" — a question it used to answer from entity
      // TYPE, which a hand-typed `memesh learn` satisfied all by itself.
      // The commit subject IS the title — git authors already wrote a
      // one-line human summary; nothing to synthesize.
      //
      // Re-capture of an already-stored commit is expected and harmless: this
      // hook runs on PostToolUse, so any later Bash call while HEAD is
      // unchanged rebuilds the same `commit-<sha>` payload. It used to APPEND
      // it — three commit entities on the maintainer's graph reached 6
      // observations / 3 distinct, one triple re-written 107 seconds after the
      // first. captureEntity now refuses to store an observation whose exact
      // content is already on the entity (#240, widened), which is the right
      // guard here rather than "skip if the entity exists": a sha is immutable,
      // so any line that DOES differ on a later run (diff stats that failed the
      // first time and succeeded now) is new information and must still land.
      const written = captureEntity(db, {
        name: entityName,
        type: 'commit',
        observations,
        tags: [AUTO_CAPTURE_TAG, `project:${projectName}`],
        title: truncateTitle(commitMsg),
        metadata: whyMetadata,
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
  // Emit NOTHING on success — not `{"suppressOutput": true}`.
  //
  // That field is valid Claude Code hook output, and it was doing no work:
  // this hook writes nothing else to stdout, so there was never any output
  // to suppress. But Codex CLI validates hook output per event against its
  // own schema, and rejects the field on PostToolUse — reported from a live
  // Codex session as "PostToolUse hook returned unsupported suppressOutput",
  // once per Bash tool call, with the capture itself having already succeeded.
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
