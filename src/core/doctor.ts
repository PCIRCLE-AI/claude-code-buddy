import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { detectCapabilities, getConfigPath, isTranscriptMiningEnabled, readConfig, type Capabilities } from './config.js';
import { embedText } from './embedder.js';
import { probeProvider } from './llm-validator.js';
import {
  openDatabase, closeDatabase, getPendingReindexInfo, isDatabaseOpen,
  readVectorGeneration, generationRowIds,
} from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport, type InstallChannel } from './install-channel.js';
import { getInstallRecord } from './install-id.js';
import { getDbPath, memeshDir, getProjectName } from './paths.js';
import { detectPluginRuntime } from './install-hooks.js';
import { lastTranscriptMineAt } from './transcript-source.js';
import { UNSPACED_SCRIPT_GLOB_RUN3 } from '../storage/fts-index.js';
import { MemeshDatabase } from '../storage/sqlite.js';
import { AUTO_CAPTURE_TAG } from './types.js';
import { parseSqliteUtcMs } from './time-utils.js';
import { autoCaptureDecision } from './capture-flag.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorOverallStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  fix?: string;
  /**
   * Machine identifier for `doctor --fix`, attached at the BRANCH that
   * diagnosed the problem — never parsed out of the human `fix` string.
   * Orthogonal to `code` (i18n): a fixId claims no catalogue entry.
   * Only prescriptions on --fix's whitelist carry one; everything else
   * stays advice for a human.
   */
  fixId?: 'install-hooks' | 'fts-rebuild' | 'chmod-db';
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
  /**
   * Stable message-variant code + interpolation params, present on every
   * warn/fail row. The dashboard translates by code (doctor.msg.<code>.*)
   * and interpolates params — the earlier attempt to localize by check `id`
   * alone was reverted because one id has many states and a generic label
   * destroyed the diagnostic detail. `summary`/`fix` remain the English
   * source of truth (the CLI prints them; the dashboard falls back to them
   * when a code has no catalogue entry). tests/dashboard-i18n.test.ts scans
   * this file for `code:` literals and fails when the catalogue misses one,
   * so a new warn/fail variant cannot ship untranslated.
   */
  code?: string;
  params?: Record<string, string | number>;
}

export interface DoctorResult {
  status: DoctorOverallStatus;
  checks: DoctorCheck[];
}

interface JsonObject {
  [key: string]: unknown;
}

/**
 * The slice of the SQLite driver doctor uses, so tests can substitute a stub.
 *
 * `get` returns `unknown` and takes bind parameters. It used to be typed
 * `() => { c?: number }` — the shape of the one query that existed when it was
 * written — which forced every later caller to cast its result to something
 * else, and a cast is not a check. Returning `unknown` makes each call site
 * state what it expects at the point it reads it.
 */
interface DatabaseLike {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
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
  /** Test override for Claude Code's plugin registry — the default reads the
   *  real machine, which would make hook-wiring tests host-state-dependent. */
  installedPluginsPathImpl?: string;
  getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
  existsSyncImpl?: typeof fs.existsSync;
  readFileSyncImpl?: typeof fs.readFileSync;
  statSyncImpl?: typeof fs.statSync;
  fetchImpl?: typeof fetch;
  /**
   * Test seam: probe that a database opens and sqlite-vec loads. Default
   * resolves sqlite-vec from packageRoot the way Node would; tests inject a
   * stub so the check can be exercised without a real extension.
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
 * local ollama call or a hosted embedder round-trip, short enough that doctor
 * always returns.
 */
const EMBEDDING_PROBE_TIMEOUT_MS = 15000;

const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];

