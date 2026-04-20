# MeMesh v4.0.1 — Dashboard Fix Release

**Release Date:** 2026-04-21  
**Type:** Hotfix

---

## 🐛 Critical Fix

### Dashboard 404 Error on Global Installation

**Problem:**  
When `memesh` command opens the dashboard at `http://127.0.0.1:<port>/dashboard`, users encounter:
```
NotFoundError: Not Found
    at SendStream.error (send/index.js:168:31)
```

**Root Cause:**  
Express's `sendFile()` uses the `send` package, which by default rejects file paths containing hidden directories (starting with `.`). When Node.js is installed via nvm (`.nvm` directory) or similar tools, the dashboard HTML file path contains hidden directories, triggering a 404 error.

**Fix:**  
Added `{ dotfiles: 'allow' }` option to `sendFile()` call in `src/transports/http/server.ts:78`:

```typescript
res.type('html').sendFile(dashboardPath, { dotfiles: 'allow' });
```

**Impact:**  
- ✅ All users with nvm, .nvm, or other hidden directories in Node.js path can now access dashboard
- ✅ No breaking changes to API or CLI
- ✅ All 445 tests pass

---

## 📦 Files Changed

- `src/transports/http/server.ts` — Added `dotfiles: 'allow'` option to `sendFile()`
- `package.json` — Bumped version to 4.0.1
- `plugin.json` — Bumped version to 4.0.1

---

## 🔍 Testing

```bash
# Install and test
npm install -g @pcircle/memesh@4.0.1
memesh
# Dashboard opens at http://127.0.0.1:<random-port>/dashboard
# ✅ Should show MeMesh Dashboard UI (no 404 error)
```

---

## 📚 References

- **Issue:** Dashboard 404 on first install (2026-04-21)
- **Affected users:** Anyone using nvm, .nvm, or hidden directories in Node.js installation path
- **Severity:** Critical (blocks primary UI access)
- **Resolution time:** 2 hours (identified root cause via `send` package source code analysis)

---

**Upgrade:** `npm install -g @pcircle/memesh@latest`
