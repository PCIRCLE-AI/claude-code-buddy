#!/usr/bin/env node

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, readFileSync, unlinkSync, mkdirSync, accessSync, constants as fsConstants } from 'fs';
import {
  buildReferenceContext,
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  HOOK_BUSY_TIMEOUT_MS,
  importFromPluginRoot,
  assembleTopologyBlock,
  DEFAULT_TOPOLOGY_BUDGET,
  SNIPPET_FETCH_CHARS,
  TOPOLOGY_CANDIDATE_CAP,
  isTrustedForAutoContext,
  parseEntityMetadata,
  // Aliased: this file already has a local `const memeshDir` (a resolved
  // db-path-derived directory string) — the helper here is the MEMESH_DIR/
  // home resolver the update-check cache itself uses.
  memeshDir as memeshHomeDir,
  parseTaskState,
  readUpdateCheckCache,
  resolvePluginRoot,
  resolveSessionLimit,
  taskStateLines,
  homeDir,
  taskStateName,
  writeCitationRule,
  writePrivateJson,
} from './_shared.js';
import { MemeshDatabase } from './_generated/sqlite.js';

const require = createRequire(import.meta.url);

// Codex round 37: dist/core/install-channel.js is emitted as ESM
// (the project's tsconfig produces NodeNext modules). On Node 20.x
// `require()` against an ESM file throws ERR_REQUIRE_ESM, which
// silently downgraded all install-channel detection to 'unknown' on
// the supported floor. Pre-load the module via dynamic `import()`
// at hook startup using a top-level await — once at process init,
// not on every call. Falls back to null if the dist file is
// missing (source checkout pre-build) or fails to load.
let _installChannelMod = null;
try {
  const _pluginRootForInit = resolvePluginRoot(import.meta.url);
  const _modPath = join(_pluginRootForInit, 'dist/core/install-channel.js');
  if (existsSync(_modPath)) {
    _installChannelMod = await import(pathToFileURL(_modPath).href);
  }
} catch { /* best-effort — fall through to 'unknown' channel */ }

const dbPath = getDbPath();
const memeshDir = getMemeshDirFromDbPath();
const throttlePath = join(memeshDir, 'session-recalled-files.json');

/**
 * Build the strong deprecation warning lines to prepend to the
 * session-start banner when the installed version has been flagged
 * by maintainers (typically a security advisory). Returns an empty
 * array when the cache says nothing to warn about.
 */
function buildDeprecationBanner(currentVersion, cache) {
  if (!cache || cache.currentVersion !== currentVersion) return [];
  const msg = cache.currentVersionDeprecation;
  if (typeof msg !== 'string' || msg.length === 0) {
    // Partial-failure state ONLY: the version lookup answered but
    // the deprecation sub-call did not. checkSucceeded stays true
    // exactly in that case. A full registry failure (offline,
    // blocked) leaves checkSucceeded=false with a generic lastError,
    // and we must not surface that as a security-style warning —
    // it's just regular "couldn't reach npm". Gate the banner
    // strictly on checkSucceeded=true + lastError populated.
    if (
      cache.checkSucceeded === true
      && typeof cache.lastError === 'string'
      && cache.lastError.length > 0
    ) {
      return [
        '',
        `ℹ️  MeMesh deprecation status unknown for ${currentVersion}: ${cache.lastError}`,
        `    Run: memesh status   (retry the lookup once back online)`,
      ];
    }
    return [];
  }
  const lines = [
    '',
    `⚠️  MeMesh ${currentVersion} is DEPRECATED by maintainers.`,
    `    ${msg}`,
  ];
  // Codex round 36: emit a remediation line for EVERY deprecation
  // banner — including the cases where the cached `latestVersion`
  // is null, equal to current, or stale. The previous gate omitted
  // the action line whenever the cache didn't yet show a strictly-
  // newer version, leaving users with a security warning and no
  // follow-up step. doctor / CLI status / dashboard already point
  // at `memesh update` (or channel equivalents) in those uncertain
  // cases, and the session-start banner should match — `npm`
  // resolves @latest at install time, so the command works even
  // when our local cache is uncertain.
  const knownUpgradeTarget = Boolean(
    cache.latestVersion && cache.latestVersion !== currentVersion,
  );
  // Codex round 39: the SessionStart hook reads ONLY cached cache
  // data — there's no fresh lookup happening on this code path.
  // That means `freshness === 'fresh'` (the strict rule the
  // dashboard / `memesh status` use to authoritatively say
  // "no upgrade target yet") can never apply here. Round 38 used a
  // 24h-window heuristic to fire the no-target message anyway, but
  // codex correctly flagged that as suppressing the upgrade hint
  // exactly when a security-advisory fix could ship within the
  // window. Conservative remediation: always recommend
  // `memesh update` (which is a harmless no-op when there's truly
  // no target, and immediately applies a freshly-published fix
  // when there is one). The "no target yet" message remains
  // available in `memesh status` (fresh lookup) and the dashboard
  // (after a Check now click).
  // Tailor the remediation hint to the install channel. `memesh
  // update` and `autoUpdate` only work for npm-global installs;
  // pointing source-checkout / project-local users at those
  // commands is misleading (especially when the deprecation is a
  // security advisory). Detect the channel and suggest the
  // remediation that actually applies.
  let channel = 'unknown';
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    channel = detectInstallChannelHook(pluginRoot);
  } catch { /* best-effort — fall through to generic guidance */ }

  if (channel === 'npm-global') {
    lines.push(
      knownUpgradeTarget
        ? `    Run: memesh update   (or set autoUpdate: memesh config set autoUpdate patch)`
        : `    Run: memesh update   (resolves @latest — or set: memesh config set autoUpdate patch)`,
    );
  } else if (channel === 'source-checkout') {
    lines.push(`    Source checkout: pull and rebuild (\`git pull && npm install && npm run build\`).`);
  } else if (channel === 'npm-local') {
    // Codex round 30: the cached `latestVersion` may itself be
    // stale (cache TTL is 24h and we're already showing a stale
    // banner). Pinning a specific version risks installing an
    // already-superseded build that's part of the same security
    // advisory. `@latest` always resolves to the registry's
    // current dist-tag at install time, which is the right
    // remediation for a deprecation/security-advisory banner.
    lines.push(
      knownUpgradeTarget
        ? `    Project-local install: run \`npm install @pcircle/memesh@latest\` in this project (cached upgrade target was ${cache.latestVersion}).`
        : `    Project-local install: run \`npm install @pcircle/memesh@latest\` in this project.`,
    );
  } else {
    lines.push(
      knownUpgradeTarget
        ? `    Upgrade via the install path you used: fetch the latest @pcircle/memesh from npm (cached upgrade target was ${cache.latestVersion}).`
        : `    Upgrade via the install path you used: fetch the latest @pcircle/memesh from npm.`,
    );
  }
  return lines;
}

