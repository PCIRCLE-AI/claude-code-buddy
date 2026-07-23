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
import { execFileSync } from 'child_process';

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
  const cached = projectNameCache.get(cwd);
  if (cached !== undefined) return cached;
  const resolved = resolveProjectIdentity(cwd);
  projectNameCache.set(cwd, resolved);
  return resolved;
}

// Resolved names are stable for the life of a process (a cwd's git identity
// doesn't change mid-run), and getProjectName runs on hot paths — every hook
// invocation, every core operation. Cache so the git subprocess runs at most
// once per distinct cwd.
const projectNameCache = new Map<string, string>();

/**
 * Layered project identity, most-canonical first:
 *
 *   1. git remote slug — the repo name from `remote.origin.url`. This is the
 *      only identity that is BOTH location-independent (same from any
 *      subdirectory, worktree, or clone path) AND case-canonical (the remote
 *      spells the name once). It fixes the real-data failures: a memory
 *      captured in `<repo>/backend` and one captured at `<repo>` now share an
 *      identity, and `tim` vs `TIM` collapse to whatever the remote says.
 *   2. git repo root basename — for a real repo with no remote configured.
 *      Still fixes the subdirectory split.
 *   3. cwd basename — non-git directories keep the original behaviour, so a
 *      scratch dir or `~/Developer/Projects` is unchanged.
 *
 * A `config.project` override would sit above all three, but adding a config
 * field with no setter is itself the "fake working" pattern this audit is
 * removing; it should land WITH its setter, not before.
 *
 * git failures at every layer fall through silently to the next — a missing
 * git binary, a non-repo cwd, or a deleted directory must never break capture.
 */
function resolveProjectIdentity(cwd: string): string {
  const remote = tryGit(cwd, ['config', '--get', 'remote.origin.url']);
  if (remote) {
    const slug = slugFromRemoteUrl(remote);
    if (slug) return slug;
  }
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (root) return path.basename(root);
  return path.basename(cwd);
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a git remote URL to its repo name. Handles both URL-style
 * (`https://host/owner/repo.git`) and scp-style (`git@host:owner/repo.git`).
 * Returns just the repo segment, matching the existing `project:<basename>`
 * tag style, so a checkout whose directory name already equals the repo name
 * stays byte-identical and needs no migration.
 */
export function slugFromRemoteUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '');
  if (!cleaned) return null;
  const seg = cleaned.split(/[/:\\]/).filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : null;
}

/** Test seam: clear the per-cwd resolution cache between cases. */
export function _clearProjectNameCache(): void {
  projectNameCache.clear();
}
