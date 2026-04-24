# MeMesh Plugin -- API Reference

**Protocol**: Model Context Protocol (MCP) over stdio
**Version**: 4.0.2
**Compatibility**: Works with Claude Code plugins, Claude Managed Agents (via MCP connector), and any MCP-compatible client.

---

## Tools

MeMesh exposes 8 tools via MCP.

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
| `namespace` | string | No | Namespace scope: `"personal"` (default), `"team"`, or `"global"` |

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

Search and retrieve stored knowledge. Uses FTS5 full-text search with optional tag filtering and multi-factor scoring. When an LLM is configured (Smart Mode, Level 1), the query is expanded into related terms before searching. Results are ranked by a weighted combination of search relevance, recency, access frequency, confidence, and temporal validity. Call with no query to list recent memories.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Search query (FTS5 full-text search). Leave empty to list recent entities. |
| `tag` | string | No | Filter by tag (e.g., `"project:myapp"`) |
| `limit` | number | No | Max results (default: 20, max: 100) |
| `include_archived` | boolean | No | Include archived (forgotten) entities in results (default: false) |
| `namespace` | string | No | Filter to a specific namespace (`"personal"`, `"team"`, `"global"`) |
| `cross_project` | boolean | No | When `true`, lifts project-tag filter and searches all namespaces (default: false) |

**Response**:

Returns an array of matching entities ranked by multi-factor score (relevance, recency, frequency, confidence, temporal validity):

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

**Conflict detection**: When any pair of returned entities have a `contradicts` relation, the response is wrapped as:

```json
{
  "entities": [...],
  "conflicts": [
    "\"no-jwt\" contradicts \"use-jwt\""
  ]
}
```

The CLI prints conflict warnings below the results; the `--json` flag outputs the wrapped form.

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

**Behavior:** `forget` does not permanently delete data. Entities are archived and hidden from normal recall, but preserved in the database. Use `include_archived: true` in recall to see archived entities.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Entity name to archive or modify |
| `observation` | string | No | If provided, only this observation is removed (entity stays active). If omitted, the entire entity is archived. |

**Modes:**
- **Entity archive** (no observation): Archives the entire entity. Hidden from recall by default.
- **Observation removal** (with observation): Removes one specific observation. Entity stays active.

---

### consolidate

Compress verbose entity observations using LLM. Requires Smart Mode.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | Specific entity to consolidate |
| `tag` | string | No | Consolidate all entities with this tag |
| `min_observations` | number | No | Minimum observations to trigger (default: 5) |

**Response**: `{ consolidated, entities_processed, observations_before, observations_after, error? }`

---

### export

Export memories to a portable JSON bundle. Use for backup, sharing with teammates, or migrating between machines.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | No | Export only entities from this namespace (`"personal"`, `"team"`, `"global"`). Omit to export all namespaces. |
| `tag` | string | No | Export only entities matching this tag (e.g., `"project:myapp"`) |
| `limit` | number | No | Maximum number of active entities to export (default: 1000) |

**Response**:

```json
{
  "version": "3.0.0",
  "exported_at": "2026-04-17T00:00:00.000Z",
  "entity_count": 12,
  "entities": [
    {
      "name": "auth-decision",
      "type": "decision",
      "namespace": "team",
      "observations": ["Use OAuth 2.0"],
      "tags": ["project:myapp", "topic:auth"],
      "relations": []
    }
  ]
}
```

**Examples**:

```json
// Export all memories
{}

// Export team namespace only
{"namespace": "team"}

// Export specific project
{"tag": "project:myapp"}
```

---

### import

Import memories from a JSON bundle produced by `export`. Three merge strategies control how conflicts with existing entities are resolved.
Imported entities are marked with import provenance and treated as untrusted for automatic Claude hook injection until they are reviewed or re-stored locally.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | object | Yes | The JSON bundle produced by `export` |
| `merge_strategy` | string | Yes | Merge strategy for conflicts: `"skip"`, `"overwrite"`, or `"append"` |
| `namespace` | string | No | Force all imported entities into this namespace, ignoring namespace stored in the bundle |

**Merge Strategies**:

| Strategy | Behaviour on existing entity |
|----------|------------------------------|
| `skip` | Keep existing entity unchanged, discard imported copy |
| `overwrite` | Replace existing entity's observations and tags with imported values |
| `append` | Append imported observations to existing, deduplicate tags |

**Response**:

```json
{
  "imported": 10,
  "skipped": 2,
  "appended": 0,
  "errors": []
}
```

**Examples**:

```json
// Import with default (skip duplicates)
{"data": {...}, "merge_strategy": "skip"}

// Import and overwrite conflicts
{"data": {...}, "merge_strategy": "overwrite"}

// Import into team namespace
{"data": {...}, "merge_strategy": "skip", "namespace": "team"}
```

---

### learn

