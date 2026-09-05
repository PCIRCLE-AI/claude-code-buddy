# MeMesh — instructions for AI coding assistants

This file is a **pointer**, on purpose. It used to carry its own copy of the
module tree, the dependency list and the development standards, and a copy is a
thing that drifts. It was the last file in the repository still quoting a
benchmark figure (95.40% R@5) that release 4.2.11 was spent proving wrong, and
its test count was 44 behind. It was also untracked, so no reviewer ever saw it
change. Both problems had one cause: it duplicated documents that already
exist, are already public, and are already checked by CI.

So — **read the real documents.** Do not restate them here.

| Question | Read |
|---|---|
| How do I contribute, what must a PR include, which docs move with a code change | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What are the modules, how does data flow, why is it built this way | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| What is the MCP / HTTP / CLI surface, exactly | [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md) |
| What does the product do, how is it installed | [README.md](README.md) |
| Colour, type, spacing, interaction — before ANY dashboard change | [DESIGN.md](DESIGN.md) |
| How do I report a vulnerability | [SECURITY.md](SECURITY.md) |
| I am an agent INSTALLING memesh for a user | [llms-install.md](llms-install.md) |
| I am an agent USING memesh (the loop, the 11 tools, hygiene) | [AGENTS.md](AGENTS.md) |
| What changed, and what is merged but unreleased | [CHANGELOG.md](CHANGELOG.md) (`[Unreleased]`) |

---

## The few things that live only here

Everything below is either non-obvious from the code or specific to working
with an assistant. If anything here starts duplicating a document above, delete
it here and link instead.

### Running the tests

```bash
node scripts/run-tests-isolated.mjs        # whole suite, against a throwaway HOME
npm test -- --run                          # vitest directly — uses YOUR ~/.memesh
```

Prefer the first. The suite writes to `~/.memesh`, so running vitest directly
mutates your real knowledge graph.

**Do not set `MEMESH_DB_PATH` when running the suite.** Several hook tests
exercise the "no database yet" branches, and pointing the env var at an
existing file makes those branches unreachable. An isolated `HOME` is the
right isolation; a fixed DB path is not.

Pool mode is `forks`, one worker, no file parallelism. That is not a
preference — several test files share one HOME and therefore one SQLite
database, and running them concurrently deadlocks on the write lock. It is
expressed as `maxWorkers: 1` + `fileParallelism: false`; the older
`singleFork`/`maxForks`/`minForks` keys do not exist in Vitest 4 and were being
silently ignored.

`npm run typecheck` uses `tsconfig.check.json`, which covers `src/`, `tests/`
and the root config files. `tsconfig.json` is narrower on purpose — it is the
config that emits `dist/`.

### Coverage, and what a 0% file means

```bash
npm run test:coverage        # whole suite + v8 coverage, throwaway HOME
```

Read the report with one caveat, or it will mislead you. Coverage is measured
**in-process**, and this project spawns a lot of what it tests: the CLI, the
hooks, the MCP server and the packaged binaries are exercised through
`spawnSync`, so they report **0% while being well tested**.
`src/transports/cli/cli.ts` is the clearest case — a whole directory of tests
against it, 0% in the report.

What the number is good for is the opposite direction: a file at 0% that is
*not* spawned anywhere is genuinely unexercised. That is where most of the
dashboard sits. Do not write the count down here — this file has already been
wrong about it once, and `tests/dashboard/component-contracts.test.tsx` derives
the real list from the directory and fails when a component belongs to neither
side of it.

### Verifying a change before claiming it works

Do not report a test result, a CI status or a benchmark number you did not
produce in this session. Paste the runner's actual output. `npm run verify:release` is the same gate the publish path runs, and
`scripts/check-doc-claims.mjs` — which it calls — checks selected source-derived
documentation claims. Other descriptions still need source-backed review.

**Read the exit code, not a grep of the output.** `cmd 2>&1 | grep …` returns
*grep's* status and hides every line the pattern misses. Vitest prints
`Errors  N errors` for unhandled rejections *while reporting every test as
passed*, and exits 1 — a branch was pushed as green that way, and CI went
eight-red on it. Capture the verdict first, then look at detail:

```bash
node scripts/run-tests-isolated.mjs > /tmp/t.log 2>&1; echo "exit=$?"
grep -E 'Test Files|Tests |Errors ' /tmp/t.log
```

When you fix a bug, **revert the fix and confirm the test goes red.** A green
suite is not evidence that a fix is protected: three tests in this repository
have passed while the thing they guarded was removed.

### The graph is the product — check the data, not only the diff

v4.8.2 was reviewed seven times before release (two whole-diff reviews, a
security review, a replay review, a contract review, a loop-closure pass and
a guard sweep). Dogfooding then found three memory-layer defects that every
one of them had missed — #240, #241, #242 — because all seven reviewed the
DIFF, and the defects sat in code the release never touched. A diff review
cannot find a defect in code the diff does not contain, at any coverage.

