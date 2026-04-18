# MeMesh Plugin Architecture

**Version**: 3.1.0

---

## Overview

MeMesh is a universal AI memory layer. It provides 7 operations (`remember`, `recall`, `forget`, `consolidate`, `export`, `import`, `learn`) accessible via three transports — CLI, HTTP REST, and MCP — backed by SQLite with FTS5 full-text search and optional sqlite-vec vector embeddings. Entities can be scoped to namespaces (`personal`, `team`, `global`) and shared across projects via JSON export/import. MeMesh includes self-improving memory: LLM-powered failure analysis automatically creates structured lessons from session errors, with proactive warnings at session start.

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
- `config.ts` — config management + capability detection (sqlite-vec availability); exports `logCapabilities()` for startup logging
- `scoring.ts` — multi-factor scoring engine: weights search relevance, recency, frequency, confidence, temporal validity; exports `rankEntities()` used by all recall paths
- `query-expander.ts` — LLM-powered query expansion (Level 1): expands a user query into related terms using a configured LLM (Anthropic/OpenAI/Ollama)
- `version-check.ts` — npm registry version check for update notifications

**Transports** (`src/transports/`) — thin adapters that expose core operations:
- `cli/cli.ts` — Commander CLI (`memesh` command)
- `http/server.ts` — Express REST API server (`memesh serve`, default port 3737)
- `mcp/server.ts` + `mcp/handlers.ts` — stdio MCP server (`memesh-mcp`)

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
│   ├── scoring.ts         # Multi-factor scoring engine (rankEntities)
│   ├── query-expander.ts  # LLM query expansion (Level 1)
│   ├── extractor.ts       # Session knowledge extraction (rule-based + LLM)
│   ├── lifecycle.ts       # Auto-decay + consolidation orchestration
│   ├── failure-analyzer.ts # LLM-powered failure analysis → StructuredLesson
│   ├── lesson-engine.ts   # Structured lesson creation, upsert, project query
│   ├── embedder.ts        # Neural embeddings (Xenova/all-MiniLM-L6-v2, 384-dim)
│   └── version-check.ts   # npm registry version check
├── db.ts                  # SQLite + FTS5 + sqlite-vec + migrations
├── knowledge-graph.ts     # Entity CRUD, relations, FTS5 search, findConflicts
├── index.ts               # Package exports
├── cli/
│   └── view.ts            # HTML dashboard generator
└── transports/
    ├── schemas.ts         # Shared Zod validation schemas (single source of truth)
    ├── mcp/
    │   ├── handlers.ts    # MCP tool handlers (imports schemas, ToolResult wrapper, conflict detection)
    │   └── server.ts      # MCP stdio server (logs capabilities on startup)
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

**config.ts** — Config management: reads `MEMESH_DB_PATH` and other environment variables, detects sqlite-vec availability, exposes a typed config object to transports and core functions. `logCapabilities()` logs detected search level and LLM provider to stderr on server startup (safe for MCP stdio transport).

**scoring.ts** — Multi-factor scoring engine. `scoreEntity()` combines five signals: search relevance (0.35), recency via exponential decay (0.25), access frequency via log normalization (0.20), confidence (0.15), and temporal validity (0.05). `rankEntities()` sorts any entity list by score descending. Applied in all recall paths (`recall()` and `recallEnhanced()`).

**query-expander.ts** — LLM-powered query expansion (Level 1). When a LLM is configured (Anthropic, OpenAI, or Ollama), `expandQuery()` generates related search terms for a user query. Results from expanded terms are merged with original-query results and re-ranked by score (original query = 1.0 relevance, expanded terms = 0.7 relevance).

**failure-analyzer.ts** — LLM-powered failure analysis (Level 1). `analyzeFailure()` takes session errors and files edited, sends them to the configured LLM, and returns a `StructuredLesson` with error, root cause, fix, prevention, error/fix patterns, and severity. Used by the Stop hook to automatically create lessons from session failures.

**lesson-engine.ts** — Structured lesson management. `createLesson()` stores a `StructuredLesson` as a `lesson_learned` entity with upsert-safe naming (`lesson-{project}-{errorPattern}`). Same error pattern in different sessions updates the existing lesson. `createExplicitLesson()` supports the `learn` MCP tool. `findProjectLessons()` queries lessons for proactive warnings.

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
- `search(query?, opts?)` -- FTS5 MATCH query with optional tag filtering; tracks access on returned entities
- `listRecent(limit?)` -- Most recent entities by ID
- `findConflicts(entityNames[])` -- Returns conflict descriptions for any `contradicts` relations among the given entity names; surfaced as warnings by all three transports

