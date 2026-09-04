#!/usr/bin/env node
//
// Entry-point execution gate
// ===========================
//
// Every other gate in this repo asks "does the file exist", "does it parse",
// "is it in the tarball". None of them ever run the thing. That is how
// `.mcp.json` shipped naming a deleted server file — every MCP tool failed
// with `-32000 failed to reconnect`, and no gate said a word (see the
// comment on `mcpEntry()` in scripts/lib/executable-targets.mjs) — and it is
// how a `${CLAUDE_PLUGIN_ROOT}` placeholder that cannot resolve outside a
// plugin loader has shipped in `.mcp.json` since 2026-05-13 without any
// check noticing.
//
// This gate spawns every declared bin (`package.json` `bin`) and every
// declared hook (`hooks/hooks.json`) once, with `process.execPath` — never a
// shell, never PATH — and checks that it starts. "Starts" means something
// different for each kind of entry point; see ASSERTIONS below for the
// per-binary reasoning.
//
// It runs with MEMESH_DIR/MEMESH_DB_PATH pointed at a throwaway directory it
// creates and removes. Nothing it spawns is allowed to touch a real
// ~/.memesh, and nothing it spawns is allowed to make a network call:
// MEMESH_AUTO_UPDATE=0 and MEMESH_AUTO_DETECT_LLM=0 keep it hermetic and
// keep a developer's real OPENAI_API_KEY/ANTHROPIC_API_KEY out of a
// subprocess this gate spawns.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binTargets, hookCommands } from './lib/executable-targets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootOption = process.argv.indexOf('--root');
const packageDir = rootOption >= 0 ? path.resolve(process.argv[rootOption + 1] ?? '') : path.resolve(here, '..');

const DEFAULT_TIMEOUT_MS = 10_000;
// Measured locally (this session, darwin): a fresh memesh-router socket
// appears in ~1.5s, including opening and migrating a brand-new SQLite
// database. That is not this gate's floor — it runs unskipped on
// ubuntu-latest with no local measurement to lean on, and this repo has
// already paid for the lesson that a timeout sized to the fastest machine
// becomes a flaky red build elsewhere (vitest.config.ts's hookTimeout going
// 10s→30s for the same reason; CLAUDE.md records a degraded CI runner
// measured at 5x slower). This is a poll that returns the instant the
// readiness signal appears, so a generous ceiling costs the happy path
// nothing.
const DAEMON_READY_TIMEOUT_MS = 15_000;
const DAEMON_SHUTDOWN_GRACE_MS = 10_000;

/**
 * Which platforms cannot prove a given entry point starts, and why.
 *
 * Exported (not inlined) so a test can pin it without a Windows machine:
 * `tests/entry-points-start.test.ts` calls this with `'win32'`/`'darwin'`
 * directly rather than relying on CI to happen to run on the right OS the
 * day the pin needs checking.
 *
 * Only one entry exists today. `memesh-router` (src/host-runtime/router.ts)
 * calls `assertSecureLocalHostRuntimeSupported()` at MODULE SCOPE — line 16,
 * before any function boundary — and that call throws
 * `SECURE_LOCAL_HOST_RUNTIME_UNSUPPORTED` on win32 with no surrounding
 * try/catch anywhere between it and the module's top level. Windows support
 * for the secure local host runtime is an explicit, documented design
 * decision (config.ts:6-13), not a bug this gate should be reporting as one
 * — but the resulting failure is also not a clean "starts and reports
 * failure" the gate can assert on with confidence without a Windows machine
 * to verify the exact shape against. Skipping it, loudly, is more honest
 * than guessing at an assertion this repo cannot verify in this session.
 *
 * `memesh-host-claude`/`memesh-host-codex`/`memesh-host-acp` are NOT here:
 * all three read `MEMESH_HOST_CONFIG`/`--config` and throw "A host config
 * file is required…" BEFORE any Windows-specific code path is reached
 * (config.ts `readHostConfig` checks `configuredPath` before calling
 * `readHostConfigFile`, which is the only place `assertSecureLocalHostRuntimeSupported`
 * runs for those three). Their missing-config failure mode is identical on
 * every platform, so it is asserted on every platform — see ASSERTIONS
 * below, where two of the three currently fail that assertion for an
 * unrelated reason (a missing try/catch, not a Windows gap).
 *
 * @param {NodeJS.Platform} platform
 * @returns {{relativePath: string, reason: string}[]}
 */
