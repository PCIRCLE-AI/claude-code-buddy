/**
 * Pins the command that closes the window `published-version.mjs` shouts about.
 *
 * Between merging a release PR and cutting the tag, `main` declares a version
 * nobody can install. `checkMainDeclaresPublishedVersion` makes that state
 * loud; it cannot make it short. `scripts/finish-release.mjs` makes it short,
 * and the only way to pin its happy path without cutting a real release is to
 * hand the decision its inputs — the same split, and the same reason, as
 * `tests/main-declares-published-version.test.ts`.
 *
 * Every refusal is asserted individually, because a precondition set that can
 * only pass is the defect this repository keeps finding. The unknown-input
 * cases matter most: `null` means "could not read it", and reading that as
 * "nothing was wrong" is how a shallow clone would talk this into re-cutting a
 * release that already shipped.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  checkReleasePreconditions,
  extractChangelogSection,
  shippedPathsFromPackageJson,
  findUsableLiveJourneyReceipt,
  LIVE_JOURNEY_RECEIPT_PATHS,
} from '../scripts/lib/release-preconditions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);

/** A `qa:live-journey` candidate list with exactly one usable PASS receipt for HEAD. */
function readyLiveJourney() {
  return [
    {
      host: 'codex',
      path: '.qa/codex-report.json',
      report: { schema_version: 'memesh-live-journey/v1', revision: HEAD, dirty: false, verdict: 'PASS', host: 'codex' },
      readError: null,
    },
    { host: 'claude', path: '.qa/claude-report.json', report: null, readError: 'not found' },
  ];
}

/** A state where cutting 4.7.0 is exactly the right thing to do. */
function ready(overrides: Record<string, unknown> = {}) {
  return {
    branch: 'main',
    isClean: true,
    headSha: HEAD,
    remoteHeadSha: HEAD,
    pkgVersion: '4.7.0',
    localTags: ['v4.6.0', 'v4.6.1'],
    remoteTags: ['v4.6.0', 'v4.6.1'],
    repoSlug: 'PCIRCLE-AI/memesh',
    notes: '### Added\n\n- something',
    shippedFilesChangedSinceBump: [],
    qaPreReleaseStatus: 0,
    liveJourneyCandidates: readyLiveJourney(),
    ...overrides,
  };
}

