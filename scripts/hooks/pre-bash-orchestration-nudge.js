#!/usr/bin/env node

// Orchestration Nudge — PreToolUse hook for Bash
// When Claude is about to run a high-verifiability command (tests, builds, lint,
// deploys, etc.), injects a one-time-per-category advisory hint to consider
// dispatching it as a background agent instead of blocking the conversation.
//
// Throttle: one nudge per category per session. State is one marker file per
// category in ${memeshDir}/agent-nudge-flags/${category}.flag. The flag IS
// the lock — created with O_EXCL so concurrent hooks racing on the same
// category resolve atomically (winner emits the nudge, loser silently passes).
// session-start.js clears the directory at the start of each session.

import { join } from 'path';
import { openSync, closeSync } from 'fs';
import { ensurePrivateDir, getMemeshDir } from './_shared.js';

const memeshDir = getMemeshDir(process.env);
const FLAGS_DIR = join(memeshDir, 'agent-nudge-flags');

// ---------------------------------------------------------------------------
// Pattern definitions
// Each entry has:
//   category: string key used for per-session throttle dedup
//   test:     RegExp that must match somewhere in the command (case-insensitive)
// ---------------------------------------------------------------------------
const PATTERNS = [
  {
    category: 'test',
    test: /\bnpm\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bmocha\b|\bava\b/i,
  },
  {
    category: 'build',
    test: /\bnpm\s+run\s+build\b|\btsc\b|\bnext\s+build\b|\bnest\s+build\b|\bcargo\s+build\b|\bvite\s+build\b|\bwebpack\b/i,
  },
  {
    category: 'lint',
    test: /\bnpm\s+run\s+lint\b|\beslint\b|\bprettier\b(?!\s+--version|\s+-v)|\btsc\s+--noEmit\b|\bbiome\b/i,
  },
  {
    category: 'migrate',
    test: /\bprisma\s+(?:migrate|db\s+push)\b|\bknex\s+migrate\b|\bsequelize\s+db:migrate\b/i,
  },
  {
    category: 'benchmark',
    test: /\bnpm\s+run\s+bench\b|\bbenchmark\b/i,
  },
  {
    category: 'deploy',
    test: /\bvercel\s+(?:deploy|--prod)\b|\bgh\s+(?:workflow\s+run|run)\b|\bwrangler\s+deploy\b|\bfly\s+deploy\b/i,
  },
  {
    category: 'npm-run-check',
    // Generic: `npm run <script>` where the script name suggests slow CI-like work
    test: /\bnpm\s+run\s+(?:check|typecheck|type-check|ci|e2e|integration|coverage|storybook|compile)\b/i,
  },
];

// Commands that are definitely NOT long-running, even if they somehow matched
// a pattern above. Short-circuit exclusions — if the command matches any of
// these, skip the nudge.
//
// Note: short-form `-v` was intentionally removed. In test runners (pytest,
// go test, cargo test, bun test) `-v` is the *verbose* flag, and those
// invocations are genuinely long-running. `node -v` / `npm -v` style
// version checks don't reach this exclusion list anyway because they
// never match any PATTERN entry above.
const NOISE_EXCLUSIONS = /--version\b|--help\b|\b-h\b|\bls\b|\bcat\b|\becho\b|\bpwd\b|\bwhich\b|\bwhere\b/i;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Opt-in gate: the agentic-orchestration protocol is a separable
    // experiment from memesh's core memory features. Enable with
    // MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1. The default is OFF so users
    // who installed memesh purely for memory don't see protocol nudges
    // they never asked for.
    if (process.env.MEMESH_ENABLE_AGENTIC_ORCHESTRATION !== '1') return pass();

    const data = JSON.parse(input);
    const command = (data.tool_input?.command ?? '').trim();

    if (!command) return pass();

    // Short-circuit: known noise commands never warrant a nudge
    if (NOISE_EXCLUSIONS.test(command)) return pass();

    // Find the first matching category
    const match = PATTERNS.find((p) => p.test.test(command));
    if (!match) return pass();

    // Throttle: only nudge once per category per session.
    //
    // Per-category marker file with O_EXCL atomic create. The flag IS the
    // lock — there is no shared state to read-modify-write, so concurrent
    // hooks for *different* categories cannot clobber each other's marker
    // (the previous shared-JSON design lost one of two parallel writes).
    // session-start.js wipes ${FLAGS_DIR} at the top of each new session.
    //
    // No pre-check (existsSync) before the open — that would be a TOCTOU
    // window. The openSync('wx') is itself the atomic check-and-create:
    // EEXIST means already-throttled, success means we won the race.
    const flagPath = join(FLAGS_DIR, `${match.category}.flag`);

    try {
      ensurePrivateDir(FLAGS_DIR);
      const fd = openSync(flagPath, 'wx', 0o600);
      closeSync(fd);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Marker already exists — this category was already nudged in this
        // session (either by an earlier hook invocation or a parallel one).
        return pass();
      }
      // Other errors (permission, FS full, EROFS): silent degrade — without
      // a marker we cannot honor the once-per-session contract, so emitting
      // the nudge would spam every matching command. Better to skip the
      // nudge entirely and let the user notice the FS issue via
      // `memesh doctor` if they care.
      return pass();
    }

    // Emit the advisory nudge
    const nudge = [
      'Orchestration hint: this looks like high-verifiability work.',
      'If it will take >10s, consider dispatching it as a background agent',
      '(Task tool with run_in_background:true) instead of blocking the conversation.',
      'See the agentic-orchestration skill for the dispatch pattern.',
    ].join('\n');

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: nudge,
      },
    }));
  } catch {
    // Never crash Claude Code — always exit cleanly
    pass();
  }
});

function pass() {
  process.exit(0);
}
