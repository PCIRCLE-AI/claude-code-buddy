<div align="center">

# 🧠 MeMesh Plugin

### A productivity plugin for Claude Code

Memory, smart task analysis, and workflow automation — all in one plugin.

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[Install](#install) • [Usage](#usage) • [Troubleshooting](#troubleshooting)

[繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## Why This Project Exists

This project started because I wanted to help more people — especially those new to coding — get the most out of Claude Code for vibe coding. One thing I noticed: when projects grow, it gets hard to keep track of all the decisions you've made across sessions. So I built a plugin (with Claude Code, of course) that remembers for you.

> **Note**: This project was originally called "Claude Code Buddy" and has been renamed to MeMesh Plugin to avoid potential trademark issues.

## What Does It Do?

MeMesh Plugin makes Claude Code smarter and more productive. It's not just memory — it's a full toolkit:

**Searchable Project Memory** — Automatically saves decisions, patterns, and lessons as you work. Search by meaning, not just keywords. Ask "what did we decide about auth?" and get an instant answer.

**Smart Task Analysis** — When you say `buddy-do "add user auth"`, MeMesh analyzes the task, pulls in relevant context from past work, and gives you an enriched plan before executing.

**Workflow Automation** — Behind the scenes, MeMesh hooks into Claude Code to:
- Show you a recap of your last session when you start
- Track which files you've changed and tested
- Remind you about code reviews before committing
- Route tasks to the right model (fast model for search, powerful model for planning)

**Learn from Mistakes** — Record errors and their fixes so they don't happen again. MeMesh builds a knowledge base of what works and what doesn't.

**How is this different from Claude's built-in memory?**

Claude Code already has auto memory and CLAUDE.md — great for general preferences and instructions. MeMesh adds dedicated **project-level tools** on top: searchable memory you can query by meaning, task analysis that pulls in past context, and automated workflows that make every session more productive.

Think of it this way:
- **CLAUDE.md** = your instruction manual for Claude
- **MeMesh** = a searchable notebook + smart assistant that learns as your project grows

---

## Install

**You need**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Restart Claude Code. Done.

**Check it works** — type this in Claude Code:

```
buddy-help
```

You should see a list of commands.

<details>
<summary>Install from source (for contributors)</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## Usage

MeMesh adds 3 commands to Claude Code:

| Command | What it does |
|---------|-------------|
| `buddy-do "task"` | Run a task with memory context |
| `buddy-remember "topic"` | Search for past decisions and context |
| `buddy-help` | Show available commands |

**Examples:**

```bash
buddy-do "explain this codebase"
buddy-do "add user authentication"
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

Everything is stored locally on your machine. Decisions are kept for 90 days, session notes for 30 days.

---

## Where It Runs

| Platform | Status |
|----------|--------|
| **macOS** | ✅ Works |
| **Linux** | ✅ Works |
| **Windows** | ✅ Works (WSL2 recommended) |

**Works with:**
- Claude Code CLI (terminal)
- Claude Code VS Code Extension
- Cursor (via MCP)
- Other MCP-compatible editors

**Claude Desktop (Cowork)**: Basic commands work, but memory features need the CLI version. See [Cowork details](docs/COWORK_SUPPORT.md).

---

## Troubleshooting

**MeMesh not showing up?**

```bash
# Check it's installed
npm list -g @pcircle/memesh

# Check Node.js version (needs 20+)
node --version

# Re-run setup
memesh setup
```

Then restart Claude Code completely.

More help: [Troubleshooting Guide](docs/TROUBLESHOOTING.md)

---

## Learn More

- **[Getting Started](docs/GETTING_STARTED.md)** — Step-by-step setup
- **[User Guide](docs/USER_GUIDE.md)** — Full usage guide with examples
- **[Commands](docs/COMMANDS.md)** — All available commands
- **[Architecture](docs/ARCHITECTURE.md)** — How it works under the hood
- **[Contributing](CONTRIBUTING.md)** — Want to help? Start here
- **[Development Guide](docs/DEVELOPMENT.md)** — For contributors

---

## License

MIT — See [LICENSE](LICENSE)

---

<div align="center">

Something not working? [Open an issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — we respond fast.

[Report Bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [Request Feature](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
