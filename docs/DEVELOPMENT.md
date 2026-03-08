# Development Guide

This guide covers the day-to-day development workflow for MeMesh Plugin contributors. For contribution guidelines and release processes, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Development Workflow](#development-workflow)
- [Testing Strategy](#testing-strategy)
- [Debugging](#debugging)
- [Common Tasks](#common-tasks)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

---

## Prerequisites

### Required Software

- **Node.js** >= 20.0.0
  ```bash
  node --version  # Should be >= 20.0.0
  ```

- **npm** >= 9.0.0
  ```bash
  npm --version
  ```

- **Claude Code CLI** (for MCP server testing)
  ```bash
  claude --version
  ```

- **Git**
  ```bash
  git --version
  ```

### Optional Tools

- **tsx** - TypeScript executor (automatically installed as dev dependency)
- **vitest** - Testing framework (automatically installed)

---

## Initial Setup

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy

# Install dependencies
npm install

# Build the project
npm run build

# Verify installation
npm test
```

### 2. Verify MCP Server

```bash
# Check if MCP server can start
npm run verify:mcp

# List MCP processes (if any)
npm run processes:list
```

Expected output:
```
✅ MCP server verified successfully
```

### 3. Install Locally (Optional)

For testing the global install experience:

```bash
# Link package globally
npm link

# Verify global installation
memesh --version

# Unlink when done
npm unlink -g @pcircle/memesh
```

---

## Development Workflow

### Starting Development

```bash
# Watch mode - auto-rebuild on file changes
npm run dev

# In a separate terminal, test your changes
npm test -- --watch
```

### Making Changes

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Edit source files in `src/`
   - Add/update tests in `tests/`

3. **Build and test**
   ```bash
   npm run build
   npm test
   ```

4. **Verify code quality**
   ```bash
   npm run lint
   npm run typecheck
   npm run format
   ```

### Understanding the Build Process

```bash
npm run build
```

This command:
1. Compiles TypeScript → JavaScript (`tsc`)
2. Copies resources to `dist/` (`copy:resources`)
3. Makes MCP server executable (`chmod +x`)
4. Prepares plugin package (`prepare:plugin`)

**Important**: The MCP server runs as a daemon. After building, you must restart Claude Code to load the new version.

---

## Testing Strategy

### Test Types

| Test Type | Command | When to Use |
|-----------|---------|-------------|
| **Unit Tests** | `npm test` | Default - fast, isolated tests |
| **Integration Tests** | `npm run test:integration` | Test component interactions |
| **E2E Tests** | `npm run test:e2e:safe` | ⚠️ Resource-intensive, use sparingly |
| **Coverage Report** | `npm run test:coverage` | Before PR submission |

### Running Tests

```bash
# Run all tests (single-thread mode to prevent worker leaks)
npm test

# Run specific test file
npm test src/memory/MemoryManager.test.ts

# Run tests matching a pattern
npm test -- --grep "MemoryManager"

# Watch mode for TDD
npm test -- --watch

# Generate coverage report
npm run test:coverage
```

### Test Coverage Requirements

- **Minimum for existing code**: 60%
- **Minimum for new code**: 70%
- **Target for core modules**: 80%+

Check current coverage:
```bash
npm run test:coverage
```

### E2E Testing (⚠️ Important)

E2E tests are resource-intensive and can freeze your system if not managed properly.

**Always use the safe wrapper:**
```bash
npm run test:e2e:safe
```

**Never run:**
```bash
npm run test:e2e  # ❌ Will exit with warning
```

The `test:e2e:safe` script:
- Monitors system resources (CPU, memory)
- Runs tests with `maxThreads: 1`
- Aborts if resource usage exceeds safe thresholds

---

## Debugging

### MCP Server Debugging

The MCP server runs as a persistent daemon process. Understanding its lifecycle is crucial for debugging.

#### Check MCP Server Status

```bash
# List all MCP server processes
npm run processes:list

# Check for orphaned processes
npm run processes:orphaned

# View MCP configuration
npm run processes:config
```

Example output:
```
┌─────────────────────────────────────────────────────────┐
│ MCP Server Process Status                               │
├──────┬──────────────┬────────┬──────────┬──────────────┤
│ PID  │ Command      │ Status │ Uptime   │ TTY          │
├──────┼──────────────┼────────┼──────────┼──────────────┤
│ 1234 │ server-boot… │ Active │ 2h 15m   │ ttys002      │
└──────┴──────────────┴────────┴──────────┴──────────────┘
```

#### Common MCP Server Issues

**Problem**: MCP tools not loading in Claude Code

**Diagnosis**:
```bash
# 1. Check if old process is running
npm run processes:list

# 2. Check global vs local version mismatch
npm list -g @pcircle/memesh  # Global version
cat package.json | grep version  # Local version
```

**Solution**:
```bash
# 1. Kill old MCP server processes
npm run processes:kill

# 2. Restart Claude Code
# Exit Claude Code completely and restart

# 3. Verify tools are now available
# In Claude Code, type: buddy-help
```

**Root Cause**: MCP server runs as a daemon and doesn't auto-reload when code changes. Old processes keep running with outdated code.

**Prevention**:
- Always restart Claude Code after rebuilding
- Kill old processes before testing: `npm run processes:kill`

#### Debugging with Node Inspector

Start MCP server with debugger enabled and open Chrome DevTools at chrome://inspect

```bash
node --inspect dist/mcp/server-bootstrap.js
```

#### Viewing Logs

MCP server logs are written to `~/.cache/claude/mcp-logs/`

```bash
# View recent logs
tail -f ~/.cache/claude/mcp-logs/memesh.log
```

### Memory System Debugging

```bash
# Check database schema
sqlite3 ~/.cache/claude/memesh/memory.db ".schema"

# List memories
sqlite3 ~/.cache/claude/memesh/memory.db "SELECT * FROM memories LIMIT 10;"

# Check database size
du -sh ~/.cache/claude/memesh/
```

### TypeScript Debugging

```bash
# Type check without building
npm run typecheck

# Show all type errors
tsc --noEmit --pretty false

# Check specific file
tsc --noEmit src/your-file.ts
```

---

## Common Tasks

### Adding a New MCP Tool

1. **Define the tool** in `src/mcp/ToolDefinitions.ts`
2. **Create the handler** in `src/mcp/handlers/`
3. **Add Zod schema** in `src/mcp/schemas/`
4. **Write tests** in `tests/unit/mcp/`
5. **Update documentation** (`docs/COMMANDS.md`, `README.md`)
6. **Test end-to-end**:
   ```bash
   npm run build
   npm run verify:mcp
   # Restart Claude Code
   # Test: buddy-your-tool "test input"
   ```

### Modifying Database Schema

1. **Create migration** in `src/db/migrations/`
2. **Update version** in `src/db/schema.ts`
3. **Verify migration**: `npm run verify:migration`
4. **Test**: `npm test -- src/db/migrations`

### Updating Dependencies

```bash
# Check outdated dependencies
npm outdated

# Update specific dependency
npm update package-name

# After updating, verify:
npm run build
npm test
npm run test:install
```

### Creating a Release

See [docs/RELEASE_PROCESS.md](RELEASE_PROCESS.md) for the full release workflow.

Quick checklist:
```bash
# 1. Bump version (on develop branch)
npm version patch --no-git-tag-version  # or minor, or major

# 2. Update CHANGELOG.md
# Add entry for new version

# 3. Commit and push
git add package.json CHANGELOG.md
git commit -m "chore(release): bump version to X.Y.Z"
git push origin develop

# 4. Open PR: develop → main, review & merge
gh pr create --base main --head develop --title "chore(release): vX.Y.Z"

# 5. Manual npm publish (GitHub Actions cannot auto-trigger publish)
npm publish --access public
npm view @pcircle/memesh version
```

---

## Troubleshooting

### Build Errors

**Problem**: `tsc` fails with type errors

**Solution**:
```bash
# Clear TypeScript cache
rm -rf dist/
rm -rf node_modules/.cache/

# Reinstall dependencies
npm ci

# Rebuild
npm run build
```

---

**Problem**: Permission denied errors

**Solution**:
```bash
# Make scripts executable
chmod +x scripts/*.sh

# Rebuild
npm run build
```

---

### Test Failures

**Problem**: Tests fail after making changes

**Solution**:
```bash
# Clear test cache
npm test -- --clearCache

# Run tests again
npm test
```

---

**Problem**: E2E tests freeze the system

**Solution**:
- Always use `npm run test:e2e:safe`
- Never run multiple E2E test processes simultaneously
- If system freezes, kill vitest processes manually

---

### Installation Issues

**Problem**: `npm install` fails

**Solution**:
```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules
rm -rf node_modules package-lock.json

# Reinstall
npm install
```

---

**Problem**: Postinstall script fails

**Solution**:
```bash
# Run postinstall manually
node scripts/postinstall-new.js

# Check logs
cat ~/.cache/claude/memesh/install.log
```

---

### MCP Server Issues

**Problem**: Tools not available in Claude Code

**Solution**:
```bash
# 1. Kill old processes
npm run processes:kill

# 2. Verify installation
npm list -g @pcircle/memesh

# 3. Reinstall if needed
npm install -g @pcircle/memesh

# 4. Restart Claude Code completely
```

---

**Problem**: MCP server crashes on startup

**Solution**:
```bash
# Check logs
tail -f ~/.cache/claude/mcp-logs/memesh.log

# Verify server can start
npm run verify:mcp

# If verification fails, check:
# 1. Node.js version >= 20
# 2. Database file is not corrupted
# 3. No other process using the same port
```

---

## Best Practices

### Code Quality

1. **Use strict TypeScript**
   - Avoid `any` types
   - Define explicit interfaces
   - Use type guards for runtime checks

2. **Write tests for new code**
   - Minimum 70% coverage for new files
   - Test both success and error paths
   - Use descriptive test names

3. **Follow existing patterns**
   - Check how similar features are implemented
   - Maintain consistent code style
   - Reuse existing utilities

### Git Workflow

1. **Small, focused commits**
   - One logical change per commit
   - Use conventional commit messages
   - Reference issue numbers when applicable

2. **Keep branches up to date**
   ```bash
   git checkout main
   git pull
   git checkout feature/your-branch
   git rebase main
   ```

3. **Run pre-commit checks**
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

### Performance

1. **Avoid blocking operations**
   - Use async/await for I/O
   - Don't block the event loop

2. **Profile before optimizing**
   - Use Node.js built-in profiler
   - Measure before and after changes

3. **Monitor memory usage**
   - Check for memory leaks
   - Use appropriate data structures

### Security

1. **Never commit sensitive data**
   - Use environment variables
   - Add sensitive files to `.gitignore`

2. **Validate user input**
   - Use Zod schemas for validation
   - Sanitize inputs before database queries

3. **Use secure dependencies**
   ```bash
   # Audit dependencies
   npm audit

   # Fix vulnerabilities
   npm audit fix
   ```

---

## Additional Resources

- **[Architecture Documentation](ARCHITECTURE.md)** - System design and components
- **API Reference** - Run `npm run build` to generate API docs locally
- **[User Guide](USER_GUIDE.md)** - End-user documentation
- **[Troubleshooting Guide](TROUBLESHOOTING.md)** - Common issues and solutions
- **[MCP Specification](https://modelcontextprotocol.io)** - MCP protocol details

---

## Getting Help

- **Discussions**: [GitHub Discussions](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
- **Issues**: [GitHub Issues](https://github.com/PCIRCLE-AI/claude-code-buddy/issues)

---

**Happy coding!** 🚀

If you find something unclear in this guide, please [open an issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=documentation) or submit a PR to improve it.
