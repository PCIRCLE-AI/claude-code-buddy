---
name: memesh
description: Use MeMesh to remember, recall, and manage AI knowledge across sessions. Triggers when the user asks to remember something, recall past decisions, forget outdated info, learn from mistakes, or analyze work patterns. Also triggers proactively when you make important decisions, fix bugs, or learn lessons worth preserving.
user-invocable: true
---

# MeMesh — AI Memory Management

Persistent memory layer for AI agents. Remember decisions, recall context, learn from mistakes — across sessions.

## How to Access (auto-detect)

```
1. MCP tools available? (remember, recall, forget, learn in your tool list)
   → YES: use MCP tools directly (fastest, structured I/O)
   → NO: continue to step 2

2. CLI available? Run: memesh status
   → Works: use CLI commands below
   → "command not found": Run: npx @pcircle/memesh status
   → Works: use npx @pcircle/memesh <command> for all commands below
```

All examples below use CLI. MCP tools accept the same parameters as JSON objects.

## What's Already Automatic (Claude Code Plugin Hooks)

If MeMesh is installed as a Claude Code plugin, these happen **without any action from you**:

| Hook | When | What it does |
|------|------|-------------|
| **SessionStart** | Every session begins | Auto-recalls top memories for current project + surfaces lesson warnings |
| **PostToolUse** | After `git commit` | Auto-tracks commit with diff stats as a memory entity |
| **Stop** | Session ends | Auto-captures session knowledge + runs LLM failure analysis → lessons |
| **PreCompact** | Before context compaction | Saves important knowledge before conversation history is compressed |

**You do NOT need to manually:**
- Recall at session start (hook does it)
- Remember commits (hook does it)
- Summarize sessions (hook does it)

**You DO need to manually** use the commands below for intentional knowledge management.

## When to Use

### Proactive triggers — do these WITHOUT being asked

| Situation | Action |
|-----------|--------|
| Design decision made | `memesh remember --name "auth-choice" --type decision --obs "Use OAuth 2.0 with PKCE" --tags "project:myapp"` |
| Bug fixed | `memesh learn --error "what broke" --fix "what fixed it" --root-cause "why" --severity major` |
| Pattern established | `memesh remember --name "validation-pattern" --type pattern --obs "Always use Zod"` |
| Starting work on a feature | `memesh recall "feature-name" --json` |
| User asks "what did we decide?" | `memesh recall "topic" --tag "project:myapp"` |
| Info is outdated | `memesh forget --name "old-decision"` |

### When NOT to remember
- Trivial implementation details (variable names, import paths)
- Anything that took < 5 minutes to decide
- Information already in the codebase (comments, README, config)

## Common Scenarios

### You just fixed a bug
```bash
memesh learn \
  --error "SIGSEGV when running vitest with threads" \
  --fix "Use pool: 'forks' instead of 'threads' for native modules" \
  --root-cause "better-sqlite3 native module is not thread-safe" \
  --prevention "Check if test framework supports native modules before choosing pool" \
  --severity major
```
This creates a `lesson_learned` entity. Lessons are surfaced as **proactive warnings** at next session start.

### You need context before working
```bash
memesh recall "authentication" --json
memesh recall --tag "project:myapp" --limit 10
memesh recall --cross-project                # search across all projects
```
Results are ranked by relevance, recency, frequency, confidence, and temporal validity.

### A decision was just made
```bash
memesh remember \
  --name "db-choice-2026" \
  --type decision \
  --obs "Use SQLite for local-first" "Rejected PostgreSQL due to deployment complexity" \
  --tags "project:myapp" "topic:database"
```
Types: `decision` `pattern` `lesson_learned` `bug_fix` `architecture` `convention` `feature` `best_practice` `concept` `tool` `note`

### Old info needs updating
```bash
memesh forget --name "old-auth-approach"                    # archive entire entity
memesh forget --name "auth-approach" --observation "Use JWT" # remove one fact only
```
Archives (soft-delete). Never permanently removes.

### Memories are getting verbose
```bash
memesh consolidate --name "entity-with-many-observations"
memesh consolidate --tag "project:myapp" --min-obs 5
```
Compresses observations using LLM. Requires Smart Mode configured.

### Backup or share memories
```bash
memesh export --tag "project:myapp" > memories.json
memesh import memories.json --merge skip    # skip | overwrite | append
```

### Check MeMesh health
```bash
memesh status                               # version, search level, embeddings
memesh config list                          # current configuration
```

### Regenerate embeddings after provider change
```bash
memesh reindex                              # rebuild all embeddings
memesh reindex --namespace personal         # reindex only one namespace
memesh reindex --json                       # structured progress output
```
Use this when you change embedding provider (e.g., Ollama → OpenAI) or dimension. The database auto-drops old embeddings on provider change, but you need to run `reindex` to regenerate them for existing memories.

## MCP-Only Features

These require MCP tools or the HTTP API (`memesh serve` + REST calls):

- **user_patterns** — Analyzes work patterns (schedule, tool preferences, strengths) from existing memories. Categories: `workSchedule`, `toolPreferences`, `strengths`, `focusAreas`.

## Best Practices

1. **Be specific** — "Use OAuth 2.0 with PKCE" not "auth stuff decided"
2. **Tag by project** — Always include `project:<name>` tag
3. **Use `--json`** — When you need to parse output programmatically
4. **Learn from every bug** — Every fix is a future warning. Use `learn`, not just `remember`.
5. **Don't over-remember** — Decisions that took > 5 minutes. Patterns worth preserving. Not trivia.
