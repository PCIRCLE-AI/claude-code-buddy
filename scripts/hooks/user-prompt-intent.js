#!/usr/bin/env node

// User Prompt Intent — UserPromptSubmit hook
//
// Detects when the user explicitly asks Claude to remember / save / memorize
// content from the current session, and injects a context hint so Claude
// dual-writes the memory:
//   1. mcp__memesh__remember (cross-project, FTS5/vector search via personal namespace)
//   2. Claude Code MEMORY.md (~/.claude/projects/<proj>/memory/), keeping the native
//      auto-load mechanism intact.
//
// Why a hint instead of autonomous capture? The user's intent is clear, but
// "what to remember" usually depends on the surrounding conversation —
// extracting that requires an LLM round and policy decisions (name, type,
// observations, namespace). A polite reminder keeps the calling agent in the
// loop with full conversation context, while still preventing the
// "I forgot to use memesh" failure mode that motivated this hook.
//
// Defensive: never blocks user prompts, even on hook failure. Errors are
// surfaced to stderr (visible in Claude Code debug logs) rather than
// swallowed — stderr does not affect prompt submission.
// Gated by `autoCapture` flag (same as other memesh write hooks).

import { isAutoCaptureEnabled } from './_shared.js';

// Patterns compiled at module load — invalid regex MUST fail loudly. Do
// NOT move into a try block "for safety": a regex compile error is a
// programmer error, not a runtime condition, and silencing it would hide
// real bugs.
//
// Design principle: when in doubt between matching and not matching, do
// NOT match — a missed hint is recoverable (user repeats themselves), but
// a false hint pollutes context and pressures the LLM into a wrong action.
//
// Disambiguation policy:
//   - All English imperatives anchored to sentence start (^ or after .!?\n)
//     to skip interrogatives ("do you remember the X?", "What does save
//     to memesh do?").
//   - For save/add/put/store/write verbs, only "memesh" (this project's
//     unique brand) is accepted — "memory" alone collides with the
//     RAM/heap technical noun and produces unfixable false positives on
//     compound nouns like "memory leak / cache / pool / mapped IO".
//     Users who want intent capture know to say "memesh" explicitly.
//   - CJK 記到 alone is ambiguous (recall vs save), so memesh suffix is
//     required. 記憶起來 omitted because it appears in narrative prose.
export const INTENT_PATTERNS = [
  // English sentence-initial imperative: "Remember/memorize this|that".
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b/im,
  // English sentence-initial save-class to memesh. Anaphor (this|that|it)
  // optional. "memory" intentionally excluded — see policy note above.
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b/im,
  // CJK imperatives. memesh required for save-class verbs.
  /記下來|記到\s*memesh|存到\s*memesh|寫進\s*記憶|存進\s*記憶/,
];

export function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const re of INTENT_PATTERNS) {
    if (re.test(prompt)) return true;
  }
  return false;
}

// The returned string is consumed BY THE LLM as additionalContext, NOT by
// configuration or by Claude Code itself. Edits here change LLM behavior,
// not hook behavior.
export function buildHint() {
  return [
    '<memesh-remember-intent>',
    'The user just asked you to save / remember content. Apply the dual-write protocol:',
    '',
    '1. Decide WHAT to remember from the conversation context. Be specific — pick observations',
    '   that will be useful in *future* sessions, not session-local state.',
    '',
    '2. Decide the SCOPE (this drives namespace + storage location):',
    '   • Machine-level / cross-project / preferences  → memesh namespace=personal',
    '   • Project-internal decision / pattern / lesson → memesh + project tag (e.g. tag:project:memesh)',
    '   • Universal / public best practice             → memesh namespace=global (rare)',
    '',
    '3. Write to BOTH stores:',
    '   • Call `mcp__memesh__remember` with chosen name/type/observations/tags/namespace.',
    '   • Mirror to Claude Code auto-memory at',
    '     ~/.claude/projects/<encoded-cwd>/memory/<type>_<topic>.md',
    '     and add a one-line entry to MEMORY.md index pointing at the file.',
    '   • In the file frontmatter, note the memesh entity name; in the memesh observations,',
    '     note the local file path. This bidirectional pointer lets either side recover the other.',
    '',
    '4. Confirm to the user with: entity name + memesh id + local file path.',
    '',
    'Do not silently choose only one store — both are intentional layers.',
    '</memesh-remember-intent>',
  ].join('\n');
}

function logError(scope, msg) {
  // Hooks may write to stderr without blocking prompt submission. Use this
  // to surface failures in Claude Code debug logs instead of swallowing.
  try {
    process.stderr.write(`[memesh:${scope}] ${msg}\n`);
  } catch {
    // stderr itself failing is unrecoverable; stay silent.
  }
}

// Only run the stdin pipeline when invoked directly as a script — not when
// imported by the test suite for in-process unit testing.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      if (!isAutoCaptureEnabled(process.env)) return process.exit(0);

      // Distinguish empty stdin (legitimate degenerate event) from malformed
      // input (protocol drift). Both stay non-blocking, but only malformed
      // input is logged — empty is normal, garbage indicates a real bug.
      let data = {};
      const trimmed = input.trim();
      if (trimmed) {
        try {
          data = JSON.parse(trimmed);
        } catch (parseErr) {
          logError('user-prompt-intent', `malformed stdin JSON (len=${input.length}): ${parseErr.message}`);
          return process.exit(0);
        }
      }

      // Claude Code sends `prompt`. The `user_prompt` fallback is defensive:
      // Claude Code's transcript format changed once before (2026-05-07), so
      // we accept either name to survive a similar rename. If both are absent
      // or non-string, detectRememberIntent's type guard returns false safely.
      const prompt = data.prompt ?? data.user_prompt ?? '';
      if (!detectRememberIntent(prompt)) return process.exit(0);

      const out = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: buildHint(),
        },
      };
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    } catch (err) {
      logError('user-prompt-intent', err?.message || err);
      process.exit(0);
    }
  });
}
