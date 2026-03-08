# Troubleshooting Guide

## TL;DR
If you're in a hurry:
1. Run `memesh setup` to fix installation and path issues.
2. Restart Claude Code completely.
3. Verify your Node.js version is **>= v20.0.0**.

---

## Diagnostic Flowchart

Use this decision tree to quickly find your solution:

```
Start: What's the problem?
│
├─ "Tools not found / command not found"
│  ├─ Is MeMesh installed? → npm list -g @pcircle/memesh
│  │  ├─ NOT installed → npm install -g @pcircle/memesh
│  │  └─ Installed → Run: memesh setup → Restart Claude Code
│  └─ Still failing? → Check Node.js >= v20: node --version
│
├─ "MCP Server Connection Failed"
│  ├─ Restart Claude Code completely (quit + reopen)
│  ├─ Still failing? → memesh config validate
│  │  ├─ Config invalid → memesh setup
│  │  └─ Config valid → Check for orphaned processes:
│  │     npm run processes:kill → Restart Claude Code
│  └─ Still failing? → Check daemon: memesh daemon status
│
├─ "Memory not persisting"
│  ├─ Does database exist? → ls ~/.memesh/database.db
│  │  ├─ Missing → memesh setup (re-creates it)
│  │  └─ Exists → Check permissions: ls -la ~/.memesh/
│  └─ Permissions OK? → memesh config validate
│
├─ "Slow or hanging"
│  ├─ Kill processes → pkill -f memesh
│  ├─ Check orphans → npm run processes:orphaned
│  └─ Restart Claude Code
│
├─ "Permission denied"
│  ├─ During install? → Use nvm, avoid sudo
│  └─ During runtime? → chmod 700 ~/.memesh/ && chmod 644 ~/.memesh/database.db
│
└─ "Database corruption / SQLITE_CORRUPT"
   ├─ Backup: cp ~/.memesh/database.db ~/.memesh/database.db.bak
   ├─ Delete: rm ~/.memesh/database.db
   └─ Restart Claude Code (database re-created automatically)
```

---

## Quick Diagnostic Commands

Before troubleshooting, run these commands to gather information:

```bash
# 1. Verify MeMesh installation
npm list -g @pcircle/memesh

# 2. Check Node.js and npm versions
node --version  # Should be >= v20.0.0
npm --version   # Should be >= v9.0.0

# 3. Validate MCP configuration
memesh config validate

# 4. Check daemon status
memesh daemon status

# 5. Test MeMesh directly
npx @pcircle/memesh --help
```

---

## Issue Categories

- [Most Common Issues](#most-common-issues)
- [Performance & Persistence](#performance--persistence)
- [Error Reference](#error-reference)
- [Getting Help](#getting-help)

---

## Most Common Issues

### 1. "buddy-help" command not found
**Symptoms**: Shell returns "command not found" after installation.
**Quick Fix:**
```bash
memesh setup  # Run interactive setup to fix PATH
# Restart your terminal or Claude Code
# Try: buddy-help
```

### 2. "MCP Server Connection Failed"
**Symptoms**: Claude Code cannot connect to the MeMesh server.
**Quick Fix:**
```bash
# Restart Claude Code completely
# Wait a few seconds for the MCP server to initialize
# Try the command again
```

### 3. "Permission denied" errors
**Symptoms**: Errors during `npm install` or file access.
**Quick Fix:**
- **Avoid sudo**: Use an npm prefix or a version manager like `nvm`.
- **Manual fix**: `sudo npm install -g @pcircle/memesh` (not recommended for long-term).

---

## Performance & Persistence

### 4. Commands are slow or hanging
**Symptoms**: MeMesh takes too long to respond or hangs indefinitely.
**Quick Fix:**
- **Kill processes**: `pkill -f memesh` then restart Claude Code.
- **Simplify**: Break complex tasks into smaller sub-tasks.
- **Check orphans**: `npm run processes:orphaned` to find orphaned processes.

### 5. Memory not persisting
**Symptoms**: Information or context from previous sessions is lost.
**Quick Fix:**
- Check permissions for `~/.memesh/` directory (or `~/.claude-code-buddy/` if migrating from older version).
- Verify the database exists: `ls ~/.memesh/database.db`
- Run `memesh config validate` to ensure storage is correctly configured.

### 6. Multiple MCP server processes
**Symptoms**: High CPU or memory usage from duplicate MeMesh processes.
**Quick Fix:**
```bash
npm run processes:list      # List all processes
npm run processes:orphaned  # Find orphaned processes
npm run processes:kill      # Kill all MeMesh processes
```
Then restart Claude Code.

---

---

## Error Reference

For a complete list of error codes, messages, and solutions, see **[ERROR_REFERENCE.md](./ERROR_REFERENCE.md)**.

Common error types:
- **ValidationError**: Invalid input — check parameters
- **StateError**: System not ready — run `memesh setup`
- **OperationError**: Operation failed — check disk space, permissions
- **ConfigurationError**: Missing config — run `memesh config validate`

---

## Getting Help

1. **Quick Start:** [docs/QUICK_START.md](./QUICK_START.md)
2. **CLI Parameters:** [docs/CLI_PARAMETERS.md](./CLI_PARAMETERS.md)
3. **Error Reference:** [docs/ERROR_REFERENCE.md](./ERROR_REFERENCE.md)
4. **Report Issue:** `memesh report-issue`

---

