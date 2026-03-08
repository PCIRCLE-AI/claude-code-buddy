# 🔄 Upgrade Guide: Claude Code Buddy → MeMesh

> **Important**: MeMesh was previously known as "Claude Code Buddy (CCB)". This guide helps existing users upgrade safely without losing any data.

---

## 🆕 v2.8.0 Migration Guide (2026-02-08)

### Breaking Changes: MCP Tool Naming Unification

MeMesh v2.8.0 introduces a unified naming scheme for better MCP tool discoverability. All non-core tools now use the `memesh-*` prefix.

### What Changed?

**4 tools have been renamed**:

| Old Name (Deprecated) | New Name (v2.8.0+) | Status |
|----------------------|-------------------|--------|
| `buddy-record-mistake` | `memesh-record-mistake` | ⚠️ Deprecated |
| `create-entities` | `memesh-create-entities` | ⚠️ Deprecated |
| `hook-tool-use` | `memesh-hook-tool-use` | ⚠️ Deprecated |
| `generate-tests` | `memesh-generate-tests` | ⚠️ Deprecated |

**Core tools preserved** (no changes):
- ✅ `buddy-do` - Task execution with memory context
- ✅ `buddy-remember` - Memory recall (now with semantic search!)
- ✅ `buddy-help` - Help and documentation

### Migration Path

**Good News**: You don't need to change anything immediately!

1. **Old names still work** - All deprecated names continue to function via aliases
2. **Deprecation warnings** - You'll see friendly migration notices when using old names
3. **Removal timeline** - Aliases will be removed in v3.0.0 (estimated Q3 2026)

### How to Update Your Code

**Option A: Update immediately (recommended)**

Update your tool calls to use the new `memesh-*` prefix names.

**Option B: Update gradually**

The old names will continue working until v3.0.0. You can update at your own pace:

1. See deprecation warning when using old tool
2. Note the suggested new name
3. Update when convenient

### Example Migration

**Before (v2.7.0)**:
```markdown
# Create knowledge entities
create-entities {
  "entities": [...]
}

# Record mistakes for learning
buddy-record-mistake {
  "context": "Authentication failed",
  "error": "Invalid JWT token"
}
```

**After (v2.8.0)**:
```markdown
# Create knowledge entities
memesh-create-entities {
  "entities": [...]
}

# Record mistakes for learning
memesh-record-mistake {
  "context": "Authentication failed",
  "error": "Invalid JWT token"
}
```

### Tool Count Changes

- **v2.7.0**: 18 tools (3 core + 2 workflow + 13 feature tools)
- **v2.8.0**: 8 tools (3 core + 4 memesh + 1 cloud sync)
  - **Removed**: A2A local collaboration (5 tools), Secret management (4 tools)
  - **Reason**: Local-first architecture simplification

### What Was Removed?

**A2A Local Collaboration Tools** (no longer available):
- ❌ `a2a-send-task` - Agent task delegation
- ❌ `a2a-get-task` - Task status retrieval
- ❌ `a2a-list-tasks` - Task listing
- ❌ `a2a-list-agents` - Agent discovery
- ❌ `a2a-report-result` - Result reporting

**Why removed?**
- Local-first architecture is simpler and more maintainable
- Aligns with MCP specification
- Cloud-based collaboration coming in future releases

### 🆕 New Feature: Semantic Search (Non-Breaking)

v2.8.0 introduces vector-based semantic search for `buddy-remember`.

**What's New:**
- `buddy-remember` now supports `mode` parameter: `semantic`, `keyword`, `hybrid` (default)
- Find memories by meaning, not just keywords
- Uses all-MiniLM-L6-v2 ONNX model (384 dimensions, runs 100% locally)
- Example: `buddy-remember "authentication" mode=semantic`

**Do I need to do anything?**
- **New users**: Semantic search works automatically
- **Existing users with knowledge graph data**: Run `npm run backfill-embeddings` to generate embeddings for existing memories
  ```bash
  cd /path/to/claude-code-buddy
  npm run backfill-embeddings
  ```
  This is a one-time operation. New memories automatically get embeddings.

**When to use each mode:**
- `semantic`: Find conceptually similar memories (e.g., "auth" finds JWT, OAuth, sessions)
- `keyword`: Exact keyword matching (fast, precise)
- `hybrid` (default): Best of both worlds - combines semantic similarity with keyword matching

### Need Help?

