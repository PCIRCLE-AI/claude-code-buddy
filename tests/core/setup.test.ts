/**
 * Machine-level wiring inspection — the question doctor structurally cannot
 * answer (doctor scopes every check to the invoked COPY; setup reads the
 * hosts' own state). Each test pins one detection branch against fixture
 * files and fake seams, because the expensive failures here are the quiet
 * ones: reporting "wired" for a host that is not, or prescribing an action
 * that would double-wire a plugin-managed machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectHosts, allWired, type SetupSeams, type RunResult } from '../../src/core/setup.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-setup-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const seams = (over: Partial<SetupSeams> = {}): SetupSeams => ({
  home: () => home,
  isOnPath: () => false,
  run: () => ({ status: 1, stderr: '' }),
  ...over,
});

const byHost = (statuses: ReturnType<typeof inspectHosts>) =>
  Object.fromEntries(statuses.map((s) => [s.host, s]));

describe('inspectHosts', () => {
  it('reports absent hosts as absent, and absent is not a failure', () => {
    // A machine without Codex is not misconfigured — --check must not fail it.
    const statuses = inspectHosts(seams());
    for (const st of statuses) expect(st.present).toBe(false);
    expect(allWired(statuses)).toBe(true);
  });

  it('a plugin-managed Claude Code is fully wired, with NO actions', () => {
    // installHooks' own guard refuses to double-wire a plugin machine; setup
    // prescribing install-hooks here would fight that guard.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const registry = path.join(home, 'installed_plugins.json');
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '4.6.0', scope: 'user' }] },
    }));

    const st = byHost(inspectHosts(seams({ installedPluginsPath: registry })))['claude-code'];
    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
    expect(st.wiredDetail).toContain('plugin v4.6.0');
  });

  it('a bare Claude Code dir gets BOTH actions: hooks and MCP registration', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'claude',
      run: () => ({ status: 1, stderr: '' }), // mcp get memesh → not registered
    })))['claude-code'];

    expect(st.wired).toBe(false);
    expect(st.actions.map((a) => a.kind)).toEqual(['install-hooks', 'run']);
    // The MCP action MUST be user-scoped: `claude mcp add` defaults to
    // LOCAL, which wires only the directory setup happens to run in — the
    // exact trap the engineering review caught in the design.
    const mcp = st.actions.find((a) => a.kind === 'run')!;
    expect(mcp.args).toEqual(['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp']);
  });

  it('recognises the _memesh hook marker install-hooks stamps', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node x.js', _memesh: true }] }] },
    }));
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'claude',
      run: () => ({ status: 0, stderr: '' }), // mcp registered
    })))['claude-code'];

    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
  });

  it('non-memesh hooks do not count as wiring', () => {
    // The user's own hooks must never satisfy the check — that would report
    // a machine as capturing when memesh writes nothing.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node their-hook.js' }] }] },
    }));
    const st = byHost(inspectHosts(seams()))['claude-code'];
    expect(st.wired).toBe(false);
    expect(st.actions.some((a) => a.kind === 'install-hooks')).toBe(true);
  });

  it('probes Codex through its own CLI, and trusts the exit code', () => {
    const calls: string[][] = [];
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'codex',
      run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stderr: '' }; },
    })))['codex'];

    expect(calls).toContainEqual(['codex', 'mcp', 'get', 'memesh']);
    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
  });

  it('an unregistered Codex gets the exact add command', () => {
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'codex',
      run: () => ({ status: 1, stderr: '' }),
    })))['codex'];
    expect(st.wired).toBe(false);
    expect(st.actions[0].args).toEqual(['mcp', 'add', 'memesh', '--', 'memesh-mcp']);
  });

  it('a failed Codex probe is UNKNOWN, never "wired"', () => {
    // status null = the probe could not run. Reporting wired=true on that
    // would be absence-as-evidence — the failure mode this repo audits for.
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'codex',
      run: () => ({ status: null, stderr: 'spawn failed' }),
    })))['codex'];
    expect(st.wired).toBeNull();
    expect(st.wiredDetail).toContain('could not determine');
  });

  it('reads Gemini from its settings file, because gemini has no `mcp get`', () => {
    // Verified against the real CLI: gemini mcp offers add/remove/list/
    // enable/disable only. The file check is the honest probe there.
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { memesh: { command: 'memesh-mcp', args: [] } },
    }));
    const st = byHost(inspectHosts(seams({ isOnPath: (bin) => bin === 'gemini' })))['gemini'];
    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
  });

  it('an unwired Gemini gets the user-scoped add command', () => {
    // -s user matters: gemini mcp add defaults to PROJECT scope, which
    // writes ./.gemini/settings.json in whatever directory setup ran.
    const st = byHost(inspectHosts(seams({ isOnPath: (bin) => bin === 'gemini' })))['gemini'];
    expect(st.wired).toBe(false);
    expect(st.actions[0].args).toEqual(['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp']);
  });
});

describe('allWired', () => {
  it('fails a present host with pending actions, passes an absent one', () => {
    const statuses = inspectHosts(seams({ isOnPath: (bin) => bin === 'gemini' }));
    expect(allWired(statuses)).toBe(false); // gemini present, unwired
  });

  it('does not fail on an undeterminable host with no actions', () => {
    // "Could not probe" without a prescribed action is a warning to a human,
    // not a machine verdict — --check exit 1 must mean "something to do".
    const runFails: SetupSeams['run'] = () => ({ status: null, stderr: 'x' } as RunResult);
    const statuses = inspectHosts(seams({ isOnPath: (bin) => bin === 'codex', run: runFails }));
    expect(allWired(statuses)).toBe(true);
  });
});
