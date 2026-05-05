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
    lines.push(`    Run: memesh update   (or set autoUpdate: 'patch' in ~/.memesh/config.json)`);
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

function decideAutoUpdateHook(currentVersion, cache, policy) {
  if (!cache || cache.currentVersion !== currentVersion) return { run: false };
  const latest = cache.latestVersion;
  if (typeof latest !== 'string' || !latest) return { run: false };
  const bump = classifyBumpHook(currentVersion, latest);
  if (!bump) return { run: false };

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
 * Detect the install channel of the running memesh binary. Mirrors
 * `src/core/install-channel.ts` heuristics so the hook can decide
 * without paying the dist-import cost (the answer is one heuristic
 * call; not worth threading dist for it).
 *
 * Returns the same string set as the typed core helper:
 *   'npm-global' | 'npm-local' | 'source-checkout' | 'unknown'
 */
function detectInstallChannelHook(pluginRoot) {
  try {
    // Source checkout: a .git directory at the package root means
    // the user is running from a clone, not an installed binary.
    if (existsSync(join(pluginRoot, '.git'))) return 'source-checkout';
    // Heuristic for npm-global: `<prefix>/lib/node_modules/@pcircle/memesh`.
    // We can't reliably probe `npm prefix -g` from inside the hook
    // without spawning npm, so we do a path-shape check.
    if (/[\\/]node_modules[\\/]@pcircle[\\/]memesh$/.test(pluginRoot)
        && /[\\/]lib[\\/]node_modules[\\/]@pcircle[\\/]memesh$/.test(pluginRoot)) {
      return 'npm-global';
    }
    if (/[\\/]node_modules[\\/]@pcircle[\\/]memesh$/.test(pluginRoot)) {
      return 'npm-local';
    }
    return 'unknown';
  } catch {
    return 'unknown';
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
 * The auto-update path only fires when the active install is
 * `npm-global`. Source checkouts and project-local installs would
 * silently create a *new* global install while the active copy
 * stayed unchanged, which is both surprising and ineffective —
 * those install shapes update via their own mechanism (git pull +
 * rebuild, project npm install).
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
      `auto-update spawn: target=${version}${deprecationOverride ? ' (deprecation-override)' : ''} pid=${child.pid ?? 'unknown'}`
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
 * permit, and always refresh the cache for the next session. This MUST
 * run on every session-start path — including the no-DB short-circuit
 * — so a fresh install of a flagged version still kicks off the
 * security-override patch upgrade and the next run starts with a fresh
 * cache. Best-effort; never throws.
 */
function runPostBannerUpdateTasks() {
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
    spawnFreshUpdateCheck();
  } catch {
    // Best-effort — never crash the hook on a network or fs hiccup.
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
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
      // Even with no recall summary to emit, a deprecation flag on the
      // installed version is more important than the regular "no
      // database found" notice — surface it so a fresh install of a
      // flagged version sees the warning before doing anything else.
      try {
        const pluginRoot = resolvePluginRoot(import.meta.url);
        const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
        const installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
        const cache = readUpdateCheckCache();
        const lines = installedVersion ? buildDeprecationBanner(installedVersion, cache) : [];
        if (lines.length > 0) {
          output(lines.filter((l) => l.length > 0).join('\n'));
        }
      } catch {
        // Best-effort — never block the no-DB path.
      }
      output('MeMesh: No database found. Memories will be created as you work.');
      // Auto-update + cache-refresh must still run on the no-DB path
      // (fresh install of a flagged version is exactly when the
      // security override matters most, and the next session needs a
      // populated cache regardless of recall state).
      runPostBannerUpdateTasks();
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
        output('MeMesh: Database exists but no memories stored yet.');
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

      // No memories at all — output nothing (don't clutter session)
      if (lines.length === 0) {
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

    // ── Auto-update + cache refresh (after main hook output) ────────
    // Same logic that runs on the no-DB short-circuit; centralised in
    // runPostBannerUpdateTasks() so both code paths can't drift out
    // of sync. Default policy is 'off' so a fresh install never
    // silently upgrades — only an opt-in MEMESH_AUTO_UPDATE env or
    // `autoUpdate` config triggers, with a deprecation security
    // override for flagged versions.
    runPostBannerUpdateTasks();
  } catch (err) {
    // Hooks must never crash Claude Code — but report honestly
    console.log(JSON.stringify({ systemMessage: `MeMesh: Session start failed (${err?.message || 'unknown error'}). Memories not loaded.` }));
  }
});

function output(text) {
  console.log(JSON.stringify({ systemMessage: text }));
}
