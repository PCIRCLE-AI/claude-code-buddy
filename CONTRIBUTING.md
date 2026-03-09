# Contributing to MeMesh

MeMesh is intentionally small. Changes should preserve that shape: a minimal MCP surface, SQLite-backed persistence, and predictable packaging.

## Prerequisites

- Node.js 20 or newer
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

## Documentation Discipline

Documentation is part of the change, not follow-up work.

- Update `README.md` when behavior, installation, or development workflow changes.
- Update `docs/api/API_REFERENCE.md` when MCP tool signatures, parameters, or responses change.
- Update `docs/ARCHITECTURE.md` when module structure, storage behavior, or packaging flow changes.
- Keep `package.json`, `package-lock.json`, and `plugin.json` version metadata aligned.

The repository-level engineering rules in `CLAUDE.md` apply to contributor changes as well.

## Pull Requests

- Keep pull requests focused. Smaller changes are easier to review and safer to release.
- Include tests for behavior changes when practical.
- Note any packaging or migration impact in the PR description.
- If your change affects the published artifact, mention that `npm run test:packaged` passed.

## Security

Do not open public issues for vulnerabilities. Use the private reporting process in [SECURITY.md](SECURITY.md).
