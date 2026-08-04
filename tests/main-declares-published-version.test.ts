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
});
