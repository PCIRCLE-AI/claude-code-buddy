# Changelog

All notable changes to MeMesh are documented here.

## [4.2.5] — 2026-05-13

### Added
- **`plugin-marketplace` install channel** (`src/core/install-channel.ts`) — `detectInstallChannel()` now recognises `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>` paths and routes them through their own `InstallChannelSupport` entry with channel-specific guidance. Previously plugin-marketplace installs were classified as `unknown`, so doctor + session-start gave generic "upgrade via your install method" hints with no actionable command. The plugin path takes priority over `.git` / npm-global checks because the plugin cache is itself a git clone.
- **`scripts/upgrade-plugin.sh`** — one-line upgrade for Claude Code plugin installs. Fast-forwards the marketplace cache, rsyncs the new version into `~/.claude/plugins/cache/`, installs runtime deps, patches `installed_plugins.json`. Idempotent (no-op when already current). Bridges Claude Code's version-pinned plugin layout to a single upgrade command — the marketplace itself does not auto-update.
- **Session-start "update available" banner** (`scripts/hooks/session-start.js`) — when the installed version is NOT deprecated but a newer release exists on npm, the session-start hook prints a single info line with the channel-tailored upgrade command (`memesh update` for npm-global, `bash <plugin-root>/scripts/upgrade-plugin.sh` for plugin installs, `git pull && npm install && npm run build` for source checkouts, `npm install @pcircle/memesh@latest` for project-local). Throttled to once per 24h per installed version so the banner doesn't nag.
- **README "Upgrading" section** — documents the three upgrade paths (Claude Code `/plugin` UI, one-line script, npm-global self-update) so users on an old version can find the path that applies to them.
- **Hook self-heal for missing `better-sqlite3` native binding** (`scripts/hooks/_shared.js`) — when `tryRequireBetterSqlite()`'s probe fails because the `.node` binding is absent (Claude Code's `/plugin install` runs `npm install --ignore-scripts` by security default, which skips both `better-sqlite3`'s install script AND memesh's `postinstall-rebuild.mjs` safety net), the hook now spawns a detached `npm rebuild better-sqlite3` in the package root. Throttled to one rebuild attempt per hour via an O_EXCL marker (`~/.memesh/last-rebuild-attempt.lock`) so a crash-loop can't drive a rebuild storm. The current hook still silent-skips, but the *next* session captures normally. Without this fix, plugin-marketplace users on Node ABI versions not covered by better-sqlite3 prebuilts (e.g. Node 24 / ABI v137) saw 100% silent dropout of the auto-capture loop — the DB stayed at 0 entities indefinitely.
- **`memesh doctor` native-binding probe** (`src/core/doctor.ts`) — new check `Native SQLite binding` that probes `better-sqlite3` by actually instantiating `new Database(':memory:')` (a bare `require()` is not sufficient — the JS wrapper succeeds even when the binding is missing). FAIL surfaces the exact `npm rebuild` command. Catches the silent-dropout failure mode that previously hid behind the existing "Hook activity (last 24h)" WARN, which used a grace period that swallowed fresh installs.

### Changed
- **Dashboard `DoctorBanner` filters non-actionable WARNs** (`dashboard/src/components/DoctorBanner.tsx`) — the banner used to fire on every `PASS_WITH_CONCERNS` doctor result, including WARN checks whose `fix` field was a generic "No action needed" placeholder. Result: alarmist title ("Heads up — memesh setup needs attention") above a self-contradicting body ("Installation method detection — No action needed"). The banner now only surfaces a check when status is FAIL, OR when status is WARN AND the doctor attached a non-placeholder `fix`. WARN-only banners get a softer title (`memesh has setup notes`) and drop the "Get help → file a GitHub issue" CTA, since the in-body fix command is the actionable path. FAIL banners keep the strong title + GitHub escalation.
- **Dashboard banner uses raw doctor summary/fix** — earlier it preferred a generic `doctor.<id>.summary` i18n override, which obliterated the actual diagnostic detail for WARN/FAIL states. A "binding missing" FAIL would render as the generic PASS-state label "Native binding detected". Now the banner shows what doctor actually said.
- **Removed the misleading `doctor.install-channel.fix: 'No action needed'` i18n overrides** across all 11 locales (`dashboard/src/lib/i18n.ts`) — these were the proximate cause of the self-contradicting banner copy. The check's real `fix` field (channel-specific upgrade instructions for FAIL/WARN) now reaches the user verbatim.

### Fixed
- **TOCTOU race in `tryRequireBetterSqlite()` self-heal block** (`scripts/hooks/_shared.js`) — the stale-marker cleanup path was `statSync → unlinkSync → openSync('wx')`, a 3-step dance where a peer hook could insert between any two steps. Worst-case outcome was duplicate `npm rebuild` spawns or one peer's fresh lock being stomped by another peer's stale-cleanup. Replaced with a single atomic `O_EXCL` claim — once the marker exists, every future hook bails. If a rebuild fails, the user clears the marker manually (the path is logged in the stderr breadcrumb alongside the manual `npm rebuild` command). Flagged by CodeQL as `js/file-system-race` (HIGH security severity).

### Changed
- **CodeQL analysis scoped to source paths** (`.github/codeql/codeql-config.yml`, `.github/workflows/codeql.yml`) — added an advanced-setup config that includes `src/`, `scripts/`, `dashboard/src/`, `tests/`, `hooks/` and excludes built artifacts (`dist/`, `dashboard/dist/`, minified bundles). Built outputs are regenerated from source on every release and would otherwise produce non-actionable findings (`js/property-access-on-non-object` on Vite runtime helpers, `js/automatic-semicolon-insertion` from minification, `js/trivial-conditional` from constant-folded bundler output). The matching source is already analyzed via the `paths` include.

## [4.2.4] — 2026-05-13

### Added
- **`memesh doctor` README locale-parity check** — compares H2 heading count across `README.md` and the 10 locale READMEs. Drift of 2+ headings (after ±1 translation tolerance) raises WARN; missing locales raise WARN; missing `README.md` skips silently. Fenced code blocks are ignored when counting so example markdown doesn't inflate the count.
- **`memesh kg backfill-relations --reset-idempotency`** — clear the persistent processed-orphan cache before running, so every orphan is reconsidered from scratch. Useful after schema changes or when you want a clean re-evaluation.

