# MeMesh Plugin Architecture

**Version**: 4.8.2

> Looking for "which file do I change for X?" — see [CODEMAP.md](../CODEMAP.md).

---

## Overview

MeMesh is the local agentic-memory and governed-collaboration layer for individual AI coding agents, including Claude Code, Codex, Gemini, Cursor, and other MCP-compatible clients. It provides 11 MCP tools (`remember`, `recall`, `forget`, `export`, `import`, `learn`, `task_state`, `briefing`, `user_patterns`, `improvement`, `message`) backed by SQLite with FTS5 full-text search and optional sqlite-vec vector embeddings. Memory and durable exact-recipient messaging are available through CLI, HTTP REST, and MCP; `improvement` stages proposals through MCP while the existing CLI/HTTP review surfaces retain human accept/reject authority.

The package is intentionally local-first and inspectable:
- one SQLite database under the user's control
- no cloud service required
- Claude Code hook integration for session-start, pre-edit recall, user-prompt-intent detection, post-commit capture, session-summary learning, and pre-compact save
- optional smarter retrieval and extraction when an LLM is configured

This repository is the standalone local package. Hosted workspace and enterprise operating-system products are intentionally out of scope for this package architecture.

```
                     ┌─────────────┐
                     │  core/      │
                     │  operations │
                     └──────┬──────┘
            ┌───────────────┼───────────────┐
            │               │               │
     transports/cli   transports/http  transports/mcp
     (memesh CLI)     (memesh serve)   (memesh-mcp)
                             │
                     KnowledgeGraph
                             │
                     SQLite (FTS5 + sqlite-vec)
```

## Package Entry Points

| Executable | Source entry point |
|---|---|
| `memesh` | `src/transports/cli/cli.ts` |
| `memesh-mcp` | `src/mcp/server.ts` |
| `memesh-http` | `src/transports/http/server.ts` |
| `memesh-router` | `src/host-runtime/router.ts` |
| `memesh-host-claude` | `src/host-runtime/claude.ts` |
| `memesh-host-codex` | `src/host-runtime/codex.ts` |
| `memesh-host-codex-session` | `src/host-runtime/codex-session.ts` |
| `memesh-host-acp` | `src/host-runtime/acp.ts` |

`memesh-host-acp` is experimental protocol-development code, not a release-gated native-wakeup provider.

---

## Core/Transport Architecture

MeMesh separates concerns into two layers:

**Core** (`src/core/`) — pure business logic with zero transport dependencies:
- `types.ts` — shared TypeScript interfaces (zero external deps)
- `operations.ts` — `remember`, `recall`, `forget`, `export`, `import` as pure functions called by all transports
- `agent-messaging.ts` — transactional exact-recipient messages, opaque cursors, bounded waits, payload fetch, and independent receipt facts
- `agent-router.ts` — owner-private local routing from a durable message event to an eligible active host adapter; native wakeups carry routing metadata, never the payload
- `config.ts` — config management + capability detection (incl. `llmFallbacks` chain); exports `logCapabilities()` for startup logging
- `paths.ts` — centralised filesystem path resolution (HOME-first override; shared with hooks via a build-generated copy in `scripts/hooks/_generated/`)
- `scoring.ts` — multi-factor scoring engine: weights search relevance, recency, frequency, confidence, recall-impact; exports `rankEntities()` used by all recall paths
- `llm-client.ts` — single dispatch for anthropic / openai / ollama with cross-provider failover, error classification, and per-attempt telemetry callback
- `ollama-host.ts` — one trust policy for configured Ollama hosts: persisted/request values stay loopback-only while operator `OLLAMA_HOST` remains the explicit remote override
- `llm-telemetry.ts` — `llm_telemetry` SQLite table + `recordTelemetry()` + `summariseTelemetry()` + `pruneTelemetry()` retention
- `dreamer.ts` — LLM cluster compactor + pattern detector with propose/accept/reject lifecycle; auto-trigger from Stop hook; also the entry point for the `--from-transcripts` transcript-mining source.
  Clusters are formed from `entities_vec` embedding distance (L2 cut-off `0.55`, measured — see the constant), with the project a hard partition. Candidates with no vector are grouped by ISO week instead of being dropped, and a graph with no vectors at all falls back to week buckets entirely; `DreamerResult.clusteringMode` reports which rule was used, because a week bucket can mix unrelated work. `cluster_key` is a display label, not the grouping rule — a proposal is identified by its source ids.
- `digest-validator.ts` — opt-in second-pass LLM cross-check on dreamer digests (`pass | soften | reject`)
- `transcript-source.ts` — read-only discovery half of transcript mining: locates the session JSONL files Claude Code writes for a project and reports what is available to mine (no LLM, no writes); dropout-proof because it reads the files directly rather than relying on the capture hook having fired
- `transcript-extractor.ts` — extraction half: reads a session's conversation, asks the LLM for the durable memories hidden in the prose, drops any candidate carrying a secret, vector-dedups against entities already in the graph, and stages the rest as `dream_proposals` for human `dream accept` (emits the `transcript_extractor` telemetry flow)
- `kg-backfill.ts` — non-LLM heuristic relation backfill: 4 rules (tag co-occurrence, project clustering, session co-occurrence, name-token similarity)
- `project-tags.ts` — list / merge / rename `project:<name>` tags (heals tags mis-homed before git-based project identity); backs `memesh kg rename-project`
- `prompt-safety.ts` — F7 prompt-injection hardening (delimiter escaping for 3 LLM call sites)
- `failure-analyzer.ts` / `auto-tagger.ts` / `digest-validator.ts` — Smart-Mode LLM flows (all use `callLLM` failover + telemetry)
- `version-check.ts` — npm registry version check for update notifications
- `why.ts` — file attribution (`memesh why` / `POST /v1/why`): a git half (`resolveFileCommits`, CLI-only — the HTTP route never shells out) and a DB half (`explainCommits`) joining full SHAs to the abbreviated-hash `commit-*` entity names, walking `metadata.session_id` to session entities, and collecting `file:<basename>`-tagged memories; every gap is a typed abstention

