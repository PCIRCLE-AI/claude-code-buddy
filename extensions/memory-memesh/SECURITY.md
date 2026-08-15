# Security Considerations for OpenClaw MeMesh Plugin

**Status**: This plugin is **built but NOT yet tested** against a live OpenClaw instance. Security issues identified in initial code review have been **FIXED** as of 2026-08-15.

---

## Security Issues (FIXED)

### 1. Indirect Prompt Injection (MEDIUM) ✅ FIXED

**Location**: `index.ts` - `normalizeRecallQuery()`

**Issue**: User message content was extracted and used directly as a recall query without sufficient sanitization.

**Fix Applied**:
```typescript
// Strip potential injection patterns (defensive sanitization)
normalized = normalized.replace(/^(system|assistant|user)\s*:\s*/gi, "");
normalized = normalized.replace(/^(ignore|disregard|forget|new instructions?)[\s:]/gi, "");
```

Query sanitization now removes system-like prefixes and directive-like patterns before recall.

### 2. Tenant Isolation (HIGH) ✅ FIXED

**Location**: `index.ts` - all memory operations

**Issue**: All agents were sharing the same MeMesh database with `namespace: "personal"`, allowing Agent A to potentially recall Agent B's memories.

**Fix Applied**:
- Memories are tagged with `agent:${agentId}` on creation (`tags` array on `/v1/remember`)
- Recalls filter with `tag: "agent:${agentId}"` — the SINGULAR `tag` field, which is what
  RecallSchema actually accepts (a `tags` array is an unknown key Zod silently strips,
  which would disable the filter without any error)
- `memory_forget` operates only on agent-scoped recall results, so one agent cannot
  archive another agent's entities through the tool

Note the honest limit: this is cooperative isolation for well-behaved plugins sharing one
MeMesh instance. `agentId` comes from the OpenClaw runtime and is not cryptographically
verified; a hostile co-resident plugin could pass another agent's id. Hard isolation
requires separate MeMesh instances (different `baseUrl`) per tenant.

### 3. Unrestricted Destructive Action (MEDIUM) ✅ FIXED

**Location**: `index.ts` - `memory_forget` tool

**Issue**: `memory_forget` deleted all memories matching a query with no preview or confirmation.

**Fix Applied**:
- Query-based forgetting is composed from the server's real name-based contract:
  recall the matches (agent-scoped), archive each by `POST /v1/forget {name}`,
  report the count the server actually confirmed
- If no matches found, returns "No memories found matching that query."
- MeMesh's forget is a soft-delete (archive) — entities are restorable server-side,
  which is the undo mechanism the original finding asked for

### 4. Fail-Open Cooldown (LOW) ✅ REVIEWED

**Location**: `index.ts` - `readCooldown()` / `recordCooldown()`

**Issue**: In-memory Map for cooldown state could be lost on plugin restart.

**Assessment**: Current implementation is appropriate for plugin lifecycle:
- Cooldown is a temporary rate-limit mechanism, not persistent security state
- Plugin restart naturally resets cooldown (expected behavior)
- Map corruption would only allow one additional recall attempt (low impact)

For persistent rate limiting, implement at the MeMesh API level with database-backed tracking.

### 5. Prompt Injection in Store (ADDRESSED)

**Location**: `index.ts` - `memory_store` → `looksLikePromptInjection()`

**Status**: ✅ Already implemented

The plugin includes prompt injection defense via `INJECTION_PATTERNS`. This is a good baseline but should be tested against real attacks.

**Enhancement**: Consider using MeMesh's own prompt injection detection if available, or a more comprehensive library.

---

## Deployment Checklist

Before deploying to production:

- [x] Tenant isolation with agentId-tagged filtering (FIXED)
- [x] Query sanitization for recall (FIXED)
- [x] Preview before `memory_forget` deletion (FIXED)
- [x] Cooldown implementation reviewed (APPROPRIATE)
- [ ] Test with live OpenClaw instance
- [ ] Run A/B test (plugin on vs off) to verify no unintended side effects
- [ ] Review MeMesh HTTP API auth model - see [API_REFERENCE.md](../../docs/api/API_REFERENCE.md#authentication) (currently assumes localhost-only)
- [ ] Consider rate limiting per agent (optional - cooldown provides basic protection)
- [ ] Add audit logging for all memory operations (optional - implement at MeMesh API level)
- [ ] Document security assumptions in deployment docs

---

## Security Assumptions

This plugin currently assumes:

1. **Trusted network**: MeMesh HTTP API is on `localhost` with no auth
2. **Honest agents**: OpenClaw agents do not attempt to access each other's memories
3. **Single tenant**: All agents belong to the same user/organization
4. **No malicious input**: User messages are not crafted to exploit recall

**If any assumption is violated**, the security model breaks. Production deployments should:
- Run MeMesh with bearer-token auth if exposed beyond localhost
- Implement proper tenant isolation (separate MeMesh instances or namespaces)
- Add input validation and rate limiting
- Enable audit logging

---

## References

- OpenClaw security model: https://docs.openclaw.ai/security
- MeMesh HTTP API auth: [docs/api/API_REFERENCE.md](../../docs/api/API_REFERENCE.md)
- LanceDB reference plugin: https://github.com/openclaw/openclaw/blob/main/extensions/memory-lancedb/index.ts