Record a structured lesson from a mistake or discovery. Creates a `lesson_learned` entity with structured observations for error, root cause, fix, and prevention.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error` | string | Yes | What went wrong |
| `fix` | string | Yes | What fixed it |
| `root_cause` | string | No | Why it happened |
| `prevention` | string | No | How to prevent it next time |
| `severity` | string | No | Severity level: `"critical"`, `"major"`, or `"minor"` (default: `"minor"`) |

**Response**:

```json
{
  "name": "lesson-myproject-null-reference",
  "stored": true,
  "entityId": 42,
  "observations": 4,
  "tags": 4
}
```

**Examples**:

```json
// Record a lesson from a bug fix
{
  "error": "TypeError: Cannot read property of null",
  "fix": "Added optional chaining (?.) on API response",
  "root_cause": "API response can be null on timeout",
  "prevention": "Always validate API responses before accessing nested properties",
  "severity": "major"
}

// Minimal lesson (only required fields)
{
  "error": "Tests fail with SIGSEGV in native module",
  "fix": "Changed vitest pool from threads to forks"
}
```

---

### user_patterns

Analyze user work patterns from existing memory. Returns work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use at session start for context about the user.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `categories` | string[] | No | Specific categories to return: `"workSchedule"`, `"toolPreferences"`, `"focusAreas"`, `"workflow"`, `"strengths"`, `"learningAreas"`. Omit for all. |

**Response** (MCP returns markdown text; HTTP returns JSON):

```json
{
  "workSchedule": {
    "hourDistribution": [{"hour": 9, "count": 42}, {"hour": 14, "count": 38}],
    "dayDistribution": [{"day": "Monday", "dayNum": 1, "count": 50}]
  },
  "toolPreferences": [{"tool": "Read", "sessions": 15}],
  "focusAreas": [{"type": "decision", "count": 12}],
  "workflow": {
    "avgSessionMinutes": 45,
    "commitsPerSession": 2.3,
    "totalSessions": 20,
    "totalCommits": 46
  },
  "strengths": [{"type": "pattern", "avgConfidence": 0.95, "count": 8}],
  "learningAreas": [{"tag": "async", "count": 3}]
}
```

**Examples**:

```json
// Get all patterns
{}

