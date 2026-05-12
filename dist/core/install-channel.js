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
function isPluginMarketplacePath(packageRoot) {
    const segment = `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`;
    return packageRoot.includes(segment);
}
export function getGlobalNpmRoot(options = {}) {
    const { execFileSyncImpl = execFileSync } = options;
    try {
        return execFileSyncImpl('npm', ['root', '-g'], { encoding: 'utf8' }).trim() || null;
    }
    catch {
        return null;
    }
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
    if (globalNpmRoot && isSubpath(path.resolve(globalNpmRoot), normalizedPackageRoot)) {
        return 'npm-global';
    }
    const rootBeforeNodeModules = getRootBeforeNodeModules(normalizedPackageRoot);
    if (rootBeforeNodeModules && existsSyncImpl(path.join(rootBeforeNodeModules, 'package.json'))) {
        return 'npm-local';
    }
    return 'unknown';
}
export function getCurrentInstallChannel(options) {
    const { packageRoot, existsSyncImpl, execFileSyncImpl, } = options;
    return detectInstallChannel({
        packageRoot,
        globalNpmRoot: getGlobalNpmRoot({ execFileSyncImpl }),
        existsSyncImpl,
    });
}
export function getInstallChannelSupport(channel) {
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
                recommendedCommand: 'bash scripts/upgrade-plugin.sh',
                guidance: 'Run `bash <plugin-root>/scripts/upgrade-plugin.sh` (or reinstall the plugin from the Claude Code /plugin UI). The plugin marketplace pins versions, so a new release does not auto-update.',
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
//# sourceMappingURL=install-channel.js.map