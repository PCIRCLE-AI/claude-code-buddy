import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { detectCapabilities, getConfigPath, type Capabilities } from './config.js';
import { embedText, isOnnxModelCached } from './embedder.js';
import { probeProvider } from './llm-validator.js';
import { openDatabase, closeDatabase, getPendingReindexInfo, isDatabaseOpen } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getInstallRecord } from './install-id.js';
import { getDbPath, memeshDir } from './paths.js';
import { UNSPACED_SCRIPT_GLOB_RUN3 } from '../storage/fts-index.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorOverallStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  fix?: string;
  /**
   * True for rows that REPORT a value rather than ASSERT a fact.
   *
   * A doctor row is one of two very different things:
   *   - an assertion — "the native binding loads", "hooks are wired". It
   *     makes a claim that the outside world can falsify, so it can fail.
   *   - an informational row — "your install id is X", "your config names
   *     ollama". It describes state. It cannot fail, because it is not
   *     claiming anything is working.
   *
   * Before this flag existed both rendered as `[PASS]` and both counted
   * toward `Overall`, so "13/13 PASS" read as "13 things verified" when
   * some had verified nothing. The Capabilities row was the worst case: it
   * was hardcoded to 'pass' and merely echoed config, so an expired API key
   * or a broken embedder could never move doctor off PASS.
   *
   * Informational rows are excluded from `summarizeOverallStatus` and are
   * rendered as `[INFO]`. If you want a row to be able to fail, it must
   * probe something — see `probeEmbeddings` / `probeLlm`.
   */
  informational?: boolean;
}

export interface DoctorResult {
  status: DoctorOverallStatus;
  checks: DoctorCheck[];
}

interface JsonObject {
  [key: string]: unknown;
}

/**
 * The slice of better-sqlite3 doctor uses, so tests can substitute a stub.
 *
 * `get` returns `unknown` and takes bind parameters. It used to be typed
 * `() => { c?: number }` — the shape of the one query that existed when it was
 * written — which forced every later caller to cast its result to something
 * else, and a cast is not a check. Returning `unknown` makes each call site
 * state what it expects at the point it reads it.
 */
interface DatabaseLike {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
}

interface DoctorOptions {
  packageRoot: string;
  packageVersion: string;
  probeHttp?: boolean;
  /**
   * Make one small LIVE call to the configured LLM provider.
   *
   * Off by default: probing on every run costs latency and, for hosted
   * providers, money. When off, the LLM row reports "NOT VERIFIED" rather
   * than a green it did not earn.
   */
  probeCapabilities?: boolean;
  embedTextImpl?: (text: string) => Promise<Float32Array | null>;
  probeProviderImpl?: typeof probeProvider;
  httpBaseUrl?: string;
  platform?: NodeJS.Platform;
  openDatabaseImpl?: typeof openDatabase;
  closeDatabaseImpl?: typeof closeDatabase;
  isDatabaseOpenImpl?: typeof isDatabaseOpen;
  detectCapabilitiesImpl?: typeof detectCapabilities;
  getConfigPathImpl?: typeof getConfigPath;
  getUpdateCheckImpl?: typeof getUpdateCheck;
  getCurrentInstallChannelImpl?: typeof getCurrentInstallChannel;
  getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
  existsSyncImpl?: typeof fs.existsSync;
  readFileSyncImpl?: typeof fs.readFileSync;
  statSyncImpl?: typeof fs.statSync;
  fetchImpl?: typeof fetch;
  /**
   * Test seam: probe better-sqlite3 by instantiating a Database. Default
   * uses Node's resolver from packageRoot. Tests inject a stub to avoid
   * hitting the real native module.
   */
  nativeBindingProbeImpl?: (packageRoot: string) => { ok: true } | { ok: false; message: string };
  /**
   * Test seam: resolve `memesh` on the user's shell PATH. Default uses
   * `which` / `where` via execFileSync. Returns the resolved absolute
   * path or null when not found. Tests inject a stub.
   */
  resolveShellMemeshImpl?: () => string | null;
}

/**
 * Cap on the live embedding probe in `memesh doctor`. Generous enough for a
 * cold ONNX model load or a local ollama call, short enough that doctor
 * always returns.
 */
const EMBEDDING_PROBE_TIMEOUT_MS = 15000;

const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];

// Locale READMEs that MUST stay in lockstep with README.md. Order matters
// only for the doctor output — alphabetised for readability.
const LOCALE_README_FILES = [
  'README.de.md',
  'README.es.md',
  'README.fr.md',
  'README.ja.md',
  'README.ko.md',
  'README.pt.md',
  'README.th.md',
  'README.vi.md',
  'README.zh-CN.md',
  'README.zh-TW.md',
];

// Locales legitimately translate headings, so we don't text-match the
// anchors — instead we compare H2 *counts*. A locale that's off by ≥2
// almost always means an English section was added (or removed) without
// the locale being resynced. ±1 stays a pass to absorb routine
// translation drift (one locale may collapse two short H2s).
const LOCALE_H2_TOLERANCE = 1;

function countH2Headings(content: string): number {
  // Track whether we're inside a fenced code block (``` or ~~~).
  // A `## comment` line inside a code block is example markdown, not a
  // real H2, so it shouldn't be counted. A simple toggling state
  // machine is enough for the well-formed READMEs this check targets.
  let n = 0;
  let inFence = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith('## ')) n++;
  }
  return n;
}

function inspectLocaleReadmeParity(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const englishPath = path.join(packageRoot, 'README.md');
  if (!existsSyncImpl(englishPath)) {
    // Most likely a packaged install where READMEs aren't shipped to the
    // npm tarball. Not a problem for end-users — skip silently with pass.
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'pass',
      'README.md not present in this install (likely a packaged tarball without docs); locale-parity check skipped.',
    );
  }
  let englishCount: number;
  try {
    englishCount = countH2Headings(readFileSyncImpl(englishPath, 'utf8'));
  } catch (err) {
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'warn',
      `Could not read README.md: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const missing: string[] = [];
  const drift: Array<{ name: string; count: number }> = [];
  for (const filename of LOCALE_README_FILES) {
    const localePath = path.join(packageRoot, filename);
    if (!existsSyncImpl(localePath)) {
      missing.push(filename);
      continue;
    }
    try {
      const count = countH2Headings(readFileSyncImpl(localePath, 'utf8'));
      if (Math.abs(count - englishCount) > LOCALE_H2_TOLERANCE) {
        drift.push({ name: filename, count });
      }
    } catch {
      // unreadable locale — treat as drift so it surfaces in the report
      drift.push({ name: filename, count: -1 });
    }
  }

  if (missing.length === 0 && drift.length === 0) {
    return createCheck(
      'readme_locale_parity',
      'README locale parity',
      'pass',
      `All ${LOCALE_README_FILES.length} locale READMEs match English H2 count (${englishCount}).`,
    );
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing: ${missing.join(', ')}`);
  }
  if (drift.length > 0) {
    const driftDetail = drift
      .map((d) => `${d.name}=${d.count === -1 ? 'unreadable' : d.count}`)
      .join(', ');
    parts.push(`H2 count drift (English=${englishCount}): ${driftDetail}`);
  }
  return createCheck(
    'readme_locale_parity',
    'README locale parity',
    'warn',
    parts.join('; '),
    `Re-sync the listed READMEs against README.md so section structure matches (±${LOCALE_H2_TOLERANCE} H2 tolerated to absorb translation collapse).`,
  );
}

function resolveDatabasePath(): string {
  return getDbPath();
}

function createCheck(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  summary: string,
  fix?: string,
): DoctorCheck {
  return { id, label, status, summary, fix };
}

/**
 * Build a row that REPORTS state instead of asserting it.
 *
 * Use this whenever the row cannot fail. It is excluded from `Overall`, so
 * it can never inflate a green verdict. If you find yourself wanting to
 * write `createCheck(..., 'pass', ...)` with a literal status at the top
 * level of `runDoctor` — i.e. with no branch that could produce 'fail' —
 * that row is informational, not a check. Use this instead.
 */
