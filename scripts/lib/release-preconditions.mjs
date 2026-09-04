// What must be true before a release is cut — as a pure function, and the
// release notes extractor that goes with it.
//
// `scripts/lib/published-version.mjs` catches the state this file exists to
// prevent: `main` declaring a version that no tag, and therefore no npm
// release, backs. Its error message names the way out in prose — "tag
// vX.Y.Z and `gh release create`" — and prose in an error string is a
// suggestion, not a gate. Nothing performed those steps, so the release was
// three hand-typed commands whose middle could be interrupted by a crash, a
// context switch, or an assistant deciding the session was over. v4.2.11 sat
// in that middle for five days.
//
// The window cannot be closed by documenting it better. It is closed by
// making the whole release one command that either refuses or completes:
// `npm run release:finish`.
//
// Kept as a pure function, separate from the script that runs it, for the
// same reason `published-version.mjs` is: the happy path cannot be exercised
// locally without cutting a real release, so the only way both directions get
// pinned is to hand the decision its inputs.

/**
 * Every input is tri-state on purpose: `null` means "could not read it", and
 * every `null` blocks. Absence is not evidence — a shallow clone reporting no
 * tags must not read as "the tag is free".
 *
 * @param {object} input
 * @param {string|null}   input.branch        Current branch, or null if undiscoverable.
 * @param {boolean|null}  input.isClean       Working tree clean? null if `git status` failed.
 * @param {string|null}   input.headSha       Local HEAD sha.
 * @param {string|null}   input.remoteHeadSha `origin/main` sha, freshly fetched.
 * @param {string}        input.pkgVersion    `package.json` version.
 * @param {string[]|null} input.localTags     Every `v*` tag in the checkout.
 * @param {string[]|null} input.remoteTags    Every `v*` tag on `origin`.
 * @param {string|null}   input.repoSlug      `owner/name` as `gh` reports it — proof gh is authenticated.
 * @param {string|null}   input.notes         Release body, already resolved.
 * @param {number|null}   input.qaPreReleaseStatus   Exit code of `npm run qa:pre-release`, run fresh by this script; null if it could not run at all.
 * @param {LiveJourneyCandidate[]} input.liveJourneyCandidates  See `findUsableLiveJourneyReceipt`.
 * @returns {{ok: boolean, blockers: string[]}}
 */
