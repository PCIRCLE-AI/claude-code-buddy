// =============================================================================
// install-hooks — wire memesh's session hooks into Claude Code
// =============================================================================
//
// PROBLEM
// ───────
// memesh ships `.claude-plugin/plugin.json` + `hooks/hooks.json` so it
// can run as a Claude Code plugin. But `npm install -g @pcircle/memesh`
// only puts
// the CLI binary on PATH — Claude Code's plugin runtime never reads
// memesh's hooks.json. Result: memesh's auto-capture (session-summary,
// pre-edit-recall, etc.) silently does nothing on every npm install.
//
// FIX
// ───
// Inject memesh's hook entries directly into `~/.claude/settings.json`
// (or `<project>/.claude/settings.json` with --scope project), with
// `${CLAUDE_PLUGIN_ROOT}` substituted to memesh's absolute install
// path. Claude Code merges hook arrays across user-global and
// project-local settings, so this coexists cleanly with whatever
// custom hooks the user has at `~/.claude/hooks/*.js`.
//
// IDEMPOTENT
// ──────────
// Each memesh-installed hook entry carries `_memesh: true` so we can
// detect existing installs, skip writing duplicates, and uninstall
// cleanly later. Re-running with a different memesh version updates
// the absolute paths in place.
//
// SAFETY
// ──────
// Always writes a `<settings>.bak-pre-memesh-<ts>` before modifying.
// Reports conflicts (existing matcher patterns that overlap) without
// blocking — users with their own hooks should know they coexist.

import fs from 'fs';
import path from 'path';
import { homeDir, memeshDir } from './paths.js';
import { citationRulePath, removeCitationRule, writeCitationRule, type CitationRuleResult } from './citation-rule.js';
import { pluginHostConfigRoot } from './install-channel.js';

type HookCommand = { type: 'command'; command: string; timeout?: number; _memesh?: boolean };
type HookEntry = { matcher?: string; hooks: HookCommand[] };
type HooksByEvent = Record<string, HookEntry[]>;
interface ClaudeSettings {
  hooks?: HooksByEvent;
  [key: string]: unknown;
}

// Shape of `<memesh>/hooks/hooks.json` — same fields, but commands
// reference `${CLAUDE_PLUGIN_ROOT}` which we substitute on install.
interface PluginHooksManifest {
  hooks: HooksByEvent;
}

/**
 * Does this Claude Code settings file carry any hook entry stamped with the
 * `_memesh: true` marker this module writes? Exported so `memesh setup` asks
 * the module that OWNS the stamped shape, instead of keeping a third private
 * walker that drifts when the shape moves (doctor has the second, richer
 * walk — it classifies per event and checks script existence, so it stays).
 */
export function settingsHaveMemeshHooks(settingsPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
    for (const entries of Object.values(parsed.hooks ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const hook of entry.hooks ?? []) {
          if (hook?._memesh === true) return true;
        }
      }
    }
  } catch { /* missing or unparseable settings — not wired */ }
  return false;
}

export interface InstallOptions {
  pluginRoot: string;
  pluginVersion: string;
  scope: 'user' | 'project';
  cwd?: string;
  dryRun?: boolean;
  // Force-write even when Claude Code's plugin runtime already wires the
  // same hooks via `/plugin install memesh@pcircle-memesh`. Without this
  // flag, install-hooks bails on plugin-runtime detection to avoid
  // double-firing every hook every event. Set to true when you genuinely
  // want both paths (rare).
  forceOverPlugin?: boolean;
  // Test seam: override the path used to detect a Claude Code plugin
  // install. Default is `<claude-config>/plugins/installed_plugins.json`.
  installedPluginsPathImpl?: string;
}

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
  scope: 'user' | 'project';
  added: number;
  skipped: number;
  /** Memesh entries removed because the manifest no longer declares their
   * (event, matcher) — the upgrade path for retired hooks. User entries are
   * never counted here; they are never touched. */
  pruned: number;
  conflicts: Array<{ event: string; matcher: string; existingCount: number }>;
  markerPath: string;
  // When non-null, install-hooks detected an active plugin-runtime install
  // and refused to write. Callers (CLI / dashboard) should surface this
  // to the user with the `--force-over-plugin` escape hatch. `null` means
  // the install either proceeded or was a dry-run.
  pluginRuntimeDetected?: {
    installPath: string;
    version: string;
  } | null;
  /** Where the citation contract landed, and whether it changed. Written on
   *  the plugin path too — see the note in `installHooks`. */
  citationRule: CitationRuleResult;
}