// Locale READMEs that MUST stay in lockstep with README.md. Order matters
// only for the doctor output — alphabetised for readability.
const LOCALE_README_FILES = [
  // The locale set was reduced to English + 繁體中文 + Deutsch (commit
  // bc6d8553) — eleven hand-synced copies of a fast-moving front page
  // drifted faster than they were read. This list must track that set:
  // listing a removed locale here made every source-checkout doctor run
  // WARN about eight files that are gone on purpose.
  'README.de.md',
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
      undefined,
      { code: 'readme-parity.unreadable', params: { detail: err instanceof Error ? err.message : String(err) } },
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
    { code: 'readme-parity.drift', params: { detail: parts.join('; '), tolerance: LOCALE_H2_TOLERANCE } },
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
  // `code` is optional: a PASS row may carry machine-readable params (e.g.
  // hook-wiring's captureWired, consumed by runDoctor) without claiming a
  // catalogue entry — the i18n scan only covers codes, which is correct,
  // because codeless params never render through a locale template.
  i18n?: { code?: string; params?: Record<string, string | number> },
  fixId?: DoctorCheck['fixId'],
): DoctorCheck {
  return { id, label, status, summary, fix, code: i18n?.code, params: i18n?.params, fixId };
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

/**
 * Is `~/.memesh/config.json` present, parseable, and an object?
 *
 * ONE row for one file. This used to be two rows (`config` here and a later
 * `config_parse`) that both read + parsed the same file and both failed on
 * invalid JSON — two IDs, two i18n families and two fix strings to keep
 * aligned for one fact. Merged keeping this row's id (pinned by tests) and
 * the stricter checks: `readConfig()` returns `{}` on ANY read failure —
 * corrupt JSON, a half-written file, EACCES, an array root — so every
 * Smart-Mode setting degrades to a silent no-op; this row makes that state
 * visible.
 */
function inspectConfigFile(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  getConfigPathImpl: typeof getConfigPath,
  envLlm: { provider: string; apiKey?: string } | null,
): DoctorCheck {
  const configPath = getConfigPathImpl();
  if (!existsSyncImpl(configPath)) {
    // "No config file" is not "Core mode". An API key in the environment is
    // enough for Smart Mode with no file at all, and this check used to say
    // Core mode regardless while the Capabilities line two sections later
    // said Smart Mode — the same report contradicting itself. The dream gate
    // already learned this (detectCapabilities, not readConfig); doctor's own
    // Config check had not. Take the level from the one detector, and say
    // which it is.
    return createCheck(
      'config',
      'Config',
      'pass',
      // Name WHAT enabled it. The first version of this sentence said "an API
      // key in the environment", which is false for OLLAMA_HOST — that sets a
      // provider with no key at all, and sent the user hunting for one.
      envLlm
        ? `No config file yet (${configPath}), but your environment names ${envLlm.provider}${envLlm.apiKey ? ' (via its API key)' : ' (via OLLAMA_HOST)'}, which enables Smart Mode. A file is only needed to pin a provider or change defaults.`
        : `No config file yet (${configPath}). MeMesh will run in Core mode until you configure Smart Mode.`,
      envLlm
        ? `Optional: \`memesh config set llm.provider ${envLlm.provider}\` pins it so it does not depend on which shell you run from.`
        : 'Optional: run `memesh config list` or set an LLM with `memesh config set llm.provider anthropic`.',
    );
  }

  try {
    const raw = readFileSyncImpl(configPath, 'utf8') as string;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createCheck(
        'config',
        'Config',
        'fail',
        `${configPath} parsed but is not a JSON object — every setting is being ignored.`,
        `Fix or remove ${configPath}, then re-run memesh doctor.`,
        { code: 'config-parse.not-object', params: { path: configPath } },
      );
    }
    return createCheck('config', 'Config', 'pass', `${configPath} is valid JSON and its settings are in effect.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createCheck(
      'config',
      'Config',
      'fail',
      `${configPath} could not be read or parsed (${msg}). Every setting in it — LLM provider, fallbacks, embedder — is being silently ignored right now.`,
      `Fix the JSON or remove the file to fall back to defaults: mv ${configPath} ${configPath}.bak`,
      { code: 'config-parse.unreadable', params: { path: configPath, detail: msg } },
    );
  }
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
      { code: 'mcp-config.missing' },
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
      { code: 'mcp-config.invalid-json', params: { path: mcpPath } },
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
      { code: 'mcp-config.no-entry' },
    );
  }

  // Does the script it points at exist?
  //
  // This check used to stop at "there is a string `command`", which made it
  // structurally unable to notice the one way this file actually breaks. When
  // the MCP entry point was renamed, `.mcp.json` kept pointing at the old path
  // and every MCP tool died with `-32000 failed to reconnect` — while doctor
  // reported PASS, because the entry was still well-formed. A config that names
  // a file that is not there is not a valid config.
  const args = Array.isArray(server.args) ? server.args : [];
  const entry = typeof args[0] === 'string' ? args[0] : null;
  if (entry) {
    // Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} with the installed plugin
    // directory, which is this package root.
    const resolved = path.resolve(entry.replaceAll('${CLAUDE_PLUGIN_ROOT}', packageRoot));
    if (!existsSyncImpl(resolved)) {
      return createCheck(
        'mcp-config',
        'MCP config',
        'fail',
        `.mcp.json starts \`${entry}\`, and that file is not in this install — so every memesh MCP tool fails to start.`,
        'Reinstall MeMesh; if you edited `.mcp.json` by hand, point it back at `${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js`.',
        { code: 'mcp-config.entry-missing', params: { entry, resolved } },
      );
    }
  }

  return createCheck(
    'mcp-config',
    'MCP config',
    'pass',
    '.mcp.json is present, defines the memesh MCP server, and the script it starts exists.',
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
        { code: 'hooks-config.missing' },
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
        { code: 'hooks-config.invalid-json', params: { path: hooksPath } },
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
      { code: 'hooks-config.missing-types', params: { types: missingTypes.join(', ') } },
    )
    : createCheck(
      'hooks-config',
      'Hooks config',
      'pass',
      `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`,
    );

  const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
  // Zero extracted scripts must not fall through to the pass branch below —
  // it used to print "All 0 hook scripts are present and executable" for a
  // hooks.json whose entries carry no `hooks` arrays (or all-empty ones),
  // i.e. an install whose hooks can never fire. Every check downstream of
  // this line filters FROM scriptPaths, so an empty set satisfies all of
  // them vacuously; the only honest verdict for it is fail.
  if (scriptPaths.length === 0) {
    return [
      configCheck,
      createCheck(
        'hook-scripts',
        'Hook scripts',
        'fail',
        'hooks/hooks.json parsed, but yields zero hook script commands — hooks can never fire.',
        'Restore the shipped hook configuration or reinstall MeMesh.',
        { code: 'hook-scripts.none' },
      ),
    ];
  }
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
        { code: 'hook-scripts.missing', params: { files: missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ') } },
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
          { code: 'hook-scripts.not-executable', params: { files: nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ') } },
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
  installChannel?: InstallChannel,
  installedPluginsPath?: string,
): DoctorCheck {
  const markerPath = path.join(memeshDir, 'install-hooks.json');
  if (!existsSyncImpl(markerPath)) {
    // Plugin-marketplace install path: when memesh is loaded as a
    // Claude Code plugin (via `/plugin install memesh@pcircle-memesh`),
    // hook wiring happens through the plugin runtime — `memesh
    // install-hooks` never runs, so the marker file is legitimately
    // absent. Report PASS there; `inspectHookActivity` covers the runtime
    // signal of whether hooks are actually firing.
    //
    // This used to key off `<packageRoot>/.claude-plugin/plugin.json`, which
    // is shipped inside the npm tarball (it is listed in `files`). So the
    // directory exists on EVERY install, and every install reported "Hooks
    // wired into Claude Code / PASS" — including a plain `npm i -g` where
    // nothing was wired and nothing would ever be remembered. The WARN below
    // was unreachable. The install channel is the honest signal: it is
    // `plugin-marketplace` only when the package actually sits under
    // `~/.claude/plugins/cache/`, which only Claude Code's plugin runtime
    // writes.
    if (installChannel === 'plugin-marketplace') {
      return createCheck(
        'hook-wiring',
        'Hooks wired into Claude Code',
        'pass',
        'Wired via the Claude Code plugin runtime (this is a plugin-marketplace install). The install-hooks marker is not used on this install path.',
      );
    }
    // A DIFFERENT copy may still be wired: on a plugin-managed machine the
    // npm-global doctor used to WARN "not connected" here while
    // install-hooks' own guard said "hooks are active" — one report, two
    // answers. The plugin registry is machine-level truth, so consult it
    // before claiming the machine is unwired. Injectable
    // (installedPluginsPathImpl) because the default path reads the REAL
    // machine — without the seam, every unit test of this branch would
    // flip on any developer box with the plugin installed.
    if (detectPluginRuntime(installedPluginsPath)) {
      return createCheck(
        'hook-wiring',
        'Hooks wired into Claude Code',
        'pass',
        'Wired via the Claude Code plugin runtime (found in installed_plugins.json). This copy is not the one doing the capturing — the plugin manages the hooks.',
      );
    }
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'warn',
      'memesh is not connected to Claude Code yet, so nothing gets remembered automatically from your sessions.',
      'Run `memesh install-hooks` once to connect it, then `memesh doctor` to confirm.',
      { code: 'hook-wiring.no-marker' },
      'install-hooks',
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
      { code: 'hook-wiring.marker-unreadable', params: { path: markerPath } },
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
      { code: 'hook-wiring.marker-malformed' },
    );
  }
  if (!existsSyncImpl(marker.settings_path)) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Marker recorded settings at ${marker.settings_path} but the file no longer exists. Hooks are not wired.`,
      'Re-run `memesh install-hooks`.',
      { code: 'hook-wiring.settings-missing', params: { path: String(marker.settings_path) } },
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
      { code: 'hook-wiring.settings-invalid', params: { path: String(marker.settings_path) } },
    );
  }
  // Walk hooks looking for _memesh:true entries. Presence anywhere is the
  // wiring contract, but the CAPTURE events are tracked separately: a
  // SessionStart-only wiring is a real wiring (recall works) while proving
  // nothing about whether a capture hook should ever execute — and
  // hook-activity's never-ran FAIL says "they should be executing", so it
  // must key on capture wiring specifically, not on wiring at all.
  const CAPTURE_EVENTS = new Set(['Stop', 'PostToolUse', 'PreCompact']);
  const hooks = (settingsParsed.value as { hooks?: Record<string, unknown> }).hooks;
  let hasMemeshHook = false;
  let hasCaptureHook = false;
  let missingScript: string | null = null;
  if (hooks && typeof hooks === 'object') {
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const cmds = (entry as { hooks?: unknown[] }).hooks;
        if (!Array.isArray(cmds)) continue;
        for (const c of cmds) {
          const cmd = c as { _memesh?: boolean; command?: unknown };
          if (cmd._memesh !== true) continue;
          hasMemeshHook = true;
          if (CAPTURE_EVENTS.has(event)) hasCaptureHook = true;
          // A wired entry whose script no longer exists is worse than no
          // wiring: the agent invokes a nonexistent file on every matching
          // event. This is the upgrade residue a release leaves when it
          // retires a hook — install-hooks now prunes it, but nothing runs
          // install-hooks automatically on a package upgrade, so doctor is
          // where the state gets caught and named.
          if (missingScript === null && typeof cmd.command === 'string'
            && path.isAbsolute(cmd.command) && !existsSyncImpl(cmd.command)) {
            missingScript = cmd.command;
          }
        }
      }
    }
  }
  if (missingScript !== null) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `A wired memesh hook points at ${missingScript}, which no longer exists — the agent invokes a missing file on every matching event. This is usually residue from an upgrade that retired the hook.`,
      'Run `memesh install-hooks` to re-wire (it now removes retired entries), then restart your agent.',
      { code: 'hook-wiring.script-missing', params: { path: missingScript } },
    );
  }
  if (!hasMemeshHook) {
    return createCheck(
      'hook-wiring',
      'Hooks wired into Claude Code',
      'fail',
      `Marker recorded a memesh install at ${marker.settings_path}, but no _memesh:true hook entries are present anymore. Settings drifted (manual edit?) or memesh was uninstalled out-of-band.`,
      'Re-run `memesh install-hooks` to re-wire.',
      { code: 'hook-wiring.entries-removed', params: { path: String(marker.settings_path) } },
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
      { code: 'hook-wiring.root-moved', params: { path: String(marker.plugin_root) } },
    );
  }
  return createCheck(
    'hook-wiring',
    'Hooks wired into Claude Code',
    'pass',
    `Wired in ${marker.settings_path} (scope: ${marker.scope ?? 'user'}, version: ${marker.version ?? 'unknown'}).`,
    undefined,
    // Consumed by runDoctor to arm hook-activity's never-ran FAIL — not a
    // user-facing message param.
    { params: { captureWired: hasCaptureHook ? 1 : 0 } },
  );
}

/**
 * Confirm the auto-capture loop is alive, from what actually RAN.
 *
 * The verdict reads `hook_runs` — the heartbeat each capture hook stamps at
 * its own successful exit — not the count of captured entities. A produced
 * entity is no longer the evidence: "ran, found nothing worth saving" is the
 * healthy case that produces no row at all, and judging by rows made a quiet
 * day and a dead loop byte-identical. The `source:auto-capture` count still
 * appears in the PASS message, but as detail, never as the verdict. (The
 * count once judged this check by entity TYPE, which a hand-typed
 * `memesh learn` satisfied — the check reported the user's own typing back
 * as proof of automation. That is why the count can never be trusted with
 * the verdict again.)
 *
 * Three hooks stamp, but only one is load-bearing: `session-summary` fires
 * on every session's Stop (its low-signal bails stamp too), so its silence
 * is meaningful. `post-commit` and `pre-compact` fire only when the user
 * commits or a session compacts — their absence proves nothing, so their
 * STALENESS caps at warn, never fail. The two ways they can still drive a
 * red are both positive evidence, not absence: a corrupt/future timestamp
 * (stale-unknown — the row itself is lying), and the stop-silent warn when
 * they keep stamping for days while session-summary has never stamped once
 * (commit capture hiding dead session capture).
 *
 * Staleness has two tiers on purpose: >24h is a WARN ("worth a look — or a
 * weekend"), >72h is the FAIL. The first version failed at 24h flat, which
 * turned every Monday morning into a red "capture has stopped" banner; an
 * alarm that cries wolf on weekends trains the user to ignore the real one.
 *
 * Deliberate silence is not a failure: capture disabled by config is a PASS
 * with its own message, and "never ran" only reds when hook wiring is
 * actually in place — otherwise the hook-wiring row already carries that
 * story and this one downgrades to a quiet corroborating warn.
 *
 * Grace periods for the never-ran verdict: tracking younger than 24h (every
 * pre-heartbeat database on its upgrade day), or an install-hooks marker
 * younger than 24h (fresh install, no session yet).
 */
function inspectHookActivity(
  openDatabaseImpl: typeof openDatabase,
  closeDatabaseImpl: typeof closeDatabase,
  existsSyncImpl: typeof fs.existsSync = fs.existsSync,
  statSyncImpl: typeof fs.statSync = fs.statSync,
  wiringPresent: boolean = true,
): DoctorCheck {
  const TITLE = 'Hook activity';

  // Deliberately disabled capture is a configuration, not a failure — and
  // every verdict below would misread it: the heartbeats legitimately stop
  // the moment the user turns capture off. The two sources are reported
  // separately because they have different blast radius: the config file is
  // shared by every process, but an env var is visible only to THIS shell —
  // the agent's hooks may be running under a different environment, so an
  // env-sourced "disabled" is a statement about doctor's own process, not a
  // verified fact about the capture loop.
  const captureOff = autoCaptureOffSource();
  if (captureOff === 'config') {
    return createCheck('hook-activity', TITLE, 'pass',
      'Automatic capture is turned off (config autoCapture: false) — deliberately, so hook silence is expected. Re-enable it to resume capturing sessions.',
      undefined,
      { code: 'hook-activity.disabled' });
  }
  if (captureOff === 'env') {
    return createCheck('hook-activity', TITLE, 'pass',
      'Automatic capture is turned off by MEMESH_AUTO_CAPTURE=false in this shell\'s environment. Doctor can only see its own environment — if your agent runs without this variable, capture there is unaffected.',
      undefined,
      { code: 'hook-activity.disabled-env' });
  }

  let db: DatabaseLike | null = null;
  try {
    db = openDatabaseImpl() as unknown as DatabaseLike;

    // A pre-heartbeat database whose FILE is read-only opens without the
    // table (the open path skips migration on a read-only file rather than
    // dying) — that is "tracking has not started", not a query failure.
    const hookRunsTablePresent = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_runs'",
    ).get();
    const rows = hookRunsTablePresent
      ? db.prepare(
        `SELECT hook, last_run_at FROM hook_runs`,
      ).all() as Array<{ hook: string; last_run_at: string }>
      : [];

    const captured = (db.prepare(
      `SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > datetime('now', '-24 hours')`,
    ).get(AUTO_CAPTURE_TAG) as { c: number } | undefined)?.c ?? 0;

    // How long tracking has been possible — both the event-hook branch and
    // the nothing-ever-ran branch below reason about it.
    const since = (db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'",
    ).get() as { value: string } | undefined)?.value;
    const measuringHours = since !== undefined ? hoursSince(since) : null;

    // Small negative ages are clock jitter between processes; anything
    // beyond that is a future timestamp — a wrong clock stamped it, and
    // "the future" must not read as "recently" (a dead loop would hide
    // behind it until the wall clock caught up).
    const SKEW_TOLERANCE_H = 5 / 60;
    // hook_runs is user-writable SQLite, so a row's name is untrusted twice
    // over: it must not ride a diagnostic into the pre-filled PUBLIC GitHub
    // issue body (`memesh feedback` copies summaries verbatim), and it must
    // not COUNT — our hooks only ever stamp three literals, so any other
    // row was written by something that is not us, and treating its
    // timestamp as liveness evidence would let one foreign row turn a dead
    // capture loop permanently green (four independent reviews converged on
    // this). Foreign rows are simply not evidence, in either direction.
    const KNOWN_HOOKS = new Set(['session-summary', 'post-commit', 'pre-compact']);
    const ages = new Map<string, number | null>();
    for (const r of rows) {
      if (!KNOWN_HOOKS.has(r.hook)) continue;
      const age = hoursSince(r.last_run_at);
      ages.set(r.hook, age !== null && age >= -SKEW_TOLERANCE_H ? Math.max(age, 0) : null);
    }

    if (ages.size > 0) {
      const capturedTail = captured > 0
        ? `${captured} memor${captured === 1 ? 'y' : 'ies'} captured in the last 24h.`
        : 'Nothing was worth saving in that time, which is normal — the loop still ran.';

      // These two shapes each appear on two independent branches
      // (session-summary-owned and event-hook-only), and their strings must
      // stay aligned with 11 dashboard locales — one definition, one sync
      // point. Stale wording rounds UP (Math.ceil): at 24.4h the status has
      // already turned warn, and "last ran 24 hours ago" would contradict
      // the 24h PASS wording next to it.
      const staleUnknown = (hook: string) => createCheck('hook-activity', TITLE, 'fail',
        `The ${hook} hook's last-run timestamp cannot be read (corrupt, or stamped by a machine with a wrong clock). ` +
          'Capture health is unknown, which is not the same as healthy.',
        'End one work session, then re-run `memesh doctor` — a fresh run overwrites the bad timestamp.',
        { code: 'hook-activity.stale-unknown', params: { hook } });
      // params.hours uses the SAME Math.ceil as the English sentence: the 11
      // dashboard locales interpolate {hours} from params, and a Math.round
      // there rendered "ran about 24 hours ago" on a warn row at 24.0–24.4h —
      // the exact contradiction the ceil exists to prevent, localized.
      const stale = (hook: string, age: number, status: DoctorCheckStatus) => createCheck(
        'hook-activity', TITLE, status,
        `The ${hook} hook last ran ${formatHoursAgo(Math.ceil(age))}. ` +
          'If you have worked since then, capture has stopped and nothing from those sessions was saved.',
        'Restart your agent, then end one session and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.',
        { code: 'hook-activity.stale', params: { hook, hours: Math.ceil(age) } });

      // session-summary is the only hook whose silence is meaningful, so its
      // row — when it has one — owns the verdict.
      const ssAge = ages.has('session-summary') ? ages.get('session-summary')! : undefined;
      if (ssAge === null) return staleUnknown('session-summary');
      if (ssAge !== undefined) {
        if (ssAge <= 24) {
          return createCheck('hook-activity', TITLE, 'pass',
            `The session-summary hook last ran ${formatHoursAgo(ssAge)} — auto-capture is alive. ${capturedTail}`);
        }
        if (ssAge <= 72) return stale('session-summary', ssAge, 'warn');
        // Past 72h, distinguish "the hook died" from "the user moved to
        // another agent": if Claude Code itself wrote anything recently
        // (Phase 2 stamps metadata.provenance.source_host on every write
        // path), the agent is in use and its Stop hook is provably silent —
        // that is the red. No recent Claude Code writes is NOT proof of
        // death (a session can write nothing), so absence only holds the
        // verdict at warn — it never upgrades to fail on missing evidence.
        // json_valid guards the extract: metadata has no validity constraint
        // and the migration chain deliberately preserves unparseable legacy
        // values, so one bad row must not turn this whole check into
        // query-failed (measured: json_extract THROWS on malformed JSON).
        const ccWrites = (db.prepare(
          `SELECT COUNT(*) as c FROM entities
           WHERE created_at > datetime('now', '-72 hours')
             AND json_valid(metadata)
             AND json_extract(metadata, '$.provenance.source_host') = 'claude-code'`,
        ).get() as { c: number } | undefined)?.c ?? 0;
        if (ccWrites > 0) return stale('session-summary', ssAge, 'fail');
        // The hedge is its own code, not a tail glued onto the English
        // summary: the 11 dashboard locales render by code, and gluing the
        // hedge onto `hook-activity.stale` meant every non-English user read
        // an unqualified "capture has stopped" — with exactly the sentence
        // that says "this may be fine" dropped in translation.
        return createCheck('hook-activity', TITLE, 'warn',
          `The session-summary hook last ran ${formatHoursAgo(Math.ceil(ssAge))}, and no Claude Code writes landed in the last 3 days either. If this machine has moved to another agent (Codex / Gemini), this is expected; if you still use Claude Code here, capture has stopped.`,
          'If you still use Claude Code on this machine: restart it, end one session, and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.',
          { code: 'hook-activity.stale-unconfirmed', params: { hook: 'session-summary', hours: Math.ceil(ssAge) } });
      }

      // Only the event-driven hooks (post-commit / pre-compact) have stamped.
      // Their triggers depend on user behaviour — no commits means no
      // post-commit run, dead or alive — so their staleness caps at WARN,
      // never fail: evidence from hooks the user may simply not be
      // triggering cannot prove death, only invite a look.
      const known = [...ages.entries()].filter((e): e is [string, number] => e[1] !== null);
      if (known.length === 0) {
        const [hook] = [...ages.keys()].sort();
        return staleUnknown(hook);
      }
      const [freshestHook, freshestAge] = known.sort((a, b) => a[1] - b[1])[0];
      if (freshestAge <= 24) {
        // Fresh event activity proves the machinery runs — but session-summary,
        // the hook that carries session memory, has never stamped once. Early
        // in tracking that is expected; past three days it stops being
        // explicable by quiet sessions (the low-signal bails stamp too), and
        // a permanently silent Stop hook hiding behind daily commits is the
        // exact masked-death this check exists to expose.
        if (measuringHours !== null && measuringHours > 72) {
          return createCheck('hook-activity', TITLE, 'warn',
            `The ${freshestHook} hook is stamping (last ran ${formatHoursAgo(freshestAge)}), but the session-summary hook has never run once in the ${Math.round(measuringHours)} hours since tracking began — session capture may be broken while commit capture hides it.`,
            'End one work session and re-run `memesh doctor`. If session-summary still has not run, run `memesh install-hooks` and restart your agent.',
            { code: 'hook-activity.stop-silent', params: { hook: freshestHook, hours: Math.round(measuringHours) } });
        }
        return createCheck('hook-activity', TITLE, 'pass',
          `The ${freshestHook} hook last ran ${formatHoursAgo(freshestAge)} — auto-capture is alive. ` +
            `(session-summary has not stamped yet — expected until a session with real work ends.) ${capturedTail}`);
      }
      return stale(freshestHook, freshestAge, 'warn');
    }

    if (since !== undefined && (measuringHours === null || measuringHours < 0)) {
      // The tracking marker itself is unreadable or in the future. Left
      // alone forever it would grant the "just started" grace FOREVER — a
      // fail-open — but the healer is NOT this function: doctor is a reader
      // (reachable via an unauthenticated loopback GET /v1/doctor, where a
      // state-changing side effect has no place), and ensureHookRunsSince
      // validates and restamps the marker on every real write-path open.
      // The next session, commit, or CLI command heals it; doctor just says
      // so.
      return createCheck('hook-activity', TITLE, 'pass',
        'The hook-run tracking marker is unreadable — it will be re-stamped automatically the next time the database is opened for writing (any session, commit, or memesh command does it). Tracking restarts then.');
    }
    if (measuringHours === null || measuringHours < 24) {
      // A database that only just gained the heartbeat has an empty table for
      // reasons that say nothing about hook health. Every existing install is
      // in this state for its first day.
      return createCheck('hook-activity', TITLE, 'pass',
        'Hook-run tracking has only just started on this database — the first work session will fill it in.');
    }
    // Fresh-install grace: hooks wired within the last day, no session yet.
    const markerPath = path.join(memeshDir(), 'install-hooks.json');
    if (existsSyncImpl(markerPath)) {
      try {
        if (Date.now() - statSyncImpl(markerPath).mtimeMs < 24 * 60 * 60 * 1000) {
          return createCheck('hook-activity', TITLE, 'pass',
            'Hooks were wired in the last day and no session has ended yet — normal for a fresh install.');
        }
      } catch { /* marker unreadable; fall through to the real verdict */ }
    }
    // Version skew: the npm CLI/MCP side and the plugin hooks ship through
    // separate channels. An upgraded CLI starts tracking while still-old
    // hooks (which predate the heartbeat) keep capturing without stamping —
    // entities carrying the auto-capture tag ARE landing, so "nothing is
    // being remembered" would be flatly false. The window is "since tracking
    // began", not the last 24h: legacy hooks capture on the user's schedule,
    // and a quiet weekend must not flip this warn into the never-ran FAIL
    // below (the false red would tell a working install its memory is gone).
    // The tag is hand-typeable, so this is a warn, never a pass.
    const legacyCaptured = (db.prepare(
      `SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > ?`,
    ).get(AUTO_CAPTURE_TAG, since) as { c: number } | undefined)?.c ?? 0;
    if (legacyCaptured > 0) {
      return createCheck('hook-activity', TITLE, 'warn',
        `No hook has stamped the heartbeat, but ${legacyCaptured} auto-capture memor${legacyCaptured === 1 ? 'y' : 'ies'} landed since tracking began — hooks from a version before heartbeat tracking are probably still running.`,
        'Update the memesh hooks to the current version (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), then restart your agent.',
        { code: 'hook-activity.never-ran-legacy', params: { captured: legacyCaptured } });
    }
    if (!wiringPresent) {
      // No CAPTURE hook is confirmed wired — the hook-wiring row is already
      // telling that story with its own fix. Failing here too would
      // double-report one condition, and for installs that never intend to
      // wire capture hooks (MCP-only hosts, recall-only wirings) it would be
      // a permanent unfixable red. Note "capture hook", not "wired at all":
      // a SessionStart-only wiring passes the wiring row but proves nothing
      // about Stop/PostToolUse/PreCompact ever executing, so it must not
      // arm the never-ran FAIL below.
      return createCheck('hook-activity', TITLE, 'warn',
        'No capture hook has ever run — and no capture hook (Stop / PostToolUse / PreCompact) is confirmed wired on this machine, so there is nothing to run.',
        'If you want automatic capture, run `memesh install-hooks`. If this install is MCP-only (Codex / Gemini), this is expected and safe to ignore.',
        { code: 'hook-activity.not-wired' });
    }
    return createCheck('hook-activity', TITLE, 'fail',
      `No capture hook has run since tracking began ${formatHoursAgo(measuringHours)}. ` +
        'Hook wiring is in place, so they should be executing and are not — nothing is being remembered.',
      'Run `memesh doctor` after ending one work session. If this still says no hook has run, run `memesh install-hooks` and restart your agent.',
      { code: 'hook-activity.never-ran', params: { hours: Math.round(measuringHours) } });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return createCheck('hook-activity', TITLE, 'fail',
      `Could not read hook activity from the database: ${detail}. Capture health is unknown, which is not the same as healthy.`,
      'The error is quoted above. Check that ~/.memesh is readable and that the disk is not full.',
      { code: 'hook-activity.query-failed', params: { detail } });
  } finally {
    try { if (db) closeDatabaseImpl(); } catch { /* best-effort */ }
  }
}