Each of those defects is a one-line SQL question against the knowledge graph.

```bash
npm run audit:memory                       # your ~/.memesh, read-only
node scripts/audit/memory-invariants.mjs --db <path>
```

Exit 1 on a violation, with the offending entities named. It is deliberately
NOT in `verify:release` (a real graph is per-machine state; the release gate
must reproduce on a fresh clone). Run it before declaring any release
verified, and whenever a memory-layer fix lands — a fix without an invariant
here can regress silently, because this file is the only place that watches
the data itself. `tests/audit/memory-invariants.test.ts` seeds each defect
into a throwaway graph and requires exit 1, so a detector that stops
detecting goes red.

Two more rules from the same night, both measured:

- **Every independent reviewer gets the same whole diff and Bash.** Of the
  seven, five were scoped by the orchestrator — one excluded a directory,
  one replayed commands without reading code, one read four files, one
  probed one pair, one was void because its probe hit the real database. A
  specialist angle narrows the QUESTIONS asked, never the FILES given.
- **Any probe that runs vitest goes through `scripts/run-tests-isolated.mjs`
  and `--maxWorkers=1`.** An `eg prove --all` sweep of 47 guards ran for 53
  minutes and produced zero valid verdicts: the bare `npx vitest` probe hit
  the real graph (1536-dim embeddings vs 384-dim fixtures) and was red on
  the unmodified tree. Whole-tree `eg prove` is also not a release gate:
  781 guards × ~113 s per isolated run is a day. Probe the guards in the
  files a change touched, with the test file that covers each.

### Working policy

How much process a change deserves is decided by its blast radius, not by
habit. Two modes:

- **Lightweight** — the change is confined to one module or one clear path,
  needs no multi-surface verification, and touches nothing security-sensitive
  or destructive. Do it directly: implement, run the affected tests plus
  `npm run typecheck`, read your own diff, done. Most fixes are this.
- **Full** — anything that changes behaviour across surfaces (hook + MCP +
  CLI + docs move together here), touches persistence, security boundaries,
  or user-facing contracts. Then: understand → plan → implement with tests →
  the full gate (`verify:release`) → break-test the guards you added
  (revert the fix, watch the test go red) → docs in the same PR.

Rules that hold in both modes:

- **Findings first, evidence over warnings.** A review or QA report leads
  with what is wrong and proves it (file:line, actual output), not with
  broad concerns. Gate verdicts use the same vocabulary `memesh doctor`
  uses: `PASS`, `PASS_WITH_CONCERNS`, `FAIL`.
- **No runtime claim without runtime evidence.** "It works" requires having
  run it — the verification section above is the how.
- **Delegating to subagents**: split ownership into disjoint file scopes so
  two writers never touch one file; isolate file-editing agents in
  worktrees; the orchestrator reads every diff before it lands. Do not
  delegate the critical path reflexively — coordination has a cost.
- **Internal working notes stay local.** Plans, scratch analyses, agent
  transcripts, private TODOs — never committed, never in commit messages or
  release notes. The repository carries only what reproduces shipped
  behaviour: source, tests, schemas, configuration, and the public docs
  above. (This is also why this file is a pointer.)
- **Docs move with the change** — a capability the docs do not describe, or
  describe wrongly, fails `check-doc-claims` and is not done.

### Git

- **Short-lived branch → PR → `main`. Never push directly to `main`.** That is
  the whole flow, and `main` is the only long-lived branch. This used to read
  "`main` ← `develop`", which described git-flow: a model for software with
  several release lines under support at once, and one whose own author now
  warns against using it for continuously delivered projects. Nothing here has
  release lines, and the branch proved it — `develop` sat 58 commits behind
  `main` and 0 ahead, through four releases, while every PR went straight to
  `main`. It was kept briefly as a passive mirror and then deleted: a branch
  that only ever receives a copy of `main` answers no question that a tag or
  `CHANGELOG.md` does not already answer, and it cost a full matrix re-run on
  every sync.
- Releases are tags on `main`. "Merged but not yet published" is answered by
  `CHANGELOG.md`'s `[Unreleased]` section, which is why a branch does not need
  to answer it.
- Commit format: `<type>(<scope>): <subject>`
- **No AI attribution.** Commit messages and PR descriptions must not contain
  `Co-Authored-By: Claude`, `🤖 Generated with [Claude Code]`, or any text
  crediting an AI as author or generator. Strip it from any default template.
- Never `git add -A` or `git add .` — stage the files you meant to change.

### Two storage facts worth knowing before you touch persistence

- `entities_fts` is a **contentless** FTS5 table. A delete must be issued with
  the exact text that was indexed, or the index silently keeps the old tokens
  and search answers for content that is gone.
- `entities_vec` is one sqlite-vec table for the **whole database**, not one per
  namespace. Dropping it drops every namespace's embeddings, and only a full
  re-embed brings them back — on a paid provider, at cost.
