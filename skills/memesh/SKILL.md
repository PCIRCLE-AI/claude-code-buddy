---
name: memesh
description: Use MeMesh to remember, recall, and manage AI knowledge across sessions. Triggers when the user asks to remember something, recall past decisions, forget outdated info, learn from mistakes, or analyze work patterns. Also triggers when the user asks "what do you remember", "where did we leave off", or wants to catch up on a project; when a session starts and project context is needed; and proactively when you make important decisions, fix bugs, or learn lessons worth preserving.
user-invocable: true
---

# MeMesh — AI Memory Management

Persistent memory for AI agents. The point is continuity: the next session starts where this one stopped, instead of re-spending thousands of tokens re-discovering project state — and the human never has to re-explain it.

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

## The Loop

Four moments. Everything else in this file is detail.

## Durable messages and active-host delivery

Use the `message` tool when another local agent needs a durable, exact-recipient handoff rather than an inferred memory. `send`, `poll`, `fetch`, `intake`, `ack`, `disposition`, `activation`, and `receipts` are independent lifecycle actions: fetching or host acceptance never implies acknowledgement or workflow acceptance.

An active compatible managed host can receive a native push, which removes polling for that live delivery. One-time provider enablement and a MeMesh-managed Codex app-server, Claude Channel, or Gemini ACP session may be required; ordinary unattached sessions are presence-only/inbound-unavailable. Adapter imports and a live router socket do not prove host registration or `host_accept`. Do not promise that a stopped, missing, or replaced session will wake up: it is not resumed or silently rerouted. Use the stable principal for logical routing, and an exact session/generation only when delivery must not move to a replacement connection. Local owns durable storage and host-native delivery; Cloud relay, A2A, SSE, discovery, or fetch is not host delivery.

Durable audit does not mean unbounded silent growth. Owners can inspect it with `memesh message storage report --cutoff <ISO timestamp>`, preview bounded terminal-payload tombstones with `memesh message storage prune --cutoff <ISO timestamp>`, and explicitly add `--apply`. Never prune unresolved/offline-pending work. `MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES` is an optional owner policy; there is no default quota or automatic pruning.

**SESSION START → load the briefing (once).**
Call the `briefing` MCP tool or run `memesh briefing`. It returns the assembled
work topology: where the work was left off (goal / next / blocked / done),
decisions and direction, lessons not to repeat, what is known, recent activity.
One call is cheaper than re-exploring the repo to reconstruct the same picture.
Exception: under Claude Code the session-start hook has ALREADY injected this
exact block — do not call it again (see "What's Already Automatic").

**USER STATES a goal, next step, or blocker → record it immediately.**
```bash
memesh task --goal "Ship the work-topology injection" --next "Open the PR once CI is green"
memesh task --blocked "Waiting on the Windows runner"
memesh task --blocked ""      # blocker resolved — empty string clears the field
```
Fields: `--goal` `--next` `--blocked` `--done` (MCP tool: `task_state`).
Record ONLY what the user actually said. This state is injected at the top of
the next session and read as fact — a goal you guessed from which files were
edited reaches that session with nothing to correct it. If it was not said,
leave the field out.

**SESSION END or milestone → make the task state match reality.**
`memesh task` (no flags) shows exactly what the next session will be told.
If "next" is now done, record what is actually next; if the blocker cleared,
clear it.

**USER ASKS "what do you remember / where were we" → briefing, then relay.**
Run `memesh briefing` (or `--project <name>`) and answer from it. For specific
follow-up questions, use `recall`.

**MEMESH UNAVAILABLE or RECALL EMPTY → say so, never invent.** Report that
memory is unavailable (or found nothing) and continue without it. Never
fabricate a memory or cite a `[mem:id]` that was not actually returned.
Recall is bounded by `limit` — a small hit count is not a graph-wide count,
and an empty result is not proof nothing was stored: vary the wording or
narrow by tag before concluding. Every recall answer includes a `retrieval`
block — `truncated: true` means the window filled (more may exist);
`degraded: true` means semantic search could not run and these are
keyword-only results right now (`memesh doctor` explains why).

## What's Already Automatic (Claude Code Plugin Hooks)

If MeMesh is installed as a Claude Code plugin, these happen **without any action from you**:

| Hook | When | What it does |
|------|------|-------------|
| **SessionStart** | Every session begins | Injects the briefing: task state → lessons → project memories → recent activity |
| **PreToolUse (Edit/Write)** | Before editing files | Injects memories related to the file or project |
| **UserPromptSubmit** | When you submit a prompt | Detects "remember this" intent (5 languages) and reminds Claude to use memesh |
| **PostToolUse (Bash)** | After `git commit` | Auto-tracks the commit with diff stats as a memory entity |
| **Stop** | Session ends | Auto-captures session knowledge + runs LLM failure analysis → lessons |
| **PreCompact** | Before context compaction | Saves important knowledge before history is compressed |
| **PreToolUse (Bash)** | Before a command runs | Fires accepted lesson-guards — warns when a recorded mistake is about to repeat |

