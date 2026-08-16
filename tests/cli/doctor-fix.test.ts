/**
 * `memesh doctor --fix` through the real binary. The whitelist executes only
 * fixId-tagged prescriptions; the verdict comes from a fresh doctor run, not
 * from trusting the fixes. Fixture HOME throughout — never the real one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.resolve('dist/transports/cli/cli.js');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-docfix-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const env = () => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  // No MEMESH_DIR override: memeshDir derives from HOME, and the hook-wiring
  // registry consult derives from HOME too — one fixture, both aligned.
});

const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env() });

describe('memesh doctor --fix', () => {
  it('refuses to change anything non-interactively without --yes', () => {
    const r = run(['doctor', '--fix']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--yes');
    // Nothing was wired.
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('wires the hooks on a fresh HOME and shows the check flipping warn → pass', () => {
    const r = run(['doctor', '--fix', '--yes']);

    // The fix really landed: settings.json carries the _memesh markers and
    // the install-hooks marker file exists (which is what the re-run's
    // hook-wiring check reads).
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks?: Record<string, Array<{ hooks: Array<{ _memesh?: boolean }> }>> };
    const markers = Object.values(settings.hooks ?? {})
      .flat().flatMap((e) => e.hooks).filter((h) => h._memesh === true);
    expect(markers.length).toBeGreaterThan(0);

    expect(r.stdout).toContain('After fixes:');
    expect(r.stdout).toMatch(/Hooks wired into Claude Code: warn → pass/);
  });

  it('has nothing to apply when the plugin manages the machine', () => {
    const pluginsDir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '9.9.9', scope: 'user' }] },
    }));

    const r = run(['doctor', '--fix', '--yes']);
    expect(r.stdout).toContain('Nothing on the --fix whitelist to apply.');
    // And it did NOT write hooks over the plugin's management.
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });
});
