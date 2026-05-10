// Centralised filesystem-path resolution for memesh.
//
// Before this module existed, `process.env.MEMESH_DB_PATH ?? path.join(...)`
// was inlined in 8+ core sites and the HOME-first override (needed for
// hermetic Windows tests) was applied in only 2 of them. Each site
// resolved roughly the same path with subtle differences (`??` vs `||`,
// with/without HOME-first), making path-related drift a recurring source
// of audit findings.
//
// Hooks cannot import from `dist/` (the F5 security boundary — `dist/`
// may be stale or absent at hook execution time), so `scripts/hooks/_shared.js`
// keeps a mirror of these helpers. Any change to the shapes here MUST be
// reflected in `_shared.js`. The `check-schema-drift` build-time guard
// (`scripts/check-schema-drift.mjs`) catches the SQL portion; the path
// helpers are short enough that a JSDoc cross-link is enough.

import os from 'os';
import path from 'path';

/**
 * Resolve the user's home directory, honouring `HOME` first.
 *
 * On POSIX, `os.homedir()` already consults `HOME`. On Windows it ignores
 * env vars and reads `GetUserProfileDirectoryW` directly, which makes
 * tests unable to redirect home-dir lookups to a tmp dir. Honouring `HOME`
 * first lets tests set `HOME=<tmpdir>` and have it actually take effect
 * across platforms. Production users on Windows almost never set `HOME`,
 * so this falls through to `os.homedir()` unchanged.
 */
export function homeDir(): string {
  // `??` only falls through on null/undefined — an env that exports
  // HOME="" (some Docker base images, some CI sandboxes, broken nss
  // configs) would silently return "" and route memesh's data dir
  // under the process cwd via path.join("", ".memesh") === ".memesh".
  //
  // Three-step fallback:
  //   1. process.env.HOME (most explicit)
  //   2. os.homedir() — but on POSIX this ALSO reads HOME first, so
  //      with HOME="" it returns "" too
  //   3. os.userInfo().homedir — reads pw_dir via getpwuid syscall,
  //      bypassing env vars entirely. Final defence against HOME=""
  //      sandboxes.
  const home = process.env.HOME;
  if (home && home.length > 0) return home;
  const fromOs = os.homedir();
  if (fromOs && fromOs.length > 0) return fromOs;
  return os.userInfo().homedir;
}

/**
 * Resolve the memesh data directory.
 *
 * Precedence: `MEMESH_DIR` env var > `<home>/.memesh`. Note that
 * `MEMESH_DB_PATH` (the more granular override, used when the user wants
 * the DB file at a non-default location) is NOT consulted here — see
 * `getDbPath()` for that. Callers that need the directory containing the
 * active DB file should use `getMemeshDirFromDbPath()` instead.
 */
export function memeshDir(): string {
  return process.env.MEMESH_DIR ?? path.join(homeDir(), '.memesh');
}

/**
 * Resolve the active memesh DB path.
 *
 * Precedence: `MEMESH_DB_PATH` env var > `<memeshDir()>/knowledge-graph.db`.
 * Most callers want this rather than a hand-rolled `process.env.MEMESH_DB_PATH ?? ...`,
 * so they automatically inherit the HOME-first override on Windows tests.
 */
export function getDbPath(): string {
  return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), 'knowledge-graph.db');
}

/**
 * Resolve the directory containing the active DB file.
 *
 * When `MEMESH_DB_PATH` is set, returns its parent directory. Otherwise
 * returns `memeshDir()`. Use this when you need to write sibling files
 * next to the DB (e.g. session tracking, update-check cache) rather than
 * the global memesh dir.
 */
export function getMemeshDirFromDbPath(): string {
  return process.env.MEMESH_DB_PATH
    ? path.dirname(process.env.MEMESH_DB_PATH)
    : memeshDir();
}

/**
 * Derive the project name from a working directory.
 *
 * Five hooks and two core operations all derived this with subtly
 * different fallback chains:
 *   - hooks: `basename(data.cwd || process.cwd())`
 *   - core/operations: `basename(process.cwd())`
 *   - core/extractor: `basename(context.cwd)` (no fallback)
 *
 * This unified version takes an optional explicit cwd (e.g. from a hook
 * payload) and falls through to `process.cwd()`. Empty / missing inputs
 * also fall through, matching the most permissive caller's behaviour.
 */
export function getProjectName(cwdInput?: string | null): string {
  const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
  return path.basename(cwd);
}
