# Quick Start Guide
## Get Started with MeMesh Plugin in 5 Minutes

Welcome to MeMesh Plugin! This guide will help you set up and start using MeMesh Plugin in less than 5 minutes.

---

## Prerequisites

- **Node.js**: v20.0.0 or higher
- **npm**: v9.0.0 or higher
- **Claude Code**: Latest version installed

### Check Your Environment

```bash
# Check Node.js version
node --version  # Should be v20.0.0 or higher

# Check npm version
npm --version   # Should be v9.0.0 or higher
```

---

## Installation

### Recommended: npm Install

```bash
npm install -g @pcircle/memesh
```

The postinstall script automatically configures Claude Code's MCP settings. Restart Claude Code and you're ready.

If the auto-configuration didn't work, run the setup wizard:

```bash
memesh setup
```

### Alternative: Manual Setup

If auto-configuration did not work:

1. **Install MeMesh**:
   ```bash
   npm install -g @pcircle/memesh
   ```

2. **Run the setup wizard**:
   ```bash
   memesh setup
   ```

   MeMesh is a Claude Code Plugin — the MCP server is auto-managed via the plugin's `.mcp.json` file. No manual editing of `~/.claude/mcp_settings.json` is needed.

3. **Restart Claude Code**:
   - Close and reopen Claude Code completely
   - Wait for MCP servers to initialize (~5 seconds)

---

## Verify Installation

Test that MeMesh is working:

```bash
# In Claude Code, type:
buddy-help
```

**Expected Output**:
```
🤖 MeMesh Quick Start

Essential Commands

┌────────────────────────────────────────────┐
│ buddy-do "<task>"                          │
└────────────────────────────────────────────┘
❯ buddy-do "add user authentication"
→ Routes to backend-developer, creates auth system

💡 New to MeMesh?
Run: memesh tutorial

📖 Full reference: buddy-help --all
```

**If you see this**: ✅ **Success!** MeMesh is working!