FTS5 is configured as a contentless virtual table (`content=''`). The `rebuildFts()` method handles explicit insert/delete operations required by contentless FTS5.

### transports/mcp/server.ts -- MCP Server

Entry point for the `memesh-mcp` binary. Creates the MCP server with stdio transport, registers tool handlers from `handlers.ts`, opens the database on startup.

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

### transports/http/server.ts -- HTTP REST API Server

Express server exposed via `memesh serve` (default port 3737). Delegates all operations to `core/operations`. See [HTTP REST API](#http-rest-api) in the API Reference.

### transports/cli/cli.ts -- CLI

Commander-based CLI exposed via the `memesh` binary. Supports `remember`, `recall`, `forget`, `serve`, and `update` subcommands.

### cli/view.ts -- Dashboard Generator

Generates the interactive MeMesh Dashboard served by the HTTP server and the legacy `memesh-view` CLI command.

- `memesh-view` CLI command (registered in `package.json` bin): generates a static file and opens it in the default browser
- `generateLiveDashboardHtml()`: exported function consumed by `GET /dashboard` in the HTTP server — returns the full HTML string for live serving
- The dashboard is a single self-contained HTML page with bundled local D3.js, styled with Tailwind CDN

**Dashboard tabs (v2.16.0)**:

| Tab | Feature |
|-----|---------|
| Search | Real-time search with keyword highlighting |
| Browse | Paginated entity list with type/status filters |
| Graph | D3.js force-directed knowledge graph |
| Analytics | Stats cards, type distribution chart, tag cloud |
| Manage | Archive/restore entities, remove individual observations |
| Timeline | Knowledge evolution chain visualization |
| Settings | LLM provider setup, API key management, theme toggle |

The Settings tab communicates with `GET /v1/config` and `POST /v1/config`. The Manage tab uses `POST /v1/forget`. All data tabs fetch from `/v1/stats`, `/v1/graph`, `/v1/entities`, and `/v1/recall`.

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
     -> If LLM configured: expandQuery() generates related terms (Level 1)
     -> KnowledgeGraph.search() for each term (original=1.0, expanded=0.7 relevance)
     -> Merge results de-duped by entity name
     -> rankEntities() applies multi-factor scoring (relevance, recency, frequency, confidence, temporal validity)
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

### Hook Scripts (4 hooks)

| Hook | Event | Purpose |
|------|-------|---------|
| session-start.js | SessionStart | Auto-recall project memories |
| post-commit.js | PostToolUse (Bash) | Record git commits with diff stats |
| session-summary.js | Stop | Auto-capture session knowledge |
| pre-compact.js | PreCompact | Save knowledge before compaction |

### Session Start (`scripts/hooks/session-start.js`)

- **Trigger**: `SessionStart` event (every new Claude Code session)
- **Matcher**: `*` (all sessions)
- **Behavior**: Opens the database, queries recent entities tagged with the current project, outputs a summary for Claude to use as context. Also shows proactive warnings for known `lesson_learned` entities matching the current project

### Post Commit (`scripts/hooks/post-commit.js`)

- **Trigger**: `PostToolUse` event on `Bash` tool
- **Matcher**: `Bash` (filters for git commit commands)
- **Behavior**: Detects git commit messages from tool output, creates a `commit` entity with the commit message as an observation, tags with the project name; includes diff stats (files changed, insertions, deletions)

### Session Summary (`scripts/hooks/session-summary.js`)

- **Trigger**: `Stop` event (when Claude finishes responding)
- **Matcher**: `*` (all sessions)
- **Behavior**: Extracts session knowledge (files edited, errors fixed, decisions made) and stores it as entities in the knowledge graph. When LLM is configured (Level 1), additionally runs failure analysis to create structured `lesson_learned` entities from session errors. Opt-out via `MEMESH_AUTO_CAPTURE=false`

### Pre-Compact (`scripts/hooks/pre-compact.js`)

- **Trigger**: `PreCompact` event (before context compaction)
- **Matcher**: `*` (all sessions)
- **Behavior**: Saves a snapshot of session knowledge before context is compacted, ensuring memories are not lost during long sessions; opt-out via `MEMESH_AUTO_CAPTURE=false`

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
| Claude Code | Plugin (native, via plugin.json + hooks) |
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
| Learn Tool | All transports | Explicit lesson creation (7th MCP tool) |

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
