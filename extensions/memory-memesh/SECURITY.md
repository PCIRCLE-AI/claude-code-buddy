# Security Considerations for OpenClaw MeMesh Plugin

**Status**: This plugin is **built but NOT yet tested** against a live OpenClaw instance. The security findings below were identified during code review and should be addressed before production deployment.

---

## Identified Security Issues

### 1. Indirect Prompt Injection (MEDIUM)

**Location**: `index.ts` - `extractLatestUserText()` → `normalizeRecallQuery()` → `client.recall()`

**Issue**: User message content is extracted and used directly as a recall query without sufficient sanitization. A malicious user could craft messages that exploit the recall mechanism to leak information about other agents' memories.

**Mitigation**:
```typescript
// Add query sanitization before recall
function sanitizeRecallQuery(text: string): string {
  // Remove potential injection patterns
  // Limit query complexity
  // Add rate limiting per agent
}
```

### 2. Tenant Isolation (HIGH)

**Location**: `index.ts` - `agentId` used as namespace but not verified

**Issue**: The plugin uses `ctx.agentId` as the isolation boundary, but:
- No verification that `agentId` is cryptographically unforgeable
- No check that one agent cannot impersonate another by manipulating `agentId`
- MeMesh HTTP API uses `namespace` (personal/team/global), not `agentId`

**Current behavior**: All agents share the same MeMesh database with `namespace: "personal"` (hardcoded in `memory_store`).

**Risk**: Agent A can potentially recall Agent B's memories if they share the same namespace.

**Mitigation**:
```typescript
// Map agentId to namespace OR use tags for isolation
await client.remember({
  type: category,
  observations: [text],
  namespace: "personal",
  tags: [`agent:${agentId}`],  // Tag-based isolation
});

// Filter recalls by agent
const entities = await client.recall(query, limit * 2);
const filtered = entities.filter(e => 
  e.tags?.includes(`agent:${agentId}`)
);
```

**Alternative**: Deploy separate MeMesh instances per agent/tenant, with different `baseUrl` per agent.

### 3. Unrestricted Destructive Action (MEDIUM)

**Location**: `index.ts` - `memory_forget` tool

**Issue**: `memory_forget` deletes all memories matching a query, with no:
- Confirmation prompt
- Undo mechanism
- Backup before deletion
- Rate limiting

**Mitigation**:
- Add confirmation step for bulk deletions
- Implement soft-delete (archive) instead of hard-delete
- Log all deletions with timestamp + agentId
- Add rate limit (max N deletions per hour)

### 4. Fail-Open Cooldown (LOW)

**Location**: `index.ts` - `readCooldown()` / `recordCooldown()`

**Issue**: If cooldown state is corrupted (e.g., `recallCooldowns` Map is cleared), recall will succeed even if it should be in cooldown.

**Current behavior**: Fail-open (allows recall if cooldown check fails).

**Mitigation**: Persist cooldowns to disk/database instead of in-memory Map, or fail-closed (deny recall if cooldown state is uncertain).

### 5. Prompt Injection in Store (ADDRESSED)

**Location**: `index.ts` - `memory_store` → `looksLikePromptInjection()`

**Status**: ✅ Already implemented

The plugin includes prompt injection defense via `INJECTION_PATTERNS`. This is a good baseline but should be tested against real attacks.

**Enhancement**: Consider using MeMesh's own prompt injection detection if available, or a more comprehensive library.

---

## Deployment Checklist

Before deploying to production:

- [ ] Test tenant isolation with multiple agents
- [ ] Verify agentId cannot be spoofed
- [ ] Implement query sanitization
- [ ] Add confirmation for `memory_forget`
- [ ] Test cooldown persistence across plugin restarts
- [ ] Run A/B test (plugin on vs off) to verify no unintended side effects
- [ ] Review MeMesh HTTP API auth model (currently assumes localhost-only)
- [ ] Consider rate limiting per agent
- [ ] Add audit logging for all memory operations
- [ ] Document security assumptions (e.g., trusted network, localhost-only)

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
