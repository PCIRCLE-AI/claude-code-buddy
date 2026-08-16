#!/usr/bin/env node

// Lesson guards — PreToolUse hook for Bash (G1).
//
// A guard is a failure-lesson a human promoted (via the dream proposal
// queue) to speak at the moment its mistake is about to repeat: a regex
// over the command about to run. This hook is the Bash evaluation point;
// the Edit/Write point lives inside pre-edit-recall, which is already
// wired to that matcher.
//
// Contract, in order of importance:
//   1. NEVER block or slow the user's work: every failure path is a
//      silent pass (with a stderr trace), and v1 guards only WARN — the
//      warning is additionalContext, exit code stays 0.
//   2. The guard message is memory content — attacker-influenced in the
//      general case — so it is fenced by buildReferenceContext exactly
//      like every other injection path.
//   3. Every fire is counted (metadata.guard.fires): a guard that never
//      fires or fires constantly is a review item, and the count is what
//      surfaces it.

import { existsSync } from 'fs';
import {
  buildReferenceContext,
  getDbPath,
  loadActiveGuards,
  matchingGuards,
  guardWarningLines,
  recordGuardFires,
} from './_shared.js';
import { MemeshDatabase } from './_generated/sqlite.js';

const dbPath = getDbPath();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = data?.tool_input?.command;
    if (!command || typeof command !== 'string') return pass();
    if (!existsSync(dbPath)) return pass();

    // `readOnly`, not `readonly`: node:sqlite ignores the lowercase
    // spelling and hands back a WRITABLE handle. This hook only reads;
    // the fire counter opens its own writable handle for the one UPDATE.
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    let matches;
    try {
      matches = matchingGuards(loadActiveGuards(db, 'Bash'), 'Bash', command);
    } finally {
      db.close();
    }
    if (!matches || matches.length === 0) return pass();

    recordGuardFires(dbPath, matches.map((g) => g.lessonId));

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: buildReferenceContext(guardWarningLines(matches, 'Bash')),
      },
    }));
    process.exit(0);
  } catch (err) {
    // Never crash Claude Code, but trace — a silent break here means
    // every accepted guard stops firing and nothing reports it.
    try { process.stderr.write(`[memesh guard-check] ${err?.message || err}\n`); } catch {}
    pass();
  }
});

function pass() {
  process.exit(0);
}
