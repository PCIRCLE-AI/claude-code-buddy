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
// observations, namespace). A polite reminder keeps Claude in the loop with
// full context, while still preventing the "I forgot to use memesh" failure
// mode that motivated this hook.
//
// Defensive: never blocks, never throws. Silent on no-match.
// Gated by `autoCapture` flag (same as other memesh write hooks).

import { isAutoCaptureEnabled } from './_shared.js';

// Intent patterns — kept conservative to avoid false positives on prompts
// that merely mention "remember" in passing.
//
// Key disambiguation: imperative "remember/memorize" must be at the start of
// a sentence (or after "please"), not in "do you remember the X?" questions.
// We anchor with (?:^|[.!?\n]\s*) for English imperatives.
const INTENT_PATTERNS = [
  // Sentence-initial imperative: "Remember this", "Please memorize that"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b/im,
  // Explicit save-to-store: "save this to memory", "save to memesh"
  /\bsave\s+(?:this\s+|that\s+|it\s+)?to\s+(?:memory|memesh)\b/i,
  /\b(?:add|put|store|write)\s+(?:this\s+|that\s+|it\s+)?(?:to|in|into)\s+(?:memory|memesh)\b/i,
  // CJK: 記下來 / 記到 memory / 存到 memesh / 寫進記憶 / 記憶起來
  /記下來|記到\s*(?:memory|memesh)?|存到\s*memesh|寫進\s*記憶|存進\s*記憶|記憶起來/,
];

function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const re of INTENT_PATTERNS) {
    if (re.test(prompt)) return true;
  }
  return false;
}

function buildHint() {
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

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (!isAutoCaptureEnabled(process.env)) return process.exit(0);

    const data = JSON.parse(input || '{}');
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
  } catch {
    // Never block the user prompt on hook failure
    process.exit(0);
  }
});