### Changed
- **LLM client now classifies malformed 2xx responses as recoverable** (`src/core/llm-client.ts`) — a body with missing or renamed fields, or a non-JSON body returned as JSON, raises a `parse` error so the cross-provider failover chain advances to the next provider instead of returning an empty string and treating it as success. An intentionally empty string from a provider is still a successful call (existing caller contract preserved).
- **`memesh kg backfill-relations` skips already-considered orphans** — the orphan-id cache lives in `memesh_metadata` under key `kg_backfill_processed_v1`. Reruns no longer pay the tokenisation and scoring cost for entities the command has previously inspected. Use `--reset-idempotency` to opt out.
- **HTTP body-limit response is now structured JSON** (`src/transports/http/server.ts`) — requests exceeding the 1MB body cap get `{ success: false, code: "PAYLOAD_TOO_LARGE", limit: "1mb", hint: ... }` instead of Express's default HTML error page. CLI export/import is unaffected (no per-request cap).
- **Lint runs at `--max-warnings 0` by default** (`package.json`, CI) — new lint warnings now block PRs. The redundant `lint:strict` script has been removed. CI runs lint before typecheck for faster fail-fast.

### Fixed
- **Plugin marketplace installs now work without npm/npx** (`.mcp.json`, `.gitignore`, `dist/`, `dashboard/dist/`) — Claude Code's plugin marketplace does not execute npm scripts on install (security model), so the previous setup left users with `-32000 "failed to reconnect to plugin:memesh"` because `dist/` was gitignored and the MCP server was re-installed via `npx` on every start. Compiled `dist/` and the dashboard build are now tracked in git so the plugin is runnable on clone. `.mcp.json` points at the plugin cache's local launcher.js, which already self-heals a missing better-sqlite3 binding via in-process rebuild (v4.2.2 work).
- **Dashboard launcher no longer invokes a shell** (`src/cli/view.ts`) — CodeQL flagged the Windows code path as `js/shell-command-injection-from-environment` / `js/indirect-command-line-injection` because `cmd.exe /c start <path>` re-parses the path through cmd's shell parser, and `MEMESH_DIR` can feed into that path. Windows now dispatches via `rundll32.exe url.dll,FileProtocolHandler` (no shell). macOS `open` and Linux `xdg-open` are unchanged.
- **F15 doctor test now inspects the actual corruption fixture** (`tests/core/doctor.test.ts`) — the "provides actionable fix commands for all failure modes" test uses the `MEMESH_DB_PATH` env override (matching every sibling F15 test) so doctor inspects the test database instead of falling through to the default path.

### Documentation
- **HTTP API request body limits** (`docs/api/API_REFERENCE.md`) — new section documents the 1MB cap, the 413 response shape, and points users at `memesh export` / `memesh import` for bulk operations that exceed the cap.

## [4.2.3] — 2026-05-12

### Fixed
- **Hook silent-skip guard misses lazy native-binding failure** (`scripts/hooks/_shared.js`) — `tryRequireBetterSqlite()` only caught `require('better-sqlite3')` failures, but the package's JS wrapper defers the `bindings()` call until the first `new Database()`. In plugin-marketplace cache installs the JS layer loads cleanly while the compiled `.node` is absent, so the helper handed back a constructor that threw "Could not locate the bindings file" on first use. The session-start hook then surfaced `MeMesh: Session start failed (Could not locate the bindings file ...)` to Claude Code on every startup. The probe now opens an in-memory database and closes it inside the same try/catch, returning `null` on either failure mode. Plugin-marketplace cache copies fall through to silent skip while dev / npm-global registrations continue to produce the summary.
- **Test coverage gap** (`tests/hooks/session-start.test.ts`) — added a second test seam (`MEMESH_TEST_FORCE_BINDING_LOAD_FAIL`) and matching test case that simulates the exact "require ok, native binding missing" failure mode. The pre-existing `MEMESH_TEST_FORCE_MISSING_NATIVE` seam short-circuited before `require()`, so the regression that v4.2.3 fixes was not exercised by the suite.

### Hardened
- **Silent-failure diagnosability** (`scripts/hooks/_shared.js`) — the probe's catch block was bare, collapsing five distinct failure causes (plugin-cache missing `.node`, ABI mismatch on Node major upgrade, disk full, fd exhaustion, tampered native module) into a single null return. The block now writes one diagnostic line to stderr (`[memesh hook] better-sqlite3 probe failed: <code> <message>`) before returning null. Stderr is **not** part of Claude Code's hook protocol channel, so this preserves the silent-on-stdout behavior the v4.2.3 fix delivers while making the underlying cause visible to `memesh doctor`, hook exit logs, and the user when they go looking. Follows the same stderr-trace-then-silent pattern used by `session-summary.js` and `post-commit.js`.
- **Test-seam production guards** (`scripts/hooks/_shared.js`) — both `MEMESH_TEST_FORCE_MISSING_NATIVE` and the new `MEMESH_TEST_FORCE_BINDING_LOAD_FAIL` seams now require `process.env.VITEST === 'true'` or `NODE_ENV === 'test'` to fire. An accidental shell export on a real user's machine no longer disables memesh's hooks. New test case verifies the seams are inert outside test environments.

## [4.2.2] — 2026-05-12

