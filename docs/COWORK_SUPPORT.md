# Claude Desktop Cowork Support

## Current Status: Partial Support (Cloud-Only Mode)

MeMesh plugin can run in **Claude Desktop Cowork** environments, but with limited functionality due to native module restrictions in the Cowork sandbox.

### ✅ What Works

- **MCP Server Startup**: Server initializes successfully in cloud-only mode
- **Basic Commands**: Non-memory tools (buddy-help, memesh-generate-tests) work normally

### ⚠️ Current Limitations

- **Memory Tools Disabled**: Local memory operations (buddy-do, buddy-remember, memesh-create-entities, memesh-record-mistake, memesh-hook-tool-use, memesh-metrics) are currently disabled
- **No Local Knowledge Graph**: better-sqlite3 cannot compile in Cowork sandbox (read-only filesystem + blocked node-gyp)
- **No Embeddings/Vector Search**: onnxruntime-node and sqlite-vec also unavailable (native modules)

### 📋 System Architecture

```
┌─────────────────────────────────────────────────────┐
│ CLI Environment (Recommended)                       │
├─────────────────────────────────────────────────────┤
│ ✅ Local SQLite (better-sqlite3)                    │
│ ✅ Full Knowledge Graph                             │
│ ✅ All 8 MCP tools                                  │
│ ✅ Embeddings & vector search                       │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Claude Desktop Cowork (Limited)                     │
├─────────────────────────────────────────────────────┤
│ ⚠️  Cloud-only mode (no local SQLite)               │
│ ❌ Memory tools disabled                            │
│ ✅ Basic commands work (buddy-help, generate-tests) │
└─────────────────────────────────────────────────────┘
```

## Why These Limitations Exist

### Cowork Sandbox Constraints

Claude Desktop Cowork runs plugins in a restricted sandbox environment:

1. **Read-only Plugin Filesystem**: Cannot write to `.claude-plugin/memesh/` directory
2. **Blocked node-gyp Compilation**: HTTP 403 when downloading Node.js headers from nodejs.org
3. **No Prebuilt Binaries**: Native modules (better-sqlite3, onnxruntime-node, sqlite-vec) don't ship ARM64 Linux binaries
4. **Ephemeral Storage**: `~/.memesh/` directory is session-scoped, wiped on restart

### Result

Native modules fail to load, causing:
- better-sqlite3 → No local SQLite → Knowledge Graph unavailable
- onnxruntime-node → No embeddings → Semantic search unavailable
- sqlite-vec → No vector index → KNN search unavailable

## Installation in Cowork

### Method 1: Cloud-Only Mode (Recommended)

If you have a MeMesh Cloud account:

1. **Set API Key**:
   ```bash
   export MEMESH_API_KEY="your-api-key"
   ```

2. **Install Plugin**:
   - Open Claude Desktop
   - Go to Settings → Plugins
   - Search for "MeMesh"
   - Click Install

3. **Verify Installation**:
   - Start a new Cowork session
   - Type `/help` to see available commands
   - Note: Memory tools will show "not available in cloud-only mode" errors

### Method 2: CLI Alternative (Full Features)

For full functionality, use the CLI version instead:

```bash
# Install globally
npm install -g @pcircle/memesh

# Or use via npx
npx @pcircle/memesh --help

# MeMesh is a Claude Code Plugin — the MCP server is auto-managed
# via the plugin's .mcp.json file. No manual configuration of
# ~/.claude/mcp_settings.json is needed. Just restart Claude Code.
```

## Expected Behavior

### When Memory Tools are Called in Cowork

```
User: buddy-remember "authentication approach"

❌ Tool 'buddy-remember' is not available in cloud-only mode.

This MCP server is running without local SQLite storage (better-sqlite3 unavailable).

To use local memory tools:
1. Install better-sqlite3: npm install better-sqlite3
2. Restart the MCP server

Local SQLite storage is required for memory features.
```

### When Basic Commands are Called

```
User: buddy-help

✅ Works normally - displays help information
```

## Future Roadmap

### 🔮 Planned: Cloud-First Memory Architecture

We're planning full Claude Desktop support through a cloud-first architecture:

**Goal**: Access Knowledge Graph via MeMesh Cloud API instead of local SQLite

**Implementation**:
1. Cloud API endpoints for KG operations (create, recall, search)
2. Memory tools proxy to cloud in cloud-only mode
3. Shared KG accessible from any client
4. No local persistence needed (cloud as source of truth)

**Timeline**: Long-term (no ETA yet)

**Related Issues**: [#73](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/73), [#76](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/76), [#77](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/77)

## Troubleshooting

### MCP Server Doesn't Start

**Symptom**: No memesh tools appear in Claude Desktop

**Cause**: Server failed to initialize (check logs)

**Solution**:
1. Check MCP server logs in Claude Desktop
2. Verify MEMESH_API_KEY is set if using cloud sync
3. Ensure plugin is enabled in Settings → Plugins

### Memory Tools Return Errors

**Symptom**: "not available in cloud-only mode" errors

**Expected Behavior**: This is normal in Cowork until cloud-first memory is implemented

**Workaround**: Use CLI version for full memory functionality

### Database Not Persisted Between Sessions

**Symptom**: Local memories disappear after restarting Cowork

**Cause**: `~/.memesh/` directory is ephemeral in Cowork

**Solution**:
- Current: This is expected behavior (no workaround)
- Future: Cloud-first memory will solve this naturally

## Recommendations

### For Development Work

**Use CLI Version** for full functionality:
- Local Knowledge Graph
- All memory tools
- Embeddings & vector search
- Optional cloud sync for backup

### For Quick Tasks in Cowork

**Use Cloud-Only Mode** if you just need:
- Basic commands (buddy-help, list-skills)
- Cloud sync functionality
- Don't need memory tools

### For Production Use

**CLI is Recommended** until cloud-first memory is implemented.

## Getting Help

- **Bug Reports**: [Create an issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?template=bug_report.yml)
- **Feature Requests**: [Request a feature](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?template=feature_request.yml)
- **Questions**: [Start a discussion](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

When reporting Cowork-specific issues, select **"Claude Desktop (Cowork)"** in the Client dropdown.

---

**Last Updated**: 2026-02-25
**Status**: Partial support (cloud-only mode functional, memory tools disabled)
