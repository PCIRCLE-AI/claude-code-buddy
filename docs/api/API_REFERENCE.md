# MeMesh Plugin -- API Reference

**Protocol**: Model Context Protocol (MCP) over stdio
**Version**: 4.2.11
**Compatibility**: Works with Claude Code plugins, Claude Managed Agents (via MCP connector), and any MCP-compatible client.

---

## Tools

MeMesh exposes 9 tools via MCP.

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

Search and retrieve stored knowledge. Uses FTS5 full-text search + sqlite-vec vector supplement, with optional tag filtering and multi-factor scoring. The hot path is LLM-free. Results are ranked by a weighted combination of search relevance, recency, access frequency, confidence, and recall-effectiveness impact. Call with no query to list recent memories.

Query terms are OR-ed and the matches are ordered by relevance (BM25) before scoring, so a question phrased in your own words finds the memory instead of requiring every word to appear in it. A memory matching more of your terms ranks higher; adding words narrows the ranking, not the result set. Terms appearing in more than half the indexed rows are dropped as noise — they are the ones BM25 already scores near zero — except that a query made entirely of common words keeps its rarest term rather than matching nothing, and the guard does not apply below 25 indexed rows, where a frequent word is the subject rather than a stopword. Of what survives, the 32 most selective terms are used. Punctuation inside a word splits it (`kitchen's` searches for `kitchen` and `s`, not for the exact phrase). Results are deterministic: BM25 ties break by recency, so the same query over the same memories returns the same list.

A query that is not empty but contains nothing searchable — `???`, `@#$%` — returns no results rather than falling back to the recent list, so "nothing matched" is never dressed up as "here is what matched". Call with no query at all to list recent memories.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Search query (FTS5 full-text search; terms are OR-ed and ranked by relevance, first 32 terms used). Leave empty to list recent entities. |
| `tag` | string | No | Filter by tag (e.g., `"project:myapp"`) |
| `limit` | number | No | Max results (default: 20, max: 100) |
| `include_archived` | boolean | No | Include archived (forgotten) entities in results (default: false) |
| `namespace` | string | No | Filter to a specific namespace (`"personal"`, `"team"`, `"global"`) |
| `cross_project` | boolean | No | When `true`, lifts project-tag filter and searches all namespaces (default: false) |

**Response**:

Returns an array of matching entities ranked by multi-factor score — relevance 0.30, recency 0.25, frequency 0.18, confidence 0.17, recall-effectiveness impact 0.10:

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

### verify_agent_work

Persist a verification report for work done by a background agent. Runs a deterministic git reality-check (diff `<base>..HEAD`, count files changed, optionally cross-check against a claimed file count) and stores the result as a `verification_record` entity tagged `verification` + `verification:pass|fail|unverified`. Heavier checks (typecheck/tests/lint/build) are expected to be pre-computed by an upstream hook and passed in via `report.*.pass` — this tool focuses on persistence + cross-checking, not running test suites.

**`verdict` is three-valued.** Both `claim` and `report` are optional, and with neither supplied there is nothing to check against — counting changed files is not a verification. That case returns `unverified`:

| `claim` | `report` | verdict |
|---|---|---|
| matches | absent | `pass` |
| mismatches | absent | `fail` |
| absent | `pass: true` | `pass` |
| absent | `pass: false` | `fail` |
| matches | `pass: false` | `fail` — any failure wins |
| **absent** | **absent** | **`unverified`** |

`unverified` is also returned when the check could not run at all: no git base discoverable, or `git diff` failed. That is distinct from `fail`, which means something was checked and did not hold.

This field replaces the previous `pass: boolean`, which returned `true` for the no-claim-no-report case. A caller still reading `result.pass` now gets `undefined`, which is falsy — the safe direction.

**Parameters:**
- `agent_id` (string, required) — Identifier for the agent whose work is being verified.
- `workdir` (string, required) — Absolute path to the git working tree the agent edited.
- `base` (string, optional) — Git ref/sha to diff against. Defaults to merge-base with origin/main.
- `claim` (object, optional) — Numbers the agent claimed in its summary, used for cross-checking.
  - `expected_files` (number) — Files the agent claimed to change.
- `report` (object, optional) — Pre-computed external report.
  - `pass` (boolean, required) — Overall pass/fail of the external report.
  - `typecheck`, `tests`, `lint`, `build` (objects) — each `{ pass: boolean, summary?: string }`.
  - `summary` (string, optional) — Free-form summary line.

