# Changelog

All notable changes to MeMesh are documented here.

## [4.1.3] — 2026-05-06

Update-mechanism UX completion. Two features that were noted as gaps in the v4.1.x update story land here.

### Added
- **Deprecation-aware session-start banner.** The npm registry check now reads the deprecation flag for the *currently installed* version, not just the latest available one. When maintainers flag a version (typically for a security advisory), the next session-start prepends a strong `⚠️ MeMesh <ver> is DEPRECATED by maintainers — <message>` banner above the recall summary, until the user upgrades. The flag round-trips through `~/.memesh/update-check.json` so a transient network failure can't dim the warning. `memesh update-status` and `memesh doctor` surface the same line.
- **Opt-in `autoUpdate` policy field.** New `autoUpdate` config field (`'off' | 'patch' | 'minor' | 'major'`, default `'off'`) and matching `MEMESH_AUTO_UPDATE` env var with env > config > default precedence. The session-start hook now records a "PENDING" entry in `~/.memesh/auto-update.log` when the policy permits the bump and the cache is fresh; it does NOT yet spawn `npm install -g`. Spawning during an active session would race other memesh hooks (pre-edit, post-commit, session-summary) reading the same `dist/` tree mid-replace, so the actual upgrade trigger is being moved to the Stop hook in v4.1.4 — that's the safe moment when no peer hooks fire from the same install. v4.1.3 ships the policy resolution, deprecation-override decision matrix, and HTTP / dashboard surfaces so a v4.1.4 patch is the single missing piece. Until then, run `memesh update` manually after seeing the PENDING line.
- **Background update-cache refresh.** Every session-start fires a detached `memesh status` to keep the registry cache fresh for the next run, regardless of whether auto-update was pending. The session itself reads only the cache, so a slow npm registry never blocks startup.
- **`.github/workflows/deprecate-npm.yml`** — manually-triggered maintainer helper that runs `npm deprecate` against any published version using the existing `NPM_TOKEN` secret. Closes the gap that surfaced when v4.1.1 needed an immediate deprecation but the maintainer's local npm session required 2FA.

### Notes
- 618 unit/integration tests pass (25 new regression tests, covering: `parseAutoUpdatePolicy` + `classifyBump` + `decideAutoUpdate` policy & deprecation-override matrix; `resolveAutoUpdatePolicy` env > config > default precedence; deprecation round-trip through the cache; format-output with leading deprecation warning; stale-version-mismatch invalidation).
- No public API breaks. Default behaviour is unchanged for users who don't set `autoUpdate` / `MEMESH_AUTO_UPDATE`. The deprecation banner appears only when npm has actually flagged the installed version — every release prior to v4.1.1 stays silent.

## [4.1.2] — 2026-05-06

Patch release for findings raised by GitHub code-scanning (CodeQL) and the Windows CI lane on the v4.1.1 cut.

### Security
- **HIGH — `js/polynomial-redos` in `bearerAuth`** (`src/transports/http/server.ts`). The header parser used a regex of the shape `/^Bearer\s+(.+)$/i` against the trimmed Authorization header. Both `\s+` and `.+` match whitespace, so an attacker-controlled header that is mostly whitespace forced the regex engine to enumerate every split between the two quantifiers — quadratic in input length. Replaced with a single linear scan: find the first whitespace, verify the prefix is the literal `Bearer`, take the suffix. Regression test sends a 10 000-character whitespace-padded header and asserts both 401 and a sub-500 ms response (a return to the old quadratic shape would blow that bound).

