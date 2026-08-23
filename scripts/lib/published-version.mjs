// Does `main` declare a version that anyone can actually install?
//
// v4.2.11 was bumped on 2026-07-29 and not tagged until 2026-08-03. For five
// days `main` said `4.2.11` while npm's `latest` said `4.2.10`, and the
// CHANGELOG grew a paragraph explaining the gap — a paragraph that was still
// there, and by then false, when the release finally shipped. Nothing detected
// any of it, because nothing was looking.
//
// The rule this enforces: **a version bump never rides in a feature or docs
// PR.** `main` carries the last PUBLISHED version and work accumulates under
// `CHANGELOG.md`'s `[Unreleased]`. A release bumps the anchors, renames the
// section, tags and publishes in one sitting — so the window where `main`
// declares an uninstallable version is minutes, and this check is what makes
// those minutes loud instead of silent.
//
// Loud is not short, though: this check can only shout, and the remedy it
// names used to be prose nobody had automated. `scripts/finish-release.mjs`
// (`npm run release:finish`) is that remedy as one command, so the window is
// the length of one API call rather than however long the next person takes.
//
// Kept as a pure function, separate from the script that runs it, so both
// directions can be pinned by a test without a repository to mutate. A gate
// nobody break-tested is the defect class this repository keeps finding.

/**
 * @param {object} input
 * @param {string|null} input.branch      Current branch, or null if undiscoverable.
 * @param {string}      input.pkgVersion  `package.json` version.
 * @param {string[]}    input.tags        Every `v*` tag visible to the checkout.
 * @returns {{status: 'ok'|'skipped'|'error', message: string}}
 */
export function checkMainDeclaresPublishedVersion({ branch, pkgVersion, tags }) {
  if (branch !== 'main') {
    return {
      status: 'skipped',
      message:
        `not on main (branch: ${branch ?? 'undiscoverable'}) — a release branch ` +
        'legitimately carries the bump for the minutes before the tag exists',
    };
  }

  // Absence is not evidence. `actions/checkout` fetches no tags by default, and
  // an empty list would otherwise read as "no mismatch found" — the gate would
  // pass on every run while checking nothing, which is precisely the shape of
  // the checks 4.2.11 spent a release removing. Say "could not run" and fail.
  if (!Array.isArray(tags) || tags.length === 0) {
    return {
      status: 'error',
      message:
        'no `v*` tag is visible, so this check could not run. A shallow ' +
        '`actions/checkout` fetches no tags — set `fetch-tags: true` on the ' +
        'checkout step. Reporting "not checked" rather than passing.',
    };
  }

  if (tags.includes(`v${pkgVersion}`)) {
    return { status: 'ok', message: `v${pkgVersion} is tagged` };
  }

  return {
    status: 'error',
    message:
      `main declares ${pkgVersion} and no \`v${pkgVersion}\` tag exists — ` +
      'that version is not installable by anyone. Either finish the release ' +
      '(`npm run release:finish` — one call that creates the tag and the ' +
      'GitHub Release together; the release is what triggers publish-npm.yml, ' +
      'a bare tag push does not), or revert the bump and put the work back ' +
      'under `## [Unreleased]`.',
  };
}
