# memesh — Anthropic Marketplace Submission

**Plugin metadata:**

| Field | Value |
|---|---|
| Plugin name | `memesh` |
| Package | `@pcircle/memesh` |
| Version | 4.1.0-alpha.1 (in branch `feat/verification-gate-v2`); 4.0.4 published on npm |
| License | MIT |
| Homepage | https://github.com/PCIRCLE-AI/memesh-llm-memory |
| Author | PCIRCLE AI |
| Bin entries | `memesh` (CLI), `memesh-mcp` (MCP server), `memesh-http` (REST), `memesh-view` (dashboard) |
| Hooks file | `hooks/hooks.json` (6 registered hooks) |
| Skills | `skills/` (memesh, memesh-review, agentic-orchestration) |

---

## Hook (one paragraph)

memesh achieves **R@5 = 95.40% on LongMemEval-S** (500 questions, MIT-licensed dataset, dataset SHA256 `08d8dad4...`) using only SQLite + FTS5 — no vector index, no API key, no cloud round-trip. The full per-question JSON, raw inputs, dataset hash and reproduction script (10 commands, 10 seconds runtime on a laptop) are committed in branch `bench/longmemeval-public-r1` of the same repository. memesh is within 1.2pp of the vendor-reported MemPalace ceiling (96.6%) but ships as a 200KB SQLite file that runs entirely on the user's machine. Beyond the memory layer, memesh ships an operating-model skill — `agentic-orchestration` — that turns Claude Code into an orchestrator of background agents instead of a single-thread coding partner.

---

## Two differentiators

### 1. Verified retrieval quality, reproducible by anyone in 10 minutes

| Mode | Description | R@5 | R@10 | MRR | Elapsed |
|---|---|---|---|---|---|
| A | FTS5 only | **95.40%** | 97.60% | 0.8899 | 10s |
| B | FTS5 + ONNX MiniLM-L6 (max fusion) | **95.40%** | 97.60% | 0.8904 | ~25min |
| C | FTS5 + ONNX (60/40 weighted) | 82.40% | 96.40% | 0.3123 | ~13min |

Honest findings published with the data:
- Mode A and Mode B tie. Adding 384-dim ONNX vectors via max-fusion contributes zero additional top-5 hits over FTS5 alone. **Recommended production config: Mode A.**
- Mode C regresses 13pp because the haystack contains generic public Q&A distractor sessions (`ultrachat_*`, `sharegpt_*`) that score high on cosine similarity but are not personal memory. Documented as a known failure mode, not hidden.

vs. published numbers from the LongMemEval ICLR 2025 paper and vendor self-reports:

| System | R@5 | Source |
|---|---|---|
| MemPalace | 96.6% | Vendor self-report (architecture differs; uses reranker) |
| **memesh (Mode A)** | **95.40%** | This benchmark (linked) |
| Supermemory | ~82% | Vendor estimate |
| Zep | 63.8% | LongMemEval paper, arXiv:2410.10813 |
| Mem0 | 49.0% | Same paper |

Reproduction: `benchmarks/longmemeval/REPRODUCE.md` on `bench/longmemeval-public-r1` — install deps, fetch dataset (verify SHA256), run three modes. All raw per-question results are committed.

### 2. Ships an operating model, not just a memory store

The `agentic-orchestration` skill defines the working model that memesh activates inside Claude Code:

> **User = CTO / PM** — owns understanding, strategy, product taste.
> **Claude = Orchestrator / engineering manager** — routes work, dispatches agents, reviews diffs, surfaces decisions, never the bottleneck.
> **Background agents = engineering interns** — execute high-verifiability technical work in parallel.

The skill includes a **three-tier verifiability classifier** (Tier 1 machine / Tier 2 review / Tier 3 judgment), a **verifiability router** that decides foreground vs background dispatch, and a mandatory **post-agent verification gate** that runs deterministic git reality-check + typecheck + tests + cross-check before any agent's claim of "done" is accepted. The protocol is translated from Karpathy's *Software 3.0 / Agentic Engineering* talk (Sequoia AI Ascent 2026-04).

Six hooks keep the protocol active across sessions:

| Hook event | Script | Purpose |
|---|---|---|
| SessionStart | `session-start.js` | Smart memory recall + agentic-orchestration banner injection |
| PreToolUse (Edit/Write) | `pre-edit-recall.js` | Inject relevant memories before file edits |
| PreToolUse (Bash) | `pre-bash-orchestration-nudge.js` | Advisory: "consider dispatching as background agent" on verifiable commands |
| PostToolUse (Bash) | `post-commit.js` | Auto-capture commit + diff stats |
| Stop | `session-summary.js` | Session knowledge extraction + LLM failure analysis → structured lessons |
| PreCompact | `pre-compact.js` | Knowledge save before context compression |

---

## 9 MCP tools

| # | Tool | Purpose |
|---|---|---|
| 1 | `remember` | Store an entity with observations, tags, relations |
| 2 | `recall` | Multi-factor scored search (FTS5 + recency + frequency + impact) |
| 3 | `forget` | Soft-archive (never deletes); supports observation-level removal |
| 4 | `consolidate` | LLM-powered compression of verbose memories |
| 5 | `export` | Snapshot to portable JSON |
| 6 | `import` | Merge external snapshot (skip / overwrite / append) |
| 7 | `learn` | Record structured lessons (error → root cause → prevention) |
| 8 | `user_patterns` | Analyse work schedule, tool preferences, focus areas, strengths |
| 9 | `verify_agent_work` | Persist verification reports as `verification_record` entities |

The 9th tool is the verification ledger Karpathy describes — it records which dispatch shapes were reliable for the user's stack, so future agents are warned about known failure modes via the `lesson_learned` feedback loop.

---

## Privacy and security

- **Local-first.** Default storage is `~/.memesh/knowledge-graph.db`; no cloud round-trip required.
- **No API key required for core operation.** LLM features (consolidate, query expansion) are BYOK and opt-in.
- **No telemetry without explicit opt-in.** Version checks against npm registry only when the user runs `memesh update`.
- **WAL mode + foreign-key cascades.** Concurrent reads are safe; deleting an entity correctly cascades to observations, relations, tags.
- **Zod validation at every transport boundary** (MCP, HTTP, CLI).

---

## Install

```bash
npm install -g @pcircle/memesh
memesh doctor   # verifies environment + capabilities
```

Or as a Claude Code plugin (recommended):

```bash
# Drop the plugin folder into ~/.claude/plugins/, then in Claude Code:
/plugin install memesh
```

---

## What is NOT measured by the benchmark (honest caveats)

The published 95.40% R@5 deliberately tests only the retrieval layer — what gets returned from FTS5 given a question and a haystack. The full production pipeline includes additional features that the benchmark **deliberately disables** for an apples-to-apples comparison:

- Multi-factor scoring (recency, frequency, confidence, impact) — would likely raise R@5
- LLM query expansion (Smart Mode) — would likely raise R@5 further
- Cross-entity graph traversal — not exercised by session-level retrieval

The benchmark is a **conservative lower bound** on memesh's production retrieval quality. See `benchmarks/longmemeval/METHODOLOGY.md` §3 for the full list of disabled features and §6 for the Mode C regression analysis.

---

## Why now

Karpathy's Sequoia talk crystallised the gap that memesh fills: the bottleneck in agentic engineering isn't model capability, it's **verification throughput**. memesh ships both the memory substrate (a verified high-recall local store) and the protocol (`agentic-orchestration` skill + verification gate) that turns that substrate into an operating model for parallel agent work. Other plugins ship one or the other. memesh ships both, and both are measured.
