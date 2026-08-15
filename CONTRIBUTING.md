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

## Security

Do not open public issues for vulnerabilities. Use the private reporting process in [SECURITY.md](SECURITY.md).
