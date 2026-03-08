# Getting Started with MeMesh Plugin

**Install Time**: 2 minutes • **First Memory**: 30 seconds • **Ready to Code**: Immediately

---

## What is MeMesh Plugin?

**MeMesh Plugin gives Claude Code a persistent memory.** Simple as that.

Every project you work on, every decision you make, every bug you fix—Claude remembers it all. No more re-explaining your architecture every session. No more "As I mentioned earlier..." No more starting from scratch.

### What You Get

✅ **Remembers Everything**: Architecture decisions, design patterns, bugs fixed, conventions used
✅ **Smart Task Routing**: Automatically detects what kind of work you need and applies the right expertise
✅ **Persistent Memory**: Knowledge graph persists across all sessions (stored locally)
✅ **Zero Configuration**: Works out of the box with sensible defaults
✅ **100% Local**: Your code and decisions never leave your machine

### Before and After

**❌ Without MeMesh:**
```
Session 1: "We use JWT for auth..."
Session 2: "Remember our auth?"
Claude: "Sorry, no context..."
You: *explains everything again* 😤
```

**✅ With MeMesh:**
```
Session 1: "Setup JWT auth"
Session 2: "Remember auth"
MeMesh: "JWT auth from Jan 15: 15min access tokens, 7-day refresh..."
```

---

## Installation

### Quick Install (Recommended)

One command, fully automatic:

```bash
npm install -g @pcircle/memesh
```

Restart Claude Code. **Done!**

No config files to edit. No API keys needed. The postinstall script auto-configures everything.

<details>
<summary><strong>Install from source (for contributors)</strong></summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

MeMesh is a Claude Code Plugin — the MCP server is auto-managed via the plugin's `.mcp.json` file. No manual configuration of `~/.claude/mcp_settings.json` is needed.

If auto-configuration did not work, run:
```bash
memesh setup
```

</details>

---

## Verify It's Working

### 1. Check MeMesh is Active

In Claude Code, run:
```bash
buddy-help
```

**Expected output:**
```
MeMesh v2.10.1 - Persistent Memory for Claude Code

Available Commands:
  buddy-do <task>        - Execute any development task
  buddy-remember <query> - Recall project decisions and patterns
  buddy-help             - Show this help

  memesh-generate-tests  - Auto-generate comprehensive tests

  ... (8 tools total)

Status: ✅ Connected (8 tools available)
```

### 2. Test Memory Storage

Try this:
```bash
"Store this decision: We're using PostgreSQL for JSONB support"
```

Then recall it:
```bash
buddy-remember "database choice"
```

**You should see:** Your stored decision retrieved from memory.

### 3. Test Task Routing

```bash
buddy-do "review this function for security issues:
function login(user, pass) {
  return db.query('SELECT * FROM users WHERE name=' + user);
}"
```

**You should see:** Security analysis identifying SQL injection vulnerability.

---

## Troubleshooting

<details>
<summary><strong>❌ "MCP server not found"</strong></summary>

**Cause**: Claude Code can't connect to MeMesh

**Fix**:
1. Verify installation path is correct:
   ```bash
   cd claude-code-buddy
   pwd  # Copy this path
   ```

2. Check the file exists:
   ```bash
   ls dist/mcp/server-bootstrap.js
   ```

3. Rebuild if missing:
   ```bash
   npm run build
   ```

4. Restart Claude Code completely

</details>

<details>
<summary><strong>❌ "Commands don't respond"</strong></summary>

**Cause**: MeMesh server isn't running or crashed

**Fix**:
1. Check server logs:
   ```bash
   cat ~/.claude/logs/memesh.log
   ```

2. Verify Node.js version:
   ```bash
   node --version  # Should be v20.0.0+
   ```

3. Reinstall dependencies:
   ```bash
   cd claude-code-buddy
   rm -rf node_modules
   npm install
   npm run build
   ```

4. Restart Claude Code

</details>

<details>
<summary><strong>❌ "Installation succeeded but nothing happens"</strong></summary>

**Cause**: Plugin directory not loaded

**Fix**:
1. Start Claude Code with plugin flag:
   ```bash
   claude --plugin-dir /path/to/claude-code-buddy
   ```

2. Create shell alias for convenience:
   ```bash
   # Add to ~/.bashrc or ~/.zshrc
   alias claude-mem='claude --plugin-dir /path/to/claude-code-buddy'
   ```