export function computeSkipList(platform) {
  if (platform !== 'win32') return [];
  return [
    {
      relativePath: 'dist/host-runtime/router.js',
      reason:
        'memesh-router calls assertSecureLocalHostRuntimeSupported() at module scope ' +
        '(src/host-runtime/router.ts:16) with no try/catch — Windows is explicitly ' +
        'unsupported by design for the secure local host runtime (src/host-runtime/config.ts:6-13).',
    },
  ];
}

/**
 * `.mcp.json`/`hooks/hooks.json` both name their entry point as
 * `${CLAUDE_PLUGIN_ROOT}/...`. That placeholder is legitimate in exactly one
 * of the two manifests.
 *
 * `hooks/hooks.json` is reachable ONLY through Claude Code's plugin loader —
 * there is no "project-scoped hooks" auto-discovery the way there is for MCP
 * servers, so every hook command this repo ships is invoked with
 * CLAUDE_PLUGIN_ROOT defined by the harness that read the plugin manifest in
 * the first place. `scripts/hooks/_shared.js`'s `resolvePluginRoot()` even
 * recomputes the same root independently from `import.meta.url`, which is
 * belt-and-braces for a hook script that already knows it will always be
 * plugin-loaded — not evidence that the manifest string itself needs to
 * resolve some other way.
 *
 * `.mcp.json` is different: Claude Code ALSO auto-discovers a project-root
 * `.mcp.json` as a project-scoped MCP server declaration, independent of
 * whether MeMesh is installed as a plugin at all. In that load path nothing
 * defines CLAUDE_PLUGIN_ROOT, so `${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js`
 * is not a path — it is the literal seven characters `${CLAUDE_PLUGIN_ROOT}`
 * followed by a filename Claude Code will never resolve. This is the
 * `-32000 failed to reconnect` defect referenced at the top of this file.
 *
 * So each manifest gets checked against the substitution environment its
 * OWN real load path actually provides — not the pre-stripped path
 * `hookCommands()`/`mcpEntry()` in executable-targets.mjs return, which
 * unconditionally strips the `${CLAUDE_PLUGIN_ROOT}/` prefix for BOTH
 * manifests (that helper answers "what file, once resolved" — a different
 * question from "does this manifest's own load path resolve it"). Checking
 * the stripped path here would make this whole rule vacuous: it would find
 * nothing, in every manifest, forever.
 *
 * @param {string} rootDir
 * @returns {{manifest: string, variable: string, raw: string}[]}
 */
export function findUnresolvedPlaceholders(rootDir) {
  const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

  /** @type {Record<string, Record<string, string>>} */
  const substitutionEnvByManifest = {
    // Plugin-loader-only: CLAUDE_PLUGIN_ROOT is always defined when this file
    // is read.
    'hooks/hooks.json': { CLAUDE_PLUGIN_ROOT: rootDir },
    // Also reachable project-scoped, with no plugin loader in the picture —
    // nothing substitutes CLAUDE_PLUGIN_ROOT there.
    '.mcp.json': {},
  };

  const findings = [];
  for (const [manifest, substitutionEnv] of Object.entries(substitutionEnvByManifest)) {
    const full = path.join(rootDir, manifest);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full, 'utf8');
    for (const match of raw.matchAll(PLACEHOLDER)) {
      const variable = match[1];
      if (!(variable in substitutionEnv)) {
        findings.push({ manifest, variable, raw: match[0] });
      }
    }
  }
  return findings;
}

/** Poll `condition` until it is true or `timeoutMs` elapses. */
async function waitFor(condition, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Run a child to completion, capturing stdout/stderr/exit under a bound. */
function run(absolutePath, args, { input, env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [absolutePath, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout, stderr, status: null, timedOut: true });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code, timedOut: false });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// A minimal but valid top-level shape for a hook's stdout, per the real
// Claude Code contract this repo derived in
// tests/helpers/hook-output-contract.ts. That file is the source of truth —
// it is a full contract test wired into the ordinary vitest suite
// (tests/hooks/hook-output-contract.test.ts) and is NOT re-derived here.
// `scripts/` runs under plain `node`, with no TypeScript loader, so it
// cannot import a `.ts` module; duplicating its full ~200-line contract
// (per-event hookSpecificOutput field allowlists) into this file would be
// the second copy of a list this repo has already been bitten by (see the
// header comment in executable-targets.mjs). This is deliberately a lighter
// subset — enough to catch a hook that starts printing raw text or an
// invalid event name, not a replacement for the real contract test.
const HOOK_TOP_LEVEL_FIELDS = [
  'continue', 'suppressOutput', 'stopReason', 'decision', 'reason', 'systemMessage', 'hookSpecificOutput',
];

