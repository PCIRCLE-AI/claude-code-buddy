# Technical Debt Tracker

**Last Updated**: 2026-05-10
**Version**: 4.2.0

---

## Overview

Baseline debt snapshot at v4.2.0. The test suite is fully green (984/984). The remaining surface is concentrated in `no-explicit-any` warnings in HTTP/CLI transports, one indirect security advisory, and a held TypeScript 6.0 upgrade. `query-expander.ts` has been retired; four new modules shipped (`llm-client`, `llm-telemetry`, `digest-validator`, `kg-backfill`).

**Current Status**: 110 lint warnings (0 errors), 984/984 tests passing

---

## Lint Warnings (110 total)

### Distribution by Rule

| Rule | Count | Priority | Target (v4.3.0) |
|------|-------|----------|------------------|
| `@typescript-eslint/no-explicit-any` | 60 | P2 | Reduce to <25 |
| `no-empty` | 27 | P3 | Comment intentional ones |
| `no-useless-assignment` | 9 | P3 | Clean up |
| `preserve-caught-error` | 5 | P3 | Attach `.cause` |
| `no-useless-escape` | 4 | P3 | Fix regex escapes |
| `@typescript-eslint/no-unused-vars` | 4 | P3 | Remove or prefix `_` |
| `no-control-regex` | 1 | P3 | Review regex |

_Derived from: `npm run lint` at HEAD (worktree commit 997c61ab)._

### Strategy

**Phase 1 (v4.2.0 → v4.3.0)**: `no-explicit-any` — highest signal, biggest count
- Target: 60 → <25, focussing on HTTP server (25 instances) and knowledge-graph (8 instances)
- Approach: typed Express `Request<P,B>` generics; `instanceof Error` in catch blocks

**Phase 2 (v4.3.0 → v4.4.0)**: remaining warnings
- Comment or handle `no-empty` blocks (27 instances)
- Fix `no-useless-assignment` (9 instances)
- Fix `no-useless-escape` (4 instances)
- Attach `.cause` to `preserve-caught-error` sites (5 instances)

**Phase 3 (v4.4.0+)**: Enable `lint:strict` in CI (zero warnings as gate)

---

## Type Safety (`any` Usage)

### Current Count by File

_Derived from: `grep -rcE "as any|: any[),;]" src/ --include="*.ts"`_

| File | Count |
|------|-------|
| `src/transports/http/server.ts` | 25 |
| `src/knowledge-graph.ts` | 8 |
| `src/transports/cli/cli.ts` | 5 |
| `src/core/embedder.ts` | 4 |
| `src/core/verifier.ts` | 3 |
| `src/core/llm-validator.ts` | 3 |
| `src/transports/mcp/handlers.ts` | 2 |
| `src/core/version-check.ts` | 2 |
| `src/core/types.ts` | 2 |
| `src/cli/view.ts` | 2 |
| Other files (4) | 1 each |

**Total: 60 instances across 14 files.**

### Recommended Patterns

#### Typed Express Handlers

```typescript
// Instead of: (req: any, res: any)
import { Request, Response } from 'express';

app.post('/v1/remember', (req: Request<{}, {}, RememberArgs>, res: Response) => {
  const { name, type, observations } = req.body; // fully typed
});
```

#### Error Handler Pattern

```typescript
// Instead of: } catch (err: any) {
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}
```

---

## Dependency Management

### Current State

_Derived from: `npm outdated` at HEAD on the main working tree._

| Package | Current | Latest | Status |
|---------|---------|--------|--------|
| typescript | 5.9.3 | 6.0.3 | ⏸️ Intentionally held |
| All runtime deps | up to date | — | ✅ |

### TypeScript 6.0 Upgrade

**Status**: ⏸️ On Hold

**Reason**: Major version. Requires review of breaking changes, isolated branch testing, and verification that all type definitions and the build pipeline are unaffected.

**Estimated Effort**: 1–2 days

---

## Security Vulnerabilities

_Derived from: `npm audit` at HEAD._

| Vulnerability | Severity | Package | Path | Status |
|---------------|----------|---------|------|--------|
| GHSA-q3j6-qgpj-74h6 (path traversal) | High | `fast-uri <=3.1.0` | `@modelcontextprotocol/sdk → ajv → fast-uri` | Awaiting upstream fix |
| GHSA-v39h-62p7-jpjc (host confusion) | High | `fast-uri <=3.1.1` | same | Awaiting upstream fix |

**Note**: `fast-uri` is a transitive dependency of `ajv` which is pulled by `@modelcontextprotocol/sdk`. Neither path traversal nor host confusion vectors are reachable from memesh's usage of the MCP SDK (MCP stdio transport, no HTTP URL parsing through ajv). Will resolve when `@modelcontextprotocol/sdk` ships an updated `ajv` pin. Track: [npm advisory GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6).

---

## Test Suite Health

_Derived from: `npx vitest run` against the main working tree at HEAD._

