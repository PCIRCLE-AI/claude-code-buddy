# MeMesh Plugin -- API Reference

**Protocol**: Model Context Protocol (MCP) over stdio
**Version**: 2.14.0
**Compatibility**: Works with Claude Code plugins, Claude Managed Agents (via MCP connector), and any MCP-compatible client.

---

## Tools

MeMesh exposes 3 tools via MCP.

---

### remember

Store knowledge as an entity with observations, tags, and relations.

If `remember` is called again with an existing `name`, MeMesh treats it as an append-style upsert: new observations are appended, tags are deduped, and the original entity type is retained.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Unique entity name (e.g., `"auth-decision"`, `"jwt-pattern"`) |
| `type` | string | Yes | Entity type (e.g., `"decision"`, `"pattern"`, `"lesson"`, `"commit"`) |
| `observations` | string[] | No | Key facts or observations about this entity |
| `tags` | string[] | No | Tags for filtering (e.g., `"project:myapp"`, `"type:decision"`) |
| `relations` | object[] | No | Relations to other entities |

**Relations object**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Target entity name (must already exist) |
| `type` | string | Yes | Relation type (e.g., `"implements"`, `"related-to"`) |

**Response**:

```json
{
  "stored": true,
  "entityId": 1,
  "name": "auth-decision",
  "type": "decision",
  "observations": 2,
  "tags": 1,
  "relations": 0
}
```

If a relation target does not exist, the entity is still stored and `relationErrors` is included in the response.

**Supersedes behavior:** When a relation has type `"supersedes"`, the target entity is automatically archived. This enables knowledge evolution — new designs replace old ones without losing history.

**Examples**:

```json
// Store a decision
{
  "name": "auth-decision",
  "type": "decision",
  "observations": [
    "Chose JWT for authentication",
    "Using RS256 algorithm for token signing"
  ],
  "tags": ["project:myapp", "topic:auth"]
}

// Store a pattern with a relation
{
  "name": "error-handling-pattern",
  "type": "pattern",
  "observations": ["All API errors return {error, code, message} format"],
  "tags": ["project:myapp"],
  "relations": [
    {"to": "auth-decision", "type": "related-to"}
  ]
}
```

---

### recall

Search and retrieve stored knowledge. Uses FTS5 full-text search with optional tag filtering. Call with no query to list recent memories.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Search query (FTS5 full-text search). Leave empty to list recent entities. |
| `tag` | string | No | Filter by tag (e.g., `"project:myapp"`) |
| `limit` | number | No | Max results (default: 20, max: 100) |
| `include_archived` | boolean | No | Include archived (forgotten) entities in results (default: false) |

**Response**:

Returns an array of matching entities:

```json
[
  {
    "id": 1,
    "name": "auth-decision",
    "type": "decision",
    "created_at": "2026-03-09 12:00:00",
    "observations": [
      "Chose JWT for authentication",
      "Using RS256 algorithm for token signing"
    ],
    "tags": ["project:myapp", "topic:auth"],
    "relations": [
      {"from": "auth-decision", "to": "api-design", "type": "related-to"}
    ]
  }
]
```

**Examples**:

```json
// Search by keyword
{"query": "authentication"}

// Search with tag filter
{"query": "auth", "tag": "project:myapp"}

// List recent (no query)
{}

// List recent with limit
{"limit": 5}
```

---

### forget

Archive an entity (soft-delete) or remove a specific observation.

**Behavior (v2.12):** `forget` does not permanently delete data. Entities are archived and hidden from normal recall, but preserved in the database. Use `include_archived: true` in recall to see archived entities.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Entity name to archive or modify |
| `observation` | string | No | If provided, only this observation is removed (entity stays active). If omitted, the entire entity is archived. |

**Modes:**
- **Entity archive** (no observation): Archives the entire entity. Hidden from recall by default.
- **Observation removal** (with observation): Removes one specific observation. Entity stays active.

---

## Data Model

### Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Auto-incremented primary key |
| `name` | string | Unique entity name |
| `type` | string | Entity type |
| `created_at` | string | ISO timestamp |
| `metadata` | object | Optional JSON metadata |
| `observations` | string[] | Associated observations |
| `tags` | string[] | Associated tags |
| `relations` | Relation[] | Outgoing relations (optional) |

### Relation

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Source entity name |
| `to` | string | Target entity name |
| `type` | string | Relation type |
| `metadata` | object | Optional JSON metadata |

---

## Error Handling

All tools return errors in a standard format:

```json
{
  "content": [{"type": "text", "text": "error message"}],
  "isError": true
}
```

Common errors:
- Unknown tool name
- Zod validation failure (missing required fields, invalid types)
- Entity not found (for relations in `remember`)

---

## HTTP REST API

Start: `memesh serve` (default: `localhost:3737`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /v1/health | Health check + version + entity count |
| POST | /v1/remember | Store knowledge |
| POST | /v1/recall | Search knowledge |
| POST | /v1/forget | Archive or remove observation |
| GET | /v1/entities | List entities (pagination) |
| GET | /v1/entities/:name | Get single entity |

All responses: `{ success: true, data: ... }` or `{ success: false, error: "..." }`

Request/response bodies for `POST /v1/remember`, `/v1/recall`, and `/v1/forget` mirror the MCP tool schemas above (same field names, same types).

**Example**:

```bash
# Start the server
memesh serve

# Store knowledge
curl -s -X POST http://localhost:3737/v1/remember \
  -H 'Content-Type: application/json' \
  -d '{"name":"auth-decision","type":"decision","observations":["Use OAuth 2.0"]}'

# Search knowledge
curl -s -X POST http://localhost:3737/v1/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"auth"}'

# Health check
curl -s http://localhost:3737/v1/health
```

---

## CLI Commands

### memesh-view

Generate and open an interactive HTML dashboard for exploring stored knowledge.

**Usage**:

```bash
memesh-view
```

**Behavior**:

1. Opens the MeMesh database (`~/.memesh/knowledge-graph.db`)
2. Reads all entities, observations, relations, and tags
3. Generates a self-contained HTML file with bundled local D3.js and:
   - **Knowledge graph** -- D3.js force-directed graph showing entities and relations
   - **Entity table** -- Searchable, sortable table of all entities with observations and tags
   - **Statistics** -- Total entities, observations, relations, and tags
4. Opens the HTML file in the default browser

No arguments or options required. The dashboard is a static HTML file that can be shared, archived, and opened offline.

---

## Connection

MeMesh runs as a stdio MCP server. Claude Code manages the connection automatically via the plugin's `.mcp.json` configuration.

```json
{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```
