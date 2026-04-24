import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

const UPDATE_CHECK_PATH = path.join(os.homedir(), '.memesh', 'update-check.json');
const DEFAULT_TIMEOUT_MS = 5000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 160;

export type UpdateCheckSource = 'fresh' | 'cache';
export type UpdateCheckFreshness = 'fresh' | 'cached' | 'stale' | 'unavailable';

interface StoredUpdateCheck {
  currentVersion: string | null;
  latestVersion: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string | null;
  checkSucceeded: boolean;
}

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string | null;
  updateAvailable: boolean;
  checkSucceeded: boolean;
  source: UpdateCheckSource;
  freshness: UpdateCheckFreshness;
}

interface CheckForUpdateOptions {
  execFileImpl?: typeof execFile;
  now?: Date;
  timeoutMs?: number;
  updateCheckPath?: string;
}

interface GetUpdateCheckOptions extends CheckForUpdateOptions {
  preferFresh?: boolean;
}

function getUpdateCheckPath(updateCheckPath?: string): string {
  return updateCheckPath ?? process.env.MEMESH_UPDATE_CHECK_PATH ?? UPDATE_CHECK_PATH;
}

function parseIsoDate(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function determineFreshness(
  source: UpdateCheckSource,
  checkSucceeded: boolean,
  lastSuccessfulCheckAt: string | null,
  now: Date,
): UpdateCheckFreshness {
  if (!lastSuccessfulCheckAt) return 'unavailable';
  if (source === 'fresh' && checkSucceeded) return 'fresh';

  const successfulAt = parseIsoDate(lastSuccessfulCheckAt);
  if (successfulAt === null) return 'unavailable';

  return now.getTime() - successfulAt > STALE_AFTER_MS ? 'stale' : 'cached';
}

function buildResult(
  currentVersion: string,
  stored: StoredUpdateCheck,
  source: UpdateCheckSource,
  now: Date,
): UpdateCheck {
  return {
    currentVersion,
    latestVersion: stored.latestVersion,
    checkedAt: stored.lastAttemptAt,
    lastAttemptAt: stored.lastAttemptAt,
    lastSuccessfulCheckAt: stored.lastSuccessfulCheckAt,
    lastError: stored.lastError,
    updateAvailable: stored.latestVersion !== null && stored.latestVersion !== currentVersion,
    checkSucceeded: stored.checkSucceeded,
    source,
    freshness: determineFreshness(source, stored.checkSucceeded, stored.lastSuccessfulCheckAt, now),
  };
}

function parseStoredUpdateCheck(raw: unknown): StoredUpdateCheck | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const latestVersion = candidate.latestVersion;
  const lastAttemptAt = 'lastAttemptAt' in candidate ? candidate.lastAttemptAt : candidate.checkedAt;
  const lastSuccessfulCheckAt = 'lastSuccessfulCheckAt' in candidate ? candidate.lastSuccessfulCheckAt : candidate.checkedAt;

  if (latestVersion !== null && latestVersion !== undefined && typeof latestVersion !== 'string') return null;
  if (lastAttemptAt !== null && lastAttemptAt !== undefined && typeof lastAttemptAt !== 'string') return null;
  if (lastSuccessfulCheckAt !== null && lastSuccessfulCheckAt !== undefined && typeof lastSuccessfulCheckAt !== 'string') return null;
  if ('lastError' in candidate && candidate.lastError !== null && typeof candidate.lastError !== 'string') return null;
  if ('checkSucceeded' in candidate && typeof candidate.checkSucceeded !== 'boolean') return null;
  if ('currentVersion' in candidate && candidate.currentVersion !== null && typeof candidate.currentVersion !== 'string') return null;

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
  };
}

function readStoredUpdateCheck(updateCheckPath?: string): StoredUpdateCheck | null {
  try {
    const targetPath = getUpdateCheckPath(updateCheckPath);
    if (!fs.existsSync(targetPath)) return null;
    return parseStoredUpdateCheck(JSON.parse(fs.readFileSync(targetPath, 'utf8')));
  } catch {
    return null;
  }
}