### Fixed
- **Windows CI: `tests/hooks/plugin-root-and-drift.test.ts`** previously asserted `pathToFileURL('/abs/path/...')` round-tripped to a POSIX literal. On Windows the round-trip yields `D:\abs\path\...`, which is correct OS behaviour; the test was not platform-aware. The synthetic input is now built from `path.parse(process.cwd()).root` so the assertion holds on POSIX and Windows alike. The production hook code itself was already platform-correct (Node's `path.dirname` is OS-aware) — this was a test-only fix.

### Notes
- Five MEDIUM `js/file-access-to-http` alerts (`src/core/llm-client.ts`) flagged the LLM client for sending operator-supplied API keys (read from `~/.memesh/config.json`) to hard-coded provider endpoints — that is the intended behaviour of a BYOK client. Dismissed as `used in tests` / by-design with a rationale comment recorded on each alert.

## [4.1.1] — 2026-05-06

v4.1.1 fixes ten issues identified in the v4.1.0 refactor. Each fix ships with a regression test.

### Fixed
- **Hook dynamic-import path off-by-one** — `scripts/hooks/session-start.js` and `session-summary.js` computed the package root with `dirname(dirname(fileURLToPath(import.meta.url)))`. The hooks live at `<root>/scripts/hooks/<file>.js`, so two `dirname()` hops only reach `<root>/scripts`; subsequent `await import('<pkg>/scripts/dist/db.js')` calls got `ENOENT`, and a surrounding `catch` swallowed the error. Net result: weekly noise compression *and* LLM failure analysis were silently non-functional in v4.1.0. Both call sites now use a shared `resolvePluginRoot()` helper that performs the correct three-hop calculation. Regression test asserts the result resolves to a directory containing `package.json`.
- **Hook config drift on `MEMESH_DB_PATH`** — `scripts/hooks/_shared.js#readHookConfig` previously read `dirname(MEMESH_DB_PATH)/config.json`, while `src/core/config.ts` always reads/writes `~/.memesh/config.json`. Any custom-DB deployment silently ignored `memesh config set …` from the hooks (auto-capture, session limit, agentic-orchestration). Hooks now read the canonical homedir path unconditionally; tests pin both the new behaviour and the rejection of any DB-relative override.
- **Dashboard 401-on-load on remote bind** — When `MEMESH_REMOTE_TOKEN` was set, the server protected `/dashboard` (HTML) and `/v1/*` with bearer auth, but browsers cannot attach an `Authorization` header on a top-level navigation, and the dashboard SPA never sent a Bearer header on `fetch`. Result: every remote deployment broke the UI on first load. The HTML route is now served unauthenticated; the SPA reads the token from `localStorage` and attaches it to all `/v1/*` calls. A 401 surfaces an in-page token-entry prompt (`AuthPrompt` component) so the operator can paste the token without leaving the page.
- **Pre-auth JSON parse DoS** — `app.use(express.json({ limit: '1mb' }))` was registered globally before `bearerAuth`, so unauthenticated requests could trigger up to 1 MB of JSON parsing before the 401. The body parser is now scoped to `/v1/*` and registered after `bearerAuth` and `apiLimiter`. Regression test confirms a malformed-JSON body without auth returns 401 (not 400).
- **`remoteToken` module-global clobber** — A second `startServer()` bound to loopback used to overwrite the module-global `remoteToken` to `null`, silently de-authenticating any already-running remote listener attached to the same Express app. Auth requirement is now per-listener via a `WeakMap<http.Server, boolean>` keyed on `req.socket.server`. Remote and loopback listeners on the same app no longer cross-authenticate. Regression test stands up both listeners and asserts each keeps its own auth profile.
- **`verify_agent_work` rejected monorepo subdirectories** — `validateWorkdir` checked for a `.git` entry directly inside `workdir`, which rejected paths like `/repo/packages/app` even though every subsequent `git -C <workdir>` call would have succeeded. The function now asks git itself via `rev-parse --is-inside-work-tree`, which correctly accepts subdirectories of a working tree (and still handles `.git` files for worktrees/submodules).
- **`verify_agent_work` symlink bypass** — The same function used `path.resolve()`, which only normalises `./..` and does not follow symlinks. A symlink pointing at a different git repo passed validation while git operations actually ran against the symlink target. Now uses `realpathSync()` so the validated path is the path git operates on; the recorded report cites both the canonical path and the original input when they differ.
- **`removeFromFts()` swallowed real DB errors** — The contentless-FTS5 delete helper caught every exception, masking real failures (lock contention, disk full, schema corruption) the same way it masked the legitimate "row not found" case. The index could drift out of sync with the entities table with no operator signal. Now classifies errors: known-benign cases (`no such rowid`, value mismatch, no-such-row) silently no-op; everything else logs a single-line warning to `stderr`. Function still never throws so callers' atomic semantics are preserved.
- **WAL/SHM permission leak on sidecar recreation** — `db.ts` chmodded `<db>`, `<db>-wal`, and `<db>-shm` once at `openDatabase`, but SQLite recreates `-wal` and `-shm` later during normal operation (checkpoint truncate, fresh shm-mapping) using the process umask. On a default umask (0022) those recreated sidecars could be created world-readable, which on a multi-user host could expose observation data to other local accounts. The fix tightens `process.umask` to `0o077` before the first DB write so any later-created sidecars are born `0600`.
- **`memesh remember "..."` deterministic same-day collision** — The quick-capture path generated `quick-<date>-<slug>` from text + date. Two `memesh remember "fixed bug"` calls on the same day collapsed into one entity (because `remember()` appends observations on duplicate-name) — silent data loss for journal-style usage. Names now carry a 6-hex-char random suffix; each call is a distinct entity. Regression test runs the same text twice and asserts distinct entity names.

### Notes
- 593 unit/integration tests now pass (12 added in this release, exclusively regression tests for the items above).
- No public API breaks; tool signatures and HTTP routes are unchanged. Operators with a custom `MEMESH_DB_PATH` may need to migrate their `config.json` to `~/.memesh/config.json`, which is now the canonical location read by all components.

## [4.1.0] — 2026-05-04

### Added
- **9th MCP tool — `verify_agent_work`** — Persist agent verification reports as `verification_record` entities. Runs a deterministic git reality-check (diff `<base>..HEAD`, count files changed, optionally cross-check against a claimed file count) and stores the report tagged `verification:pass|fail`. Heavier checks (typecheck/tests/lint/build) are expected to be pre-computed externally and passed in via `report.*.pass`. New core module `src/core/verifier.ts`; HTTP endpoint `POST /v1/verify`; CLI `memesh verify <workdir>`.
- **`agentic-orchestration` skill** — Ships at `skills/agentic-orchestration/SKILL.md`. Defines the User=CTO / Claude=Orchestrator / Background-agents=Engineering team protocol, three-tier verifiability classifier, dispatch patterns (single bg, parallel bg, foreground, hybrid), and a mandatory post-agent verification gate. **Active surfaces (banner + Bash nudge + telemetry) are opt-in via `MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1`** (see *Changed* below).
- **6th hook — `pre-bash-orchestration-nudge.js`** — PreToolUse hook on Bash that injects a one-line advisory hint when Claude is about to run a high-verifiability command (test, build, lint, migrate, deploy, benchmark, npm-run-check). Throttled per category per session via per-category marker files.
- **`memesh remember` quick-capture form** — `memesh remember "OAuth 2.0 with PKCE"` now works without `--name`/`--type`. Fresh users naturally try this form first; the explicit-flag form remains the canonical contract.
- **Multi-reviewer PR workflow GitHub Action** — `.github/workflows/multi-model-review.yml` runs independent automated code reviews on every PR diff and posts results as comments to surface non-overlapping findings. No-ops cleanly if reviewer secrets are unset.
- **LongMemEval-S benchmark — public methodology + verifiable evidence** — Three-mode benchmark runner at `benchmarks/longmemeval/run.mjs`, full per-question results in `benchmarks/longmemeval/results/`, methodology in `METHODOLOGY.md`, 8-step reproduction in `REPRODUCE.md`, manual verification log in `MANUAL-VERIFICATION.md`. Mode A = R@5 95.40%, Mode B = R@5 95.40%, Mode C = R@5 82.40%. Dataset SHA256 verified against Hugging Face `xiaowu0162/longmemeval` (longmemeval_s variant). README first page now links the evidence pack so the proof point is visible without diving into `benchmarks/`.
- **`MEMESH_ENABLE_AGENTIC_ORCHESTRATION` env flag** — Opt-in switch for the experimental working-model protocol's active surfaces (session-start banner, Bash nudge, `verify_agent_work` telemetry). Default OFF.
- **`MEMESH_AUTO_DETECT_LLM` env flag** — Opt-in switch for shell-env BYOK provider detection. Default fresh-install is local ONNX (384-dim) only — an `OPENAI_API_KEY` lying around in your shell no longer accidentally locks `entities_vec` to 1536-dim.
- **README documentation** — New `## Configuration` section listing all environment variables (DB path, auto-capture, BYOK auto-detect, agentic-orchestration opt-in). New first-install notes documenting native-module prebuilds and ONNX first-time model download (~80 MB to `~/.memesh/models/`).

### Improved
- **Root build chain produces a complete artifact** — `npm run build` now also builds the dashboard sub-package via `scripts/build-dashboard.mjs`, which lazy-installs dashboard deps if missing and then runs vite build. Closes the gap where `dashboard/dist/index.html` (declared in `files`) was only produced in CI publish workflow but never by local `npm run build`. Eliminates the previous "pre-existing dashboard test failure" on feature branches by making the build chain end-to-end.
- **Three-tier verifiability classifier in agentic-orchestration skill** — Tier 1 (machine-verifiable: tsc, vitest, lint, build, migrate, benchmark) → background, parallel OK; Tier 2 (review-verifiable: API shape, schema, types, code review against checklist) → background OK + auto-trigger code-review; Tier 3 (judgment-required: UX, naming, architecture, strategy, public-facing copy) → foreground only.
- **Verification gate procedure** — Mandatory post-agent four-step gate documented in skill: reality check (git diff vs claim), hard verification (typecheck/test/lint/build), cross-check (numbers match), independent review (Tier 2). Each step is deterministic command output, not LLM judgment.
- **Telemetry field `cwd_hashed` uses real SHA-256** — In a pre-release form the field stored a 16-character path slice rather than a hash. The published form uses real SHA-256 truncated to 16 hex chars. Test `tests/hooks/session-start-telemetry.test.ts` asserts `/^[a-f0-9]{16}$/` so the contract cannot regress.
- **Benchmark runner records the version under test** — `run.mjs` reads `memesh_version` from `package.json` instead of a hard-coded string, so future re-runs record the correct version. Historical results frozen at v4.0.4 are preserved unchanged; a clarifying note in `RESULTS.md` documents that v4.1.0's retrieval path is identical (same FTS5 query, same scoring) so the 95.40% R@5 result also holds for v4.1.0.
- **CODE_OF_CONDUCT.md** — Adopted Contributor Covenant v2.1.

### Fixed
- **Same-millisecond entity-name collision in `verify_agent_work`** — Two parallel agents calling at the exact same ms previously collided on `verification:<agent>:<iso-ts>` and silently merged into one entity (since `remember()` appends observations on duplicate-name). Now appends a 6-char hex random suffix (`crypto.randomBytes`); collision probability ~16M⁻¹.
- **`-v` no longer suppresses verbose test runs** — The Bash nudge previously matched `-v\b` as a "version invocation" exclusion, swallowing legitimate verbose test commands like `pytest -v`, `go test -v`, `cargo test -v`. Removed: short-form `-v` is too ambiguous; only long-form `--version`/`--help`/`-h` are still treated as noise.
- **Throttle clobber under parallel-category load** — Two different Bash nudge categories firing in parallel (e.g. `npm test` + `npm run build` from background agents) read the shared throttle JSON, modified their bit, and wrote back — last-writer-wins lost one category's marker. Replaced with per-category marker files (`agent-nudge-flags/<category>.flag`) using O_EXCL atomic create. The flag *is* the lock; no shared state to clobber.
- **Telemetry path split when `MEMESH_DB_PATH` is set** — `session-start.js` was writing banner-injection events to `${memeshDir}/skill-usage.jsonl` while `logSkillEvent()` always used `~/.memesh/skill-usage.jsonl`. With a custom DB path the two writers diverged, so events from one path were not visible to readers of the other. Both writers now use `~/.memesh/skill-usage.jsonl` unconditionally — telemetry is per-user, not per-database.
- **Stale `4.0.4` version references** — `docs/ARCHITECTURE.md`, `docs/api/API_REFERENCE.md`, and the example response payloads now match `package.json` at 4.1.0.
- **Reviewer CI prompt-injection mitigation** — PR diff content (author-controlled) is wrapped in a `BEGIN_DIFF`/`END_DIFF` fence with explicit instructions to ignore in-diff directives.
- **Reviewer CI shell-precedence bug** — `<reviewer-cli> review ... || echo "..." > file` parsed as `(<reviewer-cli>) || (echo > file)`, leaving the output file unwritten on success. Now uses an explicit `set +e; ...; exit_code=$?; set -e` block.
- **Doc-sync 8→9 MCP tools** — README and `docs/api/API_REFERENCE.md` headers updated; section bodies were already correct.

### Changed
- Package, plugin, and dashboard metadata now target **4.1.0**.
- **agentic-orchestration is now opt-in.** Earlier prep snapshots had these surfaces enabled by default; v4.1.0 ships them as opt-in via `MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1` so the experimental working-model protocol applies only when explicitly requested. Setting the flag also serves as consent for local-only telemetry collection (`memesh patterns`). The skill itself remains discoverable; only its proactive surfaces are gated.
- **563 tests passing across 40 test files** (was 489 / 34).

## [4.0.4] — 2026-04-25

### Added
- **CLI `memesh doctor` diagnostics** — Added a release-focused local health check that verifies install method, database access, config readability, `.mcp.json`, `hooks/hooks.json`, hook script presence/executable bits, dashboard artifact availability, current capabilities, cached update status, and optional local HTTP reachability.
- **Doctor JSON contract** — `memesh doctor --json` now exposes machine-readable diagnostics and per-check status for support, automation, and onboarding verification.
- **Doctor regression coverage** — Added focused tests for healthy source-checkout installs, invalid MCP config, missing hook scripts, and first-run warning states.

### Improved
- **Actionable install troubleshooting** — README and platform troubleshooting now point users to `memesh doctor` for end-to-end local verification instead of relying only on `memesh status`.
- **CLI positioning consistency** — The `memesh` CLI banner now matches the current product wedge: local memory for Claude Code and MCP coding agents.
- **Hook script packaging hygiene** — `pre-edit-recall.js` now ships with the correct executable bit, and the build step applies executable bits consistently across all shipped hook scripts.
- **Database failure transparency** — `memesh doctor` now surfaces the actual database-open error message instead of hiding it behind a generic failure line.

### Changed
- Package, plugin, and dashboard metadata now target `4.0.4`.
- 489 tests passing across 34 test files.

## [4.0.3] — 2026-04-25

### Improved
- **Localized README and Dashboard Copy** — Refreshed all 10 non-English README variants into shorter, more natural localized guides and removed stale direct-translation wording from dashboard UI copy.
- **Truthful Version Discovery** — `memesh status` and the dashboard update card now preserve the last successful npm check, distinguish fresh/cached/stale/unavailable states, and surface the last attempted check plus last error instead of implying "already up to date" after npm failures.
- **Install-Channel-Aware Updates** — MeMesh now detects `npm-global`, `npm-local`, `source-checkout`, and `unknown` install shapes so CLI and dashboard guidance only promise self-update where it is actually supported.
- **Stale-Aware Dashboard Update UX** — Settings now loads cached update status first, refreshes in the background, offers a manual `Check now` action, and shows current/latest version, install method, last successful check, and channel-specific guidance.

### Added
- **HTTP Update Status Contract** — `GET /v1/update-status` now exposes freshness metadata, install-channel information, and manual update guidance for the packaged dashboard and other local clients.
- **Release-Path Regression Coverage** — Added targeted tests for install-channel detection, updater verification, version-check freshness/error preservation, HTTP update-status states, and dashboard i18n parity.

### Changed
- Package and plugin metadata now target `4.0.3`, including dashboard package metadata and current-version references in docs.
- 484 tests passing across 33 test files.

## [4.0.2] — 2026-04-24

### Fixed
- **sqlite-vec Vector Persistence** — Fixed vector writes by binding vec0 row IDs as `BigInt`, replacing vectors via delete+insert, and using byte-offset-safe embedding blobs. CLI `remember` now flushes queued embeddings before closing the database.
- **Vector Recall Overmatching** — Vector recall hydration now applies archive, namespace, and tag filters, and ignores non-positive similarity hits so no-match queries do not return arbitrary nearest neighbors.
- **Hook State Directory Isolation** — Pre-edit recall throttle state now lives beside `MEMESH_DB_PATH` when a custom DB path is configured, and session-start clears the same file. This fixes Windows home-directory drift in hooks and tests.
- **Clean Consumer Install Audit** — Replaced stale `@xenova/transformers` with maintained `@huggingface/transformers`, removing the vulnerable `onnxruntime-web -> onnx-proto -> protobufjs@6` dependency chain for clean npm consumers.
- **Embedding Capability Reporting** — Level 0/no-LLM mode now reports `onnx` when the local Transformers.js provider is available, matching the actual runtime embedding fallback.
- **Dashboard Browser Smoke** — Added a no-content favicon response so packaged dashboard browser smoke tests stay console-clean.
- **Packaged Dashboard E2E Smoke** — Added a Playwright-based `npm run test:e2e-dashboard` flow that packs the tarball, serves the packaged dashboard, verifies Browse/Search/Settings, checks instant locale switching without reload, and fails on page/console errors.
- **Dashboard i18n UX** — All 11 locales now have translation key parity, and language changes apply immediately without a full-page reload.
- **Imported Memory Trust Boundary** — Imported memories are now marked `trust: untrusted` with import provenance, so team/shared bundles stay searchable but are excluded from automatic Claude hook injection until reviewed.
- **Hook Context Guardrails** — Session-start and pre-edit hooks now wrap recalled memories as reference data rather than raw instructions, and they skip untrusted/imported entities during automatic injection.
- **HTTP Remote Bind Guard** — `memesh serve` now refuses non-loopback hosts unless you pass `--allow-remote` or set `MEMESH_HTTP_ALLOW_REMOTE=true`, preventing accidental unauthenticated LAN exposure.
- **Private Local Artifact Permissions** — Config, hook throttle state, and session recall-tracking files are now chmod-hardened after write (`0700` dirs, `0600` files) instead of relying on creation mode alone.

### Changed
- Added `docs/plans/README.md` to mark historical plans as archived context, not active backlog.
- 463 tests passing across 30 test files.
- Verified clean-machine packed install, clean consumer audit, packaged CLI smoke, packaged dashboard browser/i18n smoke, packaged dashboard e2e smoke, and npm registry publication status.

## [4.0.1] — 2026-04-21

### Fixed
- **Dashboard 404 Error** — Fixed NotFoundError when accessing dashboard with Node.js installed via nvm or other tools using hidden directories (`.nvm`). Added `{ dotfiles: 'allow' }` to Express `sendFile()` call.
- **Recall Effectiveness Data Pollution** — Session-start hook now saves injected context text; session-summary excludes it from hit detection, eliminating 100% false positive rate.
- **Cross-Session Data Corruption** — Switched from global `session-injected.json` to session-scoped files (`~/.memesh/sessions/${pid}-${timestamp}.json`) with auto-cleanup (>24h), preventing race conditions in concurrent sessions.
- **Vector Search Isolation Bypass** — Added optional `{includeArchived, namespace}` parameters to `getEntitiesByIds()` and vector row deletion in `archiveEntity()`, enforcing archive and namespace isolation in vector search.
- **Ollama Dimension Mismatch** — Added runtime dimension validation in `embedAndStore()` with clear error message when actual embedding length doesn't match DB schema, preventing silent write failures.
- **Cross-Project Memory Injection** — Pre-edit-recall hook now filters by project tag (`project:${projectName}`), preventing memories from unrelated repos from being injected when editing common filenames.
- **Session-Start Duplicate Entity Counting** — Entity deduplication (Set-based by ID) before recall tracking, fixing double-counting when entity appears in both project and recent lists.
- **CodeQL Security Alerts** — Added express-rate-limit (100 req/15min) for DoS protection. Removed unused variables flagged by CodeQL.

### Added
- **CLI `reindex` command** — `memesh reindex [--namespace <ns>] [--json]` regenerates vector embeddings for all active entities. Essential after changing embedding provider or dimension. Progress logging every 10 entities.

### Changed
- Enhanced dimension migration warning in `db.ts` to suggest running `memesh reindex`
- 445 tests passing across 29 test files

## [4.0.0] — 2026-04-20

MeMesh transforms from memory database to **cognitive middleware** — memory that auto-injects, auto-captures, auto-cleans, and auto-improves.

### Added
- **Recall Effectiveness Tracking** — `recall_hits`/`recall_misses` columns track whether injected memories are actually used by the AI. Session-start hook records injected entity IDs; Stop hook checks transcript for usage and updates hit/miss counts. `/v1/analytics` returns overall hit rate, top effective, and most ignored memories.
- **Continuous Recall (PreToolUse hook)** — New `pre-edit-recall.js` hook triggers on Edit/Write. Queries MeMesh for entities matching the file being edited (tag-based + FTS5 search). Throttled to max 1 recall per file per session. 5 hooks total now.
- **BYOK Embedding** — Multi-provider embedding support: OpenAI `text-embedding-3-small` (1536-dim), Ollama embedding models (768-dim), ONNX fallback (384-dim). Anthropic has no embedding API — correctly falls back to ONNX. Auto dimension migration: stores dim in metadata, drops/recreates `entities_vec` on provider change.
- **Auto-Tagging with LLM** — When `remember()` is called without tags and LLM is configured, generates 2-5 tags (project:, topic:, tech:, severity:, scope:) via LLM. Fire-and-forget: doesn't block the sync remember call.
- **Noise Filter** — `compressWeeklyNoise()` groups auto-tracked entities (session_keypoint, commit, session-insight) older than 7 days by ISO week, creates weekly summary entities, archives originals. Threshold: 20+ per week. Never touches decisions, patterns, lessons, or intentional knowledge. Throttled to once per 24h.
- **Memory Impact Score** — Laplace-smoothed `(recall_hits+1)/(recall_hits+recall_misses+2)` as 6th scoring factor (10% weight). Entities with high recall effectiveness rise in search results; ignored entities fade.
- **RecallEffectiveness dashboard component** — Stats row (effectiveness %, hits, misses, tracked) + bar charts for top/bottom entities. i18n across all 11 locales.
- Skills rewritten to CLI-first with hooks documentation and auto-detect flow (MCP → CLI → npx fallback)

### Changed
- Scoring weights rebalanced: searchRelevance 0.30 (was 0.35), frequency 0.15 (was 0.20), new impact 0.10
- `Capabilities.embeddings` correctly reports `onnx` when provider is Anthropic (was incorrectly reporting `anthropic`)
- Circular dependency between db.ts and embedder.ts resolved — `getEmbeddingDimension()` moved to config.ts
- 445 tests across 29 test files (up from 408/26)
- 5 hooks (up from 4): added PreToolUse for continuous recall
- Dashboard: 124KB (up from 107KB, new RecallEffectiveness component + i18n)

## [3.2.1] — 2026-04-19

### Added
- **Precision Engineer Design System** — Satoshi + Geist Mono fonts, cyan accent `#00D6B4`, compact 4px spacing, `DESIGN.md` as single source of truth
- **Analytics Insights Dashboard** — Memory Health Score (0-100) with 4 weighted factors, 30-day memory timeline (canvas sparkline), value metrics (recalls, lessons learned/applied), knowledge coverage with percentage bars, cleanup suggestions with one-click archive
- **Interactive Knowledge Graph** — type filter checkboxes, search with highlight and auto-center, ego graph mode, recency heatmap, orphan detection, physics cooling
- **Feedback Widget** — bug/feature/question selector with system info toggle, pre-fills GitHub issues
- New `GET /v1/analytics` backend endpoint
- i18n: ~50 new keys across all 11 locales

### Fixed
- SQLite datetime comparison fix (proper `datetime()` function instead of text comparison)

### Changed
- Zero `as any` type casts in dashboard
- 408 tests passing across 26 test files

## [3.2.0] — 2026-04-18

### Added
- **Neural Embeddings** — Xenova/all-MiniLM-L6-v2 (384-dim, ~30MB, local, no API key needed)
- **Hybrid search** — FTS5 keyword + vector similarity, merged and re-ranked
- Fire-and-forget async embedding on `remember()` — zero latency impact
- Graceful fallback to FTS5 when @xenova/transformers unavailable
- **Dashboard 2.0** — 7 tabs (up from 5): new Graph tab (canvas force-directed, no D3) and Lessons tab (structured lesson cards with severity colors)

### Fixed
- **Overwrite import** — now actually replaces old observations (was appending due to reactivation bug)
- **Namespace export** — filter applied at SQL query level (was post-filtering after LIMIT, causing truncation)

### Changed
- 402 tests across 25 test files
- 14 core modules (+ embedder.ts)
- 76KB dashboard single-file HTML
- 1 `as any` remaining (down from 20 in v3.1.0)

## [3.1.1] — 2026-04-17

### Changed
- **Module Extraction** — `operations.ts` split from 501 to 236 lines; new `consolidator.ts` and `serializer.ts`
- **N+1 query fix** — `getEntitiesByIds()` batch hydration (4 queries instead of 400+ for limit=100)
- **Type Safety** — `as any` casts: 20 to 1 (95% elimination); new typed interfaces for DB rows and LLM responses
- **Input Validation** — shared Zod schemas (`schemas.ts`) as single source of truth; max lengths enforced
- API key masked in `/v1/config` capabilities response
- `updateConfig()` deep-merges LLM config (preserves apiKey on partial updates)
- Express body limit: 1MB
- 396 tests across 24 test files

## [3.1.0] — 2026-04-17

### Added
- **Self-Improving Memory** — LLM-powered failure analysis in Stop hook automatically extracts root cause, fix, and prevention into structured `lesson_learned` entities
- **Proactive warnings** — session-start hook surfaces known lessons for the current project
- **`learn` tool** — 7th MCP tool for explicitly recording lessons across all 3 transports
- **Upsert dedup** — same error pattern across sessions updates existing lessons instead of creating duplicates
- New modules: `failure-analyzer.ts`, `lesson-engine.ts`

### Fixed
- API key in `/v1/config` capabilities response is now masked
- `updateConfig()` deep-merges LLM config to preserve API key on partial updates

### Changed
- 348 tests across 20 test files
- 7 MCP tools, 11 core modules, 3 transports, 4 hooks

## [3.0.1] — 2026-04-17

### Added
- **Built-in Skills** — `/memesh` (proactive memory management) and `/memesh-review` (cleanup recommendations)
- **Dashboard Rebuild** — Preact + Vite architecture, dark theme, 5 tabs
- Content quality improvements: filter system tags from Analytics, pagination in Browse, meaningful memory previews
- Marketing-grade README redesign with dashboard screenshots

## [3.0.0] — 2026-04-17

### Added
- **Universal AI Memory Layer** — complete rewrite
- **6 MCP Tools** — remember, recall, forget, consolidate, export, import
- **3 Transports** — CLI + HTTP REST API + MCP
- **Smart Recall** — multi-factor scoring + LLM query expansion (97% R@5)
- **Knowledge Evolution** — soft-archive, supersedes, reactivation (never deletes)
- **Session Auto-Capture** — 4 hooks capture knowledge automatically
- **Interactive Dashboard** — Preact + Vite, 5 tabs, dark theme
- 289 tests across 17 test files

## v2.x Releases

- **2.16.0** — Interactive Dashboard
- **2.15.0** — Smart Recall
- **2.14.0** — Session Auto-Capture
- **2.13.0** — Core Refactor
- **2.11.0** — Minimal core rewrite (50+ files to 5, 26 deps to 3)
- **2.10.x** — Streamlit Visual Explorer, auto-relation inference
- **2.9.x** — Proactive recall, vector search, architecture refactoring
- **2.8.x** — Device auth, semantic search, hooks system, accessibility
- **2.7.0** — Daemon socket cleanup, memory retention improvements
- **2.6.x** — PathResolver, error formatting, npm publish fixes
- **2.0.0–2.5.x** — Initial MCP server, knowledge graph, process management

---
_Note: The GitHub repository is [PCIRCLE-AI/memesh-llm-memory](https://github.com/PCIRCLE-AI/memesh-llm-memory). The npm package is [@pcircle/memesh](https://www.npmjs.com/package/@pcircle/memesh)._
