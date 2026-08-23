# MeMesh Plugin -- API Reference

**Protocol**: Model Context Protocol (MCP) over stdio
**Version**: 4.6.2
**Compatibility**: Works with Claude Code plugins, Claude Managed Agents (via MCP connector), and any MCP-compatible client.

**Native Integrations**: Beyond MCP, MeMesh integrates as a native memory provider for Hermes Agent (Python `MemoryProvider` plugin) and OpenClaw (TypeScript memory-capability plugin) — same tier as their built-in backends, not HTTP bridges. See [docs/platforms/](../platforms/) for platform-specific guides.

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
| `title` | string | No | Short human-readable label shown wherever the memory is listed (e.g. `"Why we dropped JWT"`), max 200 characters — longer is **rejected**, not truncated, so the caller can shorten it themselves. On an entity that already exists, supplying this replaces the title; omitting it leaves the title it already has. Whitespace-only counts as omitted. |
| `observations` | string[] | No | Key facts or observations about this entity |
| `tags` | string[] | No | Tags for filtering (e.g., `"project:myapp"`, `"type:decision"`) |
| `relations` | object[] | No | Relations to other entities |
| `namespace` | string | No | Namespace scope: `"personal"` (default), `"team"`, or `"global"`. On an entity that already exists, supplying this **moves** it; omitting it leaves the namespace it already has. |

**Relations object**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Target entity name (must already exist) |
| `type` | string | Yes | Relation type. Free-form label (e.g. `"implements"`, `"related-to"`) except for the two below, which change behaviour |

**Relation types that do something.** Every other type is an inert label; these two are the whole list, and the same list is enforced against the MCP schema by `tests/relation-types-documented.test.ts`:

