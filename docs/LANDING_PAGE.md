# MeMesh Plugin — Searchable Project Memory for Claude Code

> Remember decisions, patterns, and context — across every session.

---

## The Problem

Claude Code's built-in memory (CLAUDE.md, auto memory) works for preferences and instructions. But when your project grows, you need answers to questions like:

- "What did we decide about auth last Tuesday?"
- "Why did we switch from REST to GraphQL?"
- "What was the fix for that database timeout?"

CLAUDE.md can't answer these — it's a manual file, not a searchable database.

---

## How MeMesh Helps

MeMesh gives Claude a persistent, searchable memory that works automatically.

**Monday**: You debug an API rate limit issue
→ MeMesh stores: "GitHub API: 5000 requests/hour, reset at :00"

**Friday**: You ask Claude to add GitHub integration
→ Claude recalls: "I see we're rate-limited to 5000/hour..."

No re-explaining. No wasted time. Just continuity.

---

## Features

| Feature | Description |
|---------|-------------|
| **Automatic Memory** | Claude auto-saves decisions, architecture choices, and debugging insights after every session |
| **Semantic Search** | Ask "what did we decide about auth?" and get instant context |
| **Private & Local** | All memories stored locally on your machine. Never uploaded to cloud. |
| **Project Isolation** | Memories scoped to project path — no cross-contamination |
| **Time-Based Retention** | Decisions: 90 days. Sessions: 30 days. Auto-cleanup, configurable. |
| **Zero Config** | Install → Done. No API keys, no cloud setup. Works offline. |

---

## Get Started in 30 Seconds

```bash
npm install -g @pcircle/memesh
```

That's it. Restart Claude Code, and MeMesh is running.

**Verify installation:**
```bash
buddy-help
```

**First command:**
```bash
buddy-do "explain this codebase"
```

**Requirements:**
- Claude Code CLI (latest)
- Node.js >= 20
- 100MB disk space

**Supported:** macOS, Linux, Windows (WSL2)

---

## Who Benefits from MeMesh?

### Solo Developers
Managing multiple projects? MeMesh tracks project-specific decisions, API versions, and environment configurations across different codebases.

### Small Teams
Reduce onboarding time by maintaining a searchable knowledge base of architecture decisions and technical choices.

### Research & Prototyping
Track experimental results, model parameters, and research decisions across multiple iterations.

---

## FAQ

**Q: Is my data sent to any server?**
A: No. All memories are stored locally in `~/.memesh/` on your machine.

**Q: Does it work with other AI assistants?**
A: Currently optimized for Claude Code. Cursor support via MCP coming soon.

**Q: How much disk space does it use?**
A: ~100MB for embeddings + ~1MB per 100 memories. Average user: 150-300MB total.

**Q: Can I export my memories?**
A: Yes. `memesh export --format json` exports all memories with timestamps and metadata.

**Q: Does it slow down Claude?**
A: No. Memory operations run in background with sub-50ms query latency.

---

## Your Data, Your Machine

- **100% Local Storage** — No cloud uploads
- **Open Source** — MIT license, [audited on GitHub](https://github.com/PCIRCLE-AI/claude-code-buddy)
- **No Telemetry** — Zero tracking, zero analytics
- **Data Portability** — Export and backup your memories anytime

---

## Links

- [GitHub](https://github.com/PCIRCLE-AI/claude-code-buddy)
- [npm](https://www.npmjs.com/package/@pcircle/memesh)
- [User Guide](USER_GUIDE.md)
- [Report Issues](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)