function writeStoredUpdateCheck(stored: StoredUpdateCheck, updateCheckPath?: string): void {
  try {
    const targetPath = getUpdateCheckPath(updateCheckPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(stored, null, 2));
  } catch {
    // Cache writes are best effort only.
  }
}

/**
 * Check npm registry for latest version (async, non-blocking).
 * Preserves the last successful result and records the latest attempt/error so
 * offline dashboard and CLI UX can stay truthful without losing prior good data.
 */
export async function checkForUpdate(
  currentVersion: string,
  options: CheckForUpdateOptions = {},
): Promise<UpdateCheck> {
  const {
    execFileImpl = execFile,
    now = new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    updateCheckPath,
  } = options;

  const previous = readStoredUpdateCheck(updateCheckPath);
  const attemptedAt = now.toISOString();

  try {
    const latest = await new Promise<string>((resolve, reject) => {
      execFileImpl(
        'npm',
        ['show', '@pcircle/memesh', 'version'],
        { timeout: timeoutMs },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });

    const stored: StoredUpdateCheck = {
      currentVersion,
      latestVersion: latest,
      lastAttemptAt: attemptedAt,
      lastSuccessfulCheckAt: attemptedAt,
      lastError: null,
      checkSucceeded: true,
    };

    writeStoredUpdateCheck(stored, updateCheckPath);
    return buildResult(currentVersion, stored, 'fresh', now);
  } catch (err) {
    const stored: StoredUpdateCheck = {
      currentVersion,
      latestVersion: previous?.latestVersion ?? null,
      lastAttemptAt: attemptedAt,
      lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? null,
      lastError: summarizeError(err),
      checkSucceeded: false,
    };

    writeStoredUpdateCheck(stored, updateCheckPath);
    const source: UpdateCheckSource = stored.lastSuccessfulCheckAt ? 'cache' : 'fresh';
    return buildResult(currentVersion, stored, source, now);
  }
}

/**
 * Read cached update-check state. This may represent a successful cached check,
 * a stale cached check after a later failure, or an unavailable state when no
 * successful check has been recorded yet.
 */
export function getLastUpdateCheck(
  currentVersion: string,
  options: { updateCheckPath?: string; now?: Date } = {},
): UpdateCheck | null {
  const stored = readStoredUpdateCheck(options.updateCheckPath);
  if (!stored) return null;
  return buildResult(currentVersion, stored, 'cache', options.now ?? new Date());
}

/**
 * Prefer a fresh npm lookup, but allow callers to explicitly request the cached
 * state only.
 */
export async function getUpdateCheck(
  currentVersion: string,
  options: GetUpdateCheckOptions = {},
): Promise<UpdateCheck | null> {
  if (options.preferFresh === false) {
    return getLastUpdateCheck(currentVersion, {
      updateCheckPath: options.updateCheckPath,
      now: options.now,
    });
  }

  return checkForUpdate(currentVersion, options);
}

function formatFreshness(update: UpdateCheck): string {
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

export function formatUpdateCheckStatus(update: UpdateCheck | null): string[] {
  if (!update) {
    return ['Update check: unavailable'];
  }

  const lines: string[] = [];
  if (update.freshness === 'unavailable') {
    lines.push('Update check: unavailable');
  } else if (update.updateAvailable && update.latestVersion) {
    lines.push(`🔄 Update available: ${update.latestVersion} (${formatFreshness(update)}; run: memesh update)`);
  } else if (update.latestVersion) {
    lines.push(`Update check: up to date (${formatFreshness(update)}; latest ${update.latestVersion})`);
  } else {
    lines.push(`Update check: no version information available (${formatFreshness(update)})`);
  }

  if (!update.checkSucceeded && update.lastError) {
    lines.push(`Last update check failed: ${update.lastError}`);
  }

  return lines;
}

export function getUpdateCheckPathForTests(): string {
  return UPDATE_CHECK_PATH;
}
