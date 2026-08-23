# Contributing to MeMesh

MeMesh is intentionally small. Changes should preserve that shape: a minimal MCP surface, SQLite-backed persistence, and predictable packaging.

## Prerequisites

- Node.js 22.5 or newer (`package.json` `engines.node`; Node 20 reached end of life on 2026-03-24)
- npm

## Local Setup

```bash
npm install
npm run typecheck
npm run build
npm test -- --run
npm run test:packaged
```

`npm run test:packaged` is required for changes that affect packaging, hooks, CLI assets, release automation, or any file included in the published npm tarball.

## Documentation Discipline (PR-review gate)

Documentation is part of the change, not follow-up work. The CI's `Version coherence` step and `Doctor (manifest + hooks integrity gate)` step enforce the most-fragile parts of this discipline; everything else is reviewer-judgment.

- Update `README.md` when behavior, installation, or development workflow changes (and re-sync the 2 locale parities — `README.zh-TW.md`, `README.de.md`).
- Update `docs/api/API_REFERENCE.md` when the MCP / HTTP / CLI surface changes (and bump its `**Version**: ` line on a release).
- Update `docs/ARCHITECTURE.md` when module structure, storage behavior, or packaging flow changes (and bump its `**Version**: ` line on a release).
- Read `DESIGN.md` before any dashboard change that touches colour, type, spacing or an interaction, and update it when a token or rule changes. It is derived from `dashboard/src/styles/global.css`; when the two disagree the CSS is what ships, so fix whichever is wrong rather than leaving them apart.
- Keep version metadata coherent: `package.json` + **`package-lock.json` (both the root `version` and `packages[""].version`)** + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` `plugins[].version` + `CHANGELOG.md` `## [X.Y.Z]` header + the two `**Version**:` lines above must all match. The `node scripts/check-version-coherence.mjs` check (run as a CI step) catches partial bumps. `package-lock.json` is called out because it is the one that drifted silently across four releases (4.2.6 through 4.2.10) while every other anchor stayed correct — `npm version` updates it, hand-editing `package.json` does not.
- After ANY change to `.claude-plugin/`, `scripts/hooks/`, `skills/`, or version files, run `npm run build` so `dist/skills-manifest.json` regenerates. Otherwise `memesh doctor` reports `Skills + hooks integrity FAIL` and users see "memesh setup is incomplete" in their dashboard. CI's `Doctor` step catches this before merge.

`CLAUDE.md` carries the same rules in the form an AI coding assistant reads. It is a pointer file — this document is the source of truth for anything that applies to a human contributor.

## Pull Requests

- Use the project's `.github/pull_request_template.md` — it loads automatically when you open a PR. Fill in the "Docs synced" checklist; an unfilled checklist is treated as not-ready-for-review.
- Keep pull requests focused. Smaller changes are easier to review and safer to release.
- Include tests for behavior changes when practical.
- Note any packaging or migration impact in the PR description.
- If your change affects the published artifact, mention that `npm run test:packaged` passed.
- If your change touches `scripts/hooks/*.js` or any hook payload consumer, follow the hook-change protocol: real-payload fixture (capture from a live Claude Code transcript), default-allow on optional fields, stderr-trace every silent exit, end-to-end install test in a real Claude Code session, `memesh doctor` hook-activity green post-install.

## Cutting a Release

A release is one operation, not three commands:

```bash
git checkout main && git pull        # the release PR is already merged
npm run release:finish -- --dry-run  # what it would do, or every reason it refuses
npm run release:finish
```

`npm run release:finish` (`scripts/finish-release.mjs`) creates the tag and the
GitHub Release in a single `gh release create` call, and that release — not a
bare tag push — is what triggers `.github/workflows/publish-npm.yml`. It refuses
unless it is on `main`, the tree is clean, local `HEAD` matches `origin/main`,
`vX.Y.Z` is not already taken locally or on `origin`, `gh` is authenticated, and
`CHANGELOG.md` has a `## [X.Y.Z]` section to publish as the release body. Every
reason it refuses is printed at once, so a `--dry-run` tells you the whole list
rather than the first item.

Pick the release body deliberately. With no `--notes-file` it publishes the
whole `## [X.Y.Z]` CHANGELOG section — complete, and long: 4.6.1's was 26,355
characters. The bodies actually published for 4.6.1 and 4.6.0 were 2,790 and
1,949 characters of curated highlights, written by hand and passed with
`--notes-file <path>`.
Either is a reasonable release; the command prints the first lines of whichever
it resolved before it acts, and after the call it is too late to look.

The tag it creates is lightweight rather than annotated. Nothing in this
repository reads the difference — there is no `git describe` anywhere, and
`git tag --list`, `git ls-remote --tags` and CI's `fetch-tags: true` treat both
alike. No ruleset needs pausing either: `Protect release and benchmark tags`
covers `refs/tags/v*` with `deletion` and `non_fast_forward` rules only, so tag
*creation* is not what it blocks.

Why it is one call rather than `git tag` + `git push` + `gh release create`: the
middle of that sequence leaves a pushed tag with no release. Nothing publishes,
because `publish-npm.yml` fires on `release: published` — and the version
coherence gate now sees the tag and reports ok, so `main` would look released
while npm did not have it, with nothing left looking.

Between merging the release PR and creating the release, `main` declares a
version nobody can install, and `npm run verify:release` on `main` FAILS by
design with "main declares X.Y.Z and no vX.Y.Z tag exists". That failure is
`scripts/lib/published-version.mjs` working, not a bug to investigate — v4.2.11
sat in that state for five days. Finish the release; do not go looking into the
red.

Then watch the workflow run it prints. npm's registry lags a green publish by
minutes: `npm view` still answering with the previous version is the registry
catching up, not a failed publish, and a following `npm install` failing with
`ETARGET` is npm's local metadata cache, which `--prefer-online` gets past.

## Security

Do not open public issues for vulnerabilities. Use the private reporting process in [SECURITY.md](SECURITY.md).
