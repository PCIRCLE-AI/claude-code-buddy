# MeMesh Plugin Architecture

**Version**: 4.2.11

> Looking for "which file do I change for X?" — see [CODEMAP.md](../CODEMAP.md).

---

## Overview

MeMesh Plugin is the local memory layer for Claude Code and other MCP-compatible coding agents. It provides 9 operations (`remember`, `recall`, `forget`, `consolidate`, `export`, `import`, `learn`, `user_patterns`, `verify_agent_work`) through three transports — CLI, HTTP REST, and MCP — backed by SQLite with FTS5 full-text search and optional sqlite-vec vector embeddings.

The package is intentionally local-first and inspectable:
- one SQLite database under the user's control
- no cloud service required
- Claude Code hook integration for session-start, pre-edit recall, pre-bash orchestration nudge, user-prompt-intent detection, post-commit capture, session-summary learning, and pre-compact save
- optional smarter retrieval and extraction when an LLM is configured

This repository is the plugin/package wedge of the broader MeMesh effort. Hosted workspace and enterprise operating-system products are intentionally out of scope for this package architecture.

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

## Core/Transport Architecture

MeMesh separates concerns into two layers:

**Core** (`src/core/`) — pure business logic with zero transport dependencies:
- `types.ts` — shared TypeScript interfaces (zero external deps)
- `operations.ts` — `remember`, `recall`, `forget`, `export`, `import` as pure functions called by all transports
- `config.ts` — config management + capability detection (incl. `llmFallbacks` chain); exports `logCapabilities()` for startup logging
- `paths.ts` — centralised filesystem path resolution (HOME-first override; shared with hooks via a build-generated copy in `scripts/hooks/_generated/`)
- `scoring.ts` — multi-factor scoring engine: weights search relevance, recency, frequency, confidence, recall-impact; exports `rankEntities()` used by all recall paths
- `llm-client.ts` — single dispatch for anthropic / openai / ollama with cross-provider failover, error classification, and per-attempt telemetry callback
- `llm-telemetry.ts` — `llm_telemetry` SQLite table + `recordTelemetry()` + `summariseTelemetry()` + `pruneTelemetry()` retention
- `dreamer.ts` — LLM cluster compactor + pattern detector with propose/accept/reject lifecycle; auto-trigger from Stop hook
- `digest-validator.ts` — opt-in second-pass LLM cross-check on dreamer digests (`pass | soften | reject`)
- `kg-backfill.ts` — non-LLM heuristic relation backfill: 4 rules (tag co-occurrence, project clustering, session co-occurrence, name-token similarity)
- `project-tags.ts` — list / merge / rename `project:<name>` tags (heals tags mis-homed before git-based project identity); backs `memesh kg rename-project`
- `prompt-safety.ts` — F7 prompt-injection hardening (delimiter escaping for 3 LLM call sites)
- `failure-analyzer.ts` / `auto-tagger.ts` / `consolidator.ts` — Smart-Mode LLM flows (all use `callLLM` failover + telemetry)
- `verifier.ts` — `verify_agent_work` core: git reality-check + persistence of verification reports as `verification_record` entities
- `version-check.ts` — npm registry version check for update notifications

**Transports** (`src/transports/`) — thin adapters that expose core operations:
- `cli/cli.ts` — Commander CLI (`memesh` command, 24 top-level commands; `config`, `kg`, and `dream` have subcommands)
- `http/server.ts` — Express REST API server (`memesh serve`, default port 3737, ~32 endpoints, bearer-auth gate when bound non-loopback)
- `src/mcp/server.ts` + `src/transports/mcp/handlers.ts` — stdio MCP server (`memesh-mcp`, 9 tools); `src/mcp/tools.ts` is a re-export shim

This separation means the same `remember`/`recall`/`forget` logic runs identically whether invoked from a terminal, an HTTP request, or an MCP tool call.

---

## Source Structure

