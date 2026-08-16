# CODEMAP

**Version**: 4.2.8

A navigation map for the codebase: *"I want to change X — which file?"* For the
design rationale behind these modules see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
for the public API surface see [`docs/api/API_REFERENCE.md`](docs/api/API_REFERENCE.md).

---

## Start here (entry points)

| You run… | Entry point |
|---|---|
| `memesh <cmd>` (CLI) | `src/transports/cli/cli.ts` |
| `memesh-mcp` (MCP stdio server) | `src/mcp/server.ts` → `src/transports/mcp/handlers.ts` |
| `memesh serve` (HTTP REST) | `src/transports/http/server.ts` |
| `memesh` (dashboard) | `dashboard/src/App.tsx` (served from `dashboard/dist/index.html`) |
| Claude Code hooks | `scripts/hooks/*.js` (wired in `hooks/hooks.json`) |

All three transports are thin adapters over the same core: `src/core/operations.ts`.

---

## Directory map

```
src/
├── core/            # framework-agnostic business logic (zero transport deps)
├── db.ts            # SQLite + FTS5 + sqlite-vec + migrations + auto-decay
├── knowledge-graph.ts  # Entity CRUD, relations, FTS5 search, access tracking
├── storage/         # conflicts.ts (detection) + fts-index.ts (contentless-FTS5 primitives)
├── transports/      # cli/ · http/ · mcp/ (+ schemas.ts = shared Zod validation)
├── mcp/             # stdio server (NOTE: server lives here, handlers in transports/mcp/)
└── cli/             # view.ts + view-live.ts (dashboard fallback, NOT a transport)
scripts/hooks/       # 7 Claude Code hooks + _shared.js (mirror of paths.ts, F5 boundary)
dashboard/src/       # Preact + Vite dashboard (5 tabs)
tests/               # vitest (forks pool) — mirrors src/ layout
benchmarks/longmemeval/  # public LongMemEval-S evidence (REPRODUCE.md)
docs/                # ARCHITECTURE.md, api/API_REFERENCE.md
```

---

## Feature → file index

### Recall / search (the LLM-free hot path)
- Ranking / scoring weights → `src/core/scoring.ts` (`rankEntities`)
- FTS5 + sqlite-vec query, access tracking → `src/knowledge-graph.ts`
- Recall operation (cross_project / namespace / include_archived) → `src/core/operations.ts` (`recallEnhanced`)
- Vector index / embedding dimension / migration → `src/db.ts`, `src/core/embedder.ts`

### Write flows (remember / forget / learn / pin)
- remember / forget / learn / **setPinned** → `src/core/operations.ts`
- Structured lessons → `src/core/lesson-engine.ts`, `src/core/failure-analyzer.ts`
- Auto-tagging (LLM) → `src/core/auto-tagger.ts`

### Embeddings
- Provider dispatch (Ollama / OpenAI) + graceful keyword-only fallback → `src/core/embedder.ts`
- No local model: semantic search needs Ollama (nomic-embed-text, 768-dim) or OpenAI (1536-dim); with none, recall is FTS5 keyword-only

### LLM (write-side Smart Mode only — never on the recall hot path)
- Single dispatch + cross-provider failover + secret redaction → `src/core/llm-client.ts`
- Fallback chain (`llmFallbacks`): ordered providers tried when the primary is down → defined in `src/core/config.ts`, consumed by `src/core/llm-client.ts`
- Per-attempt telemetry (`by_model` / `by_project` / `sample_errors`) → `src/core/llm-telemetry.ts`
- Provider/model capability probe → `src/core/llm-validator.ts`
- Prompt-injection hardening → `src/core/prompt-safety.ts`

### Dream (LLM cluster compaction + pattern detection)
- Compactor + pattern detector (propose/accept/reject) → `src/core/dreamer.ts`
- Transcript mining (`dream run --from-transcripts`): find a project's session JSONL → mine conversational memory → sanitise → vector-dedup → stage proposals → `src/core/transcript-source.ts` + `src/core/transcript-extractor.ts`
- `metadata.pin === true` protection is honored here (set via `memesh pin`)
- Second-pass digest cross-check → `src/core/digest-validator.ts`

### Project identity + tags
- `getProjectName()` (git-remote-slug → repo-root → cwd-basename, cached) → `src/core/paths.ts`
  (mirrored in `scripts/hooks/_shared.js` — F5 boundary; kept in sync by `tests/core/project-identity.test.ts`)
- List / merge / rename `project:*` tags → `src/core/project-tags.ts` (backs `memesh kg rename-project`)
- Heuristic relation backfill (orphan connector) → `src/core/kg-backfill.ts`

### Config / capabilities / self-update
- Config read/write + capability detection + env auto-detect → `src/core/config.ts`
- Path resolution (HOME-first) → `src/core/paths.ts`
- `memesh doctor` health check + real probes → `src/core/doctor.ts`
- npm version check / self-update → `src/core/version-check.ts`, `src/core/updater.ts`, `src/core/install-channel.ts`, `src/core/install-hooks.ts`

### Dashboard (Preact)
- Tab routing → `dashboard/src/App.tsx`
- Analytics / telemetry / insights panels → `dashboard/src/components/`
- Read-only aggregation endpoints → `src/core/analytics.ts`, `stats.ts`, `graph.ts`, `projects.ts`, `patterns.ts`
- i18n (11 locales) → `dashboard/src/lib/i18n.ts`

### Hooks (Claude Code integration — `scripts/hooks/`)
| Hook | Fires on | Does |
|---|---|---|
| `session-start.js` | SessionStart | inject top-N memories (additionalContext), banner, lesson warnings, auto-update |
| `pre-edit-recall.js` | PreToolUse Edit/Write | inject file-relevant memories |
| `session-summary.js` | Stop | auto-capture, LLM failure analysis, dream auto-trigger |
| `pre-compact.js` | PreCompact | end-of-context save |
| `post-commit.js` | PostToolUse Bash | git commit tracking |
| `user-prompt-intent.js` | UserPromptSubmit | detect "remember" intent |
| `_shared.js` | — | shared helpers (NOT a hook); `importFromPluginRoot`, `getProjectName` mirror, `captureEntity` (single owner of the hook write dance incl. FTS reindex) |

---

## Request path (a `recall` call, any transport)

```
transport (cli/http/mcp) → validate (transports/schemas.ts, Zod)
  → operations.recallEnhanced()
    → knowledge-graph FTS5 + sqlite-vec  → scoring.rankEntities()
      → conflict detection (storage/conflicts.ts) → result
```

The same `operations.ts` function runs identically from all three transports.

---

## Tests & docs

- Tests: `tests/` mirrors `src/`. Run `npm test -- --run` (pool: forks, not threads — native modules).
  Cross-hook contract gate: `tests/hooks/hook-output-contract.test.ts` (validates every hook's stdout against the real Claude Code contract).
- Version anchors that must agree on a bump: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md` header, `docs/ARCHITECTURE.md`, `docs/api/API_REFERENCE.md` (see the version-bump contract in the project instructions). Run `npm run build` after to regenerate `dist/skills-manifest.json`.