describe('release preconditions', () => {
  it('passes when the release is genuinely ready to cut', () => {
    const r = checkReleasePreconditions(ready());
    expect(r.blockers).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('refuses off main', () => {
    const r = checkReleasePreconditions(ready({ branch: 'chore/release-4.7.0' }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('not on main');
  });

  it('refuses when the branch cannot be discovered', () => {
    expect(checkReleasePreconditions(ready({ branch: null })).ok).toBe(false);
  });

  it('refuses when shipped files moved after the version bump', () => {
    // 4.8.2: the bump commit landed, then two fix PRs merged under the same
    // version. A plugin cache staged in between was named 4.8.2 and never
    // refreshed — Claude Code keys the cache by version.
    const r = checkReleasePreconditions(ready({ shippedFilesChangedSinceBump: ['src/storage/graph-repairs.ts', 'dist/storage/graph-repairs.js'] }));
    const text = r.blockers.join('\n');
    expect(text).toContain('after package.json was bumped to 4.7.0');
    expect(text).toContain('src/storage/graph-repairs.ts');
    expect(text).toContain('next version');
  });

  it('refuses when the post-bump diff could not be listed at all', () => {
    const r = checkReleasePreconditions(ready({ shippedFilesChangedSinceBump: null }));
    expect(r.blockers.join('\n')).toContain('could not list the shipped files');
  });

  it('refuses on a dirty tree', () => {
    const r = checkReleasePreconditions(ready({ isClean: false }));
    expect(r.blockers.join('\n')).toContain('uncommitted changes');
  });

  it('refuses when `git status` could not be read at all', () => {
    const r = checkReleasePreconditions(ready({ isClean: null }));
    expect(r.blockers.join('\n')).toContain('could not read');
  });

  it('refuses when local HEAD is not origin/main', () => {
    const r = checkReleasePreconditions(ready({ remoteHeadSha: 'b'.repeat(40) }));
    // A tag drags its commit to origin, so this is how unreviewed commits would
    // reach main without a PR.
    expect(r.blockers.join('\n')).toContain('origin/main');
  });

  it.each([
    ['local HEAD unreadable', { headSha: null }],
    ['origin/main unreadable', { remoteHeadSha: null }],
  ])('refuses when %s', (_label, override) => {
    expect(checkReleasePreconditions(ready(override)).ok).toBe(false);
  });

  it('refuses a version it cannot turn into a tag', () => {
    const r = checkReleasePreconditions(ready({ pkgVersion: '4.7' }));
    expect(r.ok).toBe(false);
  });

  it('refuses a prerelease version rather than mis-publishing it', () => {
    // Deliberate, not an oversight in the regex: `gh release create` would
    // mark 4.7.0-rc.1 as latest without `--prerelease`, and publish-npm.yml
    // runs `npm publish` with no `--tag`, so it would take npm's `latest`
    // dist-tag too. A prerelease flow is its own change.
    expect(checkReleasePreconditions(ready({ pkgVersion: '4.7.0-rc.1' })).ok).toBe(false);
  });

  it.each([
    ['the checkout', 'localTags'],
    ['origin', 'remoteTags'],
  ])('refuses when the tag already exists in %s', (where, key) => {
    const r = checkReleasePreconditions(ready({ [key]: ['v4.6.1', 'v4.7.0'] }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain(`v4.7.0 already exists in ${where}`);
  });

  it.each([
    ['localTags', []],
    ['localTags', null],
    ['remoteTags', []],
    ['remoteTags', null],
  ])('refuses rather than passes when %s is %s', (key, value) => {
    // A shallow clone reports no tags. "Found no clash among zero tags" must
    // never read as "the tag is free".
    const r = checkReleasePreconditions(ready({ [key]: value }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('could not be');
  });

  it('refuses before creating anything when gh cannot name the repo', () => {
    // Discovering a broken `gh` after the tag exists is the half-finished
    // release the command exists to make impossible.
    const r = checkReleasePreconditions(ready({ repoSlug: null }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('gh auth status');
  });

  it.each([[null], [''], ['   \n  ']])('refuses with no release notes (%j)', notes => {
    const r = checkReleasePreconditions(ready({ notes }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('CHANGELOG.md');
  });

  it('reports every reason at once, not just the first', () => {
    const r = checkReleasePreconditions(ready({ branch: 'topic', isClean: false, notes: null }));
    expect(r.blockers.length).toBeGreaterThanOrEqual(3);
  });

  // G4: real-credential gates. `qa:pre-release` is run fresh by
  // finish-release.mjs and its EXIT CODE gates; `qa:live-journey` cannot run
  // unattended, so a recorded receipt gates instead — see
  // `findUsableLiveJourneyReceipt` below for what makes one usable.
  it('refuses when `npm run qa:pre-release` did not pass', () => {
    const r = checkReleasePreconditions(ready({ qaPreReleaseStatus: 1 }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('qa:pre-release');
  });

  it('refuses when `npm run qa:pre-release` could not even run', () => {
    const r = checkReleasePreconditions(ready({ qaPreReleaseStatus: null }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('could not run it at all');
  });

  it('refuses when no qa:live-journey receipt is usable', () => {
    const r = checkReleasePreconditions(ready({ liveJourneyCandidates: [] }));
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toContain('qa:live-journey');
  });

  it('accepts a Claude-host receipt just as readily as a Codex one', () => {
    const claudeOnly = [
      { host: 'codex', path: '.qa/codex-report.json', report: null, readError: 'not found' },
      {
        host: 'claude',
        path: '.qa/claude-report.json',
        report: { schema_version: 'memesh-live-journey/v1', revision: HEAD, dirty: false, verdict: 'PASS', host: 'claude' },
        readError: null,
      },
    ];
    const r = checkReleasePreconditions(ready({ liveJourneyCandidates: claudeOnly }));
    expect(r.ok).toBe(true);
  });
});

describe('findUsableLiveJourneyReceipt', () => {
  const pass = { schema_version: 'memesh-live-journey/v1', revision: HEAD, dirty: false, verdict: 'PASS', host: 'codex' };

  it('accepts a PASS receipt for the exact HEAD revision', () => {
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: pass, readError: null }], HEAD);
    expect(r.ok).toBe(true);
    expect(r.usable?.host).toBe('codex');
  });

  it('refuses a receipt for a different revision', () => {
    const stale = { ...pass, revision: 'b'.repeat(40) };
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: stale, readError: null }], HEAD);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('\n')).toContain('does not match HEAD');
  });

  it('refuses a FAIL verdict', () => {
    const failed = { ...pass, verdict: 'FAIL' };
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: failed, readError: null }], HEAD);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('\n')).toContain('not PASS');
  });

  it('refuses a receipt recorded against a dirty working tree', () => {
    const dirty = { ...pass, dirty: true };
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: dirty, readError: null }], HEAD);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('\n')).toContain('dirty');
  });

  it('refuses a missing file rather than treating absence as pass', () => {
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: null, readError: 'not found' }], HEAD);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('\n')).toContain('not found');
  });

  it('refuses an unreadable file distinctly from a missing one', () => {
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: null, readError: 'Unexpected token' }], HEAD);
    expect(r.reasons.join('\n')).toContain('unreadable — Unexpected token');
  });

  it('refuses a report of the wrong shape (not a memesh-live-journey/v1 report)', () => {
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: { foo: 'bar' }, readError: null }], HEAD);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('\n')).toContain('not a memesh-live-journey/v1 report');
  });

  it('falls through to the second candidate when the first is unusable', () => {
    const r = findUsableLiveJourneyReceipt(
      [
        { host: 'codex', path: '.qa/codex-report.json', report: null, readError: 'not found' },
        { host: 'claude', path: '.qa/claude-report.json', report: pass, readError: null },
      ],
      HEAD,
    );
    expect(r.ok).toBe(true);
    expect(r.usable?.host).toBe('claude');
  });

  it('refuses with no candidates rather than vacuously passing', () => {
    expect(findUsableLiveJourneyReceipt([], HEAD).ok).toBe(false);
  });

  it('refuses when headSha itself is unknown, rather than matching against null', () => {
    const r = findUsableLiveJourneyReceipt([{ host: 'codex', path: '.qa/codex-report.json', report: pass, readError: null }], null);
    expect(r.ok).toBe(false);
  });

  it('LIVE_JOURNEY_RECEIPT_PATHS names both hosts under the gitignored .qa/ directory', () => {
    const hosts = LIVE_JOURNEY_RECEIPT_PATHS.map((c: { host: string }) => c.host).sort();
    expect(hosts).toEqual(['claude', 'codex']);
    for (const c of LIVE_JOURNEY_RECEIPT_PATHS) {
      expect((c as { relativePath: string }).relativePath.startsWith('.qa/')).toBe(true);
    }
  });
});

