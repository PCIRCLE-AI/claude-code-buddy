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
