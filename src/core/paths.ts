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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
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
 *   3. real-path basename + 8-hex hash of the real path — non-git directories
 *      used to be bare `basename(cwd)`, which made `~/a/notes` and `~/b/notes`
 *      one project and leaked memories across them. The hash pins identity to
 *      the directory itself; every host on the machine derives the same id
 *      for the same directory. (Existing non-git projects change identity
 *      once — `memesh kg rename-project --from <old> --to <new> --apply`
 *      merges the tags.)
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
  // Non-git: the basename alone collides — `~/a/notes` and `~/b/notes` used to
  // share one identity, and the symptom was the other directory's memories
  // appearing. Rare with one host; three MCP hosts sharing one database made
  // it three times likelier. The suffix is derived from the real path, so it
  // is stateless, identical for every host that opens the same directory
  // (including through a symlink), and different for two directories that
  // merely share a name. `.native`, not the JS realpath: on the
  // case-insensitive filesystems macOS and Windows default to, the JS one
  // returns whatever case the caller typed, so `~/Notes` and `~/notes` — the
  // same directory — would hash to two identities, the exact split this layer
  // exists to close. The native call returns the on-disk spelling (and
  // expands Windows 8.3 short names). realpath falls back to resolve()
  // because a deleted cwd must never break capture (same rule as the git
  // layers above).
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    real = path.resolve(cwd);
  }
  const suffix = createHash('sha256').update(real).digest('hex').slice(0, 8);
  return `${path.basename(real)}-${suffix}`;
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

/**
 * The one list of secret-shaped patterns, shared by every redactor in the
 * codebase. Three copies used to exist at three different strengths — the
 * transcript scrubber (broadest), this module's egress redactor (middle),
 * and a private one in llm-client (weakest, sk-/Bearer only) — and a
 * cross-model review measured the gap: `github_pat_`, Stripe `sk_live_`,
 * JWTs, npm tokens and private keys sailed through the egress redactor into
 * a public GitHub issue URL. One list means one place to add the next token
 * format.
 *
 * Order matters for replacement: widest, whole-block patterns FIRST so a
 * full match is redacted as one unit and a later narrower pattern can never
 * leave part of the secret naked (the PEM body would otherwise survive its
 * own header being masked).
 *
 * Source strings, not RegExp objects: consumers compile with their own flags,
 * and a shared global-flag RegExp would leak `lastIndex` state between calls.
 */
export const SECRET_PATTERN_SOURCES: readonly string[] = [
  // PEM private key — whole BEGIN..END block first...
  '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----',
  // ...then a TRUNCATED paste (BEGIN with no END): redact through the base64
  // body to the next blank line or EOF, so the body never survives naked.
  '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?=\\n[ \\t]*\\n|$)',
  // DB / message-broker connection string with embedded credentials. Scheme
  // anchored so it cannot fire on ordinary `word:word@word` prose.
  '(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]+:[^\\s:@/]+@',
  // JWT — three base64url segments; `eyJ` is base64 of `{"`.
  'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
  // SendGrid API key.
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
  // Stripe secret/restricted/publishable live+test keys.
  '[srp]k_(?:live|test)_[A-Za-z0-9]{16,}',
  // npm automation token.
  'npm_[A-Za-z0-9]{36}',
  // Anthropic / OpenAI-style keys — hyphen OR underscore delimited.
  'sk-ant-[A-Za-z0-9_-]{16,}',
  'sk-[A-Za-z0-9_-]{16,}',
  'sk_[A-Za-z0-9]{16,}',
  'ghp_[A-Za-z0-9]{30,}',              // GitHub PAT (classic)
  'gho_[A-Za-z0-9]{30,}',              // GitHub OAuth
  'gh[sur]_[A-Za-z0-9]{30,}',          // GitHub app/server/refresh tokens
  'github_pat_[A-Za-z0-9_]{20,}',      // GitHub PAT (fine-grained)
  'A(?:KIA|SIA)[A-Z0-9]{16}',          // AWS access key id (perm + temporary)
  'AIza[A-Za-z0-9_-]{30,}',            // Google API key
  'xox[baprs]-[A-Za-z0-9-]{10,}',      // Slack token
  // Bearer token. `(?:\\s|\\\\[nrt])+` instead of plain \\s+: the HTTP
  // doctor egress redacts JSON-STRINGIFIED text, where a real newline
  // between "Bearer" and the token has become the two characters \n — a
  // shape plain \s+ cannot see.
  'Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}',
];

/**
 * Redact credential-shaped substrings before text leaves the machine.
 *
 * Belt-and-suspenders: nothing should put a secret in a diagnostic, but two
 * public egresses copy diagnostics verbatim into a pre-filled GitHub issue
 * body — the dashboard's `/v1/doctor` and the CLI's `memesh feedback` — and
 * both must run this BEFORE redactUserPaths (a home path inside a token,
 * once rewritten to `~`, would break the secret pattern and leak the rest).
 * It lived as a private function in the HTTP server, which left the CLI
 * egress path-redacted but not credential-redacted; it lives here because
 * this module owns redaction and both transports already import it.
 */
/** Compiled once. `String.prototype.replace` resets a global regex's
 *  `lastIndex` around the call, so reusing them across calls is safe. The
 *  Stop hook calls this per bash block and per errored tool result — hundreds
 *  of times per session, inside a 10-second budget — and it was recompiling
 *  all eighteen patterns each time. */
