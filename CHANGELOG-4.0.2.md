# MeMesh v4.0.2 — Release-Readiness Fixes

**Release Date:** 2026-04-24  
**Type:** Patch release candidate after npm v4.0.1 publication

---

## Summary

v4.0.1 is already published on npm, so the follow-up reliability, install, and browser-smoke fixes are prepared as v4.0.2.

## Fixed

- **sqlite-vec vector persistence:** vec0 row IDs are bound as `BigInt`, vector replacement uses delete+insert in a transaction, and embedding blobs preserve typed-array byte offsets.
- **CLI embedding lifecycle:** short-lived CLI `remember` waits for queued embedding writes before closing the database.
- **Vector recall filtering:** vector hits are hydrated with archive, namespace, and tag filters, and non-positive similarity hits are ignored.
- **Hook state directory isolation:** pre-edit recall throttle state follows `MEMESH_DB_PATH` when configured, and session-start clears the same file.
- **Clean consumer install audit:** replaced stale `@xenova/transformers` with maintained `@huggingface/transformers`, removing the vulnerable `onnxruntime-web -> onnx-proto -> protobufjs@6` chain from clean installs.
- **Capability reporting:** Level 0/no-LLM mode reports `onnx` when the local Transformers.js provider is available.
- **Dashboard browser smoke:** `/favicon.ico` returns 204 so packaged dashboard browser smoke is console-clean.
- **Dashboard i18n UX:** all 11 locales have translation key parity, and language changes apply immediately without a full-page reload.
- **Imported memory trust boundary:** imported entities are now marked `trust: untrusted` with import provenance, so shared bundles remain searchable but are excluded from automatic Claude hook injection until reviewed.
- **Hook prompt-injection hardening:** session-start and pre-edit hooks wrap recalled memories as reference data and skip untrusted/imported entities during automatic injection.
- **HTTP bind safety:** `memesh serve` refuses non-loopback hosts unless `--allow-remote` or `MEMESH_HTTP_ALLOW_REMOTE=true` is explicitly set.
- **Private local artifacts:** config, hook throttle state, and session recall-tracking files are chmod-hardened after write (`0700` dirs, `0600` files).

## Documentation

- README test count updated to 463 tests.
- `CHANGELOG.md` now distinguishes published v4.0.1 from v4.0.2 follow-up fixes.
- `docs/plans/README.md` marks historical plans as archived context, not active backlog.
- Obsidian project notes were updated outside the repo to mark stale package facts as historical and note that v4.0.2 follow-up fixes are not published until a new npm release is cut.
- API reference now documents imported-memory auto-context behavior and remote HTTP bind opt-in.

## Verification

- `npm test` — 30 files, 463 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm audit --omit=dev --json` — 0 vulnerabilities.
- `npm run test:packaged` — passed.
- Clean-machine packed install smoke — fresh temp app install, CLI `remember`, CLI `recall`, and clean consumer `npm audit --omit=dev` passed.
- Packaged dashboard browser smoke — `/dashboard` rendered from the packed install with 0 Playwright console warnings/errors; English -> Traditional Chinese -> English language switching updated in-place.
- npm registry verification — npm latest is still v4.0.1 at published gitHead `c936c2548ff886b884c4ba40c83a080b467b4e17`; v4.0.2 is not published yet.