```
src/
├── core/
│   ├── types.ts           # Shared types (zero external deps)
│   ├── operations.ts      # remember/recall/forget/learn + re-exports consolidate/export/import
│   ├── consolidator.ts    # LLM-powered observation compression (extracted from operations)
│   ├── serializer.ts      # Export/import memory snapshots (extracted from operations)
│   ├── config.ts          # Config management + capability detection + logCapabilities()
│   ├── paths.ts           # Centralised path helpers (homeDir, memeshDir, getDbPath, getProjectName)
│   ├── scoring.ts         # Multi-factor scoring engine (rankEntities) + SESSION_START_WEIGHT_RATIO
│   ├── extractor.ts       # Session knowledge extraction (rule-based + LLM)
│   ├── lifecycle.ts       # Auto-decay + consolidation orchestration
│   ├── failure-analyzer.ts # LLM-powered failure analysis → StructuredLesson
│   ├── lesson-engine.ts   # Structured lesson creation, upsert, project query
│   ├── embedder.ts        # Neural embeddings (@huggingface/transformers + all-MiniLM-L6-v2, 384-dim)
│   ├── auto-tagger.ts     # LLM-powered auto-tag generation (fire-and-forget)
│   ├── llm-client.ts      # Single dispatch for anthropic/openai/ollama + cross-provider failover + secret redaction
│   ├── llm-telemetry.ts   # llm_telemetry table + recordTelemetry + summariseTelemetry + pruneTelemetry
│   ├── llm-validator.ts   # Provider+model capability detection (list models, byte-capped fetch)
│   ├── prompt-safety.ts   # F7 prompt-injection hardening (sanitizeForPrompt for 3 call sites)
│   ├── dreamer.ts         # LLM cluster compactor + pattern detector (propose/accept/reject)
│   ├── digest-validator.ts # Opt-in second-pass LLM cross-check on dreamer digests
│   ├── kg-backfill.ts     # Heuristic relation backfill (tag co-occurrence + project clustering)
│   ├── patterns.ts        # User work patterns computation (shared by MCP + HTTP)
│   ├── doctor.ts          # `memesh doctor` health check (install / hooks / DB / capabilities)
│   ├── demo.ts            # `memesh demo` 30-entity onboarding seed
│   └── version-check.ts   # npm registry version check
├── db.ts                  # SQLite + FTS5 + sqlite-vec + migrations
├── knowledge-graph.ts     # Entity CRUD, relations, FTS5 search, findConflicts
├── index.ts               # Package exports
├── cli/
│   └── view.ts            # HTML dashboard generator
├── mcp/
│   ├── launcher.ts        # memesh-mcp entry point: probes better-sqlite3 binding, rebuilds if missing, re-execs for fresh module cache
│   ├── server.ts          # MCP stdio server (logs capabilities on startup)
│   └── tools.ts           # Re-export shim → transports/mcp/handlers.ts
└── transports/
    ├── schemas.ts         # Shared Zod validation schemas (single source of truth)
    ├── mcp/
    │   └── handlers.ts    # MCP tool handlers (imports schemas, ToolResult wrapper, conflict detection)
    │                      # NOTE: launcher.ts + server.ts live in src/mcp/ (see below), NOT here
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

Session-start hook ranking is a SQL-only subset (no FTS query, no impact pass) that uses three of the five factors. `SESSION_START_WEIGHT_RATIO` exports the renormalised weights so the hook's hard-coded SQL stays in sync; a drift-guard test in `tests/core/scoring.test.ts` asserts the magic numbers in `scripts/hooks/session-start.js` match. The hook SQL uses SQLite's `exp()`/`log()` (available in better-sqlite3 v8+) to match the core math exactly, with a runtime probe + linear/rational fallback for stripped-down builds without `-DSQLITE_ENABLE_MATH_FUNCTIONS`.

**(retired) query-expander.ts** — LLM-powered query expansion was removed in 2026-05 after LongMemEval-S Mode A (FTS5 + sqlite-vec, no LLM) measured well above the LLM-augmented alternative's expected ceiling. The figure quoted at the time (95.40%) came from the benchmark's own reimplementation of retrieval rather than from this code; measured through `recallEnhanced()` the same 500 questions now score 95.60% R@5 in 9.1s, within 1.0pp of vendor reranker stacks. The expander cost ~500-10000ms per recall for an estimated 1-2pp ceiling lift, decisively losing the UX axis given that recall is the hot path for hooks (`pre-edit-recall`, `session-start`) and MCP agent calls. Recall is now strictly LLM-free; LLM augmentation is reserved for the async/analysis flows below (failure-analyzer, auto-tagger, consolidator, dreamer, llm-validator).

**failure-analyzer.ts** — LLM-powered failure analysis (Level 1). `analyzeFailure()` takes session errors and files edited, sends them to the configured LLM, and returns a `StructuredLesson` with error, root cause, fix, prevention, error/fix patterns, and severity. Used by the Stop hook to automatically create lessons from session failures.

**lesson-engine.ts** — Structured lesson management. `createLesson()` stores a `StructuredLesson` as a `lesson_learned` entity with upsert-safe naming (`lesson-{project}-{errorPattern}`). Same error pattern in different sessions updates the existing lesson. `createExplicitLesson()` supports the `learn` MCP tool. `findProjectLessons()` queries lessons for proactive warnings.

**patterns.ts** — User work patterns computation (shared by MCP `user_patterns` tool and HTTP `GET /v1/patterns`). `computePatterns()` queries the database for work schedule (hour/day distribution), tool preferences, focus areas, workflow metrics, strengths, and learning areas. Accepts optional `categories` filter array.

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
- `search(query?, opts?)` -- FTS5 MATCH query with optional tag filtering; tracks access on returned entities (access only — `recall_hits`/`recall_misses` belong to the Stop hook, the one place that can tell whether an injected memory was USED). With `includeArchived`, archived rows are matched by `LIKE` on the same terms, since `archiveEntity()` removes them from FTS5. Query terms are OR-ed (a bare space is FTS5's implicit AND, which required every word of a question to appear in one memory) and rows are ordered by FTS5 `rank` (BM25), not by id — `LIMIT` decides what survives to the scorer, so ordering by id discarded the best match before it could be scored. Terms are capped at `MAX_QUERY_TERMS` (32) so a pasted log dump cannot build an unbounded disjunction, and `dropUbiquitousTerms()` removes any term present in more than half the corpus — those are the terms BM25 already scores near zero, and OR-ing them makes the scan proportional to the whole index (measured 80.15ms → 8.57ms at 100k rows, with R@5 unchanged). Document frequency comes from `fts_vocab`, an `fts5vocab` view over `entities_fts`; the guard stays out below 25 rows, where document frequency has no meaning, and falls back to the full term list if the view is absent. `buildMatchExpression()` splits on the boundaries `unicode61` itself uses — `[\p{L}\p{N}\p{M}]+` over an NFC-normalised query — rather than on whitespace, so `kitchen's` does not become the phrase `kitchen s` and decomposed text stays whole. Before splitting, both the query and the indexed text pass through `segmentUnspacedScripts()` (`src/storage/fts-index.ts`), which cuts CJK / kana / hangul runs into overlapping character bigrams: `unicode61` indexes an unbroken run as a single token, so a Chinese memory used to be reachable only by its exact stored string. Index side and query side must use that same function — `tests/cjk-recall.test.ts` pins it. A lone unspaced-script character becomes a prefix query, which reaches every bigram starting with it. The optional tag filter is an `EXISTS` subquery rather than a join, so one statement serves every filter combination without `SELECT DISTINCT`.
- `listRecent(limit?)` -- Most recent entities by ID
- `findConflicts(entityNames[])` -- Returns conflict descriptions for any `contradicts` relations among the given entity names; surfaced as warnings by all three transports

