/**
 * Pins the gate that stops `main` declaring a version nobody can install.
 *
 * v4.2.11 was bumped on 2026-07-29 and tagged on 2026-08-03. For five days
 * every version anchor agreed with every other version anchor — which is all
 * `check-version-coherence.mjs` used to ask — while the version they agreed on
 * did not exist anywhere a user could reach.
 *
 * Both directions are asserted, because a gate that can only pass is the defect
 * this repository keeps finding. In particular: an empty tag list must FAIL.
 * `actions/checkout` fetches no tags by default, and "found no mismatch in zero
 * tags" would otherwise report success on every CI run forever.
 */
import { describe, it, expect } from 'vitest';
import { checkMainDeclaresPublishedVersion } from '../scripts/lib/published-version.mjs';

describe('main must declare a published version', () => {
  it('passes when the declared version is tagged', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: 'main',
      pkgVersion: '4.2.11',
      tags: ['v4.2.10', 'v4.2.11'],
    });
    expect(r.status).toBe('ok');
  });

  it('FAILS when main declares a version that was never tagged', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: 'main',
      pkgVersion: '4.2.12',
      tags: ['v4.2.10', 'v4.2.11'],
    });
    expect(r.status).toBe('error');
    // The message has to name the two ways out, or the next person hits the
    // same five days with a red build and no instruction.
    expect(r.message).toContain('v4.2.12');
    expect(r.message).toContain('[Unreleased]');
  });

  it('FAILS rather than passes when no tags are visible at all', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: 'main',
      pkgVersion: '4.2.11',
      tags: [],
    });
    expect(r.status).toBe('error');
    expect(r.message).toContain('fetch-tags');
  });

  it('FAILS rather than passes when the tag list could not be read', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: 'main',
      pkgVersion: '4.2.11',
      tags: null as unknown as string[],
    });
    expect(r.status).toBe('error');
  });

  it('skips on a release branch, which carries the bump before the tag exists', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: 'chore/release-4.2.12',
      pkgVersion: '4.2.12',
      tags: ['v4.2.11'],
    });
    expect(r.status).toBe('skipped');
  });

  it('skips on a pull-request ref, which GitHub names <n>/merge', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: '103/merge',
      pkgVersion: '4.2.12',
      tags: ['v4.2.11'],
    });
    expect(r.status).toBe('skipped');
  });

  it('skips when the branch cannot be discovered', () => {
    const r = checkMainDeclaresPublishedVersion({
      branch: null,
      pkgVersion: '4.2.12',
      tags: ['v4.2.11'],
    });
    expect(r.status).toBe('skipped');
  });

  /**
   * `finish-release.mjs` runs `qa:pre-release` as its own precondition, on
   * `main`, before the tag it is about to create exists — the one moment
   * this check cannot help but call an error against its own caller.
   * `aboutToTagThisVersion` is how that one caller says so.
   */
  describe('aboutToTagThisVersion (set only by finish-release.mjs)', () => {
    it('skips instead of erroring when other tags are visible but not this one', () => {
      const r = checkMainDeclaresPublishedVersion({
        branch: 'main',
        pkgVersion: '4.2.12',
        tags: ['v4.2.10', 'v4.2.11'],
        aboutToTagThisVersion: true,
      });
      expect(r.status).toBe('skipped');
      expect(r.message).toContain('4.2.12');
    });

    it('still passes outright when the tag already exists', () => {
      const r = checkMainDeclaresPublishedVersion({
        branch: 'main',
        pkgVersion: '4.2.11',
        tags: ['v4.2.10', 'v4.2.11'],
        aboutToTagThisVersion: true,
      });
      expect(r.status).toBe('ok');
    });

    // Break-test: a shallow checkout with no tag data at all is still a real
    // failure whether or not the caller is about to tag — the flag narrows to
    // "this one tag is missing", not "trust me". If this ever went green, the
    // flag would also paper over the exact defect `actions/checkout` fetching
    // no tags reintroduces.
    it('does NOT rescue a checkout where no tags are visible at all', () => {
      const r = checkMainDeclaresPublishedVersion({
        branch: 'main',
        pkgVersion: '4.2.11',
        tags: [],
        aboutToTagThisVersion: true,
      });
      expect(r.status).toBe('error');
      expect(r.message).toContain('fetch-tags');
    });
  });
});