export interface UninstallResult {
  settingsPath: string;
  backupPath: string | null;
  removed: number;
  /** `foreign-file` means a file exists at that path that memesh did not
   *  write, so it was left alone rather than deleted. */
  citationRule: { path: string; action: 'removed' | 'absent' | 'foreign-file' };
}

const MARKER_FILE = 'install-hooks.json';

/**
 * Inspect Claude Code's `installed_plugins.json` for an active memesh
 * plugin install. When present, Claude Code's plugin runtime is already
 * loading memesh's hooks via `<plugin>/hooks/hooks.json`, and writing
 * the same hooks into Claude Code's user settings would double-fire every
 * event. Returns the install metadata when found, else null.
 *
 * Used by `installHooks` as a guard. The default lookup path is
 * `<claude-config>/plugins/installed_plugins.json` but tests can inject
 * an alternate path via `installedPluginsPathImpl`.
 */
export function detectPluginRuntime(
  installedPluginsPathImpl?: string,
): { installPath: string; version: string } | null {
  const defaultPath = path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'installed_plugins.json');
  const targetPath = installedPluginsPathImpl ?? defaultPath;
  if (!fs.existsSync(targetPath)) return null;
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const j = JSON.parse(raw);
    const entries = j?.plugins?.['memesh@pcircle-memesh'];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const active = entries.find((entry: unknown): entry is { installPath: string; version?: unknown } =>
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { installPath?: unknown }).installPath === 'string'
      && (entry as { installPath: string }).installPath.length > 0);
    if (!active) return null;
    return {
      installPath: active.installPath,
      version: typeof active.version === 'string' ? active.version : 'unknown',
    };
  } catch {
    return null;
  }
}

// homeDir() and memeshDir() now live in src/core/paths.ts as the single
// canonical source. Imported above. Earlier this file had private copies;
// the reasoning (HOME-first for hermetic tests on Windows) is preserved
// in the JSDoc on `homeDir()` in paths.ts.

function settingsPathFor(scope: 'user' | 'project', cwd: string): string {
  if (scope === 'project') {
    return path.join(cwd, '.claude', 'settings.json');
  }
  return path.join(pluginHostConfigRoot('claude-code'), 'settings.json');
}

// settings.json writer. The CodeQL js/file-system-race rule fires here
// because we read settings.json earlier and now write it back, with a
// theoretical TOCTOU window. We accept that risk:
//   1. `memesh install-hooks` is a one-shot CLI command invoked manually
//      by a single user, not a long-running daemon. There is no
//      meaningful concurrent writer to race against in normal use.
//   2. `backupSettings()` runs before this write, so any concurrent
//      modification by Claude Code itself is recoverable from the
//      timestamped .bak-pre-memesh-* file we just created.
//   3. Atomic temp+rename was attempted (5c69a262) but introduced
//      Windows portability issues with no commensurate real-world
//      benefit for a once-per-install CLI.
// codeql[js/file-system-race]: justified — see comment above
function writeSettingsSync(targetPath: string, data: string): void {
  fs.writeFileSync(targetPath, data, 'utf8');
}

function readSettings(p: string): ClaudeSettings {
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    // Malformed settings — bail loudly. We refuse to overwrite a
    // file we can't parse: the user's existing config matters more
    // than our convenience.
    throw new Error(`settings file at ${p} is not valid JSON; refusing to modify`);
  }
}