FTS5 is configured as a contentless virtual table (`content=''`). The `rebuildFts()` method handles explicit insert/delete operations required by contentless FTS5.

### mcp/launcher.ts -- MCP Startup Guard

Entry point for the `memesh-mcp` binary. Probes `better-sqlite3` by instantiating an in-memory database (the binding loads lazily inside the constructor). On failure, runs `npm rebuild better-sqlite3` then re-execs the process via `spawnSync` so the fresh Node.js instance has a clean module cache. An env guard (`MEMESH_REBUILD_ATTEMPTED`) prevents infinite loops if rebuild fails.

### mcp/server.ts -- MCP Server

Actual MCP server logic. Creates the MCP server with stdio transport, registers tool handlers from `handlers.ts`, opens the database on startup. Invoked by `launcher.ts` after the native addon is confirmed working.

### transports/mcp/handlers.ts -- MCP Tool Handlers

Thin adapter: imports shared Zod schemas from `transports/schemas.ts`, validates input, delegates to `core/operations`, wraps result in MCP `ToolResult` format.

| Tool | Schema | Handler |
|------|--------|---------|
| `remember` | RememberSchema | Delegates to `operations.remember()` |
| `recall` | RecallSchema | Delegates to `operations.recallEnhanced()` |
| `forget` | ForgetSchema | Delegates to `operations.forget()` |
| `consolidate` | ConsolidateSchema | Delegates to `operations.consolidate()` |
| `export` | ExportSchema | Delegates to `operations.exportMemories()` |
| `import` | ImportSchema | Delegates to `operations.importMemories()` |
| `learn` | LearnSchema | Delegates to `operations.learn()` |
| `user_patterns` | UserPatternsSchema | Delegates to `core/patterns.computePatterns()` |
| `verify_agent_work` | VerifyAgentWorkSchema | Delegates to `core/verifier.verifyAgentWork()` |

