#!/usr/bin/env node
// Startup guard for the MeMesh MCP server.
//
// `db.ts` uses a static `import Database from 'better-sqlite3'`, which means
// the process crashes before any try-catch runs when the native binding is
// absent. Clearing `require.cache` and retrying `await import()` does not
// help — ESM's CJS interop caches at a layer below require.cache. The only
// reliable recovery is a fresh Node.js process after rebuild.
//
// Flow when binary is missing:
//   1. CJS require() detects missing binary (catchable, unlike static import).
//   2. npm rebuild better-sqlite3 compiles the binary.
//   3. spawnSync re-exec this launcher (env guard prevents infinite loops).
//   4. The fresh process finds the binary and falls through to import server.js.
//
// MCP protocol uses stdout — we never write to stdout here.

import { createRequire } from 'module';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const _require = createRequire(import.meta.url);
const _dir = dirname(fileURLToPath(import.meta.url));

function hasBinary(): boolean {
  // better-sqlite3 loads its native binding lazily inside the Database()
  // constructor (via the `bindings` package), not at require() time.
  // A plain require() always succeeds. We must instantiate to trigger the
  // binding lookup and detect a missing or incompatible binary.
  try {
    const Db = _require('better-sqlite3');
    new Db(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

if (!hasBinary() && !process.env.MEMESH_REBUILD_ATTEMPTED) {
  // dist/mcp/ → two levels up → package root (where node_modules lives)
  const cwd = join(_dir, '../..');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    process.stderr.write('[memesh-mcp] better-sqlite3 binding missing — rebuilding native addon...\n');
    execFileSync(npm, ['rebuild', 'better-sqlite3'], { cwd, stdio: 'pipe' });
    process.stderr.write('[memesh-mcp] Rebuild complete — restarting server.\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[memesh-mcp] Rebuild failed (${msg}). Server will likely fail to start.\n`);
  }
  // Re-exec via a fresh Node process — avoids stale ESM/CJS module cache.
  // MEMESH_REBUILD_ATTEMPTED prevents a second rebuild loop if the binary
  // is still unloadable after rebuild (e.g., wrong arch, build tools missing).
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, MEMESH_REBUILD_ATTEMPTED: '1' },
  });
  process.exit(result.status ?? 1);
}

await import('./server.js');
