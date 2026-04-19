---
name: memesh-review
description: Review and optimize the MeMesh memory database. Analyzes health score, finds stale/conflicting/redundant memories, shows work patterns, and suggests cleanup actions. Use when asked to "review memories", "check memory health", "clean up knowledge", or "what's in my memory".
user-invocable: true
---

# MeMesh Memory Review

Review the memory database with data-driven insights and actionable cleanup recommendations.

## Process

### Step 1: Get the big picture

Use `user_patterns` to understand the memory database at a high level:
```json
user_patterns: {}
```

This returns: health score, work schedule, tool preferences, focus areas, strengths, and learning areas.

### Step 2: Recall recent memories for detail

```json
recall: {"limit": 50}
```

### Step 3: Analyze and report

Present findings in this format:

```markdown
## Memory Health Report

### Health Score: N/100
- Activity: N% (memories accessed in last 30 days)
- Quality: N% (memories with high confidence)
- Freshness: N% (new memories this week)
- Self-Improvement: N% (lessons learned)

### Your Work Patterns
- Peak hours: HH:MM, HH:MM
- Top tools: Tool1, Tool2, Tool3
- Focus areas: type1, type2
- Strengths: area1 (N%), area2 (N%)
- Learning areas: topic1, topic2

### Memory Quality Issues

**Stale (not accessed in 30+ days, low confidence)**
- "entity-name" — confidence: N% — Suggest: archive?

**Could be consolidated (5+ observations)**
- "entity-name" (N observations) — Suggest: run consolidate

**Potential conflicts**
- "entity-A" vs "entity-B" — contradicting decisions

**Auto-generated noise**
- N% of memories are auto-tracked (session_keypoint, commit)
- N memories are intentional knowledge (decisions, patterns, lessons)
- Recommendation: use `remember` more for architecture decisions

### Recommended Actions
1. Archive "old-design" (superseded by "new-design")
2. Consolidate "auth-history" (12 observations → ~3)
3. Review conflict between "X" and "Y"
4. Consider recording more [type] memories (knowledge gap)

### Dashboard
View your full analytics at: http://localhost:3737/dashboard → Analytics tab
```

### Step 4: Execute approved actions

After presenting the report, ask the user which actions to execute. Then use `forget`, `consolidate`, `remember`, or `learn` accordingly.

## Tips

- Run this review every 1-2 weeks to keep the memory database healthy
- A health score below 50 means too many stale or low-quality memories
- If 90%+ of memories are auto-generated, encourage the user to `remember` decisions deliberately
- Use `learn` to convert ad-hoc bug fixes into structured lessons