**Transports** (`src/transports/`) — thin adapters that expose core operations:
- `cli/cli.ts` — Commander CLI (`memesh` command, 30 top-level commands; `message`, `agent`, `config`, `kg`, and `dream` have subcommands)
- `http/server.ts` — Express REST API server (`memesh serve`, default port 3737, 37 endpoints, bearer-auth gate when bound non-loopback)
- `agent-messaging.ts` — shared MCP/HTTP/CLI dispatcher that binds provenance at the transport boundary and never turns a read into a receipt
- `src/mcp/server.ts` + `src/transports/mcp/handlers.ts` — stdio MCP server (`memesh-mcp`, 11 tools); `src/mcp/tools.ts` is a re-export shim

This separation means the same `remember`/`recall`/`forget` logic runs identically whether invoked from a terminal, an HTTP request, or an MCP tool call. Governed product-improvement proposals reuse the dream staging/review lifecycle: agents can propose over MCP, and humans apply or reject through the CLI or dashboard-backed HTTP endpoints.

---

## Source Structure

```
src/
├── core/
│   ├── types.ts           # Shared types (zero external deps)
│   ├── operations.ts      # remember/recall/forget/learn + re-exports export/import
│   ├── serializer.ts      # Export/import memory snapshots (extracted from operations)
│   ├── config.ts          # Config management + capability detection + logCapabilities()
│   ├── paths.ts           # Centralised path helpers (homeDir, memeshDir, getDbPath, getProjectName)
│   ├── scoring.ts         # Multi-factor scoring engine (rankEntities) + SESSION_START_WEIGHT_RATIO
│   ├── extractor.ts       # Session knowledge extraction (rule-based + LLM)
│   ├── lifecycle.ts       # Auto-decay + weekly noise compression
│   ├── failure-analyzer.ts # LLM-powered failure analysis → StructuredLesson
│   ├── lesson-engine.ts   # Structured lesson creation, upsert, project query
│   ├── embedder.ts        # Neural embeddings via Ollama (768-dim) / OpenAI (1536-dim); keyword-only FTS5 fallback when none configured
│   ├── auto-tagger.ts     # LLM-powered auto-tag generation (fire-and-forget)
│   ├── llm-client.ts      # Single dispatch for anthropic/openai/ollama + cross-provider failover + secret redaction
│   ├── ollama-host.ts     # Shared configured-host trust policy for Ollama
│   ├── llm-telemetry.ts   # llm_telemetry table + recordTelemetry + summariseTelemetry + pruneTelemetry
│   ├── llm-validator.ts   # Provider+model capability detection (list models, byte-capped fetch)
│   ├── prompt-safety.ts   # F7 prompt-injection hardening (sanitizeForPrompt for 3 call sites)
│   ├── dreamer.ts         # LLM cluster compactor + pattern detector (propose/accept/reject); entry point for --from-transcripts
│   ├── product-improvements.ts # Idempotent evidence-linked proposals + status; human review remains in dreamer
│   ├── digest-validator.ts # Opt-in second-pass LLM cross-check on dreamer digests
│   ├── transcript-source.ts    # Read-only discovery: find a project's session JSONL to mine (no LLM, no writes)
│   ├── transcript-extractor.ts # Mine conversational memory from a session → sanitise → vector-dedup → stage dream_proposals
│   ├── kg-backfill.ts     # Heuristic relation backfill (tag co-occurrence + project clustering)
│   ├── patterns.ts        # User work patterns computation (shared by MCP + HTTP)
│   ├── doctor.ts          # `memesh doctor` health check (runtime / install / hooks / DB / capabilities)
│   ├── demo.ts            # `memesh demo` 30-entity onboarding seed
│   ├── memory-tool.ts     # Anthropic memory_20250818 adapter over the knowledge graph
│   └── version-check.ts   # npm registry version check
├── db.ts                  # SQLite + FTS5 + sqlite-vec + migrations
├── knowledge-graph.ts     # Entity CRUD, relations, FTS5 search, findConflicts
├── index.ts               # Package exports
├── cli/
│   └── view-live.ts       # Legacy HTML dashboard generator
├── host-adapters/         # Native Claude/Codex adapters; ACP remains experimental and not release-gated
├── host-runtime/          # Private-router connection and managed host runtime
├── mcp/
│   ├── server.ts          # MCP stdio server (logs capabilities on startup)
│   └── tools.ts           # Re-export shim → transports/mcp/handlers.ts
└── transports/
    ├── schemas.ts         # Shared Zod validation schemas (single source of truth)
    ├── mcp/
    │   └── handlers.ts    # MCP tool handlers (imports schemas, ToolResult wrapper, conflict detection)
    │                      # NOTE: server.ts lives in src/mcp/ (see below), NOT here
    ├── http/
    │   └── server.ts      # Express REST API server (imports schemas, 1MB body limit, rate limiting)
    └── cli/
        └── cli.ts         # Commander CLI (conflict warnings in recall output)
```