/**
 * Is automatic capture deliberately switched off — and by WHICH source?
 *
 * Mirrors the precedence the hooks themselves use (`isAutoCaptureEnabled`
 * in scripts/hooks/_shared.js): env wins over config, and only the explicit
 * strings/values count — a stray env value must not disable capture.
 *
 * The source matters to the caller: config is shared by every process on
 * the machine, while the env var is per-process — doctor observing it in
 * ITS shell says nothing certain about the agent's hooks.
 */
function autoCaptureOffSource(): 'env' | 'config' | null {
  let configAutoCapture: unknown;
  try {
    configAutoCapture = readConfig().autoCapture;
  } catch {
    configAutoCapture = undefined;
  }
  // The precedence itself lives in capture-flag.ts — the same module the
  // hooks execute (via _generated/), so the two sides cannot fork.
  return autoCaptureDecision(process.env.MEMESH_AUTO_CAPTURE, configAutoCapture).offSource;
}

/**
 * Hours between a SQLite timestamp and now, or null if it cannot be read.
 *
 * SQLite writes `datetime('now')` and `CURRENT_TIMESTAMP` as
 * `YYYY-MM-DD HH:MM:SS` in **UTC**, which is not an ISO-8601 string: handing it
 * to `new Date(...)` is implementation-defined, and the engines that do accept
 * it read it as LOCAL time — so the same row measures as "3 hours ago" in
 * London and "11 hours ago" in Taipei, and a capture loop that stopped an hour
 * ago can read as healthy. Parsed explicitly as UTC instead.
 *
 * Returns null rather than 0 for an unreadable value: a corrupt timestamp is
 * "we do not know", and letting it collapse to "just now" would report a dead
 * loop as alive, which is the exact failure this whole check exists to end.
 */
