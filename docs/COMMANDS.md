# MeMesh Commands Reference

Complete reference for all MeMesh commands and tools.

**Version**: 2.9.4
**Last Updated**: 2026-03-08

## Table of Contents

- [Buddy Commands](#buddy-commands) (User-Friendly Layer)
- [MCP Tools](#mcp-tools) (Direct Tool Access)
- [Command Aliases](#command-aliases)
- [Usage Examples](#usage-examples)

---

## Buddy Commands

Buddy commands provide a natural, conversational interface to MeMesh's functionality.

### `buddy do <task>`

Execute any development task with memory-enhanced context.

**What it does:**
- Analyzes task complexity
- Applies capability-focused prompt enhancement
- Returns execution result with routing info

**Parameters:**
- `task` (required): Description of task to execute

**Examples:**
```bash
buddy do setup authentication for the API
buddy do refactor the user service
buddy do fix the login bug we discussed
buddy do write tests for auth.ts
buddy do optimize this database query
```

**Aliases:**
- `buddy help-with`
- `buddy execute`
- `buddy run`
- `buddy task`

**Routing Logic:**
- MeMesh evaluates task complexity and capability keywords
- Specialized prompt context is added for the detected capability focus
- Estimated cost and complexity are included for transparency

---

### `buddy remember <query> [limit]`

Recall project memory - past decisions, architecture choices, bug fixes, and patterns.

**What it does:**
- Searches knowledge graph for relevant memories
- Returns past decisions and context
- Helps maintain project consistency

**Parameters:**
- `query` (required): What to search for
- `limit` (optional): Max number of results (1-50, default: 10)

**Examples:**
```bash
buddy remember how we implemented authentication
buddy remember api design decisions
buddy remember database schema changes
buddy remember why we chose TypeScript
buddy remember authentication approach 10
```

**Aliases:**
- `buddy recall`
- `buddy retrieve`
- `buddy search`
- `buddy find`

**Use Cases:**
- Recall past architectural decisions
- Remember why certain patterns were chosen
- Review previous bug fixes
- Maintain consistency across sessions

---

### `buddy help [command]`

Get help for all buddy commands or a specific command.

**What it does:**
- Shows command reference
- Explains usage and parameters
- Provides examples
- Lists command aliases

**Parameters:**
- `command` (optional): Specific command to get help for
  - `do` - Help for buddy do
  - `remember` - Help for buddy remember
  - (Leave empty for all commands)

**Examples:**
```bash
buddy help          # Show all commands
buddy help do       # Help for buddy do
buddy help remember # Help for buddy remember
```

---

## MCP Tools

Direct MCP tool access (for advanced users or MCP integrations).

### `buddy-do`

MCP tool version of `buddy do` command.

**Input Schema:**
```json
{
  "task": "string (required) - Task description"
}
```

**Example:**
```json
{
  "task": "setup authentication for the API"
}
```

---

### `buddy-remember`

MCP tool version of `buddy remember` command.

**Input Schema:**
```json
{
  "query": "string (required) - Search query",
  "limit": "number (optional) - Max results (1-50, default: 10)"
}
```

**Example:**
```json
{
  "query": "authentication approach",
  "limit": 10
}
```

---

### `buddy-help`

MCP tool version of `buddy help` command.

**Input Schema:**
```json
{
  "command": "string (optional) - Command to get help for"
}
```

**Example:**
```json
{
  "command": "do"
}
```

---

### `memesh-generate-tests`

Automatically generate comprehensive test cases from specifications or source code using AI.

**Aliases:** `generate-tests` (deprecated, will be removed in v3.0.0)

**Input Schema:**
```json
{
  "specification": "string (optional) - Feature or function specification",
  "code": "string (optional) - Source code to generate tests for"
}
```

**Note:** Must provide either `specification` or `code`.

---

### `memesh-hook-tool-use`

Internal hook event ingestion for workflow automation and memory tracking (auto-triggered by Claude Code hooks, do not call manually).

**Aliases:** `hook-tool-use` (deprecated, will be removed in v3.0.0)

**Input Schema:**
```json
{
  "toolName": "string (required) - Tool executed by Claude Code",
  "arguments": "object (optional) - Tool arguments payload",
  "success": "boolean (required) - Whether execution succeeded",
  "duration": "number (optional) - Duration in milliseconds",
  "tokensUsed": "number (optional) - Tokens used by tool call",
  "output": "string (optional) - Tool output"
}
```

---

### `memesh-record-mistake`

Record errors and mistakes for learning and prevention.

**Aliases:** `record-mistake` (deprecated, will be removed in v3.0.0)

**Input Schema:**
```json
{
  "action": "string (required) - What action the AI took",
  "errorType": "string (required) - Error classification (see values below)",
  "userCorrection": "string (required) - User's correction/feedback",
  "correctMethod": "string (required) - What should have been done instead",
  "impact": "string (required) - Impact of the mistake",
  "preventionMethod": "string (required) - How to prevent in future",
  "relatedRule": "string (optional) - Related rule/guideline",
  "context": "object (optional) - Additional context"
}
```

**Error Types:**
`procedure-violation`, `workflow-skip`, `assumption-error`, `validation-skip`, `responsibility-lack`, `firefighting`, `dependency-miss`, `integration-error`, `deployment-error`

**Example:**
```json
{
  "action": "Used synchronous file read in async handler",
  "errorType": "assumption-error",
  "userCorrection": "This blocks the event loop",
  "correctMethod": "Use fs.promises.readFile() instead of fs.readFileSync()",
  "impact": "Server becomes unresponsive under load",
  "preventionMethod": "Always use async I/O in request handlers"
}
```

---

### `memesh-create-entities`

Create knowledge entities with explicit relationships for fine-grained control over the knowledge graph.

**Input Schema:**
```json
{
  "entities": "array (required) - Array of entity objects",
  "entity.name": "string (required) - Unique entity name",
  "entity.entityType": "string (required) - Entity type",
  "entity.observations": "array (optional) - Array of observation strings",
  "entity.tags": "array (optional) - Array of tag strings"
}
```

**Example:**
```json
{
  "entities": [
    {
      "name": "PostgreSQL Database Choice",
      "entityType": "decision",
      "observations": [
        "Chose PostgreSQL over MySQL",
        "Better JSON support and performance"
      ],
      "tags": ["database", "postgresql"]
    }
  ]
}
```

---

### `memesh-metrics`

View session metrics and tool usage statistics.

**Input Schema:**
```json
{
  "period": "string (optional) - Time period: 'session' | 'day' | 'week' (default: 'session')"
}
```

---

## Cloud-Only Mode Limitations

In **cloud-only mode** (when better-sqlite3 is unavailable but MEMESH_API_KEY is configured), certain tools are disabled because they require local SQLite storage.

### ❌ Disabled Tools in Cloud-Only Mode

| Tool | Status | Reason |
|------|--------|--------|
| `buddy-do` | ❌ Unavailable | Requires local Knowledge Graph for task context |
| `buddy-remember` | ❌ Unavailable | Requires local memory search |
| `memesh-create-entities` | ❌ Unavailable | Requires local Knowledge Graph |
| `memesh-hook-tool-use` | ❌ Unavailable | Requires local memory tracking |
| `memesh-record-mistake` | ❌ Unavailable | Requires local mistake storage |
| `memesh-metrics` | ❌ Unavailable | Requires local metrics storage |

### ✅ Available Tools in Cloud-Only Mode

| Tool | Status | Notes |
|------|--------|-------|
| `buddy-help` | ✅ Works | Displays command help |
| `memesh-generate-tests` | ✅ Works | AI-based test generation (stateless) |

### Error Message Example

When calling a disabled tool in cloud-only mode:

```
❌ Tool 'buddy-remember' is not available in cloud-only mode.

This MCP server is running without local SQLite storage (better-sqlite3 unavailable).

To use local memory tools:
1. Install better-sqlite3: npm install better-sqlite3
2. Restart the MCP server

Local SQLite storage is required for memory features.
```

### Why Cloud-Only Mode Exists

Cloud-only mode enables MeMesh to run in restricted environments (like Claude Desktop Cowork) where:
- Native modules cannot compile (better-sqlite3, onnxruntime-node, sqlite-vec)
- Filesystem is read-only
- Node.js headers cannot be downloaded

See [docs/COWORK_SUPPORT.md](./COWORK_SUPPORT.md) for complete details.

### Future: Cloud-First Memory

**Planned**: Full memory tool support in cloud-only mode through cloud-first memory architecture

**Timeline**: Long-term (no ETA yet)

**How**: Memory tools will proxy to cloud KG API instead of local SQLite

**Related Issues**: #73, #76, #77

---

## Command Aliases

All buddy commands support multiple aliases for convenience:

### `buddy do` Aliases
- `buddy help-with <task>`
- `buddy execute <task>`
- `buddy run <task>`
- `buddy task <task>`

### `buddy remember` Aliases
- `buddy recall <query>`
- `buddy retrieve <query>`
- `buddy search <query>`
- `buddy find <query>`

## Usage Examples

### Complete Development Workflow

**1. Start new feature:**
```bash
buddy do create user registration API endpoint
```

**2. Check memory for past patterns:**
```bash
buddy remember how we implemented other API endpoints
buddy remember authentication patterns
```

**3. Execute specific tasks:**
```bash
buddy do write tests for registration endpoint
buddy do add input validation
buddy do update API documentation
```

### Memory-Driven Development

**Store important decisions:**
```bash
# The system automatically stores important decisions
# from your conversations and task executions
```

**Recall when needed:**
```bash
buddy remember why we chose JWT over sessions
buddy remember database migration approach
buddy remember error handling patterns
buddy remember API versioning strategy
```

---

## Tips & Best Practices

### 1. Be Specific in Tasks
```bash
# ❌ Vague
buddy do fix bug

# ✅ Specific
buddy do fix the login timeout bug in auth.ts
```

### 2. Use Memory Effectively
```bash
# Store context at the start of a session
buddy remember what we're working on

# Recall past decisions before making changes
buddy remember authentication approach
```

### 3. Use Aliases for Speed
```bash
# Short aliases for common operations
buddy recall auth    # instead of buddy remember auth
buddy run tests      # instead of buddy do run tests
```

---

## Troubleshooting

### Command Not Found

If buddy commands aren't recognized:

1. **Verify MCP Integration:**
   ```bash
   # Check Claude Code config
   cat ~/.claude/mcp_settings.json
   ```

2. **Restart Claude Code:**
   ```bash
   # After configuration changes
   ```

3. **Check Server Logs:**
   ```bash
   # Look for MCP server errors
   ```

### Tool Execution Failures

If tools fail to execute:

1. **Check Dependencies:**
   ```bash
   npm install
   npm run build
   ```

2. **Verify Environment:**
  - Node.js 20+ installed
   - Claude Code configured
   - MCP server running

3. **Test Manually:**
   ```bash
   npm run mcp
   ```

---

## Next Steps

- **API Reference:** See [API_REFERENCE.md](./api/API_REFERENCE.md) for detailed MCP tool documentation
- **User Guide:** See [USER_GUIDE.md](./USER_GUIDE.md) for complete feature reference
- **Best Practices:** See [BEST_PRACTICES.md](./BEST_PRACTICES.md) for effective workflows
- **Installation:** See [GETTING_STARTED.md](./GETTING_STARTED.md) for setup guide
- **Troubleshooting:** See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues
- **Contributing:** See [CONTRIBUTING.md](./CONTRIBUTING.md) to add features

---

**Questions?** Open an issue on GitHub or check the documentation.
