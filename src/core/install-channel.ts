import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { homeDir } from './paths.js';

export type InstallChannel = 'npm-global' | 'npm-local' | 'source-checkout' | 'plugin-marketplace' | 'unknown';

type ExistsSyncLike = typeof fs.existsSync;
type ExecFileSyncLike = typeof execFileSync;

interface DetectInstallChannelOptions {
  packageRoot: string;
  /** The global npm root, or a thunk that resolves it. A thunk is only
   *  invoked if the higher-priority classifications (plugin-marketplace
   *  path, `.git` presence) miss — resolving it eagerly costs an
   *  `npm root -g` spawn (50-200ms) that those channels never need. */
  globalNpmRoot?: string | null | (() => string | null);
  existsSyncImpl?: ExistsSyncLike;
}

interface GetCurrentInstallChannelOptions {
  packageRoot: string;
  existsSyncImpl?: ExistsSyncLike;
  execFileSyncImpl?: ExecFileSyncLike;
}

export interface InstallChannelSupport {
  channel: InstallChannel;
  label: string;
  canSelfUpdate: boolean;
  recommendedCommand: string | null;
  guidance: string;
}

function isSubpath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getRootBeforeNodeModules(packageRoot: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = packageRoot.indexOf(marker);
  if (index === -1) return null;
  return packageRoot.slice(0, index);
}

/** Which agent runtime installed this plugin copy. */
export type PluginHost = 'claude-code' | 'codex';

/** host, its default home directory name, and the env var that relocates it. */
/**
 * The one command per host that re-stages the plugin cache from the
 * marketplace. Used by the install-channel guidance and by doctor's
 * plugin-cache check; keep it in one place so the two cannot disagree.
 *
 * Codex: `codex plugin add` over an existing same-version cache replaces it
 * atomically (verified 2026-08-30 on codex-cli 0.150.1 by poisoning the
 * cache and running `add`: the poison was gone and every file matched the
 * snapshot). No `remove` step — that would delete the install first and
 * leave nothing if `add` then failed.
 */
export const PLUGIN_REFRESH_COMMANDS: Readonly<Record<PluginHost, string>> = {
  'claude-code': 'memesh upgrade-plugin',
  codex: 'codex plugin marketplace upgrade pcircle-memesh && codex plugin add memesh@pcircle-memesh',
};

const PLUGIN_HOST_DIRS: ReadonlyArray<readonly [PluginHost, string, string]> = [
  ['claude-code', '.claude', 'CLAUDE_CONFIG_DIR'],
  ['codex', '.codex', 'CODEX_HOME'],
];

export function pluginHostConfigRoot(host: PluginHost): string {
  const descriptor = PLUGIN_HOST_DIRS.find(([candidate]) => candidate === host);
  if (!descriptor) throw new Error(`Unsupported plugin host: ${host}`);
  const [, defaultDir, envVar] = descriptor;
  const relocated = process.env[envVar];
  return relocated ? path.resolve(relocated) : path.join(homeDir(), defaultDir);
}

interface ParsedVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
  raw: string;
}

const VERSION_DIRECTORY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

function parseVersionDirectory(raw: string): ParsedVersion | null {
  const match = VERSION_DIRECTORY.exec(raw);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some(identifier => NUMERIC_IDENTIFIER.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    return null;
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
    raw,
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease !== b.prerelease) return a.prerelease === null ? 1 : -1;
  } else {
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const aIdentifier = a.prerelease[index];
      const bIdentifier = b.prerelease[index];
      if (aIdentifier === undefined || bIdentifier === undefined) {
        if (aIdentifier !== bIdentifier) return aIdentifier === undefined ? -1 : 1;
        break;
      }
      const compared = compareIdentifiers(aIdentifier, bIdentifier);
      if (compared !== 0) return compared;
    }
  }
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
}

/** Existing plugin cache directories in ascending SemVer precedence. */
export function versionedPluginCacheRoots(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => parseVersionDirectory(entry.name))
      .filter((version): version is ParsedVersion => version !== null)
      .sort(compareVersions)
      .map(version => path.join(root, version.raw));
  } catch {
    return [];
  }
}

