# MeMesh Integration Guide

MeMesh is designed for local coding-agent memory first. The preferred path is MCP for Claude Code and other MCP-compatible coding agents, with HTTP and CLI available for local tools, scripts, and bridge-based experiments.

If your goal is cross-agent collaboration rather than memory alone, start with the [Local Agent Messaging Guide](./agent-messaging.md). It explains the explicit local message lifecycle, what still requires polling or a bridge, and which host behaviors remain adapter-dependent.

---

## 🎯 Quick Platform Guide

| Client | Best Mode | Setup | Guide |
|--------|-----------|-------|-------|
| **Claude Code** | Plugin (hooks + MCP + skills, wired automatically) | `/plugin marketplace add PCIRCLE-AI/memesh` → `/plugin install memesh@pcircle-memesh` | See root [README](../../README.md) |
| **Codex CLI / Gemini CLI** | MCP Server | `codex mcp add memesh -- memesh-mcp` / `gemini mcp add -s user memesh memesh-mcp` (needs `npm install -g @pcircle/memesh`) | See root [README](../../README.md) |
| **Other MCP coding agents (Cursor, Cline…)** | MCP Server | Point the client at `memesh-mcp` | See root [README](../../README.md) |
| **Local agent messaging across hosts** | MCP / HTTP / CLI; bridge where required | Explicit exact-recipient local messaging today; host push/resume remains adapter work | [agent-messaging.md](./agent-messaging.md) |
| **Hermes Agent (NousResearch)** | Native `MemoryProvider` plugin | Drop `plugins/memory/memesh/` into a Hermes Agent checkout; `hermes memory setup memesh` | [hermes-agent.md](./hermes-agent.md) |
| **OpenClaw** | Native memory plugin | `openclaw plugins install <package>` or drop into OpenClaw checkout; configure `plugins.slots.memory` | [openclaw.md](./openclaw.md) |
| **Custom apps / scripts** | HTTP API | Run `memesh serve` and call `/v1/*` | [universal.md](./universal.md) |
| **ChatGPT / Custom GPT experiments** | HTTP API | Use a local connector/proxy that can reach localhost | [chatgpt.md](./chatgpt.md) |
| **Gemini web / AI Studio experiments** | HTTP API | Use a local connector/proxy that can reach localhost (the Gemini **CLI** uses MCP above instead) | [gemini.md](./gemini.md) |
| **Grok or other browser-hosted AI** | HTTP API | Use a local connector/proxy that can reach localhost; support is adapter-specific | [agent-messaging.md](./agent-messaging.md) |

---

## 📊 Integration Modes Comparison

### 🟢 HTTP API Mode
**Best for**: custom local apps, scripts, dashboards, and bridge-based experiments that can call `localhost`

**Pros**:
- Works with local apps and custom bridges
- No MCP support required
- Easy to test manually with curl

**Cons**:
- Requires server to be running
- Browser-only AI products still need a connector, action, proxy, or local bridge to reach `localhost`

**Setup**:
```bash
npm install -g @pcircle/memesh
memesh serve --port 3737
curl http://localhost:3737/v1/health
```

---

### 🟡 MCP Server Mode (Native)
**Best for**: Claude Code and MCP-compatible coding agents

**Pros**:
- Native tool integration (cleanest UX)
- Structured inputs/outputs
- Auto-discovery of capabilities

**Cons**:
- Only works with MCP-compatible clients
- Requires MCP config setup

**Setup**:
```bash
npm install -g @pcircle/memesh
memesh-mcp
# Add this command to your MCP client's server config.
```

---

### 🔴 CLI Mode (Advanced)
**Best for**: Terminal-based workflows, scripting, CI/CD

**Pros**:
- Works without server
- Can be scripted
- Direct database access

**Cons**:
- Requires AI to invoke shell commands
- Less interactive

**Setup**:
```bash
npm install -g @pcircle/memesh
memesh remember --name "test" --type note --obs "Hello"
memesh recall "test"
```

---

## 🚀 Quick Start (Local Workflow)

### 1. Install MeMesh
```bash
npm install -g @pcircle/memesh
```

### 2. Start the server
```bash
memesh serve
# Server running at http://localhost:3737
# Dashboard at http://localhost:3737/dashboard
```

### 3. Test the HTTP API
```bash
curl http://localhost:3737/v1/health
curl -X POST http://localhost:3737/v1/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"test"}'
```

### 4. Connect your client
Use MCP mode when the client supports MCP. Use HTTP mode when you control a local app, script, or connector that can call `localhost`.

---

## 📚 Platform-Specific Guides

- **[Hermes Agent (NousResearch)](./hermes-agent.md)** - Native `MemoryProvider` plugin, on par with MCP mode
- **[OpenClaw](./openclaw.md)** - Native memory plugin (TypeScript), same tier as Hermes
- **[Local Agent Messaging Guide](./agent-messaging.md)** - Durable local message lifecycle, recovery semantics, limits, and host matrix
- **[ChatGPT / Custom GPTs](./chatgpt.md)** - HTTP API with custom instructions
- **[Google Gemini](./gemini.md)** - HTTP API with system instructions
- **[Universal Guide](./universal.md)** - For local tools or bridge-based integrations

---

## 🔍 How to Choose

**Use MCP Mode if**:
- Your platform explicitly supports MCP (Model Context Protocol)
- You want the cleanest, most native experience
- You're using Claude Code or another MCP-compatible coding agent

**Use HTTP API Mode if**:
- You control a local app, script, or connector that can call `localhost`
- You want to integrate MeMesh into a custom workflow outside native MCP
- You're using ChatGPT or Gemini through a local bridge rather than the hosted web UI alone

**Use CLI Mode if**:
- You're building scripts or automation
- You need direct database access
- You're integrating MeMesh into CI/CD

---

## 🛠️ Troubleshooting

**"Connection refused" error**:
- Make sure `memesh serve` is running
- Check the port (default: 3737)
- Try `curl http://localhost:3737/v1/health`

**"No memories found"**:
- Create a test memory: `memesh remember --name test --type note --obs "Hello"`
- Check dashboard: http://localhost:3737/dashboard

**MCP client not seeing tools**:
- Verify the client is configured to run `memesh-mcp`
- Run `memesh doctor` to verify `.mcp.json`, hooks, dashboard assets, local database, and install method
- Run `memesh status` to confirm capabilities and update state
- Check the client logs for MCP server startup errors

---

**Need help?** Open an issue: https://github.com/PCIRCLE-AI/memesh/issues
