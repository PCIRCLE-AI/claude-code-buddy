# MeMesh Plugin

Minimal persistent memory plugin for Claude Code. Remembers decisions, patterns, and context across sessions.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

## Installation

```bash
npm install -g @pcircle/memesh
```

## What it does

MeMesh gives Claude Code persistent memory through 3 MCP tools, 2 hooks, and a CLI dashboard:

### MCP Tools

| Tool | Description |
|------|-------------|
| `remember` | Store knowledge — entities with observations, relations, and tags |
| `recall` | Search stored knowledge via FTS5 full-text search with optional tag filtering |
| `forget` | Delete stored knowledge by name (cascades to observations, relations, tags) |

### Hooks

| Hook | Event | What |
|------|-------|------|
| Session Start | `SessionStart` | Auto-recalls project-specific + recent global memories |
| Post Commit | `PostToolUse` (Bash) | Records git commits as knowledge entities |

### CLI

| Command | Description |
|---------|-------------|
| `memesh-view` | Generate and open an interactive HTML dashboard with bundled local D3 |

```bash
memesh-view
```

![MeMesh Dashboard](docs/images/dashboard-screenshot.png)

## How it works

- **Storage**: SQLite database at `~/.memesh/knowledge-graph.db`
- **Search**: FTS5 full-text search (no vector embeddings)
- **Isolation**: Tag-based project filtering (`project:<name>`)
- **Upserts**: Reusing an entity name appends observations, preserves the original type, and dedupes tags
- **Dashboard**: `memesh-view` bundles D3 locally, so the generated HTML works offline
- **Schema**: entities, observations, relations, tags + FTS5 virtual table
- **Validation**: All tool inputs validated with Zod schemas

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
