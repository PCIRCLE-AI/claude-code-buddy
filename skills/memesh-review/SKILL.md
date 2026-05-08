---
name: memesh-review
description: Review and optimize the MeMesh memory database. Analyzes health score, finds stale/conflicting/redundant memories, shows work patterns, and suggests cleanup actions. Use when asked to "review memories", "check memory health", "clean up knowledge", or "what's in my memory".
user-invocable: true
---

# MeMesh Memory Review

Review the memory database and provide actionable cleanup recommendations.

## How to Access

Use CLI (works everywhere) or MCP tools (if available). See the `memesh` skill for auto-detect instructions.

## Process

### Step 1: Gather data

```bash
# Get system health
memesh status

# Get all recent memories (structured output for analysis)
memesh recall --limit 50 --json

# Get memories by type for quality analysis
memesh recall --tag "type:decision" --json
memesh recall --tag "type:lesson_learned" --json
memesh recall --tag "type:session_keypoint" --json
```

If MCP `user_patterns` tool is available, also run it for work pattern analysis:
```json
user_patterns: {}
```

### Step 2: Analyze and report

From the recalled data, compute and present:

```markdown
## Memory Health Report

### Overview
- Total entities: N
- Last 30 days active: N (N%)
- Knowledge types: N decisions, N patterns, N lessons, N auto-tracked

### Health Score: N/100
- Activity: N% (accessed in last 30 days)
- Quality: N% (high confidence, well-tagged)
- Freshness: N% (new this week)
- Self-Improvement: N% (lessons learned ratio)

### Quality Issues Found

**Stale (not accessed 30+ days, low confidence)**
- "entity-name" — confidence: N% — Suggest: archive?

**Verbose (5+ observations, needs consolidation)**
- "entity-name" (N observations) — Suggest: `memesh consolidate --name "entity-name"`

**Potential conflicts**
- "entity-A" vs "entity-B" — contradicting decisions

**Noise ratio**
- N% auto-tracked (session_keypoint, commit) vs N% intentional knowledge
- If noise > 80%: recommend more deliberate `memesh remember` usage

### Recommended Actions
1. `memesh forget --name "old-design"` (superseded)
2. `memesh consolidate --name "auth-history"` (12 obs → ~3)
3. `memesh remember ...` (knowledge gap in [area])
```

### Step 3: Execute approved actions

Present the report first. Ask which actions to execute. Then run the commands:

```bash
memesh forget --name "outdated-entity"
memesh consolidate --name "verbose-entity"
memesh remember --name "missing-knowledge" --type decision --obs "..."
```

### Step 4: Verify

```bash
memesh recall --limit 5 --json    # confirm changes took effect
```

## Documentation Synchronization Check (PR/Merge Time)

**When**: Before ANY PR merge or major feature commit  
**Why**: Prevent documentation drift (code changes without doc updates)

### Mandatory Checklist

```bash
# 1. Version consistency
□ docs/ARCHITECTURE.md version matches package.json?
□ docs/api/API_REFERENCE.md version matches package.json?

# 2. Feature descriptions
□ skills/*.md describe current functionality?
□ README.md mentions new features/changes?
□ README.*.md (i18n variants) synchronized?

# 3. Deprecated terms cleanup
□ grep -r "old-term" docs/ skills/ README*.md
  (check for removed features, renamed concepts)

# 4. Structural consistency
□ Hook count matches? (scripts/hooks/*.js vs docs/ARCHITECTURE.md table)
□ MCP tool count matches? (src/transports/mcp/handlers.ts TOOL_DEFINITIONS vs API_REFERENCE.md)

# 5. Breaking changes
□ CHANGELOG.md updated for breaking changes?
□ Migration guide provided if needed?
```

### How to Execute

```bash
# Quick verification script
grep -h "Version:" docs/ARCHITECTURE.md docs/api/API_REFERENCE.md package.json
ls -1 scripts/hooks/*.js | wc -l  # should match docs count
grep "dual" docs/ skills/ README.md  # should find none (or only valid uses)
```

---

## Tips

- Run every 1-2 weeks to keep memory healthy
- Health score < 50 → too many stale or low-quality memories
- Noise > 80% → encourage deliberate `memesh remember` for decisions
- Dashboard available at: http://localhost:3737/dashboard (run `memesh serve` first)
- **Before merge**: Run documentation sync checklist above to prevent drift
