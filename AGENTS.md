# Using MeMesh — for AI agents

MeMesh is persistent memory shared by every MCP host on this machine — one
SQLite database at `~/.memesh/knowledge-graph.db`. A memory stored from one
host is recallable from all of them. Not installed yet? Follow
[llms-install.md](llms-install.md).

## The loop that pays for itself

1. **Session start — load, don't re-explore.** Call the `briefing` tool once
   (CLI: `memesh briefing`). It returns the assembled work topology for the
   current project: goal / next / blocked / done, decisions, lessons,
   knowledge, recent activity. Read that instead of re-reading the repo to
   reconstruct context.
2. **When the user states a goal, a next step, or a blocker — record it.**
   Call the `task_state` tool (CLI: `memesh task --goal "…" --next "…"`). It
   is injected at the start of the next session and acted on as fact.
   - An empty string **clears** a field: pass `blocked: ""` (CLI:
     `memesh task --blocked ""`) once a blocker is resolved.
   - **Record only what the user actually said.** Never infer goal / next /
     done from files edited or commands run — a guessed value becomes a wrong
     instruction to a future session with nothing to contradict it. Leave a
     field out if it was not said.
3. **"What do you remember?"** — call `briefing` and relay its content. Do
   not answer from your own conversation context.

## All 9 MCP tools

| Tool | Purpose |
|---|---|
| `remember` | Store knowledge as an entity with observations, tags, and relations |
| `recall` | Search stored knowledge (words are OR-ed, ranked by relevance); empty query lists recent |
| `forget` | Archive an entity (soft-delete), or remove one observation via the `observation` parameter |
| `export` | Export memories as portable JSON for sharing or backup |
| `import` | Import a JSON export; `merge_strategy` (required): skip / append / overwrite |
| `learn` | Record a structured lesson: error, root cause, fix, prevention |
| `task_state` | Read or update where the work stands: goal / next / blocked / done |
| `briefing` | The assembled work topology for a project — call once at session start |
| `user_patterns` | Analyze work schedule, tool preferences, and focus areas from memory |

## Memory hygiene

- **Reuse a stable `name` to append.** Calling `remember` with an existing
  name appends observations and dedupes tags. A fresh name for every update
  creates duplicates that recall must wade through.
- **Replacing a decision**: `remember` the new one with a relation of type
  `supersedes` pointing at the old — the old entity is archived (recoverable),
  not left active to contradict the new one.
- **Two memories that cannot both be true**: relation type `contradicts` —
  both then surface as a conflict every time either is recalled.
- **One wrong fact in an otherwise good entity**: `forget` with the
  `observation` parameter removes just that fact and keeps the entity active.
  Prefer it over archiving the whole entity.

## What Claude Code already does — do not double-write

Under Claude Code with the MeMesh plugin, hooks capture automatically:

- **SessionStart** injects the work topology (the same block `briefing`
  returns) at the top of the session.
- **PreToolUse (Edit|Write)** surfaces memories related to the file being
  edited.
- **PostToolUse (Bash)** records git commits with diff stats.
- **Stop** captures session knowledge and turns failures into lessons.
- **PreCompact** saves important knowledge before history is compressed.
- **UserPromptSubmit** detects "remember this" intent in the prompt.

So under Claude Code: skip step 1 of the loop (the topology is already
injected), and do not `remember` commits or session summaries by hand. Manual
calls are for what hooks cannot see — decisions and their rationale, lessons
worth keeping, and user-stated task state.

Other hosts (Codex CLI, Gemini CLI, Cursor, …) have no hooks: there the loop
is fully manual, and it is worth running.

## Working on this repository (contributing agents)

The sections above are for agents whose user installed memesh. If you are an
agent making changes to this codebase, [CLAUDE.md](CLAUDE.md) is the entry
point; the policy it carries, compressed:

- **Blast radius picks the process.** One module, no security surface, no
  cross-surface behaviour → implement, run the affected tests + typecheck,
  read your own diff. Anything wider → the full gate (`npm run
  verify:release`), break-test the guards you add, docs in the same PR.
- **Findings first, with evidence.** Reviews and QA reports lead with what is
  wrong and prove it (file:line, actual output). Verdicts are `PASS`,
  `PASS_WITH_CONCERNS`, or `FAIL` — the same vocabulary `memesh doctor` uses.
- **No runtime claim without runtime evidence.** Paste the runner's output;
  read exit codes, not grepped fragments.
- **Delegation is disjoint.** Two writers never touch one file; file-editing
  subagents work in isolated worktrees and never commit or push — the
  orchestrator reads every diff before it lands.
- **Internal notes stay local.** Plans and scratch analyses are never
  committed and never appear in commit messages or release notes.
