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
4. **When you need another agent** — to hand off, to ask, to report back —
   first use `message discover` with the exact project when you do not already
   know the recipient. It lists only live registrations and their routing IDs,
   host kind, declared model/current work, generation, and lease; missing
   declarations remain unknown. Then send a `message`. The host's own push tool (Claude
   Code's `SendMessage`, a Codex queue) delivers a wakeup; it is not the
   record, and it cannot reach an agent on a different host or one that is
   not running. Generic `briefing` and SessionStart context has no recipient
   identity and stays quiet. Check an inbox with the exact `project` and
   `recipient`; poll first, then fetch each returned `message_id`. Fetching
   does not acknowledge.

## All 11 MCP tools

| Tool | Purpose |
|---|---|
| `remember` | Store knowledge as an entity with observations, tags, and relations |
| `recall` | Search stored knowledge (words are OR-ed, ranked by relevance); empty query lists recent |
| `forget` | Archive an entity (soft-delete), or remove one observation via the `observation` parameter |
| `export` | Export memories as portable JSON for sharing or backup |
| `import` | Import a JSON export; `merge_strategy` (required): skip / append / overwrite |
| `learn` | Record a structured lesson: error, root cause, fix, prevention |
| `task_state` | Read or update where the work stands: goal / next / blocked / done |
| `briefing` | The assembled work topology; exact `project` + `recipient` can surface only that recipient's unfetched deliveries |
| `user_patterns` | Analyze work schedule, tool preferences, and focus areas from memory |
| `improvement` | Propose an evidence-linked product improvement or read its status; only a human may accept/reject it |
| `message` | Discover live agents, then exchange exact-recipient untrusted messages: durable JSON payload max 64 KiB; complete native envelope max 16 KiB; delivery reads/acceptance never imply ACK or disposition |

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

## What you must never invent

- If MeMesh is unavailable or a recall returns nothing, **say so and work
  without it** — never fabricate a memory, and never cite a `[mem:id]`
  handle that was not actually shown to you. A wrong "remembered" fact is
  worse than no memory: it arrives wearing the authority of the graph.
- Recall windows are bounded (the `limit` parameter, 30 by default), so do
  not infer graph-wide counts or "there is no memory about X" from the
  number of hits one query returns. Absence of results is absence of
  results, not evidence of absence — vary the wording or narrow by tag
  before concluding anything.
- Every recall answer carries a `retrieval` block that says how it was
  produced — read it instead of guessing: `truncated: true` means the
  window filled and more may exist; `degraded: true` means semantic search
  is configured but could not run, so you are seeing keyword-only results
  right now (worth telling the user, and `memesh doctor` explains why).

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
- **PreToolUse (Bash)** fires accepted lesson-guards: a fenced warning
  citing the source lesson (`[mem:id]`) when a command matches a mistake
  the graph has recorded. Heed it, and cite the lesson if it changes what
  you do.

So under Claude Code: skip step 1 of the loop (the topology is already
injected), and do not `remember` commits or session summaries by hand. Manual
calls are for what hooks cannot see — decisions and their rationale, lessons
worth keeping, and user-stated task state.

On a host with no hooks (Gemini CLI, Cursor, an MCP-only setup, …) the loop is
fully manual, and it is worth running.

Codex CLI can be either. Wired as an MCP server it has no hooks, like the
above. Installed as a plugin (`codex plugin add memesh@pcircle-memesh`) it
reads the same `hooks/hooks.json` manifest Claude Code does and runs the same
hook scripts, so the topology is injected for you there too. If you are unsure
which one you are in, `memesh doctor` names it: the "Hooks wired into Claude
Code" row says which plugin runtime it found.

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
