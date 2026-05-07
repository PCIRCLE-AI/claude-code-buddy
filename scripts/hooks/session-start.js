#!/usr/bin/env node

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, readFileSync, unlinkSync, rmSync, appendFileSync, chmodSync, openSync, closeSync } from 'fs';
import {
  buildReferenceContext,
  ensurePrivateDir,
  getMemeshDir,
  isAgenticOrchestrationEnabled,
  isTrustedForAutoContext,
  readUpdateCheckCache,
  resolvePluginRoot,
  resolveSessionLimit,
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

const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
const memeshDir = getMemeshDir(process.env);
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
  } catch {
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
        env: { ...process.env, MEMESH_UPDATE_REFRESH: '1' },
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
    lines = installedVersion ? buildDeprecationBanner(installedVersion, cache) : [];
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
    const projectName = basename(data.cwd || process.cwd());

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
      output(combineWithBanner('MeMesh: No database found. Memories will be created as you work.'));
      return;
    }

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      db.pragma('journal_mode = WAL');

      // Check if tables exist (db may exist but be empty)
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
      ).get();
      if (!tableCheck) {
        output(combineWithBanner('MeMesh: Database exists but no memories stored yet.'));
        return;
      }

      // Inspect available columns for backward compat
      const columns = db.prepare("PRAGMA table_info(entities)").all();
      const colNames = new Set(columns.map(col => col.name));

      const hasStatus = colNames.has('status');
      const hasScoringCols = colNames.has('access_count') && colNames.has('last_accessed_at') && colNames.has('confidence');

      const statusFilter = hasStatus ? "AND e.status = 'active'" : '';
      const recentStatusFilter = hasStatus ? "WHERE status = 'active'" : '';

      // Configurable limit: how many top-N entities to load per section.
      // Env > config.sessionLimit > default 10.
      const sessionLimit = resolveSessionLimit(process.env);

      // Build scoring ORDER BY clause (or fallback to insertion order)
      const scoringOrderBy = hasScoringCols
        ? `ORDER BY
            CASE WHEN e.confidence IS NULL THEN 0.5 ELSE e.confidence END * 0.4
            + CASE WHEN e.access_count IS NULL THEN 0
                   ELSE MIN(CAST(e.access_count AS REAL) / 50.0, 1.0) END * 0.3
            + CASE WHEN e.last_accessed_at IS NULL THEN 0.3
                   ELSE MIN(1.0, 1.0 / (1.0 + (julianday('now') - julianday(e.last_accessed_at)) / 30.0)) END * 0.3
            DESC`
        : 'ORDER BY e.id DESC';

      const recentScoringOrderBy = hasScoringCols
        ? `ORDER BY
            CASE WHEN confidence IS NULL THEN 0.5 ELSE confidence END * 0.4
            + CASE WHEN access_count IS NULL THEN 0
                   ELSE MIN(CAST(access_count AS REAL) / 50.0, 1.0) END * 0.3
            + CASE WHEN last_accessed_at IS NULL THEN 0.3
                   ELSE MIN(1.0, 1.0 / (1.0 + (julianday('now') - julianday(last_accessed_at)) / 30.0)) END * 0.3
            DESC`
        : 'ORDER BY id DESC';

      // Query project-specific top-N entities by relevance score
      const projectTag = `project:${projectName}`;
      const projectEntities = db.prepare(`
        SELECT DISTINCT e.id, e.name, e.type, e.created_at, e.metadata
        FROM entities e
        JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ?
        ${statusFilter}
        ${scoringOrderBy}
        LIMIT ?
      `).all(projectTag, sessionLimit * 3)
        .filter(entity => isTrustedForAutoContext(entity.metadata))
        .slice(0, sessionLimit);

      // Fetch the first observation for each entity (for concise summary)
      const getFirstObservation = db.prepare(
        'SELECT content FROM observations WHERE entity_id = ? ORDER BY id ASC LIMIT 1'
      );

      // Query global recent/top entities (exclude project-tagged ones for this project)
      const recentEntities = db.prepare(`
        SELECT id, name, type, created_at, metadata
        FROM entities
        ${recentStatusFilter}
        ${recentScoringOrderBy}
        LIMIT 15
      `).all()
        .filter(entity => isTrustedForAutoContext(entity.metadata))
        .slice(0, 5);

      // Format entity as concise bullet: "• name (type): first observation (truncated)"
      function formatEntity(entity) {
        const obs = getFirstObservation.get(entity.id);
        const snippet = obs ? obs.content.slice(0, 100) : '';
        return snippet
          ? `• ${entity.name} (${entity.type}): ${snippet}`
          : `• ${entity.name} (${entity.type})`;
      }

      // Build recall message
      const lines = [];
      if (projectEntities.length > 0) {
        const label = hasScoringCols ? `top ${projectEntities.length} by relevance` : `${projectEntities.length}`;
        lines.push(`Project "${projectName}" memories (${label}):`);
        for (const e of projectEntities) {
          lines.push(formatEntity(e));
        }
      }
      if (recentEntities.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Recent memories:');
        for (const e of recentEntities) {
          lines.push(formatEntity(e));
        }
      }

      // No memories at all — surface only the deprecation banner if
      // active (so a flagged install still warns the user) and skip
      // the rest of the recall-summary work. The outer finally still
      // runs runPostBannerUpdateTasks().
      if (lines.length === 0) {
        const bannerOnly = combineWithBanner('');
        if (bannerOnly && bannerOnly.trim().length > 0) {
          output(bannerOnly.trim());
        }
        return;
      }

      let memorySummary = lines.join('\n');

      // --- Proactive lesson warnings ---
      try {
        const lessonEntities = db.prepare(`
          SELECT DISTINCT e.id, e.name, e.confidence, e.metadata
          FROM entities e
          JOIN tags t ON t.entity_id = e.id
          WHERE e.type = 'lesson_learned'
            AND e.status = 'active'
            AND t.tag = ?
          ORDER BY CASE WHEN e.confidence IS NULL THEN 0.5 ELSE e.confidence END DESC,
                   CASE WHEN e.access_count IS NULL THEN 0 ELSE e.access_count END DESC
          LIMIT 15
        `).all(projectTag).filter(entity => isTrustedForAutoContext(entity.metadata));

        if (lessonEntities.length > 0) {
          memorySummary += '\n\n⚠️ Known lessons for this project:\n';
          for (const lesson of lessonEntities) {
            // Load ALL observations per lesson (not fragile LIKE pattern)
            const allObs = db.prepare(
              'SELECT content FROM observations WHERE entity_id = ? ORDER BY id'
            ).all(lesson.id);

            // Find the Prevention line
            const prevention = allObs.find(o => o.content.startsWith('Prevention:'));
            const display = prevention
              ? prevention.content.replace(/^Prevention:\s*/, '')
              : (allObs[allObs.length - 1]?.content || lesson.name);

            const conf = typeof lesson.confidence === 'number' ? lesson.confidence.toFixed(1) : '1.0';
            memorySummary += `• ${display} (confidence: ${conf})\n`;
          }
        }
      } catch {
        // Lesson query failed — don't break session start
      }

      // --- Agentic-orchestration mode banner (experimental protocol, opt-in) ---
      // memesh ships an experimental working-model protocol alongside its
      // memory layer. The banner reminds Claude at session start that the
      // suggested default for verifiable work (build/test/lint/migrate/
      // refactor/benchmark) is to dispatch a background agent rather than
      // block the conversation; strategic work stays foreground.
      //
      // OPT-IN ONLY: enabled via MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1.
      // The default is OFF — main wedge of memesh is local memory; the
      // working-model protocol is a separable experiment, and its banner
      // would otherwise dominate every session for users who never asked
      // for it. Setting the flag also enables local skill-usage telemetry
      // (~/.memesh/skill-usage.jsonl) so the protocol can later be
      // validated with real usage data.
      if (isAgenticOrchestrationEnabled(process.env)) {
        try {
          memorySummary +=
            '\n\n[Experimental working model — protocol; effectiveness still being validated] ' +
            'User=CTO · Claude=Orchestrator · Agents=Engineering team\n' +
            'Verifiable work (build/test/lint/refactor/benchmark) → dispatch as background agent (Task with run_in_background:true).\n' +
            'Strategic work → stay foreground. Skill: agentic-orchestration.';

          // Local-only telemetry — never networked. Hook writes the JSONL
          // line directly to keep itself self-contained (no dynamic import
          // of compiled TS). Only fires when the user has opted in above.
          try {
            const usagePath = join(homedir(), '.memesh', 'skill-usage.jsonl');
            // Hash the cwd so distinct-project counting still works without
            // persisting any path fragment. SHA-256 → first 16 hex chars =
            // 64 bits, plenty to distinguish projects on one machine.
            const cwd = String(data?.cwd || process.cwd());
            const cwdHashed = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
            const line = JSON.stringify({
              ts: new Date().toISOString(),
              event: 'agentic_orchestration_banner_injected',
              payload: { cwd_hashed: cwdHashed },
            }) + '\n';
            appendFileSync(usagePath, line);
            // Tighten mode — telemetry includes timestamps + per-project
            // hashed cwd which can profile user activity. Other local
            // users on a shared system should not be able to read it.
            try { chmodSync(usagePath, 0o600); } catch { /* non-POSIX */ }
          } catch { /* swallow — telemetry must not break session-start */ }
        } catch {
          // Banner failed — non-critical, continue
        }
      }

      // --- Record injected entity IDs for recall effectiveness tracking ---
      try {
        // CRITICAL: Deduplicate by entity ID (entity may appear in both project and recent lists)
        const seenIds = new Set();
        const allInjected = [...projectEntities, ...recentEntities].filter(e => {
          if (seenIds.has(e.id)) return false;
          seenIds.add(e.id);
          return true;
        });

        if (allInjected.length > 0) {
          const sessionsDir = join(memeshDir, 'sessions');
          ensurePrivateDir(sessionsDir);

          // FIX: Use session-scoped file with unique ID (pid + timestamp)
          const sessionId = `${process.pid}-${Date.now()}`;
          writePrivateJson(
            join(sessionsDir, `${sessionId}.json`),
            {
              injectedAt: new Date().toISOString(),
              project: projectName,
              entityIds: allInjected.map(e => e.id),
              entityNames: allInjected.map(e => e.name),
              // FIX: Save injected context text to exclude from hit detection
              injectedContext: memorySummary,
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
      } catch {
        // Non-critical — don't break session start
      }

      // Deprecation-aware banner. Reads the cache produced by the
      // last `getUpdateCheck` (CLI or background refresh). When the
      // installed version was flagged by maintainers (typically a
      // security advisory), prepend a strong warning so the user sees
      // it on every session start until they upgrade.
      let installedVersion = null;
      try {
        const pluginRoot = resolvePluginRoot(import.meta.url);
        const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
        installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
      } catch {
        // Best-effort — without the version we can't compare to cache.
      }
      const updateCache = readUpdateCheckCache(installedVersion);
      const deprecationLines = installedVersion
        ? buildDeprecationBanner(installedVersion, updateCache)
        : [];
      const memorySummaryWithBanner = deprecationLines.length > 0
        ? [...deprecationLines, '', ...memorySummary.split('\n')].join('\n')
        : memorySummary;

      output(buildReferenceContext(memorySummaryWithBanner.split('\n')));
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
      const dbMod = await import(join(pluginRoot, 'dist/db.js'));
      const lifecycleMod = await import(join(pluginRoot, 'dist/core/lifecycle.js'));
      dbMod.openDatabase();
      try {
        lifecycleMod.compressWeeklyNoise(dbMod.getDatabase());
      } finally {
        dbMod.closeDatabase();
      }
    } catch {
      // Non-critical — noise compression failed, will retry next session
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

function output(text) {
  console.log(JSON.stringify({ systemMessage: text }));
}