### Fixed
- **MCP server startup guard** (`src/mcp/launcher.ts`) — `db.ts` uses a static ESM import of `better-sqlite3`, which crashes the process before any try-catch can run when the native binding is absent. A new `launcher.ts` entry point uses a CJS `require` (catchable) to detect the missing binary, runs `npm rebuild better-sqlite3`, then hands off to `server.ts` whose ESM import cache is still empty and picks up the freshly compiled binary. `memesh-mcp` bin now points to `dist/mcp/launcher.js`.
- **`postinstall` script for native addon compilation** (`scripts/postinstall-rebuild.mjs`) — Claude Code's plugin marketplace installs packages with scripts that can silently skip `better-sqlite3`'s native build step, leaving the plugin non-functional. A new `postinstall` npm script detects a missing binary and rebuilds it; exits silently if the binary already exists. Non-fatal: warns to stderr and exits 0 if `npm rebuild` fails (e.g., missing build tools).
- **Entity name sanitization** (`src/transports/schemas.ts`) — `RememberSchema`, `ForgetSchema`, and `ExportResultSchema` now strip `\r\n\t` from entity names via `.transform()`. Prevents LLM-generated multi-line markdown from being stored raw as entity names, which produced garbled briefings in the session-start hook.

## [4.2.1] — 2026-05-11

KG connectivity + dashboard PM filter release. Reduces entity orphan rate from 89.2% → 11.7% on a representative knowledge base using two new non-LLM heuristics; adds milestone signal filtering to the Roadmap view; and introduces PM-framed analytics. +26 tests (984 → 1010 passing).

