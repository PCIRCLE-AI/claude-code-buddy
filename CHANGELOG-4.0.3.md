# MeMesh v4.0.3 — Update UX & Localization

**Release Date:** 2026-04-25  
**Type:** Patch release candidate after v4.0.2

---

## Summary

v4.0.3 packages the post-v4.0.2 work around update truthfulness, install-aware guidance, stale/offline dashboard UX, and localized README/dashboard copy.

## Improved

- **Localized docs and UI copy:** all 10 non-English README variants were rewritten into shorter, more natural localized guides, and the dashboard no longer relies on leftover hardcoded English strings in the reviewed paths.
- **Truthful update checks:** npm lookup failures no longer get reported as "already on latest"; MeMesh now preserves the last successful result and separately records the latest attempt and failure.
- **Install-aware update guidance:** CLI and dashboard now distinguish `npm-global`, `npm-local`, `source-checkout`, and `unknown` install methods so self-update guidance only appears where it is actually supported.
- **Stale-aware dashboard updates:** Settings now shows cached vs fresh vs stale vs unavailable states, loads cached update status first, refreshes in the background, and provides a manual `Check now` action.

## Added

- **Richer update metadata:** update status now carries `lastAttemptAt`, `lastSuccessfulCheckAt`, `lastError`, and freshness state.
- **HTTP update-status contract:** `GET /v1/update-status` now documents and returns the richer freshness/install-channel metadata used by the packaged dashboard.
- **Focused regression coverage:** added tests for install-channel detection, version-check freshness/error preservation, HTTP update-status states, updater verification, and dashboard i18n parity.

## Documentation

- README test count updated to 484 tests.
- `CHANGELOG.md` now includes the v4.0.3 batch.
- `docs/api/API_REFERENCE.md` and `docs/ARCHITECTURE.md` now track v4.0.3 current-version references.
- `dashboard/package.json` metadata now aligns with the main release version instead of staying on a stale internal `3.0.0`.

## Verification

- `npm run typecheck` — passed.
- `npm test -- --run` — 33 files, 484 tests passed.
- `npm run build` — passed.
- `npm run test:packaged` — passed.
- `npm run test:e2e-dashboard` — passed.
- `npm publish --dry-run --access public` — passed.
