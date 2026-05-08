# Technical Debt Tracker

**Last Updated**: 2026-05-08  
**Version**: 4.1.4

---

## Overview

This document tracks known technical debt items and the plan for gradual cleanup.

**Current Status**: 81 lint warnings (0 errors) ✅

---

## Lint Warnings (81 total)

### Distribution by Type

| Rule | Count | Priority | Target |
|------|-------|----------|--------|
| `@typescript-eslint/no-explicit-any` | 54 | P2 | Reduce to <20 by v4.2.0 |
| `no-empty` | 10 | P3 | Add comments or handlers |
| `no-useless-assignment` | 6 | P3 | Clean up by v4.2.0 |
| `no-useless-escape` | 5 | P3 | Fix regex escapes |
| `preserve-caught-error` | 3 | P3 | Document by v4.2.0 |
| `no-control-regex` | 1 | P3 | Review regex |
| Others | 2 | P3 | - |

### Strategy

**Phase 1 (v4.1.4 → v4.2.0)**: Focus on `no-explicit-any`
- Target: Reduce from 54 to <20
- Approach: Replace with proper types in HTTP handlers
- Estimated effort: 2-3 hours

**Phase 2 (v4.2.0 → v4.3.0)**: Clean up remaining warnings
- Fix `no-useless-assignment` (6 instances)
- Fix `no-useless-escape` (5 instances)  
- Add comments to `no-empty` blocks (10 instances)

**Phase 3 (v4.3.0+)**: Zero warnings
- Enable `lint:strict` in CI
- Treat warnings as errors

---

## Type Safety Improvements

### `any` Usage Analysis

**Total**: 54 instances in src/

**Hotspots**:
1. `src/transports/http/server.ts` - ~30 instances (Express handlers)
2. `src/transports/mcp/handlers.ts` - ~10 instances
3. Other files - ~14 instances

**Recommended Approach**:

#### 1. Create Typed Request/Response Interfaces

```typescript
// src/transports/http/types.ts (new file)
import { Request, Response } from 'express';

export interface TypedRequest<T = unknown> extends Request {
  body: T;
}

export interface TypedResponse<T = unknown> extends Response {
  json: (body: T) => this;
}

// Usage in handlers:
app.post('/v1/remember', (req: TypedRequest<RememberArgs>, res: TypedResponse<RememberResult>) => {
  const { name, type, observations } = req.body;
  // Now fully typed!
});
```

#### 2. Replace `any` in Error Handlers

**Current**:
```typescript
} catch (err: any) {
  res.status(500).json({ error: err.message });
}
```

**Better**:
```typescript
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}
```

#### 3. Type MCP Tool Results

**Current**:
```typescript
return { content: [{ type: 'text', text: JSON.stringify(result as any) }] };
```

**Better**:
```typescript
return { content: [{ type: 'text', text: JSON.stringify(result) }] };
// Remove `as any`, rely on proper typing from core operations
```

---

## Dependency Management

### Current Status

| Package | Current | Latest | Status |
|---------|---------|--------|--------|
| @types/node | 25.6.2 | 25.6.2 | ✅ Up to date |
| express-rate-limit | 8.5.1 | 8.5.1 | ✅ Up to date |
| vitest | 4.1.5 | 4.1.5 | ✅ Up to date |
| zod | 4.4.3 | 4.4.3 | ✅ Up to date |
| typescript | 5.9.3 | 6.0.3 | ⏸️ Intentionally held |

### TypeScript 6.0 Upgrade

**Status**: ⏸️ **On Hold**

**Reason**: Major version bump, requires careful evaluation

**Before Upgrading**:
1. Review breaking changes in TS 6.0 changelog
2. Test in isolated branch
3. Check all type definitions still work
4. Verify build process unchanged
5. Run full test suite

**Estimated Effort**: 1-2 days

---

## Test Suite Issues

### Current Status

- **Pass Rate**: 98.66% (884/896 tests pass)
- **Failures**: 12 HTTP transport timeout tests
- **Cause**: 30-second timeout limit

### Remediation Plan

**Option A**: Increase test timeout
```typescript
// In test file
it('returns array for no-match query', async () => {
  // ...
}, 60000); // 60 second timeout
```

**Option B**: Optimize HTTP server startup
- Pre-warm database connection
- Reduce middleware overhead
- Use in-memory SQLite for tests

**Option C**: Mock HTTP layer in tests
- Test core operations directly
- Separate HTTP integration tests

**Recommended**: Option B (optimize startup) + selective Option A (timeout increase for slow tests)

---

## Empty Catch Blocks

### Status: ✅ **Addressed in P1**

All empty catch blocks have been reviewed:
- 41 have legitimate comments
- 3 fixed with error logging (P1.1)

No further action needed.

---

## Future Improvements

### P3 (Low Priority)

1. **Structured Logging**
   - Replace direct `console.*` calls
   - Implement structured logger with levels
   - Add log rotation for production

2. **Error Handling Middleware**
   - Centralized error handler for Express
   - Consistent error response format
   - Error tracking integration

3. **Type Coverage Metrics**
   - Track % of `any` usage over time
   - Set target: <1% `any` usage
   - CI gate: no new `any` types

4. **Performance Monitoring**
   - Add timing metrics to core operations
   - Track recall latency
   - Monitor database query performance

---

## Progress Tracking

### Completed

- ✅ P1 Security Audit (2026-05-08)
- ✅ Dependency Updates (2026-05-08)
- ✅ Security Vulnerabilities Fixed (2026-05-08)
- ✅ Fire-and-Forget Error Logging (2026-05-08)

### In Progress

- 🔄 Lint Warnings Reduction (54 any → <20 target)

### Planned

- ⏳ TypeScript 6.0 Evaluation (v4.2.0)
- ⏳ Test Timeout Issues (v4.2.0)
- ⏳ Structured Logging (v4.3.0)

---

## Metrics

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Lint Errors | 0 | 0 | ✅ |
| Lint Warnings | 81 | <50 | 🔄 In Progress |
| Test Pass Rate | 98.66% | 100% | 🔄 In Progress |
| `any` Usage | 54 | <20 | 🔄 In Progress |
| Security Vulns | 0 | 0 | ✅ |
| Dependencies Outdated | 1 (TS 6.0) | 0 | ⏸️ On Hold |

---

**Last Review**: 2026-05-08  
**Next Review**: 2026-05-15 (weekly)
