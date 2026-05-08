#!/usr/bin/env node

// User Prompt Intent — UserPromptSubmit hook
//
// Detects when the user explicitly asks Claude to remember / save / memorize
// content from the current session, and injects a context hint reminding Claude
// to use `mcp__memesh__remember` for cross-project recall.
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
//   - All imperatives anchored to sentence start (^ or after .!?\n) to skip
//     interrogatives ("do you remember X?", "What does save to memesh do?").
//   - For save-class verbs, "memesh" suffix required to avoid false positives
//     on generic "save this" (could mean clipboard, file, bookmark, etc.).
//   - Supported languages: English, Spanish, French, Portuguese, Traditional Chinese.
//     Additional languages welcome via PR (provide native-speaker validation).
export const INTENT_PATTERNS = [
  // English: "Remember/memorize this|that"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b/im,
  // English: "save/add/store to memesh"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b/im,

  // Spanish: "Recordar/memorizar esto|eso"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:recordar|memorizar)\s+(?:esto|eso)\b/im,
  // Spanish: "guardar en memesh"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:guardar|añadir|almacenar)\s+(?:(?:esto|eso)\s+)?(?:en|a)\s+memesh\b/im,

  // French: "Rappeler/mémoriser ceci|cela"
  /(?:^|[.!?\n]\s*)(?:s'il vous plaît\s+)?(?:rappeler|mémoriser)\s+(?:ceci|cela|ça)\b/im,
  // French: "sauvegarder dans memesh"
  /(?:^|[.!?\n]\s*)(?:s'il vous plaît\s+)?(?:sauvegarder|enregistrer|ajouter)\s+(?:(?:ceci|cela|ça)\s+)?(?:dans|à)\s+memesh\b/im,

  // Portuguese: "Lembrar/memorizar isto|isso"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:lembrar|memorizar)\s+(?:isto|isso)\b/im,
  // Portuguese: "salvar em memesh"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:salvar|guardar|adicionar|armazenar)\s+(?:(?:isto|isso)\s+)?(?:em|no)\s+memesh\b/im,

  // Traditional Chinese: 記下來, 記到/存到/寫進/存進 memesh|記憶
  /記下來|記到\s*(?:memesh|記憶)|存到\s*(?:memesh|記憶)|寫進\s*(?:memesh|記憶)|存進\s*(?:memesh|記憶)/,
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
    'The user just asked you to save / remember content. Use memesh for cross-project recall:',
    '',
    '1. Decide WHAT to remember from the conversation context. Be specific — pick observations',
    '   that will be useful in *future* sessions, not session-local state.',
    '',
    '2. Decide the SCOPE (this drives namespace + tags):',
    '   • Machine-level / cross-project / preferences  → memesh namespace=personal',
    '   • Project-internal decision / pattern / lesson → memesh + project tag (e.g. tag:project:memesh)',
    '   • Universal / public best practice             → memesh namespace=global (rare)',
    '',
    '3. Call `mcp__memesh__remember` with:',
    '   • name: descriptive entity name (e.g., "aws-cdk-stack-pattern")',
    '   • type: one of (decision, pattern, lesson_learned, bug, process, preference, etc.)',
    '   • observations: array of specific facts / steps / rationale',
    '   • tags: relevant tags (programming language, framework, domain)',
    '   • namespace: personal (default) | team | global',
    '',
    '4. Confirm to the user with: entity name + memesh ID returned by the tool.',
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
