import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
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
const PLUGIN_HOST_DIRS = [
    ['claude-code', '.claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', '.codex', 'CODEX_HOME'],
];
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
                    recommendedCommand: 'codex plugin marketplace upgrade pcircle-memesh',
                    guidance: 'Run `codex plugin marketplace upgrade pcircle-memesh` to refresh the snapshot, then `codex plugin remove memesh@pcircle-memesh` and `codex plugin add memesh@pcircle-memesh` to install the new version. The plugin marketplace pins versions, so a new release does not auto-update — and `add` over an existing same-version cache keeps the old files, which is why the remove step is there.',
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