function createInfo(id: string, label: string, summary: string, fix?: string): DoctorCheck {
  return { id, label, status: 'pass', summary, fix, informational: true };
}

function parseJsonFile(
  filePath: string,
  readFileSyncImpl: typeof fs.readFileSync,
): { ok: true; value: JsonObject } | { ok: false; error: string } {
  try {
    const raw = readFileSyncImpl(filePath, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') {
      return { ok: false, error: 'JSON root must be an object.' };
    }
    return { ok: true, value: value as JsonObject };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown parse error',
    };
  }
}

function inspectConfigFile(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  getConfigPathImpl: typeof getConfigPath,
): DoctorCheck {
  const configPath = getConfigPathImpl();
  if (!existsSyncImpl(configPath)) {
    return createCheck(
      'config',
      'Config',
      'pass',
      `No config file yet (${configPath}). MeMesh will run in Core mode until you configure Smart Mode.`,
      'Optional: run `memesh config list` or set an LLM with `memesh config set llm.provider anthropic`.',
    );
  }

  const parsed = parseJsonFile(configPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'config',
      'Config',
      'fail',
      `Config file is invalid JSON at ${configPath}.`,
      `Fix or remove ${configPath}, then run \`memesh config list\` to confirm it loads cleanly.`,
    );
  }

  return createCheck(
    'config',
    'Config',
    'pass',
    `Config file is readable at ${configPath}.`,
  );
}

function inspectMcpConfig(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const mcpPath = path.join(packageRoot, '.mcp.json');
  if (!existsSyncImpl(mcpPath)) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.mcp.json is missing.',
      'Restore `.mcp.json` from the package or reinstall MeMesh.',
    );
  }

  const parsed = parseJsonFile(mcpPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.mcp.json is not valid JSON.',
      `Fix ${mcpPath} so Claude Code can read the MCP server definition.`,
    );
  }

  const server = (parsed.value.mcpServers as JsonObject | undefined)?.memesh as JsonObject | undefined;
  if (!server || typeof server.command !== 'string') {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.mcp.json does not define a usable `memesh` MCP server entry.',
      'Reinstall MeMesh or restore the `mcpServers.memesh` entry in `.mcp.json`.',
    );
  }

  return createCheck(
    'mcp-config',
    'MCP config',
    'pass',
    '.mcp.json is present and defines the memesh MCP server.',
  );
}

function extractHookScriptPaths(hooksConfig: JsonObject, packageRoot: string): string[] {
  const hooks = hooksConfig.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (!hooks) return [];

  const scripts = new Set<string>();
  for (const entries of Object.values(hooks)) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command !== 'string') continue;
        const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
        scripts.add(path.join(packageRoot, command));
      }
    }
  }
  return Array.from(scripts).sort();
}

function inspectHooksConfig(
  packageRoot: string,
  platform: NodeJS.Platform,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  statSyncImpl: typeof fs.statSync,
): DoctorCheck[] {
  const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
  if (!existsSyncImpl(hooksPath)) {
    return [
      createCheck(
        'hooks-config',
        'Hooks config',
        'fail',
        'hooks/hooks.json is missing.',
        'Restore `hooks/hooks.json` from the package or reinstall MeMesh.',
      ),
    ];
  }

  const parsed = parseJsonFile(hooksPath, readFileSyncImpl);
  if (!parsed.ok) {
    return [
      createCheck(
        'hooks-config',
        'Hooks config',
        'fail',
        'hooks/hooks.json is not valid JSON.',
        `Fix ${hooksPath} so Claude Code can load the hook definitions.`,
      ),
    ];
  }

  const hookTypes = Object.keys((parsed.value.hooks as JsonObject | undefined) ?? {});
  const missingTypes = EXPECTED_HOOK_TYPES.filter((type) => !hookTypes.includes(type));
  const configCheck = missingTypes.length > 0
    ? createCheck(
      'hooks-config',
      'Hooks config',
      'fail',
      `hooks/hooks.json is missing expected hook types: ${missingTypes.join(', ')}.`,
      'Restore the shipped hook configuration or reinstall MeMesh.',
    )
    : createCheck(
      'hooks-config',
      'Hooks config',
      'pass',
      `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`,
    );

  const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
  const missingScripts = scriptPaths.filter((scriptPath) => !existsSyncImpl(scriptPath));
  if (missingScripts.length > 0) {
    return [
      configCheck,
      createCheck(
        'hook-scripts',
        'Hook scripts',
        'fail',
        `Missing hook scripts: ${missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`,
        'Restore the missing files from the package or reinstall MeMesh.',
      ),
    ];
  }

  if (platform !== 'win32') {
    const nonExecutable = scriptPaths.filter((scriptPath) => {
      const mode = statSyncImpl(scriptPath).mode;
      return (mode & 0o111) === 0;
    });
    if (nonExecutable.length > 0) {
      return [
        configCheck,
        createCheck(
          'hook-scripts',
          'Hook scripts',
          'fail',
          `Hook scripts are not executable: ${nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`,
          'Run `npm run build` from the repo checkout or `chmod +x scripts/hooks/*.js` for a local repair.',
        ),
      ];
    }
  }

  return [
    configCheck,
    createCheck(
      'hook-scripts',
      'Hook scripts',
      'pass',
      `All ${scriptPaths.length} hook scripts are present${platform === 'win32' ? '' : ' and executable'}.`,
    ),
  ];
}

/**
 * Verify memesh's hooks are actually wired into Claude Code's
 * settings.json — not just present on disk. The earlier doctor
 * check only confirmed the hook scripts exist; it would PASS even
 * for a user whose Claude Code never loaded them, which was the
 * exact failure mode that masked memesh's "self-improving memory
 * loop never runs" bug for two weeks of npm downloads.
 *
 * Source of truth: the install-hooks.json marker written by
 * `memesh install-hooks`. Without that marker we can't tell a
 * fresh-install-needs-wiring case apart from a manually-wired
 * case the user did themselves — so we surface as WARN with a fix.
 */
