#!/usr/bin/env node

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import { existsSync, readFileSync, unlinkSync, rmSync, appendFileSync, chmodSync, openSync, closeSync } from 'fs';
import {
  buildReferenceContext,
  ensurePrivateDir,
  getMemeshDir,
  isAgenticOrchestrationEnabled,
  isTrustedForAutoContext,
  resolveAutoUpdatePolicy,
  resolvePluginRoot,
  resolveSessionLimit,
  writePrivateJson,
} from './_shared.js';

const require = createRequire(import.meta.url);

const dbPath = process.env.MEMESH_DB_PATH || join(homedir(), '.memesh', 'knowledge-graph.db');
const memeshDir = getMemeshDir(process.env);
const throttlePath = join(memeshDir, 'session-recalled-files.json');
const nudgeFlagsDir = join(memeshDir, 'agent-nudge-flags');

/**
 * Read the cached npm update check produced by core/version-check.ts.
 * Hooks must not depend on dist/, so this duplicates the path constant
 * (mirrored in src/core/version-check.ts:6) and parses defensively.
 * Returns null on missing/corrupt cache rather than throwing — the
 * deprecation warning is best-effort.
 */
function readUpdateCheckCache() {
  const path = process.env.MEMESH_UPDATE_CHECK_PATH || join(homedir(), '.memesh', 'update-check.json');
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the strong deprecation warning lines to prepend to the
 * session-start banner when the installed version has been flagged
 * by maintainers (typically a security advisory). Returns an empty
 * array when the cache says nothing to warn about.
 */
function buildDeprecationBanner(currentVersion, cache) {
  if (!cache || cache.currentVersion !== currentVersion) return [];
  const msg = cache.currentVersionDeprecation;
  if (typeof msg !== 'string' || msg.length === 0) return [];
  const lines = [
    '',
    `⚠️  MeMesh ${currentVersion} is DEPRECATED by maintainers.`,
    `    ${msg}`,
  ];
  if (cache.latestVersion && cache.latestVersion !== currentVersion) {
    // Recommend the auto-update policy that actually covers the bump
    // kind required to leave the deprecated version. A 'patch' policy
    // only permits patch bumps, so for a deprecation that can only be
    // resolved by a minor (4.1.x → 4.2.0) or major (4.x → 5.0) jump,
    // suggesting 'patch' would silently leave the user on the
    // deprecated version. We recommend the smallest policy that fits
    // the actual bump.
    const bump = classifyBumpHook(currentVersion, cache.latestVersion);
    const policySuggestion = bump === 'major' ? 'major'
      : bump === 'minor' ? 'minor'
      : 'patch';
    lines.push(`    Run: memesh update   (or set autoUpdate: '${policySuggestion}' in ~/.memesh/config.json)`);
  }
  return lines;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/;

function classifyBumpHook(from, to) {
  const a = SEMVER_RE.exec((from || '').trim());
  const b = SEMVER_RE.exec((to || '').trim());
  if (!a || !b) return null;
  const ai = a.slice(1, 4).map(Number);
  const bi = b.slice(1, 4).map(Number);
  if (bi[0] > ai[0]) return 'major';
  if (bi[0] < ai[0]) return null;
  if (bi[1] > ai[1]) return 'minor';
  if (bi[1] < ai[1]) return null;
  if (bi[2] > ai[2]) return 'patch';
  return null;
}

const POLICY_RANK = { off: 0, patch: 1, minor: 2, major: 3 };
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

// Cache must be no older than 24 hours for auto-update to act on
// it. A stale cache could point at a target that is already
// superseded on npm — installing it would leave the user one step
// behind. When the cache is too old we skip the install and let the
// background refresh fetch fresh data for the next session.
const AUTO_UPDATE_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function decideAutoUpdateHook(currentVersion, cache, policy) {
  if (!cache || cache.currentVersion !== currentVersion) return { run: false };
  const latest = cache.latestVersion;
  if (typeof latest !== 'string' || !latest) return { run: false };
  const bump = classifyBumpHook(currentVersion, latest);
  if (!bump) return { run: false };

  // Stale-cache guard: refuse to auto-install a target that may
  // have been superseded on npm since the last successful check.
  const lastSuccessAt = cache.lastSuccessfulCheckAt;
  const lastSuccessMs = typeof lastSuccessAt === 'string' ? Date.parse(lastSuccessAt) : NaN;
  const cacheAgeMs = Number.isFinite(lastSuccessMs) ? Date.now() - lastSuccessMs : Infinity;
  if (cacheAgeMs > AUTO_UPDATE_CACHE_FRESHNESS_MS) {
    return { run: false, reason: 'stale-cache' };
  }

  const policyAllows = (POLICY_RANK[policy] ?? 0) >= BUMP_RANK[bump];
  if (policyAllows) return { run: true, latest, bump, deprecationOverride: false };

  // Deprecation security override: even with policy 'off', force a
  // patch upgrade out of a deprecated version. Don't override beyond
  // patch — minor / major can carry behaviour changes the user didn't
  // agree to.
  const deprecated = typeof cache.currentVersionDeprecation === 'string'
    && cache.currentVersionDeprecation.length > 0;
  if (deprecated && bump === 'patch') {
    return { run: true, latest, bump, deprecationOverride: true };
  }

  return { run: false };
}

/**
 * Append a one-line outcome to the auto-update audit log. Best-effort.
 */
function logAutoUpdate(line) {
  try {
    const dir = getMemeshDir(process.env);
    ensurePrivateDir(dir);
    const path = join(dir, 'auto-update.log');
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
    try { chmodSync(path, 0o600); } catch { /* non-POSIX */ }
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Detect the install channel of the running memesh binary. Cross-
 * platform: matches both POSIX (`<prefix>/lib/node_modules/...`) and
 * Windows (`%AppData%\npm\node_modules\...`) global install paths.
 *
 * Returns the same string set as src/core/install-channel.ts:
 *   'npm-global' | 'npm-local' | 'source-checkout' | 'unknown'
 *
 * Known limitation: globals at custom prefixes (e.g.
 * `/opt/tools/node_modules/@pcircle/memesh` from `npm config set
 * prefix /opt/tools`) fall through to 'unknown' here, even though
 * `memesh status` correctly classifies them via `npm root -g`. As a
 * result the auto-update spawn skips for that subset of valid
 * global installs. Tracked for v4.1.4 — the proper fix is to share
 * the dist install-channel detection (which already runs `npm root
 * -g`) but that incurs a noticeable cost on every session-start.
 *
 * Two truths to keep in sync with the core helper:
 *   1. .git at the package root  → source-checkout
 *   2. path ends in `<sep>node_modules<sep>@pcircle<sep>memesh`,
 *      and a sibling-of-node_modules `lib` (POSIX) OR `npm` (Windows
 *      global) → npm-global
 *   3. otherwise inside any node_modules tree → npm-local
 */
function detectInstallChannelHook(pluginRoot) {
  try {
    if (existsSync(join(pluginRoot, '.git'))) return 'source-checkout';
    // POSIX npm-global: <prefix>/lib/node_modules/@pcircle/memesh
    // Windows npm-global: <AppData>/npm/node_modules/@pcircle/memesh
    //   (npm 7+ may also produce <prefix>/node_modules/@pcircle/memesh
    //    when --global without a wrapper-bin convention; treat as global
    //    when one of the global-shape parents — `lib` or `npm` — sits
    //    immediately above `node_modules`.)
    const inNodeModules = /[\\/]node_modules[\\/]@pcircle[\\/]memesh$/.test(pluginRoot);
    if (!inNodeModules) return 'unknown';
    const isPosixGlobal = /[\\/]lib[\\/]node_modules[\\/]@pcircle[\\/]memesh$/.test(pluginRoot);
    const isWindowsGlobal = /[\\/]npm[\\/]node_modules[\\/]@pcircle[\\/]memesh$/.test(pluginRoot);
    if (isPosixGlobal || isWindowsGlobal) return 'npm-global';
    return 'npm-local';
  } catch {
    return 'unknown';
  }
}

// Cross-process lock window. Two parallel Claude sessions starting
// in the same minute would otherwise both decide to auto-update from
// the same cache and each fire `npm install -g` — wasted work at
// best, install corruption at worst on slow networks. The lock
// holds for the upper-bound of an `npm install -g` (most finish in
// under 60s; we allow 10 min as a safety floor) and is reclaimed
// when stale.
const AUTO_UPDATE_LOCK_TTL_MS = 10 * 60 * 1000;

function tryAcquireAutoUpdateLock(version) {
  try {
    const dir = getMemeshDir(process.env);
    ensurePrivateDir(dir);
    const lockPath = join(dir, 'auto-update.lock');
    const fs = require('fs');
    const payload = `${process.pid}\n${Date.now()}\n${version}\n`;
    // Fast path: O_EXCL atomic create. If we win, we own the lock.
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      return { acquired: true, lockPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    // Lock exists. Check staleness, but don't TOCTOU-race two
    // reclaimers: stat → unlink → O_EXCL create. If two processes
    // both pass the staleness check, only one will win the unlink
    // (a no-op for the loser) AND only one will win the EXCL
    // create. Whoever loses returns acquired=false.
    let stat;
    try { stat = fs.statSync(lockPath); } catch { return { acquired: false, lockPath }; }
    if (Date.now() - stat.mtimeMs <= AUTO_UPDATE_LOCK_TTL_MS) {
      return { acquired: false, lockPath };
    }
    try { fs.unlinkSync(lockPath); } catch (err) {
      // ENOENT = another reclaimer beat us to the unlink. Fall
      // through to the O_EXCL attempt; one of us will fail at
      // create and return acquired=false.
      if (err?.code !== 'ENOENT') return { acquired: false, lockPath };
    }
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      return { acquired: true, lockPath };
    } catch {
      return { acquired: false, lockPath };
    }
  } catch {
    return { acquired: false, lockPath: null };
  }
}

/**
 * Spawn `npm install -g @pcircle/memesh@<version>` detached so the
 * upgrade can finish after this hook returns. We never block the
 * session on the install — the running process keeps its current
 * binary; the next session picks up the new one. Argv is an array
 * (no shell interpolation), so the version string can never escape
 * into a shell command.
 *
 * Two safety gates:
 *   1. Install channel must be `npm-global`. Source checkouts and
 *      project-local installs would silently create a separate
 *      global install while the active copy stayed unchanged.
 *   2. A filesystem lock at <memeshDir>/auto-update.lock serialises
 *      across parallel session-start processes. Without this, two
 *      Claude sessions starting at the same minute would each fire
 *      `npm install -g` concurrently.
 */
function spawnAutoUpdate(version, deprecationOverride) {
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    const channel = detectInstallChannelHook(pluginRoot);
    if (channel !== 'npm-global') {
      logAutoUpdate(
        `auto-update SKIPPED: install channel '${channel}' does not support self-update via npm install -g`
      );
      return false;
    }
    const lock = tryAcquireAutoUpdateLock(version);
    if (!lock.acquired) {
      logAutoUpdate(
        `auto-update SKIPPED: another session-start already holds ${lock.lockPath ?? 'auto-update.lock'} for this upgrade`
      );
      return false;
    }
    const dir = getMemeshDir(process.env);
    ensurePrivateDir(dir);
    const logPath = join(dir, 'auto-update.log');
    let fd = -1;
    try { fd = openSync(logPath, 'a', 0o600); } catch { fd = -1; }
    const stdio = fd >= 0 ? ['ignore', fd, fd] : 'ignore';
    const child = spawn(
      'npm',
      ['install', '-g', `@pcircle/memesh@${version}`],
      { detached: true, stdio, env: process.env },
    );
    child.unref();
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    logAutoUpdate(
      `auto-update spawn: target=${version}${deprecationOverride ? ' (deprecation-override)' : ''} pid=${child.pid ?? 'unknown'} lock=${lock.lockPath}`
    );
    return true;
  } catch (err) {
    logAutoUpdate(`auto-update spawn FAILED: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Spawn a fresh `memesh status` lookup detached so the cache is
 * refreshed for the next session without blocking this one. The
 * `status` subcommand calls getUpdateCheck under the hood, which is
 * the same code path the deprecation banner reads from on the next
 * session start. The CLI command IS `status` — `update-status` does
 * not exist — so we shell to `status` and discard its output.
 */
function spawnFreshUpdateCheck() {
  try {
    const pluginRoot = resolvePluginRoot(import.meta.url);
    const cliPath = join(pluginRoot, 'dist/transports/cli/cli.js');
    if (!existsSync(cliPath)) return false;
    const child = spawn(
      process.execPath,
      [cliPath, 'status'],
      { detached: true, stdio: 'ignore', env: { ...process.env, MEMESH_UPDATE_REFRESH: '1' } },
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
    const cache = readUpdateCheckCache();
    const policy = resolveAutoUpdatePolicy(process.env);
    const decision = decideAutoUpdateHook(installedVersion, cache, policy);
    if (decision.run) {
      spawnAutoUpdate(decision.latest, decision.deprecationOverride);
    }
    // Schedule a detached refresh to keep the cache fresh for the
    // next session.
    spawnFreshUpdateCheck();
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
    const cache = readUpdateCheckCache();
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
      const updateCache = readUpdateCheckCache();
      const deprecationLines = installedVersion
        ? buildDeprecationBanner(installedVersion, updateCache)
        : [];
      const memorySummaryWithBanner = deprecationLines.length > 0
        ? [...deprecationLines, '', ...memorySummary.split('\n')].join('\n')
        : memorySummary;

      const hookOutput = {
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: buildReferenceContext(memorySummaryWithBanner.split('\n')),
        },
      };
      console.log(JSON.stringify(hookOutput));
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
