import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { homeDir } from './paths.js';
function isSubpath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function getRootBeforeNodeModules(packageRoot) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const index = packageRoot.indexOf(marker);
    if (index === -1)
        return null;
    return packageRoot.slice(0, index);
}
export const PLUGIN_REFRESH_COMMANDS = {
    'claude-code': 'memesh upgrade-plugin',
    codex: 'codex plugin marketplace upgrade pcircle-memesh && codex plugin add memesh@pcircle-memesh',
};
const PLUGIN_HOST_DIRS = [
    ['claude-code', '.claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', '.codex', 'CODEX_HOME'],
];
export function pluginHostConfigRoot(host) {
    const descriptor = PLUGIN_HOST_DIRS.find(([candidate]) => candidate === host);
    if (!descriptor)
        throw new Error(`Unsupported plugin host: ${host}`);
    const [, defaultDir, envVar] = descriptor;
    const relocated = process.env[envVar];
    return relocated ? path.resolve(relocated) : path.join(homeDir(), defaultDir);
}
const VERSION_DIRECTORY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;
function parseVersionDirectory(raw) {
    const match = VERSION_DIRECTORY.exec(raw);
    if (!match)
        return null;
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
function compareIdentifiers(a, b) {
    const aNumeric = NUMERIC_IDENTIFIER.test(a);
    const bNumeric = NUMERIC_IDENTIFIER.test(b);
    if (aNumeric && bNumeric)
        return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
    if (aNumeric !== bNumeric)
        return aNumeric ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}
function compareVersions(a, b) {
    for (let index = 0; index < a.core.length; index += 1) {
        if (a.core[index] !== b.core[index])
            return a.core[index] < b.core[index] ? -1 : 1;
    }
    if (a.prerelease === null || b.prerelease === null) {
        if (a.prerelease !== b.prerelease)
            return a.prerelease === null ? 1 : -1;
    }
    else {
        const length = Math.max(a.prerelease.length, b.prerelease.length);
        for (let index = 0; index < length; index += 1) {
            const aIdentifier = a.prerelease[index];
            const bIdentifier = b.prerelease[index];
            if (aIdentifier === undefined || bIdentifier === undefined) {
                if (aIdentifier !== bIdentifier)
                    return aIdentifier === undefined ? -1 : 1;
                break;
            }
            const compared = compareIdentifiers(aIdentifier, bIdentifier);
            if (compared !== 0)
                return compared;
        }
    }
    return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
}
export function versionedPluginCacheRoots(root) {
    try {
        return fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => parseVersionDirectory(entry.name))
            .filter((version) => version !== null)
            .sort(compareVersions)
            .map(version => path.join(root, version.raw));
    }
    catch {
        return [];
    }
}
export function detectPluginHost(packageRoot, options = {}) {
    const { env = process.env } = options;
    const normalized = path.resolve(packageRoot);
    for (const [host, dir, envVar] of PLUGIN_HOST_DIRS) {
        const segment = `${path.sep}${dir}${path.sep}plugins${path.sep}cache${path.sep}`;
        if (normalized.includes(segment))
            return host;
        const relocated = env[envVar];
        if (relocated) {
            const cacheRoot = path.join(path.resolve(relocated), 'plugins', 'cache');
            if (isSubpath(cacheRoot, normalized))
                return host;
        }
    }
    return null;
}
function isPluginMarketplacePath(packageRoot) {
    return detectPluginHost(packageRoot) !== null;
}
function derivedGlobalNpmRoot(execPath) {
    const prefix = path.dirname(path.dirname(execPath));
    return process.platform === 'win32'
        ? path.join(prefix, 'node_modules')
        : path.join(prefix, 'lib', 'node_modules');
}
export function getGlobalNpmRoot(options = {}) {
    const { execFileSyncImpl = execFileSync, execPathImpl = process.execPath } = options;
    try {
        const spawned = execFileSyncImpl('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        if (spawned)
            return spawned;
    }
    catch {
    }
    return derivedGlobalNpmRoot(execPathImpl);
}
export function detectInstallChannel(options) {
    const { packageRoot, globalNpmRoot, existsSyncImpl = fs.existsSync, } = options;
    const normalizedPackageRoot = path.resolve(packageRoot);
    if (isPluginMarketplacePath(normalizedPackageRoot)) {
        return 'plugin-marketplace';
    }
    if (existsSyncImpl(path.join(normalizedPackageRoot, '.git'))) {
        return 'source-checkout';
    }
    const resolvedGlobalNpmRoot = typeof globalNpmRoot === 'function' ? globalNpmRoot() : globalNpmRoot;
    if (resolvedGlobalNpmRoot && isSubpath(path.resolve(resolvedGlobalNpmRoot), normalizedPackageRoot)) {
        return 'npm-global';
    }
    const rootBeforeNodeModules = getRootBeforeNodeModules(normalizedPackageRoot);
    if (rootBeforeNodeModules && existsSyncImpl(path.join(rootBeforeNodeModules, 'package.json'))) {
        return 'npm-local';
    }
    return 'unknown';
}
const channelCache = new Map();
export function getCurrentInstallChannel(options) {
    const { packageRoot, existsSyncImpl, execFileSyncImpl, } = options;
    const canCache = !existsSyncImpl && !execFileSyncImpl;
    if (canCache) {
        const cached = channelCache.get(packageRoot);
        if (cached !== undefined)
            return cached;
    }
    const channel = detectInstallChannel({
        packageRoot,
        globalNpmRoot: () => getGlobalNpmRoot({ execFileSyncImpl }),
        existsSyncImpl,
    });
    if (canCache)
        channelCache.set(packageRoot, channel);
    return channel;
}
export function getInstallChannelSupport(channel, packageRoot) {
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
            if (detectPluginHost(packageRoot) === 'codex') {
                return {
                    channel,
                    label: 'Codex CLI plugin marketplace',
                    canSelfUpdate: false,
                    recommendedCommand: PLUGIN_REFRESH_COMMANDS.codex,
                    guidance: `Run \`${PLUGIN_REFRESH_COMMANDS.codex}\` to refresh the snapshot and re-stage the plugin from it (\`add\` replaces an existing same-version cache). The plugin marketplace pins versions, so a new release does not auto-update.`,
                };
            }
            return {
                channel,
                label: 'Claude Code plugin marketplace',
                canSelfUpdate: false,
                recommendedCommand: 'memesh upgrade-plugin',
                guidance: 'Run `memesh upgrade-plugin` (no npm CLI? `npx @pcircle/memesh upgrade-plugin`), or reinstall the plugin from the Claude Code /plugin UI. The plugin marketplace pins versions, so a new release does not auto-update.',
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
//# sourceMappingURL=install-channel.js.map