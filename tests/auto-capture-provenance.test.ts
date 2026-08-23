/**
 * One string, five places, and nothing holding them together.
 *
 * `memesh doctor`'s "Hook activity (last 24h)" row answers "is the auto-capture
 * loop alive". It used to answer from entity TYPE, and one of the types it
 * counted — `lesson_learned` — is what `memesh learn` writes, which a user
 * types by hand. On a brand-new HOME with no `.claude` directory at all, one
 * manual `learn` produced `[PASS] auto-capture loop is alive`: the tool
 * reporting the user's own typing back to them as evidence that automation
 * worked.
 *
 * It now counts a provenance tag instead. That is the right question, but it
 * moved the risk: the answer is only correct while FOUR writers and ONE reader
 * agree on one string, and three of the writers are plain `.js` hook scripts
 * that Claude Code loads directly and that cannot import the TypeScript
 * constant. Drop the tag from one hook and nothing fails — the other three keep
 * the row green while that hook's captures stop being counted.
 *
 * This file is that missing coupling. It was named in the constant's docstring
 * before it existed, which is its own instance of the defect this whole branch
 * is about: a gate that never runs cannot fail, and a comment claiming one is
 * worse than no comment, because it stops the next reader looking.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AUTO_CAPTURE_TAG } from '../src/core/types.js';
import { AUTO_CAPTURE_TAG as HOOK_AUTO_CAPTURE_TAG } from '../scripts/hooks/_shared.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Every path that writes a memory automatically, with no user typing. */
const CAPTURE_WRITERS = [
  'src/core/extractor.ts',
  'scripts/hooks/session-summary.js',
  'scripts/hooks/pre-compact.js',
  'scripts/hooks/post-commit.js',
] as const;

describe('the auto-capture provenance tag', () => {
  it('is one value, not two copies that can drift', () => {
    // The hooks are loaded by Claude Code as plain .js and cannot import from
    // src/, so a mirror is unavoidable. What is avoidable is the mirror
    // drifting silently.
    expect(HOOK_AUTO_CAPTURE_TAG).toBe(AUTO_CAPTURE_TAG);
  });

  it('is attached by every capture writer', () => {
    const missing: string[] = [];
    for (const file of CAPTURE_WRITERS) {
      const src = read(file);
      // Inside a `tags:` ARRAY, not merely somewhere in the file.
      //
      // The old check was `src.includes('AUTO_CAPTURE_TAG')` over the whole
      // file, which the import line alone satisfies. A writer could keep the
      // import, stop passing the tag, and pass — while `memesh doctor` counts
      // this tag to answer "is the auto-capture loop alive" and would report
      // a dead loop as healthy.
      //
      // Both spellings still count: the constant, or the literal. What does
      // not count is the identifier sitting in an import with no call site.
      const inTagsArray = /tags:\s*\[[^\]]*(?:AUTO_CAPTURE_TAG|['"`]source:auto-capture['"`])/s.test(src)
        || /\.\.\.\s*baseTags/.test(src) && /baseTags\s*=\s*\[[^\]]*(?:AUTO_CAPTURE_TAG|['"`]source:auto-capture['"`])/s.test(src);
      if (!inTagsArray) {
        missing.push(file);
      }
    }
    expect(
      missing,
      `these capture paths no longer attach the provenance tag, so doctor stops counting what they write: ${missing.join(', ')}`
    ).toEqual([]);

    // Anti-vacuity: the loop above is only meaningful if it read real files.
    // A renamed hook would otherwise make "every writer tags" vacuously true.
    for (const file of CAPTURE_WRITERS) {
      expect(fs.existsSync(path.join(repoRoot, file)), `${file} moved — this test is now blind to it`).toBe(true);
    }
  });

  it('is what doctor counts, and doctor counts nothing else', () => {
    const doctor = read('src/core/doctor.ts');
    const activity = doctor.slice(
      doctor.indexOf('function inspectHookActivity'),
      doctor.indexOf('function defaultResolveShellMemesh')
    );
    expect(activity.length, 'inspectHookActivity moved — this test is reading the wrong code').toBeGreaterThan(200);

    // It must bind the tag…
    expect(activity).toContain('AUTO_CAPTURE_TAG');
    // …and must NOT have gone back to counting entity types, which is the
    // exact regression: `lesson_learned` is hand-typed.
    expect(
      activity,
      'hook-activity is counting entity types again — a hand-typed `memesh learn` will report the auto-capture loop as alive'
    ).not.toContain('lesson_learned');
  });
});