Because of the SessionStart hook: **in Claude Code, do NOT call `briefing` at
session start — it is already in your context.** Call it only mid-session
(context was compacted, or the user asks what you remember) or on hosts
without these hooks (other MCP clients, shell-only agents). Double-injection
spends the very tokens this system exists to save.

Hooks capture what *happened*. You still act manually for what they cannot
know: what the user **meant** (task state), deliberate decisions and lessons,
and retiring outdated info.

## Proactive triggers — do these WITHOUT being asked

| Situation | Action |
|-----------|--------|
| User states what they're working on / what's next / what's blocking | `memesh task --goal "…"` / `--next "…"` / `--blocked "…"` |
| Design decision made | `memesh remember --name "auth-choice" --type decision --obs "Use OAuth 2.0 with PKCE" --tags "project:myapp"` |
| Bug fixed | `memesh learn --error "what broke" --fix "what fixed it" --root-cause "why" --severity major` |
| Starting work on a feature | `memesh recall "feature-name" --json` |
| User asks "what did we decide?" | `memesh recall "topic" --tag "project:myapp"` |
| User asks "where did we leave off?" | `memesh briefing` → relay it |
| Info is outdated | New memory with `--supersedes "old-name"`, or `memesh forget` |
| Context about the user's work habits needed | `user_patterns` MCP tool (MCP/HTTP only — no CLI command) |

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
  --root-cause "the native module is not thread-safe" \
  --prevention "Check if the test framework supports native modules before choosing pool" \
  --severity major
```
Creates a `lesson_learned` entity. Lessons are surfaced as **proactive warnings** at the next session start.

### A decision was just made
```bash
memesh remember \
  --name "db-choice" --type decision \
  --title "SQLite for local-first storage" \
  --obs "Use SQLite for local-first" "Rejected PostgreSQL due to deployment complexity" \
  --tags "project:myapp" "topic:database"
```
Use a **stable name** (`db-choice`, not `db-choice-2026-08-16`): reusing the
name appends to the same entity instead of scattering duplicates. `--title` is
the human-readable headline; the name stays the machine key. If this replaces
an older decision, add `--supersedes "old-db-choice"`.
Types: `decision` `pattern` `lesson_learned` `bug_fix` `architecture` `convention` `feature` `best_practice` `concept` `tool` `note`

### You need context on a specific topic
```bash
memesh recall "authentication" --json
memesh recall --tag "project:myapp" --limit 10
memesh recall --cross-project                # search across all projects
```
Query words are OR-ed and ranked by relevance — a naturally phrased question
works; extra words narrow the ranking, not the result set.

### Old info needs updating
```bash
memesh forget --name "auth-approach" --observation "Use JWT"   # remove one fact only
memesh forget --name "old-auth-approach"                       # archive the whole entity
```
Both are soft (recoverable) — nothing is permanently removed.

### Memories are getting verbose or stale
Use the **memesh-review** skill: it analyzes health, finds stale, conflicting
and redundant memories, and proposes cleanup (including `memesh dream`, the
reviewed digest pipeline). Do not hand-compress memories yourself.

### Backup, share, health
```bash
memesh export --tag "project:myapp" > memories.json
memesh import memories.json --merge skip     # skip | overwrite | append
memesh status                                # version, search level, embeddings
memesh reindex                               # rebuild embeddings after provider change
```

## Memory hygiene

1. **Stable names append.** Remembering under an existing name adds
   observations and dedupes tags — it never replaces the entity. Reuse the
   name to grow one memory; do not mint `-v2` / dated variants of it.
2. **`supersedes` retires the loser.** When a new memory replaces an old one,
   record it with `--supersedes <old-name>` (MCP: a relation of type
   `supersedes`). The old entity is archived — recoverable, out of recall.
3. **`contradicts` flags real conflicts.** When two memories cannot both be
   true and neither is clearly wrong yet, link them with `--contradicts`
   (MCP: relation type `contradicts`). Both surface as a conflict on every
   recall until someone resolves it.
4. **Prefer observation-level forgetting.** `forget --observation "…"` removes
   one wrong fact and keeps the entity. Plain `forget` archives the whole
   entity out of visibility — use it only when everything in it is dead.
5. **Tag by project** (`project:<name>`) and **be specific** — "Use OAuth 2.0
   with PKCE", not "auth stuff decided".