---

## Modules

### src/core/ -- Core Layer

**types.ts** — Shared TypeScript interfaces used across all transports. No external dependencies.

**operations.ts** — Pure functions implementing `remember`, `recall`, `forget`, `learn`, and others. All three transports delegate here — no transport-specific logic leaks into business logic.

**config.ts** — Config management: reads `MEMESH_DB_PATH` and other environment variables, detects sqlite-vec availability, exposes a typed config object to transports and core functions. `logCapabilities()` logs detected search level and LLM provider to stderr on server startup (safe for MCP stdio transport). The on-disk config path is resolved lazily via `paths.ts:memeshDir()` so HOME-first override works in hermetic Windows tests.

**paths.ts** — Centralised filesystem path resolution. Exports `homeDir()` (HOME-env-first override for testability), `memeshDir()` (MEMESH_DIR > `<home>/.memesh`), `getDbPath()` (MEMESH_DB_PATH > `<memeshDir>/knowledge-graph.db`), `getMemeshDirFromDbPath()` (parent dir of active DB file, used for sibling state files), and `getProjectName(cwdInput?)` (layered project identity: git remote slug → git repo root basename → cwd basename, resolved once per cwd and cached; the git layers make a memory captured in a subdirectory share identity with one captured at the repo root, and collapse case/path variants of the same repo). Replaces 10+ inline `process.env.MEMESH_DB_PATH ?? path.join(os.homedir(), …)` patterns that had subtly different fallbacks. Hooks run the always-on capture path even when `dist/` is absent or stale (plugin-marketplace `--ignore-scripts`; source pull before build), so they cannot import the main `dist/` tree at will. Because `paths.ts` and `src/storage/fts-index.ts` are runtime-leaf modules, `npm run build` copies their compiled output to `scripts/hooks/_generated/` (via `scripts/generate-hook-core.mjs`); `_shared.js` imports that committed, version-locked copy. This replaces the former hand-mirror (the source of the P0 FTS drift): the copy is byte-locked to core and gated three ways — a CI `git diff` on rebuild, `tests/hooks/mirror-parity.test.ts`, and the `memesh doctor` manifest.

**scoring.ts** — Multi-factor scoring engine. `scoreEntity()` combines five signals from `DEFAULT_WEIGHTS`: search relevance (0.30), recency via exponential decay (0.25), access frequency via log normalization (0.18), confidence (0.17), and recall-effectiveness impact via Laplace smoothing (0.10). `rankEntities()` sorts any entity list by score descending. Applied in all recall paths (`recall()` and `recallEnhanced()`).