**If you see an error**: See [Troubleshooting](#troubleshooting) below.

---

## Your First Commands

### 1. Execute a Task

MeMesh routes your task to the best capability:

```bash
buddy-do "setup user authentication with JWT"
```

**What happens**:
- 🔍 Analyzes task complexity
- 🎯 Routes to `backend-developer` capability
- ⚡ Enhances prompt with context
- ✅ Returns routing decision and enhanced prompt

### 2. Store a Decision

Record important decisions for future reference:

```bash
buddy-remember "We decided to use JWT authentication because it's stateless and scales well"
```

**What happens**:
- 🧠 Stores in Knowledge Graph
- 🏷️ Auto-tags as "decision"
- 📅 Timestamps the entry
- ✅ Confirms storage

### 3. Recall Past Knowledge

Search your project memory:

```bash
buddy-remember "authentication decisions"
```

**What happens**:
- 🔍 Searches Knowledge Graph
- 📊 Returns relevant memories
- 💡 Suggests next actions
- ✅ Displays results with context

---

## Common Use Cases

### Use Case 1: Starting a New Feature

```bash
# 1. Check for past similar work
buddy-remember "similar features"

# 2. Plan the implementation
buddy-do "plan user profile feature with avatar upload"

# 3. Record the plan
buddy-remember "User profile feature will use S3 for avatar storage"
```

### Use Case 2: Fixing a Bug

```bash
# 1. Search for similar bugs
buddy-remember "login errors"

# 2. Route bug fix
buddy-do "fix login bug where sessions expire immediately"

# 3. Record the fix
buddy-remember "Login session bug was caused by cookie domain mismatch. Fixed by setting domain to null."
```

### Use Case 3: Code Review

```bash
# 1. Recall coding standards
buddy-remember "code review checklist"

# 2. Route review task
buddy-do "review authentication implementation for security issues"

# 3. Store findings
buddy-remember "Security review found: need rate limiting on login endpoint"
```

---

## Understanding the Output

### buddy-do Response Structure

```
╭──────────────────────╮
│  ✓ BUDDY-DO SUCCESS  │  ← Status header (colored box)
╰──────────────────────╯

📋 Task                     ← Task description
Setup user authentication

─────────────────────────   ← Visual divider

✓ Results                   ← Success results with icon

  routing:
    approved: true
    message: Task routed to backend-developer
    complexity: medium

─────────────────────────   ← Visual divider

💡 Next Steps               ← Actionable guidance
  1. Verify implementation
  2. Run tests
  3. Store decision: buddy-remember

Duration: 2.3s • Tokens: 2,500  ← Metadata (subtle)
```

**Visual Hierarchy**:
- 🔴 **CRITICAL** (Red/Yellow): Errors, warnings
- 🟢 **HIGH** (Green): Results, success messages
- 🔵 **MEDIUM** (Cyan/White): Task info, descriptions
- ⚪ **LOW** (Dim Gray): Metadata, attribution

### buddy-remember Response

**No Results**:
```
✓ Search: "microservices"

✓ Results
  count: 0

💡 Next Steps
  1. Try broader search term
  2. Create new memory: buddy-do
```

**With Results**:
```
✓ Search: "api design"

✓ Results
  count: 3
  memories:
    - Decision: Use REST over GraphQL
    - Pattern: Consistent error format
    - Lesson: URL path versioning

💡 Next Steps
  1. Review memories for context
  2. Apply learnings to current task
```

---

## Interactive Tutorial

Want a guided 5-minute tour?

```bash
memesh tutorial
```

The tutorial covers:
1. ✅ Setup verification
2. 🎯 First buddy-do command
3. 🧠 Storing knowledge
4. 🔍 Recalling knowledge
5. 🚀 Advanced features

**Completion time**: ~5 minutes

---

## Troubleshooting

### Issue: "buddy-help" command not found

**Cause**: MCP server not connected

**Fix**:
1. Restart Claude Code completely
2. Wait 5-10 seconds for servers to start
3. Check MCP config:
   ```bash
   memesh config validate
   ```
4. If still failing, run setup again:
   ```bash
   memesh setup
   ```

### Issue: "Failed to connect to MCP server"

**Cause**: Configuration error or server crash

**Fix**:
1. Check MCP config file location:
   ```bash
   # macOS
   cat ~/Library/Application\ Support/Claude/claude_desktop_config.json

   # Check for "memesh" entry
   ```

2. Verify Node.js is in PATH:
   ```bash
   which node  # Should show path to node
   ```

3. Test MeMesh manually:
   ```bash
   npx @pcircle/memesh --help
   ```

4. Check Claude Code logs:
   - macOS: `~/Library/Logs/Claude/`
   - Windows: `%APPDATA%\Claude\Logs\`
   - Look for MCP errors

### Issue: "Permission denied" during installation

**Cause**: npm global install requires permissions

**Fix**:
```bash
# Option 1: Use sudo (macOS/Linux)
sudo npm install -g @pcircle/memesh

# Option 2: Configure npm prefix
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
npm install -g @pcircle/memesh
```

### Issue: Commands work but responses are slow

**Cause**: Token usage or network latency

**Fix**:
1. Check token limits (if using API keys)
2. Simplify task descriptions
3. Check network connection
4. Review logs for bottlenecks

### Still Having Issues?

1. **Check detailed troubleshooting**:
   - [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

2. **Report the issue**:
   ```bash
   memesh report-issue
   ```

3. **Get community help**:
   - GitHub Issues: https://github.com/PCIRCLE-AI/claude-code-buddy/issues
   - Discussions: https://github.com/PCIRCLE-AI/claude-code-buddy/discussions

---

## Next Steps

### Learn More

1. **Read the User Guide**:
   - [USER_GUIDE.md](./USER_GUIDE.md) - Complete command reference

2. **Explore Best Practices**:
   - [BEST_PRACTICES.md](./BEST_PRACTICES.md) - Effective workflows

3. **Check Advanced Features**:
   - Session dashboard: `memesh dashboard`
   - Usage stats: `memesh stats`
   - Configuration: `memesh config`

### Get Help

- **Quick help**: `buddy-help --all`
- **Tutorial**: `memesh tutorial`
- **Config check**: `memesh config validate`
- **Report issue**: `memesh report-issue`

### Stay Updated

- **GitHub**: https://github.com/PCIRCLE-AI/claude-code-buddy
- **Changelog**: [CHANGELOG.md](../CHANGELOG.md)
- **Releases**: https://github.com/PCIRCLE-AI/claude-code-buddy/releases

---

## Quick Reference Card

```
┌─────────────────────────────────────────────┐
│           MeMesh Quick Reference            │
├─────────────────────────────────────────────┤
│ Setup                                       │
│   memesh setup         Interactive wizard   │
│   memesh config        Manage config        │
│                                             │
│ Core Commands                               │
│   buddy-do "<task>"    Execute with context │
│   buddy-remember "X"   Store/recall memory  │
│   buddy-help           Show help            │
│                                             │
│ Utilities                                   │
│   memesh tutorial      5-min guided tour    │
│   memesh dashboard     Session health       │
│   memesh stats         Usage statistics     │
│                                             │
│ Help                                        │
│   buddy-help --all     Full reference       │
│   memesh report-issue  Bug reporting        │
└─────────────────────────────────────────────┘
```

---

**Ready to dive deeper?** Check out the [User Guide](./USER_GUIDE.md) for advanced features and workflows!

**Having trouble?** See [Troubleshooting Guide](./TROUBLESHOOTING.md) for detailed solutions.

**Want to contribute?** Read [Contributing Guide](../CONTRIBUTING.md) to get started.
