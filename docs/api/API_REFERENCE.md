# MeMesh Plugin -- API Reference

**Protocol**: Model Context Protocol (MCP) over stdio
**Version**: 3.0.0

---

## Tools

MeMesh exposes 3 tools via MCP.

---

### remember

Store knowledge as an entity with observations, tags, and relations.

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

Delete an entity and all its associated observations, relations, and tags.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Entity name to delete |

**Response**:

```json
// Entity found and deleted
{"deleted": true, "name": "auth-decision"}

// Entity not found
{"deleted": false, "message": "Entity \"auth-decision\" not found"}
```

**Example**:

```json
{"name": "auth-decision"}
```

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

## Connection

MeMesh runs as a stdio MCP server. Claude Code manages the connection automatically via the plugin's `.mcp.json` configuration.

```json
{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["dist/mcp/server.js"]
    }
  }
}
```
