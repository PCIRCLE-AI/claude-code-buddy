# CLI Parameters Reference

Complete reference for all MeMesh Plugin CLI commands and their parameters.

---

## Global

```bash
memesh [command] [options]
```

**Requirements**: Node.js >= 20.0.0, npm >= 9.0.0

---

## Commands

### `memesh setup`

Interactive setup wizard. Configures MCP server, plugin, and Claude Code integration.

```bash
memesh setup
```

No parameters. Guides you through setup steps interactively.

---

### `memesh login`

Authenticate with MeMesh Cloud (optional).

```bash
memesh login [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--manual` | Enter API key manually via stdin | Browser-based auth |
| `--backend-url <url>` | Backend URL | `https://api.memesh.cloud` |

---

### `memesh logout`

Remove stored authentication credentials.

```bash
memesh logout
```

No parameters.

---

### `memesh tutorial`

Launch interactive tutorial for learning MeMesh features.

```bash
memesh tutorial
```

No parameters.

---

### `memesh dashboard`

Open the MeMesh dashboard (session metrics, agent activity).

```bash
memesh dashboard
```

No parameters.

---

### `memesh stats`

Show productivity statistics and usage metrics.

```bash
memesh stats [options]
```

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--day` | `-d` | Show last 24 hours | — |
| `--week` | `-w` | Show last 7 days | — |
| `--month` | `-m` | Show last 30 days | — |
| `--all` | `-a` | Show all time | ✅ (default) |
| `--json` | — | Export as JSON | — |
| `--csv` | — | Export as CSV | — |
| `--verbose` | `-v` | Show detailed statistics | — |

**Examples:**
```bash
memesh stats -w           # Last 7 days
memesh stats --json       # Machine-readable output
memesh stats -v -m        # Detailed monthly stats
```

---

### `memesh report-issue`

Generate a diagnostic report for bug reporting.

```bash
memesh report-issue
```

No parameters. Collects system info, config, and recent logs.

---

### `memesh config`

Manage MeMesh configuration.

#### `memesh config show`

Display current configuration.

```bash
memesh config show
```

#### `memesh config validate`

Validate configuration files and MCP setup.

```bash
memesh config validate
```

#### `memesh config edit`

Open configuration in editor.

```bash
memesh config edit
```

#### `memesh config reset`

Reset configuration to defaults.

```bash
memesh config reset
```

---

### `memesh daemon`

Manage the MeMesh daemon process.

#### `memesh daemon status`

Show daemon status (PID, uptime, client count, socket info).

```bash
memesh daemon status
```

#### `memesh daemon stop`

Stop the daemon process.

```bash
memesh daemon stop [options]
```

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--force` | `-f` | Force kill without graceful shutdown | Graceful stop |

#### `memesh daemon restart`

Restart the daemon process.

```bash
memesh daemon restart
```

#### `memesh daemon logs`

View daemon logs.

```bash
memesh daemon logs [options]
```

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--lines <number>` | `-n` | Number of lines to show (1-10000) | `50` |
| `--follow` | `-f` | Follow log output in real-time | — |

**Examples:**
```bash
memesh daemon logs -n 100      # Last 100 lines
memesh daemon logs -f          # Live tail
```

#### `memesh daemon info`

Show detailed diagnostic information (environment, config paths, versions).

```bash
memesh daemon info
```

---

## MCP Tool Parameters

These parameters are used when MeMesh tools are invoked by Claude Code.

### `buddy-do`

Smart task analysis with memory-enriched proposals.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | ✅ | Task description to analyze (e.g., "fix the auth bug") |

**Confidence threshold**: Tasks shorter than 10 characters return null (too ambiguous).

---

### `buddy-remember`

Search project memory with semantic or keyword matching.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Search query (natural language supported) |
| `mode` | string | — | `hybrid` | Search mode: `semantic`, `keyword`, or `hybrid` |
| `limit` | number | — | `10` | Max results (1-50) |
| `matchThreshold` | number | — | `0.3` | Minimum match score (0-1). Higher = fewer, more relevant results |
| `allProjects` | boolean | — | `false` | Search across all projects vs current project only |

**Search modes:**
- **`semantic`**: AI embedding similarity — finds conceptually related content
- **`keyword`**: FTS5 full-text search + LIKE matching — exact keyword matches
- **`hybrid`**: Combines both approaches (recommended)

**Examples:**
```
buddy-remember "authentication"                              # hybrid, current project
buddy-remember "database" mode=keyword                       # exact match only
buddy-remember "user login" mode=semantic matchThreshold=0.5 # high-quality semantic
buddy-remember "API patterns" allProjects=true               # cross-project search
```

---

### `buddy-help`

Get help for MeMesh commands.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | — | Specific command (e.g., "do", "remember") |

---

### `memesh-create-entities`

Create knowledge graph entities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entities` | array | ✅ | Array of entity objects |

**Entity object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique entity name |
| `entityType` | string | ✅ | Type: `decision`, `feature`, `bug_fix`, `lesson_learned`, `pattern`, `note` |
| `observations` | string[] | ✅ | Array of atomic observations |
| `tags` | string[] | — | Tags (3-7 recommended). Scope tags added automatically |
| `metadata` | object | — | Additional structured data |

---

### `memesh-record-mistake`

Record AI mistakes for learning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | ✅ | What the AI did (the mistake) |
| `errorType` | string | ✅ | Category (see below) |
| `userCorrection` | string | ✅ | User's correction/feedback |
| `correctMethod` | string | ✅ | What should have been done |
| `impact` | string | ✅ | Impact of the mistake |
| `preventionMethod` | string | ✅ | How to prevent in future |
| `relatedRule` | string | — | Related guideline name |
| `context` | object | — | Additional context |

**Error types:** `procedure-violation`, `workflow-skip`, `assumption-error`, `validation-skip`, `responsibility-lack`, `firefighting`, `dependency-miss`, `integration-error`, `deployment-error`

---

### `memesh-metrics`

View session metrics and system status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | string | — | `all` | Section: `all`, `session`, `routing`, `memory` |

---

### `memesh-generate-tests`

Generate test cases from specifications or code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `specification` | string | — | Feature specification (at least one of spec/code required) |
| `code` | string | — | Source code to generate tests for |

---

### `memesh-hook-tool-use`

Process tool execution events (auto-triggered by hooks, do not call manually).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `toolName` | string | ✅ | Tool name (e.g., "Write", "Edit", "Bash") |
| `arguments` | object | — | Tool arguments payload |
| `success` | boolean | ✅ | Whether execution succeeded |
| `duration` | number | — | Execution duration (ms) |
| `tokensUsed` | number | — | Tokens used |
| `output` | string | — | Tool output |

---

## Process Management Scripts

```bash
npm run processes:list       # List all MeMesh processes
npm run processes:kill       # Kill all MeMesh processes
npm run processes:restart    # Restart processes
npm run processes:orphaned   # Find orphaned processes
npm run processes:config     # Show process configuration
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMESH_DATA_DIR` | Data directory path | `~/.memesh/` |
| `MEMESH_DISABLE_DAEMON` | Disable daemon mode | `false` |
| `MEMESH_LOG_LEVEL` | Log level (debug, info, warn, error) | `info` |
| `ANTHROPIC_API_KEY` | Anthropic API key (for AI features) | — |

---

**Version**: 2.10.0
**Last Updated**: 2026-03-08
