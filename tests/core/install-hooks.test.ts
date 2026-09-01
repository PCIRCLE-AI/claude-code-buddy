// install-hooks core — locks down the contract for `memesh install-hooks`:
//   1. existing user hooks coexist (we never overwrite them)
//   2. idempotent (re-running doesn't duplicate)
//   3. dry-run is a true no-op (no FS writes)
//   4. uninstall removes only memesh entries
//   5. version upgrade refreshes paths in place
//   6. malformed settings.json is refused, not silently overwritten

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

describe('install-hooks', () => {
  let tmpDir: string;
  let pluginDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installhooks-'));
    pluginDir = path.join(tmpDir, 'plugin');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js', timeout: 5 }] },
          ],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
        },
      }),
    );

    originalEnv.MEMESH_DIR = process.env.MEMESH_DIR;
    originalEnv.HOME = process.env.HOME;
    originalEnv.USERPROFILE = process.env.USERPROFILE;
    originalEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    process.env.MEMESH_DIR = path.join(tmpDir, 'memesh-state');
    process.env.HOME = path.join(tmpDir, 'home');
    // Windows parity: os.homedir() consults USERPROFILE first on Windows
    // and HOMEDRIVE+HOMEPATH next; HOME is not checked. Without this
    // override, install-hooks writes to the real user dir and the test's
    // assertion (read from process.env.HOME path) sees an absent file.
    process.env.USERPROFILE = path.join(tmpDir, 'home');
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(process.env.HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv.MEMESH_DIR === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalEnv.MEMESH_DIR;
    if (originalEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv.HOME;
    if (originalEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalEnv.USERPROFILE;
    if (originalEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv.CLAUDE_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function freshModule() {
    return import('../../src/core/install-hooks.js');
  }

  it('writes 3 memesh hook entries on a fresh user-scope install', async () => {
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    // Manifest has 3 entries: SessionStart×1 + PreToolUse×1 + Stop×1
    expect(result.added).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.backupPath).toBeNull(); // no prior settings to back up
    expect(fs.existsSync(result.settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(pluginDir);
    expect(settings.hooks.SessionStart[0].hooks[0]._memesh).toBe(true);
  });

  it('absolute-substitutes ${CLAUDE_PLUGIN_ROOT} on every hook command', async () => {
    const { installHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, '.claude', 'settings.json'), 'utf8'));
    const allCommands: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const entry of entries) {
        for (const h of entry.hooks) allCommands.push(h.command);
      }
    }
    expect(allCommands.length).toBe(3);
    for (const cmd of allCommands) {
      expect(cmd).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(cmd.startsWith(pluginDir)).toBe(true);
    }
  });

  it('is idempotent: re-running adds 0, skips all', async () => {
    const { installHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const second = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('preserves existing non-memesh user hooks on the same matcher', async () => {
    // User already has ~/.claude/hooks/stop.js wired (the real-world
    // case we hit on the maintainer's machine).
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.js' }] }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(result.added).toBe(3);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].event).toBe('Stop');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Both entries present on Stop, user's first
    expect(settings.hooks.Stop.length).toBe(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('~/.claude/hooks/stop.js');
    expect(settings.hooks.Stop[1].hooks[0]._memesh).toBe(true);
  });

  it('writes a backup before modifying an existing settings file', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'config' }));

    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(result.backupPath!, 'utf8'));
    expect(backup.existing).toBe('config');
  });

  it('--dry-run touches no files', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user', dryRun: true });
    expect(result.added).toBe(3);
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(result.markerPath)).toBe(false);
  });

  it('writes a marker JSON that records version + scope + paths', async () => {
    const { installHooks, readInstallMarker } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const marker = readInstallMarker();
    expect(marker).not.toBeNull();
    expect(marker!.version).toBe('4.1.4');
    expect(marker!.scope).toBe('user');
    expect(marker!.plugin_root).toBe(pluginDir);
    expect(marker!.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to modify a malformed settings.json', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, 'not json at all');
    const { installHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(/not valid JSON/);
    // settings file is left untouched — no destructive overwrite
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('not json at all');
  });

  it('upgrade in place: re-installing with a different pluginRoot replaces stale memesh entries', async () => {
    const { installHooks } = await freshModule();
    const oldRoot = pluginDir;
    installHooks({ pluginRoot: oldRoot, pluginVersion: '4.1.4', scope: 'user' });

    // Simulate memesh moved to a new location (e.g., npm-global path
    // changed after a Node.js upgrade). Use a name that's NOT a
    // suffix-extension of `plugin/` so substring checks below are
    // unambiguous.
    const newRoot = path.join(tmpDir, 'memesh-v2');
    fs.mkdirSync(path.join(newRoot, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(oldRoot, 'hooks', 'hooks.json'), path.join(newRoot, 'hooks', 'hooks.json'));
    const second = installHooks({ pluginRoot: newRoot, pluginVersion: '4.1.15', scope: 'user' });
    expect(second.added).toBe(3);
    expect(second.skipped).toBe(0); // OLD entries are stale → replaced

    const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, '.claude', 'settings.json'), 'utf8'));
    // No remaining references to the old plugin root
    const allCmds: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const e of entries) for (const h of e.hooks) allCmds.push(h.command);
    }
    expect(allCmds.some(c => c.includes(oldRoot))).toBe(false);
    expect(allCmds.every(c => c.startsWith(newRoot))).toBe(true);
  });

  it('upgrade prunes memesh entries the new manifest no longer declares — and never touches user hooks', async () => {
    // The exact residue the agentic-orchestration removal left behind: a
    // <=4.4.x install wrote a PreToolUse/Bash entry into settings.json; the
    // upgrade deleted the script from the package, and the merge loop —
    // which iterates only DESIRED events/matchers — never removed the stale
    // entry. Claude Code then invoked a nonexistent file on every Bash
    // call, and `memesh install-hooks` (the documented remedy for wiring
    // problems) could not heal it. Start from the OLD manifest shape and
    // prove the new install sweeps it.
    const { installHooks } = await freshModule();

    // Old-version manifest: includes a PreToolUse/Bash hook that the
    // current manifest (fixture in beforeEach) no longer declares.
    const oldRoot = path.join(tmpDir, 'memesh-old');
    fs.mkdirSync(path.join(oldRoot, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(oldRoot, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js', timeout: 5 }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-bash-orchestration-nudge.js', timeout: 3 }] },
          ],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
        },
      }),
    );
    installHooks({ pluginRoot: oldRoot, pluginVersion: '4.4.0', scope: 'user' });

    // A user hook on the SAME retired matcher must survive the sweep.
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    before.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/my-bash-guard.js' }] });
    fs.writeFileSync(settingsPath, JSON.stringify(before));

    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.0', scope: 'user' });
    expect(result.pruned, 'the retired Bash nudge entry must be swept').toBe(1);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const bashEntries = (settings.hooks.PreToolUse as any[]).filter((e) => e.matcher === 'Bash');
    expect(bashEntries, 'only the USER Bash hook may remain').toHaveLength(1);
    expect(bashEntries[0].hooks[0].command).toBe('~/.claude/hooks/my-bash-guard.js');
    const allCmds: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const e of entries) for (const h of e.hooks) allCmds.push(h.command);
    }
    expect(allCmds.some((c) => c.includes('pre-bash-orchestration-nudge')), 'no command may still point at the deleted script').toBe(false);
  });

  it('a fresh install with nothing to prune reports pruned: 0', async () => {
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.0', scope: 'user' });
    expect(result.pruned).toBe(0);
  });

  it('uninstall removes only memesh entries, leaves user hooks alone', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.js' }] }],
      },
    }));

    const { installHooks, uninstallHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });

    const result = uninstallHooks({ scope: 'user' });
    expect(result.removed).toBe(3); // the 3 memesh hook commands
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // User's stop.js remains
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('~/.claude/hooks/stop.js');
    // Events that had only memesh entries are pruned entirely
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  it('project scope writes to ./.claude/settings.json relative to cwd', async () => {
    const projectDir = path.join(tmpDir, 'fake-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'project', cwd: projectDir });
    expect(result.settingsPath).toBe(path.join(projectDir, '.claude', 'settings.json'));
    expect(fs.existsSync(result.settingsPath)).toBe(true);
  });

  // ── v4.2.7 plugin-runtime detection ─────────────────────────────────
  // Prevents the double-firing failure mode: when Claude Code's
  // `/plugin install memesh@pcircle-memesh` is already wiring memesh's
  // hooks, also writing them into ~/.claude/settings.json would fire
  // every hook script twice per event.

  it('refuses to write when Claude Code plugin install is already active', async () => {
    // Stub a plugin-install record pointing at any path (just needs to
    // exist with a memesh@pcircle-memesh entry).
    const installedPluginsPath = path.join(tmpDir, 'fake-installed_plugins.json');
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'memesh@pcircle-memesh': [{
          installPath: '/Users/test/.claude/plugins/cache/pcircle-memesh/memesh/4.2.7',
          version: '4.2.7',
        }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({
      pluginRoot: pluginDir,
      pluginVersion: '4.2.7',
      scope: 'user',
      installedPluginsPathImpl: installedPluginsPath,
    });

    // No writes — the plugin runtime already covers it.
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.pluginRuntimeDetected).not.toBeNull();
    expect(result.pluginRuntimeDetected?.version).toBe('4.2.7');
    expect(result.pluginRuntimeDetected?.installPath).toContain('/plugins/cache/pcircle-memesh/');

    // Settings file should NOT have been created.
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it.each(['first', 'last'] as const)(
    'finds the active plugin row when it appears %s among mixed registry entries',
    async (position) => {
      const installedPluginsPath = path.join(tmpDir, `mixed-installed-plugins-${position}.json`);
      const active = {
        installPath: '/Users/test/.claude/plugins/cache/pcircle-memesh/memesh/4.8.2',
        version: '4.8.2',
      };
      const invalid = { version: 'legacy-row-without-an-install-path' };
      fs.writeFileSync(installedPluginsPath, JSON.stringify({
        plugins: {
          'memesh@pcircle-memesh': position === 'first' ? [active, invalid] : [invalid, active],
        },
      }));

      const { installHooks } = await freshModule();
      const result = installHooks({
        pluginRoot: pluginDir,
        pluginVersion: '4.8.2',
        scope: 'user',
        installedPluginsPathImpl: installedPluginsPath,
      });

      expect(result.pluginRuntimeDetected).toEqual(active);
      expect(result.added).toBe(0);
      expect(fs.existsSync(result.settingsPath)).toBe(false);
    },
  );

  it('uses CLAUDE_CONFIG_DIR for default plugin detection and user settings', async () => {
    const configRoot = path.join(tmpDir, 'relocated-claude');
    process.env.CLAUDE_CONFIG_DIR = configRoot;
    const installedPluginsPath = path.join(configRoot, 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(installedPluginsPath), { recursive: true });
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'memesh@pcircle-memesh': [{ installPath: path.join(configRoot, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'), version: '4.8.2' }],
      },
    }));

    const { installHooks } = await freshModule();
    const guarded = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.8.2', scope: 'user' });
    expect(guarded.pluginRuntimeDetected?.version).toBe('4.8.2');
    expect(guarded.citationRule.path).toBe(path.join(configRoot, 'rules', 'memesh-citations.md'));
    expect(fs.existsSync(guarded.citationRule.path)).toBe(true);
    expect(fs.existsSync(path.join(process.env.HOME!, '.claude', 'rules', 'memesh-citations.md'))).toBe(false);
    expect(fs.existsSync(path.join(process.env.HOME!, '.claude', 'settings.json'))).toBe(false);

    const forced = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.8.2', scope: 'user', forceOverPlugin: true });
    expect(forced.settingsPath).toBe(path.join(configRoot, 'settings.json'));
    expect(forced.citationRule.path).toBe(path.join(configRoot, 'rules', 'memesh-citations.md'));
    expect(fs.existsSync(forced.settingsPath)).toBe(true);
  });

  it('forceOverPlugin escape hatch writes anyway with the same plugin record present', async () => {
    const installedPluginsPath = path.join(tmpDir, 'fake-installed_plugins.json');
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'memesh@pcircle-memesh': [{
          installPath: '/Users/test/.claude/plugins/cache/pcircle-memesh/memesh/4.2.7',
          version: '4.2.7',
        }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({
      pluginRoot: pluginDir,
      pluginVersion: '4.2.7',
      scope: 'user',
      installedPluginsPathImpl: installedPluginsPath,
      forceOverPlugin: true,
    });

    expect(result.added).toBeGreaterThan(0);
    expect(result.pluginRuntimeDetected).toBeUndefined();
  });

  it('proceeds normally when installed_plugins.json exists but has no memesh entry', async () => {
    const installedPluginsPath = path.join(tmpDir, 'fake-installed_plugins.json');
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'some-other-plugin@vendor': [{ installPath: '/tmp/x', version: '1.0.0' }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({
      pluginRoot: pluginDir,
      pluginVersion: '4.2.7',
      scope: 'user',
      installedPluginsPathImpl: installedPluginsPath,
    });

    // Plugin runtime not detected for memesh specifically — installs.
    expect(result.added).toBeGreaterThan(0);
    expect(result.pluginRuntimeDetected).toBeUndefined();
  });
});

describe('memesh install-hooks (CLI output) — M-11', () => {
  // `installHooks()` writes ~/.memesh/install-hooks.json in the same branch
  // as the settings.json backup (see the marker-writing block above this
  // describe block's sibling tests), and the CLI already reports the
  // settings path and the backup path — but not this one, so a user reading
  // the command's own output had no idea it wrote a second file at all.
  const cliPath = path.resolve('dist', 'transports', 'cli', 'cli.js');
  let cwd: string;
  let memeshDir: string;

  beforeEach(() => {
    // realpathSync: macOS resolves `/var` -> `/private/var`, and the
    // marker path the CLI reports is realpath-resolved (via memeshDir's
    // own path.join chain) while a bare mkdtempSync result on this
    // platform is not — an unresolved comparison here would fail on
    // every macOS run for a reason that has nothing to do with M-11.
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installhooks-cli-')));
    memeshDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installhooks-cli-home-')));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(memeshDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('names the marker path it just wrote', () => {
    // --scope project keeps the settings write inside `cwd` — no touching
    // the real ~/.claude/settings.json from a test.
    const out = execFileSync('node', [cliPath, 'install-hooks', '--scope', 'project'], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-config'),
        MEMESH_DIR: memeshDir,
      },
      encoding: 'utf8',
    });
    const markerPath = path.join(memeshDir, 'install-hooks.json');
    expect(fs.existsSync(markerPath), 'fixture: the marker was not actually written').toBe(true);
    expect(out).toContain(`Marker: ${markerPath}`);
  });
});
