// extractProjectFromName must correctly split `lesson-{project}-{errorPattern}`
// names where errorPattern itself can contain dashes. The previous heuristic
// trimmed the LAST dash-segment, which yielded "claude-code-buddy-config"
// for "lesson-claude-code-buddy-config-error" — wrong, because "config-error"
// is a single error pattern. The fix anchors on the fixed pattern set
// exported by lesson-engine.

import { describe, it, expect } from 'vitest';
import { extractProjectFromName } from '../../src/core/projects.js';
import { KNOWN_ERROR_PATTERNS } from '../../src/core/lesson-engine.js';

describe('extractProjectFromName', () => {
  it('extracts a single-word project from a known pattern suffix', () => {
    expect(extractProjectFromName('lesson-memesh-other')).toBe('memesh');
    expect(extractProjectFromName('lesson-memesh-import-missing')).toBe('memesh');
  });

  it('extracts a hyphenated project even when the error pattern contains a dash', () => {
    // The bug case: "config-error" includes a dash and tripped the previous
    // last-dash heuristic into producing "claude-code-buddy-config".
    expect(extractProjectFromName('lesson-claude-code-buddy-config-error'))
      .toBe('claude-code-buddy');
    expect(extractProjectFromName('lesson-claude-code-buddy-import-missing'))
      .toBe('claude-code-buddy');
    expect(extractProjectFromName('lesson-claude-code-buddy-other'))
      .toBe('claude-code-buddy');
  });

  it('handles every known error pattern', () => {
    for (const pattern of KNOWN_ERROR_PATTERNS) {
      expect(extractProjectFromName(`lesson-someproj-${pattern}`)).toBe('someproj');
    }
  });

  it('returns null for non-lesson prefixes (heuristic intentionally restricted)', () => {
    expect(extractProjectFromName('plan-memesh-roadmap')).toBeNull();
    expect(extractProjectFromName('decision-memesh-auth')).toBeNull();
    expect(extractProjectFromName('feature-memesh-x')).toBeNull();
  });

  it('returns null for names that do not match the lesson convention', () => {
    expect(extractProjectFromName('lesson-justone')).toBeNull();
    expect(extractProjectFromName('lesson-foo-unknown-pattern')).toBeNull();
    expect(extractProjectFromName('random-text')).toBeNull();
    expect(extractProjectFromName('')).toBeNull();
  });

  it('does not return a too-short project name', () => {
    // Even though "x-other" technically matches the pattern, "x" is too
    // short to be a meaningful project label.
    expect(extractProjectFromName('lesson-x-other')).toBeNull();
  });
});
