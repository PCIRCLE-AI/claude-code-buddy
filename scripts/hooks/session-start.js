#!/usr/bin/env node

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, readFileSync, unlinkSync, rmSync, appendFileSync, chmodSync } from 'fs';
import {
  buildReferenceContext,
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  importFromPluginRoot,
  isAgenticOrchestrationEnabled,
  isTrustedForAutoContext,
  readUpdateCheckCache,
  resolvePluginRoot,
  resolveSessionLimit,
  tryRequireBetterSqlite,
  writePrivateJson,
} from './_shared.js';

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
const nudgeFlagsDir = join(memeshDir, 'agent-nudge-flags');

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

function buildUpdateAvailableBanner(currentVersion, cache, channel) {
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
    const dir = join(homedir(), '.memesh');
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

  const lines = [
    '',
    `ℹ️  MeMesh update available: ${cache.latestVersion} (you're on ${currentVersion}).`,
  ];
  if (channel === 'npm-global') {
    lines.push(`    Run: memesh update`);
  } else if (channel === 'plugin-marketplace') {
    lines.push(`    Run: bash <plugin-root>/scripts/upgrade-plugin.sh   (or reinstall from /plugin UI)`);
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
    const dir = join(homedir(), '.memesh');
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
        const channel = detectInstallChannelHook(pluginRoot);
        lines = buildUpdateAvailableBanner(installedVersion, cache, channel);
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
  try {
    try {
    const data = JSON.parse(input);
    const projectName = getProjectName(data.cwd);

    // Clear per-session throttle files from previous session
    try {
      if (existsSync(throttlePath)) {
        unlinkSync(throttlePath);
      }
    } catch {
      // Non-critical
    }
    try {
      if (existsSync(nudgeFlagsDir)) {
        rmSync(nudgeFlagsDir, { recursive: true, force: true });
      }
    } catch {
      // Non-critical
    }

    if (!existsSync(dbPath)) {
      // Combine deprecation banner (if any) into the same
      // systemMessage so stdout stays a single JSON document. Outer
      // finally runs runPostBannerUpdateTasks().
      output(combineWithBanner('◉ MeMesh ready · no database yet, memories will be created as you work'));
      return;
    }

    // Native module unavailable (typical for plugin-marketplace cache
    // installs that ship without node_modules). Silently skip — the
    // plugin's own MCP server runs via npx and a sibling registered
    // copy of this hook (npm-global / dev path) supplies the summary.
    const Database = tryRequireBetterSqlite();
    if (!Database) return;
    const db = new Database(dbPath, { readonly: true });
    try {
      db.pragma('journal_mode = WAL');

      // Check if tables exist (db may exist but be empty)
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
      ).get();
      if (!tableCheck) {
        output(combineWithBanner('◉ MeMesh ready · database initialised but no memories stored yet'));
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
      // SQLite >= 3.35 with -DSQLITE_ENABLE_MATH_FUNCTIONS provides exp/log;
      // better-sqlite3 v8+ ships with this flag enabled by default. We probe
      // once per process and fall back to the legacy linear/rational forms
      // if a stripped-down build is detected, so ranking degrades gracefully
      // rather than throwing.
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
      const baseCols = 'e.id, e.name, e.type, e.created_at, e.metadata';
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
            SELECT p.id, p.name, p.type, p.created_at, p.metadata
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
      const projectEntities = db.prepare(projectQuery).all(projectTag, sessionLimit * 3)
        .filter(entity => isTrustedForAutoContext(entity.metadata))
        .slice(0, sessionLimit);

      // recentStatusFilter is "WHERE status = 'active'" or "" — the bare-column
      // form is fine when there's no JOIN, but we now alias the table as `e`,
      // so rewrite to e.status for consistency.
      const recentWhere = hasStatus ? "WHERE e.status = 'active'" : '';
      const recentQuery = buildScoringQuery('', recentWhere);
      const recentEntities = db.prepare(recentQuery).all(15)
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
          SELECT DISTINCT e.id, e.name, e.type, e.metadata
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
      const MAX_SNIPPET = 160;
      const MAX_CONTEXT_CHARS = 4000;

      const memoryLines = [];
      try {
        // Only the entities we will actually render — the lesson query pulls
        // up to 50 rows for the banner count, but at most 5 are injected, and
        // this runs before the user's first turn. Bounded well under SQLite's
        // 999-variable limit by construction (5 lessons + sessionLimit
        // project + 5 recent).
        const topLessons = lessonEntities.slice(0, 5);
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
            if (text) snippets.set(row.entity_id, text.slice(0, MAX_SNIPPET));
          }
        }

        // Groups overlap by construction: a lesson tagged to this project
        // is in lessonEntities AND projectEntities. Render each entity once,
        // in the highest-priority group it belongs to, so the injected block
        // doesn't spend the model's context repeating itself.
        const rendered = new Set();
        const renderGroup = (label, entities) => {
          const fresh = entities.filter(e => !rendered.has(e.id));
          if (fresh.length === 0) return;
          memoryLines.push(label);
          for (const e of fresh) {
            rendered.add(e.id);
            const snippet = snippets.get(e.id);
            const type = e.type || 'memory';
            memoryLines.push(
              snippet ? `- ${e.name} (${type}): ${snippet}` : `- ${e.name} (${type})`
            );
          }
          memoryLines.push('');
        };

        renderGroup('Lessons learned (avoid repeating these):', topLessons);
        renderGroup(`Project memory for "${projectName}":`, projectEntities);
        renderGroup('Recently active across projects:', recentEntities);
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
        // per hook.
        //
        // Truncate the LINES before wrapping, so the closing fence is never
        // cut off — a dangling fence would let the tail of the block escape
        // its delimiter.
        const budgeted = [];
        let used = 0;
        for (const line of memoryLines) {
          if (used + line.length + 1 > MAX_CONTEXT_CHARS) {
            budgeted.push('… (truncated)');
            break;
          }
          budgeted.push(line);
          used += line.length + 1;
        }
        memoryContext = buildReferenceContext(budgeted);
      }

      // --- Record injected entity IDs for recall effectiveness tracking ---
      // The Stop hook decides hit/miss by removing the transcript records
      // Claude Code created FROM this hook's output (see stripHookEchoes in
      // session-summary.js) and then looking for the entity name in what
      // remains. `injectedContext` is kept as the record of what was shown,
      // not as a string to subtract — an earlier version subtracted it and a
      // later one counted its occurrences, and BOTH were wrong because one
      // injection is echoed into the transcript more than once.
      //
      // It must still be the text we actually injected: previously it was the
      // count-only banner, so every injected entity was scored against a
      // transcript it had never appeared in and took a `recall_miss` it did
      // not earn.
      try {
        const seenIds = new Set();
        const allInjected = [...projectEntities, ...recentEntities].filter(e => {
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
        // Non-critical — sessions-file write powers recall-effectiveness
        // tracking (recall_hits / recall_misses on the dashboard). If it
        // silently breaks, the impact-score factor in core/scoring.ts
        // converges on 0.5 (neutral) for everything. Stderr trace so a
        // permission/serialisation regression is visible.
        try { process.stderr.write(`[memesh session-start] sessions-write: ${err?.message || err}\n`); } catch {}
      }

      // --- Agentic-orchestration mode (opt-in) ---
      // Banner kept short. Telemetry write preserved for protocol validation.
      if (isAgenticOrchestrationEnabled(process.env)) {
        summary += '\n[AO opt-in: dispatch verifiable work as background agent · skill: agentic-orchestration]';
        try {
          const usagePath = join(homedir(), '.memesh', 'skill-usage.jsonl');
          // Only { ts, event } — an earlier `payload: { cwd_hashed }` was never
          // read by summariseSkillUsage (counts by event name only), so it was
          // write-only privacy-adjacent data. Removed.
          const line = JSON.stringify({
            ts: new Date().toISOString(),
            event: 'agentic_orchestration_banner_injected',
          }) + '\n';
          appendFileSync(usagePath, line);
          try { chmodSync(usagePath, 0o600); } catch { /* non-POSIX */ }
        } catch { /* swallow — telemetry must not break session-start */ }
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
          let channel = 'unknown';
          try {
            const pluginRoot = resolvePluginRoot(import.meta.url);
            channel = detectInstallChannelHook(pluginRoot);
          } catch { /* best-effort */ }
          bannerLines = buildUpdateAvailableBanner(installedVersion, updateCache, channel);
        }
      }
      const finalMessage = bannerLines.length > 0
        ? [...bannerLines.filter(l => l.length > 0), '', summary].join('\n')
        : summary;

      output(finalMessage, memoryContext);
    } finally {
      db.close();
    }
    // ── Noise compression (after readonly DB is closed) ──────────────
    // Opens a separate read-write connection via the core module.
    // Throttled to once per 24h inside compressWeeklyNoise().
    try {
      // F5: derive pluginRoot strictly from this file's location.
      // See `resolvePluginRoot` for the full reasoning.
      const pluginRoot = resolvePluginRoot(import.meta.url);
      const dbMod = await importFromPluginRoot(pluginRoot, 'dist/db.js');
      const lifecycleMod = await importFromPluginRoot(pluginRoot, 'dist/core/lifecycle.js');
      dbMod.openDatabase();
      try {
        lifecycleMod.compressWeeklyNoise(dbMod.getDatabase());
      } finally {
        dbMod.closeDatabase();
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
      console.log(JSON.stringify({ systemMessage: `MeMesh: Session start failed (${err?.message || 'unknown error'}). Memories not loaded.` }));
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