- **Pass Rate**: 100% — 984/984 tests, 63 test files
- **Known Flakes**: None confirmed. Session-start and hook integration tests can fail in the worktree if `dist/` is absent (no `npm run build` run in worktree). Run tests from the main working tree.
- **Pool Mode**: `forks` (not `threads`) — required for `better-sqlite3` native module; do not change
- **Benchmark Baseline**: LongMemEval-S Mode A — R@5 95.40%, R@10 97.60%, MRR 0.8899 (FTS5-only, no LLM on recall path). Three independent runs confirm baseline is unchanged at v4.2.0 after `query-expander.ts` retirement.

---

## Empty Catch Blocks

_Derived from: `grep -rcE "catch\s*\(\s*\)\s*\{" src/ --include="*.ts"` — 0 matches._

No empty catch blocks in `src/`. The `no-empty` lint warnings (27 total) are on empty block statements in other contexts (e.g. empty `if` branches, empty function bodies used as stubs). Each should receive a comment or be removed; see Phase 2 plan above.

---

## Future Improvements

### P2

1. **Type Safety in HTTP Server** — 25 `any` instances in `src/transports/http/server.ts`. Typed Express generics would eliminate the majority in one pass. Estimated 2–3 hours.

### P3 (Deferred)

2. **Structured Logging** — Replace ad-hoc `console.*` calls with a levelled logger. Useful for production deployments; not urgent for local-first use case.

3. **Centralized Express Error Middleware** — Currently each handler has its own try/catch. A shared error middleware would standardise 500 responses and reduce duplication.

4. **Windows Env Propagation** — `os.homedir()` ignores `HOME` on Windows; the `HOME`-first helper pattern added in v4.1.4 needs to be audited for completeness across all hook scripts. Low priority until Windows CI is green end-to-end.

5. **TypeScript `strict` Mode Audit** — Several files predate the `strict: true` flag being set. A one-time pass to resolve the suppressed checks would improve type confidence.

6. **CI Lint Gate** — Enable `lint:strict` (`--max-warnings 0`) once warning count reaches zero. Not a gate yet; tracked here as a target state.

---

## Progress Tracking

### Completed Since v4.1.4

- ✅ Test failures resolved — 884/896 → 984/984 (100%) — all HTTP timeout tests fixed
- ✅ `query-expander.ts` retired — recall path is now LLM-free at all times; 17 tests removed, LongMemEval-S baseline confirmed unchanged
- ✅ `src/core/llm-client.ts` — unified LLM client with multi-provider failover
- ✅ `src/core/llm-telemetry.ts` — persistent telemetry for Smart-Mode LLM calls; auto-prune at 180 days
- ✅ `src/core/digest-validator.ts` — opt-in hallucination filter for `dream` proposals
- ✅ `src/core/kg-backfill.ts` — heuristic relation backfill for orphan entities
- ✅ Dashboard Insights tab — surfaces what memesh did for the user across sessions
- ✅ Dashboard LLM telemetry panel in Analytics tab
- ✅ Stop hook auto-triggers `dream` (gated, throttled, detached)
- ✅ Version coherence CI gate — `package.json` vs `CHANGELOG.md` diff check
- ✅ `fast-uri` polynomial-redos from v4.1.x resolved (prior CVE in `re2`-based path; separate from current advisory)
- ✅ Fire-and-forget error logging added to silent exit paths

### In Progress

_(None — v4.2.0 is the current stable baseline.)_

### Planned

- ⏳ `no-explicit-any` reduction: 60 → <25 (v4.3.0)
- ⏳ `no-empty` comment pass: 27 blocks documented or removed (v4.3.0)
- ⏳ TypeScript 6.0 evaluation (v4.3.0 or later)
- ⏳ `fast-uri` advisory resolution — awaiting MCP SDK upstream update (track `@modelcontextprotocol/sdk` releases)
- ⏳ Lint strict gate in CI (v4.4.0, after warning count reaches zero)

---

## Metrics

_All figures derived from commands run at commit 997c61ab (v4.2.0 HEAD)._

| Metric | Current | Target (v4.3.0) | Status |
|--------|---------|-----------------|--------|
| Lint Errors | 0 | 0 | ✅ |
| Lint Warnings | 110 | <60 | 🔄 In Progress |
| `no-explicit-any` warnings | 60 | <25 | 🔄 In Progress |
| Test Pass Rate | 100% (984/984) | 100% | ✅ |
| Security Vulns (direct) | 0 | 0 | ✅ |
| Security Vulns (transitive) | 1 high (`fast-uri`) | 0 | ⏸️ Awaiting upstream |
| Dependencies outdated | 1 (`typescript` 5.9.3 → 6.0.3) | 0 | ⏸️ On Hold |
| LongMemEval-S R@5 | 95.40% | ≥95.40% | ✅ |

---

**Last Review**: 2026-05-10
**Next Review**: 2026-05-17 (weekly)
