/**
 * `memesh setup` through the real binary — the machine-level wiring check
 * against fixture HOMEs. The unit tests in tests/core/setup.test.ts pin the
 * detection branches; these pin what a user actually runs: exit codes, the
 * no-write guarantee of --check and of non-interactive runs, and that --yes
 * really wires hooks into a fixture settings.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.resolve('dist/transports/cli/cli.js');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-setup-cli-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// A PATH that carries node (so the CLI itself runs) but none of the host
// CLIs — claude/codex/gemini all read as absent.
const bareEnv = () => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PATH: path.dirname(process.execPath),
});

const run = (args: string[], env = bareEnv()) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

describe('memesh setup --check', () => {
  it('exits 0 on a machine with no hosts at all', () => {
    const r = run(['setup', '--check']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not found');
  });

  it('exits 1 when Claude Code exists but nothing is wired, and writes NOTHING', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const before = fs.readdirSync(path.join(home, '.claude'));

    const r = run(['setup', '--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('hooks NOT wired');

    // --check is read-only by contract.
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(before);
  });

  it('exits 0 when the plugin manages Claude Code', () => {
    const pluginsDir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '9.9.9', scope: 'user' }] },
    }));

    const r = run(['setup', '--check']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('plugin v9.9.9');
  });
});

describe('memesh setup (wiring)', () => {
  it('non-interactive without --yes: prints the plan, changes nothing, exits 1', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = run(['setup']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Planned actions');
    expect(r.stderr).toContain('--yes');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('--yes wires the hooks into the fixture settings.json and verifies after', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = run(['setup', '--yes']);

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks?: Record<string, Array<{ hooks: Array<{ _memesh?: boolean }> }>> };
    const markers = Object.values(settings.hooks ?? {})
      .flat().flatMap((e) => e.hooks).filter((h) => h._memesh === true);
    expect(markers.length).toBeGreaterThan(0);

    // The final verdict re-reads the hosts: hooks are wired now, but the
    // claude CLI is not on the bare PATH so MCP registration is
    // undeterminable-with-no-action — which must not fail the run.
    expect(r.stdout).toContain('After wiring');
    expect(r.status).toBe(0);
  });

  // POSIX-only: the shim is a #!/bin/sh script, and on win32 `where` would
  // not resolve an extensionless file anyway — same skip the
  // upgrade-plugin tests use for their bash-only legs.
  it.skipIf(process.platform === 'win32')('runs a host CLI add through a PATH shim, and reports its failure honestly', () => {
    // A codex shim that answers `mcp get` with "not registered" and FAILS
    // the `mcp add` — setup must exit 1 and show the stderr, never claim
    // success it did not observe.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-'));
    const shim = path.join(shimDir, 'codex');
    fs.writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nif [ "$1" = "mcp" ] && [ "$2" = "add" ]; then echo "boom" >&2; exit 3; fi\nexit 0\n');
    fs.chmodSync(shim, 0o755);

    // `which` must also be findable: include /usr/bin.
    const env = { ...bareEnv(), PATH: `${shimDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    try {
      const r = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { encoding: 'utf8', env });
      expect(r.stdout + r.stderr).toContain('codex');
      expect(r.stderr).toContain('boom');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
