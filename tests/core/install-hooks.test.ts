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

describe('install-hooks', () => {
  let tmpDir: string;
  let pluginDir: string;
  let originalEnv: Record<string, string | undefined> = {};

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
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-bash-orchestration-nudge.js', timeout: 3 }] },
          ],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
        },
      }),
    );

    originalEnv.MEMESH_DIR = process.env.MEMESH_DIR;
    originalEnv.HOME = process.env.HOME;
    process.env.MEMESH_DIR = path.join(tmpDir, 'memesh-state');
    process.env.HOME = path.join(tmpDir, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv.MEMESH_DIR === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalEnv.MEMESH_DIR;
    if (originalEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv.HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshModule() {
    return import('../../src/core/install-hooks.js');
  }

  it('writes 4 memesh hook entries on a fresh user-scope install', async () => {
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    // Manifest has 4 entries: SessionStart×1 + PreToolUse×2 + Stop×1
    expect(result.added).toBe(4);
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
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, '.claude', 'settings.json'), 'utf8'));
    const allCommands: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const entry of entries) {
        for (const h of entry.hooks) allCommands.push(h.command);
      }
    }
    expect(allCommands.length).toBe(4);
    for (const cmd of allCommands) {
      expect(cmd).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(cmd.startsWith(pluginDir)).toBe(true);
    }
  });

  it('is idempotent: re-running adds 0, skips all', async () => {
    const { installHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    const second = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(4);
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
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    expect(result.added).toBe(4);
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
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(result.backupPath!, 'utf8'));
    expect(backup.existing).toBe('config');
  });

  it('--dry-run touches no files', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user', dryRun: true });
    expect(result.added).toBe(4);
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(result.markerPath)).toBe(false);
  });

  it('writes a marker JSON that records version + scope + paths', async () => {
    const { installHooks, readInstallMarker } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });
    const marker = readInstallMarker();
    expect(marker).not.toBeNull();
    expect(marker!.version).toBe('4.1.14');
    expect(marker!.scope).toBe('user');
    expect(marker!.plugin_root).toBe(pluginDir);
    expect(marker!.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to modify a malformed settings.json', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, 'not json at all');
    const { installHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' })).toThrow(/not valid JSON/);
    // settings file is left untouched — no destructive overwrite
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('not json at all');
  });

  it('upgrade in place: re-installing with a different pluginRoot replaces stale memesh entries', async () => {
    const { installHooks } = await freshModule();
    const oldRoot = pluginDir;
    installHooks({ pluginRoot: oldRoot, pluginVersion: '4.1.14', scope: 'user' });

    // Simulate memesh moved to a new location (e.g., npm-global path
    // changed after a Node.js upgrade). Use a name that's NOT a
    // suffix-extension of `plugin/` so substring checks below are
    // unambiguous.
    const newRoot = path.join(tmpDir, 'memesh-v2');
    fs.mkdirSync(path.join(newRoot, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(oldRoot, 'hooks', 'hooks.json'), path.join(newRoot, 'hooks', 'hooks.json'));
    const second = installHooks({ pluginRoot: newRoot, pluginVersion: '4.1.15', scope: 'user' });
    expect(second.added).toBe(4);
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

  it('uninstall removes only memesh entries, leaves user hooks alone', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.js' }] }],
      },
    }));

    const { installHooks, uninstallHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'user' });

    const result = uninstallHooks({ scope: 'user' });
    expect(result.removed).toBe(4); // 4 memesh hook commands
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
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.14', scope: 'project', cwd: projectDir });
    expect(result.settingsPath).toBe(path.join(projectDir, '.claude', 'settings.json'));
    expect(fs.existsSync(result.settingsPath)).toBe(true);
  });
});
