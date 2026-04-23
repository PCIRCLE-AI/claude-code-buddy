🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Local memory for Claude Code and MCP coding agents.</strong><br />
    One SQLite file. No Docker. No cloud required.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## The Problem

Your coding agent forgets what happened between sessions. Every architecture decision, bug fix, failed test, and hard-won lesson has to be re-explained. Claude Code starts fresh, re-discovers old constraints, and burns context on things it should already know.

**MeMesh gives coding agents persistent, searchable, evolving local memory.**

This package is the local memory layer of the MeMesh product family. It is intentionally small and open-source: install it with npm, keep your memory in `~/.memesh/knowledge-graph.db`, and connect it to Claude Code or any MCP-compatible client. Hosted workspace and enterprise operating-system products should stay separate from this package's README and roadmap.

---

## Get Started in 60 Seconds

### Step 1: Install

```bash
npm install -g @pcircle/memesh
```

### Step 2: Store a decision

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### Step 3: Recall it later

```bash
memesh recall "login security"
# → Finds "OAuth 2.0 with PKCE" even though you searched different words
```

**That's it.** MeMesh is now remembering and recalling across sessions.

Open the dashboard to explore your memory:

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — find any memory instantly" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — health score, timeline, patterns, knowledge coverage" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — interactive knowledge graph with type filters and ego mode" width="100%" />
</p>

---

## Who Is This For?

| If you are... | MeMesh helps you... |
|---------------|---------------------|
| **A developer using Claude Code** | Auto-recall project decisions, file-specific lessons, and past failures as you work |
| **A coding-agent power user** | Share one local memory layer across MCP-compatible tools |
| **A team experimenting with AI coding workflows** | Export/import project knowledge without introducing hosted infrastructure |
| **An agent developer** | Add local memory through MCP, HTTP, CLI, or the Python SDK |

---

## Designed For Coding Agents First

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP tools + Claude Code hooks

</td>
<td width="33%" align="center">

**Any HTTP Client**
```bash
curl localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"auth"}'
```
`memesh serve` (REST API)

</td>
<td width="33%" align="center">

**Any LLM (OpenAI format)**
```bash
memesh export-schema \
  --format openai
```
Paste tools into any API call

</td>
</tr>
</table>

---

## Why Not OpenMemory, Cursor Memories, Mem0, Or Zep?

| | **MeMesh** | OpenMemory | Cursor Memories | Mem0 | Zep / Graphiti |
|---|---|---|---|---|---|
| **Best fit** | Local memory for coding agents | Local/cross-client MCP memory | Cursor-native project memory | Managed app/agent memory | Temporal knowledge graphs |
| **Install shape** | `npm install -g @pcircle/memesh` | Local app/server flow | Built into Cursor | Cloud API / SDK / MCP | Service/framework setup |
| **Storage** | One local SQLite file | Local memory stack | Cursor-managed rules/memories | Hosted or self-hosted stack | Graph database |
| **Cloud required** | No | No for local mode | Depends on Cursor account/settings | Yes for platform | Usually yes/self-hosted |
| **Claude Code hooks** | First-class | MCP tools | No | MCP tools | Not Claude Code-specific |
| **Dashboard** | Built in | Built in | Cursor settings | Platform dashboard | Platform/graph tooling |
| **Tradeoff** | Simple local wedge, not enterprise scale | Broader local app footprint | Locked to Cursor | Strong managed platform, less local-first | Strong graph model, heavier setup |

**MeMesh trades enterprise-scale managed infrastructure for instant local setup, inspectable storage, and coding-agent workflow hooks.**

---

## What Happens Automatically In Claude Code

You don't need to manually remember everything. MeMesh has **5 hooks** that capture and inject knowledge while you work:

| When | What MeMesh does |
|------|------------------|
| **Every session start** | Loads your most relevant memories + proactive warnings from past lessons |
| **Before editing files** | Recalls memories tied to the file or project before Claude writes code |
| **After every `git commit`** | Records what you changed, with diff stats |
| **When Claude stops** | Captures files edited, errors fixed, and auto-generates structured lessons from failures |
| **Before context compaction** | Saves knowledge before it's lost to context limits |

