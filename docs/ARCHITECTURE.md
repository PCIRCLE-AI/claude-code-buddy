# MeMesh Plugin Architecture

**Version**: 3.0.0

---

## Overview

MeMesh is a minimal persistent memory plugin for Claude Code. It provides 3 MCP tools (`remember`, `recall`, `forget`) and 2 hooks (session start, post commit), backed by SQLite with FTS5 full-text search.

```
Claude Code CLI <--stdio--> MCP Server <--> KnowledgeGraph <--> SQLite (FTS5)
```

---

## Modules

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

### mcp/server.ts -- MCP Server

Entry point. Creates the MCP server with stdio transport, registers tool handlers, opens the database on startup.

### mcp/tools.ts -- Tool Handlers

Defines 3 tools with Zod validation schemas and handler functions:

| Tool | Schema | Handler |
|------|--------|---------|
| `remember` | RememberSchema | Creates entity, adds observations/tags/relations |
| `recall` | RecallSchema | Searches via FTS5, returns matching entities |
| `forget` | ForgetSchema | Deletes entity by name |

The `handleTool(name, args)` dispatcher validates input via Zod, then delegates to the appropriate handler.

### cli/view.ts -- CLI Dashboard

Generates a self-contained HTML dashboard for visualizing the knowledge graph.

- `memesh-view` CLI command (registered in `package.json` bin)
- Reads all entities, observations, relations, and tags from the database
- Produces a single HTML file with embedded D3.js force-directed graph, searchable entity table, and statistics
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
     -> INSERT tags
  -> KnowledgeGraph.createRelation() for each relation
  -> Return {stored: true, entityId, ...}
```

### Search knowledge (recall)

```
Tool call: recall({query, tag, limit})
  -> Zod validation (RecallSchema)
  -> KnowledgeGraph.search(query, {tag, limit})
     -> FTS5 MATCH query against entities_fts
     -> JOIN to entities table (contentless FTS5)
     -> For each match: getEntity() to load full data
     -> Filter by tag if specified
  -> Return Entity[]
```

### Delete knowledge (forget)

```
Tool call: forget({name})
  -> Zod validation (ForgetSchema)
  -> KnowledgeGraph.deleteEntity(name)
     -> Delete FTS5 entry (contentless delete syntax)
     -> DELETE FROM entities (CASCADE handles children)
  -> Return {deleted: true/false}
```

---

## Database Schema

```sql
-- Core tables
entities (id PK, name UNIQUE, type, created_at, metadata JSON)
observations (id PK, entity_id FK, content, created_at)
relations (id PK, from_entity_id FK, to_entity_id FK, relation_type, metadata JSON, UNIQUE constraint)
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

## Testing

7 test files, 73 tests total:

| File | Tests | What it covers |
|------|-------|---------------|
| `tests/db.test.ts` | 10 | Database lifecycle, schema, FTS5 setup |
| `tests/knowledge-graph.test.ts` | 18 | Entity CRUD, relations, search, batch ops |
| `tests/tools.test.ts` | 15 | Tool validation, handler behavior, dispatcher |
| `tests/installation.test.ts` | 7 | Package structure, required files exist |
| `tests/hooks/session-start.test.ts` | 6 | Session start hook behavior |
| `tests/hooks/post-commit.test.ts` | 7 | Post commit hook behavior |
| `tests/cli/view.test.ts` | 10 | CLI dashboard generator, XSS prevention |

Framework: vitest (forks pool mode to avoid SIGSEGV with native modules).

---

## References

- [API Reference](./api/API_REFERENCE.md)
- [Model Context Protocol](https://modelcontextprotocol.io)