const SECRET_PATTERNS = SECRET_PATTERN_SOURCES.map((s) => new RegExp(s, 'gi'));

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '***REDACTED***');
  return out;
}

/**
 * Replace every path that identifies this machine's user with `~`.
 *
 * `memesh feedback` composes a GitHub issue body out of `doctor` output, and
 * doctor names paths: the database, the config file, where `memesh` resolves
 * on `PATH`. On a normal install every one of those begins with the home
 * directory, so the pre-filled body carried the account name into a **public**
 * issue tracker, twice, inside a diagnostics block long enough that nobody
 * reads it before submitting. The paths stay just as useful with the home part
 * cut off: `~/.memesh/knowledge-graph.db` says everything the absolute form
 * said.
 *
 * It lives here, in the module that owns path resolution, because it has to
 * redact the SAME set of roots that module produces, and because two surfaces
 * publish this text: the CLI, and the dashboard's feedback widget via
 * `/v1/doctor`. The CLI-only version left the dashboard leaking.
 *
 * Three roots, longest-first so a nested one cannot be half-replaced:
 *   - `homeDir()`, and its realpath — on macOS a temp HOME resolves through
 *     `/private`, so redacting only one spelling leaves the other in the body.
 *   - `memeshDir()` and the DB's directory, which `MEMESH_DIR` /
 *     `MEMESH_DB_PATH` can move outside home entirely. That is a supported
 *     configuration, and in a real deployment such a path typically carries an
 *     account or organisation name.
 */
export function redactUserPaths(text: string): string {
  const home = homeDir();
  const roots = new Set<string>();
  const add = (root: string) => {
    // Absolute directories only. `getDbPath()` returns `MEMESH_DB_PATH`
    // verbatim, so a relative value like `kg.db` makes `path.dirname(...)`
    // exactly `"."` — which compiled to `\.` and replaced EVERY literal dot in
    // the payload: `4.5.0` became `4~5~0`, `knowledge-graph.db` became
    // `knowledge-graph~db`. This function runs on the `/v1/doctor` response
    // that the dashboard turns into a public issue, so a corrupted diagnostic
    // is published with nothing saying redaction did it.
    if (!root || !path.isAbsolute(root)) return;
    roots.add(root);
    try { roots.add(fs.realpathSync(root)); } catch { /* may not exist yet */ }
  };
  add(home);

  // The data directories only need their OWN entry when an override has moved
  // them outside home. Inside home, redacting home already covers them — and
  // adding them anyway makes it worse, not better: they are longer, so they
  // match first and turn `/Users/x/.memesh/knowledge-graph.db` into
  // `~/knowledge-graph.db`, throwing away the `.memesh` part that tells the
  // reader which file it is.
  const isInside = (child: string) => {
    const rel = path.relative(home, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const dir of [memeshDir(), path.dirname(getDbPath())]) {
    if (dir && !isInside(dir)) add(dir);
  }

  // Case-insensitive except on Linux: macOS and Windows filesystems are
  // case-insensitive, so the same directory can be spelled either way.
  const flags = process.platform === 'linux' ? 'g' : 'gi';
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Either separator, once or twice. Twice matters: the HTTP path redacts a
    // JSON string, where a Windows `C:\Users\x` is serialised as
    // `C:\\Users\\x` — a single-separator pattern matches the live path and
    // silently misses the JSON-encoded one, which is the copy that gets
    // published.
    //
    // A root has to match at a path boundary on BOTH sides, and it takes two
    // assertions to say that — one is the bug this had.
    //
    // Trailing lookahead: without it `MEMESH_DIR=/data` rewrote
    // `/var/lib/postgres/database` to `/var/lib/postgres~base` and `/datasets/x`
    // to `~sets/x`.
    //
    // Leading lookbehind: the trailing one alone still let a root match in the
    // MIDDLE of an unrelated path, because there the next character IS a
    // separator — `/var/lib/data/file` became `/var/lib~/file`. The comment here
    // used to cite only the `database` case and read as though the whole class
    // was closed; it was half closed, and the test below matched the comment
    // rather than the claim in its own name.
    //
    // What "mid-path" means, precisely: the root is glued to the END of a path
    // component. That is a component character (`\w~`) directly before the
    // match, or such a character with only separators between it and the match
    // — the latter is the `/var/lib//data` doubling, where the match can start
    // one character to the right of the pair. Both shapes, one variable-length
    // lookbehind: `[\w~]` optionally followed by the same `{1,2}` separator
    // run the body uses.
    //
    // The first version of this fix forbade `.`, `-` and bare separators as
    // predecessors too, and those rejections UNREDACTED text that is real and
    // on its way into a public issue: `file:///Users/x` — every frame of a
    // Node ESM stack trace; the match starts at a separator preceded by
    // another separator — and `-/Users/x`, a diff's removed line. This
    // function is a security control; when a predecessor is ambiguous, the
    // cost of matching is a slightly over-redacted diagnostic, the cost of
    // not matching is an account name published on a public tracker. So the
    // lookbehind names the two component-glue shapes and nothing else.
    const body = escaped.replace(/\\\\|\//g, '[\\\\/]{1,2}');
    out = out.replace(new RegExp(`(?<![\\w~](?:[\\\\/]{1,2})?)${body}(?=[\\\\/]|$)`, flags), '~');
  }
  return out;
}