/**
 * Build the softer "update available" banner that fires when the
 * installed version is NOT deprecated but a newer version exists on
 * npm. Lighter than the deprecation banner (single info line, no
 * security framing), and throttled to once per 24h so the user isn't
 * nagged on every session.
 *
 * Throttle marker lives at ~/.memesh/last-update-banner.<version>.lock.
 * Scoped by version so an upgrade from 4.2.3 → 4.2.4 immediately allows
 * the next "4.2.5 available" banner to fire instead of waiting out the
 * old version's TTL.
 */
const UPDATE_BANNER_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Return true iff `a` is strictly older than `b` under semver-ish
 * ordering. Compares the dot-separated numeric portion of each version
 * componentwise (so 4.2.10 > 4.2.9, unlike string compare). Anything
 * after the first non-numeric char falls back to lex compare on the
 * trailing fragment — fine for the prerelease / 4-segment build tags
 * memesh uses (e.g. 4.2.5-rc.1).
 */
function isStrictlyOlder(a, b) {
  const parse = (v) => {
    const [main, ...rest] = String(v).split(/[-+]/);
    const nums = main.split('.').map((s) => Number.parseInt(s, 10));
    return { nums, tail: rest.join('-') };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const ai = Number.isFinite(pa.nums[i]) ? pa.nums[i] : 0;
    const bi = Number.isFinite(pb.nums[i]) ? pb.nums[i] : 0;
    if (ai !== bi) return ai < bi;
  }
  // Numeric prefix tied. A prerelease tail counts as OLDER than no
  // tail (semver: 1.0.0-rc.1 < 1.0.0); otherwise lex on tail.
  if (pa.tail && !pb.tail) return true;
  if (!pa.tail && pb.tail) return false;
  return pa.tail < pb.tail;
}

function buildUpdateAvailableBanner(currentVersion, cache, getChannel) {
  if (!cache || cache.currentVersion !== currentVersion) return [];
  // Deprecation banner takes precedence — when set, it owns the
  // session-start real estate. Skip the soft banner so the user sees
  // one message, not two.
  if (typeof cache.currentVersionDeprecation === 'string'
      && cache.currentVersionDeprecation.length > 0) {
    return [];
  }
  if (!cache.latestVersion || cache.latestVersion === currentVersion) return [];
  // Numeric semver compare. Lexicographic compare (`'4.2.10' < '4.2.9'`
  // is true) would silently suppress the banner once patches hit two
  // digits. Split on `.`, compare each component as integer, prerelease
  // / build metadata after `-` or `+` falls back to lex compare. Keeps
  // the hook dep-free; full semver lives in version-check.ts.
  if (!isStrictlyOlder(currentVersion, cache.latestVersion)) return [];

  // Throttle. We use file mtime instead of a stored timestamp because
  // the operation is atomic on POSIX (`touch` / open-with-CREAT) and
  // we don't care about exact wall-clock — just "did we already show
  // this user a banner today?"
  try {
    const fs = require('fs');
    // memeshHomeDir(), not join(homedir(), '.memesh'): the throttle marker
    // must sit next to the update-check cache it throttles when MEMESH_DIR
    // is set (readUpdateCheckCache resolves its path with this same helper).
    const dir = memeshHomeDir();
    try { ensurePrivateDir(dir); } catch { /* best-effort */ }
    const versionTag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
    const markerPath = join(dir, `last-update-banner.${versionTag}.lock`);
    let stat;
    try { stat = fs.statSync(markerPath); } catch { stat = null; }
    if (stat && Date.now() - stat.mtimeMs < UPDATE_BANNER_THROTTLE_MS) {
      return [];
    }
    // Touch the marker BEFORE printing so a concurrent session that
    // races us doesn't both print the banner. Best-effort — failure
    // here just means the banner may show twice, which is annoying
    // but not broken.
    try {
      fs.writeFileSync(markerPath, String(Date.now()));
      try { fs.chmodSync(markerPath, 0o600); } catch { /* non-POSIX */ }
    } catch { /* best-effort */ }
  } catch { /* best-effort */ }

  // Channel detection spawns `npm root -g` (50-200ms) — resolve it only
  // here, after every early return above has had its chance to suppress
  // the banner. The guards fire on ~every session; the banner at most
  // once per 24h.
  let channel = 'unknown';
  try { channel = getChannel(); } catch { /* best-effort */ }

  const lines = [
    '',
    `ℹ️  MeMesh update available: ${cache.latestVersion} (you're on ${currentVersion}).`,
  ];
  if (channel === 'npm-global') {
    lines.push(`    Run: memesh update`);
  } else if (channel === 'plugin-marketplace') {
    lines.push(`    Run: memesh upgrade-plugin   (no CLI? npx @pcircle/memesh upgrade-plugin — or reinstall from /plugin UI)`);
  } else if (channel === 'source-checkout') {
    lines.push(`    Source checkout: \`git pull && npm install && npm run build\`.`);
  } else if (channel === 'npm-local') {
    lines.push(`    Project-local install: run \`npm install @pcircle/memesh@latest\` in this project.`);
  } else {
    lines.push(`    Upgrade via your install method (fetch @pcircle/memesh@latest from npm).`);
  }
  return lines;
}

