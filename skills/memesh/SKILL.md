---
name: memesh
description: Use MeMesh to remember, recall, and manage AI knowledge across sessions. Triggers when the user asks to remember something, recall past decisions, forget outdated info, or manage their memory. Also triggers proactively when you make important decisions, fix bugs, or learn lessons worth preserving.
user-invocable: true
---

# MeMesh — AI Memory Management

You have access to MeMesh, a persistent memory layer with 6 tools. Use them to remember important knowledge across sessions.

## When to Use (Proactive)

**Remember automatically when:**
- A design decision is made ("let's use OAuth" → remember it)
- A bug is fixed (root cause + fix → remember as lesson)
- A pattern is established ("we always use Zod for validation" → remember as pattern)
- Architecture changes ("moved from monolith to microservices" → remember)
- The user explicitly says "remember this" or "don't forget"

**Recall automatically when:**
- Starting work on a feature that might have prior decisions
- The user asks "what did we decide about X?"
- You need context about a project's conventions

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
  "relations": [{"to": "old-auth", "type": "supersedes"}]
}
```
Types: `decision`, `pattern`, `lesson`, `bug_fix`, `architecture`, `convention`

### recall
```json
{"query": "authentication", "tag": "project:myapp", "limit": 10}
```
Omit query to list recent memories. Results are ranked by relevance, recency, and access frequency.

### forget
```json
{"name": "outdated-design"}
```
Archives the entity (soft-delete). Add `"observation": "specific text"` to remove just one fact.

### consolidate
```json
{"name": "auth-history", "min_observations": 5}
```
Compresses verbose memories using LLM. Requires Smart Mode configured.

### export / import
```json
{"tag": "project:myapp"}
```
Export memories as JSON for sharing. Import with merge strategies: `skip`, `overwrite`, `append`.

## Best Practices

1. **Be specific** — "Use OAuth 2.0 with PKCE" not "auth stuff decided"
2. **Tag by project** — Always include `project:<name>` tag
3. **Use relations** — Link related decisions with `related-to`, replace old ones with `supersedes`
4. **Type correctly** — Use the right type (decision/pattern/lesson) for better search
5. **Don't over-remember** — Skip trivial things. Remember decisions that took > 5 minutes to make.
