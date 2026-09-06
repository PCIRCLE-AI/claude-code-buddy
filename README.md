🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>A memory for your AI coding agent that survives between sessions.</strong><br />
    One SQLite file. No Docker. No cloud required.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## What it does

Each session, your AI coding agent starts from zero. It proposes the approach you rejected last month, trips over the same failing test, and asks you to explain the architecture it helped design.

MeMesh remembers for it. Decisions, lessons and where you left off are captured while you work and handed back to the agent at the right moment. It works with Claude Code, Codex, Cursor and any local MCP client.

```
   you work with the agent
            |
            v
   +------------------+      +------------------+
   |  capture         |      |  recall          |
   |  sessions,       | ---> |  at session      |
   |  commits, fixes  |      |  start and       |
   |  (automatic)     |      |  before edits    |
   +------------------+      +------------------+
            |                         ^
            v                         |
   +----------------------------------------+
   |  ~/.memesh/knowledge-graph.db           |
   |  decisions, lessons, links between them |
   +----------------------------------------+
```

- **Nothing to write by hand.** In Claude Code, **9 hooks** do the capturing and reminding: at session start, before file edits, after `git commit`, when Claude stops, before context compaction, when you say "remember this" (5 languages), and before a risky command that repeats a recorded mistake.
- **One memory for all your tools.** A decision stored from Claude Code is recalled from Codex or Cursor the next day.
- **Agents can leave each other messages.** A durable inbox on your machine, picked up even after a restart.
- **A dashboard** to browse it all: 5 tabs, 11 languages, at `http://localhost:3737/dashboard`.

---

## Works with

| Platform | How | Notes |
|---|---|---|
| Claude Code | Plugin: hooks, MCP tools, `/memesh` skill | Full automatic capture and recall |
| Codex CLI, Gemini CLI | MCP server (`memesh-mcp`) | `codex mcp add memesh -- memesh-mcp`, `gemini mcp add -s user memesh memesh-mcp` |
| Cursor, Cline and other MCP clients | MCP server (`memesh-mcp`) | Point the client at `memesh-mcp` |
| Hermes Agent | Native memory-provider plugin | [docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md) |
| OpenClaw | Native memory plugin | Source only, not yet published: [docs/platforms/openclaw.md](docs/platforms/openclaw.md) |
| Your own scripts and apps | HTTP API from `memesh serve` | [docs/platforms/universal.md](docs/platforms/universal.md) |
| ChatGPT, Gemini web and other hosted chat | HTTP API through a local bridge you run | [docs/platforms/README.md](docs/platforms/README.md) |

Optional AI models for the extras (auto-tagging, lessons from failures, conflict checks): Anthropic, OpenAI, or a local Ollama. Optional meaning-based search: Ollama or OpenAI embeddings. Without any of these, everything above still works on keyword search.

---

## Install

Two install paths. They share one database and never conflict. Most Claude Code users want both.

```
   Claude Code chat                Terminal, Codex, Cursor
         |                                  |
         v                                  v
   +-----------------+              +------------------+
   | A: plugin       |              | B: npm global    |
   | /plugin install |              | npm install -g   |
   | hooks + tools   |              | memesh CLI       |
   | + /memesh skill |              | + memesh-mcp     |
   +-----------------+              +------------------+
         |                                  |
         +---------------+------------------+
                         v
            ~/.memesh/knowledge-graph.db
               (one file, both paths)
```

**A. Inside Claude Code** (hooks, tools and the `/memesh` skill are wired for you):

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Restart Claude Code. A `◉ MeMesh` line appears at the top of the next session.