/**
 * Detect the install channel of the running memesh binary by
 * delegating to src/core/install-channel.ts via the dist build. The
 * core helper resolves `npm root -g` so it correctly classifies:
 *   - POSIX globals at the default prefix (`/usr/local/lib/...`)
 *   - Windows globals (`%AppData%\npm\...`)
 *   - Globals at custom prefixes set via `npm config set prefix`
 *   - Project-local deps under any directory name (no false-positive
 *     'npm-global' from a path that merely contains `lib`)
 *
 * Earlier hook-side regex heuristics agreed with the core logic on
 * the common cases but disagreed on custom prefixes (false negative
 * → auto-update silently broken) and on project-local deps living
 * under `lib/node_modules/...` (false positive → spawning a global
 * `npm install -g` while the active copy is the local one). Using
 * the dist module here keeps the hook in lockstep with whatever
 * `memesh status` says, paying the one-time `npm root -g` cost
 * (~50-200ms) only on auto-update decision.
 *
 * Returns 'npm-global' | 'npm-local' | 'source-checkout' | 'unknown'.
 * Synchronous + best-effort: any failure in the dist import or the
 * underlying `npm root -g` call returns 'unknown', and the auto-
 * update spawn refuses to fire on 'unknown' so we never run
 * `npm install -g` when we can't confirm it would land where the
 * user expects.
 */
function detectInstallChannelHook(pluginRoot) {
  if (!_installChannelMod) return 'unknown';
  try {
    return _installChannelMod.getCurrentInstallChannel({ packageRoot: pluginRoot });
  } catch (err) {
    // Falling back to 'unknown' silences the deprecation banner's
    // remediation hint (since it's gated on channel detection). When
    // there's an active security-advisory deprecation, that's a
    // user-visible regression — surface to stderr at least once per
    // process so the reason is visible.
    try { process.stderr.write(`[memesh session-start] install-channel detection: ${err?.message || err}\n`); } catch {}
    return 'unknown';
  }
}

// Don't fire a fresh-check more often than this. Two parallel
// session-starts both spawning `memesh status` could otherwise race
// the cache: a later writer that hits a deprecation-only timeout
// would overwrite an earlier writer's successful deprecation flag,
// because each child reads `previous` from the cache *before* its
// own npm call. The TTL bounds concurrency to one refresh per
// window per machine, which is enough for the staleness window
// (24h) to stay accurate.
const FRESH_CHECK_THROTTLE_MS = 5 * 60 * 1000;