function inspectHookWiring(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  memeshDir: string,
  packageRoot?: string,
): DoctorCheck {
  const markerPath = path.join(memeshDir, 'install-hooks.json');
  if (!existsSyncImpl(markerPath)) {
    // Plugin-marketplace install path: when memesh is loaded as a
    // Claude Code plugin (via `/plugin install memesh@pcircle-memesh`),
    // hook wiring happens through the plugin runtime — `memesh
    // install-hooks` never runs, so the marker file is legitimately
    // absent. Detect that path by `<packageRoot>/.claude-plugin/plugin.json`
    // and report PASS rather than WARN — the runtime signal of "are
    // hooks actually firing" is what `inspectHookActivity` covers.
    if (packageRoot) {
      const pluginManifest = path.join(packageRoot, '.claude-plugin', 'plugin.json');
      if (existsSyncImpl(pluginManifest)) {
        return createCheck(
          'hook-wiring',
          'Hooks wired into Claude Code',
          'pass',
          'Wired via Claude Code plugin runtime (.claude-plugin/plugin.json present). The install-hooks marker is not used on this install path.',
        );
      }
    }
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      'No install-hooks marker found. memesh\'s session-summary, pre-edit-recall, and other hooks may not be firing for Claude Code sessions — the auto-capture / lesson-generation flow is silent without them.',
      'Run `memesh install-hooks` to wire memesh into ~/.claude/settings.json (one-time setup). Then `memesh doctor` to confirm.',
    );
  }
  const parsed = parseJsonFile(markerPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      `install-hooks marker at ${markerPath} is unreadable.`,
      'Re-run `memesh install-hooks` to refresh the marker.',
    );
  }
  const marker = parsed.value as {
    plugin_root?: string;
    settings_path?: string;
    version?: string;
    scope?: string;
  };
  if (typeof marker.settings_path !== 'string') {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      'install-hooks marker is malformed (missing settings_path).',
      'Re-run `memesh install-hooks`.',
    );
  }
  if (!existsSyncImpl(marker.settings_path)) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Marker recorded settings at ${marker.settings_path} but the file no longer exists. Hooks are not wired.`,
      'Re-run `memesh install-hooks`.',
    );
  }
  const settingsParsed = parseJsonFile(marker.settings_path, readFileSyncImpl);
  if (!settingsParsed.ok) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `${marker.settings_path} is no longer valid JSON.`,
      'Restore from your ~/.claude backups or re-create with `memesh install-hooks`.',
    );
  }
  // Walk hooks looking for any _memesh:true entry. Doesn't need
  // to count every event — presence is the contract.
  const hooks = (settingsParsed.value as { hooks?: Record<string, unknown> }).hooks;
  let hasMemeshHook = false;
  if (hooks && typeof hooks === 'object') {
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const cmds = (entry as { hooks?: unknown[] }).hooks;
        if (!Array.isArray(cmds)) continue;
        if (cmds.some((c) => (c as { _memesh?: boolean })._memesh === true)) {
          hasMemeshHook = true;
          break;
        }
      }
      if (hasMemeshHook) break;
    }
  }
  if (!hasMemeshHook) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Marker recorded a memesh install at ${marker.settings_path}, but no _memesh:true hook entries are present anymore. Settings drifted (manual edit?) or memesh was uninstalled out-of-band.`,
      'Re-run `memesh install-hooks` to re-wire.',
    );
  }
  // Check the recorded plugin_root still exists — npm-global path
  // can change after a Node.js upgrade, leaving stale absolute paths.
  if (typeof marker.plugin_root === 'string' && !existsSyncImpl(marker.plugin_root)) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Hook commands point at ${marker.plugin_root}, which no longer exists (likely after an npm-global path change).`,
      'Re-run `memesh install-hooks` to refresh paths.',
    );
  }
  return createCheck(
    'hook-wiring',
    'Hooks wired into Claude Code',
    'pass',
    `Wired in ${marker.settings_path} (scope: ${marker.scope ?? 'user'}, version: ${marker.version ?? 'unknown'}).`,
  );
}

/**
 * Confirm memesh's hooks have actually produced an entity in the
 * past 24 hours — the strongest signal that the auto-capture loop
 * is alive end-to-end.
 *
 * Hooks emit several memesh-attributed entity types:
 *   - 'session-insight' — RuleBasedExtractor + session-summary.js (Stop)
 *   - 'session-summary' — pre-compact.js (PreCompact)
 *   - 'commit'          — post-commit.js (PostToolUse / git commits)
 *   - 'lesson_learned'  — failure-analyzer / learn tool
 * User-global hooks (`~/.claude/hooks/stop.js`) write 'session_keypoint'
 * instead — counting that would mask the "memesh hooks aren't firing but
 * custom hooks are" failure mode, so it stays excluded.
 *
 * Earlier this check counted ONLY 'session-insight'. session-insight is
 * the strictest source: it requires an agentic session ≥3 tools, no
 * user_interrupt, and the extractor's filters all to pass. A user who
 * just installed memesh and opened the dashboard before completing such
 * a session would see a false WARN even with hooks correctly wired —
 * because post-commit and pre-compact may have already fired but they
 * write different entity types. Broadened to the full set so any sign
 * of life satisfies the check.
 *
 * Grace period: if the install-hooks marker is < 24h old, we accept
 * "no activity yet" silently. A fresh install legitimately has nothing
 * to count.
 */
function inspectHookActivity(
  openDatabaseImpl: typeof openDatabase,
  closeDatabaseImpl: typeof closeDatabase,
  existsSyncImpl: typeof fs.existsSync = fs.existsSync,
  statSyncImpl: typeof fs.statSync = fs.statSync,
): DoctorCheck {
  let db: DatabaseLike | null = null;
  try {
    db = openDatabaseImpl() as unknown as DatabaseLike;
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM entities
       WHERE type IN ('session-insight', 'session-summary', 'commit', 'lesson_learned')
         AND created_at > datetime('now', '-24 hours')`,
    ).get() as { c: number };
    const count = row?.c ?? 0;
    if (count === 0) {
      // Grace period: the install-hooks marker tells us when hooks were
      // wired. If that was recent (< 24h), 0 activity is expected — the
      // user simply hasn't completed a captureable session yet. Skip the
      // warning entirely so a freshly-installed dashboard doesn't open
      // with a noisy banner that the user can't act on.
      const markerPath = path.join(memeshDir(), 'install-hooks.json');
      if (existsSyncImpl(markerPath)) {
        try {
          const ageMs = Date.now() - statSyncImpl(markerPath).mtimeMs;
          if (ageMs < 24 * 60 * 60 * 1000) {
            return createCheck(
              'hook-activity',
              'Hook activity (last 24h)',
              'pass',
              'Hooks wired recently — no captureable sessions yet (this is normal for a fresh install).',
            );
          }
        } catch { /* best-effort */ }
      }
      return createCheck(
        'hook-activity',
        'Hook activity (last 24h)',
        'warn',
        'No memesh-attributed entities (session-insight, session-summary, commit, lesson_learned) in the past 24 hours. Hooks may be wired but not firing — likely a Claude Code restart is needed, or the agentic-loop guard is filtering all sessions.',
        'Open a Claude Code session that uses ≥3 tools and ends naturally (not user_interrupt), or commit something. Then run `memesh doctor` again.',
      );
    }
    return createCheck(
      'hook-activity',
      'Hook activity (last 24h)',
      'pass',
      `${count} memesh-attributed entit${count === 1 ? 'y' : 'ies'} captured in the past 24h — auto-capture loop is alive.`,
    );
  } catch (err) {
    return createCheck(
      'hook-activity',
      'Hook activity (last 24h)',
      'warn',
      `Could not query the database: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try { if (db) closeDatabaseImpl(); } catch { /* best-effort */ }
  }
}

/**
 * Probe `better-sqlite3`'s native binding directly. The JS wrapper at
 * `require('better-sqlite3')` always resolves once the package is
 * installed — but instantiating `new Database()` is what triggers
 * `bindings()`, which is where the missing `.node` file surfaces.
 *
 * The failure mode this catches: Claude Code's `/plugin install` runs
 * `npm install --ignore-scripts` (security default), which skips
 * better-sqlite3's `install` script that fetches/builds the prebuilt
 * binary AND skips memesh's own `postinstall-rebuild.mjs` safety net.
 * Result: JS files present, native binding missing, every hook silently
 * skip-and-exits without writing entities. Without this check, the bug
 * is invisible until a user notices "the dashboard is empty" days later.
 */
function defaultResolveShellMemesh(): string | null {
  // Use `which` on POSIX and `where` on Windows. Both return the first
  // matching binary on PATH. Return null on any failure (not found,
  // command missing, permission error) — caller treats null as "no
  // shell memesh available".
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    // node:child_process is already imported lazily by other doctor checks;
    // re-use the createRequire chain so we don't add a top-level import
    // just for this seam.
    const localRequire = createRequire(import.meta.url);
    const { execFileSync } = localRequire('child_process');
    const out = execFileSync(cmd, ['memesh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function defaultNativeBindingProbe(packageRoot: string): { ok: true } | { ok: false; message: string } {
  // No test-env seam here. Earlier versions of this function gated on
  // `process.env.VITEST === 'true'` to let test fixtures stub
  // `node_modules/better-sqlite3` as an empty directory. That seam was
  // too permissive: any user who happened to have VITEST exported in
  // their shell (e.g. shared between projects) would silently bypass
  // the binding probe and see a green PASS on a broken install — the
  // exact failure mode this check exists to surface. Tests must inject
  // `nativeBindingProbeImpl` explicitly via runDoctor options. Production
  // code paths always exercise the real probe.
  try {
    // ESM-safe createRequire (the doctor module is emitted as ESM by
    // the project's tsconfig — bare `require` would throw
    // "require is not defined").
    const localRequire = createRequire(pathToFileURL(path.join(packageRoot, 'package.json')).href);
    const Database = localRequire('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Compare a running Node version against a `>=X.Y.Z` engines range.
 *
 * Deliberately narrow: it understands exactly the one form this package
 * publishes, and says so when it meets anything else. A looser parser that
 * guessed at `^`, `||` or `<` ranges would answer confidently and sometimes
 * wrongly, and the row it feeds is allowed to FAIL — a wrong answer there
 * tells a healthy install it is broken. Returning `null` makes the caller
 * report "not checked", which is the true statement.
 */
export function satisfiesMinimumNodeRange(
  version: string,
  range: string
): boolean | null {
  const min = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range.trim());
  const running = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!min || !running) return null;

  const wanted = [Number(min[1]), Number(min[2] ?? 0), Number(min[3] ?? 0)];
  const have = [Number(running[1]), Number(running[2]), Number(running[3])];
  for (let i = 0; i < 3; i++) {
    if (have[i] > wanted[i]) return true;
    if (have[i] < wanted[i]) return false;
  }
  return true;
}

/**
 * Report the runtime MeMesh is actually running on.
 *
 * This is a diagnostic, not a survey. Doctor output reaches the maintainers
 * only when a user files a feedback issue, which samples people already
 * having trouble — so nothing here can tell you what the installed base runs,
 * and no `engines` decision should be taken from it. What it does do is close
 * a real gap: a user below the supported floor currently sees hooks
 * misbehaving with no row anywhere connecting that to their Node version.
 *
 * The `node:sqlite` line is attached because this is the one place that
 * already prints runtime facts, and because the native-binding row two
 * positions down fails for exactly the reason `node:sqlite` would not: it
 * needs no compilation. When that row is red, knowing a compile-free SQLite
 * is sitting in the same runtime is the useful next sentence.
 *
 * Everything reported is a property of the machine — version, ABI, platform,
 * arch — and none of it is personal. That matters because `memesh feedback`
 * copies this summary verbatim into a PUBLIC GitHub issue body.
 */
export function inspectNodeRuntime(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  nodeVersion: string = process.version,
  moduleAbi: string = process.versions.modules,
  hasNodeSqliteImpl: () => boolean = hasBuiltInSqlite,
): DoctorCheck {
  const facts =
    `Node ${nodeVersion} (ABI ${moduleAbi}, ${process.platform}/${process.arch}). ` +
    `Built-in node:sqlite: ${hasNodeSqliteImpl() ? 'available' : 'not available'}.`;

  let declared: string | undefined;
  try {
    const pkgPath = path.join(packageRoot, 'package.json');
    if (existsSyncImpl(pkgPath)) {
      const parsed = JSON.parse(String(readFileSyncImpl(pkgPath, 'utf8'))) as {
        engines?: { node?: unknown };
      };
      if (typeof parsed.engines?.node === 'string') declared = parsed.engines.node;
    }
  } catch {
    // Unreadable or unparseable package.json — handled as "not checked"
    // below. The manifest row is where a broken package.json belongs.
  }

  if (!declared) {
    return createInfo(
      'node-runtime',
      'Node runtime',
      `${facts} Supported range not checked: package.json declared no engines.node.`,
    );
  }

  const ok = satisfiesMinimumNodeRange(nodeVersion, declared);
  if (ok === null) {
    return createInfo(
      'node-runtime',
      'Node runtime',
      `${facts} Supported range not checked: engines.node is "${declared}", which this ` +
        `check does not parse (it understands ">=X.Y.Z" only).`,
    );
  }
  if (!ok) {
    return createCheck(
      'node-runtime',
      'Node runtime',
      'fail',
      `${facts} This package requires Node ${declared}, so this runtime is BELOW the ` +
        `supported floor. Native modules and hooks may fail in ways that look unrelated.`,
      `Upgrade Node to ${declared.replace(/^>=\s*/, '')} or newer, then run \`memesh doctor\` again.`,
    );
  }
  return createCheck(
    'node-runtime',
    'Node runtime',
    'pass',
    `${facts} Meets the required range ${declared}.`,
  );
}

