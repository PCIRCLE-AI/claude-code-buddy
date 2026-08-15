// =============================================================================
// The prompt-injection boundary is enforced by machine, not by a comment
// =============================================================================
//
// prompt-safety.ts used to open with a hand-maintained list of its call
// sites, annotated "this list has been wrong before" — it named a retired
// module and omitted a live one. A list that must be updated by the same
// discipline it exists to check is not a boundary. This test IS the
// boundary: every module that imports `callLLM` (the trust boundary where
// attacker-influenced text meets the model) must also import prompt-safety —
// wrapUntrusted for tag-delimited data blocks, or sanitizeForPrompt /
// sanitizeListForPrompt for per-line formatting.
//
// If this test fails on a NEW file: wrap every piece of user- or
// pipeline-controlled text you interpolate into the prompt with
// `wrapUntrusted(tag, text)`. If your file genuinely sends only
// program-authored constants to the LLM, add it to the allowlist below WITH
// a comment saying why.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = path.join(repoRoot, 'src', 'core');

// Files that import callLLM but legitimately need no sanitiser.
const ALLOWLIST = new Set<string>([
  // llm-client.ts defines callLLM; it builds no prompts of its own.
  'llm-client.ts',
]);

describe('prompt-safety boundary', () => {
  const llmCallers = fs
    .readdirSync(coreDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(coreDir, f), 'utf8');
      return /import\s*\{[^}]*\bcallLLM\b[^}]*\}\s*from/.test(src);
    });

  it('found the LLM flows (the boundary has something to guard)', () => {
    // If this ever reads 0, the detection regex rotted — that is a failure,
    // not a pass: an empty caller list would let every flow skip the check.
    expect(llmCallers.length).toBeGreaterThan(0);
  });

  for (const file of llmCallers) {
    if (ALLOWLIST.has(file)) continue;
    it(`${file} imports the prompt-safety boundary`, () => {
      const src = fs.readFileSync(path.join(coreDir, file), 'utf8');
      expect(
        /from '\.\/prompt-safety\.js'/.test(src),
        `${file} calls the LLM but never imports prompt-safety — wrap untrusted ` +
          `text with wrapUntrusted() before interpolating it into a prompt`,
      ).toBe(true);
    });
  }
});