describe('release notes come from the CHANGELOG section', () => {
  const doc = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [4.7.0] — 2026-09-01',
    '',
    '### Added',
    '',
    '- a thing',
    '',
    '## [4.6.1] — 2026-08-23',
    '',
    '- an older thing',
    '',
  ].join('\n');

  it('extracts the section body and stops at the next heading', () => {
    const body = extractChangelogSection(doc, '4.7.0');
    expect(body).toContain('- a thing');
    expect(body).not.toContain('older thing');
    expect(body).not.toContain('## [4.6.1]');
  });

  it('returns null when the version has no section', () => {
    expect(extractChangelogSection(doc, '4.8.0')).toBeNull();
  });

  it('returns null for a header with an empty body', () => {
    // The shape a release gets when `[Unreleased]` was renamed and the entries
    // were never written. Publishing an empty release body is not better than
    // refusing.
    expect(extractChangelogSection(doc, 'Unreleased')).toBeNull();
  });

  it('reads the real CHANGELOG for the version this repo declares', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(extractChangelogSection(changelog, pkg.version)).toBeTruthy();
  });
});

describe('finish-release cuts the release in one call', () => {
  // Structural, and deliberately so: the happy path creates a public GitHub
  // release and publishes to npm, so it cannot be exercised by a test. The
  // regression to guard is not "the output changed" — it is someone splitting
  // this back into `git tag` + `git push origin <tag>` + `gh release create`,
  // whose middle leaves a pushed tag with NO release: publish-npm.yml never
  // fires, and `verify:release` now sees the tag and reports ok. Main would
  // look released while npm did not have it, with no gate left looking.
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/finish-release.mjs'), 'utf8');
  const code = src
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');

  it('creates the tag through `gh release create --target`', () => {
    expect(code).toMatch(/'release',\s*'create'/);
    expect(code).toMatch(/'--target'/);
  });

  it('never pushes a tag by hand', () => {
    expect(code).not.toMatch(/'push'/);
    expect(code).not.toMatch(/'tag',\s*'-a'/);
  });

  it('refuses before it acts', () => {
    // The precondition check has to come first in the file, not after the
    // release call — an order this cheap to get wrong is worth pinning.
    //
    // Both indices are asserted to EXIST first. `indexOf` answers -1 for
    // something that is not there, and -1 is less than every real index — so
    // deleting the precondition call entirely satisfied the ordering
    // assertion, which is the one thing this test exists to prevent.
    const checkAt = code.indexOf('checkReleasePreconditions(');
    const createAt = code.indexOf("'release', 'create'");
    expect(checkAt, 'the precondition check is not called at all').toBeGreaterThan(-1);
    expect(createAt, 'the release call is not there — this file is not what it was').toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(createAt);
  });

  it('asks GitHub what exists before saying nothing was created', () => {
    // A failure signal is not evidence that nothing happened: gh can fail
    // AFTER the release POST succeeded, and "nothing was tagged" would then be
    // a false sentence a human acts on. The failure path has to look.
    expect(code).toMatch(/'release',\s*'view'/);
  });

  it('fetches the one tag it needs, not every tag the remote has', () => {
    // `git fetch --tags` asks for every tag origin has and exits non-zero if
    // ANY of them cannot be written. Measured 2026-08-23 across all 73 tags in
    // this repository: 26 refs disagree with origin (v2.10.1 through v4.1.7,
    // plus benchmark/longmemeval-public-r1) because a history rewrite removed
    // internal documents from those commits. So the wide form fails on every
    // release, immediately after successfully writing the tag it was asked
    // for, and the script printed a warning about a fetch that had worked.
    //
    // Both halves are pinned. The refspec must be built — delete it and this
    // goes red. And `--tags` must not come back on the FETCH — the negative
    // half is break-tested by INSERTING it, not by deleting the refspec,
    // because a not.toMatch also passes when the thing it forbids has become
    // impossible to express.
    //
    // Scoped to the fetch on purpose. `git ls-remote --tags origin` above is a
    // different call with the same flag and is correct: listing every remote
    // tag is exactly what the precondition check needs. A blanket ban on the
    // string would have failed on it — as the first version of this test did.
    expect(code).toMatch(/'fetch',\s*'origin',\s*fetchSpec/);
    expect(code).toMatch(/refs\/tags\/\$\{tag\}:refs\/tags\/\$\{tag\}/);
    expect(code).not.toMatch(/'fetch'[^\]]*'--tags'/);
  });

  it('is wired to an npm script, so it is the documented way in', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['release:finish']).toContain('scripts/finish-release.mjs');
  });

  it('runs `npm run qa:pre-release` itself, gating on its real exit code (G4)', () => {
    expect(code).toMatch(/'run',\s*'qa:pre-release'/);
    expect(code).toMatch(/qaPreReleaseStatus/);
  });

  it('checks for a qa:live-journey receipt for THIS commit, not merely that the command exists (G4)', () => {
    expect(code).toMatch(/findUsableLiveJourneyReceipt/);
    expect(code).toMatch(/LIVE_JOURNEY_RECEIPT_PATHS/);
  });

  it('fails fast on the wrong branch before spending minutes on qa:pre-release', () => {
    // The wrong-branch exit and the expensive spawn are both pinned, and in
    // that order — deleting the fast-fail (or moving it after the spawn)
    // would satisfy every other test in this file while reintroducing the
    // multi-minute wait on a one-line mistake this check exists to avoid.
    const branchGuardAt = code.indexOf("branch !== 'main'");
    const qaSpawnAt = code.indexOf("'run', 'qa:pre-release'");
    expect(branchGuardAt, 'no fast-fail branch guard found').toBeGreaterThan(-1);
    expect(qaSpawnAt, 'the qa:pre-release spawn is not there — this file is not what it was').toBeGreaterThan(-1);
    expect(branchGuardAt).toBeLessThan(qaSpawnAt);
  });
});

describe('shipped paths come from package.json, not a hand-kept list', () => {
  it('lists every `files` entry plus package.json and the lockfile, directories without the trailing slash', () => {
    const paths = shippedPathsFromPackageJson({ files: ['dist/', 'dashboard/dist/', '.claude-plugin/', 'hooks/hooks.json'] });
    expect(paths).toEqual(['dist', 'dashboard/dist', '.claude-plugin', 'hooks/hooks.json', 'package.json', 'package-lock.json']);
  });

  it('covers the surfaces the first hand-kept list missed, using the real package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const paths = shippedPathsFromPackageJson(pkg)!;
    for (const must of ['dist', 'dashboard/dist', 'hooks/hooks.json', 'scripts/hooks', 'skills', '.claude-plugin', 'package.json']) {
      expect(paths, `${must} is shipped and must be guarded`).toContain(must);
    }
  });

  it('returns null (so the guard refuses) when package.json declares no files', () => {
    expect(shippedPathsFromPackageJson({})).toBeNull();
    expect(shippedPathsFromPackageJson({ files: [] })).toBeNull();
  });
});