function backupSettings(settingsPath: string): string | null {
  if (!fs.existsSync(settingsPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${settingsPath}.bak-pre-memesh-${ts}`;
  fs.copyFileSync(settingsPath, backup);
  return backup;
}

/**
 * Read memesh's plugin manifest and substitute ${CLAUDE_PLUGIN_ROOT}
 * with the absolute path to the memesh install. Returned hooks are
 * marked `_memesh: true` so we can identify and remove them later
 * without disturbing the user's other hooks.
 */
function loadPluginHooks(pluginRoot: string): HooksByEvent {
  const manifestPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`plugin hooks manifest not found at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginHooksManifest;
  const out: HooksByEvent = {};
  for (const [event, entries] of Object.entries(manifest.hooks)) {
    out[event] = entries.map((entry) => ({
      matcher: entry.matcher,
      hooks: entry.hooks.map((h) => ({
        type: h.type,
        command: h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
        ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
        _memesh: true,
      })),
    }));
  }
  return out;
}

/**
 * Detect whether a settings entry is one we previously installed.
 * Identity test: every command in `hooks[]` carries `_memesh: true`.
 * If the user has manually added `_memesh: true` they are explicitly
 * opting that hook into our lifecycle — defensible behaviour.
 */
function isMemeshEntry(entry: HookEntry): boolean {
  return entry.hooks.length > 0 && entry.hooks.every((h) => h._memesh === true);
}

/**
 * Match desired entry against existing memesh entries on the same
 * event. Same-shape match: matcher equal AND command set equal.
 */
function entryAlreadyPresent(existing: HookEntry[], desired: HookEntry): boolean {
  return existing.some((e) => {
    if (e.matcher !== desired.matcher) return false;
    if (!isMemeshEntry(e)) return false;
    if (e.hooks.length !== desired.hooks.length) return false;
    const cmds = new Set(e.hooks.map((h) => h.command));
    return desired.hooks.every((h) => cmds.has(h.command));
  });
}

export function installHooks(opts: InstallOptions): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const settingsPath = settingsPathFor(opts.scope, cwd);

  // The citation rule is written BEFORE the plugin-runtime check, and on the
  // plugin path too. Those are different problems with different owners: the
  // plugin runtime loads `hooks/hooks.json`, so hooks must not be written
  // twice — but nothing in the plugin runtime writes a rules file, so a
  // plugin user would never get the citation contract at all. Skipping it
  // there is how the whole ROI signal stayed at zero for plugin installs.
  const citationRule = opts.dryRun
    ? { path: citationRulePath(opts.scope, homeDir(), cwd), action: 'unchanged' as const }
    : writeCitationRule(opts.scope, homeDir(), cwd);

  // Detect existing Claude Code plugin install BEFORE doing any work.
  // If `/plugin install memesh@pcircle-memesh` already wired the hooks
  // through the plugin runtime, writing user-level hooks here would
  // double-fire every event (plugin runtime + user settings both invoke
  // the same hook scripts → two `session-summary` entities per session,
  // two `pre-edit-recall` injections per Edit, etc.). Bail by default;
  // `forceOverPlugin` is the escape hatch for the rare user who knows
  // they want both surfaces.
  const pluginRuntime = detectPluginRuntime(opts.installedPluginsPathImpl);
  if (pluginRuntime && !opts.forceOverPlugin) {
    return {
      settingsPath,
      backupPath: null,
      scope: opts.scope,
      added: 0,
      skipped: 0,
      pruned: 0,
      conflicts: [],
      markerPath: path.join(memeshDir(), MARKER_FILE),
      pluginRuntimeDetected: pluginRuntime,
      citationRule,
    };
  }

  const desired = loadPluginHooks(opts.pluginRoot);
  const settings = readSettings(settingsPath);
  const existing = settings.hooks ?? {};

  let added = 0;
  let skipped = 0;
  let pruned = 0;
  const conflicts: InstallResult['conflicts'] = [];

  // Prune memesh entries the manifest no longer declares — BEFORE merging.
  // The merge loop below only iterates DESIRED events/matchers, so a memesh
  // entry under an (event, matcher) the manifest dropped survived every
  // re-install forever, pointing at a script the upgrade deleted: Claude
  // Code then invoked a nonexistent file on every matching tool call, and
  // `memesh install-hooks` — the documented fix for wiring problems — could
  // not heal it. Only memesh's own entries are swept; user hooks are never
  // touched, which is the same boundary uninstallHooks draws.
  //
  // The key joins on U+0000 because it is the one code point a Claude Code
  // event name or matcher pattern cannot contain — a printable separator
  // would let ("PostToolUse Bash", "*") and ("PostToolUse", "Bash *") produce
  // the same key, and that key decides whether a live hook entry is pruned.
  //
  // Written as the ESCAPE, never as a literal NUL byte. It was a literal one,
  // and a text file carrying a NUL is a BINARY file to `grep` and `rg`: both
  // suppress every match in it and exit 1 exactly as they would for a clean
  // file. So this file — the one that edits the user's `settings.json` —
  // answered "no matches" to every pattern any grep-based reviewer ran
  // against it. Identical runtime value; the file is text again.
  const desiredKeys = new Set(
    Object.entries(desired).flatMap(([event, entries]) =>
      entries.map((e) => `${event}\u0000${e.matcher ?? '*'}`)),
  );
  for (const [event, entries] of Object.entries(existing)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter(
      (e) => !(isMemeshEntry(e) && !desiredKeys.has(`${event}\u0000${e.matcher ?? '*'}`)),
    );
    pruned += entries.length - kept.length;
    if (kept.length === 0) delete existing[event];
    else existing[event] = kept;
  }

  for (const [event, desiredEntries] of Object.entries(desired)) {
    if (!existing[event]) existing[event] = [];
    for (const desiredEntry of desiredEntries) {
      // Read live state each iteration — earlier passes through this
      // inner loop may have already appended to existing[event].
      const live = existing[event];
      if (entryAlreadyPresent(live, desiredEntry)) {
        skipped++;
        continue;
      }
      // Detect overlap: same-event, same-matcher, but NOT a memesh
      // entry. We coexist by appending — flag for the user.
      const overlap = live.filter(
        (e) => e.matcher === desiredEntry.matcher && !isMemeshEntry(e),
      );
      if (overlap.length > 0) {
        conflicts.push({
          event,
          matcher: desiredEntry.matcher ?? '*',
          existingCount: overlap.reduce((n, e) => n + e.hooks.length, 0),
        });
      }
      // Replace any stale memesh entry with the same matcher (so
      // re-running after a memesh upgrade picks up new paths).
      existing[event] = [
        ...live.filter((e) => !(e.matcher === desiredEntry.matcher && isMemeshEntry(e))),
        desiredEntry,
      ];
      added++;
    }
  }

  const markerPath = path.join(memeshDir(), MARKER_FILE);
  let backupPath: string | null = null;

  if (!opts.dryRun && (added > 0 || skipped > 0)) {
    backupPath = backupSettings(settingsPath);
    settings.hooks = existing;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeSettingsSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    // Marker — doctor reads this to confirm hooks are wired AND
    // know which scope/path so it can verify they still match.
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          installed_at: new Date().toISOString(),
          version: opts.pluginVersion,
          plugin_root: opts.pluginRoot,
          scope: opts.scope,
          settings_path: settingsPath,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  return {
    citationRule,
    settingsPath,
    backupPath,
    scope: opts.scope,
    added,
    skipped,
    pruned,
    conflicts,
    markerPath,
  };
}

export interface UninstallOptions {
  scope: 'user' | 'project';
  cwd?: string;
  dryRun?: boolean;
}

export function uninstallHooks(opts: UninstallOptions): UninstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const settingsPath = settingsPathFor(opts.scope, cwd);

  // Parse settings FIRST, before anything is deleted.
  //
  // `readSettings` throws `refusing to modify` on an unparseable
  // settings.json, and a refusal has to mean nothing was modified. It did
  // not: the rule file was removed above this line, so `uninstall-hooks`
  // printed the refusal, exited 1, and left `.claude/rules/` empty. The
  // user's remedy for a corrupt settings.json — fix the JSON, re-run — then
  // ran against a state the failed run had already changed.
  const settings = fs.existsSync(settingsPath) ? readSettings(settingsPath) : null;

  // Removed on BOTH exits, including the one where settings.json does not
  // exist: a plugin install never writes settings.json but does get the rule
  // file, so returning early without this would leave the contract behind on
  // exactly the install shape that owns it.
  const citationRule = opts.dryRun
    ? { path: citationRulePath(opts.scope, homeDir(), cwd), action: 'absent' as const }
    : removeCitationRule(opts.scope, homeDir(), cwd);

  if (!settings) {
    return { settingsPath, backupPath: null, removed: 0, citationRule };
  }

  const existing = settings.hooks ?? {};
  let removed = 0;

  for (const [event, entries] of Object.entries(existing)) {
    const before = entries.length;
    existing[event] = entries.filter((e) => !isMemeshEntry(e));
    removed += before - existing[event].length;
    if (existing[event].length === 0) {
      delete existing[event];
    }
  }

  if (Object.keys(existing).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = existing;
  }

  let backupPath: string | null = null;
  if (!opts.dryRun && removed > 0) {
    backupPath = backupSettings(settingsPath);
    writeSettingsSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    const markerPath = path.join(memeshDir(), MARKER_FILE);
    if (fs.existsSync(markerPath)) {
      try { fs.unlinkSync(markerPath); } catch { /* best-effort */ }
    }
  }

  return { settingsPath, backupPath, removed, citationRule };
}

/**
 * Read the install marker if present. doctor uses this to verify
 * hooks were installed by `memesh install-hooks` (not just present
 * on disk by happenstance) and that the recorded paths still exist.
 */
export interface InstallMarker {
  installed_at: string;
  version: string;
  plugin_root: string;
  scope: 'user' | 'project';
  settings_path: string;
}

export function readInstallMarker(): InstallMarker | null {
  const markerPath = path.join(memeshDir(), MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as InstallMarker;
  } catch {
    return null;
  }
}
