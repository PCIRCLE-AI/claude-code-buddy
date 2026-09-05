# Changelog

All notable changes to MeMesh are documented here.

## [Unreleased]

### Fixed

- Removing an observation now updates stored content and search indexes in one
  transaction and invalidates its obsolete vector. Index failures roll back the
  removal instead of leaving partially updated memory. Editing an archived
  entity's observations no longer recreates its FTS entry.

## [4.8.5] — 2026-09-05

### Added

- **`npm run qa:pre-release` — one door before a release, that says what it did
  not check.** It runs `npm run build`, `verify:artifact` (lint, typecheck,
  version coherence, doc claims, the isolated suite, the packed artifact,
  every derived upgrade path, and now the entry-point start gate below — the
  same sequence `prepublishOnly` runs, now named once instead of copied) and
  `audit:memory`, reports each step's real exit code, and prints the checks it
  still cannot run here: the interactive live journey (gated separately by
  `release:finish`, below) and the post-release check.
- **A release gate that actually starts every shipped entry point.** Eight
  binaries and nine hooks ship; every existing check only asked whether a
  file existed, whether JSON parsed, or whether a referenced path resolved —
  none of them ran the code. `scripts/check-entry-points-start.mjs`
  (`npm run check:entry-points-start`, folded into `verify:release`) spawns
  each of the 17 for real against a throwaway `MEMESH_DIR`: a CLI must accept
  `--version`, an MCP server must exit 0 on stdin EOF, a long-lived daemon
  must reach its "running" signal (a log line, or its socket file appearing),
  and a host runtime with no config must fail closed with a named message,
  never a raw stack trace. It also fails on any unresolved `${...}` left in
  `.mcp.json` or `hooks/hooks.json`, evaluated against each manifest's own
  real substitution environment — `CLAUDE_PLUGIN_ROOT` is always defined for
  the plugin-loader-only `hooks/hooks.json`, but not for `.mcp.json`, which
  Claude Code also auto-discovers with no plugin loader involved at all. The
  Windows skip list is pinned to exactly one entry (`memesh-router`, no
  `AF_UNIX` there) so it cannot grow silently.
- **`npm run qa:post-release` — the check that runs on the machine, not on a
  fresh clone.** Every gate here runs on a fresh checkout or a fresh install,
  and all three release incidents lived in state that already existed: v4.7.0
  had a tag and a GitHub Release with nothing on npm; v4.8.2's plugin cache was
  keyed by version and served 4.8.1 code; a 4.8.2 CLI sat on PATH beside a
  4.8.3 plugin. This asks the registry whether the version is published and is
  `latest`, installs it from the registry into a throwaway prefix and runs it,
  and then asks whether this machine is on that version — read-only with
  respect to `~/.memesh`, `~/.claude` and `~/.codex`, printing remediation
  commands rather than running them. It reports EVERY `memesh` a shell would
  resolve, not the first one: two installs on one PATH, four releases apart,
  is the shape of the incident, and a check that stops at the first hit cannot
  see it.