### transports/http/server.ts -- HTTP REST API Server

Express server exposed via `memesh serve` (default port 3737, 17 endpoints). Delegates all operations to `core/operations`. Includes `GET /v1/analytics` for computed health score, 30-day timeline, value metrics, and cleanup suggestions. See [HTTP REST API](#http-rest-api) in the API Reference.

### transports/cli/cli.ts -- CLI

Commander-based CLI exposed via the `memesh` binary. Supports `remember`, `recall`, `forget`, `serve`, and `update` subcommands.

### dashboard/ -- Packaged Dashboard SPA

The primary dashboard is now the packaged Preact single-page app served by `GET /dashboard` from `dashboard/dist/index.html`.

- packaged with the npm artifact under `dashboard/dist/`
- preferred over the legacy HTML generator path
- used for live local inspection and settings/config flows

**Dashboard tabs (v4.1.4+)**:

| Tab | Feature |
|-----|---------|
| Search | Full-text + vector-assisted recall UI |
| Browse | Paginated entity list |
| Analytics | Health score, 30-day timeline, **MemoryAgeMatrix** (type × age heat map), **KnowledgeRadar** (6-axis SVG), work patterns |
| Graph | Interactive knowledge graph with **signal-first node loading**, **access_count node sizing**, and **Drift Mode** (recency coloring) |
| Lessons | Structured lessons learned from failures |
| Manage | Archive / restore and memory management via browse flow |
| Settings | LLM provider setup, capabilities, and language selection |

The dashboard talks to `/v1/health`, `/v1/config`, `/v1/analytics`, `/v1/graph`, `/v1/entities`, `/v1/patterns`, and `/v1/recall`. When the packaged build is unavailable, the HTTP server falls back to the legacy `cli/view.ts` HTML generator for compatibility.

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

### Hook Scripts (7 hooks)

| Hook | Event | Purpose |
|------|-------|---------|
| pre-edit-recall.js | PreToolUse (Edit/Write) | Continuous recall: inject relevant memories when editing files |
| pre-bash-orchestration-nudge.js | PreToolUse (Bash) | (Opt-in) Nudge to dispatch high-verifiability commands as background agents |
| session-start.js | SessionStart | Auto-recall + record injected IDs + noise compression + (opt-in) agentic-orchestration banner |
| post-commit.js | PostToolUse (Bash) | Record git commits with diff stats |
| session-summary.js | Stop | Auto-capture session knowledge + recall effectiveness tracking |
| pre-compact.js | PreCompact | Save knowledge before compaction |
| user-prompt-intent.js | UserPromptSubmit | Detect "remember" intent (5 languages: en, es, fr, pt, zh-TW) and remind Claude to use mcp__memesh__remember |

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

MeMesh works with any MCP-compatible client:

| Client | Integration Method |
|--------|-------------------|
| Claude Code | Plugin (native, via `.claude-plugin/plugin.json` + hooks) |
| Claude Managed Agents | MCP connector (beta, via session config) |
| Claude Desktop | MCP server config |
| Custom apps | Direct stdio MCP connection |

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

### Consolidation
- `consolidate` tool compresses N observations → K dense observations via LLM
- Requires Smart Mode (LLM provider configured)
- Original observations are replaced by compressed versions
- If LLM fails, entity is left unchanged

### Smart Session-Start
- Session-start hook loads top-N entities by weighted score
- Score = confidence (40%) + frequency (30%) + recency (30%)
- Default N=10, configurable via MEMESH_SESSION_LIMIT
- Concise format: "• name (type): first observation"

---

## Cross-Project Collaboration (v3.0.0)

### Namespaces

Entities carry a `namespace` field (`personal` | `team` | `global`, default: `personal`). Namespaces allow:

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

### Team Sharing Workflow

```bash
# Exporter
memesh export --namespace team --output team-memories.json

# Importers (each team member)
memesh import team-memories.json --merge skip
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
name: "lesson-{project}-{errorPattern}" (upsert-safe)
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
