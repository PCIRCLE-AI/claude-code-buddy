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

**Do not set `MEMESH_DB_PATH` when running the suite.** Pointing it at an
existing file makes `tests/hooks/session-start-telemetry.test.ts` fail: its
"short-circuits on a missing DB" case then has nothing to short-circuit on. An
isolated `HOME` is the right isolation; a fixed DB path is not.

Pool mode is `forks`, single fork, no file parallelism. That is not a
preference — several test files share one HOME and therefore one SQLite
database, and running them concurrently deadlocks on the write lock.

### Verifying a change before claiming it works

Do not report a test result, a CI status or a benchmark number you did not
produce in this session. Paste the runner's actual output. `npm run
verify:release` is the same gate the publish path runs; `bash
scripts/verify-docs-sync.sh` checks the doc contracts.

When you fix a bug, **revert the fix and confirm the test goes red.** A green
suite is not evidence that a fix is protected: three tests in this repository
have passed while the thing they guarded was removed.

### Git

- `main` (production) ← `develop` (development). Never commit directly to `main`.
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
