# MeMesh Setup Guide

## Quick Installation (Recommended)

**One command, fully automatic:**

```bash
npm install -g @pcircle/memesh
```

The postinstall script automatically configures Claude Code's MCP settings. Just restart Claude Code and you're ready to go.

**No API keys needed** — uses your Claude Code subscription.

---

## Install from Source (For Contributors)

If you want to modify the code or contribute:

### Step 1: Clone and Build

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install
npm run build
```

### Step 2: Configure Environment

```bash
# Create .env from template (optional, uses defaults)
cp .env.example .env
```

**API keys**: Not required in MCP server mode (`MCP_SERVER_MODE=true`). If running standalone orchestrator, set `MCP_SERVER_MODE=false` and `ANTHROPIC_API_KEY` in `.env`.

### Step 3: Compile TypeScript

```bash
npm run build
```

### Step 4: Configure MCP Server

MeMesh is a Claude Code Plugin. The MCP server is auto-managed via the plugin's `.mcp.json` file — no manual configuration of `~/.claude/mcp_settings.json` is needed.

If auto-configuration did not work, run the setup wizard:

```bash
memesh setup
```

### Step 5: Restart Claude Code

Restart Claude Code, and the MCP server will start automatically.

### Step 6: Verify Installation

Test in Claude Code:

```
Please use claude-code-buddy to review this code...
```

---

## Verification Checklist (V2.0)

- [ ] Node.js >= 20 installed
- [ ] Project dependencies installed (`npm install`)
- [ ] TypeScript compiled (`npm run build`)
- [ ] MCP server auto-configured via plugin's `.mcp.json` (or run `memesh setup` if needed)
- [ ] Claude Code restarted

## Common Issues (V2.0)

### Q: MCP server fails to start

**Solutions**:
1. Check if the plugin's `.mcp.json` is correctly configured (or run `memesh setup`)
2. Confirm `npm run build` executed successfully
3. Check Claude Code logs: `~/.claude/logs/`
4. Try running manually: `npm run mcp`

### Q: Cannot find claude-code-buddy tools

**Solutions**:
1. Confirm Claude Code has been restarted
2. Check MCP server status
3. Try running in Claude Code: `/mcp list`

### Q: Out of memory

**Solutions**:
1. Close other applications
2. Increase Node.js memory limit: `NODE_OPTIONS="--max-old-space-size=4096" npm run mcp`

## System Requirements

### Minimum Requirements
- **Node.js**: >= 20.0.0
- **Claude Code**: Installed
- **RAM**: 2 GB (V2.0 MCP server is lightweight)
- **Storage**: 5 GB available space

### Recommended Configuration
- **Node.js**: >= 20.0.0
- **Claude Code**: Latest version
- **RAM**: 4+ GB
- **Storage**: 20+ GB SSD
- **Network**: Stable connection (Claude Code → Claude API)

## Next Steps

After configuration, see:
- [User Guide](../USER_GUIDE.md) - How to use core capabilities
- [Commands Reference](../COMMANDS.md) - Buddy commands + MCP tools
- [Troubleshooting](../TROUBLESHOOTING.md) - Common fixes
