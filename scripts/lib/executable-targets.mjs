import fs from 'fs';
import path from 'path';

/**
 * The files that must be executable, derived from the manifests that already
 * declare them.
 *
 * Both lists here were previously hand-written in each consumer, and both had
 * drifted from the manifest they were copies of:
 *
 *   - `scripts/set-executable-bits.mjs` listed six of the seven hooks
 *     (`user-prompt-intent.js` was missing), so that hook's executable bit was
 *     preserved only by git's stored file mode. Any path that materialises the
 *     tree without git modes ships a hook Claude Code cannot exec, which is a
 *     silent total dropout for UserPromptSubmit.
 *   - The same file's binary list had drifted from `package.json` `bin` in
 *     both directions: it chmod-ed `dist/mcp/server.js`, which is not a bin
 *     entry, and omitted `dist/transports/cli/cli.js` — the `memesh` command
 *     itself — and `dist/transports/http/server.js`, both of which are
 *     committed at mode 100644.
 *   - `tests/installation.test.ts` checked five of seven hooks. `ci.yml`
 *     documents this exact class as a past incident: "installation.test.ts
 *     asserting 5 hook types when hooks.json shipped 6 went unnoticed for a
 *     full release cycle."
 *
 * Three copies of one list is three chances to drift. There is one derivation
 * now, and every consumer imports it.
 */

/**
 * Hook script paths declared in `hooks/hooks.json`, relative to the package
 * root.
 *
 * A command looks like `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/foo.js`, possibly
 * with arguments, so the prefix is stripped and the first token taken.
 *
 * @param {string} packageDir - package root to read the manifest from
 * @returns {string[]} relative paths, deduplicated, in manifest order
 */
export function hookCommands(packageDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'hooks', 'hooks.json'), 'utf8')
  );

  const commands = new Set(
    Object.values(manifest.hooks ?? {})
      .flat()
      .flatMap((matcher) => matcher.hooks ?? [])
      .map((hook) => hook.command)
      .filter((command) => typeof command === 'string')
      .map((command) => command.replace('${CLAUDE_PLUGIN_ROOT}/', '').split(' ')[0])
  );

  if (commands.size === 0) {
    throw new Error(
      'hooks/hooks.json declared no hook commands — the derivation in ' +
        'scripts/lib/executable-targets.mjs is broken, not the manifest'
    );
  }

  return [...commands];
}

/**
 * Executable entry points declared in `package.json` `bin`, relative to the
 * package root.
 *
 * @param {string} packageDir - package root to read package.json from
 * @returns {string[]} relative paths, deduplicated
 */
export function binTargets(packageDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const bin = pkg.bin ?? {};
  const targets = typeof bin === 'string' ? [bin] : Object.values(bin);

  if (targets.length === 0) {
    throw new Error('package.json declares no bin entries — expected at least the `memesh` command');
  }

  return [...new Set(targets)];
}

/**
 * Everything that has to carry an executable bit: every declared bin entry and
 * every declared hook.
 *
 * @param {string} packageDir - package root
 * @returns {string[]} relative paths
 */
export function executableTargets(packageDir) {
  return [...new Set([...binTargets(packageDir), ...hookCommands(packageDir)])];
}

/**
 * The MCP manifest the Claude plugin declares, relative to the package root.
 *
 * Read from `.claude-plugin/plugin.json` rather than hardcoded, for the same
 * anti-drift reason `mcpEntry` derives its path instead of naming one: a
 * hand-written path that stopped matching the manifest is the exact defect
 * class this pair exists to catch.
 *
 * The path MUST NOT be `.mcp.json` at the package root. Claude Code
 * auto-discovers a root `.mcp.json` as a PROJECT-scoped MCP config for anyone
 * who opens the directory, and in that context `${CLAUDE_PLUGIN_ROOT}` is
 * undefined — `claude mcp list` reports "Missing environment variables:
 * CLAUDE_PLUGIN_ROOT" and the server dies with `-32000 Connection closed`.
 * The same file is correct inside the plugin loader, which is what made the
 * breakage invisible for three and a half months: one file serving two roles,
 * right in one and wrong in the other.
 *
 * @param {string} packageDir - package root to read .claude-plugin/plugin.json from
 * @returns {string} relative path to the MCP manifest
 */
export function mcpManifestPath(packageDir) {
  const pluginManifestPath = path.join(packageDir, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
  const declared = plugin.mcpServers;

  if (typeof declared !== 'string') {
    throw new Error(
      '.claude-plugin/plugin.json declares no `mcpServers` path — without it Claude Code ' +
        'falls back to auto-discovering a root `.mcp.json`, which is the project-scoped ' +
        'path where ${CLAUDE_PLUGIN_ROOT} is undefined'
    );
  }
  if (!declared.startsWith('./')) {
    throw new Error(
      `.claude-plugin/plugin.json \`mcpServers\` is ${JSON.stringify(declared)} — the plugin ` +
        'spec requires a path relative to the plugin root that starts with "./"'
    );
  }

  const relative = declared.slice(2);
  if (relative === '.mcp.json') {
    throw new Error(
      'the MCP manifest is declared at the package root as `.mcp.json`, which Claude Code ' +
        'also auto-discovers as a project-scoped config; ${CLAUDE_PLUGIN_ROOT} is undefined ' +
        'there and every memesh MCP tool fails to start'
    );
  }

  return relative;
}

/**
 * The script the MCP manifest starts, relative to the package root.
 *
 * Derived for the same reason as the two lists above, and after the same kind
 * of miss: the MCP entry point was renamed, `package.json` `bin` and `npm
 * start` were both repointed, and the MCP manifest — the only entry point a
 * `/plugin install` user ever hits — kept naming the deleted file. Every MCP
 * tool failed with `-32000 failed to reconnect`, and nothing noticed, because
 * the packed-artifact gate checked a hand-written path list that no longer
 * mentioned it.
 *
 * `command` is the interpreter (`node`), so the script is `args[0]`.
 *
 * @param {string} packageDir - package root to read the MCP manifest from
 * @returns {string} relative path
 */
export function mcpEntry(packageDir) {
  const relativeManifest = mcpManifestPath(packageDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, relativeManifest), 'utf8'));
  const entry = manifest.mcpServers?.memesh?.args?.[0];

  if (typeof entry !== 'string') {
    throw new Error(
      `${relativeManifest} declares no \`mcpServers.memesh.args[0]\` — the derivation in ` +
        'scripts/lib/executable-targets.mjs is broken, or the manifest lost its MCP entry point'
    );
  }

  return entry.replace('${CLAUDE_PLUGIN_ROOT}/', '');
}