**Returns:**
```json
{
  "entity_name": "verification:agent-1:2026-05-03T22-00-00-000Z",
  "verdict": "pass",
  "reality_check": {
    "files_changed": 5,
    "expected_files": 5,
    "match": true,
    "base": "97cc25e9...",
    "verdict": "pass",
    "summary": "reality OK: 5/5 files"
  },
  "external_report": { "...": "echo of input report or null" },
  "timestamp": "2026-05-03T22:00:00.000Z"
}
```

With neither `claim` nor `report`:

```json
{
  "entity_name": "verification:agent-1:2026-05-03T22-00-00-000Z",
  "verdict": "unverified",
  "reality_check": {
    "files_changed": 5,
    "expected_files": null,
    "match": null,
    "base": "97cc25e9...",
    "verdict": "unverified",
    "summary": "5 files changed (no claim to check against)"
  },
  "external_report": null,
  "timestamp": "2026-05-03T22:00:00.000Z"
}
```

**Examples:**
```js
// Reality-check only (no external report)
{
  "agent_id": "wire-mcp-tool",
  "workdir": "/tmp/mm-vgate",
  "claim": { "expected_files": 5 }
}

// With pre-computed external report from local hook
{
  "agent_id": "wire-mcp-tool",
  "workdir": "/tmp/mm-vgate",
  "claim": { "expected_files": 5 },
  "report": {
    "pass": true,
    "typecheck": { "pass": true },
    "tests": { "pass": true, "summary": "519/520 passed" }
  }
}
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

### Request body limits

All `POST /v1/*` endpoints enforce a **1 MB request body limit**. Requests larger than this receive a structured `413 Payload Too Large` response:

```json
{
  "success": false,
  "error": "Request body exceeds the 1MB limit",
  "code": "PAYLOAD_TOO_LARGE",
  "limit": "1mb",
  "hint": "Split large exports/imports into smaller batches, or compress and stream them via the CLI (`memesh export` / `memesh import`) which has no per-request size cap."
}
```

The limit protects the server from accidentally parsing large payloads (e.g. an unbounded `/v1/import` with a multi-MB JSON bundle) under memory pressure. For bulk operations that exceed 1 MB, prefer the CLI: `memesh export > bundle.json` and `memesh import bundle.json` read and write files directly without buffering the whole payload through Express's body parser, so they have no per-request size cap.

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
| GET | /v1/entities | List entities (pagination); supports `?type=<type>` and `?limit=<n>` |
| GET | /v1/entities/:name | Get single entity |
| GET | /v1/config | Get current config and detected capabilities |
| GET | /v1/update-status | Current/latest package version, freshness state, and update guidance |
| POST | /v1/config | Save config (partial update); resets embedding state if LLM changed |
| POST | /v1/config/test | Validate provider+apiKey against the live `/v1/models` endpoint and return the available model list |
| GET | /v1/stats | Aggregate counts: entities, observations, relations, tags; type/tag/status distributions |
| GET | /v1/graph | Signal entities (all non-noise types) + up to 200 recent noise entities + all relations |
| GET | /v1/analytics | Health score, memory-loop metric, 30-day timeline, ageMatrix, knowledgeRadar |
| GET | /v1/patterns | User work patterns: schedule, tools, focus areas, workflow, strengths, learning |
| POST | /v1/verify | Record a verification report for background-agent work; returns `verdict: pass \| fail \| unverified` |
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
    "currentVersion": "4.2.8",
    "latestVersion": "4.2.9",
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

Returns entities prioritized for graph visualization: all non-noise entities (decision, lesson_learned, pattern, bug_fix, etc.) plus up to 200 recent noise entities (commit, session_keypoint, weekly-summary), and all relations.

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
    "loopMetric": {
      "reusedThisWeek": 12,
      "trend": [ { "date": "2026-04-01", "count": 3 } ],
      "computedFrom": "last_accessed_at_approximation"
    },
    "ageMatrix": [
      { "type": "lesson_learned", "bucket": "week", "count": 3 },
      { "type": "decision", "bucket": "month", "count": 8 }
    ],
    "knowledgeRadar": [
      { "axis": "lessons", "count": 57, "types": ["lesson_learned", "lesson", "mistake"] },
      { "axis": "decisions", "count": 28, "types": ["decision", "architecture_decision", "design_decision"] }
    ]
  }
}
```

> `valueMetrics`, `recallEffectiveness`, and `cleanup` were removed — they were computed on every request but never rendered by any dashboard component. The dashboard reads `healthScore`, `healthFactors`, `loopMetric`, `timeline`, `ageMatrix`, and `knowledgeRadar`.

**Health Score Algorithm:**
- Activity (30%): percentage of active entities accessed in last 30 days
- Quality (30%): percentage of active entities with confidence > 0.7
- Freshness (20%): new entities this week relative to 5% of total (capped at 100%)
- Lessons (20%): lesson_learned entity count, 5+ gives full score

### GET /v1/analytics/pm

Returns PM-framed metrics: decision velocity, knowledge-graph connectedness, and staleness indicators. Designed for the dashboard PM Analytics panel.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `window` | number | 30 | Lookback window in days for velocity calculations |

**Response:**

```json
{
  "success": true,
  "data": {
    "velocity": {
      "decisionsPerWeek": 2.1,
      "releasesPerMonth": 0.5,
      "windowDays": 30
    },
    "staleness": {
      "stalePlanCount": 1,
      "openDecisionCount": 3
    },
    "connectedness": {
      "orphanRate": 0.117,
      "totalRelations": 2970,
      "activeEntities": 1326
    }
  }
}
```

- `stalePlanCount`: active `plan` entities not accessed in 30+ days
- `openDecisionCount`: active `decision` entities created more than 14 days ago and not yet superseded
- `orphanRate`: fraction of active entities with zero relations (lower = better connected KG)

### POST /v1/config/test

Probes the provider's `/v1/models` endpoint with the supplied `apiKey` (or local `host` for Ollama) and returns whether the credential authenticates plus the live model catalog. Used by the dashboard Settings tab to validate before persisting and to populate a model dropdown with real choices instead of stale hardcoded names. **Does not write to disk.**

**Request body:**

```json
{
  "provider": "anthropic" | "openai" | "ollama",
  "apiKey": "<optional, required for anthropic/openai>",
  "host": "<optional, Ollama base URL, defaults to http://localhost:11434>"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "valid": true,
    "models": [
      { "id": "claude-haiku-4-5", "created": "2026-04-01T00:00:00Z" },
      { "id": "claude-opus-4", "created": "2026-01-15T00:00:00Z" }
    ],
    "suggested": "claude-haiku-4-5"
  }
}
```

On failure: `{ valid: false, error: "<provider message>" }`. The endpoint always returns HTTP 200 with `success:true` even when `valid:false` — the boolean is the contract, not the HTTP status.

The `suggested` model picks the first entry whose id contains a small-tier hint (`mini`, `nano`, `haiku`, `flash`, `lite`, `small`, `8b`, `7b`, `3b`), preferring the most recently `created`. Falls back to the first entry when no hint matches.

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

### memesh verify

Reality-check work an agent claims to have done, and record the result.

Compares the actual `git diff` against the caller's claim and/or an external
report, then persists a `verification_record` entity.

**Exit codes** — these are the contract a shell gate depends on:

| Code | Verdict | Meaning |
|------|---------|---------|
| 0 | `pass` | Something was checked and it held |
| 1 | `fail` | Something was checked and it did not hold |
| 2 | `unverified` | Nothing was checked — no claim, no report, or a claim that could not be evaluated |

`2` is deliberately non-zero so `memesh verify … && deploy` does not deploy on
a check that never ran. A boolean could not express this: `true` used to mean
both "verified and correct" and "had nothing to verify".

**Usage**:

```bash
memesh verify --agent-id build-bot --workdir /path/to/repo --base main \
  --expected-files 3 --report ./test-report.json
```

If `--expected-files` is supplied but no git base can be discovered, the claim
cannot be evaluated and the verdict is `unverified` — not `pass` — even when an
external report says everything passed.

### memesh reindex

Regenerate vector embeddings for all entities.

`--fts` rebuilds the full-text keyword index instead. The keyword index
normally rebuilds itself once, on the first open after an upgrade, guarded by a
version marker. That marker only moves forward, so it cannot describe a
database migrated by a newer build and then written to by an older one — which
happens with a downgrade, or with an npm-global and a plugin-marketplace
install side by side. `--fts` is the way out of that state.

```bash
memesh reindex --fts
```

### memesh pin / memesh unpin

Protect an entity from the dreamer's automatic compaction (or release that protection).

The dreamer periodically compacts low-signal clusters of memories into digests. `pin` marks an entity so the compactor skips it; `unpin` removes the mark. Pinning writes `metadata.pin = true` (and unpinning removes the key), which is exactly the flag the dreamer reads before compacting.

**Usage**:

```bash
memesh pin --name "auth-architecture-decision"
memesh unpin --name "auth-architecture-decision"
```

**Options**:

| Option | Description |
|--------|-------------|
| `--name <name>` | Entity name (required). |
| `--json` | Output the result as JSON (`{ name, pinned, found }`). |

If the named entity does not exist, the command reports it and exits without error (`found: false`).

---

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

### memesh telemetry

Render the per-flow LLM telemetry scorecard for the last N days.

**Usage**:

```bash
memesh telemetry [--window <days>] [--prune <days>] [--json]
```

**Options**:

| Flag | Description |
|------|-------------|
| `--window <days>` | Look-back window for the scorecard (default 30) |
| `--prune <days>` | Run `pruneTelemetry({olderThanDays: N})` BEFORE rendering. Prints `Pruned X rows older than N days.` first. |
| `--json` | Output as JSON for programmatic consumption |

**Output**: per-flow scorecard with success rate, fallback usage, median latency, provider breakdown, and error-class chips. Auto-prune also runs from `openDatabase()` once per 24h with a 180-day default cutoff.

### memesh kg backfill-relations

Heuristic non-LLM relation backfill for orphan entities. Four rules:

1. **Tag co-occurrence**: two active entities sharing ≥ 2 topical tags get a `related-to` edge. Topical filter excludes auto-capture noise (`session_end`, `auto_saved`, `commit`, `completed`, `lesson`, etc.) to prevent cartesian explosion.
2. **Project clustering**: orphan lessons / decisions / bug-fixes / patterns in a project get a `belongs-to-project` edge to the most recent release / feature / architecture / plan in the same project.
3. **Session co-occurrence** (`--session-cooccurrence`): high-signal orphans (signal_score ≥ 0.6) sharing a `session:*` tag get a `co-created` edge. Eligible types: lesson_learned, decision, architecture, feature, bug_fix, etc.
4. **Name-token similarity** (`--name-tokens`): orphans whose tokenized names share ≥ 3 content tokens or Jaccard similarity ≥ 0.50 get a `shares-name-tokens` edge. Stopword list excludes generic qualifiers and month abbreviations to prevent cartesian explosion.

**Usage**:

```bash
memesh kg backfill-relations [--project <name>] [--dry-run] [--max-per-source <n>] \
  [--min-shared-tags <n>] [--session-cooccurrence] [--name-tokens] \
  [--min-jaccard <n>] [--all-rules] [--include-archived] \
  [--reset-idempotency] [--json]
```

**Options**:

| Flag | Default | Description |
|------|---------|-------------|
| `--project <name>` | (all) | Restrict to one project |
| `--dry-run` | off | Preview proposals without writing |
| `--max-per-source <n>` | 3 | Max edges per orphan |
| `--min-shared-tags <n>` | 2 | Minimum overlapping topical tags for Rule 1 |
| `--session-cooccurrence` | off | Enable Rule 3: session co-occurrence |
| `--name-tokens` | off | Enable Rule 4: name-token similarity |
| `--min-jaccard <n>` | 0.50 | Jaccard threshold for Rule 4 |
| `--all-rules` | off | Enable all four rules in one pass |
| `--include-archived` | off | Also process archived entities |
| `--reset-idempotency` | off | Clear the persistent "already-attempted" orphan cache (`memesh_metadata.kg_backfill_processed_v1`) before running, so every orphan is reconsidered |
| `--json` | off | Output as JSON |

**Idempotency**: re-running this command is cheap by default — orphan IDs considered in a prior run are remembered in `memesh_metadata` and skipped on subsequent runs. Use `--reset-idempotency` after a schema change or when you want every orphan reconsidered from scratch. The output summary reports `idempotency: skipped N orphans` so you can see how many were filtered.

### memesh kg rename-project

Merge or rename a `project:<name>` tag across every entity. Heals project tags that were split before project identity became git-based (e.g. a repo captured under both `project:tim` and `project:TIM`, or memories captured in a subdirectory tagged with the subdirectory name). The system cannot infer the correct project for an old value, so the mapping is user-driven.

**Usage**:

```bash
memesh kg rename-project                          # list all project tags + counts
memesh kg rename-project --from tim --to TIM      # dry-run preview (writes nothing)
memesh kg rename-project --from tim --to TIM --apply   # commit (backs up the DB first)
```

**Options**:

| Flag | Default | Description |
|------|---------|-------------|
| `--from <name>` | — | Existing project name to rewrite. Omit both `--from`/`--to` to list all project tags. |
| `--to <name>` | — | New project name |
| `--apply` | off (dry-run) | Actually write the change. **Backs up the whole DB to `data/backups/kg-before-rename-project-<timestamp>.db` first**, and prints the restore command. |
| `--json` | off | Output as JSON |

**Safety**: dry-run is the default — nothing is written until `--apply`. On `--apply` the DB file is copied to `data/backups/` before any mutation; if the backup fails, the command aborts without changing anything. The tags table has a `UNIQUE(entity_id, tag)` constraint, so an entity that already carries the target tag has its old tag removed (a merge) rather than getting a duplicate.

### memesh dream

LLM cluster compactor + pattern detector with propose / accept / reject lifecycle. The dreamer also auto-triggers from the Stop hook (gated by ≥10 episodic entities + 24h throttle), so users typically don't run this manually.

**Subcommands**:

```bash
memesh dream run [--project <name>] [--dry-run] [--max-llm-calls <n>] [--window-days <n>] [--validate]
memesh dream patterns [--project <name>] [--dry-run] [--max-llm-calls <n>] [--window-days <n>] [--min-signal <n>]
memesh dream list [--status <pending|applied|rejected|all>]
memesh dream accept <id>
memesh dream reject <id> [--reason <text>]
```

**`--validate`** on `dream run` enables the optional second-pass LLM validator (`src/core/digest-validator.ts`) which cross-checks the proposed digest's claims against source observations and attaches `validation_warnings` to soften'd proposals. Doubles per-proposal LLM cost; default off.

Validator verdicts are `pass` | `soften` | `reject` | `unavailable`. Only `reject` skips a proposal and only `soften` annotates one. `unavailable` means the validator could not run at all (LLM unreachable, fallback chain exhausted) — it is deliberately distinct from `pass`, which asserts that every claim was checked and supported. Both let the proposal through, so an unreachable validator never costs you a real digest, but a proposal validated by nothing is no longer indistinguishable from one that passed a clean check.

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

### GET /v1/telemetry

Per-flow LLM telemetry scorecard for the last `window` days. Backs the dashboard Analytics tab's "LLM activity" panel and `memesh telemetry` CLI.

**Query parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `window` | number | 30 | Look-back window in days (1–365) |

**Response shape:** `{ window_days, summaries: FlowSummary[] }` where each `FlowSummary` is `{ flow, total_calls, total_attempts, successes, failures, fallback_used, median_latency_ms, by_provider, by_model, by_project, by_error_class, sample_errors, window_days }`. `by_model` and `by_project` are `Record<string, { ok, fail }>` (per-model and per-project ok/fail counts); `sample_errors` is up to 5 recent `{ error_class, message }` failure samples. Flows: `dreamer`, `pattern_detector`, `consolidator`, `auto_tagger`, `failure_analyzer`, `digest_validator`.

### GET /v1/dream/proposals

Lists dream digest / pattern proposals from the staging table.

**Query parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | enum | `pending` | One of `pending`, `applied`, `rejected`, `all` |

**Response:** array of `{ id, project, cluster_key, source_count, digest_name, digest_observations_preview, status, created_at, kind }` where `kind` is `digest | pattern_emergent`.

### GET /v1/dream/proposals/:id

Full proposal detail for the Insights tab's expanded card view.

**Response:** `{ id, project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, status, reason, created_at, reviewed_at }`. `proposed_digest` includes `name`, `type`, `observations`, `tags`, and (when the validator ran with a `soften` verdict) `validation_warnings: Array<{claim, reason}>`.

### POST /v1/dream/run

Trigger a dream pass via HTTP. Same logic as `memesh dream run`; runs `runDreamer()` synchronously and returns the result.

**Body schema:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project` | string | (all projects) | Restrict to one project |
| `windowDays` | number | 14 | Look-back window in days (1–90) |
| `maxLlmCalls` | number | 5 | Hard cap on LLM calls (1–20) |
| `validate` | boolean | false | Run the digest validator as a second LLM pass before staging |

**Response:** `DreamerResult` shape — `{ proposalsCreated, clustersScanned, llmCalls, skipped: Array<{reason, project, clusterKey}>, durationMs }`.

### POST /v1/dream/proposals/:id/accept

Apply a pending dream proposal — creates the digest entity (or `pattern_emergent` entity for pattern proposals), inserts `summarizes` / `evidence_for` relation edges, and soft-archives source entities for digest proposals.

**Response:** `{ proposalId, digestEntityName, sourcesArchived, sourcesLinked, kind }`.

### POST /v1/dream/proposals/:id/reject

Mark a pending proposal as rejected. Source entities are untouched.

**Body schema:**
| Field | Type | Description |
|-------|------|-------------|
| `reason` | string (optional, ≤500 chars) | Why this proposal was rejected |

**Response:** `{ id, status: 'rejected' }`.
