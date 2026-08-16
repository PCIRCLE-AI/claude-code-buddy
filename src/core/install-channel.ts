import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

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

// Claude Code installs plugins under <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>.
// Match that suffix anchored to the .claude/plugins/cache/ segment so we
// don't false-positive on a user repo path that happens to contain
// "plugins/cache". Using path.sep keeps the matcher Windows-correct.
function isPluginMarketplacePath(packageRoot: string): boolean {
  const segment = `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`;
  return packageRoot.includes(segment);
}

export function getGlobalNpmRoot(
  options: { execFileSyncImpl?: ExecFileSyncLike } = {},
): string | null {
  const { execFileSyncImpl = execFileSync } = options;

  try {
    return execFileSyncImpl('npm', ['root', '-g'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
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
  // under a custom npm prefix path. Anchor on the .claude/plugins/cache/
  // path segment, which only Claude Code's plugin runtime writes.
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

export function getInstallChannelSupport(channel: InstallChannel): InstallChannelSupport {
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
    case 'plugin-marketplace':
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