**B. In a terminal** (needs [Node 22.13+](https://nodejs.org)):

```bash
npm install -g @pcircle/memesh
memesh doctor          # checks the whole install
memesh install-hooks   # only if you skipped A: wires Claude Code, keeps your own hooks
```

For Codex: `codex mcp add memesh -- memesh-mcp`. For Cursor, add `{ "mcpServers": { "memesh": { "command": "memesh-mcp" } } }` to `~/.cursor/mcp.json`.

> **The plugin does not install the CLI.** After `/plugin install`, typing `memesh` in a terminal says `command not found` until you also run `npm install -g @pcircle/memesh`. If you only use Claude Code chat, A alone is enough.

**Update:** `memesh upgrade-plugin` for the plugin, `memesh update` for the npm install. **Installing with an AI agent?** Point it at [llms-install.md](llms-install.md).

---

## Get started

```bash
memesh remember "Use OAuth 2.0 with PKCE for the new auth"
memesh recall "login security"
# -> finds the PKCE decision even though you used different words

memesh briefing        # what the agent knows about this project, where you left off
memesh serve           # open the dashboard
```

In Claude Code you do not even need the terminal: say "remember this" in chat, and the briefing arrives on its own at every session start.

Two things worth knowing once you have memories:

- `forget` archives a memory instead of deleting it. A newer memory can replace an older one.
- `memesh dream conflicts` (needs an AI model) finds two memories that cannot both be true. You confirm, and every later `recall` of either one carries a warning.

Full command and tool reference: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md). How it is built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## All 11 Memory and Coordination Tools

| Tool | What it does |
|------|-------------|
| `remember` | Store knowledge with observations, relations, and tags |
| `recall` | FTS5 + sqlite-vec search with multi-factor scoring (relevance, recency, frequency, confidence, recall impact) — no LLM in the hot path |
| `forget` | Soft-archive (never deletes) or remove specific observations |
| `export` | Back up, migrate, or move memories as JSON between compatible agents |
| `import` | Import memories with merge strategies (skip / overwrite / append) |
| `learn` | Record structured lessons from mistakes (error, root cause, fix, prevention) |
| `task_state` | Read or record where the work stands — goal, next step, blocker, what was just finished |
| `briefing` | The assembled work topology for any MCP client; generic context stays quiet, while exact `project` + `recipient` can surface only that recipient's unfetched deliveries |
| `user_patterns` | Analyze your work patterns — schedule, tools, strengths, learning areas |
| `improvement` | Stage an evidence-linked product improvement for human review, or read its status; agents cannot accept or reject it |
| `message` | Discover live agents, then exchange exact-recipient untrusted messages. Durable JSON payload max: 64 KiB; complete native envelope max: 16 KiB with distinct `native_message_too_large` and `recipient_unavailable` failures. Native acceptance, discovery, poll, and fetch never imply acknowledgement or disposition |

---

## The fine print

**Scored Ranking** — Results ranked by relevance (30%) + recency (25%) + frequency (18%) + confidence (17%) + recall impact (10%).

**Agent messaging, the exact rules** (full guide: [docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)):

- Works today: an MCP, HTTP, or CLI sender can durably send one untrusted JSON-encoded payload of at most 65,536 UTF-8 bytes (64 KiB) to one named local recipient. A receiver can fetch it separately, resume from an opaque cursor after restart, and record intake, acknowledgement, workflow disposition, and host activation as separate facts.
- With the MeMesh Codex plugin enabled and the owner-private `memesh agent setup codex-session` opt-in, an exact active Codex session receives one bounded full message through its native queue without polling or a human reminder, and without a second inbox fetch. The complete native envelope, including routing metadata and payload, is capped separately at 16,384 bytes (16 KiB). An exact-session send returns success only after that native queue accepts it; an oversized full envelope reports `native_message_too_large`, while other unavailable or rejected sessions report `recipient_unavailable`. Scoped recovery data remains durable. Principal targets retain durable store-and-forward behavior.
- A stopped, missing, or disconnected Codex session is not woken up or replaced. Its inbox stays available; `memesh message storage report` shows what is stored. Native wake-up works on macOS and Linux only.

---

<p align="center"><strong>MIT License</strong></p>
