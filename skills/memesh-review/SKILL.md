---
name: memesh-review
description: Review and clean up the MeMesh memory database. Find stale, contradicting, or redundant memories and suggest cleanup actions. Use when asked to "review memories", "clean up knowledge", or "what's in my memory".
user-invocable: true
---

# MeMesh Memory Review

Review the memory database and provide actionable cleanup recommendations.

## Process

1. **Recall recent memories** — use `recall` with no query to see what's stored
2. **Check for staleness** — identify memories not accessed in 30+ days
3. **Check for conflicts** — look for `contradicts` relations or opposing observations
4. **Check for verbosity** — entities with 5+ observations that could be consolidated
5. **Report findings** with specific actions

## Steps

### Step 1: Load overview
```json
recall: {"limit": 50}
```

### Step 2: Analyze and report

Present findings in this format:

```
## Memory Review

### Summary
- Total memories recalled: N
- Active: N | Archived: N

### Stale (not accessed in 30+ days)
- "entity-name" — last observation: "..." — Suggest: archive or keep?

### Could be consolidated (5+ observations)
- "entity-name" (8 observations) — Suggest: run consolidate

### Potential conflicts
- "use-jwt" vs "no-jwt" — contradicting auth decisions

### Recommended actions
1. Archive "old-design" (superseded by "new-design")
2. Consolidate "auth-history" (12 observations → ~3)
3. Review conflict between "X" and "Y"
```

### Step 3: Execute approved actions

After presenting the report, ask the user which actions to execute. Then use `forget`, `consolidate`, or `remember` with `supersedes` accordingly.