> **Opt out anytime:** `export MEMESH_AUTO_CAPTURE=false`

---

## Dashboard

7 tabs, 11 languages, zero external dependencies. Access at `http://localhost:3737/dashboard` when the server is running.

| Tab | What you see |
|-----|-------------|
| **Search** | Full-text + vector similarity search across all memories |
| **Browse** | Paginated list of all entities with archive/restore |
| **Analytics** | Memory Health Score (0-100), 30-day timeline, value metrics, knowledge coverage, cleanup suggestions, your work patterns |
| **Graph** | Interactive force-directed knowledge graph with type filters, search, ego mode, recency heatmap |
| **Lessons** | Structured lessons from past failures (error, root cause, fix, prevention) |
| **Manage** | Archive and restore entities |
| **Settings** | LLM provider config, language selector |

---

## Smart Features

**🧠 Smart Search** — Search "login security" and find memories about "OAuth PKCE". MeMesh expands queries with related terms using your configured LLM.

**📊 Scored Ranking** — Results ranked by relevance (30%) + recency (25%) + frequency (15%) + confidence (15%) + recall impact (10%) + temporal validity (5%).

**🔄 Knowledge Evolution** — Decisions change. `forget` archives old memories (never deletes). `supersedes` relations link old → new. Your AI always sees the latest version.

**⚠️ Conflict Detection** — If you have two memories that contradict each other, MeMesh warns you.

**📦 Team Sharing** — `memesh export > team-knowledge.json` → share with your team → `memesh import team-knowledge.json`

---

## Example Usage

> "MeMesh remembered that we chose PKCE over implicit flow three weeks ago. When I asked Claude about auth again, it already knew — no re-explaining needed."
> — **Solo developer, building a SaaS**

> "We export our team's memory every Friday and import it Monday. Everyone's Claude starts the week knowing what the team learned last week."
> — **3-person startup, shared knowledge base**

> "The dashboard showed me that 90% of my memories were auto-generated session logs. I started using `remember` deliberately for architecture decisions. Game changer."
> — **Developer who discovered the Analytics tab**

---

## Unlock Smart Mode (Optional)

MeMesh works offline by default. Add an LLM API key only if you want query expansion, smarter extraction, and compression:

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

Or use the dashboard Settings tab (visual setup):

```bash
memesh  # opens dashboard → Settings tab
```

| | Level 0 (default) | Level 1 (Smart Mode) |
|---|---|---|
| **Search** | FTS5 keyword matching | + LLM query expansion (~97% recall) |
| **Auto-capture** | Rule-based patterns | + LLM extracts decisions & lessons |
| **Compression** | Not available | `consolidate` compresses verbose memories |
| **Cost** | Free, no API key | ~$0.0001 per search (Haiku) |

---

## All 8 Memory Tools

| Tool | What it does |
|------|-------------|
| `remember` | Store knowledge with observations, relations, and tags |
| `recall` | Smart search with multi-factor scoring and LLM query expansion |
| `forget` | Soft-archive (never deletes) or remove specific observations |
| `consolidate` | LLM-powered compression of verbose memories |
| `export` | Share memories as JSON between projects or team members |
| `import` | Import memories with merge strategies (skip / overwrite / append) |
| `learn` | Record structured lessons from mistakes (error, root cause, fix, prevention) |
| `user_patterns` | Analyze your work patterns — schedule, tools, strengths, learning areas |

---

## Architecture

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (8 operations) │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           │                 │                 │
     CLI (memesh)    HTTP API (serve)    MCP (memesh-mcp)
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                    SQLite + FTS5 + sqlite-vec
                    (~/.memesh/knowledge-graph.db)
```

Core is framework-agnostic. Same logic runs from terminal, HTTP, or MCP.

---

## Contributing

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test             # 445 tests
```

Dashboard: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Made by <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
