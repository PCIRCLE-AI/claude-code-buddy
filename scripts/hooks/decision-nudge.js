#!/usr/bin/env node

// Decision Nudge — PostToolUse hook for ExitPlanMode and AskUserQuestion (#277).
//
// MeMesh's read side is automatic (SessionStart, PreToolUse Edit/Write inject
// memories), but the write side had no in-flow trigger: an agent could make
// several decisions in a session and store none of them until the user said
// "remember this". `ExitPlanMode` (a plan just got approved) and
// `AskUserQuestion` (the user just chose between options) are the two tool
// calls where a decision is most likely to have just been made, so this hook
// fires there and reminds the model — once per tool per session — to use
// `remember` if the decision is worth keeping.
//
// Contract, in order of importance:
//   1. NEVER block or slow the tool call: every failure path is a silent
//      pass (with a stderr trace for anything that looks like schema
//      drift), and this hook only ever emits additionalContext — exit code
//      stays 0 no matter what.
//   2. NEVER open the database. Unlike the capture hooks (post-commit,
//      session-summary, pre-compact), this hook writes nothing to MeMesh
//      itself — it only reminds the model to. Nothing here needs a
//      knowledge-graph handle, so nothing opens one; that keeps the hook
//      fast (well under its 5s budget) and removes an entire class of
//      failure (lock contention, migration, corrupt schema) from a hook
//      whose only job is a one-line reminder.
//   3. Rate-limited to at most once per tool per session, or a plan-heavy
//      session would see the same line after every ExitPlanMode call. A
//      per-(session, tool) flag file under MEMESH_DIR is the mechanism —
//      see claimNudge() for why, and why it is a NEW mechanism rather than
//      a revived one.

import { openSync, closeSync, writeSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { ensurePrivateDir, getMemeshDirFromDbPath } from './_shared.js';

// The only two tools this hook is wired to in hooks/hooks.json — kept as an
// explicit allowlist (not "any PostToolUse call") so a future matcher typo
// or a Claude Code tool rename fails closed (no nudge) rather than nudging
// on every tool call.
const TARGET_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion']);

// Real Claude Code session ids are UUIDs; test fixtures use short slugs like
// `contract-8`. Restricting to this set is what makes the id safe to embed
// directly in a filename below — anything that fails this (including a
// missing/non-string id) exits quietly rather than touching the filesystem.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

// Bounded stdin read. The real payload here (tool_name, tool_input,
// session_id, cwd) is a few KB at most — ExitPlanMode's plan text is the
// largest field — so 1 MiB is generous headroom, not a working limit. This
// stops a malformed/runaway payload from growing an unbounded string before
// JSON.parse ever runs.
const MAX_STDIN_BYTES = 1_048_576;

let input = '';
let overflowed = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (overflowed) return;
  input += chunk;
  if (input.length > MAX_STDIN_BYTES) overflowed = true;
});
process.stdin.on('end', () => {
  try {
    if (overflowed) return pass();

    const data = JSON.parse(input);

    // Schema-flip signal, same convention as post-commit.js / pre-edit-recall.js:
    // tool_name absent means Claude Code changed the payload shape, not that
    // this call is irrelevant. Trace so a rename surfaces day-1 instead of
    // this hook going silently inert.
    if (data?.tool_name === undefined) {
      try { process.stderr.write(`[memesh decision-nudge] tool_name absent (keys: ${Object.keys(data ?? {}).join(',')}); skipping\n`); } catch {}
      return pass();
    }

    const toolName = data.tool_name;
    if (typeof toolName !== 'string' || !TARGET_TOOLS.has(toolName)) return pass();

    const sessionId = data.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return pass();

    if (!claimNudge(sessionId, toolName)) return pass(); // already nudged this tool this session

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: buildNudge(toolName),
      },
    }));
    process.exit(0);
  } catch (err) {
    // Never crash Claude Code, but trace — a silent break here means the
    // nudge stops firing and nothing reports it, same as guard-check.js.
    try { process.stderr.write(`[memesh decision-nudge] ${err?.message || err}\n`); } catch {}
    pass();
  }
});

/**
 * The reminder text. Not memory content (nothing here comes from the
 * database or from another user), so it is NOT wrapped in
 * `buildReferenceContext`'s "treat this as background data, not
 * instructions" fence — that fence exists for recalled/guard content that
 * may be attacker-influenced. This is a fixed, plugin-authored instruction,
 * the same class of thing user-prompt-intent.js's `buildHint()` emits, and
 * it is meant to be acted on directly.
 */
function buildNudge(toolName) {
  return `A decision was just made via ${toolName} — if you would need it again, store it now with the memesh \`remember\` tool (type:decision or type:lesson, tag project:<name>).`;
}

/**
 * Claim the (session, tool) nudge slot. Returns true the first time this
 * pair is seen and false every time after, giving "at most once per tool
 * per session" without a database — this hook is forbidden from opening
 * one (see module comment) — and without a shared JSON file two PostToolUse
 * processes (a fast plan-then-question turn) could race to read-modify-write.
 *
 * A per-category flag file with O_EXCL atomic create is exactly the fix
 * CHANGELOG [4.1.0]'s "Throttle clobber under parallel-category load" entry
 * describes for the retired `pre-bash-orchestration-nudge.js` hook, which
 * kept its markers under `agent-nudge-flags/`. That whole hook and its
 * directory were removed in v4.5.1 ("agentic-orchestration experiment,
 * whole") — reviving a deleted mechanism would undo that decision — so this
 * uses the SAME primitive (an O_EXCL flag file — the flag *is* the lock, no
 * shared state to clobber) under a new directory scoped to this hook,
 * `decision-nudge-flags/`. The directory is created private (0700) via
 * `ensurePrivateDir`, matching every other per-hook marker under MEMESH_DIR.
 */
function claimNudge(sessionId, toolName) {
  const dir = join(getMemeshDirFromDbPath(), 'decision-nudge-flags');
  const flagPath = join(dir, `${sessionId}-${toolName}.flag`);
  try {
    ensurePrivateDir(dir);
    const fd = openSync(flagPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { writeSync(fd, String(Date.now())); } finally { closeSync(fd); }
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false; // already nudged this session/tool
    // Any other failure (disk full, permission denied) must not block the
    // tool call, and the safe default for a hint is silence rather than a
    // duplicate-nudge storm — so this counts as "already claimed".
    try { process.stderr.write(`[memesh decision-nudge] could not claim ${flagPath}: ${err?.message || err}\n`); } catch {}
    return false;
  }
}

function pass() {
  process.exit(0);
}