/**
 * Which plugin runtime owns this package root, or null if none does.
 *
 * Claude Code installs plugins under
 * <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>. Codex CLI
 * adopted the same plugin manifest format and the same cache layout, one
 * directory over: <home>/.codex/plugins/cache/<marketplace>/<plugin>/<version>.
 * Only matching `.claude` meant a Codex-hosted install fell all the way
 * through to `unknown`, and `memesh update` answered a real user with
 * "does not support this install method (unknown)" on an install it
 * fully supports.
 *
 * Match anchored to the `<dir>/plugins/cache/` segment so a user repo whose
 * path merely contains "plugins/cache" is not a false positive. path.sep
 * keeps the matcher Windows-correct.
 *
 * Resolves first, and must: `detectInstallChannel` matches against
 * `path.resolve(packageRoot)`, so anything less here lets the two disagree.
 * `runDoctor` takes `packageRoot` from its caller, and on Windows
 * `path.resolve` rewrites `/` to `\` — so `C:/Users/a/.codex/plugins/cache/…`
 * would be classified `plugin-marketplace` while an unresolved match for
 * `\.codex\plugins\cache\` found nothing, and the Codex user would be handed
 * `memesh upgrade-plugin`: the one command that cannot work for them.
 *
 * TWO matchers, because neither alone is right:
 *
 *   1. The `<dir>/plugins/cache/` path segment. This has to stay: the running
 *      process's home is not necessarily the home the package lives under
 *      (a shared or multi-user install), and the segment is what identifies
 *      the layout regardless of whose home it sits in.
 *   2. A relocated home, read from the env var each runtime documents.
 *      `CODEX_HOME` and `CLAUDE_CONFIG_DIR` move the whole directory, so the
 *      literal `.codex` / `.claude` name is simply absent from the path and
 *      matcher 1 returns null — which lands back on `unknown`, the exact
 *      answer this function exists to stop giving. `src/core/setup.ts` had
 *      already written this hazard down ("CODEX_HOME can relocate the whole
 *      directory") and rejected a substring check over it; matcher 1 alone
 *      was that same rejected shape.
 *
 * `env` is a parameter so a test can describe a relocated layout without
 * mutating the process it runs in.
 */
export function detectPluginHost(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): PluginHost | null {
  const { env = process.env } = options;
  const normalized = path.resolve(packageRoot);
  for (const [host, dir, envVar] of PLUGIN_HOST_DIRS) {
    const segment = `${path.sep}${dir}${path.sep}plugins${path.sep}cache${path.sep}`;
    if (normalized.includes(segment)) return host;

    // An env var exporting "" means "unset" here, not "the process cwd" —
    // same reasoning as homeDir() in paths.ts, and the reason this is a
    // truthiness check rather than `!== undefined`.
    const relocated = env[envVar];
    if (relocated) {
      const cacheRoot = path.join(path.resolve(relocated), 'plugins', 'cache');
      if (isSubpath(cacheRoot, normalized)) return host;
    }
  }
  return null;
}

function isPluginMarketplacePath(packageRoot: string): boolean {
  return detectPluginHost(packageRoot) !== null;
}

/**
 * Where a global install lives, derived from the running Node binary.
 *
 * npm puts global packages at `<prefix>/lib/node_modules` on POSIX and
 * `<prefix>/node_modules` on Windows, and `<prefix>` is the directory two
 * levels above `node` itself (`<prefix>/bin/node`). That holds for nvm,
 * Volta, Homebrew, fnm, Docker images and a plain system install alike,
 * because they all place `node` and the global module tree under one prefix.
 *
 * `execPathImpl` is a parameter for the same reason the others are: so a
 * test can describe a layout without owning the machine's.
 */
function derivedGlobalNpmRoot(execPath: string): string {
  const prefix = path.dirname(path.dirname(execPath));
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
}

/**
 * `npm root -g`, with a fallback for the case where npm is not reachable.
 *
 * The spawn is authoritative when it works — it honours `prefix` from
 * `.npmrc`, which nothing derivable can see. But it fails whenever `npm` is
 * not on PATH, and that is not exotic: Claude Code launched from a GUI app,
 * or a shell where the version manager's shim has not been sourced, both
 * produce a minimal PATH with `node` present and `npm` absent. The whole
 * detection then fell through to `unknown`, and `memesh update` refused to
 * run on a genuine npm-global install with "cannot self-update from this
 * install method".
 */
