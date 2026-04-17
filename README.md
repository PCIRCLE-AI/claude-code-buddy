# MeMesh Plugin

The lightest universal AI memory layer. One SQLite file, any LLM, zero cloud.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

## Why MeMesh?

Anthropic ships a built-in [Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) in the Messages API. MeMesh solves a different problem:

| | MeMesh | Anthropic Memory Tool |
|---|---|---|
| **Data location** | Local SQLite on your machine | Anthropic cloud |
| **Data model** | Knowledge graph (entities + relations + tags) | Key-value store |
| **Search** | FTS5 full-text search | Exact key lookup |
| **Visualization** | Interactive D3.js dashboard | None |
| **Integration** | Claude Code plugin with auto-hooks | Messages API parameter |
| **Privacy** | 100% offline, zero data leaves your machine | Data sent to Anthropic |
| **Extensibility** | Open source, hackable SQLite | Closed API |

**Choose MeMesh when:** you want local-first, structured knowledge that survives across projects, with full-text search and visual exploration.

**Choose Anthropic Memory Tool when:** you want zero-setup cloud memory tightly integrated with the Messages API.

## Installation

```bash
npm install -g @pcircle/memesh
```

### Quick Start

```bash
# Use as CLI
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0"
memesh recall "auth"
memesh forget --name "old-design"

# Start HTTP API server (for Python SDK, dashboard, integrations)
memesh serve

# Open web dashboard
memesh          # (no args = opens dashboard, coming in v2.16)

# Use as MCP server (for Claude Code, Claude Desktop)
memesh-mcp      # stdio MCP server
```

## What it does

MeMesh gives Claude Code persistent memory through 3 MCP tools, 4 hooks, and a CLI dashboard:

### MCP Tools

| Tool | Description |
|------|-------------|
| `remember` | Store knowledge — entities with observations, relations, and tags |
| `recall` | Search stored knowledge via FTS5 full-text search with scoring, Smart Recall (LLM query expansion), and conflict detection |
| `forget` | Archive knowledge (soft-delete) or remove specific observations |

### Transports

| Transport | Command | Use For |
|-----------|---------|---------|
| CLI | `memesh` | Direct terminal usage, scripting, CI/CD |
| HTTP REST | `memesh serve` | Python SDK, dashboard, integrations |
| MCP | `memesh-mcp` | Claude Code, Claude Desktop, MCP clients |

### Hooks

| Hook | Event | What |
|------|-------|------|
| Session Start | `SessionStart` | Auto-recalls project-specific + recent global memories |
| Post Commit | `PostToolUse` (Bash) | Records git commits as knowledge entities |
| Session Summary | `Stop` | Auto-captures session knowledge (files edited, errors fixed) |
| Pre-Compact | `PreCompact` | Saves knowledge before context compaction |

### Dashboard

Run `memesh` to open the interactive web dashboard:

| Tab | Feature |
|-----|---------|
| Search | Real-time search with keyword highlighting |
| Browse | Paginated entity list with filters |
| Graph | D3.js force-directed knowledge graph |
| Analytics | Stats, type distribution, tag cloud |
| Manage | Archive/restore entities, remove observations |
| Timeline | Knowledge evolution chain visualization |
| Settings | LLM provider setup, API key management |

### CLI

| Command | Description |
|---------|-------------|
| `memesh-view` | Generate and open an interactive HTML dashboard with bundled local D3 |

```bash
memesh-view
```

![MeMesh Dashboard](docs/images/dashboard-screenshot.png)

### Memory Lifecycle

- **Auto-decay**: Stale memories (30+ days unused) gradually fade in ranking — never deleted
- **LLM Compression**: `memesh consolidate` compresses verbose entities into dense summaries
- **Smart Session-Start**: Loads top-N memories by relevance score (not all memories)

## How it works

- **Storage**: SQLite database at `~/.memesh/knowledge-graph.db`
- **Search**: FTS5 full-text search with multi-factor scoring (recency, frequency, confidence, temporal validity)
- **Smart Recall**: When an LLM is configured, queries are expanded into related terms before searching (Level 1 / Smart Mode). Results from all terms are merged and re-ranked by score.
- **Conflict Detection**: Recall warns when any returned entities have `contradicts` relations — surfaced as warnings in CLI output and as a `conflicts` field in MCP/HTTP responses.
- **Isolation**: Tag-based project filtering (`project:<name>`)
- **Upserts**: Reusing an entity name appends observations, preserves the original type, and dedupes tags
- **Dashboard**: `memesh-view` bundles D3 locally, so the generated HTML works offline
- **Schema**: entities, observations, relations, tags + FTS5 virtual table
- **Validation**: All tool inputs validated with Zod schemas
- **Knowledge Evolution**: `forget` archives rather than deletes — old memories are preserved but hidden. Use `supersedes` relations to replace old designs with new ones.
- **Session Auto-Capture**: Stop and PreCompact hooks automatically extract and store session knowledge. Opt-out: set `MEMESH_AUTO_CAPTURE=false`.

## Architecture

```
src/
├── cli/
│   └── view.ts           # HTML dashboard generator (D3.js graph + stats)
├── db.ts                 # SQLite database (open/close/migrate, FTS5)
├── knowledge-graph.ts    # Entity CRUD, relations, FTS5 search
├── index.ts              # Package exports
└── mcp/
    ├── server.ts         # MCP server entry point (stdio transport)
    └── tools.ts          # 3 tool handlers + Zod validation

scripts/hooks/
├── session-start.js      # Auto-recall on session start
└── post-commit.js        # Git commit tracking
```

**Dependencies** (3): `better-sqlite3`, `@modelcontextprotocol/sdk`, `zod`

## Development

```bash
npm install
npm run build       # TypeScript compile + bundle assets + set executables
npm test -- --run   # Run the vitest suite once
npm run typecheck   # tsc --noEmit
npm run test:packaged   # Pack/install smoke test for the published artifact
```

## Project Policies

- Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reporting: [SECURITY.md](SECURITY.md)

## License

MIT