export function hoursSince(sqliteTimestamp: string): number | null {
  // Anchoring, UTC semantics and rollover round-trip all live in
  // parseSqliteUtcMs — the single owner of this parse.
  const then = parseSqliteUtcMs(sqliteTimestamp);
  if (then === null) return null;
  return (Date.now() - then) / (60 * 60 * 1000);
}

/** "3 hours ago" / "6 days ago" — whichever reads as the plainer sentence. */
function formatHoursAgo(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return 'at an unknown time';
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

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

/**
 * Can this runtime actually open a database with vector search?
 *
 * There is no native binding to miss any more — node:sqlite ships with Node —
 * so this no longer probes better-sqlite3's `.node` file. What CAN still be
 * absent is sqlite-vec, whose per-platform loadable extension arrives through
 * `optionalDependencies`: on an unsupported platform npm installs nothing and
 * says nothing, and recall quietly falls back to keyword-only search.
 *
 * So the probe opens an in-memory database and loads the extension — the same
 * two steps `openDatabase` takes — rather than asserting that a file exists.
 *
 * No test-env seam here. An earlier version gated on `process.env.VITEST`,
 * which was too permissive: anyone with VITEST exported in their shell got a
 * green PASS on a broken install, the exact failure this exists to surface.
 * Tests inject `nativeBindingProbeImpl` through runDoctor options instead.
 */
/**
 * Marker the probe puts in its message when the RUNTIME, not the package, is
 * the problem. Matched by `inspectNativeBinding` instead of pattern-matching a
 * TypeError's wording, which changes between Node releases and belongs to
 * nobody.
 */
const RUNTIME_TOO_OLD = 'memesh:node-sqlite-too-old';

function defaultNativeBindingProbe(packageRoot: string): { ok: true } | { ok: false; message: string } {
  try {
    const probe = new MemeshDatabase(':memory:', { allowExtension: true });
    try {
      // Asked explicitly, because the alternative is a TypeError that reads
      // like a package problem. `node:sqlite` exists from Node 22.5 but was
      // behind `--experimental-sqlite`, and the extension methods only landed
      // in 22.13 — so a user running 22.5–22.12 WITH that flag gets a handle
      // whose `enableLoadExtension` is undefined. Left to the catch below,
      // "probe.enableLoadExtension is not a function" matched neither
      // classification branch and doctor told them to reinstall sqlite-vec,
      // which cannot help: the fix is upgrading Node.
      if (typeof probe.enableLoadExtension !== 'function') {
        return { ok: false, message: `${RUNTIME_TOO_OLD}: node:sqlite in ${process.version} has no enableLoadExtension` };
      }
      probe.enableLoadExtension(true);
      // Resolved from the package root so a hoisted install is found the way
      // Node would find it at runtime, not relative to this compiled file.
      const localRequire = createRequire(pathToFileURL(path.join(packageRoot, 'package.json')).href);
      const sqliteVec = localRequire('sqlite-vec');
      sqliteVec.load(probe);
      probe.prepare('SELECT vec_version()').get();
    } finally {
      probe.close();
    }
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
      { code: 'node-runtime.too-old', params: { detail: facts, required: declared.replace(/^>=\s*/, '') } },
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
 * Added in Node 22.13 (behind a flag from 22.5). Resolved rather than imported, so the check costs
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
  // DO NOT pre-check `<packageRoot>/node_modules/sqlite-vec` for existence —
  // npm hoists, so when memesh is installed as a dependency that directory
  // lives at the consumer's top-level node_modules. The probe uses Node's own
  // resolution, which follows hoisting.
  const result = probeImpl(packageRoot);
  if (result.ok) {
    return createCheck(
      'native-binding',
      'SQLite and vector search',
      'pass',
      'node:sqlite opened a database and sqlite-vec loaded (probe succeeded).',
    );
  }
  // The runtime is too old to use node:sqlite properly. Matched on the marker
  // the probe sets, not on a TypeError's wording — that string belongs to Node
  // and changes between releases.
  if (result.message.startsWith(RUNTIME_TOO_OLD)) {
    return createCheck(
      'native-binding',
      'SQLite and vector search',
      'fail',
      `The node:sqlite in this Node (${process.version}) is too old for memesh — it cannot load the vector-search extension. The complete version arrived in Node 22.13.`,
      'Upgrade Node to 22.13 or newer, then re-run `memesh doctor`.',
      { code: 'native-binding.node-too-old', params: { version: process.version } },
    );
  }

  // Everything below is sqlite-vec, and sqlite-vec is a SUPPLEMENT: without it
  // memesh still stores memories and still finds them by keyword, it just
  // cannot search by meaning. So these are `warn`, not `fail`.
  //
  // The severity was inherited from the better-sqlite3 row, where a missing
  // binding meant nothing was written at all. Left that way it would make
  // `memesh doctor` exit 1 — breaking any CI step, container healthcheck or
  // install script gating on it, and turning the dashboard banner red — on a
  // platform this project documents as supported. The row's own words
  // ("memories are still saved") contradicted the severity it carried.
  const isMissingPackage = /MODULE_NOT_FOUND|Cannot find module/i.test(result.message);
  if (isMissingPackage) {
    return createCheck(
      'native-binding',
      'SQLite and vector search',
      'warn',
      'sqlite-vec is not installed, so memesh cannot search by meaning. Memories are still saved, and still found by keyword.',
      'Run: npm install   (in the directory that depends on @pcircle/memesh)',
      { code: 'native-binding.not-installed' },
    );
  }
  return createCheck(
    'native-binding',
    'SQLite and vector search',
    'warn',
    `sqlite-vec could not be loaded: ${result.message}. Memories are still saved and found by keyword; only search by meaning is off.`,
    `Run: cd "${packageRoot}" && npm install --omit=dev`,
    { code: 'native-binding.load-failed', params: { detail: result.message, root: packageRoot } },
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
      { code: 'shell-cli.not-on-path' },
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
      { code: 'dashboard.missing' },
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
      'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.',
      'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.',
      { code: 'update-status.no-cache' },
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
      { code: 'update-status.deprecated', params: { version: packageVersion, detail: update.deprecationMessage ?? '' } },
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
      'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.',
      'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.',
      { code: 'update-status.no-cache' },
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
    return createCheck('update-status', 'Update status', 'warn', summary, fix, {
      code: 'update-status.deprecation-unknown',
      params: { version: packageVersion, detail: update.lastError ?? '' },
    });
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
        { code: 'update-status.update-available', params: { latest: update.latestVersion, current: packageVersion } },
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
    update.freshness === 'stale'
      ? { code: 'update-status.stale', params: { version: packageVersion } }
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
        { code: 'http-probe.bad-status', params: { status: response.status, url: httpBaseUrl } },
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
      { code: 'http-probe.no-server', params: { url: httpBaseUrl } },
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
      { code: 'skills-manifest.missing-dev' },
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
      { code: 'skills-manifest.unreadable', params: { detail: err instanceof Error ? err.message : 'parse error' } },
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
      { code: 'skills-manifest.empty' },
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
    'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.',
    { code: 'skills-manifest.verify-failed', params: { detail } },
  );
}

// (The former `config_parse` row merged into `inspectConfigFile` — one file,
// one row, one set of fix strings. Its stricter checks and error codes
// survived the merge; only the duplicate ID died.)

/**
 * Does embedding generation actually work?
 *
 * Config saying `embeddings: openai` proves only that a string was written
 * to a file. A blocked model download, a corrupt `~/.memesh/models` cache,
 * a bad BYOK key or a dimension mismatch all leave the config untouched
 * while every vector write and semantic recall silently returns nothing.
 *
 * The probe is therefore real — but it must never have side effects the
 * user did not ask a *diagnostic* command for. A live embedder call is gated
 * behind `--probe`: every embedder is now a network call (ollama is local but
 * still a socket; openai is billed), and `memesh doctor` is what you reach for
 * when the network is already misbehaving.
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
    return createInfo(
      'embeddings_probe',
      'Embeddings work',
      `NOT VERIFIED. Config names "${capabilities.embeddings}", but generating a test embedding is a network call (billed on hosted providers) so it was not made — a revoked key or an unreachable host would look identical to a healthy setup here.`,
      'Run: memesh doctor --probe   (generates one test embedding to confirm)',
    );
  }

  // Bound the probe. A BYOK embedder is a network call and a local ollama
  // endpoint can be slow to answer, so an unbounded await turns `memesh
  // doctor` — the command you reach for when things are wrong — into the
  // thing that hangs. Timing out is itself a useful answer.
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
        { code: 'embeddings.empty', params: { provider: String(capabilities.embeddings) } },
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
      'Check the embedding provider is reachable (e.g. run `ollama serve`), or remove embedder config to use keyword-only search.',
      { code: 'embeddings.threw', params: { provider: String(capabilities.embeddings), detail: msg } },
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
      'No LLM configured — Core Mode. Write-side features (lessons, auto-tag, dream) are off by design.',
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
      { code: 'llm.unreachable', params: { provider: llm.provider, detail: result.error ?? 'unknown error' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createCheck(
      'llm_probe',
      'LLM reachable',
      'fail',
      `${llm.provider} probe threw: ${msg}. Every LLM-backed feature is silently doing nothing.`,
      'Check the API key / host, then re-run: memesh doctor --probe',
      { code: 'llm.threw', params: { provider: llm.provider, detail: msg } },
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
    installedPluginsPathImpl,
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
      install === 'unknown' ? { code: 'install-channel.unknown' } : undefined,
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
            { code: 'fts.unsegmented', params: { count: unsegmented.c } },
            'fts-rebuild',
          ),
        );
      }
    }

    const pendingReindex = getPendingReindexInfo();
    if (pendingReindex) {
      const owed = pendingReindex.reason === 'vectors-missing'
        ? 'Some memories have no search vector'
        : 'Search index needs rebuilding (embedding configuration changed)';
      dbChecks.push(
        createCheck(
          'vector_index',
          'Vector Index',
          'warn',
          owed,
          `Run 'memesh reindex' to fix. This will restore full search functionality.`,
          { code: 'vector-index.stale' },
        ),
      );
    }

    // A half-built index is a normal outcome of an interrupted rebuild, and it
    // was invisible: nothing reclaimed it and no diagnostic mentioned it, so a
    // user who abandoned a rebuild carried a second full copy of their vectors
    // on disk indefinitely without being told.
    const generation = readVectorGeneration();
    if (generation.state !== 'none') {
      const staged = generationRowIds().size;
      const detail = generation.state === 'open'
        ? `${staged} vectors staged at ${generation.info.dimension} dimensions `
          + `(provider ${generation.info.provider}, started ${generation.info.startedAt})`
        : `${staged} vectors staged, but the marker cannot be read (${generation.detail})`;
      dbChecks.push(
        createCheck(
          'vector_generation',
          'Half-built search index',
          'warn',
          `An unfinished index rebuild is holding disk space: ${detail}.`,
          generation.state === 'open'
            ? `Run 'memesh reindex' to finish it (the vectors already produced are reused), `
              + `or 'memesh reindex --discard-generation' to reclaim the space.`
            : `Run 'memesh reindex --discard-generation' to clear it, then 'memesh reindex'.`,
          { code: 'vector-generation.open', params: { staged } },
        ),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown database error';

    // F15: Provide actionable diagnosis for common database failures
    let diagnosis: string;
    let fix: string;
    let fixId: DoctorCheck['fixId'];

    // Check if database file exists but can't be opened
    if (existsSyncImpl(databasePath)) {
      try {
        const stat = statSyncImpl(databasePath);
        const canRead = !!(stat.mode & 0o400);
        const canWrite = !!(stat.mode & 0o200);

        if (!canRead || !canWrite) {
          diagnosis = `Database file exists but has insufficient permissions (${(stat.mode & 0o777).toString(8)})`;
          fix = `Fix permissions: chmod 600 "${databasePath}"`;
          // The ONLY database branch --fix may act on. The rm/mv branches
          // below destroy or move user data — those stay human decisions.
          fixId = 'chmod-db';
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
        // fix stays untranslated (it is itself diagnosis-specific text);
        // the dashboard translates the summary frame and shows fix raw.
        { code: 'database.broken', params: { detail: diagnosis } },
        fixId,
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

  checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl, detectCapabilitiesImpl().llm));
  checks.push(inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl));
  checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
  // Runtime wiring + activity (#25 — file existence isn't enough;
  // doctor used to PASS for users whose Claude Code never loaded
  // memesh's hooks at all).
  // installedPluginsPathImpl may be undefined — detectPluginRuntime owns the
  // default path; restating it here was a second copy of the same location.
  const wiring = inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), install, installedPluginsPathImpl);
  checks.push(wiring);
  // hook-activity's never-ran verdict only reds when wiring is actually in
  // place — otherwise the wiring row above already tells the story, and an
  // MCP-only install would carry a permanent unfixable FAIL.
  // never-ran's FAIL claims "capture hooks should be executing" — that needs
  // a capture event (Stop/PostToolUse/PreCompact) confirmed wired, not just
  // any wiring. A plugin-marketplace pass carries no walk result and wires
  // every event through hooks.json, so it counts as capture-wired; a
  // settings-walk pass counts only when the walk saw a capture event.
  const captureWired = wiring.status === 'pass'
    && (wiring.params === undefined || wiring.params.captureWired === 1);
  checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl, captureWired));
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

  // Scheduled transcript mining (opt-in). Informational by construction: it is
  // OFF by default and being off is not a fault, so this row never warns, never
  // reaches the banner, and never touches Overall.
  if (!isTranscriptMiningEnabled()) {
    checks.push(createInfo(
      'transcript-mining',
      'Scheduled transcript mining',
      'Off (opt-in). memesh can mine this project\'s Claude Code session transcripts for decisions and lessons and STAGE them for your review. Turn it on with `memesh config set transcriptMining true`, then have a scheduler (cron/launchd) run `memesh dream run --from-transcripts --if-due` — it self-throttles and stages only, so nothing enters your graph without `dream accept`.',
    ));
  } else {
    const last = lastTranscriptMineAt(getProjectName(process.cwd()));
    const when = last === null
      ? 'not yet run for this project'
      : `last mined ${((Date.now() - last) / 3600_000).toFixed(1)}h ago`;
    checks.push(createInfo(
      'transcript-mining',
      'Scheduled transcript mining',
      `On for this project — ${when}. Have a scheduler run \`memesh dream run --from-transcripts --if-due\`; it mines when due (default every 24h) and stages proposals. Review the queue with \`memesh dream list\`.`,
    ));
  }

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