/**
 * Is `node:sqlite` importable in this runtime?
 *
 * Added in Node 22.5. Resolved rather than imported, so the check costs
 * nothing and — importantly — does not trigger the `ExperimentalWarning`
 * that Node 22 prints to stderr on first use. Seven hooks parse process
 * output; a warning emitted by a diagnostic would be a regression caused by
 * the diagnostic.
 */
export function hasBuiltInSqlite(): boolean {
  try {
    createRequire(import.meta.url).resolve('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function inspectNativeBinding(
  packageRoot: string,
  _existsSyncImpl: typeof fs.existsSync,
  probeImpl: (packageRoot: string) => { ok: true } | { ok: false; message: string } = defaultNativeBindingProbe,
): DoctorCheck {
  // DO NOT pre-check `<packageRoot>/node_modules/better-sqlite3` for
  // existence — npm hoists dependencies, so when memesh is installed as
  // a dependency the better-sqlite3 directory lives at the consumer's
  // top-level node_modules, not nested under memesh's packageRoot. The
  // probe below uses Node's normal `require.resolve` which follows the
  // resolution algorithm (current dir → parent → ancestor's node_modules)
  // and correctly finds hoisted packages. If better-sqlite3 is genuinely
  // not installed anywhere on the resolution path, `require()` throws
  // MODULE_NOT_FOUND and the probe returns ok=false with that message,
  // which we surface below with a clean reinstall instruction.
  const result = probeImpl(packageRoot);
  if (result.ok) {
    return createCheck(
      'native-binding',
      'Native SQLite binding',
      'pass',
      'better-sqlite3 native binding loads cleanly (Database probe succeeded).',
    );
  }
  const isMissingBinding = /bindings file|locate the bindings/i.test(result.message);
  const isMissingPackage = /MODULE_NOT_FOUND|Cannot find module/i.test(result.message);
  if (isMissingPackage) {
    return createCheck(
      'native-binding',
      'Native SQLite binding',
      'fail',
      'better-sqlite3 is not installed (Node could not resolve the module from any '
        + 'parent node_modules). Memesh hooks and database operations will not work.',
      `Run: npm install   (in the directory that depends on @pcircle/memesh)`,
    );
  }
  if (isMissingBinding) {
    return createCheck(
      'native-binding',
      'Native SQLite binding',
      'fail',
      'better-sqlite3 is installed but the native binding (.node file) is missing. '
        + 'Hooks will silently skip-and-exit, and auto-capture will NOT write any entities. '
        + 'This is the plugin-marketplace silent-dropout class of bug.',
      `Run: cd "${packageRoot}" && npm rebuild better-sqlite3   (or "npm install --omit=dev" for a clean reinstall)`,
    );
  }
  return createCheck(
    'native-binding',
    'Native SQLite binding',
    'fail',
    `better-sqlite3 failed to load: ${result.message}`,
    `Run: cd "${packageRoot}" && npm rebuild better-sqlite3`,
  );
}

/**
 * Detect the "plugin without shell CLI" gotcha that confuses every new
 * plugin-marketplace user. Symptom: `/plugin install memesh@pcircle-memesh`
 * gives you MCP tools + hooks + the `/memesh` skill inside Claude Code,
 * but does NOT put `memesh` on the shell `PATH`. Users then try
 * `memesh reindex` in a terminal and see `command not found: memesh`.
 *
 * Resolution: also run `npm install -g @pcircle/memesh`. Both paths
 * coexist and share the same DB.
 *
 * This check fires WARN only on plugin-marketplace installs that lack
 * a separate shell-PATH `memesh`. For npm-global / source-checkout
 * channels the check reports PASS with the resolved path. We don't
 * gate it as FAIL because plugin-only is a valid setup for users who
 * only ever interact with memesh through Claude Code chat.
 */
function inspectShellCli(
  installChannel: import('./install-channel.js').InstallChannel,
  packageRoot: string,
  resolveShellMemeshImpl: () => string | null,
): DoctorCheck {
  const shellPath = resolveShellMemeshImpl();
  // Normalize and compare: a shell `memesh` that points back into the
  // same install we're currently running from isn't a "separate" shell
  // CLI — it's the same one. The common case where this matters is
  // plugin-marketplace, where `which memesh` returns null and the user
  // typed `memesh doctor` via some launcher / npx.
  const isSameAsCurrent = shellPath ? path.resolve(shellPath).startsWith(path.resolve(packageRoot)) : false;
  const hasDistinctShellCli = !!shellPath && !isSameAsCurrent;

  if (installChannel === 'npm-global') {
    return createCheck(
      'shell-cli',
      'Shell CLI on PATH',
      'pass',
      shellPath
        ? `\`memesh\` resolves to ${shellPath} (npm-global install — terminals across the machine pick it up).`
        : 'Running from npm-global install — shell access available in this terminal.',
    );
  }

  if (hasDistinctShellCli) {
    return createCheck(
      'shell-cli',
      'Shell CLI on PATH',
      'pass',
      `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}). Both paths coexist and share the same DB.`,
    );
  }

  if (installChannel === 'plugin-marketplace') {
    return createCheck(
      'shell-cli',
      'Shell CLI on PATH',
      'warn',
      'Plugin is installed but `memesh` is not on the shell PATH. Typing `memesh` in a regular terminal will report `command not found`. '
        + 'Claude Code MCP / hooks / `/memesh` skill still work — this only affects standalone shell usage and other MCP clients (Cursor, Cline, etc.).',
      'Run `npm install -g @pcircle/memesh` to add the shell CLI. Both paths coexist; they share the same `~/.memesh/knowledge-graph.db`.',
    );
  }

  // source-checkout / npm-local / unknown — informational only.
  return createCheck(
    'shell-cli',
    'Shell CLI on PATH',
    'pass',
    shellPath
      ? `\`memesh\` resolves to ${shellPath}.`
      : `No shell-PATH \`memesh\` detected. If you want terminal access, run \`npm install -g @pcircle/memesh\` (this install is a ${installChannel}, so the check is informational only).`,
  );
}

function inspectDashboardArtifact(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
): DoctorCheck {
  const dashboardPath = path.join(packageRoot, 'dashboard', 'dist', 'index.html');
  if (!existsSyncImpl(dashboardPath)) {
    return createCheck(
      'dashboard',
      'Dashboard artifact',
      'fail',
      'dashboard/dist/index.html is missing.',
      'Build the dashboard with `cd dashboard && npm install && npm run build`, then run `npm run build` at the repo root if needed.',
    );
  }

  return createCheck(
    'dashboard',
    'Dashboard artifact',
    'pass',
    'dashboard/dist/index.html is present.',
  );
}

async function inspectUpdateStatus(
  packageVersion: string,
  getUpdateCheckImpl: typeof getUpdateCheck,
  installSupport?: import('./install-channel.js').InstallChannelSupport,
): Promise<DoctorCheck> {
  const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
  if (!update) {
    return createCheck(
      'update-status',
      'Update status',
      'warn',
      'No successful cached npm update check is available yet.',
      'Run `memesh status` once while online to populate update status.',
    );
  }

  // Deprecation outranks ordinary update-available — a maintainer-
  // flagged version is the only doctor finding that should escalate
  // to `fail` here, because it carries security implications. We
  // route the deprecation message through the same advisory line the
  // session-start banner uses, so the user sees the same string in
  // both surfaces.
  //
  // Codex round 33: this check runs BEFORE the freshness=='unavailable'
  // guard. Round 31's fix made checkForUpdate persist a successful
  // deprecation result even when the latest-version lookup failed —
  // but in that scenario `lastSuccessfulCheckAt` stays null and
  // freshness comes back as 'unavailable'. Bailing on freshness first
  // would suppress the security signal exactly when it just arrived.
  if (update.currentVersionDeprecated && update.deprecationMessage) {
    const target = update.latestVersion && update.latestVersion !== packageVersion
      ? ` -> ${update.latestVersion}`
      : '';
    // Tailor the fix message to the install channel. `memesh
    // update` only works for npm-global self-updatable installs
    // when there's a newer version published; pointing source-
    // checkout / npm-local users at it (or pointing anyone at it
    // when latestVersion is missing or unchanged) sends them at
    // a remediation that won't help.
    const hasUpgradeTarget = update.latestVersion
      && update.latestVersion !== packageVersion;
    // Codex round 39: the previous "confirmedNoUpgradeTarget" branch
    // required `update.freshness === 'fresh'`, but doctor calls
    // `getUpdateCheck(..., { preferFresh: false })`, so the cached
    // data path here can never be 'fresh'. The branch was dead code.
    // Resolution: always recommend `memesh update` (or channel
    // equivalent). When there's truly no upgrade target,
    // `npm install -g @latest` is a harmless no-op; when one ships,
    // the command applies it immediately. The "no upgrade target"
    // message lives only in `memesh status` (which CAN do a fresh
    // lookup) and the dashboard (after a Check now click) — both
    // surfaces where freshness === 'fresh' is reachable.
    let fix: string;
    if (installSupport?.canSelfUpdate) {
      fix = hasUpgradeTarget
        ? `Run \`memesh update\`${target}.`
        : 'Run `memesh update` to refresh the registry lookup and apply any newly-published fix.';
    } else if (installSupport?.guidance) {
      fix = installSupport.guidance + (hasUpgradeTarget
        ? ` Upgrade target: ${update.latestVersion}.`
        : ' Upgrade target uncertain — re-check `memesh status` while online.');
    } else {
      fix = `Upgrade via your install method (see \`memesh status\`).`;
    }
    return createCheck(
      'update-status',
      'Update status',
      'fail',
      `Installed version ${packageVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`,
      fix,
    );
  }

  // Now that deprecation has been surfaced, the no-fresh-data path
  // is the right answer for users who haven't completed a successful
  // check yet (and have no security advisory waiting).
  if (update.freshness === 'unavailable') {
    return createCheck(
      'update-status',
      'Update status',
      'warn',
      'No successful cached npm update check is available yet.',
      'Run `memesh status` once while online to populate update status.',
    );
  }

  // Partial-failure surfaces with checkSucceeded=true + lastError
  // populated (deprecation sub-call timed out / blocked, version
  // lookup answered). Doctor must NOT report a clean pass in that
  // case — the security signal is genuinely unknown. But the
  // version lookup DID answer, so include the actionable update
  // info if there's a newer version, instead of suppressing
  // the user's clearest path forward.
  if (update.checkSucceeded && update.lastError) {
    const hasUpdate = Boolean(update.updateAvailable && update.latestVersion);
    const summary = hasUpdate
      ? `Deprecation status unknown for ${packageVersion}: ${update.lastError}. Update ${update.latestVersion} is available.`
      : `Deprecation status unknown for ${packageVersion}: ${update.lastError}.`;
    // Tailor the upgrade hint to the install channel — `memesh
    // update` only works for npm-global self-updatable installs.
    let upgradeHint: string;
    if (hasUpdate) {
      if (installSupport?.canSelfUpdate) {
        upgradeHint = `, or \`memesh update\` to apply ${update.latestVersion}`;
      } else if (installSupport?.guidance) {
        upgradeHint = `. Upgrade target ${update.latestVersion} via your install method: ${installSupport.guidance}`;
      } else {
        upgradeHint = `. Upgrade target: ${update.latestVersion}.`;
      }
    } else {
      upgradeHint = '';
    }
    const fix = `Run \`memesh status\` while online to retry the deprecation lookup${upgradeHint}.`;
    return createCheck('update-status', 'Update status', 'warn', summary, fix);
  }

  if (update.updateAvailable && update.latestVersion) {
    // F14: User sees confusing "4.1.4 -> 4.1.3" on release branches — the
    // local version (unreleased) is ahead of npm latest. Don't warn unless
    // the update is actually an upgrade (semantic version comparison would
    // be more accurate, but a simple string comparison catches 99% of cases).
    if (packageVersion < update.latestVersion) {
      return createCheck(
        'update-status',
        'Update status',
        'warn',
        `Update available: ${update.latestVersion} (current: ${packageVersion})`,
        `Run 'memesh update' to upgrade`,
      );
    } else {
      // Local version is ahead (pre-release or release branch) — don't warn
      return createCheck(
        'update-status',
        'Update status',
        'pass',
        `Running pre-release version (${packageVersion}), npm latest is ${update.latestVersion}`,
      );
    }
  }

  return createCheck(
    'update-status',
    'Update status',
    update.freshness === 'stale' ? 'warn' : 'pass',
    `Version ${packageVersion} is current${update.freshness === 'stale' ? ', but cached update data is stale.' : '.'}`,
    update.freshness === 'stale'
      ? 'Run `memesh status` while online to refresh cached update metadata.'
      : undefined,
  );
}

async function inspectHttpProbe(
  httpBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}/v1/health`);
    if (!response.ok) {
      return createCheck(
        'http-probe',
        'HTTP probe',
        'warn',
        `HTTP server responded with ${response.status} at ${httpBaseUrl}.`,
        'Run `memesh serve` and check the logs, then retry `memesh doctor --probe-http`.',
      );
    }

    return createCheck(
      'http-probe',
      'HTTP probe',
      'pass',
      `HTTP server is reachable at ${httpBaseUrl}.`,
    );
  } catch {
    return createCheck(
      'http-probe',
      'HTTP probe',
      'warn',
      `No running HTTP server detected at ${httpBaseUrl}.`,
      'Start the local server with `memesh serve` if you want dashboard and HTTP API verification.',
    );
  }
}

/**
 * F4: verify the on-disk skill files + hooks match the SHA-256 manifest
 * generated at publish time. This catches tampering between npm publish
 * and the user's machine — e.g. a malicious overlay copied into
 * node_modules after install — which `npm --provenance` alone cannot
 * detect (provenance attests the tarball, not the unpacked files).
 *
 * Manifest is at dist/skills-manifest.json. If it's missing, we treat
 * that as a `warn` (developer install from source) rather than `fail`,
 * since source checkouts run `npm run build` on demand. A packaged
 * install from npm will always have it.
 */
function verifySkillsManifest(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const manifestPath = path.join(packageRoot, 'dist', 'skills-manifest.json');
  if (!existsSyncImpl(manifestPath)) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'warn',
      'No skills-manifest.json found. This is normal for source checkouts — packaged installs ship the manifest.',
      'Run `npm run build` to regenerate, or reinstall via `npm install -g @pcircle/memesh`.',
    );
  }
  let manifest: { entries?: Array<{ path: string; sha256: string }> };
  try {
    manifest = JSON.parse(readFileSyncImpl(manifestPath, 'utf8'));
  } catch (err) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'fail',
      `skills-manifest.json is unreadable (${err instanceof Error ? err.message : 'parse error'}).`,
      'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem persists open an issue.',
    );
  }
  const entries = manifest.entries ?? [];
  if (entries.length === 0) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'fail',
      'skills-manifest.json contains zero entries.',
      'Reinstall the package: `npm install -g @pcircle/memesh`.',
    );
  }
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    const full = path.join(packageRoot, entry.path);
    if (!existsSyncImpl(full)) { missing.push(entry.path); continue; }
    let actualHash: string;
    try {
      const buf = readFileSyncImpl(full);
      actualHash = createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      mismatches.push(`${entry.path} (read error: ${err instanceof Error ? err.message : 'unknown'})`);
      continue;
    }
    if (actualHash !== entry.sha256) mismatches.push(entry.path);
  }
  if (missing.length === 0 && mismatches.length === 0) {
    return createCheck(
      'skills-manifest',
      'Skills + hooks integrity',
      'pass',
      `${entries.length} skill / hook files match the published manifest (SHA-256 verified).`,
    );
  }
  const detail = [
    missing.length > 0 ? `${missing.length} missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}` : null,
    mismatches.length > 0 ? `${mismatches.length} tampered: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? ` (+${mismatches.length - 3} more)` : ''}` : null,
  ].filter(Boolean).join('; ');
  return createCheck(
    'skills-manifest',
    'Skills + hooks integrity',
    'fail',
    `Manifest verification failed: ${detail}.`,
    'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh-llm-memory/security.',
  );
}

/**
 * Is `~/.memesh/config.json` actually parseable?
 *
 * `readConfig()` returns `{}` on ANY read failure — corrupt JSON, a
 * half-written file, EACCES — not just "file absent". A corrupt config
 * therefore erases `llm`, `llmFallbacks` and `embedder` silently, and every
 * Smart-Mode feature degrades to a no-op while doctor happily reported
 * "Config file is readable". This row makes that state visible.
 */
async function inspectConfigParse(
  getConfigPathImpl: typeof getConfigPath,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): Promise<DoctorCheck> {
  const configPath = getConfigPathImpl();
  if (!existsSyncImpl(configPath)) {
    return createCheck(
      'config_parse',
      'Config parses',
      'pass',
      'No config file yet — defaults apply. This is normal for a fresh install.',
    );
  }
  try {
    const raw = readFileSyncImpl(configPath, 'utf8') as string;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createCheck(
        'config_parse',
        'Config parses',
        'fail',
        `${configPath} parsed but is not a JSON object — every setting is being ignored.`,
        `Fix or remove ${configPath}, then re-run memesh doctor.`,
      );
    }
    return createCheck('config_parse', 'Config parses', 'pass', `${configPath} is valid JSON and its settings are in effect.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createCheck(
      'config_parse',
      'Config parses',
      'fail',
      `${configPath} could not be read or parsed (${msg}). Every setting in it — LLM provider, fallbacks, embedder — is being silently ignored right now.`,
      `Fix the JSON or remove the file to fall back to defaults: mv ${configPath} ${configPath}.bak`,
    );
  }
}

