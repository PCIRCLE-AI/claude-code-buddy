#!/usr/bin/env node

// Orchestration Nudge — PreToolUse hook for Bash
// When Claude is about to run a high-verifiability command (tests, builds, lint,
// deploys, etc.), injects a one-time-per-category advisory hint to consider
// dispatching it as a background agent instead of blocking the conversation.
//
// Throttle: one nudge per category per session. State lives in
// ~/.memesh/agent-nudge-shown.json (or beside MEMESH_DB_PATH).
// session-start.js clears this file at the start of each session.

import { join } from 'path';
import { existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { ensurePrivateDir, getMemeshDir, writePrivateJson } from './_shared.js';

const memeshDir = getMemeshDir(process.env);
const THROTTLE_FILE = join(memeshDir, 'agent-nudge-shown.json');

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
const NOISE_EXCLUSIONS = /--version\b|-v\b|--help\b|-h\b|\bls\b|\bcat\b|\becho\b|\bpwd\b|\bwhich\b|\bwhere\b/i;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = (data.tool_input?.command ?? '').trim();

    if (!command) return pass();

    // Short-circuit: known noise commands never warrant a nudge
    if (NOISE_EXCLUSIONS.test(command)) return pass();

    // Find the first matching category
    const match = PATTERNS.find((p) => p.test.test(command));
    if (!match) return pass();

    // Throttle: only nudge once per category per session
    let shownCategories = {};
    try {
      if (existsSync(THROTTLE_FILE)) {
        const raw = JSON.parse(readFileSync(THROTTLE_FILE, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          shownCategories = raw;
        }
      }
    } catch {
      shownCategories = {};
    }

    if (shownCategories[match.category]) return pass();

    // Record that we nudged this category so we don't repeat it.
    // Use O_EXCL on a per-category lockfile to win the race when two parallel
    // PreToolUse hooks fire in the same millisecond — only one process gets
    // to create the lockfile, the loser silently skips writing the throttle
    // and exits as if already-throttled.
    const lockPath = `${THROTTLE_FILE}.${match.category}.lock`;
    let weOwnTheLock = false;
    try {
      ensurePrivateDir(memeshDir);
      const fd = openSync(lockPath, 'wx', 0o600);
      closeSync(fd);
      weOwnTheLock = true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Another process already claimed this category in this same instant —
        // treat as already-nudged and pass through without emitting.
        return pass();
      }
      // Other errors (permission, FS full): degrade gracefully — emit nudge,
      // skip persistence. User sees one nudge, still useful.
    }
    if (weOwnTheLock) {
      shownCategories[match.category] = true;
      try {
        writePrivateJson(THROTTLE_FILE, shownCategories);
      } catch {
        // Non-critical — nudge still emits
      } finally {
        try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ }
      }
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