export function checkReleasePreconditions({
  branch,
  isClean,
  headSha,
  remoteHeadSha,
  pkgVersion,
  localTags,
  remoteTags,
  repoSlug,
  notes,
  shippedFilesChangedSinceBump,
  qaPreReleaseStatus,
  liveJourneyCandidates,
}) {
  const blockers = [];
  const tag = `v${pkgVersion}`;

  // Claude Code keys its plugin cache by version. A machine that auto-updates
  // from the marketplace between the commit that bumped package.json and the
  // tag gets a cache named `<version>/` built from that earlier tree — and
  // nothing ever refreshes it, because the version never changes again. For
  // 4.8.2 that was 19 commits, including the graph repair the release was
  // for. So: once the version is bumped, the shipped tree must not move.
  // A fix that lands after the bump needs its own version.
  if (!Array.isArray(shippedFilesChangedSinceBump)) {
    blockers.push(
      `could not list the shipped files changed since package.json was bumped to ${pkgVersion} — ` +
        'refusing rather than assuming none were (a shallow clone reports this)'
    );
  } else if (shippedFilesChangedSinceBump.length > 0) {
    const shown = shippedFilesChangedSinceBump.slice(0, 8).join(', ');
    const more = shippedFilesChangedSinceBump.length > 8 ? `, … (${shippedFilesChangedSinceBump.length} files)` : '';
    blockers.push(
      `shipped files changed after package.json was bumped to ${pkgVersion} (${shown}${more}) — ` +
        'plugin caches that already staged this version will never pick them up. Bump to the next ' +
        'version in its own commit and release that instead'
    );
  }

  if (branch !== 'main') {
    blockers.push(
      `not on main (branch: ${branch ?? 'undiscoverable'}) — a release is cut from ` +
        'main after the release PR is merged, never from the branch that raised it'
    );
  }

  if (isClean !== true) {
    blockers.push(
      isClean === null
        ? 'could not read `git status` — refusing to release from a tree whose state is unknown'
        : 'the working tree has uncommitted changes — the release would advertise a commit that is not what you are looking at'
    );
  }

  // A tag pushed to origin drags its commit along. Releasing from a local HEAD
  // that origin has not seen would put unreviewed commits on `main` through
  // the tag, bypassing the PR the branch protection exists to require.
  if (headSha === null || remoteHeadSha === null) {
    blockers.push(
      'could not compare local HEAD with `origin/main` — refusing rather than ' +
        'guessing (`git fetch origin main` first)'
    );
  } else if (headSha !== remoteHeadSha) {
    blockers.push(
      `local HEAD (${headSha.slice(0, 8)}) is not \`origin/main\` (${remoteHeadSha.slice(0, 8)}) — ` +
        'push or pull first; a release cut here would carry commits main has never reviewed'
    );
  }

  // No prerelease suffix on purpose. Nothing here handles one: `gh release
  // create` would mark `4.7.0-rc.1` as latest without `--prerelease`, and
  // publish-npm.yml runs `npm publish` with no `--tag`, so it would take npm's
  // `latest` dist-tag too. This project has never shipped a prerelease; when
  // it does, that is its own change, not a regex that quietly permits it.
  if (!/^\d+\.\d+\.\d+$/.test(String(pkgVersion))) {
    blockers.push(`package.json version \`${pkgVersion}\` is not a version this can tag`);
  }

  // Absence is not evidence, twice over. An empty tag list is what a shallow
  // clone reports, and reading it as "the tag is not taken" would let this
  // re-cut a release that already shipped.
  for (const [label, tags] of [
    ['the checkout', localTags],
    ['origin', remoteTags],
  ]) {
    if (!Array.isArray(tags) || tags.length === 0) {
      blockers.push(
        `no \`v*\` tag is visible in ${label}, so "is ${tag} already taken" could not be ` +
          'answered. Reporting "not checked" rather than assuming it is free'
      );
    } else if (tags.includes(tag)) {
      blockers.push(
        `${tag} already exists in ${label} — this release was already cut. If the npm ` +
          'publish is what is missing, re-run the `Publish to npm` workflow instead of re-tagging'
      );
    }
  }

  // gh does the tagging AND the release in one call, so it has to be working
  // before anything is created. Discovering a broken `gh` afterwards is
  // precisely the half-done state this command exists to make impossible.
  if (!repoSlug) {
    blockers.push(
      '`gh` could not name this repository — it is missing, unauthenticated, or ' +
        'offline. Run `gh auth status`; releasing needs it, and finding that out ' +
        'after the tag exists is the half-finished release this command replaces'
    );
  }

  if (!notes || !notes.trim()) {
    blockers.push(
      `no release notes for ${tag} — add a \`## [${pkgVersion}]\` section to CHANGELOG.md, ` +
        'or pass `--notes-file <path>`'
    );
  }

  // G4: real-credential checks CI cannot run — see finish-release.mjs for why
  // each is gathered the way it is.
  if (qaPreReleaseStatus !== 0) {
    blockers.push(
      `\`npm run qa:pre-release\` did not pass (${
        qaPreReleaseStatus === null ? 'could not run it at all' : `exit ${qaPreReleaseStatus}`
      }) — fix what it reported, then re-run \`npm run release:finish\``
    );
  }

  const liveJourney = findUsableLiveJourneyReceipt(liveJourneyCandidates, headSha);
  if (!liveJourney.ok) {
    blockers.push(
      'no usable `npm run qa:live-journey` receipt for this exact commit — run ' +
        `\`npm run qa:live-journey -- --host codex --out ${LIVE_JOURNEY_RECEIPT_PATHS[0].relativePath}\` ` +
        '(or `--host claude` from an interactive Claude Code session) first. ' +
        (Array.isArray(liveJourneyCandidates) && liveJourneyCandidates.length > 0
          ? `Checked: ${liveJourney.reasons.join('; ')}`
          : 'No candidates were even checked — this is a caller bug, not a missing receipt.')
    );
  }

  return { ok: blockers.length === 0, blockers };
}

/**
 * @typedef {{host: string, path: string, report: object|null, readError: string|null}} LiveJourneyCandidate
 */