/**
 * Does embedding generation actually work?
 *
 * Config saying `embeddings: openai` proves only that a string was written
 * to a file. A blocked model download, a corrupt `~/.memesh/models` cache,
 * a bad BYOK key or a dimension mismatch all leave the config untouched
 * while every vector write and semantic recall silently returns nothing.
 *
 * The probe is therefore real — but it must never have side effects the
 * user did not ask a *diagnostic* command for. Two cases are gated behind
 * `--probe`:
 *
 *   - a BYOK provider (openai / ollama / anthropic) is a network call, and
 *     for hosted providers a billed one;
 *   - local ONNX with a cold cache would download ~90 MB of model weights.
 *     `memesh doctor` is what you reach for when the network is already
 *     misbehaving; it must not be the command that starts a large download.
 *
 * When the probe is skipped the row says NOT VERIFIED and names the reason.
 * That is not the hardcoded-'pass' failure this row was rewritten to fix —
 * the point of that fix was that "not verified" and "verified working" must
 * never look the same, which is exactly what this preserves. Same shape as
 * `inspectLlmProbe`.
 */
async function inspectEmbeddingProbe(
  capabilities: Capabilities,
  probeCapabilities: boolean,
  embedTextImpl: (text: string) => Promise<Float32Array | null>,
): Promise<DoctorCheck> {
  if (capabilities.embeddings === 'tfidf') {
    return createInfo(
      'embeddings_probe',
      'Embeddings work',
      'No neural embedder configured — recall runs on FTS5 keyword search alone. That is a supported mode, not a fault.',
    );
  }

  if (!probeCapabilities) {
    const isLocal = capabilities.embeddings === 'onnx';
    if (!isLocal) {
      return createInfo(
        'embeddings_probe',
        'Embeddings work',
        `NOT VERIFIED. Config names "${capabilities.embeddings}", but generating a test embedding is a network call (billed on hosted providers) so it was not made — a revoked key or an unreachable host would look identical to a healthy setup here.`,
        'Run: memesh doctor --probe   (generates one test embedding to confirm)',
      );
    }
    if (!isOnnxModelCached()) {
      return createInfo(
        'embeddings_probe',
        'Embeddings work',
        `NOT VERIFIED. Config names "onnx" but the model is not in the local cache yet, and probing would download ~90 MB — which a diagnostic command must not do on its own.`,
        'Run: memesh doctor --probe   (downloads the model once, then verifies)',
      );
    }
    // Local model already on disk: probing costs a few hundred ms and no
    // network, so verify for real even without --probe.
  }

  // Bound the probe. A BYOK embedder is a network call and the local ONNX
  // path can block on a cold model load, so an unbounded await turns
  // `memesh doctor` — the command you reach for when things are wrong — into
  // the thing that hangs. Timing out is itself a useful answer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vector = await Promise.race([
      embedTextImpl('memesh doctor embedding probe'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no response within ${EMBEDDING_PROBE_TIMEOUT_MS / 1000}s`)),
          EMBEDDING_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    if (!vector || vector.length === 0) {
      return createCheck(
        'embeddings_probe',
        'Embeddings work',
        'warn',
        `Config selects "${capabilities.embeddings}" but generating a test embedding returned nothing. Semantic recall is degraded to FTS5-only; keyword search still works.`,
        'Run: memesh doctor --probe for detail, or check network access to the embedding provider.',
      );
    }
    return createCheck(
      'embeddings_probe',
      'Embeddings work',
      'pass',
      `Generated a ${vector.length}-dim test embedding via "${capabilities.embeddings}".`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createCheck(
      'embeddings_probe',
      'Embeddings work',
      'warn',
      `Config selects "${capabilities.embeddings}" but the embedder threw (${msg}). Semantic recall is degraded to FTS5-only.`,
      'Check the embedding provider is reachable, or set: memesh config set embedder.provider onnx',
    );
  } finally {
    // If the embedder answered first, the timeout is still pending — and
    // because the CLI sets exitCode without calling process.exit(), a live
    // timer would keep the event loop open and hang `memesh doctor` for up to
    // EMBEDDING_PROBE_TIMEOUT_MS after the report prints. Clear it.
    clearTimeout(timer);
  }
}

/**
 * Does the configured LLM actually answer?
 *
 * Network-probing on every `memesh doctor` would add latency and (for
 * hosted providers) cost, so the live probe is opt-in via `--probe`.
 * Crucially, when the probe has NOT run this row says so explicitly rather
 * than reporting a green it did not earn — "not verified" and "verified
 * working" must never look the same.
 */
async function inspectLlmProbe(
  capabilities: Capabilities,
  probeCapabilities: boolean,
  probeProviderImpl: typeof probeProvider,
): Promise<DoctorCheck> {
  const llm = capabilities.llm;
  if (!llm) {
    return createInfo(
      'llm_probe',
      'LLM reachable',
      'No LLM configured — Core Mode. Write-side features (consolidate, lessons, auto-tag, dream) are off by design.',
    );
  }
  if (!probeCapabilities) {
    return createInfo(
      'llm_probe',
      'LLM reachable',
      `NOT VERIFIED. Config names ${llm.provider} (${llm.model ?? 'default'}), but no live call was made — an expired key or an unreachable host would look identical to a healthy setup here.`,
      'Run: memesh doctor --probe   (makes one small live call to confirm)',
    );
  }
  try {
    const result = await probeProviderImpl(llm.provider, llm.apiKey);
    if (result.valid) {
      return createCheck('llm_probe', 'LLM reachable', 'pass', `${llm.provider} answered a live probe.`);
    }
    return createCheck(
      'llm_probe',
      'LLM reachable',
      'fail',
      `${llm.provider} is configured but did not answer: ${result.error ?? 'unknown error'}. Every LLM-backed feature is silently doing nothing.`,
      'Check the API key / host, then re-run: memesh doctor --probe',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createCheck(
      'llm_probe',
      'LLM reachable',
      'fail',
      `${llm.provider} probe threw: ${msg}. Every LLM-backed feature is silently doing nothing.`,
      'Check the API key / host, then re-run: memesh doctor --probe',
    );
  }
}

function summarizeOverallStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  // Informational rows describe state and cannot fail — counting them would
  // pad the verdict with rows that verified nothing. See DoctorCheck.informational.
  const assertions = checks.filter((check) => !check.informational);
  if (assertions.some((check) => check.status === 'fail')) return 'FAIL';
  if (assertions.some((check) => check.status === 'warn')) return 'PASS_WITH_CONCERNS';
  return 'PASS';
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const {
    packageRoot,
    packageVersion,
    probeHttp = false,
    probeCapabilities = false,
    embedTextImpl = embedText,
    probeProviderImpl = probeProvider,
    httpBaseUrl = 'http://127.0.0.1:3737',
    platform = process.platform,
    openDatabaseImpl = openDatabase,
    closeDatabaseImpl = closeDatabase,
    isDatabaseOpenImpl = isDatabaseOpen,
    detectCapabilitiesImpl = detectCapabilities,
    getConfigPathImpl = getConfigPath,
    getUpdateCheckImpl = getUpdateCheck,
    getCurrentInstallChannelImpl = getCurrentInstallChannel,
    getInstallChannelSupportImpl = getInstallChannelSupport,
    existsSyncImpl = fs.existsSync,
    readFileSyncImpl = fs.readFileSync,
    statSyncImpl = fs.statSync,
    fetchImpl = fetch,
    nativeBindingProbeImpl,
    resolveShellMemeshImpl = defaultResolveShellMemesh,
  } = options;

  // F16: If the database is already open before doctor runs (e.g., the
  // HTTP server opened it at startup and is still serving requests), we
  // must NOT close it — that would set the global db = null and break
  // every subsequent /v1/* request. Substitute a noop close so doctor's
  // "best-effort cleanup" is truly best-effort and never destructive.
  // CLI usage (where db starts null) is unaffected: noop only kicks in
  // when the db was already open when we arrived.
  const wasDbOpenBeforeUs = isDatabaseOpenImpl();
  const safeCloseDatabaseImpl: typeof closeDatabase = wasDbOpenBeforeUs
    ? () => undefined
    : closeDatabaseImpl;

  const checks: DoctorCheck[] = [];

  const install = getCurrentInstallChannelImpl({ packageRoot });
  const installSupport = getInstallChannelSupportImpl(install);
  checks.push(
    createCheck(
      'install-channel',
      'Install method',
      install === 'unknown' ? 'warn' : 'pass',
      `Install method detected: ${installSupport.label}.`,
      install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined,
    ),
  );

  const databasePath = resolveDatabasePath();
  // Staged, not pushed directly.
  //
  // The `pass` row used to go into `checks` the moment the entity count came
  // back, before the rest of this block ran. Anything that threw afterwards was
  // caught below and pushed a SECOND row with the same `database` id and status
  // `fail` — so a failing database reported both, and `checks.find(c => c.id
  // === 'database')` returned the passing one. The overall verdict was right
  // and the row a reader looks at was wrong, which is worse than either alone.
  // Staging here means the block emits exactly one `database` row, whichever
  // way it ends.
  const dbChecks: DoctorCheck[] = [];
  try {
    const db = openDatabaseImpl(databasePath) as unknown as DatabaseLike;
    const count =
      (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c?: number } | undefined)?.c ?? 0;
    dbChecks.push(
      createCheck(
        'database',
        'Database',
        'pass',
        `Database opened successfully at ${databasePath} (${count} entities).`,
      ),
    );

    // The stale-keyword-index state, which two comments claimed doctor detected
    // and nothing checked.
    //
    // The segmentation marker only moves FORWARD, which leaves one state it
    // cannot describe: a database migrated by a segmentation-aware build and
    // then written to by an older one. The old build does not know the marker
    // exists, so it indexes new memories with the old rules and leaves the
    // marker alone; re-upgrading short-circuits and those memories stay
    // unreachable by any partial-phrase query, permanently. Users reach it
    // legitimately — an npm-global and a plugin-marketplace install side by
    // side, or a downgrade to recover from a bad release.
    //
    // The message reports a COUNT, never an example term. `memesh feedback` and
    // the dashboard's feedback widget copy every doctor check summary verbatim
    // into a pre-filled PUBLIC GitHub issue body, and diagnostics are opt-OUT —
    // so an example term lifted from `fts_vocab` is a line of the user's own
    // memories staged for publication. A count is just as actionable: run the
    // rebuild, re-run doctor, expect 0.
    //
    // Detected by looking for what the old rules leave behind: an indexed term
    // longer than a bigram that STARTS with an unspaced-script character. The
    // range set is imported from `fts-index.ts` rather than repeated here — it
    // grew from CJK-only to ten ranges, and a hand-written copy would have gone
    // on reporting a healthy index over an unsegmented Thai one. The
    // segmenting build cannot produce one, so its presence means some rows were
    // written by a build that was not segmenting.
    //
    // Deliberately NOT wrapped in `try/catch`. `fts_vocab` is absent only on a
    // database built by a schema older than the view, which `sqlite_master`
    // answers exactly; anything else that makes this query throw is a real
    // fault and belongs in the database check below, loudly. A blanket catch
    // here would also have swallowed the doctor-test stub's own assertion,
    // leaving this check permanently unexercised with the suite green — the
    // failure mode this whole branch exists to remove.
    const hasVocab = db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fts_vocab'`)
      .get() as { present?: number } | undefined;
    if (hasVocab?.present) {
      const unsegmented = db
        .prepare(
          `SELECT COUNT(*) AS c FROM fts_vocab
            WHERE length(term) > 2
              AND term GLOB ?`
        )
        .get(UNSPACED_SCRIPT_GLOB_RUN3) as { c?: number } | undefined;
      if (unsegmented?.c) {
        dbChecks.push(
          createCheck(
            'fts_segmentation',
            'Keyword index segmentation',
            'warn',
            `The keyword index holds ${unsegmented.c} unsegmented term(s), so some memories are only ` +
              `findable by their exact full text. This happens when an older build wrote to a database ` +
              `that a newer one had already migrated — the version marker only moves forward, so the ` +
              `automatic rebuild cannot notice. Re-run doctor after the rebuild: this count should be 0.`,
            `Run 'memesh reindex --fts' to rebuild the keyword index.`,
          ),
        );
      }
    }

    const pendingReindex = getPendingReindexInfo();
    if (pendingReindex) {
      dbChecks.push(
        createCheck(
          'vector_index',
          'Vector Index',
          'warn',
          `Search index needs rebuilding (embedding configuration changed)`,
          `Run 'memesh reindex' to fix. This will restore full search functionality.`,
        ),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown database error';

    // F15: Provide actionable diagnosis for common database failures
    let diagnosis: string;
    let fix: string;

    // Check if database file exists but can't be opened
    if (existsSyncImpl(databasePath)) {
      try {
        const stat = statSyncImpl(databasePath);
        const canRead = !!(stat.mode & 0o400);
        const canWrite = !!(stat.mode & 0o200);

        if (!canRead || !canWrite) {
          diagnosis = `Database file exists but has insufficient permissions (${(stat.mode & 0o777).toString(8)})`;
          fix = `Fix permissions: chmod 600 "${databasePath}"`;
        } else if (stat.size === 0) {
          diagnosis = 'Database file is empty (0 bytes) — likely corrupted';
          fix = `Delete and recreate: rm "${databasePath}" && memesh recall (will create fresh DB)`;
        } else {
          diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
          fix = `Backup and reset: mv "${databasePath}" "${databasePath}.backup" && memesh recall`;
        }
      } catch {
        diagnosis = `Database file exists at ${databasePath} but stat() failed: ${message}`;
        fix = `Check file system integrity and permissions`;
      }
    } else {
      // Database file doesn't exist — check parent directory
      const dir = path.dirname(databasePath);
      if (!existsSyncImpl(dir)) {
        diagnosis = `Database directory does not exist: ${dir}`;
        fix = `Create directory: mkdir -p "${dir}" && memesh recall (will create fresh DB)`;
      } else {
        try {
          const dirStat = statSyncImpl(dir);
          const canWrite = !!(dirStat.mode & 0o200);
          if (!canWrite) {
            diagnosis = `Cannot create database — directory is not writable: ${dir}`;
            fix = `Fix directory permissions: chmod 700 "${dir}"`;
          } else {
            diagnosis = `Database file missing at ${databasePath}, but directory exists and is writable`;
            fix = `Run any memesh command (e.g., memesh recall) to create a fresh database`;
          }
        } catch {
          diagnosis = `Database directory exists but cannot be accessed: ${dir}`;
          fix = `Check directory permissions and ownership`;
        }
      }
    }

    // Replaces, not appends: whatever was staged before the throw describes a
    // database this function has just concluded it cannot use.
    dbChecks.length = 0;
    dbChecks.push(
      createCheck(
        'database',
        'Database',
        'fail',
        diagnosis,
        fix,
      ),
    );
  } finally {
    checks.push(...dbChecks);
    try {
      safeCloseDatabaseImpl();
    } catch {
      // Best-effort cleanup only.
    }
  }

  checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl));
  checks.push(inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl));
  checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
  // Runtime wiring + activity (#25 — file existence isn't enough;
  // doctor used to PASS for users whose Claude Code never loaded
  // memesh's hooks at all).
  checks.push(inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), packageRoot));
  checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl));
  checks.push(inspectDashboardArtifact(packageRoot, existsSyncImpl));
  // Before the native-binding row, because when that one is red this one is
  // the context that explains it.
  checks.push(inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl));
  checks.push(inspectNativeBinding(packageRoot, existsSyncImpl, nativeBindingProbeImpl));
  checks.push(inspectShellCli(install, packageRoot, resolveShellMemeshImpl));
  checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl));

  // Capabilities: what the CONFIG says. This row asserts nothing about
  // whether any of it works, so it is informational by construction.
  // The rows that follow do the actual verifying.
  const capabilities = detectCapabilitiesImpl();
  checks.push(
    createInfo(
      'capabilities',
      'Capabilities (configured)',
      `Search level ${capabilities.searchLevel} (${capabilities.searchLevel === 1 ? 'Smart Mode' : 'Core'}); embeddings: ${capabilities.embeddings}; LLM: ${capabilities.llm ? `${capabilities.llm.provider} (${capabilities.llm.model ?? 'default'})` : 'not configured'}. Configured values only — see the probe rows below for what actually works.`,
    ),
  );

  checks.push(await inspectConfigParse(getConfigPathImpl, existsSyncImpl, readFileSyncImpl));
  checks.push(await inspectEmbeddingProbe(capabilities, probeCapabilities, embedTextImpl));
  checks.push(await inspectLlmProbe(capabilities, probeCapabilities, probeProviderImpl));

  checks.push(await inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport));

  // Anonymous install ID — surfaced so the user can SEE what's
  // included in feedback issues (transparency). Never sent
  // automatically; only attached to feedback bodies the user
  // explicitly opts into sharing via "Include system info".
  try {
    const record = getInstallRecord();
    checks.push(
      createCheck(
        'install_id',
        'Install ID',
        'pass',
        `Anonymous install ID: ${record.install_id} (created ${record.created_at}). Stored locally at ~/.memesh/install.json. Never transmitted automatically; included only in feedback issues you submit with the "Include system info" checkbox on.`,
      ),
    );
  } catch {
    // Non-critical — doctor must never fail because of an info check.
  }

  checks.push(inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl));

  if (probeHttp) {
    checks.push(await inspectHttpProbe(httpBaseUrl, fetchImpl));
  }

  return {
    status: summarizeOverallStatus(checks),
    checks,
  };
}

function iconForStatus(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    default:
      return 'FAIL';
  }
}

export function formatDoctorReport(result: DoctorResult, packageVersion: string): string[] {
  const lines = [`MeMesh doctor v${packageVersion}`, `Overall: ${result.status}`];

  for (const check of result.checks) {
    lines.push('');
    // Informational rows must NOT read as [PASS] — that is the whole bug
    // this flag exists to prevent (a row that verified nothing looking
    // identical to one that did).
    lines.push(`[${check.informational ? 'INFO' : iconForStatus(check.status)}] ${check.label}`);
    lines.push(`  ${check.summary}`);
    if (check.fix) {
      lines.push(`  Fix: ${check.fix}`);
    }
  }

  return lines;
}