### Added
- **KG backfill Rule 3 — session co-occurrence** (`src/core/kg-backfill.ts`) — high-signal orphan entities sharing a `session:*` tag get a `co-created` relation. Gate: `signal_score ≥ 0.6` (reads entity `metadata`). Eligible types: lesson_learned, decision, architecture, feature, bug_fix, pattern, etc. Exposed via `memesh kg backfill-relations --session-cooccurrence`.
- **KG backfill Rule 4 — name-token similarity** (`src/core/kg-backfill.ts`) — orphans whose tokenized names share ≥ 3 content tokens OR Jaccard similarity ≥ 0.50 get a `shares-name-tokens` relation. `tokenizeName()` and `jaccardSimilarity()` exported as pure functions. Stopword list extended with generic qualifiers, process/lifecycle terms, and month abbreviations to prevent cartesian explosion (same failure mode as over-broad tag inclusion in Rule 1's co-occurrence filter). Exposed via `memesh kg backfill-relations --name-tokens [--min-jaccard N]`.
- **`memesh kg backfill-relations --all-rules`** — convenience flag enabling Rules 1–4 in a single pass.
- **PM Analytics endpoint** (`GET /v1/analytics/pm?window=N`) — pure-SQL aggregation: decision velocity (decisions/week, releases/month), staleness (stale plans ≥30d, open decisions ≥14d), connectedness (orphan rate, total relations, active entities). Zero LLM dependency.
- **Dashboard PM Analytics panel** (`dashboard/src/components/PmAnalyticsPanel.tsx`) — 4-stat grid surfacing the PM metrics in the Analytics tab. Color-coded orphan rate (green/amber/red). Fails silently if the endpoint is unavailable.
- **Dashboard milestone signal filter** (`dashboard/src/components/ProjectRoadmap.tsx`) — Roadmap milestone rail now filters out `feature`-type milestones with `signal_score < 0.65`, reducing noise from low-confidence auto-captured entries. Releases are always shown regardless of score. A "(N low-signal hidden)" badge appears when entries are filtered.
- **Integration test** (`tests/core/kg-backfill-integration.test.ts`) — seeds 46 entities across sessions, name-token clusters, and noise types; verifies orphan rate < 50% after all-rules backfill.

### Fixed
- **`doctor.test.ts` non-hermetic** — "reports PASS_WITH_CONCERNS" test was reading the real `~/.memesh/install-hooks.json`, which could have a stale `plugin_root` → `hook-wiring` returned `fail`. Test now sets `MEMESH_DIR` to an isolated temp dir like the other hermetic doctor tests.

## [4.2.0] — 2026-05-10

A combined release covering recall-path simplification, cross-provider LLM failover, end-to-end LLM telemetry, the new Insights / Analytics dashboard surfaces, KG-connectivity work, and a clean-slate quality bar (0 lint warnings, 0 executable `any` in src/). +6k LOC, +46 tests (938 → 984 passing). Highlights below grouped per Keep-a-Changelog convention.

### Added
- **Cross-provider LLM failover** (`src/core/llm-client.ts` + `config.ts`) — new optional `llmFallbacks: LLMConfig[]` config field walked in order when the primary `llm` provider fails with auth / rate-limit / upstream / network errors. A 400-class bad-request stops the chain (the prompt itself is broken). Per-attempt telemetry surfaces via `opts.onAttempt`; secret-shaped tokens (`sk-*`, `Bearer *`) are redacted before reaching telemetry. Wired into all 5 Smart-Mode flows (dreamer, pattern-detector, consolidator, auto-tagger, failure-analyzer). Also exposed via the dashboard's POST `/v1/config` endpoint with mirrored apiKey masking on GET responses.
- **Persistent LLM telemetry** (`src/core/llm-telemetry.ts` + `llm_telemetry` SQLite table) — every callLLM attempt (primary + each fallback tried) writes one row with `{flow, provider, model, project, attempt_index, status, latency_ms, error_class, error_message, fallback_used}`. New `memesh telemetry [--window N]` CLI command renders a per-flow scorecard. Prompt and response bodies are intentionally NOT persisted — the schema stays narrow to avoid a new privacy boundary.
- **Dashboard Insights tab** (`dashboard/src/components/InsightsTab.tsx`) — surfaces the dreamer's pending / applied / rejected proposals with one-click accept/reject, replacing the CLI-only `memesh dream list`. New first-tab landing for fresh users. Backed by GET/POST `/v1/dream/proposals[/:id][/accept|reject]` endpoints.
- **Dashboard Insights banner** (`dashboard/src/components/InsightsBanner.tsx`) — slim cross-tab nudge appearing when pending proposals > 0. Click navigates to Insights tab; × dismisses for the current session (re-surfaces next session). Hidden when current tab is already Insights.
- **Dashboard Analytics LLM telemetry panel** (`dashboard/src/components/LlmTelemetryPanel.tsx`) — per-flow scorecard with success rate, fallback usage warning, median latency, provider breakdown, and error-class chips. 7d / 30d / 90d window pills. Color-coded left border by success rate (green ≥90%, yellow ≥50%, red <50%). Backed by GET `/v1/telemetry?window=N`.
- **Dashboard PatternCard** (`dashboard/src/components/PatternCard.tsx`) — distinct visual treatment for `pattern_emergent` proposals (amber accent, severity surfacing) so emerging patterns read differently from weekly recap digests. Wired through a new `kind` field on `ProposalSummary` that `listProposals` now returns.
- **Stop-hook dream auto-trigger** (`scripts/hooks/session-summary.js:maybeTriggerDream`) — after every coding session, if the project has ≥10 episodic entities and the project's last dream pass was >24h ago, spawn a detached `memesh dream run --max-llm-calls 2 --window-days 14` so the Insights tab populates without the user knowing the CLI exists. Per-project state in `~/.memesh/dream-history.json`; per-run logs under `~/.memesh/dream-runs/<project>-<ts>.log`.
- **Heuristic KG relation backfill** (`src/core/kg-backfill.ts` + new `memesh kg backfill-relations` CLI) — non-LLM connector for orphan entities. Two rules: tag co-occurrence (`related-to` for entities sharing ≥2 topical tags after a strict allow-list filter) and project clustering (`belongs-to-project` linking orphan lessons / decisions / bug-fixes to the most recent release / feature in the same project). Conservative filter excludes auto-capture noise (session_end, auto_saved, commit, completed, lesson, etc.) to prevent cartesian-edge explosion on dense lesson clusters.
- **Optional digest validator** (`src/core/digest-validator.ts` + `--validate` CLI flag on `memesh dream run`) — second LLM pass that cross-checks a proposed digest's claims against source observations. Returns `pass | soften | reject`. Soften writes the proposal with a `validation_warnings` array attached; reject skips the proposal entirely. Default off because it doubles per-proposal LLM cost. Validator's own LLM calls land in telemetry under flow=`digest_validator`.
- **`summarizes` / `evidence_for` relations on accepted dream proposals** (`src/core/dreamer.ts:applyProposal`) — accepting a digest now creates one `summarizes` edge per source entity (digest → source). Patterns get `evidence_for` (source → pattern). Without these edges, accepted digests showed as graph orphans even though they conceptually summarize their sources.
- **Dashboard roadmap tree + mindmap toggle** (`ProjectRoadmap.tsx`) — vertical timeline tree visualization (default) with a mindmap toggle for radial dendrogram view. Roadmap milestones now require a PM-anchorable entity (release / feature / decision / plan / architecture / bug_fix / lesson_learned / etc.) — date-range fallback labels for activity-only weeks have been retired.
- **`created_at` timestamp on dashboard memory rows** — every row in Browse / Manage now displays its absolute timestamp in `YYYY-MM-DD HH:mm` form alongside the relative-time badge.

### Changed
- **Recall is now strictly LLM-free.** The `query-expander` module has been retired (`src/core/query-expander.ts` and its 17 tests removed). `recallEnhanced` is single-pass FTS5 + sqlite-vec. Verified at 95.40% R@5 / 97.60% R@10 / MRR 0.8899 on LongMemEval-S Mode A — identical to the previously published baseline at every per-question-type breakdown. Mean per-query latency holds at ~18ms. Recall has been documented as FTS5-only on the hot path for several releases; the query-expander module is now removed so source matches docs exactly.
- **Dashboard graph tab card overflow fixed** — type-filter row converted from `flexWrap: 'wrap'` to `flexWrap: 'nowrap'` + `overflowX: 'auto'` (a horizontal scroll strip) so the canvas is no longer pushed below the viewport on a 1440x900 screen. `CANVAS_HEIGHT` reduced 500 → 440. Canvas width measurement switched to `getBoundingClientRect` minus card horizontal padding (24px) so sub-pixel layout never produces a horizontal scrollbar on the card itself.
- **Dashboard "dream" terminology replaced with user-friendly framing** — across 11 locales, "consolidate + dream compression" became "weekly recap + pattern detection". Same engineering work, less metaphorical naming.
- **Dashboard `Insights` is now the default landing tab** for fresh users (was Lessons). Existing users' last-tab persistence still wins.
- **CLI `memesh dream` summary preserves the full error reason.** The previous `s.reason.split(':')[0]` collapsed multi-segment provider errors (e.g. `"LLM call failed: provider error: 401"`) into the leading fragment, losing the error class. Full reason is now grouped and printed.
- **Doc-sync for the query-expander retire** — README + 4 locale parities (de / vi / th / pt) + ARCHITECTURE.md + API_REFERENCE.md + dashboard i18n's `settings.llmOptional.smartFeatures` (11 locales) all updated. Smart Mode benefits now described as auto-tagging + failure analysis + consolidate + dream, not "LLM query expansion (~97% recall)".
- **Type-safety pass across `src/`** — eliminated all 60 executable `any` instances in shipping code. Express handlers now use typed `Request<P, ResB, ReqB>` generics; `catch (err: any)` replaced with `instanceof Error` narrowing; SQLite metadata payloads typed as `Record<string, unknown>`. Pattern is uniform and PR-review enforces it going forward.
- **Lint health** — resolved every standing warning. `npm run lint` reports 0 errors and 0 warnings at v4.2.0. ESLint flat config now codifies the hook silent-failure pattern (`'no-empty': ['warn', { allowEmptyCatch: true }]`) so legitimate hook code passes while genuine empty blocks still surface.
- **Native i18n translations for v4.2.0 dashboard surfaces** — 8 locales (`ja`, `ko`, `pt-BR`, `fr`, `de`, `vi`, `es`, `th`) now have native translations for Insights / banner / telemetry / pattern keys. Previously these locales carried English placeholders to satisfy the parity test.

### Fixed
- **`/v1/config` GET response masks `llmFallbacks[].apiKey`.** Mirrors the existing `llm.apiKey` masking pattern. The `llmFallbacks` field is new in v4.2.0; the masking landed before any release tagged this code path. Verified end-to-end with a placeholder key.
- **`/v1/config` POST body schema accepts `llmFallbacks`.** Previously `ConfigBody.strip()` silently dropped the field, so the dashboard had no way to configure a fallback chain.
- **PatternCard cosmetic fixes** (`InsightsTab.tsx`):
  - busyId race on rapid accept clicks — replaced scalar `busyId` with `Set<number>` so two concurrent accepts don't stomp each other's button-disabled state.
  - `digest_observations_preview === '(empty)'` no longer renders as `(empty)…`.
  - Filter chips have `aria-pressed`, expand toggle has `aria-expanded` (accessibility).
  - Status-badge color falls back to neutral gray on unknown future status values.
  - Removed dead-code response-shape unwrap (`Array.isArray(data) ? data : ...`).

### Security
- API-key paths in fallback chains are masked on every dashboard config response (see Fixed).

### Tests
- 938 → 984 vitest tests (+46) across 63 files, +6k LOC. New test files: `tests/core/llm-client.test.ts` (failover decision tree, 23 cases), `tests/core/llm-telemetry.test.ts` (persistence + summarise, 4 cases), `tests/core/kg-backfill.test.ts` (heuristic contract, 19 cases), `tests/core/digest-validator.test.ts` (pass / soften / reject + sanitiser integration, 13 cases), `tests/hooks/dream-auto-trigger.test.ts` (gate + throttle + spawn, 5 cases). 3 independent LongMemEval-S Mode A regression runs confirm 95.40% R@5 unchanged.

### Migration
- A new `llm_telemetry` SQLite table is created on first `openDatabase()` after upgrade (idempotent `CREATE TABLE IF NOT EXISTS`). No data is migrated — telemetry starts fresh.
- Existing `dream_proposals` rows are unaffected. New proposals from `applyProposal` now also write `summarizes` / `evidence_for` edges, but historical proposals' graph connectivity is unchanged. Run `memesh kg backfill-relations` to retroactively connect the high-signal long tail.
- Dashboard build artifact (`dashboard/dist/index.html`) grows from 333 kB → 370 kB (gzip 84 kB → 90 kB) — the four new tabs / panels / cards landed inline.

### Known limitations
- **Windows `dream-auto-trigger.test.ts` "all gates pass" scenario is skipped.** Hook completes but `dream-history.json` is not updated when MEMESH_DIR is propagated through `execFileSync` to a child Node process. Functionality verified on macOS + Linux. The other four gate scenarios (LLM gate, activity gate, throttle gate, prefix-collision) all pass on Windows. v4.2.0 ships with stderr-trace instrumentation behind the `MEMESH_DREAM_TRIGGER_DEBUG=1` env flag so the failing gate can be identified from the first `[memesh dream-trigger] exit reason=…` line on a Windows runner.
## [4.1.7] — 2026-05-09

Marketplace identifier renamed from `pcircle-ai` to `pcircle-memesh` to avoid name collision with sibling PCIRCLE AI plugin repos that also self-publish marketplaces named `pcircle-ai` (e.g. `toonify-mcp`, `claude-code-buddy`). Users with any of those marketplaces already registered hit `Plugin "memesh" not found in marketplace "pcircle-ai"` on `/plugin install` because Claude Code binds one repo per marketplace name on the local machine, and earlier siblings won the binding.

### Changed
- **Install command** (Option A — Claude Code plugin):
  ```
  /plugin marketplace add PCIRCLE-AI/memesh-llm-memory      # repo URL unchanged
  /plugin install memesh@pcircle-memesh                      # was: memesh@pcircle-ai
  ```
  Only the marketplace identifier changed (`pcircle-ai` → `pcircle-memesh`). The plugin name (`memesh`) and the GitHub repo (`PCIRCLE-AI/memesh-llm-memory`) stay the same.
- **`.claude-plugin/marketplace.json`** `name` field: `"pcircle-ai"` → `"pcircle-memesh"`. The marketplace is now uniquely identifiable per plugin, which lets a user have all PCIRCLE AI plugin marketplaces registered simultaneously without collision.

### Migration for v4.1.6 plugin users
If you ran `/plugin marketplace add PCIRCLE-AI/memesh-llm-memory` on v4.1.6, the registered marketplace name was `pcircle-ai`. After this release, run these once to switch to the new name:

```
/plugin marketplace remove pcircle-ai
/plugin marketplace add PCIRCLE-AI/memesh-llm-memory
/plugin install memesh@pcircle-memesh
```

The `marketplace add` step will register the marketplace under the new `pcircle-memesh` name (read from `marketplace.json`).

### Backward compatibility
- `npm install -g @pcircle/memesh` users (Option B): unaffected. CLI binaries and behaviour unchanged.
- `memesh install-hooks` users: unaffected.
- Existing `~/.memesh/knowledge-graph.db`: untouched.
- The `.mcp.json` `npx -y -p @pcircle/memesh memesh-mcp` pattern from v4.1.6 stays — only the marketplace identifier changed.

## [4.1.6] — 2026-05-09

Marketplace manifest + plugin-context MCP wiring. The Claude Code plugin install (Option A) now delivers the full memesh experience — hooks, skills, MCP tools, CLI, and dashboard — without requiring a separate `npm install -g`. Adopts the standard `npx -y` pattern used by other stdio MCP plugins so memesh works identically whether installed as a Claude Code plugin or as an npm global.

### Added
- **`.claude-plugin/marketplace.json`** companion to the plugin manifest. With this file, the repo doubles as its own one-plugin marketplace. Users can install with:
  ```
  /plugin marketplace add PCIRCLE-AI/memesh-llm-memory
  /plugin install memesh@pcircle-ai
  ```
  alongside the existing `npm install -g @pcircle/memesh && memesh install-hooks` flow. The npm path is preserved verbatim — this is an additional install route, not a replacement.
- **`.gitignore`** further narrowed: previously `.claude-plugin/marketplace.json` was ignored alongside `.claude-plugin/plugin.json`. Now only `.claude-plugin/<other-plugin>/` subdirectories are ignored (where local-dev plugin installs land).

### Fixed
- **`.mcp.json` rewritten to use the standard `npx -y` MCP plugin pattern**: `command: "npx"`, `args: ["-y", "-p", "@pcircle/memesh", "memesh-mcp"]`. The previous form (`command: "memesh-mcp"`) required the binary to already be on PATH, which is true after `npm install -g` but not for plugin-only installs. The new form works in all three install contexts identically:
  1. **Claude Code plugin install** (Option A) — `npx` fetches `@pcircle/memesh` from the npm registry on first launch and caches it; subsequent launches are instant. No `dist/` build step or `prepare` script needed in the plugin install flow.
  2. **npm global install** (Option B) — `npx` finds the already-installed `memesh-mcp` on `PATH` immediately, no network round-trip.
  3. **Dev clone with `npm install`** — `npx` finds the locally installed `@pcircle/memesh`.

  This is the standard pattern for stdio-based MCP plugins distributed via npm (e.g. `npx -y @upstash/context7-mcp`). Plugin-only users (Option A) get a fully functional MCP server with no extra steps.
- **`marketplace.json` `source` field** changed from `"."` to `"./"` to match the [Claude Code marketplace spec](https://code.claude.com/docs/en/plugin-marketplaces#relative-paths) ("Must start with `./`"). Behaviour is unchanged in practice — both forms resolve to the marketplace root — but only `"./"` is spec-compliant.

### Documentation
- **README Get Started** rewritten so Option A delivers the full memesh experience. The plugin install gives hooks, skills, MCP tools, *and* full CLI / dashboard access — the latter via `npx @pcircle/memesh <command>` from any shell, with no `npm install -g` required. Option B (`npm install -g`) is now framed as an *optional optimisation*: it puts the `memesh` binary directly on `PATH` (skipping the per-call `npx` lookup) and exposes `memesh-mcp` as a fixed-path command for non-Claude-Code MCP clients (Cursor, Cline, etc.).
- **Step 2 / Step 3** examples updated: the bash examples assume Option B; Option A users replace `memesh` with `npx @pcircle/memesh` (same flags, no install) or use the `/memesh` skill / MCP tools inside the Claude Code conversation.

### Backward compatibility
- `npm install -g @pcircle/memesh` users: the `memesh-mcp` binary is unchanged; behaviour is identical.
- `memesh install-hooks` users: hook entries are unchanged.
- Existing `~/.memesh/knowledge-graph.db`: untouched.

## [4.1.5] — 2026-05-09

Structural repackaging for Claude Code's plugin marketplace. No behavioural changes for existing users.

### Changed
- **Plugin manifest moved** to `.claude-plugin/plugin.json` from `plugin.json` (root). This is the canonical location Claude Code's plugin spec expects, and the prerequisite for shipping memesh on the plugin marketplace. The manifest itself is now minimal — `mcpServers`, `hooks`, and `skills` references were removed because Claude Code auto-discovers them from default locations (`.mcp.json`, `hooks/hooks.json`, `skills/`). Path references updated in 3 build/test scripts and 3 docs files.
- **`.gitignore`** narrowed: previously `.claude-plugin/plugin.json` was ignored (a leftover rule from when `.claude-plugin/` only meant local-dev plugin installs). The pattern now ignores `.claude-plugin/<other-plugin>/` subdirectories while keeping memesh's own manifest tracked.

### Backward compatibility
- `npm install -g @pcircle/memesh` users: unaffected. CLI binaries unchanged.
- `memesh install-hooks` users: unaffected. Hook wiring path unchanged.

### Notes
- A `.claude-plugin/marketplace.json` companion (so users can `claude plugin marketplace add PCIRCLE-AI/memesh-llm-memory`) is a deliberate follow-up, not part of this release.

## [4.1.4] — 2026-05-08

Major release consolidating dashboard v2 + v3, the auto-update loop, the new `install-hooks` command, and an LLM-driven memory consolidation system.

### Added
- **`memesh install-hooks` / `uninstall-hooks` CLI.** `npm install -g` puts the CLI on PATH but did not previously wire MeMesh's session hooks into Claude Code. Without those hooks, the auto-capture loop (sessions → lessons → recall on next session) does not run for npm-global installs. `install-hooks` adds the hook entries directly to `~/.claude/settings.json` (or `<project>/.claude/settings.json` with `--scope project`), preserving any custom hooks the user already has. Idempotent + dry-run + backup-on-write. README Step 1.5 updated across all 11 locales.
- **7th hook — `user-prompt-intent.js`** — UserPromptSubmit hook that detects explicit "remember/save/memorize" intent in the user's prompt via conservative regex. Supported languages: English ("remember this", "save to memesh"), Spanish ("recordar esto", "guardar en memesh"), French ("rappeler ceci", "sauvegarder dans memesh"), Portuguese ("lembrar isto", "salvar em memesh"), Traditional Chinese ("記下來", "存到 memesh"). On match, emits `additionalContext` JSON reminding the agent to call `mcp__memesh__remember` for cross-project recall. Polite-reminder design (not autonomous extraction): the user's intent is clear, but *what* to remember depends on conversation context the calling agent already has. Defensive: never blocks the prompt; malformed stdin and other errors surface to stderr without affecting submission. Opt-out via `MEMESH_AUTO_CAPTURE=false`.
- **`memesh feedback` CLI** for terminal-only users. Builds the same pre-filled GitHub issue URL the dashboard widget produces, with `--bug` / `--feature` / `--question`, optional `--no-diagnostics` to opt out of the doctor JSON, and `--no-open` for headless flows.
- **`memesh dream` CLI — LLM-driven memory consolidation.** Three subcommands: `dream run` proposes digests for clusters of compactable episodic entries (commits, session-insights, weekly summaries), `dream patterns` surfaces emerging patterns / repeated mistakes / knowledge gaps across recent project activity, `dream list` / `accept <id>` / `reject <id>` review and apply proposals. Proposals always go to a staging table (`dream_proposals`) — source entities are never touched until the user accepts.
- **Rule-based `signal_score` on every entity.** `metadata.signal_score` ∈ [0, 1] stamped at creation time and backfilled on first run. Default threshold 0.4 hides empty session keypoints, trivial commits, and other low-value entries while keeping lessons / decisions / architecture / patterns visible.
- **Anonymous `install_id`.** Random UUID written to `~/.memesh/install.json` on first read, never transmitted automatically. Included in feedback issues only when the user opts in via "Include system info"; visible in `memesh doctor` output for transparency.
- **`embedder.provider` config** — separates embedding backend from LLM provider. Switching `llm.provider` no longer cascades into changing the embedder backend. Previously, that cascade could invalidate stored vectors. Defaults to ONNX (384-dim) for fresh installs; existing installs without `embedder.provider` keep their previous behaviour for back-compat.
- **`/v1/doctor` HTTP endpoint** returning structured `DoctorResult` JSON, with secret-redaction defence-in-depth before the response leaves the server. Used by the dashboard FeedbackWidget to attach diagnostics to support issues.
- **`DoctorBanner` dashboard component.** When doctor reports any WARN/FAIL check, a banner appears above the tabs with a "Get help" button that opens a pre-filled GitHub issue. Dismissable; remembers the dismissed-check signature so a *new* failure re-shows the banner without nagging on issues the user already chose to ignore.
- **Two new doctor checks:** `Hooks wired into Claude Code` (verifies hook entries are present in `~/.claude/settings.json` and the recorded plugin path still exists) and `Hook activity (last 24h)` (counts memesh-attributed entities to confirm the loop is alive).
- **Analytics tab v2:** `MemoryAgeMatrix` heat-map (type × age bucket) and `KnowledgeRadar` (six-axis SVG: lessons, decisions, patterns, bugs, processes, architecture). `/v1/analytics` augmented with `ageMatrix` and `knowledgeRadar` fields.
- **Graph tab signal-first loading.** All non-noise types always present + up to 200 recent noise entries, node radius scaled by `access_count` (log2), Drift Mode toggle re-colors nodes by `last_accessed_at` recency.
- **`/v1/entities ?type=<type>` query** parameter validated by Zod (max 100 chars; `?limit` capped at 500).
- **Settings tab Test-first API key flow.** New `POST /v1/config/test` probes the provider's `/v1/models` endpoint to verify the key authenticates and return the live model catalog. Test button gates Save (fail-closed). Suggested model picks the smallest / cheapest tier (`mini` / `nano` / `haiku` / `flash` / `lite`).
- **`scripts/release-verify.sh`** pre-publish gate. Runs typecheck, build, full vitest suite (LLM env stripped for offline runs), doctor smoke, install-hooks dry-run, feedback URL build, demo seed idempotency, and an optional live LLM probe. Exit non-zero blocks release.

### Changed
- **Auto-update spawn moved from SessionStart to Stop hook.** Avoids a TOCTOU race where `npm install -g` could overwrite `dist/` while peer hooks (pre-edit-recall, pre-bash-nudge) were still reading it mid-session. Shared flock and install-channel guards carry over: only `npm-global` installs self-update, only one concurrent session wins the lock.
- **`POST /v1/config` applies LLM changes immediately.** Every LLM call site reads config fresh on each call; the embedder's ONNX pipeline cache resets when provider or apiKey changes. Settings tab confirmation message simplified to "saved".
- **`memesh config set / unset` supports nested keys.** Previously only a hardcoded subset of `llm.*` keys was accepted. Now any key in the explicit allowlist (`llm.provider`, `llm.apiKey`, `llm.model`, `embedder.provider`, `embedder.model`, `autoUpdate`, `theme`, `sessionLimit`, etc.) works with dotted paths; unset prunes empty parent objects.
- **`/v1/graph` response includes `noiseTypes`** so the dashboard's default-hide list stays in sync with the server. Single source of truth: `src/core/analytics.ts NOISE_TYPES`.
- **Dashboard Onboarding banner is one-click GUI.** Replaced the previous "run `memesh demo` in your terminal" instruction with a primary button that POSTs `/v1/demo/seed` and refetches health automatically. CLI command kept for headless / CI flows.
- **Settings tab + OnboardingBanner explicitly explain LLM is optional.** New "Without LLM (Core mode) / With LLM (Smart mode)" copy across all 11 locales sets the expectation up-front instead of making the LLM provider card feel mandatory.
- **`src/cli/view.ts` split into `view.ts` + `view-live.ts`.** `view-live` is the HTTP-served fallback when the Preact build is absent.
- **Embedding dimension change now persists a reindex-needed flag** in `memesh_metadata`. `memesh doctor` surfaces a WARN until `memesh reindex` clears it.

### Fixed
- **Stop / PreCompact transcript parsers** updated for the current Claude Code transcript shape. Earlier parsers missed nested tool-call blocks; `toolCallCount` reported 0 and the LLM failure-analysis path did not run. Updated in `scripts/hooks/session-summary.js`, `scripts/hooks/pre-compact.js`, and `src/core/extractor.ts`.
- **Transcript parser false-positive errors.** The substring match `text.includes('Error') || text.includes('FAIL')` flagged any Read tool result containing the word "Error" (README/CHANGELOG content discussing errors) as a real session error. Now uses the explicit `is_error: true` flag Claude Code itself sets on failed tool calls.
- **Session-id duplicate-guard collision.** The Stop hook used `sessionId.slice(0, 8)` as a dedup key. Two session_ids sharing an 8-character prefix could cause the second hook to abort. Now uses the full session_id for both entity names and the dedup key.
- **30-day timeline chart blank after tab switch.** `MemoryTimeline` writes `canvas.style.width` for HiDPI; the inline value persisted across `display: none → block`, leaving a 0px canvas. Switched to `ResizeObserver` and clear inline width before measuring.
- **Lessons tab data source.** `fetchLessons()` was calling `POST /v1/recall` (recency-ranked, dominated by session noise); now uses `GET /v1/entities?type=lesson_learned`.
- **Demo `--reset` cleanup.** Now routes through `KnowledgeGraph.deleteEntity` so the FTS5 contentless virtual table and `entities_vec` rows are cleaned up (a bare `DELETE FROM entities` left orphan rows that resurfaced as phantom search hits). Wrapped in a single transaction so a mid-loop failure rolls back atomically.
- **Hard `deleteEntity` removes the vec row.** Mirrors `archiveEntity`'s cleanup. Without this, hard-delete paths left orphan rows in `entities_vec`.
- **`OnboardingBanner` runSeed clears `pending` in a finally block.** Previously the success path relied on the banner unmounting via `entity_count > 0`; if the follow-up health refetch was slow or failed, both buttons stayed disabled with no recovery path.
- **`OnboardingBanner` error toast adds `role="alert"` + `aria-live="polite"`** so screen-reader users hear seed/reset failures.
- **`failure-analyzer` LLM-failure path now logs to stderr** when the LLM call throws (401, network, rate-limit), so config issues are visible instead of producing no lesson without explanation.
- **Doctor lifecycle safety alongside the HTTP server.** `runDoctor()` now detects whether the database is already open (via new `isDatabaseOpen()` guard) and only closes the connection if it opened it itself. The dashboard can call `/v1/doctor` against a running HTTP server while other requests continue normally. CLI mode is unaffected.
- **Embedder dimension back-compat now consults explicit `cfg.llm` only**, never env-detected LLM. Keeps `embedder.provider` and `llm.provider` independent (per #36) regardless of shell environment. Regression tests assert the separation.

### Added (late additions to v4.1.4)
- **Settings dashboard "Remove provider" button** — drops the saved apiKey + model so the user can opt out of LLM-backed features without hand-editing `~/.memesh/config.json`. Falls back to env-var auto-detect or Core Mode (FTS5 + ONNX, no LLM features) if no credential is found. Only shown when an apiKey exists on disk; ollama (keyless) users switch via the radio buttons.
- **Build-time smoke test** (`scripts/smoke-test.mjs`) — runs after `npm run build` and verifies dist/ modules load, database CRUD works, HTTP server starts, and the dashboard artifact is present.
- **`isDatabaseOpen()` export** in `src/db.ts` for callers that need to detect whether the global database is already open before they touch its lifecycle.
- **Doctor warnings i18n coverage** — translated 15 doctor check IDs across all 11 dashboard locales (EN + zh-TW translated, others fallback to English).

### Removed
- **Three internal surfaces (G2/G3/G4)** — entity types and a dashboard widget that were not wired to user-visible features.
- **Dead code in `version-check.ts`** — stale `UPDATE_CHECK_PATH` constant + unused `getUpdateCheckPathForTests()` export.

### Migrations (one-time, automatic)
- `metadata.signal_score` is backfilled for all existing entities on first openDatabase call after upgrade. Marker `signal_score_backfill_v1` in `memesh_metadata` prevents re-runs.
- `dream_proposals` table is created automatically. Empty on upgrade; populated by `memesh dream` runs.
- Existing entities are preserved end-to-end. No data loss.

### Notes
- **LLM is optional**. memesh's wedge — 95.40% R@5 on LongMemEval-S using FTS5 alone — does not require an LLM. The `memesh dream` system, auto-tagger, and failure analyzer are all opt-in features that activate when `llm.provider` is configured.
- **Embedder/LLM are now decoupled.** Existing users on `llm.provider=ollama` keep their current 768-dim embeddings (back-compat); fresh installs default to ONNX 384-dim. Switch the embedder explicitly with `memesh config set embedder.provider <onnx|openai|ollama>`.
- **Run `memesh install-hooks` after upgrading** to ensure Claude Code session hooks are wired. `memesh doctor` will WARN until you do.

## [4.1.3] — 2026-05-06

Update-mechanism UX completion: deprecation-aware session banners and an opt-in auto-update policy.

### Added
- **Deprecation-aware session-start banner.** The npm registry check now reads the deprecation flag for the *currently installed* version, not just the latest available one. When maintainers flag a version (typically for a security advisory), the next session-start prepends a strong `⚠️ MeMesh <ver> is DEPRECATED by maintainers — <message>` banner above the recall summary, until the user upgrades. The flag round-trips through a per-installed-version cache file at `~/.memesh/update-check.<version>.json` (machines with multiple installs each keep their own slot, so one install's refresh can't overwrite another's deprecation flag), and a transient network failure can't dim a previously-recorded warning. `memesh update-status` and `memesh doctor` surface the same line. The dashboard's Settings tab adds a red-bordered deprecation card with channel-aware remediation (`memesh update` for npm-global, `npm install @pcircle/memesh@latest` for project-local, `git pull && npm install && npm run build` for source checkouts).
- **Opt-in `autoUpdate` policy field.** New `autoUpdate` config field (`'off' | 'patch' | 'minor' | 'major'`, default `'off'`) and matching `MEMESH_AUTO_UPDATE` env var with env > config > default precedence. The session-start hook records a "PENDING" entry in `~/.memesh/auto-update.log` when the policy permits the bump and the cache is fresh. v4.1.3 ships the policy resolution, deprecation-override decision matrix, and HTTP / dashboard surfaces; the actual `npm install -g` trigger ships in a later release. Until then, run `memesh update` manually after seeing the PENDING line.
- **Background update-cache refresh.** Every session-start fires a detached `memesh status` to keep the registry cache fresh for the next run, regardless of whether auto-update was pending. The session itself reads only the cache, so a slow npm registry never blocks startup.
- **`.github/workflows/deprecate-npm.yml`** — manually-triggered maintainer helper that runs `npm deprecate` against any published version using the existing `NPM_TOKEN` secret, so deprecations can be issued from CI without depending on local credentials.

### Notes
- 630 unit/integration tests pass, covering the `autoUpdate` policy and deprecation-override matrix, env > config > default precedence, deprecation cache round-trip and per-version scoping, concurrent-refresh safety, the Windows-safe atomic cache writer, and dashboard i18n parity across all 11 locales for the new update-status strings.
- No public API breaks. Default behaviour is unchanged for users who don't set `autoUpdate` / `MEMESH_AUTO_UPDATE`. The deprecation banner appears only when npm has actually flagged the installed version, so existing installs see no change unless a maintainer issues a deprecation.

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
