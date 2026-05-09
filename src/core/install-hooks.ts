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
// pre-edit-recall, pre-bash-orchestration-nudge, etc.) silently does
// nothing on every npm install.
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

export interface InstallOptions {
  pluginRoot: string;
  pluginVersion: string;
  scope: 'user' | 'project';
  cwd?: string;
  dryRun?: boolean;
}

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
  scope: 'user' | 'project';
  added: number;
  skipped: number;
  conflicts: Array<{ event: string; matcher: string; existingCount: number }>;
  markerPath: string;
}

export interface UninstallResult {
  settingsPath: string;
  backupPath: string | null;
  removed: number;
}

const MARKER_FILE = 'install-hooks.json';

// homeDir() and memeshDir() now live in src/core/paths.ts as the single
// canonical source. Imported above. Earlier this file had private copies;
// the reasoning (HOME-first for hermetic tests on Windows) is preserved
// in the JSDoc on `homeDir()` in paths.ts.

function settingsPathFor(scope: 'user' | 'project', cwd: string): string {
  if (scope === 'project') {
    return path.join(cwd, '.claude', 'settings.json');
  }
  return path.join(homeDir(), '.claude', 'settings.json');
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
  const desired = loadPluginHooks(opts.pluginRoot);
  const settings = readSettings(settingsPath);
  const existing = settings.hooks ?? {};

  let added = 0;
  let skipped = 0;
  const conflicts: InstallResult['conflicts'] = [];

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
    settingsPath,
    backupPath,
    scope: opts.scope,
    added,
    skipped,
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
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, backupPath: null, removed: 0 };
  }

  const settings = readSettings(settingsPath);
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

  return { settingsPath, backupPath, removed };
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