- **Repeatable owner-run live delivery checks.** `npm run qa:live-journey -- --host codex|claude`
  (`scripts/qa/live-journey.mjs`) starts this checkout's router in a throwaway
  `MEMESH_DIR`, registers one real host session, sends one exact-session
  envelope, and passes only on model-visible proof: the Codex path requires the
  model to quote the envelope's `message_id` and `delivery_id` back on its next
  turn; the Claude path requires an `intake` receipt written by the interactive
  session the operator launched with the printed command. Both then stop the
  session and require `recipient_unavailable` while the durable row stays
  fetchable and the router still answers `discover`. It refuses to run against
  `$HOME/.memesh`, reads no auth files, never runs in CI, and records its
  limitations in the JSON report — including that the Codex registration is
  harness-driven because `codex exec --ignore-user-config` bypasses the plugin
  `SessionStart` hook, and that print-mode Claude is unsupported (#275).
  Closes the "repeatable check in the repository" box on #270 and #272.
- **A write-side reminder hook.** The read side of MeMesh was already automatic
  (SessionStart and PreToolUse inject memories) but nothing prompted an agent
  to *store* anything, so decisions made mid-session were routinely lost until
  the user said "remember this" (#277). A ninth hook,
  `scripts/hooks/decision-nudge.js`, runs on `PostToolUse` for `ExitPlanMode`
  and `AskUserQuestion` — the two calls where a decision has most likely just
  been made — and adds one line of context asking the model to `remember` it
  if it is worth keeping. At most once per tool per session, enforced by an
  `O_EXCL` flag file under `MEMESH_DIR/decision-nudge-flags/`; the hook never
  opens the database, exits 0 on any malformed input, and writes nothing to
  the graph itself. Hook inventories in the READMEs (three languages),
  `docs/ARCHITECTURE.md`, `AGENTS.md`, `CODEMAP.md` and the skill now list nine
  hooks, and `check-codemap-parity` no longer hard-codes the count.

### Changed

- **`npm run release:finish` now runs the real-credential checks instead of
  merely documenting that they exist.** `qa:pre-release` and `qa:live-journey`
  were both available since the previous release but neither was in the one
  command that actually cuts a release — a check nobody has to run is a check
  that gets skipped exactly when a release is rushed. `finish-release.mjs` now
  runs `npm run qa:pre-release` itself (build + `verify:artifact` +
  `audit:memory`, several minutes, streamed live) and blocks on its exit code;
  a receipt cannot substitute here because it can go stale the moment the next
  commit lands. `qa:live-journey` cannot run unattended — it needs a Codex
  login or a person at an interactive Claude Code session — so it stays
  receipt-based: `npm run qa:live-journey -- --host codex|claude --out
  .qa/<host>-report.json` writes a report, and `release:finish` requires ONE
  of the two hosts' reports to be readable, `verdict: "PASS"`, recorded
  against a clean tree, and naming this exact commit — an older PASS proves an
  earlier revision, not this one. Neither host is preferred; only Codex can be
  driven unattended today, but a human-run Claude receipt satisfies the gate
  exactly as well. `.qa/` is gitignored — a receipt is owner-machine evidence,
  never shipped.

- **The packed-upgrade gate derives its upgrade paths instead of pinning
  them.** `scripts/smoke-packed-upgrade.mjs` named both ends by hand
  (`expectedPreviousVersion = '4.8.2'`, `expectedCandidateVersion = '4.8.3'`,
  the candidate spelled out again in the auto-update shim and three regex
  assertions). Seventy versions are published; the moment 4.8.4 shipped, that
  pin would have gone on passing while proving an upgrade nobody performs. The
  candidate now comes from `package.json` and the from-versions from the
  registry (`scripts/lib/upgrade-matrix.mjs`): the newest release below the
  candidate, the current `latest` dist-tag when that is lower still, and the
  oldest release that installs without a native build — 4.5.1, the first
  release after `better-sqlite3` was dropped, whose database predates the
  `title` column, the delivery `target_kind` column, FTS segmentation v3 and
  the tags unique index. Both rows pass today.

### Fixed

- **The Claude Code plugin cache never cleaned up an old version after an
  upgrade — only the ONE it had just replaced.** `upgrade-plugin.sh`'s atomic
  swap always removed the previous cache directory, but anything left behind
  by an interrupted upgrade, or one from before this swap mechanism existed,
  had no path back to zero: measured on the maintainer's machine, 9 stale
  version directories, 1.2 GB, with nothing ever sweeping them. A new
  `sweep_stale_cache_versions` removes every OTHER directory under the cache
  root whose name is exactly `<major>.<minor>.<patch>` after a successful
  upgrade — never the version just installed, and never the registry's own
  recorded install path even when that path is a stray non-canonical
  directory the "repairing it" branch above deliberately leaves for a human,
  whatever it happens to be named.

- **Three release-gate guards that could not fail, and the silent failure one
  of them was hiding.** A mutation audit reintroduced the defect each guard was
  written for and re-ran the suite: with all three defects present at once,
  3286 tests were green.
  - `check-generated-mirror`'s "a failed build must fail the gate" assertion
    matched `/catch[\s\S]{0,200}process\.exit\(1\)/` against the whole
    script, which has FOUR such pairs — deleting the exit from the *build*
    catch satisfied it via one of the other three. That is not cosmetic:
    `npm run build` is an `&&` chain, so a `tsc` failure short-circuits it and
    `scripts/hooks/_generated/` is never regenerated — the exact hook/core
    divergence this gate exists to catch — after which the gate diffs, finds
    nothing, and prints a green tick. The assertion is now scoped to the build
    catch's own block.
  - `check-doc-claims`'s test-count rule was pinned by asserting the gate
    *imports* the shared predicate. The gate could keep the import and filter
    with a private English-only regex at the call site, which is the drift the
    test was written for; replacing the call with `/\b\d[\d,]*\s+tests?\b/i`
    (blind to `630 項測試`) left the suite green. Now pinned at the call site,
    plus a behavioural probe that runs the shipped gate against a Chinese
    test-count claim and requires it to exit 1 naming the file.
  - The session-start banner's per-host upgrade advice was pinned by asserting
    three strings were present in one function. The defect is a wrong *mapping*,
    not a missing string: making the codex branch unreachable handed every
    Codex user the Claude Code command with all three strings still in place.
    Now pinned as a pairing — the codex predicate and the codex command in one
    branch.
- **`pluginHostOf` collapsed "could not ask" into "not Codex".** It was
  `detectPluginHost?.(root) ?? null` inside a bare `catch { return null }`, and
  `null` is a legitimate answer meaning "this path is not under any plugin
  cache" — so a module that failed to load, or a detector that threw, produced
  the identical banner a confident "not Codex" would, with no mutation needed.
  It now returns `'unknown'` for that state, matching what
  `getCurrentInstallChannel` already did, and the banner names both upgrade
  paths rather than guessing one.
- **`memesh pin`/`unpin --json` no longer reports a pin that never happened.**
  `setPinned` echoed the *requested* `pinned` argument back in its result even
  when the named entity did not exist, so `memesh pin --name nonexistent
  --json` printed `{"pinned":true,"found":false}` — a caller scripting
  against `--json` (the reason the flag exists) could read `pinned: true` and
  believe the protection was in place while `found: false` said the entity
  was never touched. `unpin` on a missing entity looked correct only because
  its requested value (`false`) happened to coincide with "not pinned"; the
  same defect was present either way. `setPinned` now returns `pinned: null`
  when `found` is `false` — there is no pin state to report for an entity
  that was never touched, and `null` cannot be misread as a boolean claim the
  way `false` was.

- **Every host runtime now fails closed with the reason, not a stack trace or a
  generic apology.** `memesh-host-codex` and `memesh-host-acp` awaited their
  entry function at module scope with no `catch`, so a user whose only mistake
  was omitting `--config` got a raw Node stack trace. `memesh-host-claude`
  caught it and then discarded the error, printing `session startup failed.` —
  fail-closed, but it hid the one sentence that says what to do. All three now
  print `<binary>: <the actual error>` on one line and exit non-zero.
  The guard is one shared `runHostEntry` rather than three copies: the
  module-scope form could only be tested by spawning the built binary, so a
  mutation to `src/` proved nothing until `dist/` was rebuilt. As a function
  it is callable with an injected failure, so the contract is pinned where
  the code lives; `tests/host-runtime/fail-closed.test.ts` keeps the spawn
  tests too, which prove each shipped binary really routes through it.
  Found by the new entry-point gate, not by review.
- **`memesh doctor` now catches a stale npm-global install sitting next to a
  newer plugin copy.** A machine can have two live installs at once — a
  terminal's `npm install -g @pcircle/memesh` and Claude Code's plugin
  marketplace cache — and nothing kept them in sync: the plugin's own
  auto-updater only ever refreshes the plugin copy (`~/.memesh/auto-update.log`
  correctly logs `SKIPPED: install channel 'plugin-marketplace' does not
  support self-update` for it, and says nothing about the separate global
  install). Doctor's shell-CLI check now reads the *other* copy's own
  `package.json` (never a spawned `--version`) when `memesh` on PATH resolves
  somewhere other than the running install, and warns naming both versions
  and which one is behind. The npm-global plugin-cache-discovery check
  similarly now compares the discovered plugin cache's version against the
  running npm-global process, not only the commit it was staged from, and
  when there are more than two versioned copies cached it also reports the
  count and a cleanup command. The "Update status" row's cached-PASS branch
  no longer prints an unqualified "Version X is current." — it names how old
  the cache backing that claim actually is, since doctor never makes a live
  registry call itself.

- **`memesh doctor`'s Vector Index fix now names its own prerequisite.** On a
  fresh Core-mode install — the default, with no embedder configured — the
  WARN's one-line fix said `Run 'memesh reindex' to fix`, but `memesh reindex`
  refuses with exit 1 (`no embedding provider is configured`) in exactly that
  state, for nearly every new user. The fix line now checks the same
  `capabilities.embeddings === 'tfidf'` predicate `inspectEmbeddingProbe`
  already uses, and says to configure an embedder first when that is true.
  The two states now carry distinct doctor codes
  (`vector-index.stale-no-embedder` vs `vector-index.stale`) rather than
  sharing one: the dashboard looks up its fix text by code alone, and one
  code covering two different messages meant the no-embedder case — the
  common one — was rendering the OTHER state's fix text there, telling
  dashboard users to run a command that is guaranteed to fail. All 11
  locales carry the new code's translation.

- **`memesh forget --json` now agrees with `memesh forget` and with `memesh
  pin`/`unpin` on the exit code.** `--json` printed the same `{ archived:
  false, ... }` / `{ observation_removed: false, ... }` envelope regardless of
  outcome and always exited 0 — the one output shape a script actually parses
  was the one that reported success for an operation that changed nothing. The
  exit code is now decided once, from whether anything was actually archived
  or removed, and applied to both `--json` and plain output alike, matching
  the rule `pin`/`unpin` already followed.

- **`memesh briefing --recipient <id>` no longer reads a typo as a quiet,
  healthy inbox.** At zero unread, the block was identical whether the
  recipient was real with nothing waiting, or had never been addressed in
  that project at all — a typo went unreported. A new `recipientEverSeen`
  check (`agent_principals` for a live connection, `agent_message_deliveries`
  for any delivery ever, `agent_session_instances` for a session that
  connected but has not been sent anything yet) distinguishes the two; the
  block now says so explicitly when the exact recipient id has never been
  seen in that project, and stays silent (as before) when the database
  predates the message tables and the question cannot be answered at all.
  The third table closes a gap in the first draft of this check: a
  `target_kind: 'session'` recipient keys on the session instance's own id,
  not a principal id, and a session that only just connected exists in
  `agent_session_instances` alone — omitting it misreported an actually-live
  session as never seen.

- **An archived memory no longer takes a recall slot from a live one.**
  `vectorSearch` ran an unrestricted k-NN and `supplementWithVectors` dropped
  archived hits during hydration — after the LIMIT had been spent on them, so
  an archived neighbour did not just get discarded, it displaced an active
  memory. Measured on the maintainer's graph (2136 entities, 820 active): 413
  of 1013 vector rows belonged to archived entities, and 41 synthetic 1536-dim
  queries against a copy of it spent 290 of 820 top-20 slots — 35.4% — on them,
  and 0 after the filter. The k-NN is now restricted to
  active entity ids inside the query, with `rowid IN (…)`, which sqlite-vec
  honours as a PRE-filter; a join is applied after k is spent and reproduces
  the bug, and adding a `status` metadata column would mean recreating
  `entities_vec` and re-embedding every namespace at cost.

- **Three archive paths left the entity in both search indexes.**
  `archiveEntity` always removed the FTS row and the vector; `compressWeeklyNoise`,
  the dreamer's compaction-digest apply and `splitFusedLessons` archived with a
  bare status UPDATE and removed neither. Measured on the same graph, 213
  archived entities were still full-text indexed — `MATCH 'ae83279'` returned
  the archived `commit-ae83279`. Removal from both indexes now has one owner
  (`storage/entity-index.ts`), which `archiveEntity`, `deleteEntity`,
  `compressWeeklyNoise` and the dreamer all call.

- **Re-remembering an archived memory inserted a second, undeletable document
  into the full-text index.** `createEntityInner` skipped the contentless FTS5
  delete for anything `wasArchived`, on the reasoning that archiving had
  already removed the row — which only `archiveEntity` did. For an entity
  archived by one of the three leaky paths the row was still there, so the
  rebuild added a SECOND document at the same rowid, and where the two
  documents differ (a title change between archive and re-remember) the first
  one's terms can never be deleted: a contentless delete has to repeat the text
  that was indexed, and only the second document's text is reconstructable. The
  previously-indexed text is now read unconditionally for an existing entity.

- **A contentless FTS5 delete is no longer issued when there is no row to
  delete.** FTS5's `'delete'` writes negative postings without looking for a
  row, so a second delete of the same (rowid, text) drives the term counts
  below zero and SQLite reports `database disk image is malformed` — which
  `isBenignFtsDeleteError` deliberately does not treat as benign. Measured on
  SQLite 3.51.3. `removeFromFts` now checks the rowid is indexed first, which
  covers every caller including `clearEntityData`, whose comment claimed the
  benign-error class absorbed the miss.

- **One-shot repair for graphs already holding those rows.**
  `dropArchivedIndexRows` (`storage/graph-repairs.ts`) rebuilds the keyword
  index from active entities and deletes every vector row belonging to an
  archived entity, at the first open after upgrade. It runs after the
  sqlite-vec load rather than beside the other repairs, because `entities_vec`
  does not exist as a queryable table before it, and it carries TWO markers:
  the FTS half is always runnable, the vector half is skipped without stamping
  anything on a platform sqlite-vec ships no binary for, so that machine still
  repairs the row when the file is next opened where the binary is present.
  Verified on a copy of the maintainer's graph: vectors 1013 → 600 (all 413
  archived removed, all 600 active kept), FTS rows 1033 → 820 (all 213 archived
  removed, all 820 active kept), entity and observation counts unchanged.

- **Two new memory invariants.** `scripts/audit/memory-invariants.mjs` now fails
  when an archived entity holds a vector row or a full-text row, naming the
  entities. The vector check reads sqlite-vec's rowid map rather than the vec0
  virtual table, because the audit opens read-only without loading the
  extension and a `no such module: vec0` would have been printed as a benign
  `skip` — a silent pass being the one outcome an invariant must not have.

- **Two capture hooks re-appended their whole payload on every run, and the
  detector for it was keyed to the other hook's name.** `#240` was fixed in
  `scripts/hooks/session-summary.js` alone. `scripts/hooks/pre-compact.js` and
  `scripts/hooks/post-commit.js` write the same way and had no guard: measured
  on a real graph, 2,188 duplicate observation rows across 58
  `pre-compact-<sessionId>` entities (worst: 220 observations, 2 distinct, one
  session's captures spanning four days) and 14 across `commit-<sha>` entities.
  `captureEntity` (`scripts/hooks/_shared.js`) now refuses, inside its
  transaction, to store an observation whose exact content is already on the
  entity — a guard on CONTENT rather than on "this session already has an
  entity", so a second real compaction that recorded different work is still
  kept while a word-for-word repeat is not. It returns `observationsWritten`,
  and PreCompact reports that instead of announcing "Saved 2 observations" on a
  run that stored none. The `#240` invariant in
  `scripts/audit/memory-invariants.mjs` and the one-shot repair in
  `src/storage/graph-repairs.ts` were both keyed to `session-%` names and so
  were blind to every row of this; both now ask the question instead — any
  entity whose observations repeat — excluding `lesson_learned`, `lesson`, and
  `mistake`, whose observations a position-sensitive reader (`groupLessons` in
  this repair, and the dashboard's `parseStructuredBlocks`) reads as ordered
  blocks where a repeated line is a second lesson's field rather than a
  duplicate fact. The repair's `runOnceMigration` version moves 1 → 2 so it
  runs again on graphs that already recorded the narrower pass; on the
  maintainer's graph it removes 2,216 rows across 134 entities and leaves the
  set of distinct (entity, content) pairs unchanged. `createEntity`'s own
  append path gets the same content guard, so this dedup is now a property of
  writing an observation at all, not just of these three hooks.

- **`memesh doctor` now says when an AI-backed feature has quietly stopped
  working.** `llm_telemetry` recorded every Smart-Mode call but nothing read
  it for a health signal — measured on a real graph, `guard_proposer` had
  failed all 69 of its calls, every one, across the four days it ran between
  2026-08-28 and 2026-09-01, invisible to doctor. A new zero-cost check
  (`inspectLlmTelemetryHealth`, no `--probe`
  gate) reads the last 7 days and warns when a flow's recent calls (≥3) all
  failed; a shorter window than `memesh telemetry`'s 30-day default is
  deliberate — a longer one blends in stale successes and hides a flow that
  has been 100% broken all week. Silent (not a false PASS) when the table is
  empty or a flow has never run; informational when calls exist and none are
  100%-failing. New `doctor.msg.llm-telemetry.silent-failure` catalogue entry
  in all 11 dashboard locales.

- **A split lesson no longer starts its life carrying its parent bucket's
  stale recall history.** `splitFusedLessons` moves a fused `-other` bucket's
  observations into their own entities but left `recall_hits`/`recall_misses`
  on the now-empty, archived bucket forever — measured, 4 of 49 already-split
  shells on a real graph still carried nonzero history (one at 3 hits / 61
  misses), which `scripts/audit/measure-signals.mjs`'s unfiltered
  `SUM(recall_hits) FROM entities` counts to this day. The bucket's rate is
  itself an artifact of the fusion being repaired — a bucket fusing many
  unrelated lessons gets injected broadly and cited rarely, which is not a
  measurement of what any one lesson in it is worth — so it is not divided or
  copied onto the successors (they correctly start at 0/0); the shell's own
  counters are zeroed and the number is kept for forensic reading under
  `metadata.retired_recall`. A new one-shot repair
  (`repairFusedLessonShellHistory`) retires the history on shells already in
  this state, and `scripts/audit/memory-invariants.mjs` gained
  `split-lesson-shell-carries-no-recall-history` to keep it caught.

- **The Claude plugin no longer ships an MCP config on the path Claude Code
  auto-discovers as a project config.** `.mcp.json` at the repository root was
  loaded twice: by the plugin runtime, where `${CLAUDE_PLUGIN_ROOT}` resolves
  to the plugin directory, and as a project-scoped MCP config for anyone who
  merely opened the repository, where it is undefined. In the second role the
  server started as `node /dist/mcp/server.js`, exited 1 with
  `Cannot find module`, and a live session reported
  `memesh (CONNECTION_CLOSED)` — for three and a half months, since the
  placeholder replaced a working `npx -y -p @pcircle/memesh memesh-mcp` form.
  The manifest now lives at `.claude-plugin/mcp.json`, declared by
  `.claude-plugin/plugin.json` as `"mcpServers": "./.claude-plugin/mcp.json"`,
  and the root file is deleted — custom component paths supplement the
  defaults rather than replacing them, so declaring a path while leaving the
  root file in place would have loaded both. `${CLAUDE_PLUGIN_ROOT}` is kept,
  because it is the documented and correct placeholder inside a plugin
  manifest; what was wrong was the path, not the variable. Verified with
  `claude mcp list` against a throwaway `CLAUDE_CONFIG_DIR`: before the change
  it reported `[Warning] [memesh] mcpServers.memesh: Missing environment
  variables: CLAUDE_PLUGIN_ROOT` from the project config, and after it the
  plugin install registers `plugin:memesh:memesh` with the placeholder already
  substituted.

- **`memesh doctor`'s MCP-config check can now fail on the channels where it
  could not.** It substituted `${CLAUDE_PLUGIN_ROOT}` with the package root
  unconditionally, so on `source-checkout`, `npm-global` and `npm-local` the
  substitution was self-fulfilling — it rebuilt a path that exists by
  construction, and the check could not report a fault whatever the manifest
  said. That green row is why the defect above survived three releases. Doctor
  now substitutes only where something really does substitute
  (`plugin-marketplace`, or an explicit `CLAUDE_PLUGIN_ROOT` in the
  environment) and otherwise reports `mcp-config.placeholder-unresolved` —
  a warn that states plainly that the target was NOT verified and gives the
  command that would verify it, instead of the old "the script it starts
  exists". It also reads the manifest path from `.claude-plugin/plugin.json`
  rather than hardcoding one, so a future move cannot leave the check pointing
  at a file nobody loads.

- **One agent's inbox was split across spellings of its own name.**
  `agent_message_deliveries` keys an inbox on (`project`, `recipient`) and both
  columns were free text with no canonical form, so a recipient that fetched
  under one spelling never saw what was sent under the other, and `briefing`
  counted unread per spelling. Measured on a real graph: `recipient` held
  `root` 25 times beside `/root` 20, and one delivery was scoped to the project
  `/Users/…/memesh-llm-memory` — a value `getProjectName` cannot produce at any
  of its three layers, so nothing would ever match it again. Both spellings had
  their own receipts, so both inboxes were live.
  Scope identifiers (`project`, `recipient`, and the `actor` they derive) are
  now canonicalised to Unicode NFC on every message action, read as well as
  write, and a value spelled as an absolute filesystem path — POSIX, Windows
  drive, or UNC — is refused at the transport boundary
  (`src/transports/schemas.ts`) and again in core before any SQL runs, with an
  error naming the field and a valid value. `sender` is deliberately unchanged:
  it is provenance, it keys no inbox, and it keys replay protection.
  The rule covers every surface that touches that key, not only the `message`
  tool: `briefing` counts unfetched deliveries for one exact
  (`project`, `recipient`) and now asks in the canonical spelling, and
  `memesh agent setup --project/--principal` refuses a path-shaped identity at
  the moment the host config is written rather than letting it surface later as
  an error about some other agent's send.
  A one-shot repair (`normalizeAgentScopePaths` in
  `src/storage/graph-repairs.ts`) rewrites the rows already written, and a new
  invariant, `agent-message-scope-ids-are-not-filesystem-paths`, watches the
  same columns in `scripts/audit/memory-invariants.mjs`. On the maintainer's
  graph the repair moved 96 values and dropped 2 poll cursors that the
  canonical identity already covered; every message, delivery, sender, payload
  and timestamp was preserved, and the only identities that changed were
  `/root` → `root` and `/Users/…/memesh-llm-memory` → `memesh-llm-memory`. Two poll
  cursors whose canonical identity already held that exact position were
  dropped rather than forced past the UNIQUE index; an agent still holding one
  of those opaque tokens gets an explicit scope error on its next
  `poll --cursor` rather than a silent restart. The repair covers the durable
  message tables only — the router and presence tables take their `project`
  from an owner-written host config, which is why that entry point is gated
  instead — and `memesh kg rename-project` likewise moves the message scopes,
  not `agent_principals`, so a renamed project needs its host config reissued.

  Two look-alike pairs are deliberately left apart, because merging identities
  that are genuinely different is worse than the split it would close.
  `claude-code:session_01PDMer…` is NOT fused with `session_01PDMer…`: that
  prefix appears nowhere in this repository's source, artifacts or history, so
  there is no convention to normalise against, the two were used with different
  `target_kind`, and neither carries a receipt. And the largest split — the
  projects `memesh` (38 messages) and `memesh-llm-memory` (28) — is not merged
  automatically even though they *are* one repository renamed on GitHub,
  because the evidence that proves it is a network call against one owner's
  account and the repair runs unattended on every machine.

- **`memesh kg rename-project` now moves durable message scopes, not just
  tags.** A project identity is half the key of an inbox as well as an entity
  tag, so renaming only the tags left every message behind in a scope nobody
  polls — which is how the `memesh` / `memesh-llm-memory` split above survived.
  The command now counts and moves the `project` column of the durable-message
  tables in the same transaction, still dry-run by default and still backing
  the database up before `--apply`, and it no longer stops at "no entities
  carry project:<x>" when only messages carry it. That is the owner-driven
  answer to a rename, and the reason the unattended repair does not guess one.

- **The Ollama host guard now rebuilds the request origin instead of forwarding
  the configured string.** `resolveOllamaHost` used to validate a persisted
  `llm.host` and then pass the same string to `fetch`, which left CodeQL alert
  #137 (`js/file-access-to-http`) open even though remote hosts were already
  rejected. The scheme and hostname are now chosen by literal `switch` cases
  and the port is re-parsed as a number, so no byte of the untrusted value
  reaches the request. A configured loopback host carrying a path, query,
  fragment, or credentials is refused with the existing `must be loopback`
  error rather than silently reduced to its origin; the operator-set
  `OLLAMA_HOST` is unchanged. The dashboard global-filter test builds its
  cross-tab event as `new Event('storage')` to clear CodeQL #138.

- **The packaged Dashboard E2E smoke now pins its environment isolation.**
  `scripts/dashboard-e2e-smoke.mjs` builds the child runtime's environment in
  an exported pure function (`buildIsolatedRuntimeEnv`) and only runs the smoke
  when invoked directly. `tests/release-scripts-safety.test.ts` calls that
  function with a deliberately polluted maintainer environment and asserts,
  key by key, that the test-owned HOME/MEMESH_DIR/database win, that
  `MEMESH_AUTO_DETECT_LLM` is off, and that every provider variable
  `detectFromEnv()` reads is gone — the list is derived from `config.ts`
  itself, so a provider added there without updating the smoke fails the test.
  Recorded under a shell that really had `OPENAI_API_KEY` set: the packaged
  server still started at Level 0 and the smoke exited 0 (#271).

- **`scripts/smoke-packed-artifact.mjs` no longer inherits the maintainer's
  ambient `MEMESH_DIR`/`MEMESH_DB_PATH`.** Its native-router `nativeEnv`
  overrode `MEMESH_DIR` but left `MEMESH_DB_PATH` to leak through from a raw
  `...process.env` spread; `src/host-runtime/router.ts`'s data directory
  follows `MEMESH_DB_PATH` (`getMemeshDirFromDbPath()`), not `MEMESH_DIR`, so
  an ambient `MEMESH_DB_PATH` sent the router's `mkdirSync` to the wrong
  directory while `MEMESH_ROUTER_TOKEN_FILE` still pointed at the directory
  nothing had created — reproduced as `ENOENT` opening `router.token`. The
  script's three child environments (the installed-module import/openDatabase
  check, the MCP protocol driver, and the native router flow) now all build
  through `buildIsolatedRuntimeEnv`, moved to `scripts/lib/isolated-env.mjs`
  so `scripts/dashboard-e2e-smoke.mjs` shares the same isolation instead of a
  second hand-rolled copy. `tests/release-scripts-safety.test.ts` now also
  pins that both scripts import the helper and that the native env is never
  built from a bare `...process.env` spread again. Same defect class as
  #271, on the sibling smoke.

- **The two audit scripts that promised an isolated run pinned only `HOME`.**
  `scripts/audit/mutation-sample.mjs` and
  `scripts/audit/measure-injection-tokens.mjs` each spawned their child with
  `{ ...process.env, HOME: <scratch> }`. `src/core/paths.ts` resolves
  `MEMESH_DIR` and `MEMESH_DB_PATH` *before* falling back to `HOME`, so an
  ambient `MEMESH_DB_PATH` — a normal state while debugging against a copy —
  sent a mutation run, or an injection measurement, straight at the real
  knowledge graph, while each script's own comments promised isolation. Both
  now build their child environment through the same
  `scripts/lib/isolated-env.mjs` the packaged smokes use, which grew a second
  variant (`buildIsolatedSuiteEnv`) that *deletes* the path variables rather
  than pinning them — the suite must not be handed a `MEMESH_DB_PATH`, or the
  hook tests covering the "no database yet" branches become unreachable.
  `scripts/run-tests-isolated.mjs` now goes through it too, so the guarantee
  has one owner instead of three copies, two of which had drifted.

- **`~/.memesh/update-check.<version>.json` no longer accumulates forever.**
  Nothing reads a file keyed by any version other than the one currently
  installed, so every prior release's cache file just sat there — 19 files
  going back to 4.2.3 on one machine. `writeStoredUpdateCheck` now prunes
  down to the 5 most-recently-modified per-version files after every write
  (current version's file always included, since its mtime is newest); the
  per-version keying itself is unchanged, so a global install and a pinned
  project-local install still get separate cache slots. `_shared.js`'s
  independent `readUpdateCheckCache()` path formula is untouched by this —
  it only reads, and the filename scheme did not change.

- **The Claude channel's own instructions told the model it did not need to
  acknowledge a message it received.** `npm run qa:live-journey -- --host
  claude` requires the session's own model to call `intake` on an incoming
  envelope as model-visible proof it was seen; two runs failed identically,
  because `CHANNEL_INSTRUCTIONS` literally said "no ... acknowledgement of
  model receipt" is needed, and the model followed that correctly. The
  instructions now say to call `message` with `action: "intake"` on a full
  envelope. This does not fix `--host claude` itself — two further runs
  (one with `--setting-sources ""` removed as a diagnostic) still failed the
  same way, which appears to be how the currently installed Claude Code
  CLI's "Channels (experimental)" feature surfaces notifications to the
  model rather than anything in this repository. `--host claude` remains a
  known-non-functional `qa:live-journey` path; `--host codex` is what
  produced this release's live-journey receipt.

## [4.8.3] — 2026-08-31

### Fixed

- **Agents can now find the right live collaborator before sending.** A bounded,
  project-scoped `message discover` read lists active session and principal IDs,
  host kind, generation, lease expiry, and explicitly declared model/current
  work. Missing declarations stay `null`; MeMesh does not infer them from model
  output. Discovery neither sends nor acknowledges a message and fails
  explicitly when the local router is unavailable.

- **Exact active agent sessions now receive the message itself, not an inbox
  marker.** Authenticated Codex and Claude native channels carry one bounded,
  untrusted full envelope without a second fetch. Exact-session send succeeds
  only after native host acceptance; a missing, stopped, disconnected, or
  rejected session returns `recipient_unavailable` and is never silently
  rerouted or replayed later. Native acceptance still does not mean the agent
  read, acknowledged, or completed the work.

- **Claude Channel diagnostics are now surfaced by `memesh doctor`.** The
  diagnostic reports the user-scoped `memesh-channel` registration and its
  configured target, while making clear that it does not prove research-preview
  channel admission, live delivery, or acknowledgement.

- **Persisted Ollama hosts now use the same loopback guard as provider tests.**
  Runtime LLM calls previously trusted `llm.host` and fallback hosts read from
  config even though the Dashboard's provider-test path rejected non-loopback
  values. A crafted config could therefore send prompts and recalled memory to
  an arbitrary server. One shared resolver now rejects configured remote hosts
  before `fetch`; an operator-set `OLLAMA_HOST` remains the explicit remote
  override.

- **Briefing no longer aggregates another recipient's unread inbox.** Generic
  `briefing` and SessionStart context have no exact recipient identity and stay
  quiet. MCP and CLI callers can pass one known `project` + `recipient` scope
  to report only that recipient's unfetched deliveries, with instructions to
  `message poll` that scope before fetching each returned `message_id`.

- **Briefing and SessionStart can add a small amount of shared context without
  crowding out the current project.** Up to three safe, active global memories
  are ranked separately and capped at 640 characters. Project decisions,
  current work and recent project memories keep their existing budget and
  priority, and capture history records only the memories actually rendered.

- **Explicit lessons that start with the same words no longer collapse into
  one entity.** Their stable name now combines a readable prefix with a short
  digest of the complete normalized error, while submitting the same lesson
  again still appends to the existing lesson. Legacy readable-only identities
  are repaired without dropping their observations.

- **Dream refreshes its proposal list immediately after a successful run.** A
  newly generated proposal appears without a page reload; provider or inference
  failures stay visible instead of being presented as an honest zero-result run.

- **Notification readiness is reported separately from installation.**
  `memesh doctor` distinguishes an installed Codex command from a live
  session-specific host task and explains when live notification delivery has
  not been established. The messaging guide now documents that boundary.

- **MCP validation failures are shorter and more actionable.** Root-level
  schema errors no longer render a misleading dotted path, and the `message`
  tool schema states that `recipient` is required for send and fetch operations.

- **A plugin install can now tell "same version" from "same code".** Claude
  Code keys its plugin cache by version, so a stale cache could previously look
  current after fixes landed under the same version. `upgrade-plugin` now
  compares recorded revisions, repairs missing or stale same-version caches,
  honors `CLAUDE_CONFIG_DIR`, and updates the cache and registry atomically with
  rollback on a concurrent or interrupted change. `memesh doctor` reports a
  cache as current, behind, or unverifiable instead of trusting its version
  directory alone, and gives the matching Claude Code or Codex refresh action.

## [4.8.2] — 2026-08-29

A Dashboard usability sweep. Every item below was found by walking the v4.8.1
Dashboard as a non-engineer would, and each one is a place where the interface
reported something that was not true.

### Fixed

- **Saving an LLM provider now updates what the page shows.** Draft, tested and
  saved were one indistinguishable state, the capability cards kept the previous
  provider after a successful save, and the environment's auto-detected provider
  was presented as if it were the configuration on disk. The search-index
  provider had no Dashboard control at all.

- **A provider that rejects your key no longer echoes it back at you.** Upstream
  rejections quote the submitted credential ("Incorrect API key provided:
  sk-…"), and that sentence was rendered verbatim in the Dashboard. Every
  failing provider probe is now credential-redacted at the module boundary, and
  the shared redactor learned the two shapes it was missing: a partially masked
  key, and a credential in a URL query parameter.

- **A caller cannot make the server fetch an arbitrary URL.** `POST
  /v1/config/test` validated a caller-supplied Ollama host only when
  `OLLAMA_HOST` was unset — so configuring that variable, which is the
  documented way to reach a remote Ollama, disabled the loopback check and
  let the request's own host win. Found by an independent review of this
  release and reproduced end to end. A host that arrives in a request is now
  always validated; the operator's environment variable remains the
  privileged, unvalidated escape hatch.

- **The transcript secret gate now sees uppercase credentials.** Session
  capture drops a mined memory that carries a credential rather than
  storing it — but it compiled the shared pattern list case-sensitively, so
  `DB_PASSWORD=…` and `export OPENAI_API_KEY=…`, the dominant shape in a
  shell transcript, passed the gate and reached the LLM prompt while the
  same bytes were masked on the way out. Both consumers now agree.

- **Dream failures are visible.** A provider connection test could pass while
  Dream failed, and Dream's own provider errors were skipped silently.

- **Output-language changes report their own failure.** A save that failed was
  swallowed while the interface switched anyway, so the next session reverted
  with no explanation.

- **A keyless Ollama provider can be removed.** The saved-provider card kept an
  entry that could not be deleted from the Dashboard.

- **Seeding demo data refreshes the tabs already open.** Memories and Graph kept
  their pre-seed contents until a manual reload, and expanded analytics did not
  reconcile.

- **The mindmap's nodes do something when activated.** Phase and entity
  activation was a visible no-op, and the nodes were not keyboard reachable.

- **The feedback form survives a blocked popup.** When the browser blocked the
  GitHub window, the form cleared and closed, losing what had been typed.

- **Demo cleanup stays reachable after the library fills up.** The reset control
  was hidden exactly when it was most likely to be wanted.

- **Memory titles read as language, not as internal slugs.** Raw entity types
  and identifiers were the primary label; they are now secondary detail.

- **The global Signal/All filter says what it filters.** Its name and its
  cross-page effect were both unexplained.

- **Home presents one next-best action** derived from current state, instead of
  leaving the reader to work out where to start.

- **Terminal and GitHub handoffs are labelled before you act**, and the label
  follows the message's primary action — a message whose fix is "reload the
  page" is no longer announced as requiring a terminal.

- **Onboarding says which features depend on an LLM**, rather than implying the
  whole product does.

- **A memory stored in the `global` namespace is injected everywhere.**
  SessionStart selected purely by `project:` tag, so a global memory with no
  project tag was reachable by nobody — a standing rule stored that way was
  never injected into any session for months. Global entities now ride in a
  small separate window after the project's own memories.

- **Two unrelated lessons no longer fuse into one entity.** `learn` keyed
  every explicit lesson on a nine-value runtime-error enum, and anything
  outside those categories landed in one `-other` bucket per project —
  measured: one entity holding 68 observations. Explicit lessons are now
  keyed on their own text; resubmitting the same lesson still appends.

- **Graphs written by 4.8.1 are repaired at the first core open after upgrade.**
  The two fixes above stop new damage; they did nothing for the rows already
  there, and every graph that ran 4.8.1 hooks has them. Three one-shot passes
  now run with the other backfills (`src/storage/graph-repairs.ts`) at the
  first open through the core `openDatabase` — CLI, MCP, HTTP, and the two
  hook paths that import it; the hooks' own wrapper runs no migrations:
  duplicate observations on `session-*` entities are removed (706 rows on the
  maintainer's graph); a summary that claimed `0 files edited` beside a Bash
  command that writes files — the shapes the Stop hook itself recognises, not
  any `<<` — is rewritten to say the count was not recorded; and every
  explicit lesson in a `lesson-<project>-other` bucket moves — rows, ids and
  timestamps intact — to its own `lesson-<project>-<slug>` entity, the name
  `learn` gives it now (35 lessons out of four buckets), reviving that entity
  if a `forget` had archived it. The emptied bucket loses its
  `source:explicit` tag and is archived, not deleted — the entity and its
  relations stay; the work-layer graph view hides archived ends, the full
  view still names it — so a later auto-learned lesson cannot re-trip the
  invariant. A bucket that kept a stray non-lesson row keeps its tag and
  stays active, where the invariant can still see it.
  `severity:` is carried only when the bucket had one; with several, which
  lesson was critical is not recorded anywhere. The FTS index is rebuilt
  whole rather than patched row by row, because a contentless FTS5 delete for
  a row the hook never indexed corrupts the index. Vectors are left in place
  — sqlite-vec loads after the backfills — and a reindex is marked owed,
  which `memesh doctor` reports and `memesh reindex` clears. Each pass prints
  one line on stderr when it changed something.
  `scripts/audit/memory-invariants.mjs` holds on the maintainer's graph
  afterwards; its Bash-write test is now the hook's own regexes and its
  `0 files edited` match is anchored so `10 files edited` is not a hit.

- **`npm run build` no longer opens the developer's real graph.** The smoke
  test's HTTP-server child inherited no database path, so it opened `~/.memesh`
  and ran every migration in the working tree against it. Found the hard way:
  the repair above ran on the maintainer's real memories from a build. The
  child now gets the smoke test's own throwaway path.

- **The Stop hook stops re-appending the session summary.** A session that
  edited through Bash produced no `-files` entity, the re-capture guard keyed
  on that entity never tripped, and `-summary` grew by the same observations
  on every Stop — 56 rows, 16 unique. The guard now keys on all three session
  entities, and Bash-driven edits are counted instead of reported as `0 files
  edited`.

### Changed

- The memory timeline is named **Project History**, not Roadmap, in all eleven
  locales. It derives its phases from when memories were captured, which
  describes capture activity — not a plan, and not proof of project progress.
  The name now says so.

- **`message` says when to use it, and a waiting message is announced.**
  An agent working next to two other local agents for a whole session never
  reached for `message` — the host's own push tool named itself in the output
  the agent was reading, and nothing said "there is a durable inbox, and
  something in it is for you." Three changes, one per place the agent looks:
  the tool description now names the trigger (contact another local agent —
  hand off, ask, report back — and send here first; the inbox is the record,
  host push is only delivery); `briefing` and the SessionStart hook add
  `N messages waiting for "<project>" — fetch them with the message tool`
  beside the stated goal/next/blocked lines when a delivery has no intake
  receipt, on any graph including one with no memories yet; and AGENTS.md's
  loop gains the step. "Waiting" means no intake receipt — fetching and
  acknowledging remain separate facts.

### Internal

- Provider environment no longer leaks into the isolated test run, and the
  config read/write tests no longer touch the owner's real configuration.

## [4.8.1] — 2026-08-28

### Fixed

- **Local host files are handled without check-then-use races.** Managed ACP
  configuration and response files now use atomic creation or validate and
  consume the same opened file descriptor, preserving owner-private,
  non-overwrite, symlink, regular-file, and payload safeguards.

- **Feedback links on Windows no longer pass through a command parser.** The
  CLI opens the prebuilt GitHub Issue URL directly with Explorer, while macOS
  and Linux retain their existing direct argument-vector openers.

- **Concurrent local delivery keeps one explicit in-flight owner.** The router
  now awaits the shared delivery operation through a non-Promise ownership
  entry, preserving same-delivery deduplication and safe cleanup even when a
  host adapter re-enters synchronously.

## [4.8.0] — 2026-08-28

### Added

- **Durable local agent collaboration.** `message` now provides an
  exact-recipient local inbox across MCP, HTTP, and CLI. Payload fetch,
  intake, acknowledgement, workflow disposition, and host activation remain
  separate, auditable facts rather than one implied "delivered" state.

- **Owner-governed message retention.** Storage reports expose message and
  SQLite/WAL usage, pruning is dry-run by default and preserves lifecycle
  facts, and an optional owner quota rejects an oversized send atomically.

- **Governed product-improvement proposals.** Agents can stage
  evidence-linked proposals and read their status; only a human can accept or
  reject them. Accepted proposals retain their source memories and remain
  explicitly unverified work until separately evidenced.

### Changed

- **Active local Codex wakeups are bounded.** On supported macOS and Linux
  setups, the private local router can send routing metadata to an eligible
  active Codex session; the recipient fetches the durable payload separately.
  Stopped, unavailable, and unsupported sessions are not resumed or replaced,
  and queue acceptance is not an acknowledgement or a workflow decision.

- **Router and read-only access fail more truthfully.** Router reconnect and
  reply handling stays conservative when a private local delivery path is not
  usable, while recall can still return results when optional read-only access
  accounting cannot be written.

- **`autoUpdate=off` remains an explicit refusal.** A registry deprecation
  can warn and provide manual update guidance, but never starts an unattended
  update when automatic updates are off. A permitted npm-global update now
  records terminal success only after exact installed-version readback, records
  failure otherwise, and releases its single-flight lock when the worker exits.

## [4.7.3] — 2026-08-24

### Fixed

- **Two hooks errored on every Bash call and every turn under Codex CLI.**
  `post-commit` (PostToolUse) and `session-summary` (Stop) each ended by
  printing `{"suppressOutput": true}`. That is valid Claude Code hook output.
  Codex validates hook output per event against its own schema and rejects the
  field, so a Codex user saw `PostToolUse hook returned unsupported
  suppressOutput` after every Bash command and `hook returned invalid stop hook
  JSON output` at the end of every turn — while the capture itself had already
  succeeded. The memory was written and the error appeared anyway.

  Both hooks now print nothing. The field was never doing any work: neither
  writes anything else to stdout, so there was no output to suppress. Empty
  stdout with exit 0 is the "no opinion" signal in both contracts.

  Affects 4.7.1 and 4.7.2 for anyone running MeMesh as a Codex plugin. Claude
  Code behaviour is unchanged — a hook that prints nothing and one that asks
  for its output to be hidden look identical to the user.

## [4.7.2] — 2026-08-24

### Fixed

- **Three hooks could be killed by a lock they were told to wait 30 seconds
  for.** `guard-check`, `session-start` and `pre-edit-recall` each need a
  read-only database handle, which the shared opener cannot express, so all
  three opened the database directly and inherited the 30-second busy-timeout
  meant for long-lived writers — against their own 5- and 10-second budgets. A
  contended lock therefore ended with the agent harness killing the hook rather
  than the hook giving up cleanly. All three now apply the 2-second cap.
  `pre-edit-recall` had a second fault on top: it paid that wait twice, once
  for a guard query whose failure is swallowed by design and again for the
  recall query, measured at ~4.4s against a 5s budget. It now probes once and
  gives up once.

- **`memesh status` never opened the database it was reporting on.** Every line
  it printed came from somewhere other than the graph, so a corrupt or
  unreadable database was invisible to it — `status` printed a healthy report
  while `doctor` diagnosed the same file as broken.

- **`memesh config set` could store the opposite of what you typed.** Only
  `true` and `1` were read as true, so `yes`, `on` and `True` all became
  `false` — and the confirmation line echoed what you typed rather than what
  was stored, so `Set autoCapture = yes` looked like it had worked. Those keys
  now reject a spelling they cannot read.

- **`memesh remember --obs "   "` stored a memory with nothing in it.** Found
  by dogfooding. Whitespace-only observations are now rejected.

- **A recall that found nothing could not say whether semantic search had even
  run.** A zero-hit answer looked identical whether the vector index was
  working, absent, or degraded to keyword-only.

- **`memesh import --merge append` duplicated observations without bound.**
  Re-importing the same export repeatedly grew the entity every time.

- **`memesh why` reported a typo'd path as a real, uncommitted file** rather
  than saying the path does not exist.

- **`install-hooks` wrote a second file and never mentioned it**, so a user who
  wanted to undo the install had no way to know it was there.

- **MCP `forget` could not report failure** — it always answered success,
  including when it had removed nothing.

- **`POST /v1/config` reported success for a mistyped key it silently
  discarded.**

- **Three doctor rows fired on installs that were fine.** The locale-README
  parity check warned about translation files that npm never ships; the install
  ID row named a hardcoded path instead of honouring `MEMESH_DIR`; and a
  minutes-old install failed the update check it had not yet had time to run.

- **The German and Traditional Chinese READMEs were missing a whole section**
  (Recipes) and carried an abbreviated conflict-detection description, so
  readers of those two were shown less than readers of the English one.

- **A Codex CLI plugin install was classified as `unknown`, and every piece of
  advice that followed was wrong.** Codex adopted Claude Code's plugin manifest
  format and its cache layout one directory over —
  `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>` against
  `~/.claude/plugins/cache/…` — but `detectInstallChannel` matched only
  `.claude`, so a Codex-hosted copy fell all the way through to `unknown`.
  `memesh update` answered a real user with "does not support this install
  method (unknown). Update this installation from the tool or workflow that
  installed MeMesh", on an install it fully supports, and `memesh doctor`
  carried the same non-answer into its summary.

  Both runtimes now classify as `plugin-marketplace`, because the condition
  every consumer asks — "is this wired by a plugin runtime" — is genuinely the
  same for both. What differs is the remediation, so that is now host-aware
  rather than assumed. A Codex install is told `codex plugin marketplace
  upgrade pcircle-memesh` followed by `codex plugin add memesh@pcircle-memesh`;
  it is deliberately **not** told to run `memesh upgrade-plugin`, which reads
  `~/.claude/plugins/marketplaces/` and patches
  `~/.claude/plugins/installed_plugins.json` — neither of which Codex creates,
  so that command aborts with "marketplace cache not found". The doctor's
  hook-wiring and shell-CLI rows, and the session-start update banner, name the
  runtime they actually found instead of saying "Claude Code" to everyone.

  `getInstallChannelSupport` now requires the package root rather than taking
  it optionally. Every caller already had it — it is what produced the channel
  — so an optional parameter only bought the ability to be answered with a
  guess.

- **The security-advisory banner never learned about plugin installs.** The
  SessionStart deprecation banner — the one that fires when maintainers flag
  the installed version, typically for a security advisory — branched on
  npm-global, source-checkout and project-local, and fell everything else
  through to "fetch the latest from npm". It had no plugin-marketplace branch
  at all, and it takes precedence over the routine "update available" banner,
  which does have one. So the highest-stakes message carried the least
  actionable instruction, on both Claude Code and Codex, while the ordinary
  out-of-date message carried the right one.

  The cause was that the decision had been written down twice. Both banners now
  call one shared helper; that is what stops it recurring, not the added
  branch.

- **A plugin install under a relocated `CLAUDE_CONFIG_DIR` was classified as
  `unknown`.** Install detection matched the literal `.claude` directory name.
  Claude Code lets you move that whole directory with `CLAUDE_CONFIG_DIR`, and
  when you do the name is absent from the path — so detection found nothing,
  the install landed on `unknown`, and `memesh update` and `memesh doctor` both
  answered a supported install with "update this from the tool that installed
  MeMesh". Detection now resolves that variable as well as the path, keeping
  the path match because the running process's home is not necessarily the home
  the package lives under. The same handling covers Codex's `CODEX_HOME`.

### Changed

- **`AGENTS.md` no longer states that Codex CLI has no hooks.** It can have
  them: installed as a plugin it reads the same `hooks/hooks.json` manifest
  Claude Code does and runs the same hook scripts. Wired as an MCP server it
  still does not, and the manual loop still applies there.

## [4.7.1] — 2026-08-24

### Fixed

- **A test fixture whose verdict depended on the time of day.**
  `tests/core/timestamp-format-comparisons.test.ts` built a "just past the
  cutoff" timestamp as `cutoff - 1 hour` and then asserted it fell on the
  cutoff's calendar day — which is false for any run between 00:00 and 01:00
  UTC, because the cutoff carries the current time of day. It cost 4.7.0: the
  local suite, the release gate and all thirteen CI legs ran green at other
  hours, and the npm publish job — which started at 00:06 UTC — went red on
  it. The stamp is clamped to midnight of the cutoff's own UTC day, which is
  inside the window at every hour, and a second fixture guard in the same file
  now compares at the second resolution the product actually works at instead
  of a stricter millisecond one.

  No shipped behaviour changes. **4.7.0 was tagged and released on GitHub but
  never reached npm**, because this is the test that stopped the publish. Its
  entire contents ship here, in 4.7.1 — the `[4.7.0]` section below is the
  right place to read what changed.

## [4.7.0] — 2026-08-24

### Removed

- **`user_patterns` no longer reports `toolPreferences` or
  `workflow.avgSessionMinutes`.** Both were parsed out of observation text in
  a format nothing has ever written: `patterns.ts` looked for observations
  beginning `[FOCUS]` containing `Top tools: …`, and for `[SESSION]` lines
  containing `Duration: Nm`. Neither string occurs anywhere else in the
  repository, and `signal-scorer.ts` — which reads the one `[SESSION]` shape
  that did exist — shows it recorded **seconds**, not minutes. So
  `toolPreferences` was permanently `[]` and `avgSessionMinutes` permanently
  `0`, on the MCP tool output, the dashboard's Analytics tab, and in the
  documented response shape. The dashboard rendered the tool list only when
  non-empty (never) and the session figure as `—` (always).

  They are removed rather than implemented. The test for them was
  `expect(result.toolPreferences).toEqual([])` — a test asserting the
  deadness. `commitsPerSession`, `totalSessions` and `totalCommits` are
  computed from real rows and are unchanged.

  If you passed `"toolPreferences"` in `categories`, that value is no longer
  accepted; it previously returned an empty list.

- **`DEFAULT_SIGNAL_THRESHOLD` is gone.** Its docstring described a dashboard
  filter users could override in Settings. Nothing imported it but its own
  test, and no such filter exists. The signal score itself is real and widely
  used — the dreamer's compactable range, `kg-backfill`'s Rule 3 floor, the
  briefing — and is unchanged.

### Changed

- **`memesh export` now tells you when the bundle is only part of your
  graph.** The `--limit` default is 1000 and always has been, but nothing
  said so: on a real graph of 1272 memories the command printed
  `✅ Exported 1000 entities` and produced a bundle missing 21% of what it was
  taken to preserve. `entity_count` could not distinguish that from a graph
  that happens to be exactly 1000. The result now carries `truncated`
  (`true`/`false`) — visible to the MCP and HTTP callers as well as the CLI —
  and the CLI prints a warning on **stderr**, so `memesh export > b.json`
  still writes a clean bundle. For a full backup, pass a limit above your
  graph size: `memesh export --limit 100000 -o backup.json`.

- **`memesh import` no longer exits 1 for a relation that points outside the
  bundle.** *(Behaviour change — scripts that check the exit code are
  affected.)* Those relations are real information loss and are still
  reported, by name, in a new `skipped_relations` field and on stderr. But
  they are not an error: every bundle narrowed by `--tag`, `--namespace` or
  `--limit` has them, so counting them as errors made
  `memesh export > b.json && memesh import b.json` — the round trip this
  project's own help text recommends — a failing command on a restore that
  did exactly what it should. Measured: a full backup of a 1272-memory graph
  restored 1000 entities and 142 of 151 relations, and exited 1. `errors`
  still means an entry that genuinely failed, and still exits 1.

- **The export bundle is version `3.1.0`, and it is now actually a backup.**
  Three things a restore needs were missing from it, and a fourth was thrown
  away on the way back in:

  - `created_at` was not exported, so a restore stamped every memory with the
    day of the restore. That is not cosmetic: creation time drives recency in
    ranking, the dreamer's weekly clustering, `memesh why`, and every "what was
    I doing then" question. Restored only for entities the import creates, and
    only when `parseSqliteUtcMs` can read the value.
  - **Archived entities were skipped**, so `memesh forget` followed by an
    export and a restore brought the memory back to life.
  - `metadata` was not exported, losing `signal_score`, `task_state`, the demo
    marker and provenance. It round-trips now, minus `guard` — that field
    controls what memesh warns about on your tool calls, and a bundle you were
    sent must be able to bring memories, not to change what memesh does.
  - **Relations were dropped on import.** They were created inside the
    per-entity loop and skipped when the target "may not have been imported
    yet". That is not an edge case: `export` writes newest-first and relations
    point newer → older, so the target was almost always still further down the
    file. A backup of a graph with relations restored with none of them and
    reported success. They are created in a second pass now, after every entity
    exists, and one that still cannot be created — a target genuinely outside
    the bundle — is reported in `errors` instead of swallowed.

  Bundles written by earlier versions import unchanged; every added field is
  optional.

### Fixed

- **`memesh doctor` no longer counts the Install ID row as something it
  verified.** The row reports a stored value — your anonymous install id and
  when it was created — and has no branch that could fail, but it was built
  with `createCheck(..., 'pass', ...)`, so it rendered as `[PASS]` and joined
  the set of rows `Overall` is computed from. That is the exact case the
  `informational` flag was added for, and its own docstring names the
  Capabilities row as the instance that was fixed; this one was left behind.
  It now renders as `[INFO]`, like the other rows that describe state rather
  than assert it. No verdict changes as a result — the row was always `pass`,
  so it could never have moved `Overall` — what changes is that "N/N PASS" no
  longer counts a row that checked nothing.

- **`release:finish` no longer warns about a fetch that worked.** Its last step
  brought the new tag into the local checkout with `git fetch --tags origin` —
  a command that asks for every tag `origin` has and exits non-zero if any one
  of them cannot be written. This repository has 26 that cannot: measured
  across all 73 tags, the version tags from `v2.10.1` through `v4.1.7` plus
  `benchmark/longmemeval-public-r1` point at different objects locally than on
  `origin`, while everything from `v4.2.0` onward agrees. The cause is a
  history rewrite that removed internal documents — `origin`'s `v4.1.7` tree
  lacks four files the local one still carries. So that step printed
  ``could not `git fetch --tags origin` `` on every release, immediately after
  writing the new tag successfully. Measured on the v4.6.2 release, same
  checkout: `--tags` exited 1 with 26 rejections while
  `refs/tags/v4.6.2:refs/tags/v4.6.2` exited 0. It now fetches the one tag it
  needs — not `--tags --force`, which would silently rewrite 26 local refs as a
  side effect of cutting a release. The line that follows is unchanged and was
  already sound: it asks whether the tag is in fact present rather than
  treating the fetch's own report as the answer.

## [4.6.2] — 2026-08-23

### Added

- **`npm run release:finish` — the release is one command now.** Merging a
  release PR leaves `main` declaring a version nobody can install, and the gate
  that catches it (`scripts/lib/published-version.mjs`) could only shout about
  the window, never shorten it: the remedy it named was prose in an error
  string, and the three commands that prose described were typed by hand.
  v4.2.11 spent five days between the first and the last. `release:finish`
  refuses unless it is on `main`, the tree is clean, `HEAD` matches
  `origin/main`, the tag is free both locally and on `origin`, `gh` is
  authenticated, and `CHANGELOG.md` has a section to publish — and otherwise
  creates the tag and the GitHub Release in a single `gh release create` call.
  One call, because the hand-typed sequence had a worse failure mode than the
  one being fixed: a pushed tag with no release publishes nothing, while the
  coherence gate now sees the tag and reports ok.

### Fixed

- **Three gates that could report success without checking anything.** Each was
  found by the previous one.

  `scripts/wait-for-checks.mjs` exists because `gh pr checks`' exit code cannot
  be trusted as a verdict — and it carried the same hole one level down. It
  asked "is pending zero?", which is only sound once every check has been
  registered, and GitHub registers them in batches. Measured on PR #190: one
  poll returned a single row while the other twelve did not exist yet. Had that
  row been green at that instant, thirteen legs would have been reported green
  on one of them. A PASS now also requires the set of check NAMES to be
  identical across two consecutive polls; a FAIL is still immediate. Keyed on
  the name set rather than the count, because `cancel-in-progress` can swap one
  run's legs for another's at the same cardinality.

  `check-doc-claims` verified that every `memesh <word>` in the agent docs
  names a registered command, capturing only the first word — so a
  two-word name was read as its first word only - a real command - and passed. It now checks
  the child too, per parent (`patterns` is registered twice, top-level and
  under `dream`, so one flat set would accept it under the wrong parent), across
  every tracked markdown file rather than a hand-listed subset. The first
  version scanned single-backtick spans only and missed 19 nested commands
  living in fenced code blocks — more than the 25 it saw, and the fenced ones
  are what an agent copies out of `llms-install.md` and runs.

  The `C3` detector finds gate-like scripts that nothing runs, by counting how
  often their basename appears. It counted raw text, so a filename written in a
  COMMENT counted as a caller. This had already happened, been diagnosed, and
  been worked around rather than fixed: one script's header sentence naming
  another was enough to hide it, and the explanation was written into the other
  entry's triage reason as a warning not to delete the comment. Comments now
  come out before counting; over-stripping is the safe direction, because a
  lost reference makes a script look UNcalled, which fails loudly.

- **Two dead command names in the documents, both found by the gates above the
  moment they were added.** `docs/api/API_REFERENCE.md` named a `kg` subcommand
  that does not exist; the real one is `kg backfill-relations`.
  The 4.5.1 release notes named a `dream` subcommand that shows the source
  ids — `git log -S` finds no trace of that string in `cli.ts`'s entire
  history, so it is not a retired command in frozen history but one that has
  never existed. The passage means `memesh dream show`, whose output does print
  the source ids.


## [4.6.1] — 2026-08-23

### Added

- **A reindex no longer deletes anything until the new index is complete.**
  Rebuilding the vector index used to drop every stored embedding first and
  then refill — so a run that died part way (rate limit, dropped connection,
  `Ctrl-C`) left the graph half unsearchable, and on a paid API the
  embeddings it had already produced had to be bought again. The new index is
  now built in a staging generation beside the live one, which keeps answering
  queries throughout, and replaces it in a single transaction only once every
  entity that should have a vector has one and nothing failed. A failed run
  changes nothing: the live index is byte-for-byte what it was, never a
  half-new mix whose distances no longer compare. The embeddings already
  produced are kept, so running `memesh reindex` again resumes and asks the
  provider only for what it did not reach — a generation started by a
  different provider or at a different width is discarded rather than
  resumed, because vectors from two embedding spaces must not share an index.

  Switching embedding provider needs no special flag any more — change the
  provider and run `memesh reindex` (see **Removed** for the retired
  `--vectors`). The
  `DROP` is gone from the database-open path entirely — a dimension
  disagreement now keeps the working index and records that a rebuild is
  owed. Three sqlite-vec behaviours were measured before this was designed
  rather than assumed: a `vec0` table cannot be renamed (it keeps four shadow
  tables the rename does not touch, leaving the table unreadable), two `vec0`
  tables of different widths coexist, and `DROP`+`CREATE`+copy inside one
  transaction really does roll back — verified on the row data through a
  fresh connection, not on the table name.

- **Embedding requests are bounded.** The provider calls had no timeout, no
  retry and no backoff, so a provider that accepted the connection and never
  answered hung a whole rebuild indefinitely, and a 429 was indistinguishable
  from a 500 or a 401 — hitting a rate limit produced the same silent `null`
  as a bad API key. Now: 30 seconds per request, up to three attempts for a
  429 or 5xx honouring `Retry-After`, and an immediate stop naming the status
  for a 401/403/404, which is configuration rather than weather and where
  retrying only spends the user's rate budget on a certainty.

- **The graph has two layers: the work, and the evidence under it.** The
  Knowledge Graph tab opens on the work layer — decisions, lessons,
  plans, milestones (`WORK_LAYER_TYPES`, the one whitelist in
  `src/core/work-topology.ts`) — with a badge on each node counting the
  mechanical capture that supports it. Clicking a node loads that
  evidence, and only then: measured on a real graph the evidence layer is
  246 entities against 53 work items, so shipping it up front would pay
  for a payload almost nobody expands (`GET /v1/graph?layer=work` and
  `GET /v1/graph/evidence?node=`). Two rules keep it honest. Work nodes
  rank by recency, not by recall traffic: a decision made this morning
  has an access count of zero and was the LAST thing the old ranking
  named. And when there are fewer than three work items — a young
  install, where an empty work layer is the normal state rather than an
  error — the tab shows the full graph and says that it did, instead of
  presenting an almost-empty canvas as the answer.

- **`memesh kg backfill-relations` draws the evidence→work edges (Rule 5, on by
  default).** Commits and session captures get an `evidences` edge to the
  work item they support, matched on an exact session id — the
  `session:*` tag, or `metadata.session_id` for commit entities, which
  carry no session tag by design. With no session match it falls back to
  the most recent same-project work item created BEFORE the capture, so a
  first run over months of history distributes it across the items that
  were current at the time instead of piling everything onto today's
  newest node. Disable with `--no-evidence-links`. Until this runs, every
  badge in the two-layer graph reads zero — which is the honest number:
  the hooks capture evidence but have never drawn this edge.

- **Honest retrieval metadata: every recall says how it was answered.**
  The envelope (MCP, HTTP and `--json` alike) now carries
  `retrieval: { mode, degraded, truncated }` — `mode` is `hybrid` when the
  vector supplement actually ran and `fts` when the answer is
  keyword-only; `degraded: true` means embeddings ARE configured but the
  vector side could not run right now (provider failure or missing
  sqlite-vec), which until now silently served keyword-only results with
  nothing in the response saying so; `truncated: true` means the results
  filled `limit` and more may exist — the difference between "that is
  all" and "that is all I was allowed to return". The CLI prints a
  degraded warning and a "(limit reached — more may exist)" note in human
  output. One shape change rides along: `memesh recall --json` now always
  prints the object envelope (`{entities, retrieval, conflicts?}`) instead
  of a bare array normally and an object only when conflicts existed —
  the bimodal shape MCP and HTTP already abandoned.

- **`memesh why <file>` + `POST /v1/why`: file attribution with typed
  abstentions.** Local git resolves which commits touched a file
  (`git log --follow`, or `git blame` for `--line N`); the graph answers
  what memesh remembers about them — the captured commit entity, the
  session it was made in, and the memories associated with the file by
  `file:<basename>` tag (labelled "associated, not commit-derived").
  Every gap in the chain is a machine-readable abstention rendered as a
  sentence — `no_commit_entity`, `no_session_link`, `not_a_git_repo`,
  `file_not_tracked`, `line_uncommitted`, `line_out_of_range` — never a
  guess. The join is prefix-based in both directions because post-commit
  names entities `commit-<abbreviated hash>` while git emits full SHAs.
  The HTTP route takes commit hashes from the caller and never shells out
  to git: its strict schema has no repo-path field on purpose. To make
  the commit→session hop real going forward, the post-commit hook now
  records `metadata.session_id` and `metadata.files` (capped at 50) on
  commit entities — metadata rather than tags, so pre-edit-recall's
  file-tag join cannot start injecting commit noise into edits.
- **Project tab: history, honestly told.** Four additions to the roadmap:
  (1) a **capture-density band** — per-category (`knowledge` / `activity`
  / `session` / `reference`) histogram of when memories were captured,
  bucketed on `created_at`, the same axis the phase strip segments on,
  and named for what it measures: what memesh captured, not everything
  that happened; (2) a **lineage overlay** — `supersedes` (solid,
  neutral) and `contradicts` (dashed, warning) arcs drawn on the
  timeline between rows actually on screen, with a visible text legend
  counting only the drawn arcs; the superseded (auto-archived) targets
  of active entities are re-admitted into the roadmap so a chain always
  has both ends — general archived noise stays out; (3) an **ADR-style
  Decisions view** — one card per decision entity with an honest
  two-state status (`active` / `superseded`, derived from the graph, no
  invented lifecycle) and its supersession chain spelled out with jump
  links; (4) **URL deep links** — the dashboard now writes `?tab=` back
  to the address bar and the Project tab reads and writes `?project=`,
  so a copied URL shows the reader the view being looked at.

- **Lesson guards: a recorded mistake can now warn at the moment it is
  about to repeat.** The dreamer gained a guard stage: for each
  failure-shaped lesson (the Error / Root cause / Fix structure) it
  proposes a `{tool, pattern, message}` trigger — a regex over the Bash
  command or the Edit/Write content about to run — and every proposal is
  verified mechanically before staging: the pattern must compile, must
  not match a benign-input probe list (`git status`, `npm test`, …), and
  must pass its own attached evidence (at least two inputs that trigger,
  two that stay silent — executed, not trusted). A human accepts or
  rejects in the same review queue as every other proposal; acceptance
  writes `metadata.guard` onto the source lesson (nothing is created or
  archived, and the spec is re-verified with no model in the loop). At
  runtime a new `guard-check` hook (PreToolUse Bash — MeMesh's seventh
  hook) and the existing pre-edit-recall hook (Edit/Write, deliberately
  outside its recall throttle: a dangerous edit is dangerous every time)
  evaluate accepted guards as plain regex tests — no LLM, no network —
  and a hit injects the lesson's warning as a fenced reference block
  carrying the lesson's `[mem:id]` citation handle. v1 guards only WARN;
  the schema carries `action` so per-guard blocking can arrive once
  measured fire accuracy justifies it, and every fire is counted on the
  guard (`fires`, `last_fired_at`) so a guard that never fires or fires
  constantly surfaces for review. Guard failure of any kind degrades to
  silence — the guard system can never block or break the user's work.

### Removed

- **`embedder.model` is removed from the config.** It was settable
  (`memesh config set embedder.model …`), documented in three READMEs, and it
  never reached the embedding call — `embedText` built its provider config with
  `model: undefined`, so the only models ever used were each provider's default.
  It is removed rather than wired through, because honouring it would have
  introduced the exact fault the rest of this release closes: a vector index is
  fixed at one width and the width is resolved from the *provider*, so a model of
  a different width could never be rebuilt against, and one of the *same* width
  would have put vectors from a second embedding space into the index with no
  width signal to catch it. Each provider pins its own model and dimension
  (`ollama` → nomic-embed-text at 768, `openai` → text-embedding-3-small at
  1536). Setting the key now reports an unknown key instead of printing "✅ Set"
  and doing nothing.

- **`memesh reindex --vectors` is removed. Scripts that pass it will fail**
  with a message saying it was retired and naming `memesh reindex` as the
  replacement, and exit 1. The flag existed only to
  grant consent for dropping every stored embedding before the refill began,
  and generations removed that step, so there is no longer any consent to ask
  for. To rebuild the index at a new width — which is what the flag was used
  for — change the embedder in your config and run plain `memesh reindex`. It
  is rejected rather than accepted as a no-op, and rejecting it destroys
  nothing.

### Fixed

- **The reindex-owed marker is now actually written when a dimension change is
  noticed on open.** `markReindexOwed` guarded on the module-level database
  singleton, which `openDatabase` assigns only *after* initialisation runs — so
  during open it was still null and the write silently returned. Measured: 20
  cold opens of a 384-vs-1536 database printed the "semantic search is OFF"
  warning every time and recorded nothing, and `memesh doctor` then reported
  PASS over an index owed a rebuild. The open path now passes its own handle.
- **`memesh reindex --json` is honoured on the refusal paths.** It was
  silently ignored on the pre-flight refusal (an emoji banner instead of JSON),
  on `--discard-generation` (prose), on the retired `--vectors` flag, and on a
  thrown error — so a script piping the output through `JSON.parse` broke on
  exactly the paths where it most needed a machine-readable answer. One path
  still prints prose under `--json`: an invalid `--namespace` value, which is
  rejected by a validator shared with seven other commands and is out of this
  change's scope.
- **`memesh reindex` with no embedder configured now says so.** It told every
  user to "check that Ollama is running or your OpenAI API key is valid" —
  advice for a provider the user had never set up. The unconfigured case now
  names the two `config set embedder.provider` commands and says keyword recall
  needs no rebuild meanwhile.
- **`memesh reindex --vectors` now says it was retired and what to run
  instead.** It answered with Commander's bare `unknown option`, which reads as
  a typo and teaches nothing — the same dead end the retired `consolidate`
  command was already given a real message for.
- **`memesh doctor` no longer contradicts itself about Smart Mode.** With no
  config file and an API key in the shell environment — a common developer
  setup — the Config row said "MeMesh will run in Core mode" while the
  Capabilities row two sections later said "Search level 1 (Smart Mode)". The
  Config check now takes its answer from the same detector and names what
  enabled Smart Mode — the provider, and whether it came from an API key or
  from `OLLAMA_HOST`, which sets a provider with no key at all.
- **The dimension-mismatch notice prints once per database, not once per
  open.** `memesh doctor` opens the database twice in one run, so the same
  paragraph appeared twice back to back and read like a retry loop. The de-dup
  resets when the database is closed, so a process that then opens a
  different database is told again.

### Changed

- **Simplification pass over the rebuild code: net −12 lines, no behaviour
  change.** Three copies of the "does this table exist" query became one
  helper; two copies of the vector-width guard became one; a two-`try` read
  became one; and the CLI's three near-identical "Processed / Embedded /
  Skipped" blocks became one with byte-identical output. No test changed.

- **A failed rebuild no longer prints "Reindex complete" before "Reindex
  incomplete".** The first line meant "the loop finished", fired regardless of
  outcome, and sat in the same stream as the real verdict. It now says
  "processed N entities; M embedded this run".

- **A resumed rebuild no longer promotes a vector for text that has since
  changed.** It skipped an entity whenever a row for it was already staged, on
  presence alone — so an entity edited between an interrupted run and its resume
  kept the vector built from its old text, and nothing downstream could detect it
  because the row *was* there (the missing-vector count only asks whether a row
  exists). Each staged row now records a hash of what it was embedded from, and a
  resume reuses it only while that still matches. An unchanged entity is still
  never bought twice, and `already_staged` is now its own count instead of being
  folded into `stored` — a resumed run used to report "900/900 entities embedded"
  after issuing one request.
- **A half-built index whose marker cannot be read is no longer thrown away
  silently.** "The marker is unreadable" and "there is no rebuild in progress"
  were the same answer, and the caller treats the second as licence to delete —
  so a marker that failed to parse discarded every embedding a previous run had
  produced. Neither choice is safe to make silently (resuming could merge two
  embedding spaces; discarding destroys work), so it now refuses, says which it
  is, and points at `memesh reindex --discard-generation`.
- **A rebuild against a broken provider stops instead of grinding through the
  whole graph.** There was no circuit breaker: a provider that stopped answering
  at entity 50 of 20,000 was still asked about the remaining 19,950 — up to ~91.5
  seconds each — printing one identical failure per entity, even for a 401, where
  the code's own reasoning is that retrying "spends the rate budget on a
  certainty". Five consecutive failures now end the run; everything already
  embedded is kept and the next run resumes. Provider backoff is also exponential
  rather than linear, so a rate limit is backed away from instead of re-arrived
  at.
- **A provider that sends headers and then stalls the body is now retried.** The
  response was parsed by the caller, outside the retry, so an abort during the
  body read arrived as an indistinguishable `null` with no attempt counter and no
  message naming it a timeout — which is precisely the failure the 30-second
  budget was added to catch.
- **A whitespace-only memory no longer holds the reindex flag open forever.**
  SQLite's `TRIM` strips spaces only while JavaScript's `.trim()` also strips tabs
  and newlines, so the rebuild loop and the database disagreed about the same
  entity: permanently "nothing to embed" to one and permanently owed a vector to
  the other. Every full reindex reported "1 active memory still has no vector"
  and could never resolve it.
- **`memesh reindex` no longer prints a tick when the new index was refused.**
  The verdict was built from a count taken against whatever index is *live*, so
  when a rebuild was withheld that was the old, complete-by-construction index —
  the run exited 0 while its own output said the new index was not switched in.
  The result now carries `generationSwapped` and `abortedAfter`, and `--json`
  publishes both.
- **`memesh doctor` reports a half-built index.** An interrupted rebuild leaves a
  full second copy of the vectors on disk; nothing reclaimed it and no diagnostic
  mentioned it, so it could sit there indefinitely. Doctor now shows its size,
  width, provider and age, with the two ways out.
- **A rebuild no longer discards a memory captured while it ran.** The swap
  installed exactly the staging index, and every writer other than the rebuild
  itself — the seven capture hooks, `remember`, the dreamer, the MCP server —
  writes the live index, which the rebuild had snapshotted before it started.
  So a memory captured mid-rebuild lost its vector, and one whose text was
  *edited* mid-rebuild had its fresh vector silently replaced by the older
  staged one, which the missing-vector count cannot detect because the row is
  present. Rows still active and absent from staging are now carried across the
  swap. Conversely a memory deleted mid-rebuild could be resurrected, because
  `forget` clears the live row and knows nothing about a staging index; staged
  rows for entities that are no longer active are now pruned before the swap.
- **`memesh doctor` can no longer report a healthy install over a graph that is
  owed vectors.** The swap deleted the reindex-needed marker itself, which
  pre-empted the check that runs afterwards against the finished index — so a
  rebuild that completed while vectors were still missing printed "the
  reindex-needed flag was left set" and then left nothing set. The marker now
  has one owner, the post-rebuild measurement, which either clears it or writes
  it.
- **Semantic search being off during a width change is reported instead of
  hidden.** A query embedded at the new width cannot be matched against an index
  built at the old one; sqlite-vec raised, the error was swallowed into an empty
  result, and "no matches" is indistinguishable from "no search happened" — so
  `recall` reported `mode: "hybrid"`, `degraded: false` for a vector side that
  answered nothing, for the entire window between switching provider and
  finishing the rebuild. It now reports `mode: "fts"` and `degraded: true`, and
  the message printed on open says semantic search is off until the rebuild
  finishes rather than claiming the index "still answers queries".
- **A rebuild no longer costs concurrent writers their captures.** The swap
  copies every embedding inside one transaction — that copy *is* the atomicity
  guarantee, because a `vec0` table cannot be renamed — and the copy is O(rows):
  measured at 5.4s for 20,000 vectors and 9.1s for 30,000. Against the 5-second
  busy timeout that meant a rebuild on a graph past roughly 16,500 vectors made
  concurrent writers *fail* rather than wait, losing hook captures. The busy
  timeout is now 30 seconds, which covers a graph around 100,000 vectors.
- **Two runtime messages told users to run the removed `--vectors` flag** on a
  dimension mismatch — the exact situation the new mechanism exists to handle —
  so the only remedy offered exited 1. Both now name `memesh reindex`. A test
  scans every source file that prints advice and fails on any `memesh <cmd>
  --flag` the CLI does not register; it immediately caught a second, older
  instance, `memesh doctor --verbose`, a flag that never existed.
- **An embedding provider can no longer redirect the request carrying your
  memory text.** The provider fetch used the default redirect behaviour; a 307
  forwards the POST body to the redirect target, and the Ollama base URL is an
  unvalidated environment variable. Redirects are now refused.
- **A failed read of the staging index is no longer reported as "nothing is
  staged".** That number decides whether a finished rebuild is promoted and
  which entities a resume re-buys from the provider, so a locked database or a
  corrupt shadow table must not arrive as an empty result. The staging index's
  start time also survives a resume now, instead of being overwritten on every
  attempt.

- **Dashboard design system: VIVARIUM supersedes Precision Engineer.** The
  dashboard's visual language is rebuilt around one idea — a second brain
  that is *alive*: what glows is recent, what is sealed in amber was
  preserved by a human, and total stillness is the alarm. Concretely: the
  ground becomes a neutral night (`#09090A` family) so the new
  bioluminescent-green accent (`--life`, `#8FF25C`) is reserved for what is
  actually alive — active state, focus, and the header heartbeat, the one
  sanctioned idle animation, which breathes only while the dashboard is
  connected and falls perfectly still when it is not (honest by
  construction, and static under `prefers-reduced-motion`). Memory content
  now speaks in its own serif voice (Newsreader) distinct from UI chrome
  (Bricolage Grotesque) and data (Geist Mono, unchanged). Entity-type
  colours are no longer nine hand-picked hexes: every species hue is the
  output of one formula, `oklch(0.78 0.12 H)`, at equal lightness so no
  type shouts over another — the luminance channel is reserved for the
  vitality mechanics the UX arc ships next. The old cyan brand and the
  retired hues joined the design-token test's blacklist, so writing any of
  them again fails CI. `DESIGN.md` is rewritten as the constitution of the
  new system, including the laws ("luminance carries information or it
  does not appear", "every moving pixel tells a truth") and the component
  patterns the coming tab consolidation must follow.
- **Dashboard: eight tabs become five — Home, Memories, Project, Graph,
  Settings.** Four of the eight were the same library wearing four doors:
  Search, Browse, Manage and Lessons all listed memories, and two of them
  each pulled their own duplicate 2000-row load to do it. They are now one
  **Memories** tab with one fetch and one search box — it filters instantly
  as you type, and Enter asks the server for ranked results (full-text +
  vector). Scope chips cut the library into the work layer
  (goals / decisions / lessons / plans), evidence, everything, or archived;
  a cluster composition bar shows what the current scope is made of; and
  every row expands in place — lessons keep their structured
  error / root-cause / fix / prevention view. Archived stopped being a
  10-row capped list and became a real scope with restore. Insights and
  Analytics merged into **Home** — what memesh did for you, dreamer recaps
  and pattern proposals first, with the full analytics stack (health score,
  30-day timeline, PM velocity + KG connectivity, work patterns) folded
  into an expander that defers its five requests until opened. The project
  roadmap (phases, milestones, key lessons, behind a project selector) got
  its own **Project** tab. Old `?tab=` deep links and stored tab choices
  migrate to the surface that absorbed them, so a bookmarked
  `?tab=Browse` opens Memories instead of nothing.
  Three of the retired Lessons tab's four counters were **dropped on
  purpose, not migrated**: total failures, plan records and total recalls
  answered no question a reader acts on, and the recall total was built on
  the literal-content matching that measured 0% signal and has since been
  retired. The fourth — how many lessons are marked `severity:critical` —
  is the one a reader does act on ("mistakes I have already paid for,
  waiting to be repeated"), and it moves to Home rather than disappearing.
- **One notice at a time.** The Doctor, Onboarding and Insights banners
  could stack three deep above the nav. They now share a priority slot —
  Doctor (broken install) > Onboarding (empty library) > Insights
  (pending proposals) — showing exactly one; the next in line surfaces
  the moment the winner is dismissed or its condition clears.
- **Recall accounting becomes honest: explicit citations replace literal
  matching.** "Was an injected memory actually used?" used to be answered
  by substring-matching names and titles against the transcript — measured
  across ten real sessions and three matching strategies, that had **zero
  signal**: nobody restates a memory's title in prose, so every injected
  memory drifted toward an unearned `recall_miss`, and misses feed the
  ranking's impact factor. Now every injected line carries a citation
  handle (`[mem:42]`, on both the session-start injection and the
  `briefing` tool), one instruction line asks the agent to cite the
  memories it genuinely uses, and the Stop hook credits `recall_hits`
  from those markers alone — after structurally stripping the hook's own
  echoes, so the injection can never cite itself. The markers are
  self-reported and therefore undercount, never overcount; on that
  asymmetry `recall_misses` is **frozen** until measured compliance (two
  new `memesh_metadata` counters track it) justifies reading silence as
  non-use, and an accounting-mode stamp keeps the two eras of numbers
  apart. The injected-set record now also includes the lessons pool,
  which was never accounted at all. Measured on the same database
  snapshot, the handles and the instruction cost +70 tokens per session
  start (695 → 765) — the price of measuring injection ROI instead of
  guessing it.

## [4.6.0] — 2026-08-16

### Added

- **`memesh upgrade-plugin` — the CLI front door to the plugin upgrade script (P6).**
  Upgrading a Claude Code plugin install used to mean hand-substituting the
  installed version into
  `~/.claude/plugins/cache/pcircle-memesh/memesh/<current-version>/scripts/upgrade-plugin.sh`
  — a path shape most users get wrong on the first try — and the script then
  died partway through when `rsync` was missing, a prerequisite the README
  never named. The new command finds the newest installed plugin version
  itself, checks the script's prerequisites (`node`, `npm`, `rsync`) up front
  — a missing one is a plain sentence naming what to install, before anything
  runs — and executes the bundled script with its exit code passed through
  unchanged. With no plugin cache present it points npm users at
  `memesh update` instead. READMEs (en / zh-TW / de) now lead with the
  command and keep the hand-run path as the fallback for plugin-only
  installs without the npm CLI.
- **Agent-facing install and usage docs: `llms-install.md` and `AGENTS.md`.**
  Many users have their AI agent install and operate memesh; until now the
  agent's only source was the human README, 668 words to the first command
  and with the contradictions the install audit catalogued. `llms-install.md`
  is deterministic per-host instructions — exact command, expected output,
  failure→remedy table — for Claude Code (typed in chat, verified by the
  `◉ MeMesh` session-start line), terminal (Node floor checked first),
  Codex CLI and Gemini CLI. `AGENTS.md` is how to use it well: the
  token-economy loop first, the 9-tool table, memory hygiene, what Claude
  Code hooks already do (so agents do not double-write), and — for agents
  working ON this repository — the working policy in compressed form. Both
  ship in the npm package, and `check-doc-claims` gained a machine gate:
  every `memesh <subcommand>` in these docs must be a registered CLI
  command, the AGENTS.md tool table must match TOOL_DEFINITIONS name-for-
  name both directions, and the documented Node floor must equal
  `engines.node` (gate break-tested 5/5 KILLED).

### Fixed

- **`memesh doctor` warned about eight locale READMEs that were removed on
  purpose.** `LOCALE_README_FILES` still listed the ten-locale set from
  before the reduction to English + 繁體中文 + Deutsch, so every source
  checkout ran `readme_locale_parity` into a WARN — "missing 8 files" —
  and the overall verdict degraded to PASS_WITH_CONCERNS on a healthy tree.
  The list now tracks the real set (with a comment tying it to the
  reduction), and the parity tests exercise the real locales instead of
  eight deleted ones.
- **`memesh setup` — one command from installed to wired, per host, verified
  at machine level.** The install audit's core finding was that no tool
  could answer "is this MACHINE wired?": `memesh doctor` scopes every check
  to the copy being invoked, so a plugin-only user has no copy that can see
  the plugin, and a both-paths user gets a report that contradicts
  install-hooks' own bail message. `memesh setup` reads the HOSTS' own
  state — Claude Code's plugin registry and settings.json markers, Codex's
  and Gemini's MCP registries — detects which hosts exist, offers to wire
  each (through the host CLI's own `mcp add`; memesh never writes their
  config files), and verifies by re-reading, not by trusting its own
  actions. `memesh setup --check` is the read-only verdict (exit 1 when a
  present host is unwired). Design went through an adversarial engineering
  review first, which caught — before implementation — that
  `claude mcp add` defaults to LOCAL scope (would have wired only the
  directory setup ran in; it uses `-s user`), and that Gemini has no
  `mcp get` subcommand (its probe reads `~/.gemini/settings.json`, the
  shape verified against a real machine). Absent hosts are informational,
  never failures; an unprobeable host is UNKNOWN, never "wired".
- **`memesh doctor --fix` — doctor now repairs what it prescribes, within a
  deliberately short whitelist.** Fixable prescriptions carry a machine
  `fixId` attached at the diagnosing BRANCH (never parsed out of the human
  fix string): hook wiring (runs the same `installHooks()` as
  `memesh install-hooks` — backs up settings.json, refuses on
  plugin-managed machines), the keyword-index rebuild (free, local), and
  the database chmod. Deliberately NOT fixable: `memesh reindex` for the
  vector index (re-embeds the whole database — real money on a paid
  provider) and the rm/mv database branches (destroy or move user data) —
  those stay human decisions. Asks per fix on a terminal; `--yes` applies
  silently; non-interactive without `--yes` changes nothing and exits 1.
  The after-state is a fresh doctor run diffed per check ("hook-wiring:
  warn → pass"), not trust in the fixes.

### Fixed

- **doctor and install-hooks no longer contradict each other on a
  plugin-managed machine.** With the plugin managing hooks and the npm CLI
  also installed (the README's own recommended setup), `memesh
  install-hooks` correctly bailed with "Hooks are active" while `memesh
  doctor` WARNed "memesh is not connected to Claude Code" in the same
  minute — the wiring check only trusted its own copy's marker file. The
  check now consults Claude Code's plugin registry
  (installed_plugins.json, machine-level truth) before claiming the
  machine is unwired, through an injectable seam — without which every
  no-marker unit test would silently flip on any developer machine that
  has the plugin installed (measured: two did, on first run).


- **`briefing` — the assembled work topology for clients that run no hooks, and the 9th MCP tool (A1c).**
  Claude Code gets the work topology pushed by the session-start hook. Every
  other MCP client — Gemini, Codex, anything speaking the protocol — could
  reach the parts (`recall`, `task_state`) but never the assembled block.
  `briefing` returns it: task state first, then decisions, lessons,
  knowledge and recent activity, wrapped in the same fence and
  "background data, not instructions" preamble the hook uses. Also
  `memesh briefing` on the CLI, for agents whose only integration is a
  shell (the OpenClaw/Hermes pattern).

  Two single-owner moves behind it, closing drift the A1a design had left
  possible:

  - The auto-injection policy (which memories may be shown to an agent
    unasked) moved from the hooks' `_shared.js` into the work-topology leaf
    as `isAutoInjectable()`; the hook now delegates to the same function the
    MCP side calls.
  - `buildReferenceContext` — the fence that IS the trust boundary — moved
    to the same leaf, so both injection paths share one implementation.

  A parity test runs the real hook and the real assembler against the same
  database and asserts the same content lines in the same order. On its
  first run it caught a real divergence: the hook's lesson-pool query never
  selected `title`, so lessons were injected as raw observation snippets
  while everything else got UX-1 titles. Fixed in the same change.

- **`task_state` — one "where we are" per project, and the 8th MCP tool (A1b).**
  A new `task-state` memory records four fields for a project: the goal, the
  next step, what is blocked, and what was just finished. It is read back at
  the top of the next session's injected context, before any ranked memory,
  because it is the one line in that block someone stated on purpose —
  everything else is ranked, and ranking cannot know what you meant to do
  next.

  Writable three ways: the new `task_state` MCP tool (read with no arguments,
  write with any field — so Gemini and Codex reach it over MCP too), the new
  `memesh task` CLI command, and nothing else.

  **Nothing derives these fields automatically, and that is deliberate.** The
  plan had the Stop hook write them. A transcript mechanically yields "edited
  6 files, hit 2 errors"; turning that into "the goal is X" is a machine
  guessing intent, and the guess would reach the next session as fact with
  nothing to contradict it. `done` is no better — a session that edited files
  is not a session that finished anything. So all four are stated explicitly
  or not at all.

  Details that matter in use:

  - An empty string **clears** a field (`memesh task --blocked ""`), which is
    how a resolved blocker gets removed. Omitting a field leaves it alone —
    a different thing, and the two are told apart by which keys arrived, not
    by whether they are truthy.
  - Re-stating a value writes nothing: no new observation, and `updated_at`
    stays put, so the age shown in the injected heading ("2 days ago") stays
    an honest answer to how old the thinking is rather than how recently
    something was echoed. This is also what bounds the row's growth — it
    grows per change, not per session.
  - Current state lives in `metadata.task_state`; the observation trail is
    its history. Reading the current goal out of the trail would mean
    guessing which line is newest.
  - `TaskStateSchema` is `.strict()`, alone among the tool schemas: on this
    tool an unknown key changes the operation. "No recognised field" is what
    marks a call as a read, so a model writing `blocker:` for `blocked:`
    would have the key stripped, fall through to the read branch, and get a
    success-shaped response back with nothing recorded. (The other schemas
    strip unknown keys too, but there a stripped key still leaves the
    intended write intact.)

  Break-tested 6/6 KILLED: the ranked-pool exclusion, the injection itself,
  the strict schema, the no-op guard, empty-string-as-clear, and the age in
  the heading.

- **Platform integration guides for Hermes Agent and OpenClaw.** Two native
  memory-plugin integrations now documented: Hermes Agent (NousResearch,
  Python `MemoryProvider` ABC) and OpenClaw (TypeScript memory-capability
  plugin). Both integrate at the same tier as their respective framework's
  built-in memory backends — not HTTP bridges. Hermes guide includes four
  real pitfalls from a live dgx94 deployment; OpenClaw guide documents the
  confirmed contract from the LanceDB reference plugin. Both added to README's
  native-integration section and the platform comparison table in
  `docs/platforms/README.md`. GitHub topics updated to include `hermes-agent`
  and `native-integration`.

- **OpenClaw TypeScript plugin implementation.** Complete native
  memory-capability plugin at `extensions/memory-memesh/` (478 lines): three
  tools (`memory_recall`, `memory_store`, `memory_forget`), auto-recall hook
  on `before_prompt_build`, TypeBox config schema, timeout/cooldown handling,
  prompt injection defense. Maps MeMesh's HTTP API (`/v1/recall`,
  `/v1/remember`, `/v1/forget`) onto OpenClaw's plugin contract. Based on
  `@openclaw/memory-lancedb` reference (711 lines). Status: built, NOT yet
  tested against live OpenClaw instance. Package name:
  `@pcircle/openclaw-memory-memesh`.

- **Hermes Agent reference plugin implementation.** The live-tested Python
  `MemoryProvider` from the dgx94 deployment now ships in-repo at
  `extensions/hermes-memesh/` (`__init__.py` + `plugin.yaml` + `README.md`).
  Includes the session-boundary hooks (`on_pre_compress`, `on_session_end`,
  `on_session_switch`) with the synchronous-archive fix for the
  `provider.shutdown()` race (Pitfall 5 in the platform guide). Copy into a
  Hermes checkout as `plugins/memory/memesh/`.

### Changed

- **Release-prep simplification pass (two independent reviews over the
  install-UX arc; fixed and skipped items recorded in the PR).** One PATH
  predicate instead of two in the same file; `settingsHaveMemeshHooks`
  exported from install-hooks (the module that stamps the marker) instead
  of a third private walker in setup; doctor passes the plugin-registry
  seam through and lets `detectPluginRuntime` own its default path;
  doctor --fix dispatches through an exhaustiveness-checked Record (a new
  fixId now fails to compile rather than prompting and silently doing
  nothing), shares `wireUserHooks()` with setup, forces probes OFF on its
  verification re-run (`--probe --fix` was paying the live LLM probe
  twice), and scopes the after-diff to the checks it actually fixed; the
  session-start hook stops restating the topology budget and now imports
  the shared candidate cap (fulfilling the "both sides agree" contract its
  comment claimed); check-doc-claims states the agent-docs list and the
  tool-name extraction once each.


- **Every tool schema is now `.strict()` — the runtime finally enforces the
  `additionalProperties: false` every tool's MCP inputSchema has advertised
  all along.** Zod's default silently strips unknown keys; the gap graduated
  from cosmetic to destructive twice (forget's plural typo archived whole
  entities; task_state's stripped key flipped a write into a read), and the
  "harmless" cases were still silent data loss — `titel:` for `title:`
  dropped the title while reporting success. A mistyped key is now rejected
  with its name, on MCP and on the HTTP routes that share these schemas.
  One deliberate exception, documented in place: `ExportResultSchema`, the
  portable file format — a newer memesh may add export fields and an older
  install must still import them, so tolerance there is forward
  compatibility. The provenance-spoof tests were updated to pin the new,
  stronger outcome: a smuggled `sourceHost` is rejected outright and
  nothing is stored, instead of being silently stripped.

- **`memesh update` / `status` / doctor / the session-start banner now
  recommend `memesh upgrade-plugin`** for plugin-marketplace installs
  (previously: a bash path the user had to complete by hand;
  plugin-only users are pointed at `npx @pcircle/memesh upgrade-plugin`).


- **The README answers "install it" in the first screen, and stops making a
  false claim.** An install-path audit (all eleven paths, stepped through
  against the actual code) found the first working command 668 words into the
  README — inside a warning box — and one sentence that was simply untrue:
  Option B claimed "the MCP server is registered" when the npm package
  deliberately runs no install scripts and registers nothing. Now: a compact
  `## Install` section right under the intro (both paths, with the
  verification for each — the plugin's verification is the `◉ MeMesh`
  session-start line, which was previously documented nowhere); the false
  sentence corrected in all three languages; the Codex/Gemini wiring section
  added to 繁體中文 and Deutsch (both previously omitted it entirely); the
  platforms guide table aligned with the root README (it told Claude Code
  users to hand-edit MCP config and listed Gemini as HTTP-only); and two new
  subsections — "See what it remembered" (`memesh briefing` as the one-command
  answer) and "Your data" (one local file, backup = copy it, capture opt-out,
  delete = remove the directory).

- **CLAUDE.md carries the working policy.** Lightweight vs full-process
  criteria, findings-first review with `PASS`/`PASS_WITH_CONCERNS`/`FAIL`
  verdicts, no runtime claims without runtime evidence, disjoint-scope
  delegation, and internal-notes-stay-local — stated once, in the pointer
  file assistants actually read.
- **The `/memesh` skill leads with the continuity loop.** The skill now opens
  with the four moments that make memory pay for itself: session start →
  load the briefing once (with the explicit Claude Code exception — the
  session-start hook has ALREADY injected that block, and the old skill was
  actively instructing double-injection by listing `memesh briefing` under
  "you need context" with no host distinction); user states a goal / next /
  blocker → record it via `memesh task` immediately, only what was said;
  session end → make the task state match reality; "what do you remember?"
  → briefing, then relay. Also fixed against the real surface: the
  SessionStart hook row described the pre-A1 injection, the PreToolUse
  matcher said `Edit` only (it is `Edit|Write`), and `--title` /
  `--supersedes` / `--contradicts` were absent from the remember recipe. New
  memory-hygiene section: stable names append, `supersedes` retires,
  `contradicts` flags, prefer observation-level forgetting.


- **The topology assembly has one owner; the review that found it also found
  two real defects.** A four-angle cleanup pass over the A1 arc (reuse /
  simplification / efficiency / altitude) converged on the same seam from
  three directions: the assembly sequence — dedupe pools, task-state block
  first, spacer, sections, budget — was restated line for line in the
  session-start hook and the `briefing` tool, held together only by a parity
  test on a small fixture. It is now `assembleTopologyBlock()` in the
  work-topology leaf, alongside the exported budget constants both sides
  previously declared separately; each consumer keeps only its own database
  access and row mapping, which is what the A1a design assigns it.

  The two defects the pass surfaced, both fixed here:

  - **A foreign or stale task-state rendered as a decision.** The consumers
    excluded the task-state row from the ranked pool by comparing the exact
    current name, which protects nothing else: another project's task-state
    arriving through the recent pool, or a `task-state:<old-name>` left
    behind by a project rename, fell through to "Decisions and direction"
    and presented a goal as a decision someone made here. `groupTopology`
    now drops the TYPE; `taskStateLines` is that type's sole renderer.
  - **The briefing over-read and over-wrote.** It selected through
    `kg.search`/`kg.listRecent` — recall's machinery, sized for limit≈20 —
    which hydrated observations, tags and relations for up to 2×400
    candidate rows to render ~35 lines, and bumped `access_count` on every
    one of them, teaching the ranking that ~765 never-shown rows were
    "used". Selection is now a lean scalar read (rank, gate, then fetch one
    snippet for survivors only — the hook's own shape) and tracks no access,
    matching the hook, whose injection never tracked.

  Smaller items from the same pass: snippet pre-slicing at exactly the line
  cap defeated `clip()`'s word-boundary cut on both surfaces (snippets are
  now fetched a few line-widths long and clipped once, by the owner);
  `isRecallHit` re-lowercased the multi-megabyte transcript on every call —
  twice per injected entity since title matching landed (the caller now
  lowercases once, and a new test pins the mixed-case-title match that made
  the needle-side lowercase load-bearing); two task-state helpers nobody
  called and one never-passed budget option were deleted; the generated hook
  copies moved to eslint's ignore list next to `dist/` (same category:
  compiled output of linted source).


- **Session-start injection is a work topology, not a provenance dump (A1).**
  The block an agent receives at session start used to be grouped by where a
  row came from — "Lessons learned", "Project memory", "Recently active" — and
  each line led with the entity's machine dedup key
  (`session-<pid>-<ts>-files`), followed by a 160-character observation
  snippet that was usually a near-duplicate of the title UX-1 had already
  derived from it.

  It now groups by what the memory IS — decisions and direction, lessons,
  what is known, recent activity — orders within each section by
  `signal_score` (unscored hook captures rank last but are never dropped, so
  a graph with only mechanical capture still gets a useful block), shows the
  title with a `title → snippet → type` fallback that never reaches the name,
  and truncates on word boundaries instead of mid-word.

  **Measured on the same database with the same eligible entities, so only
  the serialization differs: 833 → 666 tokens, −20%.** Fewer tokens is not on
  its own the goal — an empty block would win that — so the claim is
  narrower: the same content, more usable structure, for a fifth less
  context. Whether the model *uses* it more is not claimed; the instrument
  that would measure that (literal-mention matching) was found to carry no
  signal at all and is recorded that way in the baseline.

  Memories from other projects now get their own honest heading instead of
  being filed under one that names the current project.

  New: `src/core/work-topology.ts` — a runtime leaf, copied next to the hooks
  by the existing codegen, exporting `WORK_LAYER_TYPES` as the single
  whitelist for what counts as the work layer. UX-4 consumes this constant
  rather than defining its own.

### Fixed

- **A memory class that ranked high could starve the injection window.** The
  session-start pools took the top `sessionLimit * 3` rows by score and
  applied the trust filter afterwards, so an entity class that both ranks
  high and gets filtered could consume the whole window. Measured: all 30
  top-ranked project rows were filtered, the section rendered empty, and 92
  eligible entities sat below the cut. The window is now wide enough that a
  filtered class cannot fill it.

- **Recall-effectiveness scored a miss against a string it no longer sends.**
  `isRecallHit` matched the transcript against the entity NAME; the injected
  block now shows the title. Left alone, every injected memory would have
  taken an unearned `recall_miss`, which lowers its impact factor in core
  ranking. It now matches either.

- **Memories you accepted were being withheld from the agent, while raw commit
  records were not.** `dream accept` stamped `metadata.trust = 'untrusted'` on
  the entity it created, and `isTrustedForAutoContext` reads that as "never
  inject unprompted". Measured on a real graph before changing it: of the
  active memories tagged to one project, **74/74 commit records were eligible
  for auto-injection while 29 facts, 11 lessons and 6 decisions — every one
  accepted by a human — were not.** The raw commit text that motivated the
  marker reached the model either way; only the reviewed paraphrase of it was
  blocked, so the gate protected nothing and inverted the channel.

  Auto-injection eligibility now follows human acceptance. The write-side half
  of the old marker is unchanged and now stated explicitly as `trustOverride`:
  a re-applied digest still cannot lift its own confidence. Import
  (`serializer.ts`) and auto-learned lessons (`lesson-engine.ts`) still mark
  themselves untrusted — nobody reviews those before they land. A marker-guarded
  backfill releases entities accepted before this change, scoped by
  `metadata.proposal_id` so it cannot reach an import. The backfill runs on the
  next core open (CLI, MCP server, `memesh serve`); the SessionStart hook opens
  read-only and never migrates.

  Effect on this repo's own graph: session-start injection went from
  `5 recent memories · 1 active lesson` to `10 project + 5 recent memories ·
  12 active lessons`. New instrument: `scripts/audit/measure-injection-tokens.mjs`.

- **`forget` archived the whole memory when the caller mistyped one key.**
  `remember` names the field `observations`; `forget` names it `observation`.
  Zod strips unknown keys by default, and `forget` branches on whether
  `observation` is *present* — absent means "archive the entire entity". So
  `forget({name, observations: "one fact"})`, using the plural that the
  sibling tool uses for the same concept, lost the key, fell through to the
  archive branch, and returned `{"archived": true}`.

  Measured before the fix: the entity's status became `archived` with both
  observations still in it, and it dropped out of recall and out of
  session-start injection. The caller asked to remove one fact and was told
  it had succeeded.

  `ForgetSchema` is now `.strict()`, so the mistyped key is rejected and
  named. Rejecting rather than accepting the plural as an alias: an alias
  would invent API surface, while the rejection tells the caller exactly
  which key was wrong. Reached through both the MCP tool and `POST /v1/forget`
  (the HTTP route shares the schema); the CLI was never affected, because
  commander rejects unknown flags already.

  The other tool schemas still strip unknown keys. That is a real gap —
  `remember` with `titel:` silently drops the title — but it is not
  destructive anywhere else, since a stripped key there still leaves the
  intended write intact. Making them all strict is a behaviour change with
  compatibility risk and is deliberately not bundled here.

### Removed

- **README locales reduced to three.** English, 繁體中文 (`README.zh-TW.md`)
  and Deutsch (`README.de.md`) remain; the other eight locale READMEs
  (zh-CN, ja, ko, es, fr, pt, vi, th) are removed. Eleven hand-synced
  copies of a fast-moving front page drifted faster than they were read —
  the dashboard UI keeps all 11 languages (`dashboard/src/lib/i18n.ts` is
  unaffected).

- **`memesh-view` bin retired.** It was a third, parallel dashboard
  implementation (624-line static HTML snapshot) alongside the live fallback
  (`view-live.ts`, still serving the no-Preact-build case) and the Preact
  dashboard — every dashboard change was potentially a three-place edit, and
  the HTTP server never used it. `memesh serve` is the dashboard;
  `view-live.ts` remains as its no-build fallback.

### Changed

- **Repositioned as agentic memory.** The README (all 11 locales), package
  metadata and UI brand line now describe MeMesh as agentic memory for
  coding agents — captured from the agent's real work, injected when it
  acts, kept honest when it contradicts itself — instead of "LLM memory".
  The LongMemEval-S benchmark moved from the first screen to a Benchmarks
  section after the product comparison; the number itself is unchanged.
  The dashboard/CLI viewer title `MeMesh LLM Memory` is now `MeMesh`.

### Added

- **README recipes.** Three worked walkthroughs where feature lists used to
  carry the weight alone: catching a contradiction with the conflict judge
  (the reviewed-proposal flow end to end), one memory store serving Claude
  Code / Codex / Gemini through MCP, and recording decisions with explicit
  `caused`/`influenced` links. The Conflict Detection blurb now describes
  the shipped pipeline (judge → staged proposal → human accept → recall
  warning) instead of implying it happens by itself.

- **Causal-relation conventions, written where a model can see them.**
  `caused` and `influenced` are documented as the vocabulary for causal
  links (from cause to effect; inert by design — no machine behaviour),
  in both the MCP `remember` schema description and API_REFERENCE, together
  with the principle they exist to carry: MeMesh never infers causality
  from timestamps, embedding distance or co-occurrence — the conflict judge
  proposes contradicts/supersedes/duplicates from meaning, never `caused`.
  Pinned by `relation-types-documented.test.ts` at both reading surfaces,
  so the convention cannot drift out of the schema or the docs separately.

- **Conflict pipeline, second half: the LLM judge.** `memesh dream
  conflicts` spends the LLM on the tightest candidate pairs (default 20 per
  run; the list regenerates with judged pairs excluded, so successive runs
  walk down it) and rules each pair CONTRADICTS / SUPERSEDES / DUPLICATE /
  UNRELATED. UNRELATED is recorded in `conflict_judged_pairs` and never
  re-bought; the other three are staged as `kind='relation'` proposals in
  the same `dream list` / `accept` / `reject` review flow as every other
  machine proposal — accepting one creates the relation (`supersedes`
  honours the judge's named survivor; both endpoints must still be active
  or the apply refuses loudly), and nothing is created, archived or applied
  automatically. An unparseable LLM response is a counted failure, not a
  verdict — a pair is never ruled UNRELATED on evidence that was never
  given. With this, `findConflicts` — which had never once fired, because
  nothing ever created a `contradicts` relation — surfaces machine-found,
  human-approved conflicts at recall time. Verified end-to-end against a
  live Ollama (nomic embeddings + gemma judge): remember two opposing
  decisions → judge stages CONTRADICTS → accept → recall warns. Telemetry
  flow: `conflict_judge`.

- **Conflict pipeline, first half: candidate generation.** `findConflicts`
  has only ever reported pairs someone manually related with `contradicts` —
  and nothing ever created that relation automatically, so in practice it
  always answered empty. `src/core/conflict-candidates.ts` now enumerates
  the pairs WORTH judging: signal-type entities only (episodic auto-capture
  drowned the list — measured: the tightest pairs on a real graph were all
  session-summary × session-summary periodicity), per-entity top-3 vector
  neighbours inside a measured cosine gate (0.35, calibrated by exhaustive
  sweep; on the same real graph the shipped algorithm returns 118 pairs —
  `scripts/audit/measure-conflict-candidates.mjs` reports both the sweep and
  the shipped output so the numbers can be re-derived before changing
  embedders), excluding pairs already related by supersedes/contradicts and
  pairs an earlier judge already ruled on (`conflict_judged_pairs`, keyed by
  sorted entity-id pair — deliberately not the dreamer's drift-prone
  cluster_key). The signal-type list is derived from the dreamer's
  PROTECTED_TYPES rather than hand-copied, the KNN is constrained to signal
  rows (`rowid IN`, so episodic neighbours cannot eat the k slots), and a
  database whose catalogue lists `entities_vec` but whose platform lacks the
  vec0 module gets the honest keyword-only answer ([]) instead of a throw.
  Read-only; the LLM judge that turns candidates into staged CONTRADICTS /
  SUPERSEDES / DUPLICATE proposals for human review is the second half.

### Changed

- **The knowledge graph earns visibility instead of distributing it.** The
  dashboard graph drew every edge at one brightness and named no node until
  hover — uniform emphasis that read as a hairball of anonymous dots. Now a
  backbone of the highest-traffic edges (≤128, ≤5 per node) draws readable
  while the rest recede (deterministically sampled on dense graphs), and it
  is re-picked whenever the view changes, so filtered and ego views keep a
  bright skeleton instead of falling entirely to the faint layer; the
  highest-traffic nodes carry always-on labels under a zoom-tiered budget
  (3/12/28) allocated over the nodes actually in view, drawn at constant
  screen size and stroked against the background so they stay legible over
  other elements at any zoom; node radii sit in a tight 3.5–9px band while
  ranking uses the raw recall counts (the clamped radius ties every hub);
  every connected node gets a rim in its own hue stepped darker, so
  adjacent same-colour nodes read as separate objects (orphans keep their
  dashed boundary); and initial positions are seeded per type on a
  golden-angle spiral, slotted by name order rather than the server's
  recall-ordered response — the same data now draws the same shape on every
  visit, and the simulation starts near equilibrium instead of untangling
  random positions. Informed by a study of graph UIs that read well at
  scale; the ornament they also carry (vignettes, glows, grids) was
  deliberately not adopted, per DESIGN.md.

### Fixed

- **Embeddings are normalized at the single write/query chokepoint.** Every
  distance constant in the codebase (`MAX_VECTOR_DISTANCE`, the scorer's
  similarity mapping, the conflict gate's d²/2 conversion) is derived under
  "embeddings are unit vectors" — an invariant that was documented but never
  enforced. `toVectorBlob` now normalizes both stored and query vectors, so
  a future provider (or Ollama's legacy non-normalizing `/api/embeddings`
  endpoint) cannot silently invalidate the whole distance stack.

## [4.5.1] — 2026-08-13

### Removed

- **The agentic-orchestration experiment, whole.** The opt-in working-model
  protocol (CTO / Orchestrator / Agents framing) shipped in 4.1.0 behind
  `MEMESH_ENABLE_AGENTIC_ORCHESTRATION` and never left opt-in; its
  effectiveness was being instrumented and the instrumentation never
  produced a reason to keep it. Removed: the `agentic-orchestration` skill,
  the session-start banner, the `pre-bash-orchestration-nudge` PreToolUse
  hook, the `enableAgenticOrchestration` config field and its dashboard
  toggle, the env flag, and the local `skill-usage.jsonl` telemetry with
  its `memesh patterns` viewer. The `verify_agent_work` tool goes with it —
  it existed to score the protocol's background agents: the MCP tool, the
  `memesh verify` CLI command, and `POST /v1/verify` (which now answers
  `410 Gone` with a pointer, like every deliberately retired route, rather
  than a silent 404). Existing `verification_record` entities in user
  databases are untouched — they are ordinary entities and remain
  searchable. A leftover `~/.memesh/skill-usage.jsonl` or
  `agent-nudge-flags/` directory is inert and safe to delete by hand.

  The removal's own review round (Claude + Codex, both converging on the
  first two) then closed the residue the deletion alone would have left:
  `memesh install-hooks` now PRUNES memesh entries the manifest no longer
  declares — the merge loop only iterated desired events, so a `<=4.4.x`
  install's Bash-nudge entry survived every re-install pointing at the
  deleted script, and the documented remedy could not heal it. Doctor
  gained `hook-wiring.script-missing` for the same state (nothing runs
  install-hooks automatically on a package upgrade, so doctor is where the
  residue gets caught). `memesh verify` and `memesh patterns` answer with
  retirement signposts instead of Commander's "unknown command" (exit 1, so
  `memesh verify … && deploy` fails loudly), pinned by
  `tests/verify-retired.test.ts` on every surface like consolidate before
  them. `memesh config set enableAgenticOrchestration` no longer reports
  success while writing a key nothing reads. And the doc-claims gate grew
  four checks for the claims this removal proved ungated: README's hook and
  memory-tool counts, ARCHITECTURE's CLI command count, and CODEMAP's
  bare-filename references.

### Added

- **memesh now records that a capture hook RAN, not only that it saved
  something.** Every liveness signal in the product was "a row appeared in the
  last 24 hours", and the healthiest state there is — a hook that ran and found
  nothing worth remembering — produces no row at all. So a quiet Tuesday and a
  capture loop that had been dead for a month were byte-identical in the
  database. `memesh doctor` had one message to cover both, which meant it cried
  wolf on ordinary days *and* stayed silent on the failure it existed to catch;
  the dashboard, reasonably, suppressed it entirely, so the single signal that
  automatic memory might have stopped was the single signal a dashboard user
  could never see.

  A `hook_runs` table (one row per hook, upserted, it does not grow) is now
  stamped by the three hooks that hold a read-write handle — each at its own
  **successful exit**, after capture, never at open. The first draft stamped
  when the database handle became usable, and two independent adversarial
  reviews converged on the same objection: a hook that opens the database and
  then dies in its own capture logic would read as "alive" for a day, which
  is the exact lie this table exists to end, relocated one step later. The
  stamp means precisely "this hook executed to a correct decision": a run
  that correctly decides there is nothing to do stamps too — the dedup bail,
  a light session under the tool-call floor, a non-agentic session, a
  transcript rotated away between Stop and the hook. What does *not* stamp
  is a payload the hook could not attribute (empty stdin, malformed JSON, a
  missing `cwd` or `transcript_path` field — the schema-flip shapes, where a
  heartbeat would mask exactly the capture-is-dead state it exists to
  expose), a failed write, and a run that throws; tests drive hooks into a
  mid-capture crash and a light-session bail to hold both sides.

  Doctor reads the table per hook, and only `session-summary`'s silence is
  allowed to alarm: it fires on every real session's Stop, while
  `post-commit` and `pre-compact` fire only when the user commits or a
  session compacts — a week without commits proves nothing, and treating it
  as death would just relocate the crying wolf. Event-hook staleness
  therefore caps at WARN forever: absence of commits is not evidence of a
  dead hook. A healthy `post-commit` cannot mask a dead `session-summary`
  either: once session-summary has ever stamped, its row owns the verdict.
  Staleness is two-tiered — >24h is a warn (a weekend), >72h is the FAIL
  that banners — and the red itself demands positive evidence: it fires only
  when recent entities carry `source_host: claude-code` provenance, proving
  the agent is in use while its Stop hook is silent. Without that
  corroboration the verdict holds at warn with a hedge, because this
  database is shared across MCP hosts and a user who moved to Codex or
  Gemini stops triggering Claude Code's Stop hook forever — a permanent,
  unfixable red under a flat rule. Two masked states get their own warns:
  commits stamping daily while session-summary has *never* run past three
  days of tracking (`stop-silent` — the Stop hook hiding behind a living
  post-commit), and captures landing with no heartbeat at all
  (`never-ran-legacy` — hooks from a version before tracking are still
  running). A quiet day where the hook ran is a **PASS** that says so. A database that only just gained the
  table is a PASS too — `hook_runs_since` records when we first *could*
  tell, so the upgrade itself does not look like a failure (and a corrupt or
  future-dated marker is restamped rather than granting that grace forever).
  Deliberately disabled capture (`MEMESH_AUTO_CAPTURE=false` or config
  `autoCapture: false`) is a PASS that names the setting, never a failure;
  and "never ran" only reds when hook wiring is actually in place — an
  MCP-only install (Codex / Gemini) gets a quiet corroborating warn, not a
  permanent unfixable red. Timestamps are parsed as the UTC that SQLite
  writes, rolled-over pseudo-dates (`2026-99-99`) are rejected rather than
  normalised into the future, and a future-dated heartbeat reads as
  *unknown*, not *recent* — three hosts share this database, and one wrong
  clock must not hide a dead loop behind a timestamp from tomorrow.

### Fixed

- **A foreign row in `hook_runs` can no longer certify the capture loop
  alive.** The table is user-writable SQLite, and the first fix only
  sanitized unrecognized hook names for display while still counting their
  timestamps as liveness evidence — so one fresh row written by anything
  that is not memesh (a fork sharing the database, a renamed future hook, a
  hand INSERT) turned a dead capture loop permanently green. Four
  independent review passes converged on the same finding. Rows whose name
  is not one of the three literals our hooks stamp are now excluded from
  the verdict entirely: not echoed, not counted, in either direction.

- **One credential-pattern list for the whole codebase, and it is the
  broad one.** Three redactors existed at three strengths: the transcript
  scrubber (broadest), the doctor/feedback egress redactor (seven
  patterns), and a private copy in the LLM client (two). Measured against
  the egress redactor: `github_pat_` fine-grained tokens, Stripe keys,
  JWTs, npm tokens and pasted private keys all reached the pre-filled
  public GitHub issue body unmasked. The shared list (18 patterns) now
  covers all of those plus AWS temporary keys, Google API keys, Slack
  tokens and GitHub app/refresh tokens, and every consumer draws from it.
  The Bearer rule also matches JSON-escaped whitespace, because the
  dashboard egress redacts stringified JSON where a newline is the two
  characters `\n` — a shape the CLI path never produced, so the two
  egresses silently disagreed. `redactSecrets` itself was shipped with
  zero tests; it now has a suite that exercises every pattern plus the
  near-misses that must survive.

- **`memesh doctor` is now a pure reader.** The corrupt-tracking-marker
  self-heal was an UPDATE inside a diagnostic reachable via unauthenticated
  loopback `GET /v1/doctor` — a state change on a GET. The heal moved to
  `ensureHookRunsSince` on the write-path opens, which also closes a hole
  the doctor-side heal left: with heartbeat rows present, the doctor branch
  that healed the marker was unreachable, so a wrong-clock marker silently
  disabled the stop-silent detector forever. Any session, commit, or CLI
  command now restamps a corrupt or future-dated marker; doctor just says
  so.

- **An unreadable transcript no longer stamps the session-summary
  heartbeat.** The transcript parser returned zeros on a permissions or I/O
  failure, which made a LOST capture indistinguishable from a quiet session
  — and the quiet-session bail stamps. Repeated read failures would have
  kept doctor green while every session's capture was lost. The parser now
  flags the failure and the hook exits unstamped, so the loss shows up as
  the silence it is.

- **An unwritable capture target no longer withholds recall.** The
  every-session write probe returned on its warning — before the read-only
  recall connection — so a read-only mount turned "capture is off" into
  "your memory is gone", withholding every existing memory exactly when the
  user needs context to notice something is wrong. The hook now warns and
  keeps reading (and if recall then fails for its own reasons, the warning
  still leads the message instead of being dropped). The probe also checks
  the WAL/SHM sidecars — an interrupted `sudo` run leaves a user-owned
  database next to root-owned sidecars, which the file-level probe alone
  called healthy — and "MeMesh ready" is demoted whenever the warning is
  present, because ready is a promise about capture.

- **"Cannot migrate" no longer means "cannot open".** The general form of
  the read-only regression: any release that adds a table or column makes
  the first open of an older database a write, and a database FILE that is
  read-only (a pre-upgrade backup, a snapshot) died on it — this release's
  `hook_runs` table would have recreated the exact failure the SELECT-first
  helpers fixed, one layer down. Bringing the schema current is now one
  boundary that tolerates exactly the read-only-file error class: the open
  degrades to reads with a stderr trace, and capture and migrations resume
  when the file is writable. Doctor treats a missing `hook_runs` table on
  such an open as "tracking has not started", not a query failure.

- **Assorted verdict-integrity fixes from the same review round.** The >72h
  corroboration query is guarded with `json_valid` (one malformed legacy
  metadata row — which the migration chain deliberately preserves — used to
  throw and turn the whole check into query-failed); the no-corroboration
  hedge is its own code (`hook-activity.stale-unconfirmed`) with entries in
  all 11 locales, because gluing it onto the English summary dropped
  exactly the "this may be fine" sentence in every translation; the
  localized `{hours}` param now rounds up like the English sentence
  (Math.round rendered "ran about 24 hours ago" next to a warn that starts
  at 24h); the legacy-hooks detection window is "since tracking began"
  rather than 24h (a quiet weekend flipped a working legacy install into
  the never-ran red); the never-ran FAIL arms only when a CAPTURE event
  (Stop / PostToolUse / PreCompact) is confirmed wired, not any `_memesh`
  entry (a recall-only wiring is not evidence that capture hooks should be
  executing); env-sourced "capture disabled" gets its own code that says
  doctor can only see its own shell; the tags dedup + unique index run in
  one IMMEDIATE transaction instead of two autocommit statements; and the
  dashboard banner's dismissal signature includes the check code and hook,
  so dismissing one hook-activity warning no longer swallows a different
  one that appears later under the same id:status.

- **Opening the database no longer writes to it when there is nothing to
  write.** Two DML statements lived inside the schema block that every open
  executes — the heartbeat-tracking marker's `INSERT OR IGNORE` (new in this
  release's first draft) and a tags-dedup `DELETE` that had been there since
  the unique-index migration. Even when both were no-ops, SQLite still took
  the WAL writer lock to find that out, so a read-only database file — a
  backup, a snapshot, a permissions accident — failed to open at all
  (`attempt to write a readonly database`), and every reader shared the
  writer's lock contention. Both statements now run outside the schema
  block behind SELECT-first guards: an open that has nothing to migrate
  reads, decides, and touches nothing.

- **`post-commit` now honours `MEMESH_AUTO_CAPTURE=false`.** Its two sibling
  hooks checked the opt-out; this one kept writing commit entities and
  stamping the heartbeat with capture disabled, which also made doctor's
  "capture is off, hook silence is expected" message false. A disabled hook
  now writes nothing — not an entity, not a stamp, not even the database
  file.

- **Diagnostic egress is whitelisted and redacted on every path.** Doctor
  summaries end up verbatim in the pre-filled public GitHub issue that
  `memesh feedback` opens. Hook names read back from the user-writable
  database are now masked to `unknown-hook` unless they are one of the three
  literals our hooks actually stamp, and the CLI feedback path now applies
  the same secret-pattern redaction (API keys, tokens, bearer headers) the
  HTTP transport already applied — the two egresses previously disagreed.
  Timestamp parsing is anchored at both ends as well: a value with a
  timezone suffix was measured hours wrong (the offset silently ignored);
  it now reads as *unknown* instead.

- **A `~/.memesh` that cannot be written no longer reports the session as
  ready, on any run.** The probe for this existed and was measured by hand, but
  it sat inside the "no database yet" branch — so it only ever ran before the
  database existed, which is the one moment the failure is least likely. A
  directory that *became* unwritable later (permissions changed, a read-only
  mount, a botched `sudo`) printed the green count banner on every session
  while every capture hook failed with EACCES. The probe now runs on every
  session and also checks the database file itself, because a writable
  directory holding a read-only database is a state the old mkdir-only check
  called healthy. `tests/hooks/session-start-unwritable.test.ts` pins both
  cases against a real read-only directory; nothing pinned either before.

- **Doctor no longer treats the `source:auto-capture` tag as proof that
  automation is running.** A tag is something anyone can type — the test
  directly above this one in `doctor-honest-pass.test.ts` proves the user can
  write entities by hand, and nothing stopped them writing that tag too.
  Liveness now comes from `hook_runs`, which only a hook writes.

- **`memesh remember --contradicts <name>` and `--supersedes <name>`.** Both
  relation types that change behaviour were statable through MCP and HTTP and
  from neither the terminal nor anywhere else the CLI could reach. That made
  conflict detection structurally dead for a CLI-only user: `findConflicts()`
  runs on every recall, nothing creates a `contradicts` relation
  automatically, and no command could create one — so "no conflicts" was not a
  finding, it was the only possible answer. A relation whose target does not
  exist is reported and exits 1, because the consequence you asked for did not
  happen. `tests/relation-types-documented.test.ts` now fails if either type
  loses its flag or its help text stops explaining the consequence.

### Added

- **Every memory captured through `remember`, `learn` or the capture hooks
  records which host wrote it**, as `metadata.provenance.source_host`. The
  MCP server stamps the client's self-declared `initialize` name (Claude
  Code, Codex CLI and Gemini CLI each send one; a client that declares none —
  or an empty or unprintable one — is recorded as `mcp`, and every name is
  stripped of control characters and capped at 64 characters on the way in),
  the CLI stamps `cli`, the HTTP API stamps `http`, and the capture hooks
  stamp `claude-code` — on first insert only, on every write path, so a
  re-capture or a cross-host re-remember never overwrites what an earlier
  writer recorded. The value is set by the transport and is deliberately NOT
  a tool parameter: a provenance field the model could fill in is not
  provenance — though note it is attribution, not authentication: stdio has
  no identity check, so the name is honest bookkeeping, not a security
  boundary. `import` deliberately does not stamp a host — imported entities
  keep their own `provenance.source: 'import'` marker, and per-host ingest
  attribution is the federation phase's job. Existing entities are
  untouched; with three hosts now sharing one database, "which host wrote
  this" is the field federation (and any future attribution) hangs off.

### Changed

- **A non-git directory's project identity is now `<basename>-<8-hex hash of
  its real path>` instead of the bare basename.** Bare `basename(cwd)` made
  `~/a/notes` and `~/b/notes` one project, and the symptom was the other
  directory's memories appearing in recall — rare with one host, three times
  likelier now that Codex CLI and Gemini CLI share the database with Claude
  Code. The hash is derived from the directory's real path, so every host that
  opens the same directory (through any symlink spelling) derives the same
  identity, and two directories that merely share a name derive two — the
  real path is taken with the OS-native resolver, so on the case-insensitive
  filesystems macOS and Windows default to, `~/Notes` and `~/notes` (one
  directory, two spellings) also derive one identity. Git repositories are
  untouched — their identity still comes from the remote slug or the repo
  root. **One-time effect:** memories captured in a non-git
  directory under the old bare-basename identity stay under that tag. Run
  `memesh kg rename-project` (no flags) from anywhere to list every
  project tag with its entity count, then merge the old tag into the new one
  with `memesh kg rename-project --from <old> --to <new> --apply`. If several
  hosts share the database, upgrade all of them before running the merge — a
  host still on the old version keeps writing the bare-basename tag, and the
  split reappears until it is upgraded and the merge re-run.

- **The supported Node floor is now `>=22.13.0`** (was `>=22.5.0`). `node:sqlite`
  first appeared in 22.5, but behind `--experimental-sqlite`, and the three
  methods memesh needs — `loadExtension`, `enableLoadExtension` and
  `db.function` — all landed in **22.13.0**. Declaring 22.5 would have let npm
  install cleanly onto a runtime where every command, all 7 hooks and the MCP
  server die at startup with `ERR_UNKNOWN_BUILTIN_MODULE`, while `memesh doctor`
  — which derives what it requires from this very field — told the user their
  Node was fine. 22.13.0 is still within the Node 22 LTS line; Node 22 users at
  or above it need do nothing.

- **memesh no longer compiles anything when you install it.** The database
  engine moved from `better-sqlite3` to `node:sqlite`, which is part of Node
  itself. `better-sqlite3` shipped a
  compiled binary built by an `install` script, and that one fact caused a
  family of failures: `npm install --ignore-scripts` never built it, so a
  `/plugin install` — which uses exactly that flag — produced a memesh whose
  hooks loaded, found no binding, and silently did nothing; a Node major
  upgrade left the binary built for the wrong runtime; and unusual platforms
  needed a C/C++ toolchain. None of those can happen to a module that ships
  with the runtime. A clean install now runs **zero** native build steps.

  Everything that existed to nurse that binary is gone with it: the
  `postinstall` rebuild script, the MCP launcher that probed the binding and
  re-executed the process after `npm rebuild`, and the hooks' cached probe with
  its detached background rebuild. `memesh doctor`'s "Native SQLite binding"
  row becomes "SQLite and vector search" and now probes what can still
  genuinely be missing — sqlite-vec, which ships as a prebuilt file per
  platform and, when absent, quietly costs you meaning-based search while
  keyword recall keeps working. The row says that, in all 11 languages,
  instead of telling you to rebuild something that no longer exists.

  Your database is untouched: same file, same schema, same SQLite. No
  migration, no re-embedding, nothing to do.

- **The dreamer groups entries by similarity, not by which calendar week they
  landed in.** A week is not a topic. Two unrelated pieces of work done on the
  same Tuesday went into one digest, and one piece of work spanning a Friday
  and the following Monday was split in half by a bucket boundary running
  through the middle of it. Clusters are now formed from the stored embeddings
  — nearest-first around a running centroid, with the project still a hard
  partition, since two projects are never one narrative whatever the vectors
  say.

  **What that buys, stated no higher than it was measured.** The two clusters
  this produced on the reference graph were read, not assumed. One is 29
  commits that are plainly a single work-stream — a feature's tables, its
  isolation tests, its service, its REST surface, its CI gate. The other is 33
  commits that share a *kind* rather than a subject: assorted `fix(...)` work
  across unrelated modules from the same days. So this separates work-streams
  when a work-stream has its own vocabulary, and otherwise degrades toward
  "same kind of entry, same period". That is still strictly better than the
  week — both of those clusters fall inside ONE ISO week and used to be a
  single bucket — and it is short of topic detection. It is also not a
  correctness risk: the model's contract is ADD-or-NOOP, and a cluster with no
  narrative is what NOOP is for. It costs a call, not a digest.

  The cut-off is `0.55` in `entities_vec` L2 distance, **measured** on a real
  graph (681 entities, 114 compactable candidates with vectors,
  `nomic-embed-text` at 768 dims) rather than picked. Against pairs from
  different projects — which cannot be one narrative, so they measure false
  merges directly — the rate holds at 0.17–0.32% up to 0.55 and then
  multiplies: 0.78% at 0.60, 2.17% at 0.65, 5.70% at 0.70, where the largest
  cluster swelled to 65 entities across two weeks. The full table is on the
  constant. It belongs to that embedder; changing embedders means measuring
  again.

  **A graph with no embeddings still works, and now says so.** The default
  configuration is keyword-only and stores no vectors, so clustering falls back
  to the calendar week — the previous behaviour — and `memesh dream run` prints
  which of the two it used and why, along with a count of any candidates that
  had no vector and were left out. A quiet fallback would have been the
  familiar shape: no error signal, read as success.

  Three consequences worth knowing. `cluster_key` is now a label — the dates
  the cluster spans plus a short digest of its membership — and no longer the
  grouping rule; a pending proposal is matched by the entries it covers, so a
  changed label cannot cause the same cluster to be proposed twice. The prompt
  no longer tells the model the entries share a week, which was an invitation
  to invent the connection. And membership is no longer stable as the graph
  grows: a week bucket never changed once its week ended, whereas one new entry
  can shift a centroid and move a member. Identical membership is still
  de-duplicated exactly; an *overlapping* cluster is not, so a pending proposal
  can end up beside a later one covering most of the same entries. Both are
  staged, neither touches a source entity, and `memesh dream show` shows the
  source ids — but it is a real difference from the old behaviour.

### Fixed

- **`recall` works from Gemini CLI: its MCP payload is now an object envelope,
  never a bare JSON array.** Gemini CLI JSON-parses the first text content item
  of every MCP tool result and assigns the parsed value to the result's
  `structuredContent`, which the MCP SDK requires to be an *object* — so
  `recall`'s bare-array payload failed **every** recall issued from a Gemini
  session with `structuredContent: expected record, received array`, while
  Claude Code and Codex, which don't rewrite the result, read the same payload
  fine. The payload is now `{"entities": [...]}` (plus `conflicts` when any
  are stated), which also removes the old bimodal shape — array normally,
  object when conflicts exist — that every consumer had to special-case. The
  HTTP API's response shape is unchanged.

- **An MCP tool call with `null` in an optional parameter no longer fails.**
  Zod's `.optional()` accepts a missing key but rejects an explicit `null`, so
  a host that serializes blank optionals as `null` got
  `tag: Invalid input: expected string, received null` for a call it meant as
  "no filter" — reproduced with a direct MCP `tools/call`. The MCP boundary
  now drops null-valued properties before validation; no memesh tool uses
  `null` as a sentinel, so a null property can only mean "left blank". A
  `null` *element* inside an array (an observation, a tag) is still rejected —
  that is malformed data, not a blank field — and HTTP and CLI validation are
  unchanged.

- **A redaction root can no longer match in the middle of an unrelated path.**
  `redactUserPaths` anchored the end of a root but not the beginning, so with
  `MEMESH_DIR=/data` the text `/var/lib/data/file` — someone else's path, on
  its way into a **public** GitHub issue — came out as `/var/lib~/file`: a
  corrupted diagnostic with nothing saying redaction did it. A root now has to
  sit at a path boundary on both sides, where "boundary" forbids exactly the
  two shapes that glue a root to the end of another path component — review
  caught that the first cut of this fix forbade more, which had stopped
  redacting real user paths inside `file://` stack-trace frames and on diff
  removed-lines. Ambiguity resolves toward redacting: this is a security
  control, and an over-redacted diagnostic costs less than an account name on
  a public tracker.

- **A dream proposal that would claim nothing is now rejected instead of
  applied.** When every source of a digest proposal had already been
  summarised by another digest — or every source had since been forgotten —
  `apply` still created the digest entity: a summary summarising nothing (or
  a pattern with zero evidence), left active in the graph, with the proposal
  marked `applied` and `sourcesArchived: 0` reported as success. It now
  throws before writing, the transaction rolls back, and the proposal is
  marked `rejected` with a reason that names what actually happened —
  "already summarised", "no longer exist", or both — so later runs stop
  retrying it. If marking it rejected fails too, the error says the proposal
  is **still pending**, instead of promising a rejection that never landed.
  Over HTTP, `POST /v1/dream/proposals/:id/accept` answers this outcome with
  `400 operation.failed` rather than `500 server.internal` — it is the server
  resolving the proposal, not the server breaking, and a generic retry
  against the 500 used to earn a contradictory 404.

- **A stored vector holding `NaN` no longer joins every cluster.** The
  clustering distance check exits early on `sum >= limit²`; `NaN` makes that
  comparison false at every step, so the loop ran to the end and a bare
  `return true` declared the pair a match — one corrupt vector merged with
  everything, and the digest went to the model as if those memories belonged
  together. The check now requires the accumulated distance to be finite.

- **An embedding with a non-finite component is refused at the door.**
  sqlite-vec stores and returns `NaN` without complaint (measured: `[0.1,
  NaN, 0.3]` survives a round trip), and `Float32Array` manufactures one out
  of provider JSON quietly — a `"NaN"` string, a missing slot, a magnitude
  past float64. `embedText` now returns null for such a vector and says why
  on stderr, so the text stays on keyword search instead of poisoning
  clustering and vector search from inside the index.

- **The `import` documentation no longer contradicts itself about `skip` +
  `namespace`.** The parameter table said forcing a namespace "moves entities
  that already exist" unconditionally; thirty lines down, the strategy table
  says `skip` leaves existing entities unchanged — and the code agrees with
  the strategy table. The docs now state the exception and show both
  examples, because "unchanged" includes the namespace.

- **A session on a HOME that cannot be written no longer reports itself ready.**
  `session-start` printed `◉ MeMesh ready · memories will be created as you
  work` on a directory the process has no permission to create. Every capture
  hook for the rest of that session then failed with `EACCES: permission
  denied, mkdir`, silently — the banner was a promise nothing kept. It now
  makes the same `mkdir` call the capture hooks make, and when that fails it
  says so and names `memesh doctor`.

- **A Stop capture is no longer lost to an extension the hook never used.**
  `session-summary` loaded sqlite-vec at startup, and on any platform whose
  prebuilt binary was missing the load threw and took the **whole** capture
  with it — the session's files, commands and errors, gone, with a `Require
  stack:` and two absolute paths on stderr. The hook issues exactly two
  statements (`PRAGMA table_info(entities)` and one `SELECT`) and neither
  touches a vector. The load is deleted rather than guarded: an extension
  nobody calls should not be able to cost a session its memory.

- **A session is no longer filed under whatever directory the hook started in.**
  With no `cwd` in its payload, `session-summary` fell back to `process.cwd()`
  — unspecified for a Stop hook — and tagged the session with a project it had
  nothing to do with. Because that tag gates `session-start` injection and
  `pre-edit-recall`, one project's file names, commands and error text could
  surface inside another's context. The hook now refuses and says which keys it
  did receive, matching what `post-commit` already did.

- **`import --merge <typo>` no longer overwrites.** `serializer.ts` branched on
  `skip` and `append` and let every other value fall through to the most
  destructive option — on the least information. A misspelled strategy reported
  `Imported: 1`, exited 0, and left nothing archived to restore the replaced
  observation from. Unknown strategies are now refused in the serializer, so
  every caller is covered rather than only the CLI.

- **The `import` tool no longer tells an agent "archive" when it deletes.** The
  MCP description of `overwrite` read `archive existing and recreate`;
  the code runs `DELETE FROM observations` and `DELETE FROM tags`, and nothing
  is recoverable. `forget` really does soft-archive, so an agent reading
  "archive" had every reason to expect the same. `API_REFERENCE.md` was correct
  throughout — the string the agent actually read was not.

- **`post-commit` no longer invents commits that never happened.** The hook
  wrote a commit entity from any Bash output containing a commit-shaped line;
  the command that produced it was never consulted. Reading a changelog or
  tailing a build log was enough, and the fabricated commit then surfaced
  through `session-start` and `pre-edit-recall` as fact. Two guards now: the
  command has to be a `git commit`, and the hash has to resolve in that repo.

- **`memesh serve` on a held port no longer prints a URL and exits 0.** The
  listen callback echoed the *requested* host and port whenever the bind had
  failed, dashboard link and all. That branch is gone, replaced by a real
  `'error'` listener that names EADDRINUSE and EACCES.

- **`POST /v1/verify` with a bad `workdir` answers JSON, not a stack trace.** A
  synchronous throw escaped the promise chain and came back as a 500 `text/html`
  page carrying the install path.

- **Flags that accepted anything now name what they accept.** `--namespace`
  exiled memories to a namespace nothing queries; `--severity` wrote an
  undocumented level into the graph as a tag; `export -o` into a missing
  directory and `telemetry --window abc` dumped Node stack traces with absolute
  paths. All validate first and exit 1 — a complaint printed alongside exit 0
  is invisible to a script.

- **`forget` stops sending you the wrong way.** With no matching observation it
  reported that the *entity* was missing, pointing at re-creating a memory that
  was sitting right there; and on a genuinely missing entity it exited 0 while
  `pin` exited 1 for the same case. Both now exit 1 and name the real problem.

- **Transcript mining no longer throws away memories that are not duplicates.**
  The near-duplicate cut-off was `0.55`, derived from a fixture of twenty
  hand-written pairs which put the false-positive boundary at `0.668`. Measured
  against a real knowledge graph instead — 214 entities, including 47
  transcript-mined memories a human had reviewed and accepted — the real
  boundary is `0.446`: `0.55` sat *above* it and would have silently dropped 6
  of those 47, including a pair that is plainly two different facts. Invented
  examples are further apart than real memories, which are formulaic and cluster
  tightly. The cut-off is now `0.44`, taken from the measurement, and the
  calibration script says in its header that a synthetic fixture is not where
  the shipped number comes from.

- **`memesh reindex` no longer rebuilds your vectors from different text than
  everything else writes.** `remember`, the dreamer digest and transcript-accept
  all embed an entity as `name + observations`; `reindex` embedded the
  observations alone. So an entity's vector depended on which path last wrote
  it, and running `reindex` — the command you run precisely when the index is
  in doubt — silently re-based the whole database into the other space, moving
  every distance in it. Both numbers that were measured against that space (the
  transcript dedup threshold, and the published recall figure, which the
  benchmark builds with `name + observations`) then described something the
  runtime no longer computed. There is now one shared builder and all four
  writers call it. Existing rows keep the vector they were last given until the
  next `memesh reindex` rebuilds them; that is a paid call on a cloud embedding
  provider, so nothing re-embeds on its own.

- **`memesh feedback` no longer puts your account name in a public issue.** The
  issue body is composed from `doctor` output, and doctor names paths — the
  database, the config file, where `memesh` resolves on `PATH`. On a normal
  install every one of those starts with the home directory, so a measured run
  carried `/Users/<name>/…` into the pre-filled GitHub issue twice, inside a
  diagnostics block long enough that nobody reads it before submitting. Home
  directories are now written as `~`, which keeps every path just as useful for
  triage. And the body is printed in the terminal before the browser opens:
  GitHub does render it, but below the fold of a form the user opened in order
  to type. `--no-diagnostics` still drops the install ID and the report
  entirely.

- **`memesh doctor` no longer reports "Hooks wired into Claude Code / PASS" on
  an install where nothing is wired.** It accepted the presence of
  `.claude-plugin/plugin.json` as proof that the Claude Code plugin runtime had
  loaded the hooks. That file is listed in `package.json`'s `files`, so it is
  inside the tarball and exists on **every** install — including a plain
  `npm i -g` that has never been connected to anything. The WARN telling you to
  run `memesh install-hooks` was unreachable. It now keys off the install
  channel, which reports `plugin-marketplace` only when the package really sits
  under `~/.claude/plugins/cache/`. The test fixture also gained the
  `.claude-plugin` directory, because a fixture that does not carry what ships
  cannot see this class of bug.

- **`memesh doctor` no longer reports your own typing as evidence that
  automation works.** The "Hook activity (last 24h)" row counted entity
  *types*, and one of them — `lesson_learned` — is what `memesh learn` writes.
  On a brand-new HOME with no `.claude` directory at all, one hand-typed
  `learn` produced `[PASS] auto-capture loop is alive`. The row now counts the
  `source:auto-capture` provenance tag that the capture hooks attach.
  `post-commit` did not attach it and now does, so all four capture paths mark
  what they write the same way.

- **An API key with no provider no longer looks like a working LLM.** `memesh
  config set llm.apiKey sk-…` without `llm.provider` wrote `{ apiKey: … }`,
  and that object is truthy: `memesh status` printed `LLM: undefined
  (undefined)`, search level jumped to Smart Mode, and every LLM-backed feature
  became a silent no-op that still reported success — the provider dispatcher
  fell off the end of its chain and returned an empty string, which the
  failover loop records as a successful call. Three changes: the dispatcher
  throws and names the missing setting, a key without a provider no longer
  counts as a configured LLM, and `config set llm.apiKey` says at that moment
  that nothing will use the key yet. `status` also prints `(default)` rather
  than `(undefined)` for a provider left on its built-in model.

- **`memesh serve --allow-remote` no longer promises a token it does not
  create.** Authentication is keyed to the bind *address*, not to the flag: on
  the default loopback host the flag changes nothing — no token file, no
  bearer requirement, `/v1/entities` answers 200 unauthenticated — while
  `--help` said unconditionally that a token is generated and required for
  every request. The help now states the condition, and a `--allow-remote` that
  had no effect says so at startup, because someone who typed it meant to
  expose the server.

- **Refusing a remote bind is no longer a crash.** `memesh serve --host
  0.0.0.0` without the opt-in produces exactly the right sentence — what was
  refused, and the two ways to allow it — and used to throw it out of an async
  action, so it arrived beneath a ten-frame Node dump carrying three absolute
  install paths. Both entry points (`memesh serve` and `memesh-http`) now print
  the sentence and exit 1.

- **A malformed import bundle is described in its own terms.** An entry with no
  `type` reported `Provided value cannot be bound to SQLite parameter 2` — the
  storage layer's argument numbering, for someone holding a JSON file. Worse, a
  bundle whose `entities` was a string got iterated **character by character**,
  so `"oops"` became four entities named `undefined`. The importer now names
  the entry and the field (`entities[0] has no usable "type"`), refuses a
  bundle with no `entities` array outright, and still imports the good entries
  of a partly-broken one. The check lives in the serializer, so the CLI, MCP
  and HTTP paths all get it.

- **A `namespace` you supply is no longer accepted, ignored and reported as
  success.** `remember` with `namespace: "team"` on a memory that already
  existed left it in `personal` and said it had stored it; `import
  --namespace` did not do the forcing its own documentation promised. A
  namespace was applied on creation only. It now moves an entity that already
  exists — but only when the caller actually supplied one, so a re-remember
  that says nothing about namespace still cannot drag a memory back to the
  `personal` default. Import keeps the same distinction: your `--namespace`
  override applies to everything, while the namespace stored inside a bundle
  only places entities the import creates, so importing cannot relocate a
  memory you already had.

- **`import` and `export` now reject a namespace they do not recognise.** Both
  validated the field as any string up to 50 characters while `remember` and
  `recall` used the enum. On `export` a typo produced a successful **empty
  backup**; on `import` — once an explicit namespace began moving entities that
  already exist — it became a way to relocate memories into a scope nothing
  queries, gone from every scoped view while the import reported them appended.
  All four schemas now share one list with the core, and `importMemories`
  refuses the value itself so every transport inherits the check.

- **`memesh remember` no longer announces a conflict it failed to record.** With
  one good and one bad `--contradicts` target it printed both under `conflicts
  stated:`, two lines above the error saying the second had failed — it asked
  whether *something* succeeded rather than *which*. `remember` now returns the
  relations it actually created and the command reports from those.

- **The dashboard published the account name the CLI had just stopped
  publishing.** `memesh feedback` exists on two surfaces and only the terminal
  one was fixed: the dashboard widget builds the same public GitHub issue body
  from the same `/v1/doctor` route, and stripped nothing. Redaction moved into
  `core/paths.ts` and now runs server-side in that route, so every consumer of
  it is covered at once — the browser cannot do this itself, it does not know
  the server's HOME. It also covers a data directory that `MEMESH_DIR` or
  `MEMESH_DB_PATH` moved outside home, which the first version missed, and
  matches the doubled separators a Windows path picks up when it is JSON
  encoded.

- **A namespace move is no longer silent or one-way.** Moving an existing
  memory between namespaces drops it out of every scoped view it appeared in,
  and it was reported as a plain `stored: true` with no record of where it came
  from — undoable only by someone who independently remembered. The move now
  writes `metadata.previous_namespace` and a timestamp, `remember` returns
  `movedFromNamespace`, and the CLI prints the move with the command to reverse
  it. The MCP schema description no longer reads `(default: "personal")`, which
  was an invitation for an agent to fill the field in and relocate a `team`
  memory it was merely re-remembering.

- **Upgrading no longer stages a duplicate of every pending dream proposal.**
  De-duplication needs an exact source-id match, and a semantic cluster is
  never the exact set its week bucket was — so each pending proposal would have
  gained an overlapping twin, and accepting both ran compaction twice over
  shared entities where the `compacted_into` back-pointer is a plain overwrite.
  The shipped rule is more general than that upgrade, and applies on every
  run: when a digest is written, any pending proposal covering **strictly
  fewer** of the same entries is marked `rejected` with a reason — never
  deleted, so `dream list --status rejected` still shows it. Only when the
  replacement has actually been written, because rejecting is terminal. And
  when a pending proposal OVERLAPS a cluster without either containing the
  other — the usual shape of a week bucket against the clusters carved out of
  it — nothing is decided for you: the run stops before spending an LLM call
  and names the proposal to review.

- **The dreamer no longer loses semantic clustering on a large graph, silently
  and with the wrong explanation.** It loaded vectors with one SQL placeholder
  per candidate; SQLite's ceiling is 32766 (measured), and the failure was
  caught and reported as "sqlite-vec is not loaded" — so the graphs big enough
  to need meaning-based grouping were the ones that lost it, and were sent to
  fix a dependency that was fine. Measured on a seeded 33 000-candidate graph:
  before, `dream run` reported `calendar` mode in 247 ms with "No vector index
  (sqlite-vec is not loaded)" — false, the index held all 33 000 vectors — and
  produced a single ISO-week bucket; after, `semantic` mode, 5 249 clusters,
  17.8 s.

  The lookup is chunked, an unreadable index now reports its real error, and
  the distance loop stops as soon as a pair is out of range — end-to-end
  10.1 s → 3.3 s at 5 000 candidates and 20.7 s → 9.2 s at 10 000, with
  identical cluster counts on both builds, which is the check that matters:
  this is a speed change, not a behaviour change. Those two had to land
  together, because the placeholder limit was what had been capping the
  quadratic work — fixing it alone would have turned a wrong answer into a
  hang.

- **The memory tool refuses to create a memory whose name is taken elsewhere.**
  Names are unique across the whole database, so `create` at
  `/memories/team/x` when `x` already lives under `personal` was never really
  a create: it appended the text to the memory at the OTHER address. Once an
  explicit namespace began moving an existing memory, it would have relocated
  it instead. Both are a silent write to something other than the path you
  named, so it now returns an error — the same refusal `rename` has always
  had.

- **A remembered memory now keeps the signal score it was given.** `remember`
  rebuilt an entity's metadata from a snapshot taken *before* the entity was
  written, which discarded the `signal_score` stamped at creation — so every
  memory written through `remember` carried no score at all. Anything reading
  that field fell back to its default: the dreamer treats a missing score as
  `0.5`, which is inside the `0.2–0.7` band it compacts, so high-signal types
  (`decision`, `architecture`, `lesson_learned`) were compaction candidates
  when they should never have been, and low-signal notes were too. They now
  carry their real score. Verified unchanged for `pin`, `compacted_into`,
  `consolidation_depth` and import provenance.

- **Two documents that described code that does not exist.**
  `API_REFERENCE.md` said "MeMesh does not add an auth layer for you" while a
  non-loopback bind has required a bearer token since 4.2 — generated before
  the listener opens, kept at `~/.memesh/remote-token`, overridable with
  `MEMESH_REMOTE_TOKEN` — none of which was written down outside two error-code
  rows. It also documented a `learn` response (`stored`, `entityId`,
  `observations`, `tags`) that the server has never returned; the real shape is
  `{learned, name, type}`. Both are corrected, and
  `scripts/check-doc-claims.mjs` — which counted hooks, tools and routes but
  checked no response *shape* and no prose claim — now fails when a documented
  response names a field its `*Result` type does not have, and when the
  document denies authentication the server performs.

## [4.5.0] — 2026-08-05

### Added

- **Transcript mining can now run on a schedule (opt-in).** `dream run
  --from-transcripts --if-due` is a scheduler-friendly entry point: it does
  nothing unless the new `transcriptMining` config switch is on (env override
  `MEMESH_TRANSCRIPT_MINING`) *and* at least `--min-interval-hours` (default 24)
  have passed since this project was last mined, so one frequently-firing
  cron/launchd entry self-throttles per project. memesh has no daemon — enabling
  the switch does not run anything by itself; it only authorises that command.
  `memesh doctor` gained an informational "Scheduled transcript mining" row
  reporting whether it is on and, if so, when this project was last mined. Still
  staging-only: nothing enters the graph without `dream accept`.
- **Fallback LLM providers can now be configured from the dashboard.** The
  ordered failover chain (`llmFallbacks`) — the providers memesh tries in
  order when your primary is down — was config-file / CLI only, so most
  users never knew it existed. Settings now has a "Fallback providers"
  section: add entries, pick a provider (Ollama, OpenAI, Anthropic), set a
  model, test each one against the live provider, reorder them (order is the
  failover priority), and remove them. A prominent, always-visible privacy
  note spells out the tradeoff before you add a cloud fallback: when your
  primary is down, memory content — which can be private — is sent to that
  cloud provider, which matters if you run local-only Ollama for privacy.
  Stored API keys are shown masked and are never re-sent: leaving a cloud
  entry's key untouched saves the entry with no key plus an explicit
  `keepKeyFrom` index, and the server refills that exact stored key
  (provider-guarded) — so a reorder, a removal, or a model edit keeps each
  entry its OWN key and a provider change never inherits an unrelated one; a
  freshly typed key rotates it. The per-entry Test button probes that entry's
  own stored key (via `fallbackIndex`), never the primary provider's.

- **`memesh dream run --from-transcripts` now mines the conversation, not
  just the mechanics.** The capture hook and the old transcript parser only
  ever extracted mechanical signals — files edited, bash commands, errors.
  The actually-valuable memory — the decision made, the lesson learned, the
  *why* — lives in the conversational text (your messages + the assistant's
  reasoning) and was mined by nothing. This flag reads a session's JSONL
  directly (no dependence on a capture hook having fired), asks the LLM for
  the durable, high-value memories, and stages them as proposals for
  `memesh dream accept` — nothing enters the knowledge graph automatically.
  It is time-ordered on purpose: a claim stated then reversed later in the
  same session is not recorded as a live fact. Every candidate is
  sanitised, and any candidate carrying a detected secret is dropped, not
  stored. Scoped to the current project only. `--dry-run` lists the
  sessions and their conversation-turn counts without calling an LLM;
  `dream list` labels transcript-sourced proposals distinctly.
- **Transcript mining no longer re-proposes a memory you already accepted.**
  Before staging a transcript-mined candidate, `--from-transcripts` now
  embeds it and checks it against the entities already in your graph using
  the same vector index recall uses — so a candidate that near-duplicates a
  memory you accepted from an earlier run (or remembered by hand) is skipped
  instead of proposed again. The match is scoped to the current project, so
  a candidate from one project is never dropped as a "duplicate" of another
  project's memory. Skips are always reported — `N candidate(s) skipped as
  near-duplicates of existing memories`, each naming the candidate and the
  memory it matched — never a silent drop. The similarity cut-off was
  measured, not guessed (`scripts/calibrate-transcript-dedup.mjs`), and set
  deliberately tight: it reliably catches exact re-runs and clear
  duplicates, and errs toward re-proposing a borderline paraphrase (which
  you reject in one keystroke) rather than silently discarding a genuinely
  new memory. Accepting a transcript proposal now embeds the new entity so
  the next run can recognise it.
- **`memesh dream show <id>` prints a proposal in full before you accept
  it.** `dream list` truncates each proposal's observations so the list stays
  scannable; `show` prints the name, type, *every* observation untruncated,
  the tags and the source — so a secret or a wrong claim hiding past the
  preview is visible before the proposal ever enters the knowledge graph. Add
  `--json` for scripting.
- **Generated memories can now be written in your language.** Every LLM
  prompt in MeMesh is English, so digests, emergent patterns, lessons and
  validator notes came back in English no matter what language the dashboard
  was set to — the Insights tab was permanently English for a Chinese user.
  A new `language` config key (`memesh config set language zh-TW`, or the
  same field on `POST /v1/config`) adds one shared output-language
  instruction to all four content-generating prompts — and changing the
  dashboard language now sets it automatically. Unset keeps today's
  English behaviour, and machine identifiers (entity types, tags, category
  enums) stay English so nothing downstream breaks on a translated value.
- **HTTP errors now carry a stable `errorCode` next to the English
  message.** `{ success: false, error: "<prose>" }` forced clients to
  regex-match English sentences to tell "bad token" from "bad body". Every
  error envelope now includes a documented machine code
  (`auth.missing-bearer`, `validation.bad-body`, `route.retired`,
  `payload.too-large`, `server.internal`, …), and `POST /v1/config/test`
  failures carry `auth` / `network` / `no_models` / `http_<status>` codes.
  The dashboard now translates every known code in all 11 languages
  (falling back to the server prose for codes it does not know yet).
  The prose stays; nothing existing is removed.
- **An empty database now explains itself — everywhere, durably.** The
  onboarding banner can be dismissed permanently, after which the one-click
  demo was undiscoverable: Browse said "try a different filter" over a
  database with nothing behind any filter, and the Graph tab rendered a
  bare black canvas. Whenever the database is empty, Browse, Graph and
  Lessons now render an instructive empty state with the same one-click
  demo seed the banner offers — independent of the banner's dismissal.
  An empty *filter result* keeps its own message; the two are no longer
  conflated. A Lessons tab in a populated database now says how lessons
  come to exist instead of showing a blank category.
- **The Knowledge Graph no longer freezes on large libraries.** The force
  simulation is O(n²) per frame and the server sends every signal entity
  uncapped — a few thousand memories hard-froze the tab. The graph now
  keeps the 1,500 most-recalled (then most-recent) nodes and says
  "showing top N of X" in place of silently dropping or freezing; the
  stats row still reports the real library size.
- **Truncated lists now say they are truncated.** Browse fetches at most
  2,000 rows while the header shows the real count from `/v1/health`; when
  they disagreed the two numbers silently contradicted each other. At the
  fetch limit Browse now shows "showing the first 2,000 of X", and the
  Lessons tab notes its 100-row window next to its stats.
- **Settings shows the configured model, and Test works without
  re-pasting the key.** The Test button required a key in the field even
  though the server already falls back to the stored key when the field is
  omitted — re-testing a saved provider meant fetching the key again from
  a password manager. Test is now enabled with an empty field whenever a
  key is stored for the selected provider. The Capabilities card also
  shows which model is configured, next to the provider.

### Removed

- **The local ONNX embedder (`@huggingface/transformers`,
  `Xenova/all-MiniLM-L6-v2`, 384-dim) is gone.** It was the zero-dependency
  default for *semantic* search, but it and ollama produced
  different-dimension vectors sharing one index, so switching embedders
  corrupted the index. MeMesh now standardises on ollama (nomic-embed-text)
  for local semantic search, with OpenAI as the hosted option. The
  `@huggingface/transformers` optional peer dependency, the `~/.memesh/models`
  download, the `onnx` value of `embedder.provider`, and the
  `MEMESH_MODEL_CACHE_DIR` environment variable are all removed.
  **Keyword search is unchanged.** MeMesh still needs no LLM and no embedder
  to work: with no embedder configured, recall degrades gracefully to FTS5
  keyword search alone — it never crashes, never blocks startup, and never
  pretends semantic search is working. `memesh doctor` reports the
  keyword-only state as informational (not a failure), and probes the
  configured embedder when one is present. **Upgrade is safe:** a config that
  still names `embedder.provider: onnx`, or an existing 384-dim vector table,
  is treated as keyword-only at the same 384-dim width, so no vectors are
  dropped. To get semantic search back, run Ollama and
  `memesh config set embedder.provider ollama` (or configure OpenAI), then
  `memesh reindex --vectors`.

### Fixed

- **No raw exceptions in the dashboard's error surfaces.** A stopped
  server used to surface as the browser's literal "Failed to fetch" in
  Search, Lessons, Insights (expand/accept/reject/dream-run), Settings
  (save/test/behaviour toggles) and the onboarding seed — a string that
  names neither the process nor the fix. Every catch now routes through
  one classifier that says what happened and what to do, in all 11
  languages. And the dashboard now reads the server's error envelope on
  non-2xx responses — the status codes the server actually sends — so the
  stable `errorCode` translations introduced above fire on real errors
  instead of collapsing to "HTTP 500".

- **A non-English dashboard no longer shows hardcoded English.** Every
  server-supplied identifier the dashboard used to print raw is now
  translated in all 11 languages: entity-type badges and graph filters,
  graph edge relation labels, weekday names in Work Patterns (the server
  now sends only the day number — the English day-name column is gone
  from the `/v1/patterns` payload), LLM-telemetry flow and error-class
  labels, lesson severity badges, roadmap phase/entry/view strings, icon
  screen-reader names, tooltips on memory rows, and the Insights tab's
  hand-rolled "3h ago" formatter (replaced by the shared localised one).
  Dates and number grouping follow the chosen dashboard language instead
  of the browser's. New build-failing tests pin every dynamic
  `t(...)`-key family (types, relations, weekdays, flows, error classes,
  severities, radar axes) to the catalogue so none of these can regress
  silently. zh-TW/zh-CN strings that mixed English gratuitously
  (「等你 review」, an untranslated telemetry panel) are now fully
  Chinese. Two screen-reader defects fixed along the way: the onboarding
  error alert no longer contradicts itself (`role="alert"` +
  `aria-live="polite"`), and the pending-insights banner is announced as
  the button it behaves as, not a region.
- **`dream list` no longer invents "(empty)" content.** A digest proposal
  with no observations reported the literal string `(empty)` as its preview
  — untranslatable, and indistinguishable from a digest that genuinely says
  "(empty)". The API now returns `null` and each surface renders its own
  empty state.
- **The dashboard's doctor banner now speaks the user's language — and only
  speaks when something is wrong.** Two reported defects: with the language
  set to Chinese the banner printed raw server English ("No memesh-attributed
  entities…", "agentic-loop guard", "user_interrupt" — jargon no user can act
  on), and a fresh install nagged "no cached npm update check yet" on every
  tab. Every doctor warn/fail variant now carries a stable message code +
  params; the dashboard translates them in all 11 languages (raw English only
  as a fallback for unknown codes, enforced by a build-failing detector), the
  two worst messages were rewritten in plain language at the source, and ten
  "nothing is wrong yet" codes never produce a banner — FAIL and
  action-needed warns still do. `memesh doctor` keeps reporting everything.
- **`memesh serve` fills the npm update-check cache itself.** The doctor
  used to tell users to "run `memesh status` once while online" — a command
  whose only effect a running (hence online) server can produce on its own.
  It now does, in the background, skipping when the cache is fresh.
- **Removed a falsified benchmark figure from the dashboard.** Two i18n
  strings in all 11 locales still claimed "95.40% R@5" — the number release
  4.2.11 disproved. The claim is gone; two untranslated zh strings were also
  translated.

## [4.4.0] — 2026-08-04

### Changed

- **Bare `memesh` prints help instead of starting a server.** Running the
  command with no subcommand used to start the dashboard on a *random* port
  and hang the terminal — the audit's worst first-run moment: a new user
  typing `memesh` to see what the tool does got a stuck prompt, no
  explanation, and a different URL every time. It now does what `git`,
  `npm` and `docker` do: prints the command list and exits. The dashboard
  is `memesh serve` (which prints its URL); every README's quick-start now
  says so.

### Fixed

- **Recall stops presenting geometry's best guess as a match**
  (`src/core/operations.ts`, `Entity.match`, the CLI). A nonsense query
  against a populated database used to return an unrelated entity dressed
  exactly like a hit — and the cutoff cannot fix it: measured on this
  repository's own calibration data, junk queries land at distance
  1.205–1.288 against real stored entities while genuine matches reach p75
  1.269. The distributions overlap; no constant separates them. So recall
  results now carry provenance — `match: { source: 'keyword' | 'semantic',
  relevance }` — and the CLI says **"No keyword matches. Closest memories by
  meaning — may be unrelated:"** with a per-row `~N% semantic` badge when
  the keyword index found nothing. Ranking is untouched: Mode A benchmark
  re-run on the changed tree, R@5 **0.956** and MRR **0.8929**, identical to
  the published figures. Oversized observations are also capped on display
  (500 chars + a count; storage and `--json` untouched) — a 324KB note used
  to flood the terminal on every hit.

- **`memesh remember` dropped positional text in BOTH mixed forms** — the
  flag form (`remember "text" --name x --type y`) reported
  `Stored (0 observations)`: success, with the user's content gone; and the
  quick-capture form (`remember "text" --obs "note"`, no `--name`/`--type`)
  discarded the text while *naming the entity after it*, so the entity
  claimed content it never stored. Positional text is now always an
  observation, which is the only thing those invocations can mean.

- **The model-download notice fired on a warm cache** when
  `MEMESH_MODEL_CACHE_DIR` was set: the cached-check read a different root
  than the pipeline it speaks for. Both now ask `onnxCacheDir()`. A one-time
  message that shows up every time is how it stops being read.

- **The demo knowledge graph now contains a graph** (`src/core/demo.ts`):
  the tour seeded 30 entities and zero relations, so the Graph tab's guided
  tour showed thirty floating dots — a knowledge-graph demo with no edges —
  and the PM panel's orphan rate read 100%. Fifteen typed relations now
  connect the tour's five clusters (auth, storage/recall, billing, API,
  dashboard); orphans drop to nine deliberate ones.

- **Every `pcircle.ai` reference is now `pcircle.com`** — the dashboard
  brand line (11 locales, both view surfaces) shipped earlier today; this
  completes the sweep: README Made-by links in 11 languages, the `homepage`
  fields in package.json / plugin.json / marketplace.json, and the
  security/conduct contact addresses in SECURITY.md, CODE_OF_CONDUCT.md and
  the issue template.


- **The first-use audit: four agents executed every shipped surface of
  v4.3.0** — all 32 CLI leaf commands, all 30 HTTP routes plus the dashboard,
  all 7 hooks, all 8 MCP tools; 152 scenarios, each asked the same three
  questions (does first use get stuck? what does an error show? can the user
  fix it from the message alone?). What follows is what failed those
  questions and how each failure now dies.

- **The 90MB silence**: the first semantic search downloads the local ONNX
  model in the foreground, and it used to do so in TOTAL silence — measured
  13-14 seconds of apparent hang on a fast link, minutes on a slow one, with
  no way to tell a download from a deadlock. One stderr line now says what
  is happening and that it is one-time.

- **A malformed JSON body answered with Express's HTML error page** — full
  stack trace, this machine's absolute paths — served to remote callers
  under `--allow-remote`. Now a 400 JSON like every other /v1 error. A wrong
  `Content-Type` also now names the HEADER as the problem instead of Zod's
  "expected object, received undefined", which sent users off to fix a body
  that was never the issue.

- **`--allow-remote`'s help said "(no auth layer is added)" — the exact
  opposite of the code**, which generates a bearer token and enforces it on
  every /v1 request. `memesh serve` also never mentioned `/dashboard`; both
  startup lines now print it.

- **Three commands let a caller mistake escape as a raw stack trace**:
  `dream accept`/`reject` with a wrong id (the most common slip in the
  review flow) and `verify` with a bad workdir. Each now prints the
  message the throw already carried, plus the next step, with the
  documented exit code (1 / 1 / 2-unverified). `pin` of a nonexistent
  entity also now exits 1 — a protection that silently did not happen was
  invisible to scripts.

- **`dream` was the one surface that ignored environment API keys**:
  `status` and `doctor` count an env `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
  as Smart Mode, but `dream run`/`patterns` read only the config file — the
  same machine said "Smart Mode" and "No LLM configured" in consecutive
  commands. Both gates now use `detectCapabilities()` like everything else,
  and `dream patterns` gained the fix-command hint `dream run` already had.

- **`post-commit` never remembered the first commit of any repository**:
  git prints `[master (root-commit) abc1234]` for a repo's first commit and
  the extraction pattern required branch-then-hash with nothing between —
  a silent, traceless miss. The pattern now tolerates the parenthesised
  note, and a `git show` failure no longer leaks a raw `fatal: not a git
  repository` to stderr.

- **`pre-compact` fabricated a memory out of a non-event**: a payload with
  neither session id nor transcript wrote a junk entity whose only content
  was "Compaction reason: auto", answered "Saved 2 observations to MeMesh"
  — and that junk surfaced in the NEXT session's context as a recent
  memory. Not-an-event now writes nothing and claims nothing. A session
  with a real id but no transcript still records; that contract is pinned
  by its own test.

- **`session-start`'s glitch banner read like a catastrophe** ("Session
  start failed") for what is a skipped context injection; it now says
  memories were not loaded this session and that everything else works.

- **MCP `verify_agent_work` corrections**: `claim.expected_files` reads as
  a file list but is a COUNT — its description now says so (the audit's
  own LLM client tripped on it first try); the mismatch verdict now states
  that only committed changes are counted, because an agent with real but
  uncommitted work used to be told "reality MISMATCH: claimed 2, actual 0"
  with no hint why.

- Re-classified during the audit, recorded so it is not re-flagged:
  `POST /v1/recall {}` returning entities is the documented list-recent
  mode (its test pins it), not a silent failure — the API reference now
  says so where the route is listed.

## [4.3.0] — 2026-08-04

### Added

- **The verification audit is a gate with a baseline, not a report nobody
  reruns** (`scripts/audit/verification-audit.mjs`, wired into
  `verify:release`). One re-runnable detector per "looks verified but isn't"
  defect class, each with a denominator; a detector whose candidate set comes
  out empty **fails** — finding nothing to examine is what a broken detector
  looks like, not what a clean repository looks like. Every current hit sits
  in `baseline.json` with a classification and a one-clause reason from the
  2026-08-04 triage; a NEW hit fails the gate until someone fixes it or
  triages it. The baseline is recorded judgement, not suppression — entries
  whose hit disappears are reported for pruning, and line drift resurfaces an
  entry as new, which re-asks the question rather than silently keeping the
  old answer.

- **Sampled mutation testing lives in the repository**
  (`scripts/audit/mutation-sample.mjs`, no absolute paths). `SAMPLE` and
  `SEED` are parameters and belong next to any reported score, because a
  score without its seed cannot be reproduced. Two operator sets: `classic`
  behaviour flips, and `blank` — the blank-out set that answers "does any
  test notice when this code produces nothing?", which is the detector for
  negative-only tests. Selection under-picks only; survivors re-run against
  the whole suite; unapplied mutations report MISS.

- **Six more numbers in prose are derived, not asserted**
  (`scripts/check-doc-claims.mjs`): README's search-scoring weights against
  `DEFAULT_WEIGHTS`; ARCHITECTURE's session-start ratios against the
  renormalised constants (the gate recomputes them, so changing a weight in
  code fails the doc line); API_REFERENCE's four health-factor weights
  against `computeAnalytics`; README's "8 tabs, 11 languages" against
  `TAB_KEYS` and the `Locale` union; the intent hook's language count in two
  documents against its pattern groups; and ARCHITECTURE's second copy of
  the MCP tool count, which the existing gate only checked in one place.

### Fixed

- **`memesh view` no longer renders a broken database as a healthy empty
  one** (`src/cli/view.ts`): a missing core table (observations / tags /
  relations) used to become "entities with zero observations" with no
  signal. The degrade stays; the silence does not — each missing table is
  named on stderr with a pointer at `memesh doctor`.

- **Two race guards from the failure-display work are now pinned by tests**:
  the telemetry window switch proves a stale response cannot overwrite the
  current window's data (resolve-out-of-order test), and the app-level 401
  listener proves an expired token swaps in the auth prompt no matter which
  tab's request tripped it. Removing either guard fails exactly its own
  test. `BrowseTab`'s reload ticket shares the telemetry guard's mechanism
  and stays read-verified — deterministically interleaving its three
  trigger paths was judged not worth the harness.

- **The local review of this change caught the mutation harness grading its
  own absence** — the deepest cut of the whole hunt: a test runner that
  never ran (timeout kill, missing `npx`) left `status` null/undefined, and
  `?? 1` folded both into "the tests failed", which the callers read as
  KILLED. A misconfigured environment would have reported a perfect 100%
  score. A non-numeric exit status now crashes the run with "the test runner
  produced no verdict"; a non-integer `SAMPLE` or an empty candidate pool
  exits 2 instead of printing `killed=0 survived=0` with a green exit. The
  same review found the C3 detector excluding `scripts/audit/` — thereby
  hiding `mutation-sample.mjs`, an uncalled gate, from the detector built to
  catch uncalled gates. The exclusion is gone, and the harness has a real
  caller (`.github/workflows/mutation-audit.yml`: monthly schedule with
  run-number seeds so each run samples fresh mutants, plus manual dispatch
  defaulting to the published seed). Also from the review: `memesh view`
  warned about three missing tables but early-returned silently past the
  worst one (`entities` — now the loudest); two baseline entries carried a
  reason copy-pasted from different code (re-written); the baseline id
  scheme's no-content-hash trade-off is documented where it lives; and a
  malformed `baseline.json` names itself in the failure instead of surfacing
  as a bare JSON stack trace.

### Fixed

- **Four places where a missing input read as success** — found by the first
  systematic pass of the verification audit (absence-as-success is the `??
  true` family this repository keeps hunting; these are the survivors of
  three earlier hunts):
  - `memesh doctor` printed **"All 0 hook scripts are present and
    executable — pass"** for a hooks.json whose entries carry no `hooks`
    arrays. Every downstream check filters FROM the extracted script set, so
    an empty set satisfied all of them vacuously, and an install whose hooks
    can never fire got an overall PASS. Zero extracted scripts is now a fail.
  - The **Anthropic and OpenAI connection probes answered `valid: true` for a
    200 with no models in it** — what a corporate proxy or auth-portal
    interstitial looks like. "Answered with nothing" was indistinguishable
    from "verified working" in both `memesh doctor --probe` and the
    dashboard's Test button. The Ollama probe has always rejected the empty
    list; the asymmetry was the tell. Both now match it.
  - The Thai FTS-migration test asserted only what the rebuilt index must
    NOT contain — a rebuild that deleted the Thai row and wrote nothing back
    passed both assertions. The rebuild's output is now pinned non-empty
    first.

- **Two documented formulas the code never implemented** (`docs/`): the
  session-start score was documented as "confidence 40% + frequency 30% +
  recency 30%" while the code weights recency ~42% / frequency 30% /
  confidence ~28% (`SESSION_START_WEIGHT_RATIO`, derived from
  `DEFAULT_WEIGHTS`) — confidence and recency swapped, values wrong; and the
  health score's freshness factor was documented as "relative to 5% of
  total" while the code divides by ALL active entities — a 20× difference in
  what earns full marks. Both now state what the code does and name the
  constant they derive from.

- **Two numbers with no measurement behind them, in eleven languages**: the
  READMEs claimed `kg backfill-relations` cuts orphan rate "from 89% to
  under 12%" — neither number appears in any benchmark, test, or artifact in
  the repository — and quoted "~4ms per recall", which traces only to an old
  changelog entry while the benchmark publishes a different metric. A claim
  that cannot be re-measured is deleted, not kept for flavour.

### Removed

- **The multi-model PR review workflow** (`.github/workflows/multi-model-review.yml`)
  — it had never reviewed anything, and it said so on every pull request in a
  form that read like the opposite.

  Both reviewer jobs are guarded by `if: env.ANTHROPIC_API_KEY != ''` and
  `if: env.OPENAI_API_KEY != ''`. Neither secret is set on this repository, so
  each job ran a `Skip notice` step, finished in about five seconds and reported
  **pass**. The third job then posted its summary comment under
  `if: always()`, opening with "Both Claude and Codex reviews above are
  independent" — above being a pull request with no reviews on it. Six such
  comments accumulated on one PR before anyone read the job log.

  So the check could not fail, and its output asserted that a review had
  happened. That is worse than the dead gate this project removed in 4.2.11,
  which at least stayed quiet. The 4.2.11 notes describe this workflow as
  no-opping "cleanly if reviewer secrets are unset"; a tag freezes the file it
  points at, so the correction belongs here rather than there — it did not
  no-op cleanly, it no-opped loudly and inaccurately.

  Review on this project is done locally, against the working tree, by whoever
  is landing the change. Keeping a disabled placeholder for a service nobody
  intends to enable is how the previous one survived. `git revert` restores all
  170 lines if that changes. `codeql.yml`'s comment, which cited this workflow
  as the reason it carries no branch filter, keeps the reasoning and drops the
  reference.

### Added

- **The dashboard now tells the two load failures apart, in every locale**
  (`dashboard/src/lib/failure.ts`, five components, all 11 locales). "Could
  not reach the memesh server — check `memesh serve`, then reload" and "the
  server answered, but this page could not read the reply — reload, then
  `memesh doctor`" are different sentences with different next steps, because
  they are different problems: one collapsed "could not load" message sends
  half its readers chasing a server that is running fine. Every failure
  message renders inside a `role="alert"` element, and the contract suite
  asserts both the wording and the announcement for each component in each
  failure — and that the WRONG diagnosis never shows.

  Two false states died with this: `LlmTelemetryPanel`'s shape rejection left
  data null and error empty — all four render branches false, an empty card
  with no explanation — and `BrowseTab` / `InsightsTab` displayed a rejected
  payload as an empty library / "no insights yet", which is a false empty
  from a response nobody could parse.

  The local review of this change caught its central classification being
  wrong for the most common real failure: every component's `.catch` labelled
  everything "unreachable", but **a 500 comes from a server that answered** —
  running, reachable, and not something "check `memesh serve`" can help with.
  `api()` now throws `NetworkError` for transport-level failures (fetch's
  TypeError, timeouts) and `HttpError` for answered error statuses, and only
  the former reads as unreachable. A mid-session 401 is announced on a window
  event the app listens for, so an expired token swaps in the auth prompt no
  matter which tab's request tripped it — before, it surfaced as one tab's
  "failed to load" forever. The same review found `GraphTab`'s raw-error
  branch was unreachable (deleted), and the telemetry window switch and
  Browse reload had no stale-response ordering guards (added; the guards are
  read-verified but not exercised by a test — interleaving two in-flight
  responses deterministically is not worth the harness it would take).

  Housekeeping from the same pass: `doctorBanner.warnTitle` was an orphaned
  key in all 11 locales (deleted), and in de / vi / es / th the "soft" WARN
  title was byte-identical to the loud one it was meant to soften — those
  four locales silently never had the softer wording (differentiated).

### Fixed

- **`PmAnalyticsPanel` had zero `t()` calls** — every label was an English
  literal, including a hand-rolled `plan{s}` plural. All six strings moved to
  the catalogue in all 11 locales. The test for this cannot be a `toContain`
  in English, because the English catalogue values ARE the old literals: it
  switches to zh-TW and asserts the translation renders and the English does
  not — which also fails if the zh-TW key is ever dropped, since `t()` falls
  back to English on a miss.

- **`telemetry.loading` / `telemetry.empty` were English in both Chinese
  locales** (`dashboard/src/lib/i18n.ts`) — untranslated copies pasted into
  the zh-TW and zh-CN blocks, invisible to every check that only counts keys.

- **`DoctorBanner` told screen readers two urgencies at once**
  (`role="alert"` plus `aria-live="polite"`). `role="alert"` already implies
  an assertive live region; the polite attribute contradicted it. A failed
  doctor check is the thing to hear about before interacting — alert wins.

### Added

- **Two new documentation gates, because a count cannot say what is missing**
  (`scripts/check-doc-claims.mjs`). Every registered `/v1` route must now
  appear in `docs/api/API_REFERENCE.md` — four routes (`/v1/doctor`,
  `/v1/projects`, `/v1/demo/seed`, `/v1/demo/reset`) were registered, called
  by the dashboard on every load, and documented nowhere, while the existing
  endpoint-count check happily agreed that 32 equals 32. And no README may
  mention Python at all: four translations still offered "the Python SDK"
  months after the SDK was deleted, each in different words, which is why the
  gate scans a term and not a phrase. All four routes are documented and all
  four lines are gone.

- **A CLI hint has to name a command that exists**
  (`tests/cli-hints-name-real-commands.test.ts`). The telemetry empty-state
  hint told users to run `memesh consolidate` for a release after that
  command was retired — its only remaining behaviour is printing that it no
  longer exists — and the first draft of the fix pointed at `memesh
  auto-tag`, which has never existed. Every backticked `memesh <cmd>` in CLI
  output is now cross-checked against the command registry and the retired
  set, in the same shape as the route test.

- **The coverage floor is a gate with a caller** (`vitest.config.ts`,
  `.github/workflows/ci.yml`). `npm run test:coverage` had zero automated
  callers and no thresholds — an installed provider that nothing would ever
  fail. It now enforces floors (statements 52, branches 48, functions 55,
  lines 54; measured 54.59 / 50.2 / 57.89 / 56.09 on the day they were set) and
  runs as its own CI leg. The ratchet turns one way: raise a floor when the
  suite clears it, never lower one to make a run green.

### Fixed

- **The retired-route set is data the server registers from, not a regex over
  its own source** (`src/transports/http/retired-routes.ts`). The route test
  re-derived "which routes answer 410" by scanning server.ts through a
  400-character window between the path literal and `status(410)` — an input
  set pinned to nothing but formatting. Both the server's 410 handler and the
  test now read one exported constant, and the test additionally requires
  every retired route to still be registered, because a deleted registration
  is a silent 404 wearing a documented retirement.

- **The route test now scans every in-repo client, and proves each one
  contributes** (`tests/http-clients-call-real-routes.test.ts`).
  `src/cli/view-live.ts` calls nine `/v1` paths and was scanned by nothing;
  `scripts/dashboard-e2e-smoke.mjs`'s only call begins right after a template
  interpolation (`${port}/v1/health`), which the quote-anchored extraction
  regex could not see — the file matched zero call sites while looking
  covered. Each client root must now contribute a known call, so a root that
  stops matching is a failure instead of a silently narrower gate.

- **ci.yml's Doctor step reads the exit code, not a grep**
  (`.github/workflows/ci.yml`). `OUTPUT=$( … || true)` discarded doctor's
  verdict to survive `set -e`, leaving two greps as the only gate — and a
  grep matches only the failure formats it was written against. The CLI exits
  1 exactly on FAIL and 0 on PASS_WITH_CONCERNS, which is precisely the
  acceptance rule the step's comment described in prose.

- **Three checks re-derived a fact a real module owns, and drifted**: the
  hook-count rule is now `scripts/lib/hook-files.mjs` and its test runs it
  against a fixture directory shaped like the `_generated` incident instead
  of regexing the gate's source; `release-verify.sh` labelled its typecheck
  gate `tsc --noEmit`, which is not what `npm run typecheck` runs; and the
  learn→recall integration test computed its expected project name as
  `basename(cwd)` while the code asks git — it passed only when the checkout
  directory happened to be named like the remote, and running the suite from
  a worktree named anything else turned it red.

- **Dev-dependency advisories cleared without changing bundlers**
  (`package.json`). `npm audit fix` "resolved" the high-severity vite
  advisory by jumping to vite 8 — a different bundler (rolldown) that broke
  the suite. vite is pinned to 7.3.6 via overrides instead (the advisory's
  fix version, 7.3.4, was never published; 7.3.5 is the real floor), and
  `@babel/core` / `esbuild` moved within semver. `npm audit`: 0
  vulnerabilities. The override covers the ROOT install tree only — npm
  applies `overrides` at the install root, and the dashboard is a separate
  install with its own lockfile (`scripts/check-consumer-audit.mjs`'s header
  documents this same trap). The dashboard's own vite resolves to 6.4.2,
  which is the patched release of its line, and its declared floor is raised
  to `^6.4.2` so a regenerated lockfile cannot float below it.

### Added

- **The dashboard components are held to one contract**
  (`tests/dashboard/component-contracts.test.tsx`) — most of them had no test of
  their own. This is deliberately not a set of "renders without throwing" tests,
  which cannot fail for any reason a user would notice. It asserts the class of
  bug that actually reaches a dashboard user: **on degenerate data a component
  may render an empty state, but it may not render the machinery, drop half the
  page, or reject into nowhere.** No `undefined`, `NaN` or `[object Object]` in
  visible text — the shape an unguarded `toFixed()`, a missing field or a
  stringified object takes on screen — and no raw i18n **key**, which is not
  hypothetical: the auth screen shipped `auth.title` to a remote operator,
  because `t()` returns its argument on a miss.

  Each component is exercised against five API shapes: empty-but-successful, a
  failure, half a payload, every group present but hollow, and the core valid
  with the optional extras hollow. Which components are covered is **derived
  from the directory listing**, and one that is neither in the case list nor in
  a named exclusion list fails the suite — an earlier version of this file
  stated in its own header that the components with dedicated test files were
  "covered here too" when they were exactly the ones missing, which is what a
  hand-maintained list is for.

  Three detectors, because one defect shape slips past each of the others: a
  text leak that never throws (`GraphTab` was a live instance), an unhandled
  rejection that renders no text, and a render error that does neither — the
  last produces no rejection and no visible output, so four panels simply
  vanish. Four canary components assert the harness's own ability to fail: one
  per detector, and a fourth whose leak arrives through the stubbed `fetch` two
  responses deep — measured, that one is the single assertion in the file that
  notices when the settling machinery is removed, so the machinery is no longer
  something only a comment says is needed. If the harness ever stops settling
  before it asserts, the canaries stop being caught and the file goes red on
  itself.

  The shape guards themselves are exported and tested **leaf by leaf**: for
  every field a guard requires, a payload missing only that field must be
  rejected. A component-level stub cannot do this — a stub missing three fields
  is rejected by whichever checks remain, so deleting any single check from a
  guard still left the whole file green, and the stats row's guard was the live
  instance: it checked two of the five fields the row reads.

- **The dashboard and every `.tsx` test are type-checked, for the first time**
  (`tsconfig.check-dashboard.json`, `tests/typecheck-scope.test.ts`) — a second
  project rather than a wider `include`, because the two halves of this
  repository resolve modules differently and cannot share one pass: the package
  is `node16`, the dashboard is bundled by vite and imports
  `./components/Header` without an extension. Measured, that one disagreement
  produces 93 errors before any real type is looked at. `npm run build:dashboard`
  is vite, which transpiles without checking, so nothing had ever run `tsc` over
  `dashboard/src`. It found a test helper annotated `container: HTMLElement`
  against a value typed `Element`.

  Two projects means a file can fall between them, and one did: the package
  project takes `tests/**/*.ts` and excludes `tests/dashboard/**`, the dashboard
  project took `tests/dashboard/**` — so a `.tsx` test in any third directory
  was checked by **neither** while vitest ran it. Measured with a deliberate
  `const broken: number = "string"` planted under `tests/transports/`: both
  passes exited 0. `tests/typecheck-scope.test.ts` closes it by asking `tsc
  --listFilesOnly` which files it actually read and comparing that to the files
  vitest collects — not by comparing one list of globs to another, which is how
  a check turns into a copy of the thing it checks. It failed on its first run
  and found a second hole the widening had just opened.

  The dashboard project now `extends` `dashboard/tsconfig.json` instead of
  copying its nine compiler options. The copy carried a stated reason —
  "extending would inherit an include the tests are not in" — that is simply not
  how tsconfig works: a derived `include` replaces the base's. The copy had also
  already dropped `isolatedModules`.

  The list of suffixes the scope test collects test files by was itself a
  hand-copy of `vitest.config.ts`'s `include` — correct on the day it was
  written, a mirror from then on, which is the same defect the test exists to
  catch in tsconfig. It is now derived from the config at run time, and the
  derivation is asserted non-empty, because a detector whose input set came out
  empty is a broken detector reporting a clean result.

### Fixed

- **Eight dashboard tabs crashed on a response whose shape did not match**
  (`AnalyticsTab`, `BrowseTab`, `DoctorBanner`, `GraphTab`, `InsightsTab`,
  `LlmTelemetryPanel`, `PmAnalyticsPanel`, and the patterns row) — found by the
  contract above, and every one is the same root cause: **the guard asked
  whether an object arrived, not whether the data did.** `{}` is truthy, so
  `data || []`, `data ?? []` and `if (!data) return null` all passed a
  shape-less response straight through to a `for…of`, a `.filter` or a `.length`
  that then threw — `entities is not iterable`,
  `allProposals.filter is not a function`,
  `Cannot read properties of undefined (reading 'orphanRate')`.

  That is the `?? true` family one more time: absence read as presence. It took
  three passes to land, because each round tightened the guard by exactly one
  level and the read was always one level further down: first `!data`, then the
  groups (`data.velocity && data.staleness`), and only then the leaves the
  render actually dereferences. A group check is worth nothing here — `{}`
  satisfies it, and then `HealthScore` reads `factors.activity.score` off
  `undefined`. Each guard now checks the leaf.

  Two of the eight were invisible to a test that only looks at rendered text.
  `GraphTab` catches its own TypeError and paints the raw JS message on screen,
  so it produced no unhandled rejection at all; the analytics rows throw during
  the rerender the response triggers, which produces no rejection **and** no
  text — four panels just disappear. Both are covered now.

  What `{success: true, data: {}}` is **not** is what a fresh install returns:
  `computeAnalytics` and `computePmAnalytics` return every key unconditionally,
  so a brand-new database yields `healthScore: 0` and `summaries: []`, which
  pass every guard. The reachable causes are a stale cached bundle, a proxy
  rewriting the body, and a future partial-failure path. The previous wording
  here claimed otherwise.

  There is no error boundary anywhere in `dashboard/src`, so before this the
  user-visible result of each of these was a blank page, not a broken panel.

  A rejected shape is also no longer silent. The request **succeeded**, so no
  error path will ever log it — the panel just never appears. Each guard now
  says so on the console, and says which of the two failures it is: the server
  answered, but with a shape this bundle cannot render — a stale bundle or
  version skew, not an outage. The user-facing half of that distinction (two
  different messages with two different next steps) is queued behind this
  change, not part of it.

- **`SettingsTab` was the ninth tab, and the last one outside the contract**
  (`dashboard/src/components/SettingsTab.tsx`) — it was excluded with a written
  reason ("has unguarded reads") rather than silently, which is the one thing
  that went right; the reads are now guarded and the exclusion is gone. Three
  defects, two of them the same shapes as the other eight tabs: the
  `/v1/config` chain had a `.finally` and **no `.catch`**, so a server that was
  simply down became an unhandled rejection; and the behaviour card read
  `config?.config.autoUpdate` — the optional chain guards `config`, the read is
  one level further down, on `.config`, and `{}` lands exactly between them.

  The third was new: a **false green**. The update summary *branches* on
  `checkSucceeded` / `freshness` / `updateAvailable`, and a hollow
  `update-status` payload crashes nothing — it falls through every branch and
  lands on **"Up to date"**, from a response that said nothing at all. The
  guard for it requires the fields the summary branches on (version strings
  degrade to '—' harmlessly and are deliberately not required), and the
  contract pins the call site: on a payload with none of those fields, the tab
  must say it **can't check**, visibly.

  One more assertion exists because a break-test proved everything else blind
  to it: bypassing the config shape guard entirely left all 157 other tests
  green — the read throws, the new network `.catch` absorbs it, and the tab
  degrades identically while the console blames an outage that never happened.
  The two failures carry different next steps for the user, so the diagnosis
  itself is now under test.

- **`npm run typecheck` had never checked a single test file, and 68 real errors
  were waiting behind that** (`tsconfig.check.json`, 9 test files) —
  **this corrects a claim made in the previous entry's own release notes.** The
  commit that added `tsconfig.check.json` reported "exactly one error appeared
  across `src/` + `tests/` + config". That measurement was wrong: the new config
  extended `tsconfig.json` without declaring its own `exclude`, and the base
  carries `**/*.test.ts`. Every test in the repository was still being skipped,
  so the one error found was in `vitest.config.ts` alone.

  With the exclusion lifted, the errors were not cosmetic:

  - **32 `detectCapabilities` stubs in `doctor.test.ts` returned objects missing
    four of `Capabilities`' required fields.** They stood in for an interface
    they did not implement, and would have stopped standing in for it the moment
    `doctor` read one of the missing fields.
  - **22 of those stubs claimed `embeddings: 'disabled'` — a value the type does
    not permit, that appears nowhere in `src/`, and that no code path produces
    or reads.** The state they meant is `'tfidf'`, which is what a default
    install actually reports now that the local ONNX runtime is an optional
    peer. The helper that accepted it was typed `embeddings: string`; it is
    typed `Capabilities['embeddings']` now, so the next impossible value cannot
    be passed.
  - **20 SQLite rows were read as `unknown`** in the hook tests. `better-sqlite3`
    types `.get()`/`.all()` that way correctly — it cannot know an arbitrary
    query's shape — so a test reading columns has to declare which ones. Before
    this, `entity.typo` would have compiled.
  - Stubs for `existsSync` and `statSync` were typed narrower than the functions
    they replace, and four `execFile` stubs were asserted onto an overloaded
    signature in one step.

  All 68 are fixed and `npm run typecheck` now covers `src/`, every test, and
  the root config files, in two projects.

### Added

- **Coverage can be measured for the first time, and `npm run typecheck` now
  covers the files that configure the build** (`vitest.config.ts`,
  `tsconfig.check.json`, `package.json`) — two settings that looked like
  configuration and were not.

  `vitest.config.ts` had a `coverage` block labelled "(if needed)" and
  `@vitest/coverage-v8` was never installed, so `vitest --coverage` answered
  `MISSING DEPENDENCY`. Nobody could see which modules a test had ever touched.
  The provider is installed and pinned exactly, and `npm run test:coverage`
  runs the suite against a throwaway `HOME` like the normal runner does.

  Installing it was not enough. With no `coverage.include`, v8 reports only the
  files a test **imported** — a module nothing touches is not 0%, it is absent.
  Several files under `src/` were missing from the first report entirely, among
  them `cli/view-live.ts` and `mcp/launcher.ts`, the entry point every MCP
  client executes, and the headline percentage was correspondingly flattering.
  A coverage report that cannot show a zero is a gate that cannot fail. With the
  source globs declared it can.

  No percentage is quoted here on purpose. The one that used to be was measured
  before the dashboard tests landed in the same pull request and was already
  wrong by the time it would have been published — which is the failure this
  release set out to stop. Run `npm run test:coverage` and read the number the
  runner prints.

  Read it with one caveat, recorded in `CLAUDE.md` rather than left as a trap:
  coverage is in-process, and this project spawns much of what it tests. The
  CLI, the hooks and the MCP server are exercised through `spawnSync` and
  therefore report 0% while being well covered. The number is useful in the
  other direction: a 0% file that is *not* spawned anywhere is genuinely
  unexercised, which is where most of the dashboard sits.

### Fixed

- **Three Vitest options that do not exist were silently configuring nothing**
  (`vitest.config.ts`) — `singleFork: true`, `maxForks: 1` and `minForks: 1` sat
  at the top level of `test:`. None of the three is part of Vitest 4's config
  type; `poolOptions` is gone too. Only `fileParallelism: false` was doing any
  work, and it happens to be the half that matters — several test files share
  one `HOME` and therefore one SQLite database, and running them concurrently
  deadlocks on the write lock. So the property held, by luck, through three keys
  that described it and did nothing. Replaced with `maxWorkers: 1`; suite
  duration is unchanged at ~38s, which is the measurement confirming the removed
  keys were inert.

  The root cause is why nothing caught it: **`npm run typecheck` had never read
  the file.** `tsconfig.json`'s `include` is `src/**/*.ts`, correct for the
  config that emits `dist/` and wrong for a check, so `vitest.config.ts`,
  `tests/` and the root config files were outside every type check the project
  ran. `tsconfig.check.json` widens the scope for checking only, and
  `npm run typecheck` points at it. Measured when it was added: exactly **one**
  error appeared across `src/` + `tests/` + config — this one.

A git tag freezes the file it points at, so the 4.2.11 notes cannot be corrected
where they were published. They are corrected here, and whichever release ships
next carries the corrected copy.

### Added

- **`main` can no longer declare a version nobody can install**
  (`scripts/lib/published-version.mjs`, `scripts/check-version-coherence.mjs`,
  `.github/workflows/ci.yml`) — the gate above this one asks whether the seven
  version anchors agree with each other. They agreed with each other throughout
  the five days `main` said `4.2.11` and npm's `latest` said `4.2.10`; agreement
  says nothing about whether the version they agree on was ever released.

  On `main`, `package.json`'s version must now have a matching `v<version>` tag.
  The rule it enforces is that **a version bump never rides in a feature or docs
  pull request**: `main` carries the last published version, work accumulates
  under `[Unreleased]`, and a release bumps, tags and publishes in one sitting —
  so the window this check is red for is minutes rather than days.

  A release branch and a pull-request ref are skipped, since both legitimately
  carry the bump before the tag exists. **An empty tag list fails rather than
  passes**: `actions/checkout` fetches no tags by default — measured, `git clone
  --depth 1` brings down 0 of this repository's 65 `v*` tags — and "found no
  mismatch among zero tags" would have made the check unable to fail, which is
  the shape of the two dead gates 4.2.11 removed. The checkout now fetches full
  history (0.83s, against a 13-minute matrix leg).

  Pinned in both directions by `tests/main-declares-published-version.test.ts`,
  and break-tested: making the empty-tag-list branch return success kills 2 of
  the 7 cases, and making the missing-tag branch return success kills 1.

- **The documentation gate now runs, and its checks can now fail**
  (`scripts/check-doc-claims.mjs`, replacing `scripts/verify-docs-sync.sh`) —
  the shell version had six checks, 150 lines, and **no caller**: not CI, not
  `verify:release`, not `release-verify.sh`, not a `package.json` script. Its
  only references were a line in `CLAUDE.md` telling an assistant to run it by
  hand and a manual review skill. A gate that never runs cannot fail, which is
  the same defect as a gate that cannot fail when it runs — and this is the
  fifth of those found since 4.2.11. It is wired into `verify:release`, the one
  list both CI and the publish path execute, and ported to Node because that
  list runs on `windows-latest`.

  Three of the six could not fail and were rebuilt rather than carried over.
  The hook check compared a file count to the literal `7` while separately
  counting hook mentions in `ARCHITECTURE.md` and comparing that to **nothing**;
  both halves now derive from `hooks/hooks.json`, the manifest that invokes
  them. The skills check counted every four-column table row in `SKILL.md` and
  required "7 or more" — it reported 9 against a table whose rows are not all
  hooks; it now counts the rows of the hook table and compares them to the
  manifest. The lint check printed `WARN` without incrementing the error count,
  so a failing lint passed the gate; `verify:release` hard-gates lint two steps
  earlier and the weaker copy is gone.

  Three checks are new, one per drift this release found: the **HTTP endpoint
  count** — `ARCHITECTURE.md` said "~32 endpoints" in one paragraph and "17" in
  another, fifteen apart, in the same file; **no README may state a hardcoded
  test count** — all eleven said "630 tests" against a suite past 1,400, and the
  fix is to stop writing the number down rather than to check eleven copies of
  it; and **no living document may point at a path that is not in the
  repository**, which is what catches a deletion leaving a dangling pointer
  behind.

  Every check is break-tested, and two of them found bugs in the gate itself
  that way. The path check measured `fs.existsSync`, so a deleted directory that
  still held untracked `__pycache__` answered "exists" and the mutation passed —
  it reads `git ls-files` now, because the question is whether a path survives a
  clone. And the gate read one file that is not in the repository at all, which
  is an `ENOENT` crash on every CI leg and is invisible in any working tree that
  has ever had the file; it now reads only what git tracks. Both were found by
  running the gate against a fresh clone rather than against this one.

- **In-repo clients of the HTTP API are checked against the real route list**
  (`tests/http-clients-call-real-routes.test.ts`) — every `/v1/...` path a
  client calls must be a route the server registers, and must not be one that
  answers `410 Gone`. Reaching a retired route is worse than a 404 from the
  caller's side: the call compiles and the request succeeds, and only the body
  says the feature is gone. Break-tested against both cases.

### Removed

- **The Python SDK** (`packages/python-sdk/`, and the section of
  `docs/api/API_REFERENCE.md` that told you to `pip install memesh`) — that
  package does not exist. PyPI answers **404** for the name, no workflow ever
  built it, and no CI job ever ran its 31 lines of tests. It covered 7 of the 32
  HTTP endpoints, its version read `3.0.0b1`, and `client.py` still posted to
  `POST /v1/consolidate`, which has answered `410 Gone` since 4.2.11 — while its
  own README already said that method was retired. A published install
  instruction for an unpublished package is a promise this project was not
  keeping, and repairing it would have meant committing to maintain a second
  client of a surface nobody could install. The HTTP API is documented; call it
  with what your language already has.

### Fixed

- **Three advisories the repository's own tree was carrying**
  (`package-lock.json`) — `npm audit --omit=dev` reported 2 high and 1 moderate
  while `npm run audit:prod`, the gate that decides shippability, reported
  clean. Both were right: the tarball does not ship the lockfile, so a consumer
  resolves the `^` ranges to patched versions while the repo and every CI leg
  run what the lockfile pins. Users were never exposed; contributors and CI
  were, and `ip-address` sits under the HTTP rate limiter — the one place in
  this tree that makes a trust decision about an address. `ip-address` 10.2.0 →
  10.4.0, `fast-uri` 3.1.4 → 3.1.5, `hono` 4.12.32 → 4.13.0, all inside the
  existing ranges, so `package.json` is untouched.

- **The 4.2.11 notes opened by denying their own release.** They said "4.2.11
  was never published", which was true when the sentence was written — the
  version had been bumped and no tag pushed — and false a few hours later, when
  `v4.2.11` was tagged, released and published to npm as `latest`. Nothing
  removed it before publishing.

- **They gave two different sizes for the MCP surface.** One entry said nine
  tools; the summary and the `consolidate` entry said eight. Eight is correct —
  `consolidate` was retired in 4.2.11.

- **They described CI as running on `main`/`develop`** in the same section that
  records `develop` being deleted.

- **The sample update-check response still showed 4.2.8 / 4.2.9**
  (`docs/api/API_REFERENCE.md`).

### Changed

- **The 4.2.11 notes are roughly half their previous length.** They had grown
  into an account of how the work was done — which review found what, which
  internal gates were re-broken to test them — rather than what changed for
  someone using MeMesh. What a reader acts on is kept in full: the breaking
  changes, the one-time index rebuild on first open, the benchmark retraction
  and correction, the fixes that stop embeddings being deleted, and the security
  fixes stated as what changed.

## [4.2.11] — 2026-08-03

This release exists because the headline benchmark figure was measuring the wrong
code. `benchmarks/longmemeval/run.mjs` carried its own table creation, its own
FTS5 query building and its own ranking, so the published **95.40% R@5** scored
that reimplementation and not the product. Measured through the function a real
`recall` call actually reaches, the same 500 questions scored **5.20%**, with 473
of them returning nothing at all. Four compounding retrieval defects were each
hiding the others.

They are fixed, the benchmark now runs through the shipped path, and every
published claim that no longer matched the code has been corrected against
source. The number is **95.60%**, and it is the product's number.

**Breaking changes when upgrading from 4.2.10:**

- **`consolidate` is gone** — the MCP tool, `POST /v1/consolidate` and
  `memesh consolidate`. The endpoint answers `410 Gone` and the CLI prints where
  to go; the MCP surface is **8** tools now. See **Removed**.
- **Node 20 is no longer supported.** `engines.node` is `>=22.5.0`.

Upgrading rebuilds the full-text index once, on first open, to add CJK
segmentation. Existing memories are re-indexed from the entity and observation
rows, which are never touched — nothing is deleted and nothing needs re-entering.

### Added

- **Anthropic memory tool (`memory_20250818`) backed by the knowledge graph**
  (`src/core/memory-tool.ts`, exported from the package root) — for applications
  that call the **Messages API directly** rather than through MCP. Claude gets a
  memory tool whose storage is MeMesh instead of a folder of text files, so it
  also gets FTS5 search, multi-factor ranking, auto-decay, relations and
  namespaces without knowing they are there. Not a ninth MCP tool, and not on the
  HTTP or CLI surface.

  Each entity renders as one file whose lines are its observations, **ordered by
  observation id — insertion order, never score.** `view` and the edit that
  follows it are separate turns, and a hook can write in between; if the order
  came from a ranking, the line numbers the model read would address different
  content by the time it sent them back. Two behaviours differ from a filesystem
  on purpose: `delete` **archives**, because a model asked for it and not the
  person whose memory it is, and `str_replace` **refuses an ambiguous `old_str`**
  and returns every match's line number rather than editing the first. Writes are
  bounded to 256 KB per memory and 16 000 characters per `view`, and paths are
  validated before they resolve — `..`, encoded traversal, backslashes, NUL
  bytes, unknown namespaces and anything outside `/memories` are refused.

- **`memesh doctor` reports the runtime it is running on** (`src/core/doctor.ts`)
  — Node version, ABI, platform/arch, whether that version satisfies
  `engines.node`, and whether `node:sqlite` is present. Below the supported floor
  the row fails with an upgrade instruction; previously a user below it saw hooks
  misbehaving and a red native-binding row with nothing naming the one fact that
  explains both. Anything the version comparison cannot parse is reported as
  "not checked" rather than guessed at.

- **`memesh reindex --fts` rebuilds the keyword index on demand**, and
  `memesh doctor` reports when you need it. The segmentation marker only moves
  forward, so it cannot describe a database migrated by a newer build and then
  written to by an older one — reachable by a downgrade, or by an npm-global and
  a plugin-marketplace install side by side. That state was silent by
  construction: every health signal stayed green while the affected memories were
  unfindable by any partial-phrase query.

- **`memesh reindex --vectors`** drops and recreates the vector table at the
  configured dimension and immediately refills it — the supported way to switch
  embedding provider. It refuses when no provider can actually produce a vector,
  and refuses `--namespace` alongside it, because `entities_vec` is one table for
  the whole database and the rebuild would drop every namespace's embeddings
  while refilling only one.

### Changed

- **The supported Node floor is `>=22.5.0`** (`package.json`,
  `.github/workflows/*.yml`, all 11 `README*.md` badges, `CONTRIBUTING.md`) —
  **nothing was broken on Node 20.** It reached end of life on 2026-03-24, so the
  package was promising a runtime that receives no security patches. `22.5.0`
  rather than `22.0.0` because that is the release where `node:sqlite` became
  available. CI now runs 22 and 24 on three operating systems, plus 26 on Linux;
  a test fails the build if any workflow pins a Node below `engines.node`, or if
  no job runs the declared floor.

  Node 26 is Linux-only because `better-sqlite3@12.9.0` publishes no prebuilt
  binary for its ABI (147). It builds from source in 18s where a toolchain
  exists — but a plugin-marketplace install runs with `--ignore-scripts`, so
  there is neither a prebuild to download nor a build step to run.

- **`develop` is gone; `main` is the only long-lived branch** — it was
  fast-forwarded from `main` after every merge and never merged into, so every
  sync re-tested a byte-for-byte identical tree. A branch that only ever receives
  a copy of `main` answers no question a git tag or `CHANGELOG.md`'s
  `[Unreleased]` section does not already answer.

- **CI runs on every pull request** (`ci.yml`, `codeql.yml`) — the `pull_request`
  trigger carried a branch filter, so a PR stacked on another feature branch got
  no build, no tests and no CodeQL while still collecting automated review
  comments: reviewed, never compiled, never scanned, and indistinguishable from
  healthy on a page of green checks.

- **Workflow hardening** (`.github/workflows/*.yml`) — every job now has a
  `timeout-minutes` budget instead of GitHub's six-hour default, and CodeQL and
  the review workflow supersede an in-flight run when a new commit arrives. The
  publish and deprecate workflows deliberately do not: cancelling a publish
  half-way is worse than letting it finish.

- **`verify_agent_work` reports three states, not two** (`src/core/verifier.ts`,
  `cli.ts`, `handlers.ts`) — `pass: boolean` is replaced by
  `verdict: 'pass' | 'fail' | 'unverified'` on both the result and its nested
  `reality_check`. A `pass` now requires that something was actually checked;
  `unverified` also covers the runs where the check could not look at all.
  `memesh verify` prints `UNVERIFIED` and **exits 2**, distinct from 0 and 1, so
  a gate written as `memesh verify … && deploy` cannot read "checked nothing" as
  success. `pass` remains as a deprecated alias for `verdict === 'pass'`, so
  callers upgrading from 4.2.10 keep working; both are removed together in a
  later minor.

- **A query with no searchable terms returns empty** (`src/knowledge-graph.ts`) —
  `"???"` and the like fell through to the recent list, so unmatched memories
  came back labelled as results. A genuinely empty query still lists recent.
  **Behaviour change.**

- **The two relation types that do something are now described to the model**
  (`handlers.ts`, `src/core/types.ts`, `docs/api/API_REFERENCE.md`) —
  `supersedes` **archives the target entity** on write and `contradicts` makes
  both memories surface as a conflict on every recall, and the `remember` schema
  named neither, offering two inert examples instead. `findConflicts()` runs on
  every recall and could therefore only ever return `[]`, which all three
  transports render as "no conflicts" — a clean bill of health from a check whose
  input was unreachable.

- **The `recall` MCP tool tells the model how its query will be read** — OR-joined,
  ranked by BM25, capped at 32 terms, with ubiquitous words removed. The
  description said only "uses FTS5 full-text search", so an agent choosing
  between a keyword and a sentence had nothing to go on.

- **Every published claim that no longer matched the code has been corrected**
  (`README.md` + 10 locales, `docs/ARCHITECTURE.md`, `skills/memesh/SKILL.md`) —
  each checked against source rather than adjusted by eye: the R@5 figure
  (95.40% → **95.60%**, now named together with the code path that produces it),
  the scoring weights (`frequency` 18% / `confidence` 17%, not 15% / 15%),
  `temporal validity` as a scoring factor (removed from `scoring.ts` in 2026-05,
  and a constant 1.0 no-op before that), and `~18ms/query` (that number was
  9.2s ÷ 500 questions, and each question includes building a fresh 50-session
  database; a recall itself measures ~4ms).

- **The LongMemEval benchmark measures the shipped retrieval path**
  (`benchmarks/longmemeval/`) — it seeds through `KnowledgeGraph.createEntity()`
  and retrieves through `recallEnhanced()`, the calls `remember()` and every
  transport make, and records `run_info.measures: "shipped_recall_path"` so a
  result file states what produced it. Modes name real product configurations —
  A without embeddings, B with them. Earlier result files are kept unmodified and
  labelled. Two published claims were retracted rather than quietly dropped: that
  the figure was measured with "the same retrieval engine MeMesh uses in
  production", and that the benchmark was "a conservative lower bound" on
  production quality.

- **The publish path enforces what the review path enforces**
  (`.github/workflows/publish-npm.yml`) — version coherence, mirror drift and the
  doctor manifest gate ran on every pull request and on no release, while
  `.claude-plugin/*.json` ship inside the tarball, so a partial version bump could
  reach plugin-marketplace users unchecked. `npm run verify:release` is now the
  single answer to "is this shippable", with a tag-versus-`package.json` check
  before anything is installed and `prepublishOnly` so a manual publish cannot
  bypass it.

### Removed

- **`consolidate` — MCP tool, HTTP endpoint and CLI command**
  (`src/core/consolidator.ts` deleted) — **this is a breaking change.** MeMesh
  now exposes **8** MCP tools.

  What it did: deleted an entity's observations and wrote an LLM summary in their
  place, immediately, with no proposal and nothing to restore from. Three defects
  were measured in it before the decision to retire, and each is one the reviewed
  path was already designed against. A failure between the delete and the write
  destroyed the entity and reported that nothing had happened. It ignored pins,
  so `memesh consolidate` with no arguments swept pinned entities in with the
  rest. And it reset `confidence` to 1.0 on success — compression removes text
  and adds no evidence, and since a model could call it, a model could raise its
  own memories to maximum confidence by asking for a summary.

  **`dream` is the surviving compression path** and the reviewed form of the same
  idea: it proposes, applies nothing until a proposal is accepted, keeps
  `source_ids`, archives sources instead of deleting them, refuses semantic types
  and pinned entities, and caps compaction depth. It is **not** a like-for-like
  replacement — it merges *clusters* of episodic memories, so compressing the
  observations *within* one named entity has no reviewed equivalent today.

  | Surface | Before | Now |
  |---|---|---|
  | MCP | `consolidate` tool | gone from the registry |
  | HTTP | `POST /v1/consolidate` | `410 Gone` + what to use instead — not 404, which reads as a typo and invites a retry |
  | CLI | `memesh consolidate` | prints where to go, exits `1` — deleting it outright reads as a broken install |

- **`cleanup.consolidateHint`, a dead dashboard string in 11 locales**
  (`dashboard/src/lib/i18n.ts`) — advice to use the tool that has now been
  retired, translated eleven times and rendered zero times.

### Fixed

- **`recall` finds the memory when you ask a question in your own words**
  (`src/knowledge-graph.ts`, `src/core/operations.ts`) — four defects compounded
  into near-total recall failure for anything but a single keyword, and each one
  hid the others.

  1. **Query terms were AND-ed.** Every word of the query — including `what`,
     `did` and `with` — had to appear in the same memory, so recall got *worse*
     the more precisely you asked: R@5 fell from 62.5% at one keyword to 41% at
     two, 29% at three and 18% at five. Terms are OR-ed now.
  2. **Relevance was discarded before ranking.** The SQL ordered by `e.id DESC`
     and applied `LIMIT`, so the *newest* matches survived to the scorer and the
     best match was thrown away before it could be scored — unreachable at any
     database size once 26 memories mentioned a term. Ordering is by BM25 `rank`
     now; recency is still one of the five scoring factors, it just no longer
     decides what gets scored.
  3. **The relevance signal was flattened.** Every hit entered the scorer at a
     hard-coded `1.0`, tying them all and letting recency and frequency re-sort
     them, undoing the ordering the search had just computed. Relevance is graded
     by BM25 position now. Invisible in a fresh database and decisive in an aged
     one, which is why it ships alongside the others rather than after them.
  4. **Punctuation inside a word turned it into a phrase requirement.**
     `kitchen's` became the FTS5 phrase `kitchen s`, matching only a memory with
     those words adjacent and in that order; a memory that said "kitchen" was
     missed outright. Queries are split on the boundaries `unicode61` itself
     uses, over an NFC-normalised query, which keeps non-Latin scripts alive — a
     plain `[^a-zA-Z0-9]` strip would reduce a CJK query to the empty string and
     fall through to the recent-list path looking like a successful search.

  Measured end to end on the same 500 LongMemEval-S questions, through
  `recallEnhanced()`: **R@5 5.20% → 95.60%, R@10 5.20% → 97.80%,
  MRR 0.0520 → 0.8929, and questions returning zero results 473/500 → 0/500.**

  OR raises recall and lowers precision: a query now returns weaker partial
  matches below the strong ones instead of returning nothing, and result lists
  are longer. Ranking, not exclusion, is what keeps the top of the list clean.

- **Every spaceless script is searchable by part of a phrase, not only by its
  exact stored text** (`src/storage/fts-index.ts`, `src/knowledge-graph.ts`,
  `src/db.ts`) — FTS5's `unicode61` tokenizer puts no boundary between CJK
  characters, so an unbroken run indexed as **one token**. A memory holding
  「資料庫遷移前一定要先備份」 could be found by searching that exact string and by
  nothing else. Measured on a mixed corpus, Chinese recall was **2/9** where
  English was 4/4 — which is why it stayed invisible. For anyone whose notes are
  in one of these scripts, keyword recall was effectively broken.

  Text now passes through `segmentUnspacedScripts()` on the way into the index
  and on the way into a query, cutting unspaced runs into overlapping character
  bigrams. Latin text is returned byte-for-byte unchanged, so English behaviour
  is untouched and the 500-question run is identical before and after. Chinese
  recall on the same corpus goes **2/9 → 9/9**. Chosen over FTS5's `trigram`
  tokenizer, which measured 3/9 for 4× the index size.

  The first version of this listed the scripts that had been *reported* — CJK
  ideographs, kana, hangul — rather than the property that makes them need
  fixing, so **Thai, Lao, Khmer, half-width katakana and CJK Extension B kept the
  exact defect**, invisibly, because no test used one. All five are covered now,
  and segmentation is code-point aware: Extension B lives above the BMP, so
  building bigrams over UTF-16 code units had been cutting surrogate pairs in
  half. Spaced scripts are unaffected — Cyrillic, Greek and Devanagari are
  asserted to pass through byte-for-byte.

  Known bound, pinned by a test rather than chased: a single-character query
  becomes a prefix match, so it reaches any bigram starting with that character
  but not one where it sits last (「收」 will not find 「營收」).

- **Text stored in decomposed (NFD) form was unreachable** (`fts-index.ts`,
  `knowledge-graph.ts`) — the index side never normalised Unicode and the query
  side normalised *after* segmenting, so decomposed Hangul was never split into
  bigrams and text arriving as NFD could not be found in either spelling. NFD is
  not exotic input: macOS filesystem APIs, Finder and several Korean and
  Vietnamese input methods emit it, and the hooks capture it from file paths.
  `toIndexForm()` now owns "text → index tokens" for both sides.

  The same disagreement had a second edge, after archiving. Archived rows leave
  FTS5, so that branch matches with `LIKE` against the raw columns while its
  terms come from a NFC-normalising tokenizer — measured, a Vietnamese memory
  stored NFD was returned by `search('dữ liệu')` and absent from the same search
  with `includeArchived: true`. A deterministic `memesh_nfc()` SQL function now
  normalises the stored side too.

- **A query of combining marks alone claimed to be searchable**
  (`src/storage/fts-index.ts`) — the tokenizer accepted a run of marks with no
  base character, which `unicode61` treats as separators, so the phrase built
  from one could never hit a row. `hasSearchableTerms` answered true and
  `search()` returned 0 — and because the vector supplement is gated on that
  answer, those queries skipped the keyword result and got semantically-nearest
  memories instead. A term must start with a letter or a number now; marks that
  follow one are untouched, so Thai tone marks, Devanagari matras, Arabic harakat
  and Hebrew niqqud all still tokenise as part of their word.

- **`include_archived` searches for what you asked, not for a literal substring
  of it** (`src/knowledge-graph.ts`) — the `LIKE` branch interpolated the whole
  raw query, so a question phrased in your own words found the active copy of a
  memory and missed the archived one, and a CJK query missed entirely because it
  was never segmented. It now matches the same terms the FTS path produces, with
  `LIKE` metacharacters escaped.

- **Recall was not reproducible** (`src/knowledge-graph.ts`) — `ORDER BY f.rank`
  had no tiebreaker and BM25 ties are the common case, so which rows survived
  `LIMIT` to reach the scorer was left to SQLite. Ties break by recency now.

- **The vector index could be destroyed on evidence the guard exists to
  distrust** (`src/db.ts`, `src/core/config.ts`, `src/core/embedder.ts`,
  `cli.ts`) — four ways, all ending in a BYOK user's embeddings being dropped
  with no backup, no prompt, and a paid re-embed to recover.

  `readConfig()` returned `{}` for both "no config" and "config could not be
  read", and the embedding dimension derived from it drives a `DROP TABLE
  entities_vec` on mismatch — so a truncated write or a bad permission bit read
  as "user configured nothing", fell back to 384 dimensions, and dropped a
  1536-dimension index. The guard against that was keyed to the config being
  *absent*, which every foreign-`HOME` case defeats when that `HOME` happens to
  contain a config file. `memesh reindex --vectors` asked
  `isEmbeddingAvailable()` before authorising the drop, and that function reports
  which provider the config *names* — an expired key or a stopped Ollama
  authorised dropping every vector and then wrote nothing back. And consent was a
  module-level boolean, so in any process that opens more than one database a
  grant recorded for A could be spent by an unrelated open of B.

  The refusal now follows the consequence rather than the evidence: any
  disagreement between the stored and configured dimension keeps the existing
  index, because a stale index still works and is recoverable by fixing the
  config, while a dropped one is gone. The precondition for a deliberate rebuild
  is `canRefillVectorIndex()`, which embeds one string and measures the result
  against the width the table is about to be declared with — a proof rather than
  a claim. Consent records a resolved database path. The `DROP`, marker, `CREATE`
  and dimension stamp are one transaction, so a crash between them can no longer
  leave `memesh doctor` reporting a healthy install over an emptied index.

- **`memesh reindex` reported success for work it had not done**
  (`src/core/embedder.ts`, `src/core/operations.ts`, `cli.ts`) — `embedAndStore()`
  has six exits and exactly one writes a vector, but it returned `void` from all
  six, so the only signal a caller got was "it didn't throw". A provider whose
  dimension no longer matched therefore produced a full `Embedded:` count over an
  index nothing had been written to, cleared the flag that tells `memesh doctor`
  the index still needs refilling, printed `✅ Reindex complete` and exited `0`.

  `embedAndStore` returns which of the six happened now, and the decision to
  clear the flag is taken from the **database** — active memories with
  observation text but no vector row — rather than from what the loop believed it
  did. The verdict additionally requires that every attempted write landed, since
  a full index of *stale* vectors satisfies "does every entity have a vector" in
  exactly the situation the command exists for. An incomplete run prints
  `⚠️  Reindex incomplete` with a per-reason breakdown, leaves the flag set, and
  exits `1`. Memories whose observations are all whitespace are counted
  separately, so they cannot hold the flag open forever. The count deciding the
  user-facing verdict is scoped to the run while the count deciding the
  database-wide flag is not — sharing one number made a `--namespace` run report
  failure after doing everything it was asked to do.

- **A memory written while the index rebuilt could vanish from search,
  permanently** (`src/db.ts`, `scripts/hooks/_shared.js`) — the rebuild read its
  source rows *before* opening its transaction, and better-sqlite3's default
  `BEGIN DEFERRED` takes no write lock until the first statement inside it. Seven
  hooks, the MCP server, the HTTP server and the CLI all open this database, so
  an entity committed in that window was erased by `delete-all` and never
  reinserted — and the version marker then committed, so it never retried. The
  entity row survived, which is why nothing noticed. Migrations run through one
  helper that takes `BEGIN IMMEDIATE` and re-checks the version under the lock
  now, and backs off 24h after a failure instead of re-scanning the whole corpus
  on every process start. Hooks run the same migration; they previously did not,
  leaving hook-only users with a permanently half-segmented index.

- **The segmentation upgrade did not reach any existing database** (`src/db.ts`)
  — `rebuildFtsIndex` carried a fast path justified by "v2 differs from v1 only
  by NFC-normalising before segmenting", which was true when the target was 2.
  Version 3 also widens the script class, and **none of the newly-covered scripts
  has a canonical decomposition**, so the probe returned false for exactly the
  corpora the widening exists to fix. Measured: a database holding Thai and
  half-width katakana came out of the upgrade with its marker stamped 3, its
  index still holding old whole-run tokens, and every fragment query returning
  nothing. The marker only moves forward, so it never self-healed. The skip is
  gone; a version-keyed shortcut is only sound while someone re-derives its
  premise at every bump.

- **A failed database open poisoned the whole process** (`src/db.ts`) —
  `openDatabase` assigned its module singleton *before* finishing initialisation,
  so any throw after `new Database()` — a peer holding the write lock, a
  read-only file, a failed extension load — left `db` pointing at a handle with
  no schema, no migrations and no sqlite-vec, and every later caller got it for
  the life of the process. The singleton is published only on success now, and
  the abandoned handle is closed.

- **The vector half of "hybrid search" was doing nothing**
  (`src/core/embedder.ts`, `src/core/operations.ts`) — `entities_vec` is declared
  with no `distance_metric`, so sqlite-vec measures **L2**, a 0…2 range over unit
  vectors; both constants assumed a 0…1 cosine scale. `MAX_VECTOR_DISTANCE = 1`
  discarded 995 of 1000 vector hits, and `1 - distance` sent 98.8% of the rest to
  exactly 0.0 relevance. Embeddings were being generated, stored, searched, and
  thrown away before anything could use them. The cut-off is **1.30** and the
  mapping `1 - distance/2`, extracted as `vectorSimilarity()` next to the
  constant it shares a scale with — keeping them in separate files is how they
  drifted apart.

  **This does not raise the benchmark score**, and that is worth stating plainly:
  R@5 is unchanged. What changes is that the feature is no longer inert, and a
  query matching nothing lexically can now be answered semantically. Re-measured
  over all 500 questions, 14 result lists differ between embeddings-off and
  embeddings-on where before they were identical to sixteen decimal places; two
  questions move the correct session, both at ranks no one would scroll to, for
  89× the wall clock. This refutes a prediction the benchmark docs used to make —
  that the remaining failures were "dominated by vocabulary mismatch — exactly
  what a working vector supplement would cover". The docs say so instead of
  quietly dropping the claim. Recall stays LLM-free and embeddings stay opt-in.

- **Recorded, not fixed: a vector hit cannot outrank the best keyword hit,
  however certain it is** (`src/core/operations.ts` docstring) — FTS relevance is
  *positional* (the top row gets 1.0 no matter how weak the match) while a vector
  hit's is *absolute*, and a genuinely good semantic match sits near 0.4. Rank
  fusion is the fix; it was implemented, measured and **not adopted** — on this
  corpus it recovered 4 of 5 misses and cost R@5 95% → 92%, and LongMemEval's
  haystack is padded with generic public Q&A that scores high on semantic
  similarity while being nobody's memory, so it is the wrong corpus to tune
  fusion on.

- **A query term present in most of the corpus no longer drags the whole index
  into the scan** (`src/knowledge-graph.ts`, `src/db.ts`) — query terms are
  OR-ed, so the cost of a search is the union of their postings and one
  ubiquitous word dominates it. `dropUbiquitousTerms()` removes terms appearing
  in more than half the indexed rows. Measured with a 12-term query:
  **0.411 → 0.079 ms at 500 rows (−81%), 4.147 → 0.481 ms at 5 000 (−88%),
  80.15 → 8.57 ms at 100 000 (−89%)**. The dropped terms are the ones BM25
  already scores near zero, so this removes work rather than signal — R@5 is
  unchanged. Two edges are pinned by tests: a query made entirely of common words
  keeps its rarest term rather than filtering to nothing, and the guard does not
  apply below 25 rows, where a term in most of the corpus is the subject rather
  than a stopword. Preventive rather than remedial.

- **`recall_hits` has one owner again** (`src/storage/conflicts.ts`,
  `src/knowledge-graph.ts`) — the column was written by two paths with
  incompatible definitions. The Stop hook writes it to mean "a memory we injected
  was actually used", recording a hit *or* a miss; `search()` also wrote it to
  mean "this memory was returned", which can only add to the hit side. The
  impact score reads the pair as a ratio, which is meaningful only if both sides
  answer the same question. Retrieval paths track access only now — "was
  returned" is already recorded by `access_count`, in the same statement.

- **`verify_agent_work` passed on a claim it never evaluated**
  (`src/core/verifier.ts`) — with no discoverable git base, `expected_files` was
  never compared, and with neither a claim nor a report supplied it counted
  changed files, which is not a check against anything, and then reported
  `pass: true`. It also wrote a permanent memory tagged `verification:pass`,
  which a later `recall` hands to another agent as evidence the work was checked.
  The root cause was two absences multiplying into a pass — `realityCheck()`
  returning true with no claim, and a missing report defaulting to true. See the
  `verdict` tri-state under **Changed**.

- **The dashboard's auth screen was unusable with a screen reader, and silent on
  a rejected token** (`dashboard/src/components/AuthPrompt.tsx`,
  `dashboard/src/App.tsx`, `dashboard/src/lib/i18n.ts`) — the error had no live
  region, the input was not focused on a screen reached involuntarily by a 401,
  `required` made the empty-token message unreachable, and pasting a rejected
  token produced no message in any locale. The rejected branch also left
  `aria-invalid="false"` and no `aria-describedby`, so a screen-reader user heard
  an announcement and then found a control that disagreed with it. Both messages
  own one stable id now and both reach the field.

  Five lookups on that screen were written as `t('auth.x') || 'English literal'`,
  which reads as a safety net and cannot be one — `t()` returns the key string on
  a miss, and a non-empty string is truthy, so the right-hand branch is
  unreachable. When those keys were genuinely missing this screen rendered
  `auth.title` at a remote operator. They are removed; English is already the
  fallback inside `t()`. The token input's `placeholder` was a hardcoded
  `"paste token here"` and is now translated in all 11 locales.

- **Two checks that could not fail** (`scripts/verify-docs-sync.sh`,
  `src/core/schema-export.ts`) — both claimed to compare the MCP registry against
  something and neither did. The shell gate compared the code's tool count to a
  literal, and counted the docs' side by counting *every* `### ` heading in
  `API_REFERENCE.md` — 43 of them — then checking `-lt 9`, which no version of
  that document could fail. It reads the number the document actually claims now.
  The schema test asserted a hardcoded count and name list under the title
  "matches MCP registry"; it matched nothing, it restated. Deriving both from
  `TOOL_DEFINITIONS` immediately surfaced a real drift the duplicate had hidden:
  the OpenAI export listed `memesh_learn` third where the MCP registry lists it
  sixth.

- **A docs gate reported FAIL on a correct tree** (`scripts/verify-docs-sync.sh`)
  — the hook count recursed into subdirectories, so a build-generated mirror took
  it from 7 to 9 and the gate failed every run. A gate that fails on a healthy
  repo gets ignored, and then it is not a gate.

- **Committed build output could drift from source**
  (`scripts/check-generated-mirror.mjs`, `scripts/generate-skills-manifest.mjs`)
  — `dist/` is tracked because plugin-marketplace installs run it directly:
  they install with `--ignore-scripts` and never build. Nothing verified it
  matched `src/`, and the one channel that ships committed output was the one no
  gate covered. `npm publish` was never exposed, because `prepublishOnly`
  rebuilds first — which is precisely why it could persist. The manifest also
  carried a `generated_at` timestamp, written and never read, so every build
  produced a different file and "is the committed output current?" had no answer
  a diff could give; it is gone and the build is reproducible.

- **The committed dashboard bundle could not be reproduced on Windows**
  (`.gitattributes`, `scripts/build-dashboard.mjs`, `ci.yml`) — `.gitattributes`
  listed the ten extensions whose CRLF breakage had been noticed and left `.css`
  and `.html` out, so Windows checked those out with CRLF, vite **inlined** them
  into `dashboard/dist/index.html`, and the carriage returns landed mid-line
  inside a shipped artifact. The rule is `* text=auto eol=lf` now: line endings
  are a property of text, not of a suffix list somebody remembered to extend. The
  build also ran `npm install` rather than `npm ci`, and CI built the dashboard
  twice with the second build landing *after* the release gates — so the gate
  diffed an artifact produced by an unpinned install.

- **`memesh doctor` reported a healthy index as damaged**
  (`src/core/doctor.ts`, `src/storage/fts-index.ts`) — its predicate assumed a
  segmenting build cannot emit a term longer than a bigram that starts with an
  unspaced-script character. False: a *lone* unspaced character is left
  untouched and `unicode61` then joins it to adjacent ASCII, so an ordinary
  database holds terms like `第1章`. The predicate requires three consecutive
  unspaced-script characters now, which segmentation can never emit. The message
  also embedded an example term taken from the index; since `memesh feedback`
  copies doctor summaries verbatim into a pre-filled **public** GitHub issue
  body, it reports a count instead — just as actionable: rebuild, re-run doctor,
  expect 0.

- **A failing database reported both `pass` and `fail`** (`src/core/doctor.ts`)
  — the "Database opened successfully" row was pushed as soon as the entity count
  came back, so anything that threw afterwards appended a *second* row with the
  same id and status `fail`. The overall verdict was right and the row a reader
  looks at was wrong. The block stages its rows and emits exactly one now.

- **One hook and two commands were not guaranteed executable**
  (`scripts/set-executable-bits.mjs`) — the chmod list had drifted from
  `package.json` `bin` in both directions, and `dist/transports/cli/cli.js` — the
  `memesh` command itself — was committed at mode 100644. Both lists are derived
  from their manifests now.

- **`package-lock.json` carried the version from four releases ago** — its two
  self-version fields read `4.2.6` through v4.2.7, v4.2.8, v4.2.9 and v4.2.10,
  because the lockfile was missing from the version-anchor checklist. Only those
  two fields changed; all 520 dependency entries are byte-identical.

- **Published benchmark results no longer record the absolute path of the machine
  that produced them** (`benchmarks/longmemeval/run.mjs`) — `run_info.dataset`
  held the full path to the dataset file, which in a public repository means
  publishing a local home directory. It records the basename now;
  `dataset_sha256`, which is what actually identifies the dataset, is unchanged.

- **A retrieval-quality floor now runs on every CI leg**
  (`tests/recall-quality.test.ts`) — the LongMemEval dataset is a 278 MB download
  and committing a slice is dataset redistribution, so the gate uses a small
  synthetic corpus: ten memories, ten questions phrased as a person would ask
  them, and thirty function-word notes so `limit: 5` has to choose which rows
  reach the scorer. It asserts an aggregate R@5 floor of 80% and is calibrated to
  catch collapse, not drift — AND-joined terms take it to 0% and ordering by
  `e.id DESC` takes it to 20%.

### Security

- **`actions/checkout` no longer persists the job token**
  (`.github/workflows/*.yml`, 9 steps) — by default `checkout` writes the job's
  `GITHUB_TOKEN` into `.git/config`, where every later step can read it. That
  includes `npm ci`, which in this repository **runs install scripts** on
  pull-request code. No step here pushes with the token, so nothing needed it.
  `ci.yml` also declares `permissions: contents: read` in the file rather than
  inheriting a repository-level default that can change with no diff and no
  review.

- **The local embedding runtime is no longer installed by default**
  (`package.json`) — `@huggingface/transformers` is an optional peer dependency
  now, so a plain `npm i @pcircle/memesh` no longer pulls `onnxruntime-node` and
  `sharp`, which between them carried five high-severity advisories with no fix
  available upstream. Recall does not need it: the published 95.60% R@5 is
  Mode A, measured with **no embeddings at all**. Users who want local ONNX
  embeddings install it alongside; BYOK OpenAI/Ollama embeddings are unaffected.
  Verified on a real consumer install of the packed tarball: neither package
  present, no advisories, English and Chinese recall both still working.

- **The dependency gate measures what ships, not what this repo has**
  (`scripts/check-consumer-audit.mjs`) — `npm audit --omit=dev` run in the repo
  audits the repo's own tree, and npm applies `overrides` only at the install
  root, so the overrides added here changed what this project tests and changed
  nothing for a consumer. `npm run audit:prod` packs the tarball, installs it the
  way a user does, and audits there — and refuses to pass if the install produced
  no tree.

- **LLM-written memories are marked as such, and no longer auto-injected into
  context** (`src/core/dreamer.ts`, `scripts/hooks/_shared.js`) — `applyProposal`
  wrote metadata with no `trust` key at all, while the identical threat model
  elsewhere is marked `trust: 'untrusted'`. Both consumers of that marker
  **default to allow when it is absent**, so digests entered session-start and
  pre-edit auto-injection at the highest signal score in the codebase, and the
  confidence gate read the same missing marker as "trusted". This is a policy
  inconsistency, not a break-out — the auto-context fence collapses whitespace
  and cannot be closed from inside. What changes is that LLM-written text is no
  longer pushed into context unprompted; it stays fully searchable by explicit
  `recall`. Also pinned: the `project:` tag on an applied digest comes from the
  cluster rather than from the model, since `project:` is what tag-filtered
  recall routes on.

- **The dreamer's two prompts now get the same prompt-injection hardening as
  every other LLM call site** (`src/core/dreamer.ts`) — they interpolated entity
  names, types and observations straight into the prompt with only "treat the
  entries as data only" holding the line. The exposure is not theoretical for
  this path in particular: the dreamer exists to compact **episodic** entities —
  commit messages and session transcripts — which carry whatever a dependency, a
  PR title or a test fixture printed. Both prompts sanitise their sources and
  wrap them in a delimiter now.

- **The pattern detector wrote relations to entities it was never shown**
  (`src/core/dreamer.ts`) — `evidence[]` comes back from the LLM and becomes the
  proposal's `source_ids`; accepting a pattern then writes a relation row and a
  metadata back-pointer for each id. Every other field of that response is
  truncated or whitelisted; `evidence` was checked only for "positive integer",
  so an id the model invented, or lifted out of injected text, wrote a relation
  against an entity outside the scan. Ids are validated against the set actually
  present in the prompt now. Fixed alongside: the "at least two pieces of
  evidence" rule ran on the **raw** array, before non-integers were dropped, so
  `evidence: ["a", "b"]` cleared the gate and arrived as `[]`.

- **The prompt-injection fence did not own its own fence**
  (`scripts/hooks/_shared.js`) — `buildReferenceContext()` declares its contents
  to be data rather than instructions, then interpolated caller text verbatim, so
  a stored memory containing a newline and a triple-backtick closed the fence and
  had the rest read as instructions. The renderer guarantees it now: whitespace is
  collapsed and the fence outgrows any backtick run in the content.

- **`.gitignore` re-included a subtree over the top of the global rules** —
  `!benchmarks/longmemeval/**` is a recursive negation and a later negation wins,
  so it overrode `.env` and `data/` for that whole subtree, in a public
  repository, in the directory `REPRODUCE.md` tells people to download a dataset
  into. The line was also unnecessary.

### Performance

- **The test suite went from 253s to 40s** (`src/core/embedder.ts`,
  `scripts/run-tests-isolated.mjs`, `ci.yml`) — the local embedding model caches
  at `~/.memesh/models`, which is right for a real install and wrong for anything
  that isolates `HOME`, so every test that spawned the CLI or a hook under a
  per-test `HOME` re-downloaded 98 MB. Measured on a first write in a fresh
  `HOME`: 19.4s wall clock, 1.21s user, 8% CPU — almost entirely network wait,
  which is why it looked like slow tests rather than a download.
  `MEMESH_MODEL_CACHE_DIR` points the cache somewhere stable; the default is
  unchanged. CI was paying this on every leg of the matrix, and it made the whole
  matrix depend on `huggingface.co` being reachable — a third-party outage would
  have turned it red with nothing wrong in the code. CI also caches the model
  between runs now, removing the first download too.

## [4.2.10] — 2026-07-25

### Fixed
- **LLM JSON-block extraction is now nesting- and prose-safe (latent bug)** (`src/core/json-utils.ts` + auto-tagger / consolidator / digest-validator / dreamer) — five sites pulled a JSON object/array out of a chatty LLM reply with a regex, and they had drifted between a greedy `/\{[\s\S]*\}/` and a lazy `/\{[\s\S]*?\}/`. Both are fragile: greedy over-matches a `]`/`}` that appears later in prose and breaks `JSON.parse`; lazy stops at the first closer and truncates a nested block. Replaced all five with one `extractJsonBlock(text, kind)` that scans for the first balanced block, tracking depth and skipping brackets inside string literals — robust to nesting, trailing prose, and quoted brackets. Covered by a new unit test hitting each case the old regexes broke on.

### Changed
- **Hooks no longer hand-mirror `src/core` — the shared path + FTS logic is generated from core at build time** (`scripts/generate-hook-core.mjs`, `scripts/hooks/_generated/`, `scripts/hooks/_shared.js`) — hooks run the always-on capture path even when `dist/` is absent (plugin-marketplace `--ignore-scripts`) or stale, which historically forced a hand-copy of `src/core/paths.ts` + the FTS write dance inside `_shared.js`. That copy drifted and shipped the P0 where session memory was written but not indexed (unrecallable). Because those two source files are runtime-leaf modules, `npm run build` now copies their compiled output into `scripts/hooks/_generated/` and `_shared.js` imports the committed, version-locked copy. Drift is now caught three ways: a CI `git diff` on rebuild, `tests/hooks/mirror-parity.test.ts`, and the `memesh doctor` manifest (which now verifies the generated files too). No runtime behavior change — the mirror-parity test confirms the generated copy is byte-equivalent to the former hand-mirror.
- **`recall`'s conflict annotation is owned by core, not re-implemented in each transport** (`src/core/operations.ts`, `src/transports/{mcp,http,cli}`) — all three transports independently ran `recallEnhanced → new KnowledgeGraph → findConflicts → wrap`, so a change to how recall results carry conflicts meant editing three files that had already drifted (different try/catch shapes). Lifted the composition into `recallWithConflicts()` in core; the transports now call it and only format. No behavior change — same `{ entities, conflicts }` when conflicts exist, bare entities otherwise.

### Fixed
- **Dashboard Behaviour toggles no longer swallow a failed save** (`dashboard/src/components/SettingsTab.tsx`) — the auto-update `<select>` and the agentic-orchestration checkbox POSTed to `/v1/config` inside an empty `catch`, so a failed write snapped the control back to its old value with no message; the user thought the setting saved. Both now route through a shared `saveField()` that surfaces the error (and a "saved" confirmation) via the same status banner the provider save uses.
- **`memesh config list` shows every settable key, not just `llm.*`** (`src/transports/cli/cli.ts`) — `list` hard-coded three `llm.*` lines, so a user who ran `config set sessionLimit 50` (or `llmFallbacks`, `autoCapture`, `autoUpdate`, `embedder.*`) got `✅ Set` but saw no trace of it in `list` — reads as a silent write-drop. `list` now iterates `ALLOWED_KEYS` (the single source of truth for settable keys) so the two can't drift, printing each present value with `apiKey` fields — including every `llmFallbacks[].apiKey` — masked.

### Tests
- **Permanent CI gates for the fake-working write-path class** (`tests/hooks/write-hook-invariants.test.ts`) — turns the session-capture-FTS fix into invariants that can't silently regress: (1) `captureEntity()` really keeps `entities_fts` in sync (write → `MATCH` returns the row), and (2) every write hook (session-summary / post-commit / pre-compact) routes through `captureEntity()` and hand-rolls no `INSERT INTO observations` / `entities_fts` of its own — so a future hook can't drop the FTS step again. Mirrors the i18n key-coverage guard shipped for the AuthPrompt fix.

### Performance
- **Dashboard graph + browse + type-list no longer fire a query storm** (`src/knowledge-graph.ts`, `src/core/graph.ts`, `src/transports/http/server.ts`) — `computeGraph` (the `/v1/graph` endpoint), `listRecent` / `listRecentByTag` (empty-query recall + Browse tab), and the `/v1/entities?type=` branch each mapped `getEntity()` over their result rows, and `getEntity()` fires 4 queries per row. A 700-entity graph meant ~2800 queries per request. All now route their id list through the existing order-preserving `getEntitiesByIds()` batch hydrator (4 queries total). The transport's hand-rolled `SELECT ... WHERE type = ?` moved into a new `KnowledgeGraph.listByType()` so status/ordering semantics live in the storage layer, not the HTTP handler. Same fields, same active/archived filtering, same ordering — verified by the existing listRecent tests plus a new listByType test.

### Fixed
- **Recall-effectiveness stops scoring machine-named auto-capture entities against a name they can't match** (`scripts/hooks/session-summary.js`) — the Stop hook decided "was this injected memory used?" by substring-matching the entity name in the session transcript. Auto-capture entities are named with machine identifiers (`session-<pid>-…`, `commit-<hash>`, `pre-compact-<id>`) that never appear verbatim in prose, so every injection scored a `recall_miss` they didn't earn, dragging their Laplace-smoothed impact factor (10% of ranking) down over time and quietly suppressing auto-captured memories from future recall. These names carry no name-match signal, so they're now excluded from hit/miss accounting (kept at the neutral 0.5 impact) via a new `isMeasurableRecallName()` guard. The name-substring heuristic is unchanged for human/LLM-slug names.

## [4.2.9] — 2026-07-24

### Security
- **`POST /v1/config` no longer echoes fallback-provider API keys in plaintext** (`src/transports/http/server.ts`) — the POST response masked only `llm.apiKey`, so saving an `llmFallbacks: [{provider, apiKey}]` chain returned each fallback key in cleartext to the dashboard SPA (the GET handler already masked the whole chain). Consolidated both surfaces onto one `maskLlmSecrets()` helper that redacts the primary key and every fallback entry, so they can't drift again. Persistence was unaffected; only the response surface leaked.

### Fixed
- **Session-capture memories are now FTS-recallable (fake-working bug)** (`scripts/hooks/session-summary.js`, `scripts/hooks/_shared.js`) — the Stop hook's `storeMemory()` inserted the entity + observations + tags but never reindexed `entities_fts`, unlike its sibling hooks (post-commit, pre-compact). With no FTS trigger and no rebuild-on-open, every `session-insight` memory was invisible to `recall` and pre-edit-recall — the two keyword paths that inject memory when it matters. The hook reported success; the knowledge could not be keyword-recalled. Root-caused to three hand-rolled copies of the write dance drifting apart: extracted the correct dance (incl. FTS reindex) into a single `captureEntity()` in `_shared.js` now used by all three write hooks, so the FTS step can't be forgotten again. Added a regression test asserting a captured session memory is returned by an `entities_fts MATCH`.
- **Dashboard auth screen showed raw i18n keys instead of text** (`dashboard/src/lib/i18n.ts`) — the `AuthPrompt` (shown at the bearer-auth gate for remote-bound dashboards) referenced five `auth.*` keys that were absent from all 11 locale catalogues. Since `t()` returns the key string itself on a miss (truthy), the `t('auth.title') || 'English'` fallbacks were dead code and the first screen a remote operator saw rendered `auth.title` / `auth.submit` etc. Added the five keys (translated) to every locale. Also added a CI guard that scans components for static `t('...')` keys and fails if any is missing from the English catalogue — the existing i18n test only checked locale-to-locale parity, so a key missing from *all* locales slipped through.

## [4.2.8] — 2026-07-23

### Changed
- **Simplify pass over the audit's changes (quality-only; a 4-agent reuse/simplification/efficiency/altitude review)** — no behaviour change:
  - `memesh doctor --probe` no longer hangs up to 15s after printing its report. The embedding-probe timeout used a `setTimeout` that was never cleared, so on the happy path (the embedder answers first) the timer kept the event loop alive; it is now cleared in a `finally`, and the timeout arm rejects cleanly instead of `resolve(null).then(throw)`.
  - `doctor` no longer hardcodes the ONNX model id + cache layout — `embedder.ts` now owns and exports `isOnnxModelCached()`, so the two can't drift (the exact fake-working risk the code's own comment flagged).
  - Deduped `memesh pin`/`unpin` behind one registrar, the three `by_provider`/`by_model`/`by_project` telemetry accumulators behind one `bump()` helper, and corrected a stale `isRecallHit` docblock that still described a superseded "count occurrences" approach.


### Docs
- **Documented BYOK embeddings + fixed a stale CLI count** (`README.md` + 10 locales, `docs/ARCHITECTURE.md`) — the READMEs documented `config set llm.provider` but never `embedder.provider` / `embedder.model`, so BYOK embeddings (OpenAI / Ollama, independent of the chat LLM, with automatic vector-index rebuild on dimension change) were undocumented. Added a "Bring-your-own embeddings" subsection to all 11 READMEs (H3 — locale H2 parity unchanged). ARCHITECTURE.md's "17 top-level commands" corrected to the actual 24 (config/kg/dream have subcommands).
- **10 locale READMEs re-synced for `MEMESH_AUTO_DETECT_LLM` opt-out semantics** (`README.{de,es,fr,ja,ko,pt,th,vi,zh-CN,zh-TW}.md`) — the honestly-unticked box from the Phase-1 PR. Every locale still described the pre-#36 OPT-IN behaviour ("set to `1` to enable; without the flag a shell key is ignored") and incorrectly tied the flag to BYOK embeddings. Corrected to match the English README: auto-detect is ON by default, `0` disables it, a shell key is used for write-side LLM features unless disabled, and embeddings are unaffected (stay local ONNX). H2 structure unchanged, so `memesh doctor` locale parity stays PASS.

### Removed
- **Removed the write-only `payload` from skill-usage telemetry** (`src/core/skill-usage-log.ts`, `src/core/verifier.ts`, `scripts/hooks/session-start.js`) — each recorded event carried a `payload` (a hashed cwd from session-start; agent-id/pass/files-changed from verify_agent_work), but `summariseSkillUsage` counts by event name and never read it. It was write-only, privacy-adjacent local data. Lines are now `{ ts, event }` only; `logSkillEvent(event, path?)` no longer takes a payload.
- **Dead analytics compute + components, and the unread `config.theme`** (`src/core/analytics.ts`, `dashboard/src/components/`, `src/core/config.ts`, `src/transports/http/server.ts`, `src/transports/cli/cli.ts`) — `/v1/analytics` computed `valueMetrics`, `recallEffectiveness`, and `cleanup` (the latter with an O(n²) duplicate-candidate self-join) on every request, but no dashboard component ever rendered them — the dedicated `ValueMetrics` / `RecallEffectiveness` / `CleanupSuggestions` components were never imported. Removed the compute, the three components, and the response fields. Separately, `config.theme` was settable via `memesh config set theme` and `POST /v1/config` but read by nothing — the dashboard theme lives entirely in `localStorage`. Removed from the config type, CLI `ALLOWED_KEYS`, and the HTTP schema. (`tfidf`, also flagged by the audit, was checked and KEPT — it is the live sentinel for "no neural embedder".)

### Fixed
- **Dashboard analytics panels no longer vanish silently on a single-endpoint failure** (`dashboard/src/components/AnalyticsTab.tsx`) — the tab fetched `/v1/stats`, `/v1/analytics`, `/v1/patterns` with `.catch(() => null)` each, but the error box only showed when both stats and analytics were null, so a `/v1/patterns`-only outage made the patterns panel disappear with no signal. Each failure now logs to the console.
- **`POST /v1/config` test now verifies persistence** (`tests/transports/http.test.ts`) — it asserted only status 200 + `success:true`, so a silent write-drop stayed green; it now writes `sessionLimit` and reads it back via `GET /v1/config`.


### Docs
- **Corrected long-standing doc drift against the code** — `docs/ARCHITECTURE.md` listed `temporal validity` as a live scoring factor, but `scoring.ts` removed it in 2026-05 (`valid_from` / `valid_until` were never written by any code path, so it was a constant 1.0 no-op); `ARCHITECTURE.md` also contradicted itself, describing six factors in one place and "five signals" in another. Both now list the five real weights. The MCP file tree was also wrong in both docs: `launcher.ts` and `server.ts` live in `src/mcp/`, not `src/transports/mcp/` (which contains only `handlers.ts`), and `src/mcp/tools.ts` is a re-export shim. HTTP endpoint count corrected to ~32 to match `src/transports/http/server.ts`.
- **`docs/ARCHITECTURE.md` Session Start section rewritten** to document the two-channel output contract (human `systemMessage` vs model `additionalContext`), why the split is load-bearing, and the real session-file path (`~/.memesh/sessions/<pid>-<timestamp>.json`, not `~/.memesh/last-session-injected.json`).
- **All 11 README locales now have an `## Upgrading` section** (`README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`, `README.ko.md`, `README.de.md`, `README.fr.md`, `README.es.md`, `README.pt.md`, `README.vi.md`, `README.th.md`) — v4.2.5–v4.2.7 release notes added the upgrade flow + pre-v4.2.5 fallback to English + Thai only, so 9 locales were missing the section entirely. Now every locale has the three upgrade paths and the npm-global fallback note.
- **"Actively developed" callout at the top of every README** — adds a `> [!IMPORTANT]` block immediately after the hero divider linking to the GitHub Issues tracker. Sets expectations that features evolve between releases and routes bug reports / feature requests to the correct channel from the first glance.

### Added
- **`memesh kg rename-project` — heal project tags mis-homed before git-based identity** (`src/core/project-tags.ts`, `src/transports/cli/cli.ts`) — the forward-fix (git-remote-slug project identity) only affects NEW captures; existing entities keep whatever `project:<name>` tag they were written with, so a repo split across `project:tim` / `project:TIM` (or captured in a subdirectory) stays split. This is the deliberately-separate, opt-in healer: `rename-project` (no args) lists every project tag + count; `--from X --to Y` previews a dry-run; `--apply` commits after copying the whole DB to `data/backups/kg-before-rename-project-<ts>.db` and printing the restore command. Respects the `UNIQUE(entity_id, tag)` constraint (an entity already carrying the target tag has its old tag removed rather than duplicated). Backup failure aborts without mutating.
- **LLM telemetry now surfaces per-model, per-project, and recent-error detail** (`src/core/llm-telemetry.ts`, `src/transports/cli/cli.ts`, `dashboard/src/components/LlmTelemetryPanel.tsx`) — the `model`, `project`, and `error_message` columns were written on every attempt but never read back, so "which model is failing", "which project's calls fail most", and "what did the failure actually say" were all unanswerable. `summariseTelemetry` now returns `by_model`, `by_project`, and up to 5 recent `sample_errors` alongside the existing `by_provider`/`by_error_class`; the `memesh telemetry` CLI and the dashboard LLM-activity panel render them. `/v1/telemetry` returns the new fields automatically.

### Added
- **`memesh pin` / `memesh unpin` — protect a memory from the dreamer's auto-compaction** (`src/core/operations.ts`, `src/transports/cli/cli.ts`) — the dreamer already read `metadata.pin === true` and documented "never compresses pinned entities", but nothing could ever SET the flag: `remember` exposes no metadata field, and import discards it. The protection was inert — every entity was compactable regardless of the promise. `setPinned()` (behind the new `pin`/`unpin` commands) writes/removes the flag via `updateEntityMetadata`, preserving trust/provenance. End-to-end verified: an unpinned commit cluster is proposed for compaction; after `pin` the same cluster is skipped (`clustersScanned` drops to 0).

### Fixed
- **Comprehensive fake-working sweep (6-dimension scan): hook input-field bugs + a contract-gate coverage hole** (`scripts/hooks/pre-compact.js`, `scripts/hooks/session-summary.js`, `tests/hooks/hook-output-contract.test.ts`) — a full-codebase scan for "produces output nothing consumes / looks wired but does nothing" surfaced several confirmed issues, all verified against the shipped Claude Code `cli.js` bundle (not docs):
  - `pre-compact.js` read `data.reason`, but Claude Code's PreCompact payload names the field `trigger` — every compaction recorded "Compaction reason: auto" regardless of manual/auto. Now reads `data.trigger` (bundle: `hook_event_name:"PreCompact",trigger,custom_instructions`).
  - `pre-compact.js`'s transcript-read `catch` had no stderr trace — the exact twin of the `session-summary.js` outer catch fixed earlier this branch, missed the first time. A real read failure reported "Saved 0 insights" while losing the whole capture; it now traces (ENOENT stays silent).
  - `session-summary.js` guarded on `stop_reason === 'user_interrupt'`, but the Stop payload carries no `stop_reason` field (verified: Stop input is `{...base, hook_event_name:"Stop", stop_hook_active}`; the `stop_reason` in the bundle is the Anthropic API message field). The guard was always false — a filter that looked active but never skipped anything. Removed; the `toolCallCount < 3` check is the real low-signal filter.
  - The cross-hook contract gate ran every hook against an **empty DB**, but `pre-edit-recall` and `session-start` only emit their `hookSpecificOutput` — the branch the gate exists to validate — when memories exist. So that branch was contract-unvalidated and a malformed payload (the #53 class) could ship on the two most-fired hooks. The gate now seeds memories for those cases so the emitting branch actually fires under the validator; mutation-verified (an invalid `hookEventName` / extra field now reddens the gate where it previously stayed green).

- **Project identity now derives from the git repo, not the current directory's name** (`src/core/paths.ts`, `scripts/hooks/_shared.js`) — `getProjectName()` returned `basename(cwd)`, so a memory captured while working in `<repo>/backend` was tagged `project:backend` and became invisible when recalling from the repo root (`project:<repo>`), and the same repo split across `project:tim` / `project:TIM` by directory-name case. On a real 973-tag database ~10% of tags were mis-homed this way. Resolution is now layered — git remote slug → git repo root basename → `basename(cwd)` — so the identity is location-independent (same from any subdirectory or worktree) and case-canonical (the remote spells the name once). Non-git directories keep the exact prior behaviour, so every test fixture and scratch dir is unchanged; only real git working directories gain the fix. Resolved once per cwd and cached. This is forward-only: existing mis-homed tags are left as-is (a backfill that rewrites them touches real user data and will ship separately, opt-in, with a DB backup). Verified end-to-end that the core resolver and the hook-side mirror agree.
- **`pre-edit-recall` Strategy 1 (`file:<name>` tag lookup) had no producer and returned zero rows for every user** (`scripts/hooks/session-summary.js`) — the hook's most precise recall path queried `file:auth.ts` / `file:auth` tags that nothing ever wrote (0 `file:%` tags across the entire real database), so it was dead on arrival and all recall fell through to the filename-FTS proxy. Session capture now tags each session-insight entity with `file:<basename>` (both the full name and the extension-less form the read path queries) for every edited file, lighting the strategy up: a memory captured while editing a file becomes findable the next time that file is edited. Verified end-to-end (producer writes the tags → consumer injects the matching session-insight).
- **OpenAI tool export (`exportOpenAITools`) was missing `relations` + `namespace` on `remember` and `include_archived` + `namespace` + `cross_project` on `recall`** (`src/core/schema-export.ts`) — an agent driven off the exported OpenAI function schema literally had no parameter to send graph edges, so every entity it created was an orphan node with no relations, and it could neither scope by namespace nor search across projects/archives. The export now mirrors the `RememberSchema` / `RecallSchema` Zod definitions (the real validation source of truth) field-for-field. A new non-tautological parity test derives the expected fields from the Zod schemas themselves, so any future field added to the schema fails the export test until the export catches up (mutation-verified). The MCP/HTTP surface and `docs/api/API_REFERENCE.md` always had these fields — only this programmatic export had drifted.
- **Four core failure paths that silently no-op'd now trace to stderr, and `src/core` empty catches are now a lint error** (`src/core/config.ts`, `src/core/extractor.ts`, `src/core/failure-analyzer.ts`, `scripts/hooks/session-summary.js`, `eslint.config.js`) — each of these swallowed a real failure and returned an all-green empty result, so a broken install looked healthy. `readConfig()` returned `{}` on a corrupt/unreadable config (disabling every Smart-Mode feature and silently dropping a BYOK embedder back to 384-dim ONNX) — it now distinguishes a missing file (normal Core Mode, silent) from an existing-but-unreadable one, which traces once per (path, error) so it can't flood the hot path. `parseTranscript()` (both the core copy and the session-summary hook mirror) returned an empty result on any read error, emptying all session extraction downstream — it now stays silent on ENOENT (transcript not written yet) but traces a genuine I/O/permission fault. `analyzeFailure()` returned `null` both when the LLM call threw and when it succeeded-but-returned-unusable-JSON — the latter recorded `ok` telemetry while the self-improvement loop quietly died, so both now trace, distinguishing "call failed" from "call worked, reply unusable". To stop the class from regrowing, `no-empty` is now `error` with `allowEmptyCatch:false` scoped to `src/core/**`: a swallowed error there must carry a one-line reason (`catch { /* why */ }`), making every silent catch a decision someone wrote down. All traces are mutation-verified.
- **Windows: hook → dist dynamic imports silently threw, disabling LLM analysis, lessons, dream and auto-decay for 100% of Windows users** (`scripts/hooks/session-summary.js`, `scripts/hooks/session-start.js`, `scripts/hooks/_shared.js`, `scripts/release-verify.sh`) — ESM `import()` takes a URL, but seven call sites passed `import(join(pluginRoot, 'dist/...'))`, an absolute path. POSIX tolerates the leading `/`; on Windows `D:\...` is read as a `d:` URL scheme and rejected (`Only URLs with a scheme in: file, data, and node are supported`). Each caller's surrounding `catch` traced the error to stderr and moved on, so on Windows the Stop hook's failure analysis + lesson creation, the dream auto-trigger, and the session-start noise-compression/auto-decay all did nothing — while macOS/Linux and `memesh doctor` stayed green. The two init-time install-channel imports were already correct (`pathToFileURL().href`), so the discipline existed and simply stopped at these sites. Fixed at the root with a single shared `importFromPluginRoot(pluginRoot, relPath)` helper next to `resolvePluginRoot`, so the URL conversion is done correctly once and cannot drift per-site again; all seven sites now route through it. A new static gate in `tests/hooks/plugin-root-and-drift.test.ts` scans every shipped hook and fails on any `import(join(...))`, plus a behavioural test that the helper actually loads a real dist module (mutation-verified).
- **`memesh doctor` no longer downloads a ~90 MB model as a side effect** (`src/core/doctor.ts`) — v4.2.7 rewrote the embeddings row from a hardcoded `pass` into a real probe (correct), but the probe called `embedText()`, which on a cold cache downloads `Xenova/all-MiniLM-L6-v2` (~90 MB) into `~/.memesh/models`. A diagnostic command you reach for *because the network is misbehaving* must never be the thing that starts a large download, and a hosted BYOK embedder would additionally spend a billed API call. The probe now runs for real only when it is cheap and side-effect-free — a local ONNX model already on disk (`existsSync` check); a cold ONNX cache or any BYOK provider now renders an informational `NOT VERIFIED` row naming the reason, with `memesh doctor --probe` to opt into the download / live call. `--probe` behaves exactly as before. "Not verified" and "verified working" still render differently — the point of the v4.2.7 fix is preserved, only its unwanted side effect is removed.
- **Doctor tests could download the model into a temp dir mid-suite** (`tests/core/doctor.test.ts`) — none of the 30 `runDoctor()` call sites injected an `embedTextImpl`, so with the v4.2.7 real-probe the first doctor test to run did the 90 MB download into its per-test `MEMESH_DIR`; the ONNX pipeline is a module-level singleton that never releases its file handles, so `afterEach`'s `rmSync` then failed with `ENOTEMPTY` on windows-latest (green everywhere else). All calls now go through a wrapper that injects a stub embedder by default, and a new 8-test block locks in the no-download / no-bill contract (mutation-verified).
- **`llmFallbacks` is now settable, so cross-provider LLM failover actually engages** (`src/transports/cli/cli.ts`) — v4.2.0 shipped the whole consumer side of failover (`config.ts`, `consolidator`, `dream`, `session-summary`) but no setter: the key was absent from the CLI's `ALLOWED_KEYS` and the dashboard never sent it, so short of hand-editing `~/.memesh/config.json` the value stayed `[]` for everyone and all 5 Smart-Mode flows still died on the primary provider's first auth/rate error — the exact failure the feature exists to survive. `memesh config set llmFallbacks '[{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-..."}]'` now works, validated as a JSON array of objects each carrying a known provider.
- **`memesh dream list --status accepted` no longer silently returns nothing** (`src/transports/cli/cli.ts`) — accepting a proposal writes status `applied`, so `accepted` was a value no row could ever hold. Help text now lists the three real values: `pending | applied | rejected`.
- **Dashboard PM Metrics card was never rendering** (`dashboard/src/components/PmAnalyticsPanel.tsx`) — `api()` already unwraps the `{success, data}` envelope, but the component declared the envelope as its type argument and read `.data` a second time. The result was always `undefined`, `if (!data) return null` always fired, and the card silently vanished while the server recomputed velocity, staleness and KG orphan rate on every load.
- **The digest validator no longer reports `pass` when it never ran** (`src/core/digest-validator.ts`, `src/core/dreamer.ts`) — an unreachable LLM returned `status: 'pass'`, which is the same answer as "I checked every claim and they are all supported". A proposal was therefore recorded as validated when nothing had been validated. Failures now return a distinct `unavailable` status and trace to stderr. Behaviour is unchanged for callers (still never blocks a proposal); only the ability to tell "clean" from "not checked" is new.
- **A stray API key in your shell is no longer spent without a way to say no** (`src/core/config.ts`, `README.md`) — env auto-detect was originally opt-in behind `MEMESH_AUTO_DETECT_LLM=1` because an auto-detected `OPENAI_API_KEY` locked embeddings to 1536-dim. #36 fixed that properly by decoupling the embedder from the LLM provider, and F17 removed the gate — correctly. But the flag carried a second promise nobody re-homed: the README still told users "without this flag set, an `OPENAI_API_KEY` lying around in your shell is ignored". That had been false ever since, so a key present only for some other tool was silently used for every LLM write flow (consolidation, failure analysis, auto-tagging, dream) — the user's money, and their memory content sent to a provider they never chose here. Re-adding the opt-in would undo F17 and silently disable Smart Mode for everyone relying on env detection today, so the flag is now an explicit **opt-out**: auto-detect remains the default and `MEMESH_AUTO_DETECT_LLM=0` (also `false`/`no`/`off`) turns it off. An explicitly configured provider always wins over both. README corrected to describe what the code actually does.
- **Session-start recall now actually reaches the model** (`scripts/hooks/session-start.js`) — the hook emitted its entire payload as top-level `systemMessage`, which Claude Code renders to the human and **strips from the model's context** (`normalizeAttachmentForAPI` returns `[]` for the `hook_system_message` attachment). Combined with the v4.2.x switch to a count-only banner (`◉ MeMesh · 4 project + 5 recent memories`), this meant memesh ranked the top-N memories at every session start and then delivered **none of them** to the agent — the banner reported a memory count the model never received. The hook now emits two channels: the count banner stays in `systemMessage` for the human, and the ranked entities (lessons first, one observation snippet each, capped at 4000 chars) go out as `hookSpecificOutput.additionalContext` with `hookEventName: "SessionStart"`, which *is* injected into the model's context.
- **Recall-effectiveness scoring no longer penalises memories that were never shown** (`scripts/hooks/session-start.js`) — a direct consequence of the bug above. `session-summary.js` reads the session file written at start, and for every entity listed there increments `recall_hits` if its name appears in the transcript and `recall_misses` otherwise. Because the entities were never actually injected, virtually all of them took a `recall_miss` every session, driving `impactScore` (10% of ranking weight, Laplace-smoothed `hits/(hits+misses)`) toward zero for exactly the memories memesh had ranked highest — a self-reinforcing decay that buried good memories the agent was never given a chance to use. The session file now records the **real injected text** as `injectedContext` (previously the count banner), so the Stop hook can strip memesh's own injection from the transcript before deciding whether the session referenced a memory.
- **Stop hook no longer miscounts its own injection as memory usage** (`scripts/hooks/session-summary.js`) — the hit/miss check removed the injected block from the transcript with `transcriptText.replace(injectedContext, '')` and then substring-matched entity names. Transcripts are JSONL, so the injected text is JSON-encoded and a multi-line `replace()` of a ~2 KB block never matches — the injection stayed in and every injected entity scored a hit. Counting occurrences and requiring `transcript > injected` fails for the same underlying reason: Claude Code echoes ONE SessionStart injection into the transcript at least twice (`hook_success` carrying the raw stdout, plus `hook_additional_context`), so `2 > 1` holds for every entity. Both approaches depend on guessing an undocumented internal. The hook now strips the echo records structurally (`stripHookEchoes`) — matching on `attachment.type` in `hook_success` / `hook_additional_context` / `hook_system_message` — which is independent of both the copy count and the JSON escaping. Decision extracted to the exported, unit-tested `isRecallHit()`; its fixtures deliberately contain both echo records.
- **PreCompact hook no longer fails Claude Code's output validation on every compaction** (`scripts/hooks/pre-compact.js`) — closes [#53](https://github.com/PCIRCLE-AI/memesh/issues/53). The hook emitted `hookSpecificOutput.hookEventName: 'PreCompact'`, but Claude Code's hook-output schema defines `hookSpecificOutput` variants for exactly nine events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `SessionStart`, `Setup`, `SubagentStart`, `Notification`) — `PreCompact` is not among them, so the payload failed union discrimination at the root and every compaction surfaced `Hook JSON output validation failed — (root): Invalid input` to the user. The insight save itself always succeeded, so no data was ever lost; this was user-visible noise only. The hook now emits the same message via the top-level `systemMessage` field, which is valid for every event.
- **Test flake: `tests/transports/http.test.ts > returns array (possibly empty) for no-match query`** — assertion was `toHaveLength(0)`, but `recallEnhanced` may supplement FTS5 results with sqlite-vec near-neighbours when ONNX embeddings are loaded, so a query that misses FTS5 can still legitimately return a small set. The API contract is "always return a valid JSON array of entities, never a 500"; assertion now mirrors that contract (length bounded, all rows shaped like entities).
- **Test flake: `tests/tools.test.ts > auto-archives entity when superseded by new remember`** — same root cause; the `recall('JWT')` after archiving `auth-v2` asserted exactly `[]`, but vector supplement could surface the related `auth-v3`. The behavioural guarantee is "archived rows stay hidden from default recall", so the assertion now checks `not.toContain('auth-v2')` instead of empty-array.
- **Test isolation: `tests/hooks/pre-bash-orchestration-nudge.test.ts` no longer reads the developer's real `~/.memesh/config.json`** — `isAgenticOrchestrationEnabled()` falls back to `readHookConfig()` when the env var is unset, and `readHookConfig()` reads `<memeshDir>/config.json`. The "default off" test deleted the env var but didn't pin `MEMESH_DIR`, so a developer with `enableAgenticOrchestration: true` in their personal config saw the test fail even though hook code was correct. Both the test helper and the gate-off case now point `MEMESH_DIR` at the per-test tmpdir.

### Added
- **Shared hook-output contract + cross-hook CI gate** (`tests/helpers/hook-output-contract.ts`, `tests/hooks/hook-output-contract.test.ts`) — root-cause fix for the class of bug behind #53, not just the one instance. Every hook test previously hand-asserted the shape its own hook happened to emit, so the assertions mirrored the implementation and stayed green while the implementation violated the external schema (`tests/hooks/pre-compact.test.ts` asserted the invalid `PreCompact` variant, actively locking the bug in). The new helper encodes the real contract — 7 valid top-level fields and the 9 events that have a `hookSpecificOutput` variant — extracted from the shipped Claude Code CLI bundle (v2.1.19) rather than from the public docs, which list every hook *event* and are not the same set. The new test drives all 7 shipped hooks and validates their stdout against that contract, asserts each hook's declared `hookEventName` matches the event it is bound to in `hooks/hooks.json`, and fails if a hook is added to `hooks.json` without a contract case. Verified non-vacuous by re-introducing the #53 payload and confirming the gate fails.

## [4.2.7] — 2026-05-13

### Added
- **`memesh doctor` Shell CLI check** (`src/core/doctor.ts`) — new check `Shell CLI on PATH` resolves `memesh` via the user's shell PATH (`which` / `where`) and detects the most common plugin-marketplace gotcha: plugin is installed (MCP + hooks + `/memesh` skill work) but `memesh` is NOT on the shell PATH, so typing `memesh reindex` in a terminal yields `command not found`. WARN on plugin-marketplace installs without a separate shell-PATH `memesh`, with the exact fix command (`npm install -g @pcircle/memesh`) and the clarification that both paths coexist and share the same DB. Informational PASS on `npm-global` (running from the install itself), `source-checkout` (informational only), and any plugin-marketplace install that already has a separate shell-PATH `memesh`. Mirrors the new "Install paths at a glance" section landed in v4.2.6 docs — users who hit the gotcha now get told by doctor instead of having to re-read the README.
- **`memesh export -o <file>` flag** (`src/transports/cli/cli.ts`) — `memesh export` now accepts an `-o, --out <file>` flag that writes the JSON snapshot directly to a file. Previously the only path was stdout redirect (`memesh export > backup.json`) which wasn't documented in `--help`, so users coming from CLI conventions of every other tool tried `-o backup.json` first and saw `error: unknown option '-o'`. Stdout mode is preserved as the default (pipe-friendly). The file mode also prints a one-line confirmation to stderr so the user knows it landed.

### Changed
- **`memesh forget --confirm` is now accepted as a no-op** (`src/transports/cli/cli.ts`) — `memesh forget` is a soft archive, no confirmation gate is needed, but rejecting the flag outright as `unknown option` was hostile to users coming from `rm -i` / `git branch -D` conventions. Adding the flag as a documented no-op (marked `[deprecated, no-op]` in `--help`) closes the surprise without changing semantics.
- **`memesh install-hooks` refuses to double-wire over an active plugin install** (`src/core/install-hooks.ts`) — when Claude Code's plugin runtime is already loading memesh's hooks (via `/plugin install memesh@pcircle-memesh`), writing the same hooks into `~/.claude/settings.json` would cause every event (session-start, Stop, PreToolUse, etc.) to fire memesh's hook scripts **twice** — duplicate `session-insight` entities, duplicate recall injections, duplicate orchestration nudges. `installHooks()` now detects the plugin install via `~/.claude/plugins/installed_plugins.json` and bails with a clear message naming the install path + version, leaving the user with a `--force-over-plugin` escape hatch for the rare case where double-firing is intentional. CLI surface (`memesh install-hooks`) surfaces the new state directly so the message is visible without a JSON return inspection.
- **`memesh install-hooks --dry-run` wording is now future-tense** — was "Added 7 hook entries, skipped 0" (past-tense in dry-run mode is misleading); now "Would add 7 / would skip 0".

### Fixed
- **HTTP server: unknown routes return JSON 404** (`src/transports/http/server.ts`) — previously the server fell through to Express's default `text/html` 404 page (`<!DOCTYPE html>...Cannot GET /v1/whatever`). Every other route returns `{success, data}` JSON, so a typo'd path broke clients piping through `JSON.parse`. A catch-all JSON 404 middleware now sits at the end of the router and returns `{success: false, code: "NOT_FOUND", error: "No route for <METHOD> <path>"}`.

### Docs
- **README (English + Thai) upgrade-plugin.sh instruction now covers pre-v4.2.5 users** (`README.md`, `README.th.md`) — the v4.2.6 release notes told users to run `bash ~/.claude/plugins/cache/pcircle-memesh/memesh/<v>/scripts/upgrade-plugin.sh`, but plugin installs created before v4.2.5 don't contain this file (it was added in v4.2.5). Existing v4.2.3 / v4.2.4 users have no way to bootstrap the upgrade from inside their plugin install. Added a fallback line pointing at the npm-global copy (`$(npm prefix -g)/lib/node_modules/@pcircle/memesh/scripts/upgrade-plugin.sh`), which works the moment the user runs `npm install -g @pcircle/memesh` (which they already need for shell CLI access — see the "Install paths at a glance" section). Other 9 locale READMEs still need a full `## Upgrading` section to host this note; will follow up.

## [4.2.6] — 2026-05-13

### Fixed
- **`memesh doctor` and hook self-heal now follow npm hoisting** (`src/core/doctor.ts`, `scripts/hooks/_shared.js`) — the v4.2.5 native-binding check pre-checked `<packageRoot>/node_modules/better-sqlite3` literally, but when memesh is installed as a dependency npm hoists `better-sqlite3` to the consumer's top-level `node_modules/`. Result: every fresh `npm install @pcircle/memesh` saw a FAIL on the native-binding check even though the binding worked correctly. Both surfaces now resolve via `require.resolve('better-sqlite3', { paths: [pkgRoot] })`, which follows Node's normal resolution algorithm and finds hoisted packages. The hook's `npm rebuild` self-heal also targets the correct project root now (the package that owns the hoisted `node_modules`), not memesh's own pkgRoot.
- Doctor test `reports FAIL when node_modules/better-sqlite3 is entirely missing` updated to `reports FAIL with npm install hint when better-sqlite3 is not resolvable` — exercises the MODULE_NOT_FOUND probe response now that the existence-check branch is gone.

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
- **Cross-provider LLM failover** (`src/core/llm-client.ts` + `config.ts`) — new optional `llmFallbacks: LLMConfig[]` config field walked in order when the primary `llm` provider fails with auth / rate-limit / upstream / network errors. A 400-class bad-request stops the chain (the prompt itself is broken). Per-attempt telemetry surfaces via `opts.onAttempt`; secret-shaped tokens (`sk-*`, `Bearer *`) are redacted before reaching telemetry. Wired into all 5 Smart-Mode flows (dreamer, pattern-detector, consolidator, auto-tagger, failure-analyzer). Accepted by the `POST /v1/config` endpoint with mirrored apiKey masking on GET responses. (Correction, 2026-07: the released v4.2.0 shipped no way to actually SET this field — it was missing from the CLI's allowed config keys and the dashboard never sent it, so `llmFallbacks` stayed `[]` on every install and the failover path never engaged. Fixed in Unreleased below.)
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
  /plugin marketplace add PCIRCLE-AI/memesh      # repo URL unchanged
  /plugin install memesh@pcircle-memesh                      # was: memesh@pcircle-ai
  ```
  Only the marketplace identifier changed (`pcircle-ai` → `pcircle-memesh`). The plugin name (`memesh`) and the GitHub repo (`PCIRCLE-AI/memesh`) stay the same.
- **`.claude-plugin/marketplace.json`** `name` field: `"pcircle-ai"` → `"pcircle-memesh"`. The marketplace is now uniquely identifiable per plugin, which lets a user have all PCIRCLE AI plugin marketplaces registered simultaneously without collision.

### Migration for v4.1.6 plugin users
If you ran `/plugin marketplace add PCIRCLE-AI/memesh` on v4.1.6, the registered marketplace name was `pcircle-ai`. After this release, run these once to switch to the new name:

```
/plugin marketplace remove pcircle-ai
/plugin marketplace add PCIRCLE-AI/memesh
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
  /plugin marketplace add PCIRCLE-AI/memesh
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
- A `.claude-plugin/marketplace.json` companion (so users can `claude plugin marketplace add PCIRCLE-AI/memesh`) is a deliberate follow-up, not part of this release.

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
_Note: The GitHub repository is [PCIRCLE-AI/memesh](https://github.com/PCIRCLE-AI/memesh). The npm package is [@pcircle/memesh](https://www.npmjs.com/package/@pcircle/memesh)._