function spawnFreshUpdateCheck(installedVersion) {
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    const cliPath = join(pluginRoot, 'dist/transports/cli/cli.js');
    if (!existsSync(cliPath)) return false;
    const fs = require('fs');
    // memeshHomeDir(), not join(homedir(), '.memesh') — same reasoning as
    // the banner marker above: marker and cache must share a directory.
    const dir = memeshHomeDir();
    try { ensurePrivateDir(dir); } catch { /* best-effort */ }
    // Codex round 37: scope the throttle marker to the installed
    // version. The marker was machine-global, so a refresh started
    // by a global 4.1.3 install would suppress refreshes for a
    // sibling project-local 4.1.1 for the next 5 minutes — and the
    // shared cache it wrote would carry version 4.1.3, so the
    // 4.1.1 session would skip its banner because
    // `cache.currentVersion !== currentVersion`. Per-version
    // markers ensure each install gets its own refresh window.
    // Sanitize version for filesystem (semver chars only, no path
    // separators); fall back to 'unknown' if missing.
    const versionTag = typeof installedVersion === 'string'
      && /^[0-9A-Za-z.+-]+$/.test(installedVersion)
      ? installedVersion
      : 'unknown';
    const markerPath = join(dir, `last-fresh-refresh.${versionTag}.lock`);
    // Single-owner claim: O_EXCL atomic create. Codex round 27
    // caught that the previous temp+rename+readback pattern was
    // racy — both peers' renames are destructive, so each could
    // read its own token back and both would spawn a refresh.
    // O_EXCL is the standard POSIX/libuv primitive that lets at
    // most one process succeed. Same pattern as
    // tryAcquireAutoUpdateLock above.
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const claim = () => {
      try {
        const fd = fs.openSync(
          markerPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
        return 'won';
      } catch (err) {
        if (err?.code === 'EEXIST') return 'exists';
        return 'error';
      }
    };
    let result = claim();
    if (result === 'exists') {
      // Marker already there. Honor the throttle window: if it's
      // fresh, a peer owns this slot. If it's stale, take it over
      // by removing the marker and retrying ONCE — best-effort,
      // multiple processes may race the unlink but only one can
      // win the subsequent O_EXCL.
      let stat;
      try { stat = fs.statSync(markerPath); } catch { return false; }
      if (Date.now() - stat.mtimeMs < FRESH_CHECK_THROTTLE_MS) {
        return false;
      }
      try { fs.unlinkSync(markerPath); } catch { /* peer already removed */ }
      result = claim();
    }
    if (result !== 'won') return false;
    const child = spawn(
      process.execPath,
      [cliPath, 'status'],
      // windowsHide prevents a console-window flash on every session
      // start on Windows; harmless on POSIX.
      {
        detached: true,
        stdio: 'ignore',
        // `memesh status` already forces a fresh npm lookup (getUpdateCheck
        // with preferFresh, the default) and rewrites the cache — so the
        // spawn itself is the refresh. An earlier MEMESH_UPDATE_REFRESH='1'
        // env var here had NO reader anywhere and did nothing; removed.
        env: { ...process.env },
        windowsHide: true,
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the post-banner update tasks: spawn auto-update if policy + cache
 * permit, and always refresh the cache for the next session.
 *
 * Known one-session delay (documented):
 *   The very first session after install (or after the cache file is
 *   deleted) emits the recall summary BEFORE this finally clause
 *   runs, so a freshly-installed deprecated version sees no
 *   deprecation banner on session 1. The detached refresh below
 *   populates the cache for session 2, where the banner and the
 *   security override fire normally. We deliberately don't do an
 *   inline synchronous npm fetch here because that would block every
 *   cold-cache session-start by ~3s for users whose installed version
 *   is healthy — a worse trade for the common case.
 *
 * Idempotent guard: callers should not invoke twice for the same
 * session — duplicated `npm install -g` spawns would race. We use a
 * one-shot flag rather than a no-op-on-second-call lock so a coding
 * mistake produces visible breakage during testing instead of silent
 * over-spawning.
 */
let __postBannerRan = false;
function runPostBannerUpdateTasks() {
  if (__postBannerRan) return;
  __postBannerRan = true;
  try {
    let installedVersion = null;
    try {
      const pluginRoot = resolvePluginRoot(import.meta.url);
      const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
      installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
    } catch { /* best-effort */ }
    if (!installedVersion) return;
    // Auto-update spawn moved to Stop hook (v4.1.4) to avoid TOCTOU race
    // where npm install -g overwrites dist/ while peer hooks are still reading it.
    spawnFreshUpdateCheck(installedVersion);
  } catch {
    // Best-effort — never crash the hook on a network or fs hiccup.
  }
}

/**
 * Can the capture hooks actually write? Returns the offending path, or null.
 *
 * Probes the two things a capture hook needs and nothing else: the memesh
 * directory has to exist and be writable, and where the database file already
 * exists, that file has to be writable too. The second half matters on its
 * own — a writable directory holding a read-only database is a state the old
 * mkdir-only probe called healthy, and it is exactly what a botched `sudo`
 * leaves behind.
 *
 * `accessSync(W_OK)` rather than opening a handle: this is the SessionStart
 * hot path, and a read-write open would run the whole migration chain here
 * just to answer a permissions question. It is one syscall and it fails in
 * the same cases EACCES would.
 *
 * Deliberately not detected: a full disk. No cheap probe finds it, and
 * claiming otherwise would be worse than the honest gap.
 */
function captureTargetUnwritable() {
  try {
    mkdirSync(memeshDir, { recursive: true });
    accessSync(memeshDir, fsConstants.W_OK);
  } catch {
    return memeshDir;
  }
  // The WAL/SHM sidecars are probed too: an interrupted `sudo` run leaves a
  // user-owned database next to root-owned `-wal`/`-shm` files, and SQLite
  // then fails every write with EACCES while the db file itself probes
  // writable — the most common botched-sudo residue, and exactly the state
  // the db-file probe alone called healthy.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (!existsSync(p)) continue;
    try {
      accessSync(p, fsConstants.W_OK);
    } catch {
      return p;
    }
  }
  return null;
}

/**
 * Build a "base message + optional deprecation banner" combined
 * single-line systemMessage payload. Keeps stdout a single JSON
 * object on every empty/no-DB exit path so Claude Code's hook
 * contract holds.
 */
function combineWithBanner(baseMessage) {
  let lines = [];
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    const installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
    const cache = readUpdateCheckCache(installedVersion);
    if (installedVersion) {
      const deprecation = buildDeprecationBanner(installedVersion, cache);
      // Deprecation owns the spot when present; the update-available
      // banner is the fallback for the much more common "not flagged,
      // just out of date" case.
      if (deprecation.length > 0) {
        lines = deprecation;
      } else {
        lines = buildUpdateAvailableBanner(
          installedVersion, cache, () => detectInstallChannelHook(pluginRoot));
      }
    }
  } catch {
    // Best-effort — fall through to base message only.
  }
  if (lines.length === 0) return baseMessage;
  return [...lines.filter((l) => l.length > 0), '', baseMessage].join('\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  // Hoisted above both try blocks: the recall-failure catch below must be
  // able to lead with this warning too, or a capture-dead session that ALSO
  // hits a recall error silently drops the more important half of the story.
  let captureWarning = null;
  const withCaptureWarning = (msg) => {
    if (!captureWarning) return msg;
    return `${captureWarning}\n${msg.replace(/^◉ MeMesh ready · /, '◉ MeMesh · ')}`;
  };
  try {
    try {
    const data = JSON.parse(input);
    const projectName = getProjectName(data.cwd);

    // Self-heal the citation contract.
    //
    // `install-hooks` writes it too, but a PLUGIN install never runs that
    // command — and plugin is how most users arrive. Without this, the
    // contract would reach only npm installs, which is the same shape as the
    // bug it exists to fix: a mechanism that is correct on a path nobody
    // takes. Idempotent (a byte-identical file is left alone), refuses to
    // touch a file memesh did not write, and never blocks the session: a
    // failure here traces and the hook carries on.
    try {
      // Scope comes from the install marker, NOT hardcoded to 'user'. A
      // `--scope project` install keeps everything inside that project, and
      // writing the contract to ~/.claude/rules/ anyway would leak it into
      // every OTHER project on the machine — and survive
      // `uninstall-hooks --scope project`, which only knows about the
      // project path. No marker means a plugin install, which is user-level
      // by construction.
      let ruleScope = 'user';
      try {
        const markerPath = join(memeshHomeDir(), 'install-hooks.json');
        if (existsSync(markerPath)) {
          const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
          if (marker?.scope === 'project') ruleScope = 'project';
        }
      } catch { /* unreadable marker → user scope, the safe default */ }
      writeCitationRule(ruleScope, homeDir(), data.cwd || process.cwd());
    } catch (err) {
      try { process.stderr.write(`[memesh session-start] citation rule: ${err?.message || err}\n`); } catch {}
    }

    // Clear per-session throttle files from previous session
    try {
      if (existsSync(throttlePath)) {
        unlinkSync(throttlePath);
      }
    } catch {
      // Non-critical
    }

    // Every banner below this line is a PROMISE that memories will be saved,
    // so check that it can be kept before making any of them.
    //
    // This probe used to live INSIDE the `!existsSync(dbPath)` branch below,
    // which meant it only ever ran before the database existed — while the
    // failure it detects has nothing to do with first runs. A `~/.memesh` that
    // became unwritable later (permissions changed, a read-only mount, a
    // directory that changed owner) produced the cheerful green count banner
    // on every session, forever, while every capture hook failed with EACCES.
    // Fixing the first-run case and leaving the steady-state case is how a
    // detector ends up covering the one day the bug is least likely to happen.
    // The warning does NOT return: this hook's other job is recall, which
    // opens the database read-only and works fine on an unwritable target.
    // Returning here turned "capture is off" into "your memory is gone" —
    // every existing memory silently withheld exactly when the user needs
    // the context to notice something is wrong. Warn, then keep reading.
    const unwritable = captureTargetUnwritable();
    // "ready" is a promise about capture — when the warning is present,
    // withCaptureWarning (hoisted above) demotes it instead of contradicting
    // it one line later.
    captureWarning = unwritable
      ? `◉ MeMesh cannot write to ${unwritable} — memories will NOT be saved this session (recall still works). Run 'memesh doctor'.`
      : null;

    if (!existsSync(dbPath)) {
      // Combine deprecation banner (if any) into the same
      // systemMessage so stdout stays a single JSON document. Outer
      // finally runs runPostBannerUpdateTasks().
      // With no database there is nothing to recall either — the warning IS
      // the whole truth, and "memories will be created as you work" would
      // contradict it one line later.
      output(combineWithBanner(captureWarning ?? '◉ MeMesh ready · no database yet, memories will be created as you work'));
      return;
    }

    // `readOnly`, not `readonly`: node:sqlite ignores the lowercase spelling
    // and hands back a WRITABLE handle. This hook only reads.
    //
    // No `journal_mode = WAL` here. Setting it is a write, so a read-only
    // connection refuses it — and it was never doing anything: the mode is a
    // property of the database file that the writing side already set, and a
    // reader opens a WAL database perfectly well without asking for it.
    const db = new MemeshDatabase(dbPath, { readOnly: true });
    // MemeshDatabase's constructor always sets busy_timeout to the 30s that
    // is correct for the CLI/MCP/HTTP writers; this hook's own budget
    // (hooks.json) is 10s, so left alone a contended lock outlives the hook.
    db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
    // Whether the noise-compression epilogue below should run at all —
    // pre-read from this readonly handle before it closes. Defaults to
    // true so any early exit still lets the epilogue's own throttle decide.
    let noiseCompressDue = true;
    try {
      // Check if tables exist (db may exist but be empty)
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
      ).get();
      if (!tableCheck) {
        output(combineWithBanner(captureWarning ?? '◉ MeMesh ready · database initialised but no memories stored yet'));
        return;
      }

      // Inspect available columns for backward compat
      const columns = db.prepare("PRAGMA table_info(entities)").all();
      const colNames = new Set(columns.map(col => col.name));

      const hasStatus = colNames.has('status');
      const hasScoringCols = colNames.has('access_count') && colNames.has('last_accessed_at') && colNames.has('confidence');

      const statusFilter = hasStatus ? "AND e.status = 'active'" : '';
      // (Note: a previous `recentStatusFilter` constant lived here; the
      // refactor that introduced `buildScoringQuery` aliased the table
      // as `e` for both the project- and recent-pool queries, so the
      // bare-column `WHERE status = 'active'` form was replaced by the
      // qualified `WHERE e.status = 'active'` computed inline below.)

      // Configurable limit: how many top-N entities to load per section.
      // Env > config.sessionLimit > default 10.
      const sessionLimit = resolveSessionLimit(process.env);

      // Scoring math is aligned to src/core/scoring.ts exactly:
      //   - confidence  weight 0.2833  (core 0.17 / 0.60 sub-total)
      //   - frequency   weight 0.3000  (core 0.18 / 0.60)
      //   - recency     weight 0.4167  (core 0.25 / 0.60)
      // Sub-total excludes searchRelevance + impact, which session-start
      // can't compute without an FTS query. The renormalised ratios are
      // exported from core/scoring.ts as `SESSION_START_WEIGHT_RATIO`;
      // a drift-guard test in tests/core/scoring.test.ts asserts the SQL
      // here stays in sync.
      //
      // Functions:
      //   - frequency: log(c+1) / log(max(maxAccess,1) + 1)  (matches frequencyScore)
      //   - recency:   exp(-(now - lastAccessed_days) / 30)  (matches recencyScore)
      // SQLite >= 3.35 with -DSQLITE_ENABLE_MATH_FUNCTIONS provides exp/log,
      // which Node's bundled SQLite has. We probe once per process and fall
      // back to the legacy linear/rational forms if a stripped-down build is
      // detected, so ranking degrades gracefully rather than throwing.
      // Test-only seam: force the legacy linear/rational fallback so the
      // pre-math-functions code path is reachable in CI on builds where
      // exp/log ARE available. Production callers never set this.
      let hasSqliteMath = false;
      if (process.env.MEMESH_TEST_FORCE_LEGACY_SCORING_SQL !== '1') {
        try {
          db.prepare('SELECT exp(1.0), log(2.0)').get();
          hasSqliteMath = true;
        } catch {
          // Legacy SQLite build without math functions — keep linear fallback.
        }
      }

      // The legacy schema (createTestDb in tests, plus very old installs)
      // doesn't have confidence/access_count/last_accessed_at, so the
      // SELECT can't reference them. Build the column list to match
      // what the schema actually supports.
      // `title` is an ALTER-added column (UX-1) and gets the same
      // legacy-schema guard as the scoring columns: a database that predates
      // it must still produce an injection, falling back to the observation
      // snippet for its display text.
      const hasTitle = colNames.has('title');
      const baseCols = `e.id, e.name, e.type,${hasTitle ? ' e.title,' : ''} e.created_at, e.metadata`;
      const scoringCols = hasScoringCols
        ? `, e.confidence, e.access_count, e.last_accessed_at`
        : '';

      const buildScoringQuery = (joinClause, whereClause) => {
        const poolSelect = `SELECT DISTINCT ${baseCols}${scoringCols} FROM entities e ${joinClause}`;
        if (!hasScoringCols) {
          return `${poolSelect} ${whereClause} ORDER BY e.id DESC LIMIT ?`;
        }
        if (hasSqliteMath) {
          return `WITH pool AS (
              ${poolSelect} ${whereClause}
            ),
            pool_stats AS (
              SELECT COALESCE(MAX(access_count), 0) AS max_access FROM pool
            )
            SELECT p.id, p.name, p.type,${hasTitle ? ' p.title,' : ''} p.created_at, p.metadata
            FROM pool p, pool_stats s
            ORDER BY
              COALESCE(p.confidence, 1.0) * 0.2833
              + (CASE WHEN s.max_access <= 0 THEN 0
                      ELSE log(COALESCE(p.access_count, 0) + 1) / log(max(s.max_access, 1) + 1) END) * 0.3000
              + (CASE WHEN p.last_accessed_at IS NULL THEN 0.5
                      ELSE exp(-(julianday('now') - julianday(p.last_accessed_at)) / 30.0) END) * 0.4167
              DESC
            LIMIT ?`;
        }
        // Legacy fallback (SQLite without math functions): linear cap + rational decay.
        // Same direction as core ranking; absolute scores differ slightly.
        return `${poolSelect} ${whereClause}
          ORDER BY
            COALESCE(e.confidence, 1.0) * 0.2833
            + CASE WHEN e.access_count IS NULL THEN 0
                   ELSE MIN(CAST(e.access_count AS REAL) / 50.0, 1.0) END * 0.3000
            + CASE WHEN e.last_accessed_at IS NULL THEN 0.5
                   ELSE MIN(1.0, 1.0 / (1.0 + (julianday('now') - julianday(e.last_accessed_at)) / 30.0)) END * 0.4167
            DESC
          LIMIT ?`;
      };

      const projectTag = `project:${projectName}`;
      const projectQuery = buildScoringQuery(
        `JOIN tags t ON t.entity_id = e.id`,
        `WHERE t.tag = ? ${statusFilter}`,
      );
      // Over-fetch WIDE, then filter. The window used to be `sessionLimit * 3`
      // and the trust filter ran after it — so a class of entity that ranks
      // high can consume the entire window and leave nothing. That was not
      // hypothetical: measured on a real graph, all 30 top-ranked rows were
      // filtered out and the "project memory" section rendered empty while 92
      // eligible entities sat below the cut. The filter is a JS predicate with
      // one owner (`isTrustedForAutoContext`); rather than restate it as SQL
      // and own it twice, the window is made wide enough that the filtered
      // class cannot fill it. CANDIDATE_CAP bounds the work for a large graph.
      // Shared with the briefing surface via the leaf, so the two sides'
      // candidate windows cannot drift apart.
      const CANDIDATE_CAP = TOPOLOGY_CANDIDATE_CAP;
      const projectEntities = db.prepare(projectQuery).all(projectTag, CANDIDATE_CAP)
        .filter(entity => isTrustedForAutoContext(entity.metadata))
        .slice(0, sessionLimit);

      // recentStatusFilter is "WHERE status = 'active'" or "" — the bare-column
      // form is fine when there's no JOIN, but we now alias the table as `e`,
      // so rewrite to e.status for consistency.
      const recentWhere = hasStatus ? "WHERE e.status = 'active'" : '';
      const recentQuery = buildScoringQuery('', recentWhere);
      const recentEntities = db.prepare(recentQuery).all(CANDIDATE_CAP)
        .filter(entity => isTrustedForAutoContext(entity.metadata))
        .slice(0, 5);

      // Lesson count (queried for summary, not listed individually).
      // Status-column gate matches the project/recent queries above —
      // legacy v2.11 schemas don't have e.status and would otherwise
      // throw `no such column: status`, hiding lessons from session-start
      // auto-context indefinitely.
      let lessonCount = 0;
      let lessonEntities = [];
      try {
        const lessonRows = db.prepare(`
          SELECT DISTINCT e.id, e.name, e.type,${hasTitle ? ' e.title,' : ''} e.metadata
          FROM entities e
          JOIN tags t ON t.entity_id = e.id
          WHERE e.type = 'lesson_learned'
            ${hasStatus ? "AND e.status = 'active'" : ''}
            AND t.tag = ?
          LIMIT 50
        `).all(projectTag).filter(entity => isTrustedForAutoContext(entity.metadata));
        lessonCount = lessonRows.length;
        lessonEntities = lessonRows;
      } catch (err) {
        // Real query bug (typo, missing column on a schema older than v2.11)
        // — surface to stderr so a maintainer sees it on next session.
        try { process.stderr.write(`[memesh session-start] lesson query: ${err?.message || err}\n`); } catch {}
      }

      // Build single-line summary with mid-dot separators. Earlier this
      // was a multi-line tree (├─ / └─); switched to a one-liner so the
      // SessionStart system message takes one row in the Claude Code
      // log instead of four. Counts are count-only — no entity bullets.
      const projectCount = projectEntities.length;
      const recentCount = recentEntities.length;
      const memoryFragments = [];
      if (projectCount > 0) memoryFragments.push(`${projectCount} project`);
      if (recentCount > 0) memoryFragments.push(`${recentCount} recent`);

      let summary;
      if (memoryFragments.length === 0 && lessonCount === 0) {
        summary = `◉ MeMesh ready · no memories for "${projectName}" yet`;
      } else {
        const parts = ['◉ MeMesh'];
        if (memoryFragments.length > 0) {
          parts.push(`${memoryFragments.join(' + ')} memories`);
        }
        if (lessonCount > 0) {
          parts.push(`${lessonCount} active lesson${lessonCount === 1 ? '' : 's'}`);
        }
        summary = parts.join(' · ');
      }

      // --- Build the context actually injected into the model ---------
      // The `summary` above is a human banner (counts only) and never
      // reaches the model. This block is the real payload: the top-ranked
      // entities with a short observation snippet each, sent via
      // hookSpecificOutput.additionalContext.
      //
      // Lessons come first — they are the "don't repeat this mistake"
      // signal and are the most expensive thing to rediscover.
      //
      // Budget: additionalContext is capped by Claude Code (10k chars). We
      // stay far under that on purpose — session start should prime the
      // model, not consume its working context. Snippets are truncated per
      // observation and the whole block is hard-capped.
      // The budget itself comes from the leaf (DEFAULT_TOPOLOGY_BUDGET) at
      // the assembleTopologyBlock call — "the same block" depends on the two
      // surfaces agreeing, so neither side restates the numbers.

      // Only the entities we will actually render — the lesson query pulls
      // up to 50 rows for the banner count, but at most 5 are injected, and
      // this runs before the user's first turn. Bounded well under SQLite's
      // 999-variable limit by construction (5 lessons + sessionLimit
      // project + 5 recent). Declared out here because the injected-set
      // record below must list the SAME lessons the block renders.
      const topLessons = lessonEntities.slice(0, 5);

      const memoryLines = [];
      try {
        const rankedIds = [
          ...topLessons.map(e => e.id),
          ...projectEntities.map(e => e.id),
          ...recentEntities.map(e => e.id),
        ];
        const uniqueIds = [...new Set(rankedIds)];

        // One query for every snippet — avoids N round-trips on the
        // session-start hot path (this runs before the user's first turn).
        const snippets = new Map();
        if (uniqueIds.length > 0) {
          const placeholders = uniqueIds.map(() => '?').join(',');
          const obsRows = db.prepare(
            `SELECT entity_id, content FROM observations
             WHERE entity_id IN (${placeholders})
             ORDER BY id ASC`
          ).all(...uniqueIds);
          for (const row of obsRows) {
            // Keep the FIRST observation per entity: observations are
            // append-only, so the first one is the defining statement and
            // later ones are refinements.
            if (snippets.has(row.entity_id)) continue;
            const text = String(row.content ?? '').replace(/\s+/g, ' ').trim();
            // A few line-widths, not the exact line cap: the final cut is
            // clip()'s, on a word boundary — a hard slice at the line cap
            // would hand it a string with nothing left to trim and ship
            // mid-word fragments again.
            if (text) snippets.set(row.entity_id, text.slice(0, SNIPPET_FETCH_CHARS));
          }
        }

        // "Where we left off" leads the block. It is the one memory a new
        // session needs before any other: everything below is context for
        // work, this IS the work. It is also the only line here a human
        // (or an agent acting for one) stated on purpose — the rest is
        // ranked, and ranking cannot know what you meant to do next.
        //
        // Read from metadata, not from the observation trail: observations
        // are the CHANGE history, and picking "the current goal" out of them
        // means guessing which line is newest. Metadata holds one answer.
        const taskRow = db
          .prepare('SELECT metadata FROM entities WHERE name = ?')
          .get(taskStateName(projectName));
        const stateLines = taskStateLines(
          parseTaskState(parseEntityMetadata(taskRow?.metadata)),
          projectName,
        );

        // The pools overlap by construction (a lesson tagged to this project
        // is in lessonEntities AND projectEntities); the shared assembler
        // dedupes across them in claim order, so a project-scoped row is
        // never marked foreign by the cross-project recent pool, and the
        // topology grouping decides where each one belongs. This mapping —
        // raw row → TopologyEntity — is the only part this hook owns; the
        // assembly order, the spacer discipline, the budget and the
        // task-state exclusion live in the leaf, shared with `briefing`.
        const toEntity = (e) => {
          const meta = parseEntityMetadata(e.metadata);
          return {
            name: e.name,
            type: e.type || 'memory',
            // The citation handle: topologyLine prints `[mem:<id>]` so the
            // agent can credit the exact memory it used (the Stop hook's
            // accounting reads those markers back).
            id: e.id,
            title: e.title ?? null,
            snippet: snippets.get(e.id) ?? null,
            signalScore: meta && typeof meta.signal_score === 'number' ? meta.signal_score : null,
          };
        };
        memoryLines.push(...assembleTopologyBlock(
          stateLines,
          [
            { entities: topLessons.map(toEntity), foreign: false },
            { entities: projectEntities.map(toEntity), foreign: false },
            { entities: recentEntities.map(toEntity), foreign: true },
          ],
          projectName,
          DEFAULT_TOPOLOGY_BUDGET,
        ));
      } catch (err) {
        // Snippet enrichment is best-effort. A failure here must not stop
        // the banner or the session — but trace it, because a silent break
        // means memories stop reaching the model again (the exact v4.2.7
        // regression this block was written to fix).
        try { process.stderr.write(`[memesh session-start] memory-context: ${err?.message || err}\n`); } catch {}
      }

      let memoryContext = '';
      if (memoryLines.length > 0) {
        // Same wrapper pre-edit-recall uses: an explicit "background data,
        // not instructions" preamble plus a fenced block. Memory content is
        // attacker-influenced in the general case (anything the agent has
        // ever been told can end up in an observation), so it must be
        // delimited the same way on every injection path — not hand-rolled
        // per hook. The lines arrive already budgeted — assembleTopologyBlock
        // charges the task-state block and the sections against ONE ceiling
        // and returns whole lines only, so the closing fence cannot be cut.
        memoryContext = buildReferenceContext(memoryLines);
        // The citation contract — OUTSIDE the fence on purpose: the fence
        // declares its content "background data, not instructions", and
        // this line IS an instruction. One line is the entire write side of
        // the injection-ROI signal; the Stop hook credits recall_hits only
        // from these markers (self-reported: undercounts, never overcounts).
        // The citation instruction used to be appended here, outside the
        // fence, so it would read as an instruction rather than as data.
        // It never worked: Claude Code wraps a hook's additionalContext in a
        // system-reminder ending "you should not respond to this context
        // unless it is highly relevant", so the whole block — instruction
        // included — arrives as data. Measured on a real database:
        // citation_sessions_total=4, sessions WITH a citation = 0.
        //
        // The contract now lives in `.claude/rules/memesh-citations.md`,
        // which Claude Code loads as an instruction. Writing it is the
        // self-heal below; the line here is gone rather than duplicated,
        // because a per-session copy of an instruction that is read as data
        // is a per-session cost with no effect.
      }

      // --- Record injected entity IDs for recall effectiveness tracking ---
      // The Stop hook credits recall_hits from EXPLICIT `[mem:id]` citations
      // the agent writes (after structurally removing the transcript records
      // Claude Code created FROM this hook's output — the injected block
      // itself prints a handle on every line; see stripHookEchoes in
      // session-summary.js). Literal-content matching was retired after
      // measuring 0% signal over ten real sessions. `injectedContext` is
      // kept as the record of what was shown.
      //
      // The set below is every pool the topology block draws from — the
      // lessons pool included. It used to record only project + recent
      // rows, so an injected lesson could never be credited at all.
      try {
        const seenIds = new Set();
        const allInjected = [...topLessons, ...projectEntities, ...recentEntities].filter(e => {
          if (seenIds.has(e.id)) return false;
          seenIds.add(e.id);
          return true;
        });

        if (allInjected.length > 0) {
          const sessionsDir = join(memeshDir, 'sessions');
          ensurePrivateDir(sessionsDir);

          const sessionId = `${process.pid}-${Date.now()}`;
          writePrivateJson(
            join(sessionsDir, `${sessionId}.json`),
            {
              injectedAt: new Date().toISOString(),
              project: projectName,
              entityIds: allInjected.map(e => e.id),
              entityNames: allInjected.map(e => e.name),
              injectedContext: memoryContext || summary,
            }
          );

          // Clean up old session files (>24h)
          try {
            const files = require('fs').readdirSync(sessionsDir);
            const now = Date.now();
            for (const file of files) {
              if (!file.endsWith('.json')) continue;
              const filePath = join(sessionsDir, file);
              const stats = require('fs').statSync(filePath);
              if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
                require('fs').unlinkSync(filePath);
              }
            }
          } catch {}
        }
      } catch (err) {
        // Non-critical — sessions-file write powers citation accounting
        // (recall_hits credited from `[mem:id]` markers). If it silently
        // breaks, no hit can ever be credited and the impact-score factor
        // in core/scoring.ts converges on 0.5 (neutral) for everything.
        // Stderr trace so a permission/serialisation regression is visible.
        try { process.stderr.write(`[memesh session-start] sessions-write: ${err?.message || err}\n`); } catch {}
      }

      // Deprecation banner (security advisory) — surfaced even with the
      // short summary so flagged installs still warn on every session.
      let installedVersion = null;
      try {
        const pluginRoot = resolvePluginRoot(import.meta.url);
        const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
        installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
      } catch {
        // Best-effort — without the version we can't compare to cache.
      }
      const updateCache = readUpdateCheckCache(installedVersion);
      let bannerLines = [];
      if (installedVersion) {
        const deprecation = buildDeprecationBanner(installedVersion, updateCache);
        if (deprecation.length > 0) {
          bannerLines = deprecation;
        } else {
          bannerLines = buildUpdateAvailableBanner(installedVersion, updateCache,
            () => detectInstallChannelHook(resolvePluginRoot(import.meta.url)));
        }
      }
      const finalMessage = bannerLines.length > 0
        ? [...bannerLines.filter(l => l.length > 0), '', summary].join('\n')
        : summary;

      output(withCaptureWarning(finalMessage), memoryContext);

      // Pre-read the noise-compression throttle on the handle we already
      // hold. compressWeeklyNoise() re-checks under its own connection, but
      // ~364/365 sessions are inside the 24h window — and the full path
      // costs two dist module-graph imports plus a write-capable
      // migration-chain open (WAL writer lock) that must stay off the
      // SessionStart hot path. Missing table / any error ⇒ due (the full
      // path owns schema creation).
      noiseCompressDue = (() => {
        try {
          const row = db.prepare(
            "SELECT value FROM memesh_metadata WHERE key = 'last_noise_compress_at'"
          ).get();
          if (!row) return true;
          return Date.now() - new Date(row.value).getTime() >= 24 * 60 * 60 * 1000;
        } catch {
          return true;
        }
      })();
    } finally {
      db.close();
    }
    // ── Noise compression (after readonly DB is closed) ──────────────
    // Opens a separate read-write connection via the core module.
    // Throttled to once per 24h inside compressWeeklyNoise().
    try {
      if (noiseCompressDue) {
      // F5: derive pluginRoot strictly from this file's location.
      // See `resolvePluginRoot` for the full reasoning.
      const pluginRoot = resolvePluginRoot(import.meta.url);
      const dbMod = await importFromPluginRoot(pluginRoot, 'dist/db.js');
      const lifecycleMod = await importFromPluginRoot(pluginRoot, 'dist/core/lifecycle.js');
      dbMod.openDatabase();
      try {
        // Say what it did. This archives at least 20 of the user's memories
        // per week processed and the count was thrown away, so the one
        // operation in memesh that removes things from view was also the
        // only one that left no trace anywhere — not in the hook output, not
        // in doctor, not in the dashboard. Nothing to opt into: it runs at
        // most once a day and stays silent when it compresses nothing.
        const noise = lifecycleMod.compressWeeklyNoise(dbMod.getDatabase());
        if (noise && noise.compressed > 0) {
          try {
            process.stderr.write(
              `[memesh] archived ${noise.compressed} low-signal memor${noise.compressed === 1 ? 'y' : 'ies'} `
              + `into ${noise.weeksProcessed} weekly summar${noise.weeksProcessed === 1 ? 'y' : 'ies'} `
              + `(recover with \`memesh recall --include-archived\`)\n`,
            );
          } catch { /* stderr gone */ }
        }
      } finally {
        dbMod.closeDatabase();
      }
      }
    } catch (err) {
      // Non-critical — noise compression failed, will retry next session.
      // Trace because this catch previously hid an off-by-one regression
      // in resolvePluginRoot (4.0.4-4.1.0) that silently disabled both
      // noise compression AND LLM failure analysis for three minor
      // releases. A one-line stderr would have surfaced it on day 1.
      try { process.stderr.write(`[memesh session-start] noise-compression: ${err?.message || err}\n`); } catch {}
    }

    } catch (err) {
      // Hooks must never crash Claude Code — but report honestly.
      // Inner catch so the outer finally can still run the post-
      // banner update tasks even when the recall flow blew up.
      console.log(JSON.stringify({ systemMessage: withCaptureWarning(`MeMesh: memories not loaded this session (${err?.message || 'unknown error'}) — everything else works; run \`memesh doctor\` if this repeats.`) }));
    }
  } finally {
    // ── Auto-update + cache refresh ──────────────────────────────
    // Outer finally guarantees this runs on every exit path — no-DB
    // short-circuit, empty-DB return, no-memories return, recall
    // happy path, or even a thrown error caught above. The
    // function is single-shot per process so the duplicated
    // late-path call from older versions is now idempotent.
    runPostBannerUpdateTasks();
  }
});

