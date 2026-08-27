import { execFileSync } from 'child_process';
const DEFAULT_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_READBACK_TIMEOUT_MS = 30 * 1000;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VALID_AUTO_UPDATE_POLICIES = new Set([
    'off',
    'patch',
    'minor',
    'major',
]);
export function parseAutoUpdatePolicy(value) {
    if (typeof value !== 'string')
        return null;
    const lowered = value.toLowerCase();
    return VALID_AUTO_UPDATE_POLICIES.has(lowered)
        ? lowered
        : null;
}
function parseSemver(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(version.trim());
    if (!m)
        return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
    };
}
export function classifyBump(from, to) {
    const a = parseSemver(from);
    const b = parseSemver(to);
    if (!a || !b)
        return null;
    if (b.major > a.major)
        return 'major';
    if (b.major < a.major)
        return null;
    if (b.minor > a.minor)
        return 'minor';
    if (b.minor < a.minor)
        return null;
    if (b.patch > a.patch)
        return 'patch';
    return null;
}
const POLICY_RANK = {
    off: 0,
    patch: 1,
    minor: 2,
    major: 3,
};
const BUMP_RANK = {
    patch: 1,
    minor: 2,
    major: 3,
};
export function decideAutoUpdate(input) {
    const { currentVersion, latestVersion, policy, currentVersionDeprecated } = input;
    if (!latestVersion) {
        return { shouldUpdate: false, bump: null, reason: 'no latest version available', deprecationOverride: false };
    }
    const bump = classifyBump(currentVersion, latestVersion);
    if (!bump) {
        return { shouldUpdate: false, bump: null, reason: 'already at or above latest', deprecationOverride: false };
    }
    const policyAllows = POLICY_RANK[policy] >= BUMP_RANK[bump];
    if (policyAllows) {
        return {
            shouldUpdate: true,
            bump,
            reason: `policy '${policy}' permits ${bump} bump`,
            deprecationOverride: false,
        };
    }
    if (currentVersionDeprecated && bump === 'patch' && policy !== 'off') {
        return {
            shouldUpdate: true,
            bump,
            reason: `installed ${currentVersion} is deprecated; security override forces patch upgrade despite policy '${policy}'`,
            deprecationOverride: true,
        };
    }
    return {
        shouldUpdate: false,
        bump,
        reason: `policy '${policy}' does not permit ${bump} bump`,
        deprecationOverride: false,
    };
}
function parseInstalledGlobalVersion(raw) {
    const parsed = JSON.parse(raw);
    return parsed.dependencies?.['@pcircle/memesh']?.version ?? null;
}
export function getInstalledGlobalVersion(options = {}) {
    const { execFileSyncImpl = execFileSync, readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS, } = options;
    try {
        const raw = execFileSyncImpl('npm', ['ls', '-g', '@pcircle/memesh', '--json', '--depth=0'], { encoding: 'utf8', timeout: readbackTimeoutMs });
        return parseInstalledGlobalVersion(raw);
    }
    catch {
        return null;
    }
}
export function runGlobalUpdate(latestVersion, options = {}) {
    const { execFileSyncImpl = execFileSync, installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS, readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS, } = options;
    if (!EXACT_VERSION_RE.test(latestVersion)) {
        throw new Error(`refusing non-exact npm version target: ${latestVersion}`);
    }
    execFileSyncImpl('npm', ['install', '-g', `@pcircle/memesh@${latestVersion}`], { stdio: 'inherit', timeout: installTimeoutMs });
    const installedVersion = getInstalledGlobalVersion({ execFileSyncImpl, readbackTimeoutMs });
    if (installedVersion !== latestVersion) {
        if (installedVersion) {
            throw new Error(`expected ${latestVersion}, but npm reports ${installedVersion} is installed`);
        }
        throw new Error('npm did not report a global @pcircle/memesh installation after update');
    }
    return { installedVersion };
}
//# sourceMappingURL=updater.js.map