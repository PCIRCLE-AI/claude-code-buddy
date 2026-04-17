🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>The lightest universal AI memory layer.</strong><br />
    One SQLite file. Any LLM. Zero cloud.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
    <a href="https://pypi.org/project/memesh/"><img src="https://img.shields.io/badge/pip-memesh-3b82f6?style=flat-square" alt="PyPI" /></a>
  </p>
</p>

---

## The Problem

Your AI forgets everything between sessions. Every decision, every bug fix, every lesson learned — gone. You re-explain the same context, Claude re-discovers the same patterns, and your team's AI knowledge resets to zero.

**MeMesh gives every AI persistent, searchable, evolving memory.**

---

## Get Started in 60 Seconds

### Step 1: Install

```bash
npm install -g @pcircle/memesh
```

### Step 2: Your AI remembers

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### Step 3: Your AI recalls

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
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — understand your AI's knowledge" width="100%" />
</p>

---

## Who Is This For?

| If you are... | MeMesh helps you... |
|---------------|---------------------|
| **A developer using Claude Code** | Remember decisions, patterns, and lessons across sessions automatically |
| **A team building with LLMs** | Share team knowledge via export/import, keep everyone's AI context aligned |
| **An AI agent developer** | Give your agents persistent memory via MCP, HTTP API, or Python SDK |
| **A power user with multiple AI tools** | One memory layer that works with Claude, GPT, LLaMA, Ollama, or any MCP client |

---

## Works With Everything

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP protocol (auto-configured)

</td>
<td width="33%" align="center">

**Python / LangChain**
```python
from memesh import MeMesh
m = MeMesh()
m.recall("auth")
```
`pip install memesh`

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

## Why Not Just Use Mem0 / Zep?

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **Install time** | 5 seconds | 30-60 minutes | 30+ minutes |
| **Setup** | `npm i -g` — done | Neo4j + VectorDB + API keys | Neo4j + config |
| **Storage** | Single SQLite file | Neo4j + Qdrant | Neo4j |
| **Works offline** | Yes, always | No | No |
| **Dashboard** | Built-in (5 tabs) | None | None |
| **Dependencies** | 6 | 20+ | 10+ |
| **Price** | Free forever | Free tier / Paid | Free tier / Paid |

**MeMesh trades:** enterprise-scale multi-tenant features for **instant setup, zero infrastructure, and 100% privacy**.

---

## What Happens Automatically

You don't need to manually remember everything. MeMesh has **4 hooks** that capture knowledge without you doing anything:

| When | What MeMesh does |
|------|------------------|
| **Every session start** | Loads your most relevant memories (ranked by scoring algorithm) |
| **After every `git commit`** | Records what you changed, with diff stats |
| **When Claude stops** | Captures files edited, errors fixed, and decisions made |
| **Before context compaction** | Saves knowledge before it's lost to context limits |

> **Opt out anytime:** `export MEMESH_AUTO_CAPTURE=false`

---

## Smart Features

**🧠 Smart Search** — Search "login security" and find memories about "OAuth PKCE". MeMesh expands queries with related terms using your configured LLM.

**📊 Scored Ranking** — Results ranked by relevance (35%) + how recently you used it (25%) + how often (20%) + confidence (15%) + whether the info is still current (5%).

**🔄 Knowledge Evolution** — Decisions change. `forget` archives old memories (never deletes). `supersedes` relations link old → new. Your AI always sees the latest version.

**⚠️ Conflict Detection** — If you have two memories that contradict each other, MeMesh warns you.

**📦 Team Sharing** — `memesh export > team-knowledge.json` → share with your team → `memesh import team-knowledge.json`

---

## Unlock Smart Mode (Optional)

MeMesh works fully offline out of the box. Add an LLM API key to unlock smarter search:

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

## All 6 Memory Tools

| Tool | What it does |
|------|-------------|
| `remember` | Store knowledge with observations, relations, and tags |
| `recall` | Smart search with multi-factor scoring and LLM query expansion |
| `forget` | Soft-archive (never deletes) or remove specific observations |
| `consolidate` | LLM-powered compression of verbose memories |
| `export` | Share memories as JSON between projects or team members |
| `import` | Import memories with merge strategies (skip / overwrite / append) |

---

## Architecture

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (6 operations) │
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
npm test -- --run    # 289 tests
```

Dashboard: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Made by <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
