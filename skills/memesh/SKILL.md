---
name: memesh
description: Use MeMesh to remember, recall, and manage AI knowledge across sessions. Triggers when the user asks to remember something, recall past decisions, forget outdated info, learn from mistakes, or analyze work patterns. Also triggers proactively when you make important decisions, fix bugs, or learn lessons worth preserving.
user-invocable: true
---

# MeMesh — AI Memory Management

You have access to MeMesh, a persistent memory layer with 8 tools. Use them to remember important knowledge across sessions.

## When to Use (Proactive)

**Remember automatically when:**
- A design decision is made ("let's use OAuth" → remember it)
- A bug is fixed (root cause + fix → remember as lesson)
- A pattern is established ("we always use Zod for validation" → remember as pattern)
- Architecture changes ("moved from monolith to microservices" → remember)
- The user explicitly says "remember this" or "don't forget"

**Learn automatically when:**
- An error is encountered and fixed → use `learn` to record the lesson
- A debugging session reveals a non-obvious root cause
- A workaround is needed → record why so it can be fixed properly later

**Recall automatically when:**
- Starting work on a feature that might have prior decisions
- The user asks "what did we decide about X?"
- You need context about a project's conventions

**Analyze patterns when:**
- Starting a new session → use `user_patterns` to understand the user's work style
- The user asks about their habits, strengths, or areas to improve

**Forget when:**
- A decision is superseded by a new one (use `supersedes` relation)
- The user says "forget about X" or "that's outdated"

## Tools Reference

### remember
```json
{
  "name": "auth-decision",
  "type": "decision",
  "observations": ["Use OAuth 2.0 with PKCE for authentication"],
  "tags": ["project:myapp", "topic:auth"],
  "relations": [{"to": "old-auth", "type": "supersedes"}],
  "namespace": "personal"
}
```
Types: `decision`, `pattern`, `lesson_learned`, `bug_fix`, `architecture`, `convention`, `feature`, `best_practice`, `concept`, `tool`, `note`
Namespaces: `personal` (default), `team`, `global`

### recall
```json
{"query": "authentication", "tag": "project:myapp", "limit": 10}
```
Omit query to list recent memories. Results are ranked by relevance, recency, frequency, confidence, and temporal validity.

### forget
```json
{"name": "outdated-design"}
```
Archives the entity (soft-delete, never permanently removes). Add `"observation": "specific text"` to remove just one fact.

### consolidate
```json
{"name": "auth-history", "min_observations": 5}
```
Compresses verbose memories using LLM. Requires Smart Mode configured.

### learn
```json
{
  "error": "SIGSEGV when running vitest with threads",
  "fix": "Use pool: 'forks' instead of 'threads' for native modules",
  "root_cause": "better-sqlite3 native module is not thread-safe",
  "prevention": "Always check if a test framework supports native modules before choosing pool mode",
  "severity": "major",
  "project": "memesh"
}
```
Records a structured lesson from a mistake or discovery. Creates a `lesson_learned` entity. Lessons are surfaced as proactive warnings at session start.

### user_patterns
```json
{"categories": ["workSchedule", "toolPreferences", "strengths"]}
```
Analyzes your work patterns from existing memories. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics, knowledge strengths, and learning areas. Omit categories for all.

### export / import
```json
{"tag": "project:myapp"}
```
Export memories as JSON for sharing. Import with merge strategies: `skip`, `overwrite`, `append`.

## Best Practices

1. **Be specific** — "Use OAuth 2.0 with PKCE" not "auth stuff decided"
2. **Tag by project** — Always include `project:<name>` tag
3. **Use relations** — Link related decisions with `related_to`, replace old ones with `supersedes`
4. **Type correctly** — Use the right type for better search and analytics
5. **Don't over-remember** — Skip trivial things. Remember decisions that took > 5 minutes to make.
6. **Use learn for mistakes** — Every bug fix is a learning opportunity. Record it so the AI warns you next time.
7. **Check patterns** — Use `user_patterns` at session start to adapt to the user's work style