export function getGlobalNpmRoot(
  options: { execFileSyncImpl?: ExecFileSyncLike; execPathImpl?: string } = {},
): string {
  const { execFileSyncImpl = execFileSync, execPathImpl = process.execPath } = options;

  try {
    const spawned = execFileSyncImpl('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    if (spawned) return spawned;
  } catch {
    // npm is not reachable from this process — fall through to the layout.
  }
  return derivedGlobalNpmRoot(execPathImpl);
}

export function detectInstallChannel(options: DetectInstallChannelOptions): InstallChannel {
  const {
    packageRoot,
    globalNpmRoot,
    existsSyncImpl = fs.existsSync,
  } = options;

  const normalizedPackageRoot = path.resolve(packageRoot);

  // Plugin-marketplace cache wins over .git / npm-global checks because
  // a plugin install can legitimately contain a `.git` directory (the
  // marketplace cache is a git clone of the source repo) AND can sit
  // under a custom npm prefix path. Anchor on the plugins/cache path
  // segment, which only a plugin runtime writes — see detectPluginHost
  // for the two runtimes that do.
  if (isPluginMarketplacePath(normalizedPackageRoot)) {
    return 'plugin-marketplace';
  }

  if (existsSyncImpl(path.join(normalizedPackageRoot, '.git'))) {
    return 'source-checkout';
  }

  const resolvedGlobalNpmRoot =
    typeof globalNpmRoot === 'function' ? globalNpmRoot() : globalNpmRoot;
  if (resolvedGlobalNpmRoot && isSubpath(path.resolve(resolvedGlobalNpmRoot), normalizedPackageRoot)) {
    return 'npm-global';
  }

  const rootBeforeNodeModules = getRootBeforeNodeModules(normalizedPackageRoot);
  if (rootBeforeNodeModules && existsSyncImpl(path.join(rootBeforeNodeModules, 'package.json'))) {
    return 'npm-local';
  }

  return 'unknown';
}

// The install channel of a running binary cannot change within the process,
// and the miss path can spawn `npm root -g` — which sits on the SessionStart
// hook, `/v1/doctor` (fetched on every dashboard page load), and
// `/v1/update-status`, blocking the single-threaded HTTP server's event loop.
const channelCache = new Map<string, InstallChannel>();

export function getCurrentInstallChannel(
  options: GetCurrentInstallChannelOptions,
): InstallChannel {
  const {
    packageRoot,
    existsSyncImpl,
    execFileSyncImpl,
  } = options;

  // Only cache the real-filesystem path — injected test doubles must stay
  // isolated from each other and from real runs.
  const canCache = !existsSyncImpl && !execFileSyncImpl;
  if (canCache) {
    const cached = channelCache.get(packageRoot);
    if (cached !== undefined) return cached;
  }

  const channel = detectInstallChannel({
    packageRoot,
    // Thunk: `npm root -g` is only spawned when the marketplace-path and
    // `.git` classifications both miss (i.e. never for the two most common
    // channels, plugin-marketplace and source-checkout).
    globalNpmRoot: () => getGlobalNpmRoot({ execFileSyncImpl }),
    existsSyncImpl,
  });

  if (canCache) channelCache.set(packageRoot, channel);
  return channel;
}

/**
 * @param packageRoot - the same root that produced `channel`. Required, not
 *   optional, because the `plugin-marketplace` remediation is only correct
 *   once you know the host: the bundled `upgrade-plugin` script drives Claude
 *   Code's layout (it reads `~/.claude/plugins/marketplaces/` and patches
 *   `~/.claude/plugins/installed_plugins.json`, neither of which Codex
 *   creates), while Codex ships its own plugin CLI. Every caller already has
 *   this path — it is what produced `channel` — so there is no honest reason
 *   to let one omit it and be answered with a guess.
 */
export function getInstallChannelSupport(
  channel: InstallChannel,
  packageRoot: string,
): InstallChannelSupport {
  switch (channel) {
    case 'npm-global':
      return {
        channel,
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      };
    case 'npm-local':
      return {
        channel,
        label: 'project-local package install',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this installation from the project package manager that installed MeMesh.',
      };
    case 'source-checkout':
      return {
        channel,
        label: 'source checkout',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this source checkout from its repository and rebuild it.',
      };
    case 'plugin-marketplace': {
      // channel === 'plugin-marketplace' is derived from this same path, so
      // detectPluginHost cannot miss here.
      if (detectPluginHost(packageRoot) === 'codex') {
        return {
          channel,
          label: 'Codex CLI plugin marketplace',
          canSelfUpdate: false,
          // NOT `memesh upgrade-plugin`. That script reconciles Claude
          // Code's layout specifically: it reads
          // ~/.claude/plugins/marketplaces/pcircle-memesh and patches
          // ~/.claude/plugins/installed_plugins.json. Codex creates
          // neither, so pointing a Codex user at it hands them
          // "ERROR: marketplace cache not found" — worse than saying
          // nothing. Codex ships its own plugin CLI; use that.
          recommendedCommand: PLUGIN_REFRESH_COMMANDS.codex,
          guidance:
            `Run \`${PLUGIN_REFRESH_COMMANDS.codex}\` to refresh the snapshot and re-stage the plugin from it (\`add\` replaces an existing same-version cache). The plugin marketplace pins versions, so a new release does not auto-update.`,
        };
      }
      return {
        channel,
        label: 'Claude Code plugin marketplace',
        canSelfUpdate: false,
        // The bundled script reconciles the marketplace cache, copies the
        // new version into the plugin cache, runs npm install for runtime
        // deps, and patches installed_plugins.json to point at the new
        // version. It's the missing piece that bridges Claude Code's
        // version-pinned plugin layout to a single one-liner upgrade.
        // `memesh upgrade-plugin` finds the plugin cache and the script's
        // prerequisites itself — the old prescription asked the user to
        // hand-substitute the installed version into a path. Plugin-only
        // users (no npm CLI on PATH) reach the same command via npx.
        recommendedCommand: 'memesh upgrade-plugin',
        guidance:
          'Run `memesh upgrade-plugin` (no npm CLI? `npx @pcircle/memesh upgrade-plugin`), or reinstall the plugin from the Claude Code /plugin UI. The plugin marketplace pins versions, so a new release does not auto-update.',
      };
    }
    default:
      return {
        channel: 'unknown',
        label: 'unknown',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this installation from the tool or workflow that installed MeMesh.',
      };
  }
}
