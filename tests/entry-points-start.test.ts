import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { binTargets, hookCommands } from '../scripts/lib/executable-targets.mjs';
import { computeSkipList, findUnresolvedPlaceholders } from '../scripts/check-entry-points-start.mjs';

const script = path.resolve('scripts/check-entry-points-start.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, file: string, value = ''): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-entry-gate-fixture-'));
  dirs.push(root);
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', timeout: 30_000 });
}

describe('executable-targets derivation picks up new manifest entries', () => {
  // Requirement: "the list is derived, never hand-written... a new entry
  // point added to either manifest must be covered automatically, and a
  // test must prove that". This proves it at the derivation-function level
  // — the layer both the gate and every other executable-targets.mjs
  // consumer share (tests/installation.test.ts derives its own expected
  // file lists from these same two functions) — rather than only at the
  // whole-gate level, so a future third consumer inherits the same
  // guarantee.
  it('binTargets reflects a bin entry no fixture author hand-listed here', () => {
    const root = fixtureRoot();
    write(root, 'package.json', JSON.stringify({
      bin: { memesh: 'dist/cli.js', 'memesh-brand-new-thing': 'dist/brand-new-thing.js' },
    }));
    const entries = binTargets(root);
    expect(entries).toHaveLength(2);
    expect(entries).toContain('dist/brand-new-thing.js');
  });

  it('hookCommands reflects a hook command no fixture author hand-listed here', () => {
    const root = fixtureRoot();
    write(root, 'hooks/hooks.json', JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
        PreCompact: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/brand-new-hook.js', async: true }] }],
      },
    }));
    const entries = hookCommands(root);
    expect(entries).toHaveLength(2);
    expect(entries).toContain('scripts/hooks/brand-new-hook.js');
  });
});

describe('gate fails when a declared entry point does not start', () => {
  // A minimal-but-complete fixture: one bin whose real file is broken, and
  // one hook whose real file is a trivial no-op — both keyed at the SAME
  // relative paths the real repo uses, so the gate's actual PROFILES table
  // (keyed by relative path, not by root) applies to them unmodified. This
  // exercises the real assertCliVersion/assertHookStarts logic against a
  // controlled fixture instead of only ever running against the live repo.
  function brokenBinFixture(): string {
    const root = fixtureRoot();
    write(root, 'package.json', JSON.stringify({ bin: { memesh: 'dist/transports/cli/cli.js' } }));
    write(root, 'dist/transports/cli/cli.js', '#!/usr/bin/env node\nprocess.exit(7);\n');
    write(root, 'hooks/hooks.json', JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js' }] }] },
    }));
    write(root, 'scripts/hooks/pre-edit-recall.js', '#!/usr/bin/env node\nprocess.exit(0);\n');
    return root;
  }

  it('a broken bin fails the gate while an unrelated working hook still passes', () => {
    const result = run(brokenBinFixture());
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain('bin memesh (dist/transports/cli/cli.js)');
    expect(result.stderr).toContain('exited 7');
    expect(result.stdout).toContain('ok    hook (scripts/hooks/pre-edit-recall.js)');
  });

  it('a manifest entry with no execution profile fails loudly, not silently', () => {
    const root = fixtureRoot();
    write(root, 'package.json', JSON.stringify({ bin: { 'memesh-unknown-thing': 'dist/unknown-thing.js' } }));
    write(root, 'dist/unknown-thing.js', '#!/usr/bin/env node\nprocess.exit(0);\n');
    write(root, 'hooks/hooks.json', JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js' }] }] },
    }));
    write(root, 'scripts/hooks/pre-edit-recall.js', '#!/usr/bin/env node\nprocess.exit(0);\n');
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no execution profile defined for dist/unknown-thing.js');
  });
});

describe('unresolved ${...} placeholders fail the gate', () => {
  // The manifest's own load path decides which substitutions are real.
  // hooks/hooks.json is reachable ONLY through the plugin loader, so
  // CLAUDE_PLUGIN_ROOT there is always defined and must NOT be flagged —
  // otherwise this rule is vacuous for the one manifest (.mcp.json) it
  // exists to catch, which is exactly the trap the header comment on
  // findUnresolvedPlaceholders warns the next reader away from.
  it('flags an unresolved placeholder in .mcp.json', () => {
    const root = fixtureRoot();
    write(root, '.mcp.json', JSON.stringify({
      mcpServers: { memesh: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'] } },
    }));
    const findings = findUnresolvedPlaceholders(root);
    expect(findings).toEqual([{ manifest: '.mcp.json', variable: 'CLAUDE_PLUGIN_ROOT', raw: '${CLAUDE_PLUGIN_ROOT}' }]);
  });

  it('does NOT flag ${CLAUDE_PLUGIN_ROOT} in hooks/hooks.json — plugin-loader-only, always defined there', () => {
    const root = fixtureRoot();
    write(root, 'hooks/hooks.json', JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }] },
    }));
    expect(findUnresolvedPlaceholders(root)).toEqual([]);
  });

  it('still flags a DIFFERENT unresolved variable in hooks/hooks.json — the exemption is CLAUDE_PLUGIN_ROOT only', () => {
    const root = fixtureRoot();
    write(root, 'hooks/hooks.json', JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ command: '${SOME_OTHER_VAR}/scripts/hooks/session-start.js' }] }] },
    }));
    expect(findUnresolvedPlaceholders(root)).toEqual([{ manifest: 'hooks/hooks.json', variable: 'SOME_OTHER_VAR', raw: '${SOME_OTHER_VAR}' }]);
  });

  it('the whole gate fails, not just the helper function, when .mcp.json has an unresolved placeholder', () => {
    const root = fixtureRoot();
    write(root, 'package.json', JSON.stringify({ bin: { memesh: 'dist/cli.js' } }));
    write(root, 'dist/cli.js', '#!/usr/bin/env node\nprocess.exit(0);\n');
    write(root, 'hooks/hooks.json', JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js' }] }] },
    }));
    write(root, 'scripts/hooks/pre-edit-recall.js', '#!/usr/bin/env node\nprocess.exit(0);\n');
    write(root, '.mcp.json', JSON.stringify({
      mcpServers: { memesh: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'] } },
    }));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.mcp.json still contains the unresolved placeholder ${CLAUDE_PLUGIN_ROOT}');
  });
});

describe('Windows skip list does not grow silently', () => {
  // Requirement: "If any binary genuinely cannot be started in CI, do not
  // skip it silently... add a test that the skip list is not silently
  // growing." Pinned as an exact list (not just a length) so an addition
  // must edit this test, not merely bump a number.
  it('is empty on POSIX platforms', () => {
    expect(computeSkipList('darwin')).toEqual([]);
    expect(computeSkipList('linux')).toEqual([]);
  });

  it('is pinned to exactly memesh-router on win32', () => {
    const relativePaths = computeSkipList('win32').map((entry) => entry.relativePath);
    expect(relativePaths).toEqual(['dist/host-runtime/router.js']);
  });

  it('every skipped entry names a non-empty reason', () => {
    for (const entry of computeSkipList('win32')) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
