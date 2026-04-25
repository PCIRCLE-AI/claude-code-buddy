# MeMesh v4.0.4 — Doctor Diagnostics & Release Prep

**Release Date:** 2026-04-25  
**Type:** Patch release candidate after v4.0.3

---

## Summary

v4.0.4 packages the activation-and-trust follow-up work around `memesh doctor`, release-facing install diagnostics, and the supporting packaging/doc cleanup needed to make those checks trustworthy.

## Added

- **CLI `memesh doctor`:** new local diagnostics command that verifies install method, DB access, config readability, `.mcp.json`, hook config, shipped hook scripts, dashboard artifact presence, runtime capabilities, cached update state, and optional HTTP reachability.
- **Machine-readable doctor output:** `memesh doctor --json` returns per-check results and overall status for support automation and scripted verification.
- **Focused doctor regression coverage:** added tests for healthy installs, invalid MCP config, missing hook scripts, and first-run warning states.

## Improved

- **Troubleshooting path:** README and platform troubleshooting now tell users to run `memesh doctor` for end-to-end local verification.
- **CLI messaging consistency:** the top-level CLI description now matches the local coding-agent positioning used elsewhere in the package.
- **Hook packaging correctness:** `pre-edit-recall.js` now ships executable, and the build step applies executable bits consistently to all shipped hook scripts.
- **Database failure clarity:** doctor now surfaces the real DB open failure message instead of hiding it behind a generic error.

## Documentation

- `CHANGELOG.md` now includes the v4.0.4 batch.
- Package, plugin, and dashboard metadata now align on `4.0.4`.
- README test count now reflects the current full-suite result of 489 tests.

## Verification

- `npm run typecheck` — passed.
- `npm test -- --run` — 34 files, 489 tests passed.
- `npm run build` — passed.
- `npm run test:packaged` — passed.
- `npm run test:e2e-dashboard` — passed.
- `npm publish --dry-run --access public` — planned as final pre-release gate.
