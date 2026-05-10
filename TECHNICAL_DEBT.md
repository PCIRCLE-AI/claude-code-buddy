# Technical Debt Tracker

**Last Updated**: 2026-05-10
**Version**: 4.2.0

---

## Overview

v4.2.0 ships with a clean slate on lint and type debt: **0 lint warnings, 0 lint errors, 0 executable `any` in `src/`, 984/984 tests passing**. The remaining surface is two upstream-bound items (one held dependency upgrade, one transitive security advisory) and tracker entries for future engineering quality investments. Nothing on this page is currently blocking — this doc exists to keep the bar from drifting.

**Current Status**: 0 lint warnings · 0 lint errors · 0 executable `any` in src/ · 984/984 tests · 1 transitive high-sev advisory (not reachable from memesh's API surface)

---

## Lint Health

### Current Distribution

_Derived from: `npm run lint` at HEAD._

| Metric | Count |
|--------|-------|
| Errors | 0 |
| Warnings | 0 |

ESLint flat config (`eslint.config.js`) treats empty `catch {}` as the project's intentional silent-failure pattern in hook code (`allowEmptyCatch: true`) — every other empty block still warns. Other historical noise rules (`no-empty`, `no-useless-assignment`, `no-useless-escape`, `preserve-caught-error`, `no-control-regex`) remain on `'warn'` so future regressions surface immediately.

### Going-Forward Discipline

- **Today**: `npm run lint` reports 0 problems.
- **CI**: a `lint` step on every PR (see `.github/workflows/ci.yml`) reports the count; the doctor + version-coherence steps are the hard gates.
- **Target (v4.3.0)**: switch the CI lint step from informational to **`--max-warnings 0`** so any new warning fails the build before merge. The current zero-state makes this safe to enable on the next minor.

---

## Type Safety (`any` Usage)

_Derived from: `grep -rnE "(: any[,)\;>]|<any>|as any)" src/ --include="*.ts"`_

| Surface | Executable `any` | Notes |
|---------|------------------|-------|
| `src/**/*.ts` | **0** | Down from 60 at v4.1.x baseline |
| Comments / strings | 3 | Documentation references inside `types.ts` and `digest-validator.ts`; not executable |

The v4.2.0 cleanup typed every Express handler against the `Request<P, ResB, ReqB>` generics, replaced `catch (err: any)` with `instanceof Error` narrowing, and introduced `Record<string, unknown>` for SQLite `metadata` payloads. The pattern is now uniform; new handlers must match it (PR-review gate).

### Pattern Reference

```typescript
// HTTP handler — typed body + response
app.post('/v1/remember', (req: Request<{}, RememberResult, RememberArgs>, res: Response<RememberResult>) => {
  const { name, type, observations } = req.body;     // fully typed
  res.json(remember({ name, type, observations })); // return type checked
});

// Catch — narrow with instanceof, never `: any`
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

// SQLite metadata — Record<string, unknown> with try/catch parse
let metadata: Record<string, unknown>;
try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { metadata = {}; }
```

---

## Dependency Management

_Derived from: `npm outdated` at HEAD._

| Package | Current | Latest | Status |
|---------|---------|--------|--------|
| `typescript` | 5.9.3 | 6.0.3 | ⏸️ Intentionally held |
| All runtime deps | up to date | — | ✅ |

### TypeScript 6.0 Upgrade — Held

**Reason**: Major version bump. TS 6.0 introduces several breaking changes in inference around conditional types and `unknown`-narrowing that show up in the project's `Record<string, unknown>` patterns (which we just rolled out broadly in v4.2.0). Upgrading immediately would risk re-opening the type-debt we just paid down.

**Plan**: Re-evaluate at v4.3.0. Verification path: branch `chore/ts-6.0`, run `npx tsc --noEmit && npx vitest run`, audit any new errors. If the new errors are all in code we wrote in v4.2.0, defer to v4.4.0 once the patterns settle. If they're orthogonal (e.g. third-party type packages), upgrade.

**Estimated Effort**: 1–2 days (most of the time is in test verification across the matrix).

---

## Security Advisories

_Derived from: `npm audit` at HEAD._

| Advisory | Severity | Package | Path | Status |
|----------|----------|---------|------|--------|
| GHSA-q3j6-qgpj-74h6 (path traversal) | High | `fast-uri ≤3.1.0` | `@modelcontextprotocol/sdk → ajv → fast-uri` | Awaiting upstream |
| GHSA-v39h-62p7-jpjc (host confusion) | High | `fast-uri ≤3.1.1` | same | Awaiting upstream |

**Reachability**: Neither vector is reachable from memesh's runtime. The MCP SDK uses ajv only for JSON-schema validation of tool-call requests over stdio; memesh never parses URLs through ajv. The advisory exists on the lock graph but not in the call graph.

**Resolution path**: bump `@modelcontextprotocol/sdk` to a version that pins `ajv ≥9.0`. Tracked in `chore: bump MCP SDK` work — not on the v4.2.0 critical path. We re-check on every minor release.

---

## Test Suite Health

_Derived from: `npx vitest run` against the integrated `release/4.2.0` branch._

- **Pass Rate**: 100% — 984/984 tests across 63 files
- **Pool Mode**: `forks` (required for `better-sqlite3` native module — never change)
- **Benchmark Baseline**: LongMemEval-S Mode A — R@5 95.40%, R@10 97.60%, MRR 0.8899 (FTS5-only, no LLM on recall path). Three independent runs at v4.2.0 confirm the baseline is unchanged after `query-expander.ts` retirement.

### Known Test-Environment Pitfalls

- **Worktree without `dist/`**: `await import('dist/core/config.js')` in some hooks will silently fail under a fresh worktree. Run `npm run build` before `npx vitest run` in any worktree, or run from the main checkout.
- **Windows `dream-auto-trigger.test.ts` "all gates pass"**: skipped on `process.platform === 'win32'` pending Windows-specific env-propagation diagnosis. v4.2.0 ships with stderr-trace instrumentation behind `MEMESH_DREAM_TRIGGER_DEBUG=1` so the next Windows session can identify the failing gate without further code reading. Runbook: `docs/notes/windows-dream-trigger-diagnosis.md` (gitignored).

---

## Empty Catch Blocks

_Derived from: `grep -rcE "catch\s*\(\s*\)\s*\{" src/ --include="*.ts"` — 0 matches in src/._

Hook code (`scripts/hooks/*.js`) intentionally uses `try { stderr.write(...) } catch {}` so even logging a failure cannot crash the hook itself. ESLint allows this via `'no-empty': ['warn', { allowEmptyCatch: true }]`. Any other empty block (e.g. empty `if` body) still warns.

---

## Future Improvements

### P2 (target v4.3.0)

1. **Lint CI gate** — flip `eslint` step to `--max-warnings 0`. Pre-condition (zero warnings) is met today; the change is one-line and turns the bar into a guarantee.
2. **Windows env-propagation fix** — diagnose the `dream-auto-trigger` Windows skip using the v4.2.0 instrumentation. Removing the skip is the deliverable.

### P3 (deferred)

3. **Structured logging** — replace ad-hoc `console.*` with a levelled logger. Useful for production deployments; low-priority for local-first use.
4. **Centralised Express error middleware** — currently each handler has its own try/catch. A shared middleware would standardise 500 responses and reduce duplication.
5. **TypeScript 6.0 evaluation** — see Dependency Management above.
6. **MCP SDK bump** to clear the `fast-uri` advisory once an upstream-pinned `ajv` is available.

---

## Progress Tracking

### Completed in v4.2.0

- ✅ Lint warnings: **110 → 0** (1 error → 0)
- ✅ Executable `any` in `src/`: **60 → 0**
- ✅ Test failures resolved: 884/896 → **984/984** (100%)
- ✅ `query-expander.ts` retired — recall is LLM-free at all times; LongMemEval-S baseline unchanged
- ✅ `src/core/llm-client.ts` — unified LLM client with multi-provider failover
- ✅ `src/core/llm-telemetry.ts` — persistent telemetry, 180-day auto-prune
- ✅ `src/core/digest-validator.ts` — opt-in hallucination filter for dream proposals
- ✅ `src/core/kg-backfill.ts` — heuristic relation backfill (tag co-occurrence + project clustering)
- ✅ Dashboard Insights tab — pending dream proposals + accept/reject UI
- ✅ Dashboard LLM telemetry panel in Analytics tab
- ✅ Stop-hook auto-triggers `dream` (gated, throttled, detached)
- ✅ Version coherence CI gate (`scripts/check-version-coherence.mjs`)
- ✅ Doctor CI gate (manifest + hooks integrity)
- ✅ Native i18n translations for 8 locales (`ja`, `ko`, `pt-BR`, `fr`, `de`, `vi`, `es`, `th`) for the v4.2.0 dashboard surfaces
- ✅ Windows dream-trigger stderr-trace instrumentation (gated behind `MEMESH_DREAM_TRIGGER_DEBUG=1`)
- ✅ ESLint flat-config `allowEmptyCatch: true` — codifies the hook silent-failure pattern

### In Progress

_(None — v4.2.0 is the current stable baseline.)_

### Planned (post-v4.2.0)

- ⏳ Lint CI gate at `--max-warnings 0` (v4.3.0)
- ⏳ Windows `dream-auto-trigger` env-propagation diagnosis (v4.3.0)
- ⏳ TypeScript 6.0 evaluation (v4.3.0 or later)
- ⏳ `fast-uri` advisory resolution — bump `@modelcontextprotocol/sdk` once upstream pins `ajv ≥9.0`
- ⏳ Centralised Express error middleware (v4.4.0)
- ⏳ Structured logging (v4.4.0+)

---

## Metrics

_All figures derived from commands run at the integrated v4.2.0 head._

| Metric | Current | Target (v4.3.0) | Status |
|--------|---------|-----------------|--------|
| Lint Errors | 0 | 0 | ✅ |
| Lint Warnings | 0 | 0 (CI-gated) | ✅ |
| `no-explicit-any` warnings | 0 | 0 | ✅ |
| Executable `any` in src/ | 0 | 0 | ✅ |
| Test Pass Rate | 100% (984/984) | 100% | ✅ |
| Security Vulns (direct) | 0 | 0 | ✅ |
| Security Vulns (transitive) | 1 high (`fast-uri`, not reachable) | 0 | ⏸️ Awaiting MCP SDK |
| Dependencies outdated | 1 (`typescript` 5.9.3 → 6.0.3, held) | re-evaluate | ⏸️ On Hold |
| LongMemEval-S R@5 | 95.40% | ≥95.40% | ✅ |

---

**Last Review**: 2026-05-10
**Next Review**: 2026-05-17 (weekly)