/**
 * Where `finish-release.mjs` looks for a `qa:live-journey` report, relative to
 * the repo root. `npm run qa:live-journey -- --host <host> --out <relativePath>`
 * writes exactly this shape. Order does not encode preference — either host
 * satisfies the gate — it only fixes which command this file's own messages
 * suggest first.
 */
export const LIVE_JOURNEY_RECEIPT_PATHS = [
  { host: 'codex', relativePath: '.qa/codex-report.json' },
  { host: 'claude', relativePath: '.qa/claude-report.json' },
];

/**
 * Is any ONE of the candidate `qa:live-journey` reports usable as proof for
 * THIS release? Any host qualifies — only the Codex path can be driven
 * unattended today, but nothing here prefers it over a Claude-host receipt a
 * human actually produced.
 *
 * A receipt is usable only if it is readable, is the report shape
 * `live-journey.mjs` actually emits, passed, was not run against a dirty
 * tree (a dirty-tree run does not describe any single commit), and names
 * THIS exact commit — an older PASS proves an earlier revision, not this one.
 *
 * @param {LiveJourneyCandidate[]} candidates
 * @param {string|null} headSha
 * @returns {{ok: boolean, usable: LiveJourneyCandidate|null, reasons: string[]}}
 */
export function findUsableLiveJourneyReceipt(candidates, headSha) {
  const reasons = [];
  if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, usable: null, reasons };
  if (!headSha) {
    return { ok: false, usable: null, reasons: ['HEAD sha is unknown, so no receipt could be matched to it'] };
  }
  for (const candidate of candidates) {
    const label = `${candidate.path} (${candidate.host})`;
    if (!candidate.report) {
      reasons.push(`${label}: ${candidate.readError === 'not found' ? 'not found' : `unreadable — ${candidate.readError}`}`);
      continue;
    }
    const report = candidate.report;
    if (report.schema_version !== 'memesh-live-journey/v1') {
      reasons.push(`${label}: not a memesh-live-journey/v1 report`);
      continue;
    }
    if (report.verdict !== 'PASS') {
      reasons.push(`${label}: verdict is ${JSON.stringify(report.verdict ?? null)}, not PASS`);
      continue;
    }
    if (report.dirty !== false) {
      reasons.push(`${label}: ran against a dirty working tree, so it does not describe one commit`);
      continue;
    }
    if (report.revision !== headSha) {
      reasons.push(
        `${label}: revision ${String(report.revision ?? '?').slice(0, 8)} does not match HEAD ${headSha.slice(0, 8)}`
      );
      continue;
    }
    return { ok: true, usable: candidate, reasons };
  }
  return { ok: false, usable: null, reasons };
}

/**
 * The body of `## [X.Y.Z]` in a CHANGELOG, up to the next `## ` heading.
 *
 * Returns null when the section is absent OR present but empty — an empty
 * section is the shape a release gets when the header was renamed from
 * `[Unreleased]` and the entries were never written, and publishing an empty
 * release body is not better than refusing.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string|null}
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== 'string') return null;
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Same header shape `check-version-coherence.mjs` accepts: `## [4.6.1] — 2026-08-23`.
  //
  // `[^\n]*`, not `[\s—-]*.*`: `\s` matches a newline inside a character
  // class even under `/m`, so the greedy first attempt walked past the blank
  // line and swallowed the NEXT version's header — asked for `[Unreleased]`,
  // it returned 4.7.0's entries. The header has to end at the end of its line.
  const header = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm');
  const start = changelog.match(header);
  if (!start) return null;
  const after = changelog.slice(start.index + start[0].length);
  const next = after.search(/^## /m);
  const body = (next === -1 ? after : after.slice(0, next)).trim();
  return body.length > 0 ? body : null;
}

/**
 * The paths a release ships, read from package.json so the guard cannot drift
 * from the tarball: every `files` entry, plus package.json and its lockfile.
 * A trailing slash means a directory; `git diff -- <dir>` takes it either way.
 */
export function shippedPathsFromPackageJson(pkg) {
  const files = Array.isArray(pkg?.files) ? pkg.files.filter(f => typeof f === 'string' && f.length > 0) : [];
  if (files.length === 0) return null;
  return [...new Set([...files.map(f => f.replace(/\/+$/, '')), 'package.json', 'package-lock.json'])];
}
