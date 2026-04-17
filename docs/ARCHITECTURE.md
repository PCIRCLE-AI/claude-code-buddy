# MeMesh Plugin Architecture

**Version**: 2.13.0

---

## Overview

MeMesh is a universal AI memory layer. It provides 3 operations (`remember`, `recall`, `forget`) accessible via three transports — CLI, HTTP REST, and MCP — backed by SQLite with FTS5 full-text search and optional sqlite-vec vector embeddings.

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

MeMesh v2.13 separates concerns into two layers:

**Core** (`src/core/`) — pure business logic with zero transport dependencies:
- `types.ts` — shared TypeScript interfaces (zero external deps)
- `operations.ts` — `remember`, `recall`, `forget` as pure functions called by all transports
- `config.ts` — config management + capability detection (sqlite-vec availability)
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
│   ├── operations.ts      # remember/recall/forget pure functions
│   ├── config.ts          # Config management + capability detection
│   └── version-check.ts   # npm registry version check
├── db.ts                  # SQLite + FTS5 + sqlite-vec + migrations
├── knowledge-graph.ts     # Entity CRUD, relations, FTS5 search
├── index.ts               # Package exports
├── cli/
│   └── view.ts            # HTML dashboard generator
└── transports/
    ├── mcp/
    │   ├── handlers.ts    # MCP tool handlers (Zod + ToolResult wrapper)
    │   └── server.ts      # MCP stdio server
    ├── http/
    │   └── server.ts      # Express REST API server
    └── cli/
        └── cli.ts         # Commander CLI
```

---

## Modules

### src/core/ -- Core Layer

**types.ts** — Shared TypeScript interfaces used across all transports. No external dependencies.

**operations.ts** — Pure functions implementing `remember`, `recall`, and `forget`. All three transports delegate here — no transport-specific logic leaks into business logic.

**config.ts** — Config management: reads `MEMESH_DB_PATH` and other environment variables, detects sqlite-vec availability, exposes a typed config object to transports and core functions.

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
- `search(query?, opts?)` -- FTS5 MATCH query with optional tag filtering
- `listRecent(limit?)` -- Most recent entities by ID

FTS5 is configured as a contentless virtual table (`content=''`). The `rebuildFts()` method handles explicit insert/delete operations required by contentless FTS5.

### transports/mcp/server.ts -- MCP Server

Entry point for the `memesh-mcp` binary. Creates the MCP server with stdio transport, registers tool handlers from `handlers.ts`, opens the database on startup.

### transports/mcp/handlers.ts -- MCP Tool Handlers

Thin adapter: validates input via Zod, delegates to `core/operations`, wraps result in MCP `ToolResult` format.

| Tool | Schema | Handler |
|------|--------|---------|
| `remember` | RememberSchema | Delegates to `operations.remember()` |
| `recall` | RecallSchema | Delegates to `operations.recall()` |
| `forget` | ForgetSchema | Delegates to `operations.forget()` |

### transports/http/server.ts -- HTTP REST API Server

Express server exposed via `memesh serve` (default port 3737). Delegates all operations to `core/operations`. See [HTTP REST API](#http-rest-api) in the API Reference.

### transports/cli/cli.ts -- CLI

Commander-based CLI exposed via the `memesh` binary. Supports `remember`, `recall`, `forget`, `serve`, and `update` subcommands.

### cli/view.ts -- Dashboard Generator

Generates a self-contained HTML dashboard for visualizing the knowledge graph.

- `memesh-view` CLI command (registered in `package.json` bin)
- Reads all entities, observations, relations, and tags from the database
- Produces a single HTML file with bundled local D3.js, searchable entity table, and statistics
- Opens the generated file in the default browser

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
  -> KnowledgeGraph.search(query, {tag, limit})
     -> FTS5 MATCH query against entities_fts
     -> Apply tag filtering in SQL when specified
     -> JOIN to entities table (contentless FTS5)
     -> For each match: getEntity() to load full data
  -> Return Entity[]
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
entities (id PK, name UNIQUE, type, created_at, metadata JSON)
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

### Session Start (`scripts/hooks/session-start.js`)

- **Trigger**: `SessionStart` event (every new Claude Code session)
- **Matcher**: `*` (all sessions)
- **Behavior**: Opens the database, queries recent entities tagged with the current project, outputs a summary for Claude to use as context

### Post Commit (`scripts/hooks/post-commit.js`)

- **Trigger**: `PostToolUse` event on `Bash` tool
- **Matcher**: `Bash` (filters for git commit commands)
- **Behavior**: Detects git commit messages from tool output, creates a `commit` entity with the commit message as an observation, tags with the project name

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

## References

- [API Reference](./api/API_REFERENCE.md)
- [Model Context Protocol](https://modelcontextprotocol.io)