3. For team distribution, see Claude Code plugin documentation

</details>

---

## Your First Commands

### Store and Retrieve

**Store a decision:**
```bash
"Remember: We chose React over Vue because the team knows React better"
```

**Retrieve it later:**
```bash
buddy-remember "why React?"
```

**Expected**: Instant recall of your decision with the reasoning.

### Smart Task Routing

**Code review:**
```bash
buddy-do "review src/auth.ts for security"
```

**Generate tests:**
```bash
memesh-generate-tests --code "function add(a, b) { return a + b; }"
```

**Refactor code:**
```bash
buddy-do "refactor UserService to reduce duplication"
```

**Each command automatically routes to the right internal capability with the right expertise.**

---

## Common Scenarios

### Scenario 1: Joining an Existing Project

**You**: New to the project, need to understand decisions

```bash
# Query project memory
buddy-remember "architecture decisions"
buddy-remember "why PostgreSQL"
buddy-remember "authentication approach"

# Get overview
buddy-do "summarize the key technical decisions in this project"
```

**Result**: Instant context on why things are the way they are.

---

### Scenario 2: Starting a New Project

**You**: Fresh start, want to track decisions from day one

```bash
# Make initial decisions and store them
"Remember: Using TypeScript strict mode for type safety"
"Remember: Chose Express over Fastify for ecosystem maturity"
"Remember: Using Vitest for testing because it's fast and ESM-native"

# Later in the project
buddy-remember "testing framework"
```

**Result**: Your decisions are preserved across sessions (30/90 days). New team members can query them months later.

---

### Scenario 3: Debugging a Recurring Issue

**You**: Bug keeps coming back, want to track the fix

```bash
# Debug and document
buddy-do "analyze why users are logged out randomly"

# After fixing
"Remember: Random logout bug was caused by JWT expiry not being refreshed.
Fixed in auth/middleware.ts by adding token refresh logic."

# Next time it happens
buddy-remember "logout bug"
```

**Result**: Root cause analysis is stored. If the bug returns, you have the full history.

---

## Next Steps

Now that MeMesh is running, explore more:

### Learn More
- **[User Guide](USER_GUIDE.md)** - Complete feature documentation
- **[API Reference](api/API_REFERENCE.md)** - All commands and tools explained
- **[Troubleshooting](TROUBLESHOOTING.md)** - Common issues and solutions

### Advanced Topics
- Knowledge graph queries and entity management
- Memory best practices and organization
- Error tracking and mistake prevention

---

## Quick Reference Card

```bash
# Core Commands
buddy-help                     # Show available commands
buddy-do "<task>"             # Execute any development task
buddy-remember "<query>"      # Query project memory

# Testing
memesh-generate-tests          # Auto-generate tests (provide specification or code)

# Status
"Show MeMesh status"          # Connection and capability status
```

---

## Why It Works

**MeMesh operates on three principles:**

1. **Memory First**: Every significant action is recorded automatically
2. **Context-Aware**: Tasks are enhanced with relevant project memory
3. **Zero Friction**: No configuration, no API keys, no setup ceremony

**The result**: Claude Code that remembers your project like a teammate, not a tool.

---

## Learn More

**Comprehensive Documentation**:

- **[User Guide](./USER_GUIDE.md)** - Complete feature reference and workflows
- **[API Reference](./api/API_REFERENCE.md)** - Detailed MCP tool documentation with schemas and examples
- **[Best Practices](./BEST_PRACTICES.md)** - Effective patterns and workflows
- **[Commands Reference](./COMMANDS.md)** - All available commands
- **[Troubleshooting](./TROUBLESHOOTING.md)** - Common issues and solutions

**Advanced Topics**:
- [Knowledge Graph Tools](./api/API_REFERENCE.md#knowledge-graph-tools) - Build complex entity relationships
- [Integration Examples](./api/API_REFERENCE.md#integration-examples) - Complete workflow patterns
- [Error Reference](./api/API_REFERENCE.md#error-reference) - Error codes and handling

---

**Ready to code with memory?** 🚀

Install MeMesh, run `buddy-help`, and never explain your architecture twice again.

**Questions?** [Open an issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues) or [start a discussion](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions).

---

**Version**: 2.10.1
**Last Updated**: 2026-03-08
**Not affiliated with Anthropic PBC** • Independent open-source project
