import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { memeshDir } from './paths.js';
const DEFAULT_TIMEOUT_MS = 5000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 160;
function getUpdateCheckPath(updateCheckPath, currentVersion) {
    if (updateCheckPath)
        return updateCheckPath;
    if (process.env.MEMESH_UPDATE_CHECK_PATH)
        return process.env.MEMESH_UPDATE_CHECK_PATH;
    const versionTag = currentVersion && /^[0-9A-Za-z.+-]+$/.test(currentVersion)
        ? currentVersion
        : 'unknown';
    return path.join(memeshDir(), `update-check.${versionTag}.json`);
}
function parseIsoDate(value) {
    if (!value)
        return null;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
}
function summarizeError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, MAX_ERROR_LENGTH);
}
function determineFreshness(source, checkSucceeded, lastSuccessfulCheckAt, now) {
    if (!lastSuccessfulCheckAt)
        return 'unavailable';
    if (source === 'fresh' && checkSucceeded)
        return 'fresh';
    const successfulAt = parseIsoDate(lastSuccessfulCheckAt);
    if (successfulAt === null)
        return 'unavailable';
    return now.getTime() - successfulAt > STALE_AFTER_MS ? 'stale' : 'cached';
}
function buildResult(currentVersion, stored, source, now) {
    const versionMatches = stored.currentVersion === currentVersion;
    const deprecationMessage = versionMatches ? stored.currentVersionDeprecation : null;
    const lastError = versionMatches ? stored.lastError : null;
    return {
        currentVersion,
        latestVersion: stored.latestVersion,
        checkedAt: stored.lastAttemptAt,
        lastAttemptAt: stored.lastAttemptAt,
        lastSuccessfulCheckAt: stored.lastSuccessfulCheckAt,
        lastError,
        updateAvailable: stored.latestVersion !== null && stored.latestVersion !== currentVersion,
        checkSucceeded: stored.checkSucceeded,
        source,
        freshness: determineFreshness(source, stored.checkSucceeded, stored.lastSuccessfulCheckAt, now),
        currentVersionDeprecated: deprecationMessage !== null,
        deprecationMessage,
    };
}
function parseStoredUpdateCheck(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const candidate = raw;
    const latestVersion = candidate.latestVersion;
    const lastAttemptAt = 'lastAttemptAt' in candidate ? candidate.lastAttemptAt : candidate.checkedAt;
    const lastSuccessfulCheckAt = 'lastSuccessfulCheckAt' in candidate ? candidate.lastSuccessfulCheckAt : candidate.checkedAt;
    if (latestVersion !== null && latestVersion !== undefined && typeof latestVersion !== 'string')
        return null;
    if (lastAttemptAt !== null && lastAttemptAt !== undefined && typeof lastAttemptAt !== 'string')
        return null;
    if (lastSuccessfulCheckAt !== null && lastSuccessfulCheckAt !== undefined && typeof lastSuccessfulCheckAt !== 'string')
        return null;
    if ('lastError' in candidate && candidate.lastError !== null && typeof candidate.lastError !== 'string')
        return null;
    if ('checkSucceeded' in candidate && typeof candidate.checkSucceeded !== 'boolean')
        return null;
    if ('currentVersion' in candidate && candidate.currentVersion !== null && typeof candidate.currentVersion !== 'string')
        return null;
    if ('currentVersionDeprecation' in candidate && candidate.currentVersionDeprecation !== null && typeof candidate.currentVersionDeprecation !== 'string')
        return null;
    const normalizedLatestVersion = latestVersion ?? null;
    const normalizedLastAttemptAt = lastAttemptAt ?? null;
    const normalizedLastSuccessfulCheckAt = lastSuccessfulCheckAt ?? null;
    const checkSucceeded = typeof candidate.checkSucceeded === 'boolean'
        ? candidate.checkSucceeded
        : normalizedLatestVersion !== null;
    return {
        currentVersion: typeof candidate.currentVersion === 'string' ? candidate.currentVersion : null,
        latestVersion: normalizedLatestVersion,
        lastAttemptAt: normalizedLastAttemptAt,
        lastSuccessfulCheckAt: normalizedLastSuccessfulCheckAt,
        lastError: typeof candidate.lastError === 'string' ? candidate.lastError : null,
        checkSucceeded,
        currentVersionDeprecation: typeof candidate.currentVersionDeprecation === 'string'
            ? candidate.currentVersionDeprecation
            : null,
    };
}
function readStoredUpdateCheck(updateCheckPath, currentVersion) {
    try {
        const targetPath = getUpdateCheckPath(updateCheckPath, currentVersion);
        if (!fs.existsSync(targetPath))
            return null;
        return parseStoredUpdateCheck(JSON.parse(fs.readFileSync(targetPath, 'utf8')));
    }
    catch {
        return null;
    }
}
function writeStoredUpdateCheck(stored, updateCheckPath, currentVersion) {
    try {
        const targetPath = getUpdateCheckPath(updateCheckPath, currentVersion);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(stored, null, 2));
        try {
            fs.renameSync(tempPath, targetPath);
        }
        catch (renameErr) {
            const REPLACEABLE_ERRS = new Set(['EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY']);
            const renameCode = renameErr?.code;
            if (!renameCode || !REPLACEABLE_ERRS.has(renameCode)) {
                try {
                    fs.unlinkSync(tempPath);
                }
                catch { }
                throw renameErr;
            }
            try {
                fs.unlinkSync(targetPath);
            }
            catch (err) {
                if (err?.code !== 'ENOENT') {
                    try {
                        fs.unlinkSync(tempPath);
                    }
                    catch { }
                    throw renameErr;
                }
            }
            try {
                fs.renameSync(tempPath, targetPath);
            }
            catch (secondErr) {
                try {
                    fs.unlinkSync(tempPath);
                }
                catch { }
                throw secondErr;
            }
        }
    }
    catch {
    }
}
export async function checkForUpdate(currentVersion, options = {}) {
    const { execFileImpl = execFile, now = new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, updateCheckPath, } = options;
    const previous = readStoredUpdateCheck(updateCheckPath, currentVersion);
    const attemptedAt = now.toISOString();
    try {
        const [latestOutcome, deprecationOutcome] = await Promise.all([
            new Promise((resolve) => {
                execFileImpl('npm', ['show', '@pcircle/memesh', 'version'], { timeout: timeoutMs }, (err, stdout) => {
                    if (err)
                        resolve({ outcome: 'failed', error: err });
                    else
                        resolve({ outcome: 'ok', latest: stdout.trim() });
                });
            }),
            new Promise((resolve) => {
                execFileImpl('npm', ['view', `@pcircle/memesh@${currentVersion}`, 'deprecated'], { timeout: timeoutMs }, (err, stdout, stderr) => {
                    if (err) {
                        const errText = [
                            stderr,
                            err.stderr,
                            err.message,
                        ].filter((v) => typeof v === 'string').join(' ');
                        if (/E404|404 Not Found/i.test(errText)) {
                            resolve({ outcome: 'ok', message: null });
                            return;
                        }
                        resolve({ outcome: 'failed' });
                        return;
                    }
                    const trimmed = (stdout || '').trim();
                    resolve({ outcome: 'ok', message: trimmed.length > 0 ? trimmed : null });
                });
            }),
        ]);
        const needsInherited = deprecationOutcome.outcome === 'failed' || latestOutcome.outcome === 'failed';
        const refreshed = needsInherited ? readStoredUpdateCheck(updateCheckPath, currentVersion) : null;
        const inheritedDeprecation = refreshed?.currentVersion === currentVersion
            ? refreshed?.currentVersionDeprecation ?? null
            : previous?.currentVersion === currentVersion
                ? previous?.currentVersionDeprecation ?? null
                : null;
        const hasInheritablePrior = inheritedDeprecation !== null;
        const resolvedDeprecation = deprecationOutcome.outcome === 'ok'
            ? deprecationOutcome.message
            : inheritedDeprecation;
        if (latestOutcome.outcome === 'ok') {
            const partialDeprecationFailure = deprecationOutcome.outcome === 'failed' && !hasInheritablePrior;
            const stored = {
                currentVersion,
                latestVersion: latestOutcome.latest,
                lastAttemptAt: attemptedAt,
                lastSuccessfulCheckAt: attemptedAt,
                lastError: partialDeprecationFailure
                    ? 'deprecation lookup failed (status unknown)'
                    : null,
                checkSucceeded: true,
                currentVersionDeprecation: resolvedDeprecation,
            };
            writeStoredUpdateCheck(stored, updateCheckPath, currentVersion);
            return buildResult(currentVersion, stored, 'fresh', now);
        }
        const stored = {
            currentVersion,
            latestVersion: previous?.latestVersion ?? null,
            lastAttemptAt: attemptedAt,
            lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? null,
            lastError: summarizeError(latestOutcome.error),
            checkSucceeded: false,
            currentVersionDeprecation: resolvedDeprecation,
        };
        writeStoredUpdateCheck(stored, updateCheckPath, currentVersion);
        const source = stored.lastSuccessfulCheckAt ? 'cache' : 'fresh';
        return buildResult(currentVersion, stored, source, now);
    }
    catch (err) {
        const stored = {
            currentVersion,
            latestVersion: previous?.latestVersion ?? null,
            lastAttemptAt: attemptedAt,
            lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? null,
            lastError: summarizeError(err),
            checkSucceeded: false,
            currentVersionDeprecation: previous?.currentVersion === currentVersion
                ? previous?.currentVersionDeprecation ?? null
                : null,
        };
        writeStoredUpdateCheck(stored, updateCheckPath, currentVersion);
        const source = stored.lastSuccessfulCheckAt ? 'cache' : 'fresh';
        return buildResult(currentVersion, stored, source, now);
    }
}
export function getLastUpdateCheck(currentVersion, options = {}) {
    const stored = readStoredUpdateCheck(options.updateCheckPath, currentVersion);
    if (!stored)
        return null;
    return buildResult(currentVersion, stored, 'cache', options.now ?? new Date());
}
export async function getUpdateCheck(currentVersion, options = {}) {
    if (options.preferFresh === false) {
        return getLastUpdateCheck(currentVersion, {
            updateCheckPath: options.updateCheckPath,
            now: options.now,
        });
    }
    return checkForUpdate(currentVersion, options);
}
function formatFreshness(update) {
    switch (update.freshness) {
        case 'fresh':
            return 'fresh';
        case 'cached':
            return `cached from ${update.lastSuccessfulCheckAt}`;
        case 'stale':
            return `stale cache from ${update.lastSuccessfulCheckAt}`;
        default:
            return 'unavailable';
    }
}
export function formatUpdateCheckStatus(update) {
    if (!update) {
        return ['Update check: unavailable'];
    }
    const lines = [];
    if (update.currentVersionDeprecated && update.deprecationMessage) {
        lines.push(`⚠️  Installed version ${update.currentVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`);
    }
    if (update.currentVersionDeprecated) {
        if (update.updateAvailable && update.latestVersion) {
            lines.push(`🔄 Update available: ${update.latestVersion} (${formatFreshness(update)}; run: memesh update)`);
        }
        else if (update.latestVersion
            && update.latestVersion === update.currentVersion
            && update.freshness === 'fresh') {
            lines.push(`Update check: deprecated, no upgrade target yet (${formatFreshness(update)})`);
        }
        else {
            lines.push(`Update check: deprecated, upgrade target unknown — try \`memesh update\` (${formatFreshness(update)})`);
        }
    }
    else if (update.freshness === 'unavailable') {
        lines.push('Update check: unavailable');
    }
    else if (update.updateAvailable && update.latestVersion) {
        lines.push(`🔄 Update available: ${update.latestVersion} (${formatFreshness(update)}; run: memesh update)`);
    }
    else if (update.checkSucceeded && update.lastError) {
        lines.push(`Update check: partial — deprecation status unknown (${formatFreshness(update)})`);
    }
    else if (update.latestVersion) {
        lines.push(`Update check: up to date (${formatFreshness(update)}; latest ${update.latestVersion})`);
    }
    else {
        lines.push(`Update check: no version information available (${formatFreshness(update)})`);
    }
    if (!update.checkSucceeded && update.lastError) {
        lines.push(`Last update check failed: ${update.lastError}`);
    }
    else if (update.checkSucceeded && update.lastError) {
        lines.push(`⚠️  Update check partial: ${update.lastError}`);
    }
    return lines;
}
//# sourceMappingURL=version-check.js.map