| Type | Effect |
|------|--------|
| `supersedes` | **Archives the target entity**, immediately, on write. Use it when this memory replaces an older one. |
| `contradicts` | Makes both memories surface as a conflict every time either is recalled (see [recall → Conflict detection](#recall)). Use it when two memories cannot both be true. Stated by the caller, or staged by the conflict judge (`memesh dream conflicts`) and created only when a human accepts the proposal. |

**Causal conventions (inert, but worth agreeing on).** For links between a
decision and what it led to, use `caused` (direct: this decision produced
that outcome) or `influenced` (partial: it was one input among several),
pointing **from the cause to the effect**. These carry no machine behaviour —
they are ordinary free-form labels — but a shared vocabulary is what makes a
causal chain traversable later (`decision —caused→ incident —caused→
lesson_learned`). The principle behind stating them explicitly: **MeMesh
never infers causality.** Two memories being close in time, close in meaning,
or co-mentioned proves nothing about one causing the other, so no pipeline
here will ever manufacture a causal edge from timestamps or embedding
distance (the conflict judge proposes `contradicts`/`supersedes`/`duplicates`
from meaning — never `caused`). A cause you know but do not state is a cause
the graph does not have.

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

Three fields are conditional. `relationsCreated` lists the relations actually created — report from it rather than subtracting errors from what you asked for. `relationErrors` is included when a relation target does not exist; the entity is still stored. `movedFromNamespace` appears only when the call MOVED a memory that already existed, naming the scope it came from, and pairs with `metadata.previous_namespace` so the move can be reversed.

**Write provenance.** Every entity created through `remember` or `learn` carries `metadata.provenance.source_host` — which surface wrote it. It is **not an input parameter** on any transport (a provenance field the caller's model could fill in is not provenance); the transport sets it: the MCP server stamps the client's self-declared `initialize` name (`claude-code`, `codex`, `gemini-cli`, …; `mcp` when the client declares none), the CLI stamps `cli`, and the HTTP API stamps `http`. The stamp lands on first insert only — appending to an existing entity from another host does not rewrite it. The field is returned wherever entity `metadata` is returned (e.g. `recall` results).

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

Query terms are OR-ed and the matches are ordered by relevance (BM25) before scoring, so a question phrased in your own words finds the memory instead of requiring every word to appear in it. A memory matching more of your terms ranks higher; adding words narrows the ranking, not the result set. Terms appearing in more than half the indexed rows are dropped as noise — they are the ones BM25 already scores near zero — except that a query made entirely of common words keeps its rarest term rather than matching nothing, and the guard does not apply below 25 indexed rows, where a frequent word is the subject rather than a stopword. Of what survives, the first 32 in query order are used — dropping the ubiquitous terms *before* the cap means a bigram-segmented CJK question no longer loses its whole tail to terms that would have been discarded anyway, but the cap itself is still positional, so a query with more than 32 surviving terms does lose its tail. Punctuation inside a word splits it (`kitchen's` searches for `kitchen` and `s`, not for the exact phrase). Results are deterministic: BM25 ties break by recency, so the same query over the same memories returns the same list.

A query that is not empty but contains nothing searchable — `???`, `@#$%` — returns no results rather than falling back to the recent list, so "nothing matched" is never dressed up as "here is what matched". This holds with embeddings enabled too: the vector supplement is skipped for such a query rather than returning its semantically-nearest memories. Call with no query at all to list recent memories.

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

Returns an object whose `entities` array holds the matching entities ranked by multi-factor score — relevance 0.30, recency 0.25, frequency 0.18, confidence 0.17, recall-effectiveness impact 0.10. The envelope is an object, never a bare array: Gemini CLI JSON-parses a tool's text payload into the MCP result's `structuredContent`, which the protocol requires to be an object — a bare array failed every Gemini recall while other hosts read it fine:

```json
{
  "entities": [
    {
      "id": 1,
      "name": "auth-decision",
      "title": "Why we chose JWT",
      "type": "decision",
      "created_at": "2026-03-09 12:00:00",
      "observations": [
        "Chose JWT for authentication",
        "Using RS256 algorithm for token signing"
      ],
      "tags": ["project:myapp", "topic:auth"],
      "relations": [
        {"from": "auth-decision", "to": "api-design", "type": "related-to"}
      ],
      "match": {"source": "keyword", "relevance": 0.42}
    }
  ],
  "retrieval": {"mode": "hybrid", "degraded": false, "truncated": false}
}
```

`title` is present on every entity that has one and `null` on the ones that do
not — a memory written before titles existed, or by a caller that sent none.
Show it where you would otherwise show `name`; `name` is the identifier the
other tools address the memory by, not a label meant to be read.

**Retrieval metadata (`retrieval`)**: every recall envelope says HOW it was
answered — the three things the rows themselves cannot tell you. `mode` is
`"hybrid"` when the vector supplement actually ran and `"fts"` when the
answer is keyword-only (either because embeddings are not configured, or
because there was no searchable query). `degraded: true` means embeddings
ARE configured but the vector side could not run right now — provider
failure or missing sqlite-vec — so keyword-only results are a degradation,
not the configured behaviour (`memesh doctor` diagnoses why; before this
field, that condition was silent). `truncated: true` means the results
filled `limit` and more may exist — a small hit count is a window, not a
graph-wide count, and this flag is the difference between "that is all"
and "that is all I was allowed to return". The CLI prints a warning line
when degraded and a `(limit reached — more may exist)` note when
truncated.

**Provenance (`match`)**: when the call has a query, every result says how it
was found. `"source": "keyword"` means the full-text index matched your words;
`"source": "semantic"` means the keyword index found nothing for this entity
and it was surfaced by vector similarity alone. The distinction is disclosed
because similarity cannot certify relevance — measured on this project's own
calibration data, the distance ranges of unrelated and genuinely related
memories overlap, so a semantic-only result may be unrelated. `relevance` is
the 0–1 similarity for semantic results and the normalized keyword score for
keyword results. The CLI renders this honestly: a result set that is entirely
semantic is prefixed with `No keyword matches. Closest memories by meaning —
may be unrelated:` and each such row carries a `~N% semantic` badge. The
empty-query listing (recent memories) carries no `match` field — a listing is
not a match. In CLI (non-`--json`) output, observations longer than 500
characters are capped on display with `… (+N more chars)`; storage and
`--json` always carry the full text.

**Conflict detection**: When any pair of returned entities have a `contradicts` relation, the object gains a `conflicts` array beside `entities`. Nothing creates that relation for you — a caller states it via `remember`'s `relations` (see [remember](#remember)), so an absent `conflicts` means "none stated between these results", not "checked and clean":

```json
{
  "entities": [...],
  "retrieval": {"mode": "hybrid", "degraded": false, "truncated": false},
  "conflicts": [
    "\"no-jwt\" contradicts \"use-jwt\""
  ]
}
```

The CLI prints conflict warnings below the results; the `--json` flag outputs the same object envelope (`entities` + `retrieval`, plus `conflicts` when any exist).

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

### consolidate — retired

`consolidate` was removed. It deleted an entity's observations and wrote an LLM summary in their place, immediately: no proposal, no review, and nothing to restore from if the summary was wrong. It also ignored pins, and reset `confidence` to 1.0 on success. A failure between the delete and the write left the entity permanently empty while the result reported that nothing had happened.

**MCP**: the tool is gone from the registry.
**HTTP**: `POST /v1/consolidate` answers `410 Gone` with a pointer, rather than 404 — a script author reads the difference.
**CLI**: `memesh consolidate` prints where to go and exits `1`.

Use [`dream`](#dream) instead: it proposes digests and applies nothing until a proposal is accepted, keeps `source_ids`, and archives sources rather than deleting them. It is **not** a like-for-like replacement — `dream` merges *clusters* of episodic memories (commits, session notes) into a digest, and never touches lessons, decisions, architecture notes or pinned entities. There is no reviewed equivalent of "compress this one named entity" today.

---

### export

Export memories to a portable JSON bundle. Use for personal backup, migrating between machines, or optional manual transfer between compatible agents.

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
      "title": "Why we chose OAuth 2.0",
      "type": "decision",
      "namespace": "team",
      "observations": ["Use OAuth 2.0"],
      "tags": ["project:myapp", "topic:auth"],
      "relations": []
    }
  ]
}
```

`title` is `null` for an entity that has none. Bundles written before titles existed carry no `title` key at all, and `import` reads that as "this bundle says nothing about the title" — it leaves an existing entity's title alone rather than clearing it.

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
| `namespace` | string | No | Force imported entities into this namespace, ignoring the namespace stored in the bundle. With `overwrite` or `append` it also **moves** entities that already exist, in bulk, out of the scope they are in — `metadata.previous_namespace` records where each came from. With `skip` it does not: see the table below. Must be `personal`, `team` or `global`; anything else is refused outright. |

**Merge Strategies**:

| Strategy | Behaviour on existing entity | Does `namespace` move it? |
|----------|------------------------------|---------------------------|
| `skip` | Keep existing entity unchanged, discard imported copy | **No** — "unchanged" includes its namespace |
| `overwrite` | Replace existing entity's observations and tags with imported values | Yes |
| `append` | Append imported observations to existing, deduplicate tags | Yes |

`skip` is the exception because it is the one strategy that promises to touch
nothing that is already there, and a namespace move is a change — it takes the
memory out of every scoped recall that used to return it. An import asking to
skip existing entities does not get to relocate them as a side effect.

A bundle's `title` is applied to the entities the import creates, and replaces
the title of one it updates (`overwrite`, `append`). A bundle entry with no
title — or a blank one — leaves an existing title as it was; over-long titles
are truncated rather than refused, because one bad row must not cost the whole
bundle.

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

// File NEW entities under team; existing ones keep the namespace they have,
// because `skip` leaves existing entities alone
{"data": {...}, "merge_strategy": "skip", "namespace": "team"}

// Move existing entities into team as well as filing new ones there
{"data": {...}, "merge_strategy": "append", "namespace": "team"}
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
  "learned": true,
  "name": "lesson-myproject-null-reference",
  "type": "lesson_learned"
}
```

`name` is generated from the project and the error text. To see what was stored — the observations and the `severity:` / `error-pattern:` tags — recall the entity by that name.

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

### task_state

Read or update where the work stands on a project: the goal, the next step, what is blocked, and what was just finished. There is exactly one state per project, and it is injected at the top of the next session's context.

Call it with **no arguments** to read. Any field present is a write.

**Only record what the user actually stated.** These four values are handed to a future session as fact, with nothing to contradict them — a goal inferred from which files were edited is a wrong instruction with no author. Nothing derives this automatically for the same reason; the Stop hook can see that six files changed, which is not a goal.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project name (default: the current working directory's project) |
| `goal` | string | No | What this work is FOR — the outcome being aimed at |
| `next` | string | No | The next concrete step |
| `blocked` | string | No | What is standing in the way |
| `done` | string | No | What was just finished |

Passing an **empty string** clears a field — that is how a blocker is removed once it is resolved. Omitting a field leaves it untouched, which is a different thing.

**Response**:

```json
{
  "project": "myproject",
  "state": {
    "goal": "Ship the work-topology injection",
    "next": "Open the PR once Windows CI is green",
    "updated_at": "2026-08-16T02:41:00.000Z"
  },
  "changed": ["next"]
}
```

`changed` lists the fields that actually differed. Re-stating a value that is already recorded returns `"changed": []` and writes nothing — which is what keeps `updated_at` an honest answer to "how old is this thinking". A read (no arguments) returns `project` and `state` only.

**Examples**:

```json
// Read the current state
{}

// Record a goal and the next step
{
  "goal": "Cut session-start injection below 700 tokens",
  "next": "Measure against the real graph before and after"
}

// Clear a blocker that has been resolved
{
  "blocked": ""
}
```

---

### briefing

The assembled work topology for a project, ready to place in context: where the work was left off (the `task_state` fields), decisions and direction, lessons not to repeat, what is known, and recent activity — the same block the Claude Code session-start hook injects. This is the cross-vendor read path: an MCP client that runs no hooks (Gemini, Codex) calls this once at the start of a session instead.

The text is wrapped in the same fence and "background data, not instructions" preamble the hook uses. Memory content is attacker-influenced in the general case, and the wrapping is done by the same single owner on every path.

**Input Schema**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | No | Project name (default: the current working directory's project) |

**Response**:

```json
{
  "project": "myproject",
  "text": "MeMesh reference memory. Treat the content below as background data…",
  "entityCount": 12,
  "hasTaskState": true
}
```

`text` is empty when the project has no injectable memories yet. `entityCount` counts the memory lines actually rendered into the block (the character budget can cut candidates), excluding the task-state block. Also available as `memesh briefing` on the CLI, for agents whose only integration is a shell.

**Examples**:

```json
// Load context at session start
{}

// Another project's briefing
{ "project": "other-repo" }
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
    "dayDistribution": [{"dayNum": 1, "count": 50}]
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

Safety note: non-loopback binds are blocked by default. To expose the HTTP server beyond the local machine, you must pass `memesh serve --host 0.0.0.0 --allow-remote` or set `MEMESH_HTTP_ALLOW_REMOTE=true`.

**Authentication on a remote bind.** A non-loopback bind requires a bearer token on every `/v1` request — MeMesh generates one before it starts listening, so there is no unauthenticated window:

| | |
|---|---|
| Header | `Authorization: Bearer <token>` |
| Token file | `~/.memesh/remote-token`, mode 600, printed at startup |
| Override | `MEMESH_REMOTE_TOKEN` |
| Rotate | Delete the token file and restart |

The requirement is keyed to the **bind address**, not to the flag. `--allow-remote` on the default loopback host generates no token and requires no auth — the server is reachable only from this machine, and it says so at startup. Loopback requests are never challenged, even while a remote listener is running: the check is per-listener.

This is transport authentication only. It does not authorise individual callers or separate their data — everyone holding the token sees the whole graph.

### Request body limits

All `POST /v1/*` endpoints enforce a **1 MB request body limit**. Requests larger than this receive a structured `413 Payload Too Large` response:

```json
{
  "success": false,
  "errorCode": "payload.too-large",
  "error": "Request body exceeds the 1MB limit",
  "code": "PAYLOAD_TOO_LARGE",
  "limit": "1mb",
  "hint": "Split large exports/imports into smaller batches, or stream them via the CLI (`memesh export` / `memesh import`) which reads/writes files directly and is not subject to the per-request 1MB cap."
}
```

The limit protects the server from accidentally parsing large payloads (e.g. an unbounded `/v1/import` with a multi-MB JSON bundle) under memory pressure. For bulk operations that exceed 1 MB, prefer the CLI: `memesh export > bundle.json` and `memesh import bundle.json` read and write files directly without buffering the whole payload through Express's body parser, so they have no per-request size cap.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /v1/health | Health check + version + entity count |
| GET | /v1/doctor | Run the full doctor check suite; secrets in the result are redacted before the response leaves the server |
| POST | /v1/remember | Store knowledge |
| POST | /v1/recall | Search knowledge; with neither `query` nor `tag` it lists recent entities |
| POST | /v1/forget | Archive or remove observation |
| POST | /v1/consolidate | **Retired** — answers `410 Gone`. Use `POST /v1/dream/run`. |
| POST | /v1/export | Export memories as JSON bundle |
| POST | /v1/import | Import memories from JSON bundle with merge strategy |
| POST | /v1/learn | Record structured lesson from mistake or discovery |
| POST | /v1/why | File attribution: join caller-resolved commit hashes to commit entities, their sessions, and file-tag memories |
| GET | /v1/entities | List entities (pagination); supports `?type=<type>` and `?limit=<n>` |
| GET | /v1/entities/:name | Get single entity |
| GET | /v1/config | Get current config and detected capabilities |
| GET | /v1/update-status | Current/latest package version, freshness state, and update guidance |
| POST | /v1/config | Save config (partial update); resets embedding state if LLM changed |
| POST | /v1/config/test | Validate provider+apiKey against the live `/v1/models` endpoint and return the available model list |
| GET | /v1/stats | Aggregate counts: entities, observations, relations, tags; type/tag/status distributions |
| GET | /v1/graph | Signal entities (all non-noise types) + up to 200 recent noise entities + all relations |
| GET | /v1/graph?layer=work | The work layer only: decisions, lessons, plans — plus per-node evidence counts |
| GET | /v1/graph/evidence?node=NAME | The evidence supporting one work node, loaded on drill-down |
| GET | /v1/analytics | Health score, memory-loop metric, 30-day timeline, ageMatrix, knowledgeRadar |
| GET | /v1/patterns | User work patterns: schedule, tools, focus areas, workflow, strengths, learning |
| POST | /v1/verify | **Retired** — answers `410 Gone`. Removed with the agentic-orchestration experiment. |
| POST | /v1/demo/seed | Insert the demo tour dataset (entities tagged `metadata.demo = true`) |
| POST | /v1/demo/reset | Remove every demo entity; all-or-nothing transaction |
| GET | /v1/projects | Distinct projects from `project:*` tags and name-prefix heuristics, with per-project counts |
| GET | /dashboard | Interactive web dashboard (HTML) |

All responses: `{ success: true, data: ... }` or `{ success: false, errorCode: "...", error: "..." }`

### Stable error codes

Every `success: false` envelope carries a machine-readable `errorCode` **alongside** the human `error` string. The `error` text is English prose and may be reworded in any release; `errorCode` is the stable contract — clients (the dashboard translates known codes into the UI locale) should branch on it instead of matching English sentences. Removing or renaming a code is a breaking change; adding one is not.

| `errorCode` | HTTP status | Meaning |
|---|---|---|
| `auth.missing-bearer` | 401 | No (or blank) `Authorization: Bearer <token>` header on a remote-bound listener |
| `auth.invalid-token` | 401 | A bearer token was presented but did not match |
| `auth.not-configured` | 503 | Remote listener is up but no token was provisioned (server misconfiguration) |
| `validation.bad-body` | 400 | Request body missing, not valid JSON, or failed schema validation |
| `validation.bad-param` | 400 | A path or query parameter is invalid |
| `route.retired` | 410 | Endpoint retired on purpose; the `error` text names the replacement |
| `route.not-found` | 404 | No such route (the legacy `code: "NOT_FOUND"` field is also kept) |
| `resource.not-found` | 404 | Route exists, but the named entity / proposal does not |
| `payload.too-large` | 413 | Body exceeds the 1 MB limit (the legacy `code: "PAYLOAD_TOO_LARGE"` field is also kept) |
| `operation.failed` | 400 | The request was well-formed but the operation itself rejected it |
| `llm.not-configured` | 400 | The endpoint needs Smart Mode and no LLM provider is configured |
| `server.internal` | 500/503 | Unexpected server-side failure |

`POST /v1/config/test` is the one surface whose failures travel *inside* a `success: true` envelope (the probe outcome is data, not a transport error); its stable codes are documented with that endpoint below.

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
    "currentVersion": "4.2.10",
    "latestVersion": "4.2.11",
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

**Request body**: Any subset of `MeMeshConfig` fields (`llm`, `llmFallbacks`, `autoCapture`, `sessionLimit`, `autoUpdate`, `language`, `setupCompleted`)

`language` sets the output language for LLM-generated *content* — dreamer digests, emergent patterns, lessons, digest-validator reasons. It is free-form (a locale code like `zh-TW` or a language name like `繁體中文`, max 60 chars) because it becomes a prompt instruction, not a parsed locale. Unset means English. It is deliberately separate from the dashboard's own locale (stored client-side in the browser): that setting translates the UI chrome, this one decides what language generated memories are written in. Machine identifiers (entity type slugs, tags, category enums) stay English regardless. CLI equivalent: `memesh config set language zh-TW` / `memesh config unset language`.

`llmFallbacks` is the ordered cross-provider failover chain, written *wholesale* — the array you send replaces the stored one, so send the entries in the priority order you want (index 0 is tried first after the primary). Stored secrets are preserved through an EXPLICIT identity, never positional guessing: because GET masks every fallback `apiKey` as `***`, a client MUST NOT echo that mask back. To keep the key already on disk for an entry, send it **with no `apiKey`** and a `keepKeyFrom: <original index>` — the index that entry occupied in the chain you loaded. The server refills the key from exactly that stored slot (guarded by a `provider` match, so a stale index can never graft one provider's key onto another), then strips `keepKeyFrom` before persisting. Carry `keepKeyFrom` with the entry across reorders and removals; omit it (or send `null`) for a new entry, one whose key you retyped, or one whose provider you changed. An entry that sends an `apiKey` sets or rotates that key and wins over `keepKeyFrom`. An entry with neither `apiKey` nor `keepKeyFrom` is stored with no key. CLI equivalent: `memesh config set llmFallbacks '[{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-..."}]'`.

**Response**: `{ success: true, data: <updated config> }` (every API key — primary and fallback chain — masked if present)

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

### GET /v1/graph?layer=work

The two-layer view. Returns only work-layer entities — the types
`src/core/work-topology.ts` lists as `WORK_LAYER_TYPES` (`decision`,
`lesson_learned`, `lesson`, `mistake`, `milestone`, `pattern`,
`technical_pattern`, `goal`, `plan`, `task-state`) — with the relations whose
BOTH endpoints are in that layer, and a count of the evidence supporting each
node. Archived entities are excluded.

`evidenceCounts` maps a work-node name to its number of incoming `evidences`
edges; a node with no such edge is absent from the map. Those edges are drawn
by `memesh kg backfill-relations`, not by the hooks — a graph where every
count is zero means the backfill has not run, not that the work happened
without evidence.

Any other `layer` value is a `400` with `errorCode: "validation.bad-param"`.
There is no `layer=evidence`: the evidence layer is an order of magnitude
larger than the work layer and is fetched one node at a time, below.

**Response**:

```json
{
  "success": true,
  "data": {
    "entities": [...],
    "relations": [{"from": "auth-decision", "to": "api-design", "type": "supersedes"}],
    "evidenceCounts": {"auth-decision": 12}
  }
}
```

### GET /v1/graph/evidence?node=NAME

The drill-down: the evidence entities carrying an `evidences` edge to one work
node, newest first, with the edges themselves. `node` is the entity NAME and is
required (`400`, `validation.bad-param` without it); a name that matches no
entity is a `404` with `errorCode: "resource.not-found"` — distinct from a node
that exists and has no evidence, which is a `200` with empty arrays.

At most 200 entities are returned. `truncated: true` says the page filled and
more exist — the same in-band honesty rule `recall`'s `retrieval` block follows.

**Response**:

```json
{
  "success": true,
  "data": {
    "entities": [...],
    "relations": [{"from": "commit-a1b2c3d", "to": "auth-decision", "type": "evidences"}],
    "truncated": false
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
- Freshness (20%): new entities this week as a fraction of all active entities, capped at 100% (`min(newThisWeek / totalActive, 1)` in `src/core/analytics.ts`; this line previously said "relative to 5% of total", a formula the code never used)
- Lessons (20%): lesson_learned entity count, 5+ gives full score

### GET /v1/doctor

Runs the same check suite as `memesh doctor` and returns the structured result. Any secret-shaped substring (API keys, bearer tokens) is redacted before the response leaves the server — defence in depth on top of the config masking.

**Response:** `{ "success": true, "data": { ...doctor result... } }`, or `500` with `{ "success": false, "error": "..." }` if the suite itself failed to run.

### GET /v1/projects

Lists distinct projects extracted from entity tags (`project:*`) and entity name prefixes. The dashboard's Memories and Project tabs use it to populate the project chips.

**Response:**

```json
{
  "success": true,
  "data": [
    { "name": "memesh", "count": 421, "types": ["decision", "lesson_learned"], "source": "mixed" }
  ]
}
```

`source` says how the assignment was made: an explicit `project:` tag, the name-prefix heuristic, or both.

### POST /v1/demo/seed / POST /v1/demo/reset

Back the dashboard onboarding banner: `seed` inserts the demo tour dataset (every entity carries `metadata.demo = true`), `reset` removes exactly those entities in one all-or-nothing transaction, routed through the knowledge-graph delete so the FTS and vector indexes stay consistent. The CLI equivalent is `memesh demo`.

**Response:** `{ "success": true, "data": { "inserted": 12, "removed": 0 } }` — counts of demo entities written or removed.

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

When `apiKey` is omitted the server resolves a stored key so the dashboard can offer "Test with current settings" without re-typing: send `fallbackIndex: <index>` to test the stored key of `llmFallbacks[index]` (provider-guarded — it tests THAT entry's own credential, not the primary's); with no `fallbackIndex`, an omitted key resolves the primary `llm` key when its provider matches. This keeps a Test on a saved-but-untouched fallback from either falsely failing (probing empty) or falsely passing on the primary's key.

**Request body:**

```json
{
  "provider": "anthropic" | "openai" | "ollama",
  "apiKey": "<optional, required for anthropic/openai unless a stored key is resolved>",
  "host": "<optional, Ollama base URL, defaults to http://localhost:11434>",
  "fallbackIndex": "<optional, test the stored key of llmFallbacks[index]>"
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

On failure: `{ valid: false, error: "<provider message>", errorCode: "<stable code>" }`. The endpoint always returns HTTP 200 with `success:true` even when `valid:false` — the boolean is the contract, not the HTTP status. `error` is the human message (English, may be reworded); `errorCode` is the stable machine code:

| `errorCode` | Meaning |
|---|---|
| `auth` | API key empty or rejected by the provider (401/403) |
| `network` | DNS failure, connection refused/reset, timeout, or abort |
| `no_models` | Provider answered but returned zero usable models (proxy/gateway interception, or a bare Ollama with nothing pulled) |
| `bad_host` | Caller-supplied Ollama host rejected (must be loopback; use the server-side `OLLAMA_HOST` env for remote Ollama) |
| `http_<status>` | Any other upstream HTTP status, e.g. `http_429` for rate limiting |
| `unknown` | Unclassified failure |

The `suggested` model picks the first entry whose id contains a small-tier hint (`mini`, `nano`, `haiku`, `flash`, `lite`, `small`, `8b`, `7b`, `3b`), preferring the most recently `created`. Falls back to the first entry when no hint matches.

### POST /v1/why

The graph half of `memesh why` (see the CLI section): join commit hashes to
the commit entities the hooks captured, walk each entity's
`metadata.session_id` to its session entities, and collect the memories
associated with the file by `file:<basename>` tag.

The route runs **no git, ever** — commit hashes come from the caller, and
the strict schema has no repo-path field on purpose: the server is never
handed a directory to execute anything in. A caller without a working tree
(e.g. the dashboard) omits `commits` and gets the file-tag half, plus the
`no_commits_supplied` abstention saying so — omitting the field is a gap in
the question, and the response must not look like the answer "this file has
no remembered commits". A caller that resolved commits itself and found none
sends `"commits": []` and gets no such abstention.

```json
{
  "file": "src/auth.ts",          // required
  "commits": ["<hex sha, 7-40>"], // optional, max 50 — resolved by the caller
  "project": "myapp",             // optional scope for the file-tag half
  "limit": 10                     // optional, 1-50
}
```

Response `data`:

```json
{
  "file": "src/auth.ts",
  "basename": "auth.ts",
  "project": "myapp",
  "commits": [
    {
      "commit": { "hash": "…" },
      "entity": { "id": 12, "name": "commit-abc1234", "observations": ["…"], "…": "…" },
      "session": { "session_id": "…", "entities": [ { "name": "session-…-files", "…": "…" } ], "truncated": false },
      "abstentions": []
    }
  ],
  "file_memories": { "basis": "file-tag", "entities": [ … ] },
  "abstentions": []
}
```

`session.truncated` is `true` when the session held more than 200 entities
and only the first 200 were returned — the same cap and the same flag
`GET /v1/graph/evidence` uses, and for the same reason: this query runs once
per commit and the schema accepts 50 of them, so the response needs both a
ceiling and a way to say the ceiling was hit.

Every gap in the chain is a **typed abstention**, never a guess:
`no_commit_entity` (the graph has no memory of that hash — it predates
capture, or was made without hooks / on another machine) and
`no_session_link` (the commit entity was captured before commits recorded
their session id) appear per commit; `no_commits_supplied` (the request
carried no `commits` field at all) and the git-side codes (`not_a_git_repo`,
`file_not_tracked`, `git_unavailable`, `history_unreadable`,
`line_out_of_range`, `line_uncommitted`) appear in the top-level
`abstentions` — the git-side ones only from the CLI, which resolves commits
locally and passes its own abstention through. `history_unreadable` means
`git log` did not answer (its output outgrew the read buffer, it exceeded the
5-second timeout, or the repository has no commits yet): the empty commit
list under that code means *unknown*, never *none*. The `file_memories` block is
labelled `basis: "file-tag"` because it is associated by basename tag —
not derived from the commits — and the two must not be read as the same
kind of evidence.

### GET /dashboard

Returns the full interactive MeMesh Dashboard as a self-contained HTML page. Served by the HTTP server — no separate build step needed.

**Usage**: Run `memesh serve` (prints the dashboard URL), then open `http://localhost:3737/dashboard` in a browser. Bare `memesh` with no subcommand prints the command list.

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

### memesh remember — stating a relation

The two relation types that change behaviour have their own flags, because
they are the two worth typing:

| Flag | What it does |
|------|--------------|
| `--supersedes <name...>` | Archives the named entity immediately. Recoverable — nothing is deleted — and reported as `archived as superseded: <name>`. |
| `--contradicts <name...>` | Both memories surface as a conflict every time either is recalled (see [recall → Conflict detection](#recall)). |

```bash
memesh remember --name auth-v2 --type decision --obs "Sessions, not JWT" --supersedes auth-v1
memesh remember --name no-jwt --type decision --obs "JWT is out" --contradicts use-jwt
memesh recall jwt        # → Warning: Conflicts detected: "no-jwt" contradicts "use-jwt"
```

A relation whose target does not exist is reported on stderr and exits `1`:
the consequence you asked for did not happen, so the command does not claim it
did. Free-form relation labels are MCP/HTTP only — as a tag with extra steps,
they have no CLI flag.

### memesh reindex

Regenerate vector embeddings for all entities.

**Options**:

| Option | Description |
|--------|-------------|
| `--namespace <namespace>` | Reindex only entities in this namespace. |
| `--fts` | Rebuild the full-text keyword index instead of the vector index. |
| `--discard-generation` | Throw away a half-built index left by an interrupted rebuild, without rebuilding. Never touches the live index. |
| `--json` | Output the result as JSON. |

`--fts` rebuilds the full-text keyword index instead. The keyword index
normally rebuilds itself once, on the first open after an upgrade, guarded by a
version marker. That marker only moves forward, so it cannot describe a
database migrated by a newer build and then written to by an older one — which
happens with a downgrade, or with an npm-global and a plugin-marketplace
install side by side. `--fts` is the way out of that state.

```bash
memesh reindex --fts
```

#### Nothing is deleted until the new index is complete

A full reindex builds the new vectors in a **staging generation** beside the
live index, and replaces the live one only once every entity that should have a
vector has one and nothing failed. The swap is a single transaction.

What that means in practice:

- **The old index keeps answering queries** for the whole rebuild, when the
  rebuild is at the same width. Rebuilding at a **new** width is different and
  the difference matters: a query embedded at the new width cannot be matched
  against an index built at the old one, so from the moment you switch provider
  until the rebuild completes, **semantic search is off and recall runs on
  keyword search alone**. That window is reported honestly rather than hidden —
  `recall` returns `retrieval.mode: "fts"` and `retrieval.degraded: true` for
  it, and the message printed on open says so.
- **A run that dies part way changes nothing.** Provider rate limit, network
  drop, `Ctrl-C`, a killed process — the live index is byte-for-byte what it
  was. It is never left as a half-new, half-old mix, whose distances are no
  longer comparable against each other or against the dedup threshold.
- **The embeddings already produced are kept.** Run `memesh reindex` again and
  it resumes: only the entities the previous run did not reach are sent to the
  provider. On a paid API this is the difference between finishing the job and
  paying for it twice.
- **A half-built generation is discarded, not resumed, if the provider or the
  width changed** since it was started. Vectors from two different embedding
  spaces must not end up in one index.
- **A memory captured while the rebuild runs keeps its vector.** Only the
  rebuild writes to the staging index; every other writer — the capture hooks,
  `remember`, the dreamer, the MCP server — writes the live one, and the rebuild
  works from a list of entities taken before it started. So at swap time, rows
  that are still active and absent from the staging index are carried across
  rather than dropped. (This applies to a same-width rebuild. During a width
  change a concurrent write is refused as a dimension mismatch, so there is
  nothing of the new width to carry.)
- **A memory you deleted stays deleted.** `forget` clears the live row, but it
  does not know about a staging index, so a row staged before the deletion is
  pruned at swap time instead of being promoted back into the live index.

**Switching embedding provider needs no special flag.** Each provider emits a
different width — 768 for Ollama, 1536 for OpenAI, 384 for the keyword-only
default — and a `vec0` table is fixed at one width, so the new index really is a
new table. That is what a generation is. Change the provider in your config and
run `memesh reindex`; the old index stays live at its old width until the new one
is verified. Until you do, MeMesh keeps the existing index and says so on open,
because a stale index still works.

> `--vectors` was retired. It existed to grant consent for dropping every
> stored embedding before the refill began — the step generations removed. The
> flag is rejected rather than accepted as a no-op, and rejecting it destroys
> nothing.

A full reindex refuses up front in two cases:

| Refused | Why |
|---------|-----|
| A test embedding could not be produced at the configured width | The run would fill nothing, and would spend its whole length discovering that. The check embeds one string and measures the result, rather than trusting the provider name in the config: `openai` and `ollama` are "available" the moment they are named, so an expired key, a typo'd key or a stopped Ollama would otherwise be found out one entity at a time. Your existing index is untouched. |
| sqlite-vec is not loaded | There is no vector index to rebuild, so there is nothing this command can do. Recall is running on FTS5 keyword search alone. `memesh doctor`'s "SQLite and vector search" row explains why the extension did not load on this machine. |
| A half-built index is present and its marker cannot be read | Resuming it could merge vectors from two different embedding spaces; discarding it would destroy embeddings a previous run already produced. Neither is done silently. Clear it with `memesh reindex --discard-generation`, then rebuild. |

**`memesh reindex --discard-generation`** throws away a half-built index without
rebuilding, and never touches the live one. Two situations call for it: a rebuild
you have decided to abandon (the staging index otherwise holds a full second copy
of your vectors on disk — `memesh doctor` reports its size), and the unreadable
marker above. It prints what it discarded, and exits 0 when there was nothing to
discard.

**A resumed rebuild only reuses a staged vector while it still matches.** Each
staged row records a hash of the text it was built from, so an entity edited
between an interrupted run and its resume is re-embedded rather than promoted with
a stale vector. An entity that has not changed is never sent to the provider
twice, and the result reports those separately as `already_staged` — `embedded`
counts only what this run wrote.

**A rebuild gives up after five consecutive provider failures.** A provider that
has stopped answering answers for every remaining entity too, so continuing costs
the whole graph at up to ~91.5 seconds each and tells the user nothing new.
Everything embedded so far is kept, the run reports `abortedAfter`, and the next
`memesh reindex` continues from there.

Namespace-scoped runs (`--namespace X`) write in place rather than through a
generation, because a staging table holding one namespace would drop every other
namespace's vectors when swapped in. In-place is safe for the reason a full
rebuild is not: each row's old vector survives until its replacement has been
produced.

**Provider requests** are bounded: a 30-second timeout per request, and up to
three attempts for a 429 or a 5xx (honouring `Retry-After` when the server sends
one). A 401, 403 or 404 is configuration rather than weather, so it stops
immediately and names the status instead of retrying against a certainty.

**Exit codes**:

| Code | Meaning |
|------|---------|
| `0` | Every memory this run was responsible for has a vector, and every embedding this run attempted was written. |
| `1` | The command failed, was refused, finished with memories still missing a vector, or could not regenerate an embedding it tried to. |

Both halves are needed, because either alone can be satisfied by a run that did
nothing. "Every memory has a vector" is true of a full index whose vectors are
the *stale* ones a provider switch was meant to replace — so a run that refused
every write would report itself complete and exit `0`, in exactly the situation
the command exists for. When that happens the run now reports
`Could not be regenerated: N` and leaves the reindex-needed flag set.

The verdict is scoped to what was asked: `--namespace personal` exits `0` when
that namespace is complete, even if another namespace is behind. The
reindex-needed flag is *not* scoped — it describes the whole database, so it
stays set until every namespace is complete, and the run says so rather than
printing a bare tick next to a `memesh doctor` that still reports work
outstanding.

An incomplete run prints `⚠️  Reindex incomplete` with a per-reason breakdown.
Earlier versions printed `✅ Reindex complete` and exited `0` in every case,
including runs that wrote no vectors at all.

### memesh why

```bash
memesh why src/auth.ts              # which commits touched this file, and what memesh remembers about them
memesh why src/auth.ts --line 42    # attribute ONE line via git blame instead of file history
memesh why src/auth.ts --limit 5    # cap the commits inspected (default 10)
memesh why src/auth.ts --json       # the full structured result (same shape as POST /v1/why)
```

Local git answers *which* commits touched the file (`git log --follow`, or
`git blame` for `--line`); the graph answers *what memesh remembers* about
them: the commit entity the post-commit hook captured, the session it was
made in (commits record `metadata.session_id` going forward), and the
memories associated with the file by `file:<basename>` tag — printed under
an explicit "associated, not commit-derived" label.

What the chain cannot prove is said outright, never guessed: a commit with
no entity ("memesh has no memory of this commit"), an entity with no
session link, an untracked file, a line not yet committed, and a history
git could not read at all (`history_unreadable` — the empty list means
unknown, not none). Run it from
inside the repository — the current directory picks both the git repo and
the project scope.

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

### Calling the HTTP API from another language

There is no first-party client library. The HTTP surface documented above is the
integration point: start `memesh serve` and call it with whatever your language
already has.

A Python SDK used to ship in this repository, and this page told you to
`pip install memesh`. It was never published — PyPI answers 404 for that name —
no workflow built it, no CI ran its tests, and it still called
`POST /v1/consolidate`, which has answered `410 Gone` since 4.2.11. It is
removed rather than repaired: an unpublished client covering 7 of 32 endpoints
is a promise this project was not keeping.

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

Heuristic non-LLM relation backfill for orphan entities. Five rules:

1. **Tag co-occurrence**: two active entities sharing ≥ 2 topical tags get a `related-to` edge. Topical filter excludes auto-capture noise (`session_end`, `auto_saved`, `commit`, `completed`, `lesson`, etc.) to prevent cartesian explosion.
2. **Project clustering**: orphan lessons / decisions / bug-fixes / patterns in a project get a `belongs-to-project` edge to the most recent release / feature / architecture / plan in the same project.
3. **Session co-occurrence** (`--session-cooccurrence`): high-signal orphans (signal_score ≥ 0.6) sharing a `session:*` tag get a `co-created` edge. Eligible types: lesson_learned, decision, architecture, feature, bug_fix, etc.
4. **Name-token similarity** (`--name-tokens`): orphans whose tokenized names share ≥ 3 content tokens or Jaccard similarity ≥ 0.50 get a `shares-name-tokens` edge. Stopword list excludes generic qualifiers and month abbreviations to prevent cartesian explosion.
5. **Evidence links** (on by default; `--no-evidence-links` disables): evidence-layer captures — commits, session insights, session summaries — get an `evidences` edge to the work item they support. Matched by exact session id (a `session:*` tag, or `metadata.session_id` for commits, which carry no session tag by design); with no session match, to the most recent same-project work item created BEFORE the capture. This is the edge `GET /v1/graph?layer=work` counts for its evidence badges, so the dashboard's two-layer graph shows zero badges until this has run. Unlike the other rules, its sources are evidence entities rather than orphans — a commit that already relates to something else is still evidence.

**Usage**:

```bash
memesh kg backfill-relations [--project <name>] [--dry-run] [--max-per-source <n>] \
  [--min-shared-tags <n>] [--session-cooccurrence] [--name-tokens] \
  [--min-jaccard <n>] [--all-rules] [--no-evidence-links] [--include-archived] \
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
| `--all-rules` | off | Enable all five rules in one pass |
| `--no-evidence-links` | (Rule 5 is on) | Disable Rule 5: evidence → work-item links |
| `--include-archived` | off | Also process archived entities |
| `--reset-idempotency` | off | Clear the persistent "already-attempted" orphan cache (`memesh_metadata.kg_backfill_processed_v1`) before running, so every orphan is reconsidered |
| `--json` | off | Output as JSON |

**Idempotency**: re-running this command is cheap by default — orphan IDs considered in a prior run are remembered in `memesh_metadata` and skipped on subsequent runs. Use `--reset-idempotency` after a schema change or when you want every orphan reconsidered from scratch. The output summary reports `idempotency: skipped N orphans` so you can see how many were filtered.

### memesh kg rename-project

Merge or rename a `project:<name>` tag across every entity. Heals project tags that were split by an identity-rule change: tags from before project identity became git-based (e.g. a repo captured under both `project:tim` and `project:TIM`, or memories captured in a subdirectory tagged with the subdirectory name), and — since non-git identity gained its real-path hash suffix — bare-basename tags like `project:notes` that should merge into the new `project:notes-<8 hex>` form (run with no flags to see both spellings side by side). The system cannot infer the correct project for an old value, so the mapping is user-driven.

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
memesh dream run [--project <name>] [--dry-run] [--from-transcripts] [--max-llm-calls <n>] [--window-days <n>] [--validate]
memesh dream patterns [--project <name>] [--dry-run] [--max-llm-calls <n>] [--window-days <n>] [--min-signal <n>]
memesh dream conflicts [--max-pairs <n>] [--dry-run]
memesh dream list [--status <pending|applied|rejected|all>]
memesh dream show <id> [--json]
memesh dream accept <id>
memesh dream reject <id> [--reason <text>]
```

**`--validate`** on `dream run` enables the optional second-pass LLM validator (`src/core/digest-validator.ts`) which cross-checks the proposed digest's claims against source observations and attaches `validation_warnings` to soften'd proposals. Doubles per-proposal LLM cost; default off.

**`memesh dream conflicts`** is the contradiction pipeline. Candidate
generation (`src/core/conflict-candidates.ts`) is deterministic and free:
signal-type entities only, per-entity nearest vector neighbours inside a
measured cosine gate, minus pairs already related by
`supersedes`/`contradicts` and pairs a previous run already judged
(`conflict_judged_pairs`). The judge (`src/core/conflict-judge.ts`) then
spends the LLM on the `--max-pairs` tightest pairs (default 20) and rules
each one `CONTRADICTS`, `SUPERSEDES`, `DUPLICATE` or `UNRELATED`.
`UNRELATED` is recorded so the pair is never re-bought; the other three are
**staged as `kind='relation'` proposals** in the same `dream list` /
`accept` / `reject` review flow as every other machine proposal. Accepting
one creates the corresponding relation (`contradicts` / `supersedes` — the
judge names the survivor — / `duplicates`) between the two existing
entities; nothing is created, archived or applied automatically, and both
endpoints must still be active or the apply refuses loudly. An unparseable
LLM response is a counted failure, not a verdict — the pair simply returns
as a candidate next run. Causality is never inferred from timestamps: a
`SUPERSEDES` verdict must come from content showing revision, and relations
like `caused`/`influenced` remain explicit human statements. `--dry-run`
prints the candidate count without calling an LLM. Telemetry flow:
`conflict_judge`.

**`memesh dream show <id>`** prints a proposal in full — name, type, *every* observation untruncated, tags and source — so you can review the whole thing (including anything hiding past the `dream list` preview) before accepting. `--json` for scripts.

**`--from-transcripts`** on `dream run` mines this project's Claude Code session transcripts (`src/core/transcript-source.ts` + `src/core/transcript-extractor.ts`) for the decisions, lessons and facts that live in the conversation itself, instead of clustering existing entities. It reads each session's JSONL directly (no dependence on a capture hook having fired), asks the LLM for the durable memories, and **stages them as proposals** for `dream accept` — nothing enters the knowledge graph automatically. It is scoped to the current project only (`--project` does not apply). Every candidate is sanitised and any candidate carrying a detected secret is dropped, not stored. Before staging, each candidate is embedded and checked against entities already in the graph with the same vector index recall uses, so a near-duplicate of a memory you already accepted is skipped (and the skip is reported, never silent). With `--dry-run` it lists the sessions and their conversation-turn counts **without calling an LLM**.

**`--if-due`** (with `--from-transcripts`) makes `dream run` safe to put behind a scheduler. memesh has no daemon, so it does not mine on its own — a `--if-due` run does nothing *unless* the `transcriptMining` config switch is on (env override `MEMESH_TRANSCRIPT_MINING=1`) **and** at least `--min-interval-hours` (default 24) have elapsed since this project was last mined; otherwise it prints why and exits 0. The last-mined time is tracked per project in `~/.memesh/transcript-mining.json`, and any completed run (manual or scheduled) advances it, so a cron entry never re-mines right after a hand run. This lets one frequently-firing entry self-throttle. Example — a launchd/cron job that fires hourly but mines at most daily:

```bash
# crontab: attempt hourly; --if-due mines only when enabled AND ≥24h since last run
0 * * * * cd /path/to/your/project && memesh dream run --from-transcripts --if-due --min-interval-hours 24 --max-llm-calls 25 >> ~/.memesh/mine.log 2>&1
```

Enable it first with `memesh config set transcriptMining true` (or `MEMESH_TRANSCRIPT_MINING=1`); until then the scheduled entry is a harmless no-op. `memesh doctor` shows the current state under "Scheduled transcript mining".

Validator verdicts are `pass` | `soften` | `reject` | `unavailable`. Only `reject` skips a proposal and only `soften` annotates one. `unavailable` means the validator could not run at all (LLM unreachable, fallback chain exhausted) — it is deliberately distinct from `pass`, which asserts that every claim was checked and supported. Both let the proposal through, so an unreachable validator never costs you a real digest, but a proposal validated by nothing is no longer indistinguishable from one that passed a clean check.

---

## Anthropic memory tool (`memory_20250818`)

For applications that call the **Messages API directly** rather than through MCP. Claude gets a memory tool whose storage is MeMesh instead of a folder of text files, so it also gets search, ranking, decay, relations and namespaces without knowing they are there.

This is **not** one of the nine MCP tools and is not exposed over HTTP or the CLI. The MCP surface serves an agent that already speaks MeMesh; this serves an application that speaks only the Messages API.

### Wiring it up

The tool is client-side: Claude only *requests* file operations, and your loop performs them.

```ts
import { handleMemoryCommand, MEMORY_TOOL_DEFINITION } from '@pcircle/memesh';

const message = await anthropic.messages.create({
  model: 'claude-opus-5',
  max_tokens: 2048,
  messages,
  tools: [MEMORY_TOOL_DEFINITION],   // { type: 'memory_20250818', name: 'memory' }
});

for (const block of message.content) {
  if (block.type === 'tool_use' && block.name === 'memory') {
    const { content, isError } = handleMemoryCommand(block.input);
    toolResults.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: isError });
  }
}
```

`handleMemoryCommand` takes `unknown` and validates every field itself. The input comes from a model over the wire, so the declared schema describes what should arrive, not what does.

### The path space

| Path | Is |
|------|----|
| `/memories` | The root. Lists the three namespaces. |
| `/memories/<namespace>` | `personal`, `team` or `global`. Lists that namespace's memories with type and tags. |
| `/memories/<namespace>/<name>.md` | One entity. Its lines are its observations. |

Entity names may contain `/`, so `/`, `\` and `%` are percent-encoded in the filename and nothing else is — `Project Apollo.md`, not `Project%20Apollo.md`.

### How lines map to memories

A file's content is the entity's observations joined by newlines, with no header — every line the model can count has to be a line it can also address, and a header would put an offset between "line 3" and "the third thing I remember".

**Observations are ordered by observation id: insertion order, never score.** This is the load-bearing choice. `view` and the edit that follows it are two separate turns, and between them a hook can write a new observation or access tracking can change a ranking. If the order the model saw came from a score, the line numbers it read would address different content by the time it sent them back — a silent wrong write, not an error.

An observation may itself contain newlines, so the line → memory map is computed from the rendered text rather than assumed one-to-one. `insert_line: 2` pointing at the second line of a three-line memory inserts *after that whole memory*, not into the middle of it.

### Commands

| Command | Parameters | Against the knowledge graph |
|---------|-----------|------------------------------|
| `view` | `path`, `view_range?` | Root → namespaces. Namespace → its active entities. File → observations with line numbers. |
| `create` | `path`, `file_text` | Creates the entity, or **overwrites** its observations (tags are preserved). Refuses when the name is already taken in another namespace. |
| `str_replace` | `path`, `old_str`, `new_str?` | Content-addressed edit. Omitting `new_str` deletes the text. |
| `insert` | `path`, `insert_line`, `insert_text` | New observation after the memory owning that line. `0` prepends. |
| `delete` | `path` | **Archives** the entity — never destroys it. |
| `rename` | `old_path`, `new_path` | Renames the entity and reindexes it under the new name. |

Two behaviours worth stating because they differ from a filesystem:

- **`delete` archives.** The person whose memory it is did not ask for the deletion — a model did. From the model's side the file is gone (`view` lists only active entities); from the user's side it is restorable.
- **`str_replace` refuses an ambiguous `old_str`** rather than editing the first match, and returns the line numbers of every occurrence so the model can widen it. This is a write, and the wrong one is silent.

### Refusals

| Refused | Why |
|---------|-----|
| Any path not under `/memories` | Including `/memories-of-you/…`, which passes a naive `startsWith` check. |
| `..`, `.`, empty segments, `%2e%2e`, `\`, NUL | Nothing here touches a filesystem, so traversal cannot reach `secrets.env` — but it *can* resolve to a different namespace or memory than the one named, which is a silent wrong write. |
| More than two levels deep | The path space is exactly `namespace/memory`. |
| A namespace that is not `personal`, `team` or `global` | |
| Writing to `/memories` or a namespace | Those are directories. |
| Deleting or renaming `/memories` or a namespace | The contract tells Claude it cannot; this enforces it. |
| A rename onto a name taken in **any** namespace | Entity names are unique database-wide, so checking only the destination namespace would fail later on a UNIQUE constraint instead of returning the specified message. |
| A create onto a name taken in **another** namespace | Same uniqueness. Writing anyway appended to a memory at a different address than the one named — and, since an explicit namespace now moves an existing entity, would instead relocate it into this one. |

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

`workSchedule.dayDistribution` entries carry `dayNum` — an integer `0`–`6` from SQLite `strftime('%w')`, where `0` is Sunday and `6` is Saturday. There is no English `day` name field: day names are presentation, so localising `dayNum` into a weekday label is the client's job.

### GET /v1/telemetry

Per-flow LLM telemetry scorecard for the last `window` days. Backs the "LLM activity" panel in the dashboard Home tab's analytics section and `memesh telemetry` CLI.

**Query parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `window` | number | 30 | Look-back window in days (1–365) |

**Response shape:** `{ window_days, summaries: FlowSummary[] }` where each `FlowSummary` is `{ flow, total_calls, total_attempts, successes, failures, fallback_used, median_latency_ms, by_provider, by_model, by_project, by_error_class, sample_errors, window_days }`. `by_model` and `by_project` are `Record<string, { ok, fail }>` (per-model and per-project ok/fail counts); `sample_errors` is up to 5 recent `{ error_class, message }` failure samples. Flows: `dreamer`, `pattern_detector`, `auto_tagger`, `failure_analyzer`, `digest_validator`, `transcript_extractor`, `conflict_judge`. (`consolidator` rows may still exist from before that tool was retired.)

### GET /v1/dream/proposals

Lists dream digest / pattern proposals from the staging table.

**Query parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | enum | `pending` | One of `pending`, `applied`, `rejected`, `all` |

**Response:** array of `{ id, project, cluster_key, source_count, digest_name, digest_observations_preview, status, created_at, kind }` where `kind` is `digest | pattern_emergent`.

### GET /v1/dream/proposals/:id

Full proposal detail for the Home tab's expanded card view.

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

**Response:** `DreamerResult` shape — `{ proposalsCreated, clustersScanned, llmCalls, skipped: Array<{reason, project, clusterKey}>, durationMs, clusteringMode?, clusteringNote? }`.

`clusteringMode` is `"semantic"` when entries were grouped by embedding distance and `"calendar"` when the graph has no vectors and they fell back to ISO-week buckets — which can put unrelated work in one digest, so a client that surfaces digests should surface this too. `clusteringNote` is one sentence saying why, or naming candidates that had no embedding and were left out.

### POST /v1/dream/proposals/:id/accept

Apply a pending dream proposal — creates the digest entity (or `pattern_emergent` entity for pattern proposals), inserts `summarizes` / `evidence_for` relation edges, and soft-archives source entities for digest proposals.

**Response:** `{ proposalId, digestEntityName, sourcesArchived, sourcesLinked, kind }`.

A proposal that can no longer claim **any** of its sources (every source already summarised by another digest, or every source since forgotten) answers `400` with `errorCode: "operation.failed"` — and the server has already marked that proposal `rejected`, so it will not appear as pending again. This is a resolved outcome, not a server failure; do not retry it.

### POST /v1/dream/proposals/:id/reject

Mark a pending proposal as rejected. Source entities are untouched.

**Body schema:**
| Field | Type | Description |
|-------|------|-------------|
| `reason` | string (optional, ≤500 chars) | Why this proposal was rejected |

**Response:** `{ id, status: 'rejected' }`.
