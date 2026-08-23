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
}) {
  const blockers = [];
  const tag = `v${pkgVersion}`;

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

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkgVersion))) {
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

  return { ok: blockers.length === 0, blockers };
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