- 📖 **Full Changelog**: [CHANGELOG.md](../CHANGELOG.md#280---2026-02-08)
- 💬 **Questions?**: [GitHub Discussions](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
- 🐛 **Issues?**: [Report a bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues)

---

## 📊 Quick Summary (CCB → MeMesh Package Upgrade)

| Aspect | Change |
|--------|--------|
| **Package Name** | `claude-code-buddy` → `@pcircle/memesh` |
| **Data Directory** | `~/.claude-code-buddy/` → `~/.memesh/` |
| **MCP Server Name** | `claude-code-buddy` → `memesh` |
| **Binary Command** | `ccb` → `memesh` |
| **Breaking Changes** | ✅ **Data migration required** |

---

## ✅ Who Should Upgrade?

**You should upgrade if**:
- ✅ You're currently using Claude Code Buddy (any version)
- ✅ You want the latest features and improvements
- ✅ You want to align with the official naming

**You can skip if**:
- ⏸️ You're happy with your current version
- ⏸️ You don't have time for migration right now (no rush - legacy support continues)

---

## 🛡️ Safety Guarantee

**This upgrade is designed to be 100% safe**:
- ✅ Automatic data migration script provided
- ✅ Your old data is **never deleted** automatically
- ✅ Backup created before migration
- ✅ Rollback possible if needed
- ✅ Zero data loss guarantee

---

## 📋 Pre-Upgrade Checklist

Before you start, ensure:

1. ✅ **Stop all Claude Code sessions**
   ```bash
   # Check for running MCP servers
   ps aux | grep -E "claude-code-buddy|memesh|server-bootstrap"

   # Stop Claude Code CLI if running
   # Just exit your current Claude Code session
   ```

2. ✅ **Verify your data location**
   ```bash
   # Check if you have data to migrate
   ls -la ~/.claude-code-buddy/

   # You should see files like:
   # - knowledge-graph.db
   # - database.db
   ```

3. ✅ **Check disk space** (at least 2x your data size)
   ```bash
   du -sh ~/.claude-code-buddy/
   df -h ~
   ```

4. ✅ **Note your current MCP configuration** (we'll update it later)
   ```bash
   # MeMesh plugin auto-manages MCP via .mcp.json — check plugin status:
   cat ~/.claude/plugins/known_marketplaces.json 2>/dev/null || \
   cat ~/Library/Application\ Support/Claude/claude_desktop_config.json 2>/dev/null
   ```

---

## 🚀 Upgrade Steps

### Step 1: Install MeMesh Package

```bash
# Uninstall old package (optional - can coexist temporarily)
npm uninstall -g claude-code-buddy

# Install new package
npm install -g @pcircle/memesh@latest
```

### Step 2: Migrate Your Data

**Automatic Migration (Recommended)**:

```bash
# Clone or navigate to the MeMesh repository
cd /path/to/claude-code-buddy  # (repository is still named this)

# Run the migration script
./scripts/migrate-from-ccb.sh
```

The script will:
- ✅ Detect your old data at `~/.claude-code-buddy/`
- ✅ Create a timestamped backup
- ✅ Copy all data to `~/.memesh/`
- ✅ Verify migration success
- ✅ **Keep your old data safe** (not deleted)

**Manual Migration** (if script fails):

```bash
# Backup first
cp -r ~/.claude-code-buddy ~/.claude-code-buddy-backup-$(date +%Y%m%d)

# Copy to new location
cp -r ~/.claude-code-buddy ~/.memesh

# Verify
ls -la ~/.memesh/
```

### Step 3: Update MCP Configuration

#### Option A: Automatic Detection (for developers)

If you're in the repository:
```bash
npm run setup
```

#### Option B: Manual Update

1. Find your MCP config file:
   - Claude Code CLI: Auto-managed via plugin's `.mcp.json` (no manual editing needed)
   - Claude Desktop: `~/.config/claude/claude_desktop_config.json`

2. Open the file and update:

**Before**:
```json
{
  "mcpServers": {
    "claude-code-buddy": {
      "command": "node",
      "args": ["/path/to/old/server.js"]
    }
  }
}
```

**After**:
```json
{
  "mcpServers": {
    "memesh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pcircle/memesh"]
    }
  }
}
```

**Find the correct path**:
```bash
# On macOS/Linux
npm root -g

# Then append: /node_modules/@pcircle/memesh/dist/mcp/server-bootstrap.js
```

### Step 4: Restart Claude Code

```bash
# Just restart your Claude Code CLI
# The new MeMesh MCP server will be loaded automatically
```

### Step 5: Verify Upgrade

```bash
# In Claude Code session, check if MeMesh tools are available
# You should see tools like:
# - buddy-do
# - buddy-remember
# - memesh-create-entities
# etc.
```

---

## 🧪 Verification Checklist

After upgrade, verify everything works:

- [ ] **MCP Server Connected**: Check Claude Code shows MeMesh as connected
- [ ] **Tools Available**: All 8 MeMesh tools are listed
- [ ] **Data Accessible**: Your knowledge graph is intact
  ```
  Use `buddy-remember "test"` to check if past data is accessible
  ```

---

## 🔧 Troubleshooting

### Issue 1: "MCP server failed to connect"

**Cause**: Wrong path in config or permissions issue

**Fix**:
```bash
# Verify memesh is installed
which memesh
npm list -g @pcircle/memesh

# Check binary permissions
ls -la $(npm root -g)/@pcircle/memesh/dist/mcp/server-bootstrap.js

# Should show: -rwxr-xr-x (executable)
# If not, fix permissions:
chmod +x $(npm root -g)/@pcircle/memesh/dist/mcp/server-bootstrap.js
```

### Issue 2: "Can't find my old data"

**Cause**: Data migration didn't complete

**Fix**:
```bash
# Check if old data exists
ls -la ~/.claude-code-buddy/

# Check if new location has data
ls -la ~/.memesh/

# If ~/.memesh/ is empty, run migration again:
./scripts/migrate-from-ccb.sh
```

### Issue 3: "Tools show errors when used"

**Cause**: Database permissions or corruption

**Fix**:
```bash
# Check database file permissions
ls -la ~/.memesh/*.db

# Should be readable/writable by you:
# -rw-r--r-- (644) is fine

# If corrupted, restore from backup:
cp -r ~/.claude-code-buddy-backup-YYYYMMDD ~/.memesh
```

### Issue 4: "Old and new servers both running"

**Cause**: Config has both entries

**Fix**:
```bash
# MeMesh plugin auto-manages MCP config. To fix conflicts:
# 1. Remove legacy entries from ~/.claude/mcp_settings.json (if exists)
# 2. The plugin's .mcp.json handles MCP configuration automatically
# 3. Restart Claude Code
```

---

## 🔄 Rollback (If Needed)

If you encounter issues and want to rollback:

### Step 1: Restore Old Package

```bash
# Uninstall new package
npm uninstall -g @pcircle/memesh

# Reinstall previous version
npm install -g @pcircle/memesh@<previous-version>
```

### Step 2: Restore Old Config

```bash
# Revert MCP config if needed
# Run: memesh setup
```

### Step 3: Verify Old Data

```bash
# Check old data is intact
ls -la ~/.claude-code-buddy/

# If needed, restore from backup
cp -r ~/.claude-code-buddy-backup-YYYYMMDD ~/.claude-code-buddy
```

**Your data at `~/.claude-code-buddy/` was never deleted, so rollback is safe.**

---

## 🆕 What's New in MeMesh?

After upgrading, you'll get:

- ✅ **8 MCP Standard Tools**
- ✅ **Improved backward compatibility** (automatic fallback to legacy paths)
- ✅ **Better error messages** with actionable guidance
- ✅ **Performance improvements** (query caching, connection pooling)
- ✅ **Cleaner branding** (avoiding trademark issues)
- ✅ **Active development** (regular updates and improvements)

---

## 📚 Additional Resources

- 📖 **Installation Guide**: [QUICK_INSTALL.md](QUICK_INSTALL.md)
- 🐛 **Troubleshooting**: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- 💬 **Get Help**: [GitHub Discussions](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
- 🆕 **What's Changed**: [CHANGELOG.md](../CHANGELOG.md)

---

## ❓ FAQ

### Q: Will I lose my knowledge graph data?
**A**: No. The migration script copies your data safely. Your old data is never deleted automatically.

### Q: Can I use both old and new versions simultaneously?
**A**: Technically yes, but not recommended. They'll use different data directories, so your knowledge graph won't be shared.

### Q: How long does the upgrade take?
**A**: Usually 5-10 minutes:
- Install: ~2 minutes
- Data migration: ~2 minutes (depends on data size)
- Config update: ~2 minutes
- Verification: ~2 minutes

### Q: What if the migration script fails?
**A**: Use the manual migration steps above. If still stuck, [open an issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues).

### Q: Do I need to update my custom skills/workflows?
**A**: No changes needed! All APIs remain compatible. Skills and workflows continue working as-is.

### Q: Will future updates require manual migration?
**A**: No. This is a one-time migration for the naming change. Future updates will be seamless.

---

## 💚 Need Help?

- 🐛 **Found a bug?** [Open an issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)
- 💬 **Have questions?** [Start a discussion](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
- 📧 **Private concern?** Email: support@memesh.ai

---

**Thank you for using MeMesh!** 🎉

Your support helps us build better tools for AI-assisted development.
