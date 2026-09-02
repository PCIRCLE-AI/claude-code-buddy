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
 * `package.json` `bin` entries with their command names preserved.
 *
 * `binTargets()` above collapses this to a de-duplicated path list, which is
 * right for "which files need the executable bit" but wrong for "which
 * command failed" — a gate that only has the path cannot tell a release
 * engineer whether `memesh` or `memesh-http` broke when they share no path
 * in common. This keeps the name.
 *
 * @param {string} packageDir - package root to read package.json from
 * @returns {{name: string, relativePath: string}[]}
 */
export function binEntries(packageDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const bin = pkg.bin ?? {};
  const entries = typeof bin === 'string'
    ? [{ name: typeof pkg.name === 'string' ? pkg.name : 'bin', relativePath: bin }]
    : Object.entries(bin).map(([name, relativePath]) => ({ name, relativePath }));

  if (entries.length === 0) {
    throw new Error('package.json declares no bin entries — expected at least the `memesh` command');
  }

  return entries;
}

/**
 * Every hook Claude Code can invoke, one entry per `hooks/hooks.json`
 * declaration, with the event it fires on and whether it is async.
 *
 * `hookCommands()` above collapses this to a de-duplicated path list. This
 * keeps the event name (for "which SessionStart hook broke") and the
 * `async` flag — an async hook's stdout is never parsed as a control
 * response, so a caller validating hook output against the Claude Code
 * hook-output contract needs to know which entries to hold to that contract
 * and which merely need to exit cleanly.
 *
 * @param {string} packageDir - package root to read the manifest from
 * @returns {{event: string, async: boolean, command: string, relativePath: string}[]}
 */
export function hookEntries(packageDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'hooks', 'hooks.json'), 'utf8')
  );

  const entries = [];
  for (const [event, matchers] of Object.entries(manifest.hooks ?? {})) {
    for (const matcher of matchers ?? []) {
      for (const hook of matcher.hooks ?? []) {
        if (typeof hook.command !== 'string') continue;
        entries.push({
          event,
          async: hook.async === true,
          command: hook.command,
          relativePath: hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '').split(' ')[0],
        });
      }
    }
  }

  if (entries.length === 0) {
    throw new Error(
      'hooks/hooks.json declared no hook commands — the derivation in ' +
        'scripts/lib/executable-targets.mjs is broken, not the manifest'
    );
  }

  return entries;
}

/**
 * The script `.mcp.json` starts, relative to the package root.
 *
 * Derived for the same reason as the two lists above, and after the same kind
 * of miss: the MCP entry point was renamed, `package.json` `bin` and `npm
 * start` were both repointed, and `.mcp.json` — the only entry point a
 * `/plugin install` user ever hits — kept naming the deleted file. Every MCP
 * tool failed with `-32000 failed to reconnect`, and nothing noticed, because
 * the packed-artifact gate checked a hand-written path list that no longer
 * mentioned it.
 *
 * `command` is the interpreter (`node`), so the script is `args[0]`.
 *
 * @param {string} packageDir - package root to read .mcp.json from
 * @returns {string} relative path
 */
export function mcpEntry(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, '.mcp.json'), 'utf8'));
  const entry = manifest.mcpServers?.memesh?.args?.[0];

  if (typeof entry !== 'string') {
    throw new Error(
      '.mcp.json declares no `mcpServers.memesh.args[0]` — the derivation in ' +
        'scripts/lib/executable-targets.mjs is broken, or the manifest lost its MCP entry point'
    );
  }

  return entry.replace('${CLAUDE_PLUGIN_ROOT}/', '');
}
