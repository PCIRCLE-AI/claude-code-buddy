import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { mcpEntry, mcpManifestPath } from '../scripts/lib/executable-targets.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The paths Claude Code auto-discovers as a PROJECT-scoped MCP config when
 * someone merely opens this directory. This is the environment the plugin
 * manifest must never be loaded under.
 */
const PROJECT_SCOPED_MCP_PATHS = ['.mcp.json'];

interface McpServer {
  command?: unknown;
  args?: unknown;
}

/**
 * What breaks when `config` is loaded as a PROJECT-scoped MCP config — i.e.
 * with only the environment an ordinary session provides, and specifically
 * without `CLAUDE_PLUGIN_ROOT`, which nothing but the plugin runtime defines.
 *
 * Returns one string per fault, empty when the config would really start.
 */
function projectScopedFaults(config: unknown, root: string): string[] {
  const record = (config ?? {}) as Record<string, unknown>;
  const servers = (record.mcpServers ?? record) as Record<string, McpServer>;
  const faults: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    const parts = [server?.command, ...(Array.isArray(server?.args) ? server.args : [])]
      .filter((part): part is string => typeof part === 'string');
    if (parts.length === 0) continue;

    // `${FOO}` references the config makes of the environment. A project-scoped
    // load defines none of them, so each one is a path segment that resolves to
    // nothing.
    for (const variable of parts.flatMap((part) => [
      ...part.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
    ])) {
      faults.push(`${name}: ${variable[1]} is undefined in project scope`);
    }

    // `node <script>` — the interpreter is `command`, the script is args[0].
    const script = parts[0] === 'node' ? parts[1] : parts[0];
    if (script && (script.startsWith('.') || script.startsWith('/') || script.includes('/'))) {
      if (!fs.existsSync(path.resolve(root, script))) {
        faults.push(`${name}: ${script} does not exist`);
      }
    }
  }
  return faults;
}

describe('the Claude plugin MCP manifest is not also a project-scoped config', () => {
  // The defect this file exists for.
  //
  // `.mcp.json` at the repository root is BOTH the plugin's default MCP
  // manifest and the file Claude Code auto-discovers as a project-scoped MCP
  // config for anyone who opens the repository. One file, two roles, and the
  // roles disagree about the environment: inside the plugin loader
  // `${CLAUDE_PLUGIN_ROOT}` is the plugin directory, and in project scope it
  // is undefined. So the shipped config resolved to `/dist/mcp/server.js`,
  // node exited 1 with `Cannot find module`, and a live session reported
  // `memesh (CONNECTION_CLOSED)`. It shipped that way for three and a half
  // months, through three releases, because every gate looked at the file
  // through the plugin's eyes and none looked at it through the project's.
  //
  // Every assertion below is written from the project's side.

  it('recognises the manifest that actually shipped broken', () => {
    // The anti-vacuity pin, and it is not decoration. The repository-scan
    // assertion below has nothing to scan once the root file is gone — the
    // shape every "no violations found" check degrades into. This runs the
    // same predicate against the exact bytes that were served at
    // `<repo>/.mcp.json` for three and a half months and requires it to
    // object, so a predicate that stopped objecting cannot pass as a clean
    // repository.
    const asShipped = {
      mcpServers: {
        memesh: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'] },
      },
    };
    const faults = projectScopedFaults(asShipped, repoRoot);
    expect(faults).toHaveLength(2);
    expect(faults[0]).toContain('CLAUDE_PLUGIN_ROOT is undefined in project scope');
    expect(faults[1]).toContain('does not exist');

    // …and that it is not simply always unhappy: the same manifest with the
    // placeholder resolved the way the plugin runtime resolves it is clean.
    expect(
      projectScopedFaults(
        { mcpServers: { memesh: { command: 'node', args: [`${repoRoot}/dist/mcp/server.js`] } } },
        repoRoot,
      ),
    ).toEqual([]);
  });

  it('ships no MCP config on a path Claude Code auto-discovers as project scope', () => {
    for (const relative of PROJECT_SCOPED_MCP_PATHS) {
      expect(
        fs.existsSync(path.join(repoRoot, relative)),
        `${relative} is auto-discovered as a project-scoped MCP config by anyone who opens this ` +
          'repository. Custom component paths in plugin.json SUPPLEMENT the defaults rather than ' +
          'replacing them, so declaring a custom path does not stop this one from loading too.',
      ).toBe(false);
    }
  });

  it('declares its MCP manifest on a path only the plugin loader reads', () => {
    const plugin = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    // Per the plugin spec: relative to the plugin root, starting with `./`.
    expect(plugin.mcpServers).toMatch(/^\.\//);

    const relative = mcpManifestPath(repoRoot);
    expect(PROJECT_SCOPED_MCP_PATHS).not.toContain(relative);
    expect(fs.existsSync(path.join(repoRoot, relative))).toBe(true);
  });

  it('leaves nothing for a project-scoped load to start with an unresolvable command', () => {
    // The repository-facing half: whatever is on an auto-discovered path right
    // now must be startable under the environment such a load really gets.
    // Absent counts as startable; a placeholder nothing defines does not.
    for (const relative of PROJECT_SCOPED_MCP_PATHS) {
      const full = path.join(repoRoot, relative);
      if (!fs.existsSync(full)) continue;
      const faults = projectScopedFaults(JSON.parse(fs.readFileSync(full, 'utf8')), repoRoot);
      expect(faults, `${relative} would fail a project-scoped load`).toEqual([]);
    }
  });

  it('resolves to a real server once the plugin runtime supplies CLAUDE_PLUGIN_ROOT', () => {
    // The other direction: the manifest must still be CORRECT for the loader
    // it is written for. `mcpEntry` strips the placeholder the way the plugin
    // runtime substitutes it; `dist/mcp/server.js` is built by `npm run build`
    // and is what a `/plugin install` user actually starts.
    const entry = mcpEntry(repoRoot);
    expect(entry).not.toContain('${');
    expect(fs.existsSync(path.join(repoRoot, entry))).toBe(true);

    const declared = JSON.parse(
      fs.readFileSync(path.join(repoRoot, mcpManifestPath(repoRoot)), 'utf8'),
    );
    expect(
      projectScopedFaults(declared, repoRoot).length,
      'the plugin manifest is expected to depend on CLAUDE_PLUGIN_ROOT — that is why it must not ' +
        'sit on an auto-discovered path',
    ).toBeGreaterThan(0);
  });
});