Session-start hook ranking is a SQL-only subset (no FTS query, no impact pass) that uses three of the five factors. `SESSION_START_WEIGHT_RATIO` exports the renormalised weights so the hook's hard-coded SQL stays in sync; a drift-guard test in `tests/core/scoring.test.ts` asserts the magic numbers in `scripts/hooks/session-start.js` match. The hook SQL uses SQLite's `exp()`/`log()` (present in Node's bundled SQLite) to match the core math exactly, with a runtime probe + linear/rational fallback for stripped-down builds without `-DSQLITE_ENABLE_MATH_FUNCTIONS`.

**(retired) query-expander.ts** — LLM-powered query expansion was removed in 2026-05 after LongMemEval-S Mode A (FTS5 + sqlite-vec, no LLM) measured well above the LLM-augmented alternative's expected ceiling. The figure quoted at the time (95.40%) came from the benchmark's own reimplementation of retrieval rather than from this code; measured through `recallEnhanced()` the same 500 questions now score 95.60% R@5 in 9.1s, within 1.0pp of vendor reranker stacks. The expander cost ~500-10000ms per recall for an estimated 1-2pp ceiling lift, decisively losing the UX axis given that recall is the hot path for hooks (`pre-edit-recall`, `session-start`) and MCP agent calls. Recall is now strictly LLM-free; LLM augmentation is reserved for the async/analysis flows below (failure-analyzer, auto-tagger, dreamer, digest-validator, llm-validator).

**failure-analyzer.ts** — LLM-powered failure analysis (Level 1). `analyzeFailure()` takes session errors and files edited, sends them to the configured LLM, and returns a `StructuredLesson` with error, root cause, fix, prevention, error/fix patterns, and severity. Used by the Stop hook to automatically create lessons from session failures.

**lesson-engine.ts** — Structured lesson management. `createLesson()` stores a `StructuredLesson` as a `lesson_learned` entity with upsert-safe naming (`lesson-{project}-{errorPattern}`). Same error pattern in different sessions updates the existing lesson. `createExplicitLesson()` supports the `learn` MCP tool; an explicit lesson with no caller-supplied `errorPattern` is keyed on a human-readable prefix plus a short digest of its complete normalised error (`lesson-{project}-{readable-prefix}-{digest}`), so lessons that share their first eight significant words still remain distinct while a resubmitted lesson appends — the seven-value `inferErrorPattern()` set is a coarse classifier, and keying explicit lessons on it fused everything outside those categories into one `-other` bucket per project. `findProjectLessons()` queries lessons for proactive warnings.

**patterns.ts** — User work patterns computation (shared by MCP `user_patterns` tool and HTTP `GET /v1/patterns`). `computePatterns()` queries the database for work schedule (hour/day distribution), tool preferences, focus areas, workflow metrics, strengths, and learning areas. Accepts optional `categories` filter array.

**memory-tool.ts** — Executes Anthropic's `memory_20250818` tool against the knowledge graph. The tool is client-side: Claude requests file operations and the application performs them, and Anthropic's contract states that `/memories` is "a prefix that your handler maps onto real storage, such as a per-user directory or keys in a database". Here that storage is MeMesh, so a model using the plain Messages API gets search, ranking, decay, relations and namespaces underneath a file-shaped view. Each entity renders as one file whose lines are its observations, **ordered by observation id** — insertion order, never score, because `view` and the edit that follows it are separate turns and a hook writing in between would otherwise move the lines the model just read. Deliberately not a tenth MCP tool: the MCP surface serves an agent that already speaks MeMesh, this serves an application that speaks only the Messages API.

**version-check.ts** — Queries the npm registry for the latest `@pcircle/memesh` version and emits an update notification if the installed version is behind.

### db.ts -- Database Layer

Manages the SQLite connection lifecycle and schema initialization.

- `openDatabase(path?)` -- Opens (or reuses) a SQLite connection
- `closeDatabase()` -- Closes the connection
- `getDatabase()` -- Returns the active connection (throws if not opened)
- Schema: Creates tables (`entities`, `observations`, `relations`, `tags`) and FTS5 virtual table (`entities_fts`)
- Pragmas: WAL journal mode, foreign keys enabled

Default database path: `~/.memesh/knowledge-graph.db` (overridable via `MEMESH_DB_PATH`).

### knowledge-graph.ts -- Knowledge Graph

CRUD operations and full-text search over the entity graph.

**Entity operations**:
- `createEntity(name, type, opts?)` -- Insert or ignore, add observations/tags, rebuild FTS index
- `createEntitiesBatch(entities[])` -- Wraps multiple creates in a single SQLite transaction
- `getEntity(name)` -- Full entity with observations, tags, and relations
- `deleteEntity(name)` -- Cascading delete (observations, relations, tags, FTS entry)

**Relation operations**:
- `createRelation(from, to, type, metadata?)` -- Insert or ignore
- `getRelations(entityName)` -- All outgoing relations for an entity

**Search**:
- `search(query?, opts?)` -- FTS5 MATCH query with optional tag filtering; tracks access on returned entities (access only — `recall_hits`/`recall_misses` belong to the Stop hook, the one place that can tell whether an injected memory was USED). With `includeArchived`, archived rows are matched by `LIKE` on the same terms, since `archiveEntity()` removes them from FTS5. Query terms are OR-ed (a bare space is FTS5's implicit AND, which required every word of a question to appear in one memory) and rows are ordered by FTS5 `rank` (BM25) with `e.id DESC` as the tiebreaker — `LIMIT` decides what survives to the scorer, so ordering by id alone discarded the best match before it could be scored, and leaving equal-ranked rows unordered made the same query return different sets on different runs. A non-empty query whose terms all tokenise away (`"???"`, a lone emoji) now returns `[]` rather than the recent list, on the vector-supplement path as well as the keyword one. Terms are capped at `MAX_QUERY_TERMS` (32) so a pasted log dump cannot build an unbounded disjunction, and `dropUbiquitousTerms()` removes any term present in more than half the corpus — those are the terms BM25 already scores near zero, and OR-ing them makes the scan proportional to the whole index (measured 80.15ms → 8.57ms at 100k rows, with R@5 unchanged). Document frequency comes from `fts_vocab`, an `fts5vocab` view over `entities_fts`; the guard stays out below 25 rows, where document frequency has no meaning, and falls back to the full term list if the view is absent. `buildMatchExpression()` splits on the boundaries `unicode61` itself uses — `[\p{L}\p{N}\p{M}]+` over an NFC-normalised query — rather than on whitespace, so `kitchen's` does not become the phrase `kitchen s` and decomposed text stays whole. Before splitting, both the query and the indexed text pass through `segmentUnspacedScripts()` (`src/storage/fts-index.ts`), which cuts runs of any spaceless script — CJK ideographs (including Extension A and, above the BMP, Extension B), kana, half-width katakana, hangul, Thai, Lao and Khmer — into overlapping character bigrams: `unicode61` indexes an unbroken run as a single token, so a Chinese memory used to be reachable only by its exact stored string. The list is by writing system, not by language reported: an earlier version covered only CJK, kana and hangul and left Thai, Lao, Khmer, half-width katakana and Extension B with the identical defect. Bigrams are built over code points, not UTF-16 code units, so a boundary between a BMP and a non-BMP character still produces a real token instead of a split surrogate pair. Index side and query side must use that same function — `tests/cjk-recall.test.ts` pins it. A lone unspaced-script character becomes a prefix query, which reaches every bigram starting with it. The optional tag filter is an `EXISTS` subquery rather than a join, so one statement serves every filter combination without `SELECT DISTINCT`.
- `listRecent(limit?)` -- Most recent entities by ID
- `findConflicts(entityNames[])` -- Returns conflict descriptions for any `contradicts` relations among the given entity names; surfaced as warnings by all three transports

FTS5 is configured as a contentless virtual table (`content=''`). The `rebuildFts()` method handles explicit insert/delete operations required by contentless FTS5.

### mcp/server.ts -- MCP Server

Entry point for the `memesh-mcp` binary and the MCP server itself. Creates the server with stdio transport, registers tool handlers from `handlers.ts`, opens the database on startup.

There used to be a `launcher.ts` in front of it whose whole job was to instantiate an in-memory better-sqlite3 database, detect a missing native binding, run `npm rebuild`, and re-exec the process for a clean module cache. `node:sqlite` has no binding to miss, so the guard and its re-exec are gone and the bin points straight at the server.

### transports/mcp/handlers.ts -- MCP Tool Handlers

Thin adapter: imports shared Zod schemas from `transports/schemas.ts`, validates input, delegates to `core/operations`, wraps result in MCP `ToolResult` format.

| Tool | Schema | Handler |
|------|--------|---------|
| `remember` | RememberSchema | Delegates to `operations.remember()` |
| `recall` | RecallSchema | Delegates to `operations.recallEnhanced()` |
| `forget` | ForgetSchema | Delegates to `operations.forget()` |
| `export` | ExportSchema | Delegates to `operations.exportMemories()` |
| `import` | ImportSchema | Delegates to `operations.importMemories()` |
| `learn` | LearnSchema | Delegates to `operations.learn()` |
| `task_state` | TaskStateSchema | Delegates to `core/task-state-store` (`getTaskState()` with no fields, `setTaskState()` otherwise) |
| `briefing` | BriefingSchema | Delegates to `core/briefing.assembleBriefing()` |
| `user_patterns` | UserPatternsSchema | Delegates to `core/patterns.computePatterns()` |
| `improvement` | ImprovementSchema | Delegates to `core/product-improvements` for proposal staging and status reads |
| `message` | MessageSchema | Delegates to `transports/agent-messaging.executeAgentMessageAction()` |

### transports/http/server.ts -- HTTP REST API Server

Express server exposed via `memesh serve` (default port 3737; the endpoint count is stated once, in the module list above, and checked against `server.ts` by `scripts/check-doc-claims.mjs`). Delegates all operations to `core/operations`. Includes `GET /v1/analytics` for computed health score, 30-day timeline, value metrics, and cleanup suggestions. See [HTTP REST API](#http-rest-api) in the API Reference.

### transports/cli/cli.ts -- CLI

Commander-based CLI exposed via the `memesh` binary. It registers the 30 top-level commands catalogued in the module list above; `scripts/check-doc-claims.mjs` derives and verifies that count from `cli.ts`.

### dashboard/ -- Packaged Dashboard SPA

The primary dashboard is now the packaged Preact single-page app served by `GET /dashboard` from `dashboard/dist/index.html`.

- packaged with the npm artifact under `dashboard/dist/`
- preferred over the legacy HTML generator path
- used for live local inspection and settings/config flows

**Dashboard tabs**:

| Tab | Feature |
|-----|---------|
| Home | Dreamer insights (weekly recaps, pattern proposals, accept/reject) leading; the analytics stack — health score, 30-day timeline, **MemoryAgeMatrix** (type × age heat map), **KnowledgeRadar** (6-axis SVG), work patterns — folded into a lazy expander that defers its fetches until first opened |
| Memories | The whole library behind one surface: instant client filter + Enter for server-ranked recall, work-layer / evidence / all / archived scope chips (`layerOf()` over the shared `WORK_LAYER_TYPES` whitelist), cluster composition bar, per-row expandable detail (structured lesson bodies via `LessonCards`), inline archive/restore |
| Project | One project's roadmap (phases, milestones, key lessons) behind a project selector |
| Graph | Interactive knowledge graph with **signal-first node loading**, **access_count node sizing**, and **Drift Mode** (recency coloring) |
| Settings | LLM provider setup, capabilities, and language selection |

The dashboard is a client of the ordinary HTTP API — no private endpoints — so the endpoint list lives in exactly one place: the route table in [API_REFERENCE.md](api/API_REFERENCE.md#http-rest-api), which `scripts/check-doc-claims.mjs` checks against `server.ts`'s registrations. A copy of it used to sit here and had already rotted: it named seven endpoints and missed `/v1/graph/evidence` and `/v1/projects`, both of which the dashboard calls. A second list nothing gates is a list that goes quietly wrong. When the packaged build is unavailable, the HTTP server falls back to the legacy `cli/view-live.ts` HTML generator for compatibility.

**Graph data contract**: `/v1/graph` returns `{ entities, relations, noiseTypes }` — `noiseTypes` is the server-supplied list of high-volume / low-diagnostic types (`session_keypoint`, `commit`, etc.) the dashboard default-hides. Single source of truth lives in `src/core/analytics.ts NOISE_TYPES`.

---

## Data Flow

### Store knowledge (remember)

```
Tool call: remember({name, type, observations, tags, relations})
  -> Zod validation (RememberSchema)
  -> KnowledgeGraph.createEntity(name, type, {observations, tags})
     -> INSERT OR IGNORE into entities
     -> INSERT observations
     -> Rebuild FTS5 index
     -> INSERT OR IGNORE tags
     -> Preserve original type on duplicate entity names
  -> KnowledgeGraph.createRelation() for each relation
  -> Return {stored: true, entityId, ...}
```

### Wake an eligible local message recipient (optional)

```
message send (MCP / HTTP / CLI)
  -> durable exact-recipient message + notification event in SQLite
  -> owner-private local agent router
  -> eligible active supported host adapter (for example, configured Codex)
  -> routing-metadata marker only
  -> recipient explicitly fetches the durable payload with message fetch
```

Implementation anchors: `src/core/agent-messaging.ts`, `src/core/agent-router.ts`,
`src/transports/agent-messaging.ts`, `src/host-adapters/`, `src/host-runtime/`, and
`docs/platforms/agent-messaging.md`.

This branch is optional and local-only: unavailable, stopped, disconnected, or unsupported sessions are not resumed or replaced. A host queue acceptance is a host receipt, not recipient acknowledgement or workflow disposition. See the [`message` API contract](api/API_REFERENCE.md#message) and the [Local Agent Messaging Guide](platforms/agent-messaging.md) for the lifecycle and supported-host limits.

### Search knowledge (recall)

```
Tool call: recall({query, tag, limit})
  -> Zod validation (RecallSchema)
  -> recallEnhanced() in core/operations
     -> KnowledgeGraph.search() — FTS5 keyword match
     -> supplementWithVectors() — sqlite-vec embedding similarity merge
     -> rankEntities() applies multi-factor scoring (relevance, recency, frequency, confidence, impact)
     -> KnowledgeGraph.findConflicts() checks for contradicts relations among results
  -> If conflicts: return {entities, conflicts}; else return Entity[]
```

### Mine memory from transcripts (`dream run --from-transcripts`)

```
memesh dream run --from-transcripts   (current project only)
  -> transcript-source.ts: locate this project's session JSONL files (read-only)
     -> --dry-run stops here: list sessions + conversation-turn counts, no LLM
  -> transcript-extractor.ts: read a session's conversation (user + assistant text)
     -> ask the LLM for the durable, high-value memories (time-ordered:
        a claim later reversed in the same session is not recorded)
     -> sanitise every candidate; drop any candidate carrying a detected secret
     -> embed each survivor and vector-dedup against entities already in the
        graph (same index recall uses); report — never silently drop — skips
     -> stage the rest as dream_proposals (nothing enters the graph yet)
  -> human review: memesh dream show <id> / accept <id> / reject <id>
     -> accept creates the entity AND embeds it, so the next run recognises it
```

### Delete knowledge (forget)

```
Tool call: forget({name})
  -> Zod validation (ForgetSchema)
  -> KnowledgeGraph.deleteEntity(name)
     -> SELECT entity by name (return false if not found)
     -> SELECT all observations for entity (needed for FTS5 delete)
     -> Delete FTS5 entry (contentless delete requires original indexed values)
     -> DELETE FROM entities (CASCADE handles observations, relations, tags)
  -> Return {deleted: true/false}
```

---

## Database Schema

```sql
-- Core tables
entities (id PK, name UNIQUE, type, created_at, metadata JSON, status, access_count, last_accessed_at, confidence, valid_from, valid_until, namespace DEFAULT 'personal')
observations (id PK, entity_id FK, content, created_at)
relations (id PK, from_entity_id FK, to_entity_id FK, relation_type, metadata JSON, created_at, UNIQUE constraint)
tags (id PK, entity_id FK, tag)

-- Indexes
idx_tags_entity (entity_id)
idx_tags_tag (tag)
idx_observations_entity (entity_id)
idx_relations_from (from_entity_id)
idx_relations_to (to_entity_id)

-- FTS5 virtual table (contentless)
entities_fts USING fts5(name, observations, content='', tokenize='unicode61 remove_diacritics 1')
```

Foreign key cascades: deleting an entity automatically deletes its observations, relations, and tags.

---

## Hook Architecture

Hooks are defined in `hooks/hooks.json` and executed by Claude Code at specific lifecycle events.

### Hook Commands (8 hooks)

| Hook | Event | Purpose |
|------|-------|---------|
| pre-edit-recall.js | PreToolUse (Edit/Write) | Continuous recall: inject relevant memories when editing files |
| session-start.js | SessionStart | Auto-recall + record injected IDs + noise compression |
| post-commit.js | PostToolUse (Bash) | Record git commits with diff stats |
| session-summary.js | Stop | Auto-capture session knowledge + recall effectiveness tracking |
| pre-compact.js | PreCompact | Save knowledge before compaction |
| user-prompt-intent.js | UserPromptSubmit | Detect "remember" intent (5 languages: en, es, fr, pt, zh-TW) and remind Claude to use mcp__memesh__remember |
| guard-check.js | PreToolUse (Bash) | Fire accepted lesson-guards against the command about to run (warn-only; fires counted) |
| codex-session.js | SessionStart (startup/resume, async) | Register the exact configured live Codex thread for metadata-only message wakeups; no-op without Codex thread identity |

### Pre-Edit Recall (`scripts/hooks/pre-edit-recall.js`)

- **Trigger**: `PreToolUse` event on `Edit` and `Write` tools
- **Matcher**: `Edit|Write`
- **Behavior**: Reads the file path from tool input, queries MeMesh for entities tagged with the file name or matching via FTS5 search. Returns relevant memories as additional context. Throttled to max 1 recall per file per session via temp file (`~/.memesh/session-recalled-files.json`). Timeout: 5 seconds.

### Session Start (`scripts/hooks/session-start.js`)

- **Trigger**: `SessionStart` event (every new Claude Code session)
- **Matcher**: `*` (all sessions)
- **Behavior**: Opens the database, ranks entities tagged with the current project (plus recently-active entities across projects and active `lesson_learned` entities), and emits **two separate channels**:
  - `systemMessage` — a one-line count banner (`◉ MeMesh · 4 project + 5 recent memories · 1 active lesson`) plus any deprecation / update-available banner. Claude Code renders this to the **human only**; `normalizeAttachmentForAPI` strips the `hook_system_message` attachment from the model's context.
  - `hookSpecificOutput.additionalContext` (`hookEventName: "SessionStart"`) — the **model-facing** payload: the ranked entities with a first-observation snippet each, lessons first. Capped at 4000 characters (Claude Code's own limit is 10000) so session start primes the model without eating its working context.

  Splitting the channels is load-bearing, not cosmetic. Before v4.2.7 the hook emitted **only** `systemMessage`, so nothing it recalled ever reached the model even though the banner reported a memory count — and the Stop hook then charged each of those entities a `recall_miss` for not appearing in a transcript they were never shown in, permanently depressing their `impactScore`. Regression tests in `tests/hooks/session-start.test.ts` assert the model-facing payload directly.

- Records the injected entity IDs, names, and the **exact injected text** to `~/.memesh/sessions/<pid>-<timestamp>.json` for recall-effectiveness tracking. `session-summary.js` subtracts that text from the transcript before hit/miss matching so memesh's own injection is never mistaken for the user referencing a memory. Files older than 24h are pruned on each run.
- After output, runs `compressWeeklyNoise()` (throttled to once per 24h) to archive old auto-tracked noise into weekly summaries

### Post Commit (`scripts/hooks/post-commit.js`)

- **Trigger**: `PostToolUse` event on `Bash` tool
- **Matcher**: `Bash` (filters for git commit commands)
- **Behavior**: Detects git commit messages from tool output, creates a `commit` entity with the commit message as an observation, tags with the project name; includes diff stats (files changed, insertions, deletions)

### Session Summary (`scripts/hooks/session-summary.js`)

- **Trigger**: `Stop` event (when Claude finishes responding)
- **Matcher**: `*` (all sessions)
- **Behavior**: Extracts session knowledge (files edited, errors fixed, decisions made) and stores it as entities in the knowledge graph. When LLM is configured (Level 1), additionally runs failure analysis to create structured `lesson_learned` entities from session errors. Also reads `~/.memesh/last-session-injected.json` to track recall effectiveness — updates `recall_hits` (entity name found in transcript) or `recall_misses` (not found). Opt-out via `MEMESH_AUTO_CAPTURE=false`

### Pre-Compact (`scripts/hooks/pre-compact.js`)

- **Trigger**: `PreCompact` event (before context compaction)
- **Matcher**: `*` (all sessions)
- **Behavior**: Saves a snapshot of session knowledge before context is compacted, ensuring memories are not lost during long sessions; opt-out via `MEMESH_AUTO_CAPTURE=false`

### User Prompt Intent (`scripts/hooks/user-prompt-intent.js`)

- **Trigger**: `UserPromptSubmit` event (every user prompt)
- **Matcher**: `*` (all sessions)
- **Behavior**: Detects explicit "remember/save/memorize" intent in the user's prompt via conservative regex. Supported languages: English ("remember this", "save to memesh"), Spanish ("recordar esto", "guardar en memesh"), French ("rappeler ceci", "sauvegarder dans memesh"), Portuguese ("lembrar isto", "salvar em memesh"), Traditional Chinese ("記下來", "存到 memesh"). On match, emits `additionalContext` JSON reminding the agent to call `mcp__memesh__remember` for cross-project recall. Polite-reminder design (not autonomous extraction): the user's intent is clear, but *what* to remember depends on conversation context the calling agent already has. Defensive: never blocks the prompt; malformed stdin and other errors surface to stderr without affecting submission. Opt-out via `MEMESH_AUTO_CAPTURE=false`

---

## Knowledge Evolution

MeMesh supports knowledge lifecycle management through soft-delete and supersedes semantics:

- **Archive (soft-delete):** `forget` sets entity status to 'archived', removing it from FTS5 search but preserving all data (observations, relations, tags)
- **Observation-level forget:** Remove specific observations without archiving the entity
- **Supersedes relations:** `remember` with `relations: [{type: "supersedes"}]` auto-archives the old entity, creating a knowledge evolution chain
- **Reactivation:** `remember` on an archived entity automatically reactivates it (status → 'active', FTS5 rebuilt)
- **Include archived:** `recall` with `include_archived: true` shows all entities including archived ones, marked with `archived: true`

Data lifecycle: `active` → `archived` (never deleted). Archived entities can be reactivated by calling `remember` with the same name.

---

## Ecosystem Compatibility

MeMesh supports three integration tiers:

| Tier | Client | Integration Method |
|------|--------|--------------------|
| **Native plugin** | Claude Code | Plugin (`.claude-plugin/plugin.json` + 8 lifecycle hooks) |
| | Hermes Agent | Native `MemoryProvider` plugin (Python ABC, convention-based discovery) |
| | OpenClaw | Native memory-capability plugin (TypeScript, `api.registerMemoryCapability()`) |
| **MCP server** | Claude Managed Agents | MCP connector (beta, via session config) |
| | Claude Desktop | MCP server config |
| | Codex CLI / Gemini CLI | MCP server (`memesh-mcp` in client config) |
| | Cursor | MCP server (`memesh-mcp` in client config) |
| | Custom apps | Direct stdio MCP connection |
| **HTTP API** | Custom apps/scripts | HTTP REST API (`memesh serve`, 37 endpoints) |

See [docs/platforms/](../platforms/) for platform-specific integration guides.

### Anthropic API Feature Alignment

| Feature | Relevance to MeMesh |
|---------|---------------------|
| Prompt Caching | Session-start memories benefit from automatic caching |
| Compaction | MeMesh memories survive compaction (external DB) |
| Memory Tool | MeMesh offers local-first structured alternative |
| Agent Skills | MeMesh can be loaded as a custom Agent Skill |

---

## Testing

The automated test suite covers:

- database lifecycle and schema setup
- knowledge graph CRUD, relations, FTS search, and tag filtering
- MCP tool validation and dispatch
- hook behavior for session start and post-commit flows
- dashboard HTML generation and XSS escaping
- repository/package structure checks

Framework: vitest (forks pool mode to avoid SIGSEGV with native modules).

For release safety, `npm run test:packaged` creates a real npm tarball, extracts it, and verifies the published artifact still contains the required runtime files, hook scripts, bundled D3 asset, and package exports.

---

## Memory Lifecycle (v3.0.0)

### Auto-Decay
- Runs on openDatabase() when last decay was 24h+ ago
- Entities not accessed in 30+ days: confidence *= 0.9
- Floor: confidence never below 0.01
- Never deletes — only affects search ranking

### Consolidation — retired
- The `consolidate` tool was removed. It deleted an entity's observations and
  wrote an LLM summary in their place with no proposal and no review, ignored
  pins, reset confidence to 1.0, and could leave an entity permanently empty
  while reporting that nothing had happened
- `dreamer` is the surviving compression path and the reviewed form of the same
  idea: propose → accept/reject, sources archived not deleted, `source_ids`
  kept, semantic types and pinned entities refused
- Not a like-for-like replacement: `dreamer` merges *clusters* of episodic
  entities into a digest. Compressing the observations *within* one named entity
  has no reviewed equivalent today

### Smart Session-Start
- Session-start hook loads top-N entities by weighted score
- Score = recency (~42%) + frequency (30%) + confidence (~28%) — the `SESSION_START_WEIGHT_RATIO` constants in `src/core/scoring.ts`, derived from `DEFAULT_WEIGHTS`; this line previously said 40/30/30 with confidence first, which matched no version of the code
- Default N=10, configurable via MEMESH_SESSION_LIMIT
- Concise format: "• name (type): first observation"

---

## Cross-Project Collaboration (v3.0.0)

### Namespaces

Entities carry a `namespace` field (`personal` | `team` | `global`, default: `personal`). SessionStart injection reads `global` as cross-project: after the project's own window it adds up to three trusted, active global-namespace entities, so a memory stored in `global` reaches a project it was never tagged with. Namespaces allow:

- **personal** — private to the individual user / current project
- **team** — shared across a team; visible when `--cross-project` or namespace filter is applied
- **global** — available in all recall contexts regardless of project tag

### Export / Import

`operations.exportMemories(opts)` serialises matching entities (filtered by namespace, tags, or names) to a structured JSON bundle. `operations.importMemories(bundle, mergeStrategy)` deserialises and inserts entities with one of three merge strategies:

| Strategy | Behaviour on conflict |
|----------|-----------------------|
| `skip` (default) | Keep existing entity, discard imported copy |
| `overwrite` | Replace existing entity's observations and tags |
| `append` | Append imported observations, dedup tags |

### Cross-Project Recall

`recall` accepts a `cross_project: true` flag. When set, the project-tag filter is lifted and FTS5 search spans all namespaces. The same multi-factor scoring applies.

### Personal Backup and Cross-Agent Transfer

```bash
# Export from the personal namespace
memesh export --namespace personal --output memesh-backup.json

# Import on another machine or through another compatible agent
memesh import memesh-backup.json --merge skip
```

---

## Self-Improving Memory (v3.1.0)

MeMesh automatically learns from session failures and proactively warns about known pitfalls.

### Architecture

```
Session with errors
  → Stop hook detects errors + files edited
  → analyzeFailure() sends to LLM (Level 1 only)
  → StructuredLesson { error, rootCause, fix, prevention, patterns }
  → createLesson() stores as lesson_learned entity (upsert-safe naming)
  → Next session: session-start queries lessons → proactive warnings
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Failure Analyzer | `src/core/failure-analyzer.ts` | LLM-powered root cause analysis |
| Lesson Engine | `src/core/lesson-engine.ts` | Structured lesson CRUD + upsert dedup |
| Stop Hook Integration | `scripts/hooks/session-summary.js` | Auto-triggers analysis after sessions |
| Proactive Warnings | `scripts/hooks/session-start.js` | Shows known lessons at session start |
| Learn Tool | All transports | Explicit lesson creation (MCP tool) |

### Lesson Entity Structure

```
type: "lesson_learned"
name: "lesson-{project}-{errorPattern}" (upsert-safe; explicit `learn` without errorPattern → "lesson-{project}-{error-slug}")
observations:
  - "Error: <what went wrong>"
  - "Root cause: <why>"
  - "Fix: <what fixed it>"
  - "Prevention: <how to avoid>"
tags:
  - "project:{name}"
  - "error-pattern:{category}"
  - "severity:{level}"
  - "source:auto-learned" | "source:explicit"
```

### Feedback Loop

- **Positive signal**: `recall()` increments `access_count` — frequently recalled lessons rank higher
- **Negative signal**: Auto-decay reduces confidence of unused lessons (30+ days → `confidence *= 0.9`)
- **Recurrence**: Same error pattern upserts existing lesson, appending observations as recurrence evidence

---

## References

- [API Reference](./api/API_REFERENCE.md)
- [Model Context Protocol](https://modelcontextprotocol.io)
