# Quick Start Guide (2 Minutes)

Get MeMesh running in under 2 minutes.

## Prerequisites

- **Node.js 20+** ([download here](https://nodejs.org/))
- **Claude Code CLI** installed and configured

No API keys needed — MeMesh uses your Claude Code subscription.

---

## Installation

```bash
npm install -g @pcircle/memesh
```

Restart Claude Code. That's it.

<details>
<summary><strong>Install from source (for contributors)</strong></summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

The build auto-configures MCP settings. Restart Claude Code after building.

</details>

---

## Verify It Works

In Claude Code, type:

```
buddy-help
```

You should see a list of available commands including `buddy-do`, `buddy-remember`, and `buddy-help`.

---

## 🎯 First Usage Examples

### Example 1: Code Review (Prompt-Enhanced Capability)

Ask Claude Code to review code with enhanced prompts:

```bash
# In Claude Code, ask:
"Review this authentication function for security vulnerabilities:

function login(username, password) {
  const query = 'SELECT * FROM users WHERE username=' + username;
  const user = db.query(query);
  if (user.password === password) {
    return { token: generateToken(user) };
  }
  return null;
}
"
```

**What happens:**
1. MeMesh detects "code review" capability needed
2. Routes to code review capability
3. Enhances prompt with security best practices checklist
4. Claude Code receives enhanced prompt with context
5. Returns comprehensive security review identifying:
   - SQL injection vulnerability
   - Plain-text password comparison
   - Missing input validation

---

### Example 2: Workflow Guidance

Ask for next-step suggestions based on your current phase:

```bash
# In Claude Code, ask:
"What's the next step after finishing my tests?"
```

**What happens:**
1. MeMesh evaluates your workflow context
2. Provides actionable next steps (tests, review, commit)
3. Suggests the most relevant tool to use next

---

## 📖 Next Steps

Now that you're up and running, explore more:

- **📚 Capability Reference:** Learn about available capabilities - [USER_GUIDE.md](../USER_GUIDE.md)
- **📚 Docs Index:** Documentation map - [README.md](../README.md)
- **🧪 Contributing Guide:** Testing and development - [CONTRIBUTING.md](../../CONTRIBUTING.md)
- **🔧 MCP Integration:** Advanced configuration - [SETUP.md](./SETUP.md)

---

## ❓ Troubleshooting

### "MCP server not found"

**Symptom:** Claude Code can't connect to MeMesh

**Solutions:**
1. Verify plugin is installed and enabled:
   ```bash
   # Check plugin registration
   cat ~/.claude/plugins/known_marketplaces.json
   cat ~/.claude/settings.json  # should have enabledPlugins.memesh@pcircle-ai = true
   ```

2. Ensure absolute path is used:
   ```bash
   # Get absolute path
   cd /path/to/claude-code-buddy
   pwd
   # Use this path in config.json
   ```

3. Verify server.js was built:
   ```bash
   # Check dist directory exists
   ls -la dist/mcp/server-bootstrap.js
   # Rebuild if missing
   npm run build
   ```

4. Restart Claude Code after config changes

---

### "API key invalid"

**Symptom:** Errors about missing or invalid API keys

**Solutions:**

**For Anthropic (standalone mode):**
1. Only needed if `MCP_SERVER_MODE=false` in `.env`
2. Verify key starts with `sk-ant-api03-`
3. Get key from [Anthropic Console](https://console.anthropic.com/)

---

### "Tests failing"

**Symptom:** `npm test` shows failures

**Solutions:**

1. **Check Node.js version:**
   ```bash
   node -v
  # Should be v20.0.0 or higher
   ```

2. **Clean install:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

3. **Verify environment:**
   ```bash
   # Check .env exists
   ls -la .env
   # Validate format
   cat .env | grep -v "^#" | grep -v "^$"
   ```

4. **Run specific test suites:**
   ```bash
   # MCP-related tests
   npm test -- --run tests/mcp/

   # E2E tests (requires API keys)
   npm run test:e2e:safe
   ```

5. **Check API keys for E2E tests:**
   - E2E tests require valid API keys
   - Set `ANTHROPIC_API_KEY` for orchestrator tests

---

### "Build errors"

**Symptom:** `npm run build` fails with TypeScript errors

**Solutions:**

1. **Clean build:**
   ```bash
   rm -rf dist/
   npm run build
   ```

2. **Check TypeScript version:**
   ```bash
   npx tsc --version
   # Should be 5.x.x
   ```

3. **Validate tsconfig.json:**
   ```bash
   npx tsc --noEmit
   # Shows errors without building
   ```

---

### "MCP server starts but tools not available"

**Symptom:** Server connects but Claude Code doesn't see tools

**Solutions:**

1. **Verify server is running:**
   ```bash
   # Check process
   ps aux | grep "node.*mcp/server.js"
   ```

2. **Check server logs:**
   ```bash
   # Set debug logging in .env
   LOG_LEVEL=debug
   # Restart server and check output
   ```

3. **Validate tool definitions:**
   ```bash
   # Validate MCP tool wiring
   npm test -- --run tests/mcp/
   ```

---

## 🆘 Getting Help

If you're still stuck after trying the troubleshooting steps:

1. **📚 Check Documentation:**
   - [README.md](../../README.md) - Full project overview
   - [README.md](../README.md) - Documentation map
   - [SETUP.md](./SETUP.md) - Installation and MCP configuration

2. **🐛 Report Issues:**
   - [GitHub Issues](https://github.com/PCIRCLE-AI/claude-code-buddy/issues)
   - Include: OS, Node.js version, error messages, steps to reproduce

3. **💬 Discussions:**
   - [GitHub Discussions](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
   - Ask questions, share tips, request features

4. **📝 Logs:**
   - Set `LOG_LEVEL=debug` in `.env`
   - Include relevant logs when reporting issues

---

## What's Next?

You've successfully set up MeMesh! Try these next:

1. **Store a decision**: `"Remember: We chose PostgreSQL for JSONB support"`
2. **Recall it later**: `buddy-remember "database choice"`
3. **Execute a task**: `buddy-do "review this code for security issues"`

For more, see the [User Guide](../USER_GUIDE.md) and [Commands Reference](../COMMANDS.md).
