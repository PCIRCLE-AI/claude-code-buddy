# What each result file measures

Raw per-question output from `run.mjs`. **Two different things produced the files
in this directory**, and the difference is larger than any version-to-version
change.

## Files from 2026-07 onward — the shipped retrieval path

`run_info.measures` is `"shipped_recall_path"` and
`run_info.retrieval_entrypoint` names the function that produced them
(`dist/core/operations.js::recallEnhanced`). These are measurements of MeMesh.

- `mode-A-2026-07-28T21-36-54.json` — no embeddings. R@5 95.60%.
- `mode-B-2026-07-28T21-54-01.json` — embeddings populated. R@5 95.60%, byte-for-byte
  the same metrics as Mode A: the vector supplement contributes nothing while
  `MAX_VECTOR_DISTANCE = 1` discards hits that sqlite-vec returns at L2 distances
  of 1.2–1.4.

## Files from 2026-05 — an adapter reimplementation

`mode-A-2026-05-*.json`, `mode-B-2026-05-*.json`, `mode-C-2026-05-*.json`.

These have no `measures` field. They were produced when `run.mjs` carried its own
`CREATE TABLE`, its own FTS5 query construction and its own ranking, and they
measure that code — not the product. The two had drifted: the adapter OR-joined
query terms and ordered by BM25 `rank`, while the shipped `search()` AND-joined
and ordered by `e.id DESC`. On the same 500 questions the adapter scored 95.40%
R@5 and the shipped path scored 5.20%, with 473 of 500 questions returning
nothing.

They are kept unmodified because they are published evidence and deleting or
editing them would be worse than labelling them. Read them as a record of what
the adapter did, not as a statement about any version of MeMesh.

`mode-C-*` additionally measures a 60/40 weighted FTS+vector fusion that MeMesh
has never implemented.

See `../METHODOLOGY.md` §2 and CHANGELOG `[Unreleased]` / PR #78.