// Get only workflow and schedule
{"categories": ["workflow", "workSchedule"]}
```

---

## Data Model

### Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Auto-incremented primary key |
| `name` | string | Unique entity name |
| `type` | string | Entity type |
| `namespace` | string | Namespace scope (`"personal"`, `"team"`, `"global"`) |
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

Safety note: non-loopback binds are blocked by default. To expose the HTTP server beyond the local machine, you must pass `memesh serve --host 0.0.0.0 --allow-remote` or set `MEMESH_HTTP_ALLOW_REMOTE=true`. MeMesh does not add an auth layer for you.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /v1/health | Health check + version + entity count |
| POST | /v1/remember | Store knowledge |
| POST | /v1/recall | Search knowledge |
| POST | /v1/forget | Archive or remove observation |
| POST | /v1/consolidate | Compress entity observations via LLM (Smart Mode required) |
| POST | /v1/export | Export memories as JSON bundle |
| POST | /v1/import | Import memories from JSON bundle with merge strategy |
| POST | /v1/learn | Record structured lesson from mistake or discovery |
| GET | /v1/entities | List entities (pagination) |
| GET | /v1/entities/:name | Get single entity |
| GET | /v1/config | Get current config and detected capabilities |
| GET | /v1/update-status | Current/latest package version, freshness state, and update guidance |
| POST | /v1/config | Save config (partial update) |
| GET | /v1/stats | Aggregate counts: entities, observations, relations, tags; type/tag/status distributions |
| GET | /v1/graph | All entities + all relations (for graph visualization) |
| GET | /v1/analytics | Health score, 30-day timeline, value metrics, cleanup suggestions |
| GET | /v1/patterns | User work patterns: schedule, tools, focus areas, workflow, strengths, learning |
| GET | /dashboard | Interactive web dashboard (HTML) |

All responses: `{ success: true, data: ... }` or `{ success: false, error: "..." }`

### GET /v1/config

Returns the current configuration and detected capabilities. API keys are masked in the response.

**Response**:

```json
{
  "success": true,
  "data": {
    "config": { "theme": "dark", "autoCapture": true },
    "capabilities": {
      "fts5": true,
      "vectorSearch": true,
      "scoring": true,
      "knowledgeEvolution": true,
      "embeddings": "tfidf",
      "llm": null,
      "searchLevel": 0
    }
  }
}
```

### GET /v1/update-status

Returns the current package version, the latest npm version MeMesh knows about, freshness metadata for the last update check, and install-channel-aware update guidance.

Use `?cached=1` to read the cached state only. Without it, MeMesh prefers a fresh npm lookup and falls back to the cached state when npm is unavailable.

**Response**:

```json
{
  "success": true,
  "data": {
    "currentVersion": "4.0.2",
    "latestVersion": "4.0.3",
    "checkedAt": "2026-04-24T10:15:00.000Z",
    "lastAttemptAt": "2026-04-24T10:15:00.000Z",
    "lastSuccessfulCheckAt": "2026-04-24T10:00:00.000Z",
    "lastError": "npm unavailable",
    "updateAvailable": true,
    "checkSucceeded": false,
    "source": "cache",
    "freshness": "cached",
    "installChannel": "source-checkout",
    "canSelfUpdate": false,
    "recommendedCommand": null
  }
}
```

**Freshness values**:
- `fresh`: latest version came from a successful live npm lookup
- `cached`: using the last successful cached result
- `stale`: using a cached result whose last success is older than the freshness threshold
- `unavailable`: no successful update check has been recorded yet

### POST /v1/config

Save a partial config update. Fields not provided are preserved.

**Request body**: Any subset of `MeMeshConfig` fields (`theme`, `autoCapture`, `sessionLimit`, `llm`, etc.)

**Response**: `{ success: true, data: <updated config> }` (API key masked if present)

### GET /v1/stats

Returns aggregate counts and distributions for the knowledge graph.

**Response**:

```json
{
  "success": true,
  "data": {
    "totalEntities": 42,
    "totalObservations": 128,
    "totalRelations": 15,
    "totalTags": 30,
    "typeDistribution": [{"type": "decision", "count": 12}, ...],
    "tagDistribution": [{"tag": "project:myapp", "count": 8}, ...],
    "statusDistribution": [{"status": "active", "count": 40}, {"status": "archived", "count": 2}]
  }
}
```

### GET /v1/graph

Returns all entities (including archived) and all relations, suitable for graph visualization.

**Response**:

```json
{
  "success": true,
  "data": {
    "entities": [...],
    "relations": [{"from": "auth-decision", "to": "api-design", "type": "related-to"}, ...]
  }
}
```

### GET /v1/analytics

Returns computed analytics insights for the memory database.

**Response:**

```json
{
  "success": true,
  "data": {
    "healthScore": 72,
    "healthFactors": {
      "activity": 50,
      "quality": 80,
      "freshness": 60,
      "lessons": 100
    },
    "timeline": [
      { "day": "2026-04-01", "created": 5, "recalled": 12 }
    ],
    "valueMetrics": {
      "totalRecalls": 500,
      "lessonsSaved": 5,
      "lessonCount": 8,
      "typeDistribution": [
        { "type": "concept", "count": 120 },
        { "type": "decision", "count": 45 }
      ]
    },
    "cleanup": {
      "staleEntities": [
        { "id": 42, "name": "old-auth", "type": "concept", "confidence": 0.2, "days_unused": 90 }
      ],
      "duplicateCandidates": [
        { "name1": "auth-flow", "name2": "authentication-flow", "type": "concept" }
      ]
    }
  }
}
```

**Health Score Algorithm:**
- Activity (30%): percentage of active entities accessed in last 30 days
- Quality (30%): percentage of active entities with confidence > 0.7
- Freshness (20%): new entities this week relative to 5% of total (capped at 100%)
- Lessons (20%): lesson_learned entity count, 5+ gives full score

### GET /dashboard

Returns the full interactive MeMesh Dashboard as a self-contained HTML page. Served by the HTTP server — no separate build step needed.

**Usage**: Open `http://localhost:3737/dashboard` in a browser, or run `memesh` (no args) to auto-open it.

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

### memesh export-schema

Export MeMesh tools in OpenAI function calling format. Use this to integrate MeMesh with any OpenAI-compatible API or SDK.

**Usage**:

```bash
memesh export-schema
memesh export-schema --format openai
```

**Options**:

| Option | Description |
|--------|-------------|
| `--format <format>` | Output format. Currently only `openai` is supported (default: `openai`). |

**Output**: A JSON array of OpenAI function calling tool definitions:

```json
[
  {
    "type": "function",
    "function": {
      "name": "memesh_remember",
      "description": "Store knowledge as an entity with observations, tags, and relations.",
      "parameters": { ... }
    }
  },
  ...
]
```

The exported schema can be passed directly to the OpenAI `tools` parameter or any OpenAI-compatible API:

```python
import json, openai

with open("schema.json") as f:
    tools = json.load(f)

client = openai.OpenAI()
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Remember that we use OAuth"}],
    tools=tools,
)
```

Or generate on the fly:

```bash
memesh export-schema | python -c "
import json, sys, openai
tools = json.load(sys.stdin)
# pass tools to your OpenAI call
"
```

---

### Python SDK

MeMesh includes a Python SDK that connects to a running `memesh serve` instance.

**Installation**:

```bash
pip install memesh
```

**Requires**: `memesh serve` running (default: `localhost:3737`).

**Usage**:

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth"])
results = m.recall("auth")
m.forget("old-design")
```

See `packages/python-sdk/` for full SDK source and documentation.

---

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

### GET /v1/patterns

Returns user work patterns extracted from existing memory entities.

**Response fields:** `workSchedule` (hour/day distribution), `toolPreferences`, `focusAreas`, `workflow` (avg session minutes, commits/session), `strengths` (high-confidence types), `learningAreas` (tags from lessons/mistakes).