function isPlausibleHookOutput(stdout, boundEvent) {
  const trimmed = stdout.trim();
  if (trimmed === '') return { ok: true };

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: `printed non-JSON, non-empty stdout: ${trimmed.slice(0, 200)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'stdout JSON is not an object' };
  }
  const unknown = Object.keys(parsed).filter((key) => !HOOK_TOP_LEVEL_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown top-level field(s): ${unknown.join(', ')}` };
  }
  if ('hookSpecificOutput' in parsed) {
    const event = parsed.hookSpecificOutput?.hookEventName;
    if (event !== undefined && event !== boundEvent) {
      return { ok: false, reason: `hookSpecificOutput.hookEventName is "${event}", bound event is "${boundEvent}"` };
    }
  }
  return { ok: true };
}

/** A raw Node uncaught-exception dump has indented `at ...` stack frames. */
function looksLikeStackTrace(stderr) {
  return /^\s{2,}at .+/m.test(stderr);
}

async function main() {
  const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-'));
  // Belt-and-suspenders: mkdtemp already defaults to 0700 on every platform
  // this gate runs on, but the router's own startup check (agent-router.ts
  // `start()`: `(directoryMode & 0o077) !== 0` throws `insecure_socket_directory`)
  // is exactly the kind of check this gate exists to actually exercise, not
  // assume past. Making it explicit removes any dependency on umask.
  fs.chmodSync(gateRoot, 0o700);
  const memeshDir = path.join(gateRoot, '.memesh');
  fs.mkdirSync(memeshDir, { recursive: true });
  const memeshDbPath = path.join(memeshDir, 'kg.db');
  // NESTED under gateRoot, not a sibling of it — a sibling's directory is
  // `os.tmpdir()` itself, which is the shared, world-writable system temp dir
  // on Linux (`/tmp`, mode 1777), not gateRoot's own private (0700)
  // directory. That is precisely the failure this router rejects: measured
  // on ubuntu-latest CI, `memesh-router` refused to start with
  // `insecure_socket_directory: Router socket directory must be private` —
  // masked locally on macOS only because `os.tmpdir()` there already
  // resolves to a per-user 0700 directory, so the bug was invisible on the
  // one platform this gate had been run on before it first reached CI.
  // AF_UNIX paths are capped at 103 bytes (agent-router.ts `validateSocketPath`);
  // nesting one level costs one path separator — measured 66 bytes total on
  // macOS's unusually long tmpdir (`/var/folders/.../T/mep-XXXXXX/r.sock`),
  // well inside the limit, and shorter still on Linux's `/tmp`.
  const routerSocket = path.join(gateRoot, 'r.sock');
  const routerTokenFile = path.join(gateRoot, 'r.token');

  const baseEnv = {
    ...process.env,
    MEMESH_DIR: memeshDir,
    MEMESH_DB_PATH: memeshDbPath,
    MEMESH_AUTO_UPDATE: '0',
    MEMESH_AUTO_DETECT_LLM: '0',
  };
  delete baseEnv.MEMESH_HOST_CONFIG;

  // Two distinct kinds of finding, reported and counted separately: an
  // entry point that did not start (counted against `checked`) and a
  // manifest placeholder finding (not an entry point at all — findings.mjs
  // once conflated these into one `failures` list, which made
  // `checked - failures.length` under-report the started count by one for
  // every placeholder finding and mislabeled the FAIL summary as "entry
  // point(s) did not start" when one of them was a manifest string.
  const entryFailures = [];
  const placeholderFindings = [];
  const skipped = [];
  let checked = 0;

  const record = (label, promise) => promise.then(
    (detail) => { checked += 1; process.stdout.write(`  ok    ${label}\n`); return detail; },
    (error) => {
      checked += 1;
      entryFailures.push({ label, message: error.message });
      process.stdout.write(`  FAIL  ${label} — ${error.message}\n`);
    },
  );

  // --- Assertions, one per entry-point kind ------------------------------
  //
  // "Starts" means something different per kind; each function below is the
  // cheapest thing that actually proves it, chosen after reading the source
  // it exercises (cited in each comment).

  /** `memesh` — a commander CLI. --version exits 0 and prints the version
   * without touching the DB or the network; it is the cheapest proof the
   * binary parses argv and its command tree loads at all. */
  async function assertCliVersion(absolutePath, env) {
    const result = await run(absolutePath, ['--version'], { env });
    if (result.timedOut) throw new Error(`timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    if (result.status !== 0) throw new Error(`exited ${result.status}\nstderr: ${result.stderr.slice(0, 500)}`);
    if (result.stdout.trim() === '') throw new Error('--version printed nothing');
  }

  /** `memesh-mcp` — an MCP stdio server. Its entire contract is "read
   * JSON-RPC frames from stdin until it closes, then exit"; EOF on stdin is
   * the exact signal a disconnecting client sends, and is the only thing
   * this gate can prove without a live MCP handshake. Verified empirically
   * (2026-09-02, this session): closing stdin makes it exit 0 immediately
   * rather than hang, so a bound here is a real assertion, not a safety net
   * for a process this gate is about to kill regardless. */
  async function assertMcpStdioEof(absolutePath, env) {
    const result = await run(absolutePath, [], { input: '', env });
    if (result.timedOut) throw new Error(`did not exit on stdin EOF within ${DEFAULT_TIMEOUT_MS}ms`);
    if (result.status !== 0) throw new Error(`exited ${result.status} on stdin EOF\nstderr: ${result.stderr.slice(0, 500)}`);
  }

  /** `memesh-http` — a long-lived Express server (src/transports/http/server.ts).
   * It never reads stdin, so EOF proves nothing; it prints
   * "MeMesh HTTP server running at …" from inside its `listen` callback
   * (server.ts:1643) once it has actually bound a socket, which is the
   * earliest true "started" signal available without an HTTP round trip.
   * MEMESH_HTTP_PORT=0 asks the OS for an ephemeral port so this cannot
   * collide with a real server or another gate run in CI. */
  async function assertHttpDaemon(absolutePath, env) {
    const child = spawn(process.execPath, [absolutePath], {
      env: { ...env, MEMESH_HTTP_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exitInfo = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
    try {
      await waitFor(() => stdout.includes('running at') || exitInfo !== null, 'memesh-http to report it is listening', DAEMON_READY_TIMEOUT_MS);
      if (exitInfo !== null) throw new Error(`exited before listening (${JSON.stringify(exitInfo)})\nstderr: ${stderr.slice(0, 500)}`);
    } finally {
      if (exitInfo === null) {
        child.kill('SIGTERM');
        try {
          await waitFor(() => exitInfo !== null, 'memesh-http to exit after SIGTERM', DAEMON_SHUTDOWN_GRACE_MS);
        } catch {
          child.kill('SIGKILL');
        }
      }
    }
    if (exitInfo !== null && exitInfo.code !== 0 && exitInfo.code !== null) {
      throw new Error(`memesh-http did not shut down cleanly on SIGTERM (${JSON.stringify(exitInfo)})`);
    }
  }

  /** `memesh-router` — a Unix-domain-socket daemon (src/host-runtime/router.ts).
   * Like the HTTP server it never reads stdin. It creates the socket file
   * inline in module top-level code (no "ready" log line to grep for), so
   * the socket's existence on disk IS the started signal — the same proof
   * scripts/smoke-packed-artifact.mjs uses for the same reason. */
  async function assertRouterDaemon(absolutePath, env) {
    const child = spawn(process.execPath, [absolutePath], {
      env: { ...env, MEMESH_ROUTER_SOCKET: routerSocket, MEMESH_ROUTER_TOKEN_FILE: routerTokenFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let exitInfo = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
    try {
      await waitFor(() => fs.existsSync(routerSocket) || exitInfo !== null, 'memesh-router to create its socket', DAEMON_READY_TIMEOUT_MS);
      if (exitInfo !== null) throw new Error(`exited before creating a socket (${JSON.stringify(exitInfo)})\nstderr: ${stderr.slice(0, 500)}`);
    } finally {
      if (exitInfo === null) {
        child.kill('SIGTERM');
        try {
          await waitFor(() => exitInfo !== null, 'memesh-router to exit after SIGTERM', DAEMON_SHUTDOWN_GRACE_MS);
        } catch {
          child.kill('SIGKILL');
        }
      }
      for (const f of [routerSocket, routerTokenFile]) {
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
      }
    }
    if (exitInfo !== null && exitInfo.code !== 0 && exitInfo.code !== null) {
      throw new Error(`memesh-router did not shut down cleanly on SIGTERM (${JSON.stringify(exitInfo)})`);
    }
  }

  /** `memesh-host-claude` / `memesh-host-codex` / `memesh-host-acp` — each
   * needs a host config file (`--config` or MEMESH_HOST_CONFIG) it will not
   * find here. All three call `readHostConfig()` (src/host-runtime/config.ts:15),
   * which throws "A host config file is required…" before touching stdin or
   * any Windows-gated code path. The REQUIRED behaviour (spec, and this
   * gate) is: fail closed with a named error and a non-crash exit — not a
   * raw Node stack trace.
   *
   * All three now meet this — `codex.ts`/`acp.ts` originally called
   * `await run…Host()` at top level with no try/catch and Node dumped the
   * raw exception with stack frames; CHANGELOG.md's "Every host runtime now
   * fails closed with the reason, not a stack trace" entry (fix/host-runtimes-
   * fail-closed) gave every host runtime one shared `runHostEntry` wrapper
   * instead of three hand-copied try/catch blocks, precisely so this
   * assertion could stop being written to a spec none of them met yet. */
  async function assertHostRuntimeFailsClosed(absolutePath, env) {
    const result = await run(absolutePath, [], { input: '', env });
    if (result.timedOut) throw new Error(`timed out after ${DEFAULT_TIMEOUT_MS}ms instead of failing closed`);
    if (result.status === 0) throw new Error('exited 0 with no host config — expected a fail-closed non-zero exit');
    if (result.stderr.trim() === '') throw new Error(`exited ${result.status} with no stderr message — a fail-closed exit must name the error`);
    if (looksLikeStackTrace(result.stderr)) {
      throw new Error(
        `exited ${result.status} but stderr is a raw stack trace, not a named error:\n${result.stderr.slice(0, 800)}`,
      );
    }
  }

  /** `memesh-host-codex-session` (both the `bin` entry and the async
   * SessionStart hook — same file, src/host-runtime/codex-session.ts).
   * Unlike the three above, its `main()` checks
   * `fs.existsSync(configPath)` FIRST (codex-session.ts:99-100) and returns
   * before ever reading stdin when no host config exists — a silent,
   * successful no-op is the documented safe behaviour here, not a bug. */
  async function assertCodexSessionOptionalConfig(absolutePath, env, payload) {
    const result = await run(absolutePath, [], { input: JSON.stringify(payload), env });
    if (result.timedOut) throw new Error(`timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    if (result.status !== 0) throw new Error(`exited ${result.status} with no host config present (expected a quiet no-op)\nstderr: ${result.stderr.slice(0, 500)}`);
  }

  /** The eight ordinary hook scripts under scripts/hooks/. Each gets the
   * minimal well-formed payload for the event it is bound to (same shapes
   * used by tests/hooks/hook-output-contract.test.ts's HOOK_CASES, without
   * the memory seeding that test uses to force specific branches — this
   * gate only needs to prove the process starts and speaks the contract,
   * not exercise every branch). */
  async function assertHookStarts(absolutePath, env, boundEvent, payload) {
    const result = await run(absolutePath, [], {
      input: JSON.stringify(payload),
      env: { ...env, MEMESH_AUTO_UPDATE: '0' },
      timeoutMs: 15_000,
    });
    if (result.timedOut) throw new Error('timed out after 15000ms');
    if (result.status !== 0) throw new Error(`exited ${result.status}\nstderr: ${result.stderr.slice(0, 500)}`);
    const shape = isPlausibleHookOutput(result.stdout, boundEvent);
    if (!shape.ok) throw new Error(shape.reason);
  }

  // --- Profiles: which assertion applies to which declared relativePath --
  //
  // Keyed by relativePath (unique across the whole derived list, unlike
  // basename — dist/mcp/server.js and dist/transports/http/server.js are
  // both literally "server.js"). An entry the derivation produces with no
  // profile here is NOT silently passed — see the fallback below.
  const projectCwd = path.join(gateRoot, 'project');
  const hookPayload = (overrides) => ({
    session_id: 'entry-point-gate',
    cwd: projectCwd,
    ...overrides,
  });

  const PROFILES = {
    'dist/transports/cli/cli.js': { run: (abs, env) => assertCliVersion(abs, env) },
    'dist/mcp/server.js': { run: (abs, env) => assertMcpStdioEof(abs, env) },
    'dist/transports/http/server.js': { run: (abs, env) => assertHttpDaemon(abs, env) },
    'dist/host-runtime/router.js': { run: (abs, env) => assertRouterDaemon(abs, env) },
    'dist/host-runtime/claude.js': { run: (abs, env) => assertHostRuntimeFailsClosed(abs, env) },
    'dist/host-runtime/codex.js': { run: (abs, env) => assertHostRuntimeFailsClosed(abs, env) },
    'dist/host-runtime/acp.js': { run: (abs, env) => assertHostRuntimeFailsClosed(abs, env) },
    'dist/host-runtime/codex-session.js': {
      run: (abs, env) => assertCodexSessionOptionalConfig(abs, env, hookPayload({ hook_event_name: 'SessionStart', source: 'startup' })),
    },
    'scripts/hooks/pre-edit-recall.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'PreToolUse', hookPayload({
        hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(projectCwd, 'src/x.ts') },
      })),
    },
    'scripts/hooks/guard-check.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'PreToolUse', hookPayload({
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' },
      })),
    },
    'scripts/hooks/session-start.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'SessionStart', hookPayload({
        hook_event_name: 'SessionStart', source: 'startup',
      })),
    },
    'scripts/hooks/post-commit.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'PostToolUse', hookPayload({
        hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_input: { command: 'git commit -m test' },
        tool_response: { stdout: '[main abc1234] test' },
      })),
    },
    'scripts/hooks/decision-nudge.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'PostToolUse', hookPayload({
        hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'entry-point gate smoke' },
      })),
    },
    'scripts/hooks/session-summary.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'Stop', hookPayload({
        hook_event_name: 'Stop', transcript_path: '',
      })),
    },
    'scripts/hooks/pre-compact.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'PreCompact', hookPayload({
        hook_event_name: 'PreCompact', transcript_path: '', reason: 'auto',
      })),
    },
    'scripts/hooks/user-prompt-intent.js': {
      run: (abs, env) => assertHookStarts(abs, env, 'UserPromptSubmit', hookPayload({
        hook_event_name: 'UserPromptSubmit', prompt: 'hello',
      })),
    },
  };

  try {
    // --- Requirement 1: the list is derived, never hand-written ----------
    // `binTargets`/`hookCommands` (scripts/lib/executable-targets.mjs) return
    // plain relative-path lists — the single derivation every consumer in
    // this repo shares (see that file's own header comment for why there is
    // exactly one). The bin NAME (e.g. "memesh-mcp") is not part of that
    // return value, so it is recovered here, once, from the same
    // package.json `bin` map the derivation itself reads — for the log
    // label only; PROFILES below is keyed on relativePath, not on this name.
    const bins = binTargets(packageDir);
    const hooks = hookCommands(packageDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const binNameByPath = new Map(
      Object.entries(pkg.bin ?? {}).map(([name, relativePath]) => [relativePath, name]),
    );
    const skipList = computeSkipList(process.platform);
    const skippedPaths = new Set(skipList.map((s) => s.relativePath));

    process.stdout.write(`entry-point-start: ${bins.length} bin(s) + ${hooks.length} hook(s) derived from package.json / hooks/hooks.json\n`);

    for (const skip of skipList) {
      skipped.push(skip);
      process.stdout.write(`  SKIP  ${skip.relativePath} — ${skip.reason}\n`);
    }

    const entries = [
      ...bins.map((relativePath) => ({
        label: `bin ${binNameByPath.get(relativePath) ?? relativePath} (${relativePath})`,
        relativePath,
      })),
      ...hooks.map((relativePath) => ({ label: `hook (${relativePath})`, relativePath })),
    ];

    for (const entry of entries) {
      if (skippedPaths.has(entry.relativePath)) continue;
      const absolutePath = path.join(packageDir, entry.relativePath);
      if (!fs.existsSync(absolutePath)) {
        entryFailures.push({ label: entry.label, message: `${entry.relativePath} does not exist — run \`npm run build\` first` });
        process.stdout.write(`  FAIL  ${entry.label} — does not exist\n`);
        checked += 1;
        continue;
      }
      const profile = PROFILES[entry.relativePath];
      if (!profile) {
        // Requirement 1: a new manifest entry must be covered automatically.
        // It cannot be covered by a correct assertion nobody wrote yet, so
        // it is covered by failing loudly instead of silently passing.
        entryFailures.push({
          label: entry.label,
          message: `no execution profile defined for ${entry.relativePath} in scripts/check-entry-points-start.mjs — add one to PROFILES`,
        });
        process.stdout.write(`  FAIL  ${entry.label} — no execution profile\n`);
        checked += 1;
        continue;
      }
      await record(entry.label, profile.run(absolutePath, baseEnv));
    }

    // --- Requirement 5: unresolved ${...} placeholders are a failure -----
    // Not an entry point, so kept out of `checked`/`entryFailures` — folding
    // it in there is what previously made `checked - entryFailures.length`
    // under-report the started count and mislabeled the FAIL summary as
    // "entry point(s) did not start" for a manifest string.
    const placeholders = findUnresolvedPlaceholders(packageDir);
    for (const finding of placeholders) {
      placeholderFindings.push({
        label: `placeholder in ${finding.manifest}`,
        message: `${finding.manifest} still contains the unresolved placeholder ${finding.raw} — nothing substitutes ${finding.variable} in this manifest's real load path`,
      });
      process.stdout.write(`  FAIL  placeholder ${finding.raw} in ${finding.manifest}\n`);
    }
  } finally {
    // Best-effort, not guaranteed: session-start.js always spawns a
    // detached, unref'd `memesh status` to refresh its update-check cache
    // (scripts/hooks/session-start.js `spawnFreshUpdateCheck` — this is
    // unconditional, MEMESH_AUTO_UPDATE only gates the separate auto-INSTALL
    // policy, not this cache refresh). That child can still be writing
    // `update-check.<version>.json` into gateRoot after this hook process
    // has already exited, which occasionally beats this rmSync and leaves a
    // small directory behind. tests/helpers/temp-dir.ts documents the exact
    // same race for the vitest suite (which spawns session-start.js far
    // more often, in the same CI job, via `npm test -- --run` right after
    // this gate); a leaked temp file is harmless on a CI runner and retrying
    // forever cannot outlast a process still writing, so this is a bounded
    // best-effort clean, not a correctness requirement.
    try { fs.rmSync(gateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    for (const f of [routerSocket, routerTokenFile]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  }

  process.stdout.write(
    `entry-point-start: ${checked - entryFailures.length}/${checked} entry point(s) started` +
      (skipped.length ? `, ${skipped.length} skipped` : '') +
      (placeholderFindings.length ? `, ${placeholderFindings.length} manifest placeholder finding(s)` : '') +
      '\n',
  );

  const totalFailures = entryFailures.length + placeholderFindings.length;
  if (totalFailures > 0) {
    process.stderr.write(
      `entry-point-start: FAIL (${entryFailures.length} entry point(s) did not start, ` +
        `${placeholderFindings.length} manifest placeholder finding(s))\n`,
    );
    for (const f of [...entryFailures, ...placeholderFindings]) process.stderr.write(`  - ${f.label}: ${f.message}\n`);
    process.exit(1);
  }

  process.stdout.write('entry-point-start: PASS\n');
}

// Guard `main()` behind an entrypoint check — mirroring the same pattern
// src/host-runtime/{claude,codex,acp,codex-session}.ts already use — so that
// `computeSkipList`/`findUnresolvedPlaceholders` can be imported directly by
// tests (tests/entry-points-start.test.ts) without running the whole gate,
// spawning 17 processes, and calling `process.exit()`, as an import side
// effect inside the vitest worker.
function isMainModule() {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return fs.realpathSync(entrypoint) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