/**
 * Emit the SessionStart hook payload.
 *
 * Two channels, two audiences — they are NOT interchangeable:
 *
 *   systemMessage      -> shown to the human in the terminal. Claude Code
 *                         strips it from the model's context entirely
 *                         (`normalizeAttachmentForAPI` returns [] for the
 *                         `hook_system_message` attachment type).
 *   hookSpecificOutput -> `additionalContext` IS injected into the model's
 *      .additionalContext  context for the next turn. `SessionStart` is one of
 *                         the nine events with a valid variant.
 *
 * Until v4.2.7 this hook only ever emitted `systemMessage`, so *nothing*
 * memesh recalled at session start ever reached the model — the banner said
 * "4 project + 5 recent memories" while the model received none of them.
 * Worse, the Stop hook then marked every one of those entities as a
 * `recall_miss` for not appearing in the transcript, so memories that were
 * never shown were permanently penalised in ranking (see scoring.ts
 * impactScore). Passing `memoryContext` closes that loop honestly.
 *
 * The shape is asserted by tests/helpers/hook-output-contract.ts.
 */
function output(text, memoryContext) {
  const payload = { systemMessage: text };
  if (memoryContext) {
    payload.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: memoryContext,
    };
  }
  console.log(JSON.stringify(payload));
}
