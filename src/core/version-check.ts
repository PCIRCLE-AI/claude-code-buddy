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
  // The deprecation message npm has on the *current* installed version,
  // or null if it isn't deprecated. Captured so the session-start
  // banner can surface a "your version is deprecated, upgrade now"
  // warning (a stronger nudge than the regular "update available" hint
  // — used when the maintainers actively flagged a published version,
  // typically for a security advisory).
  currentVersionDeprecation: string | null;
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
  /** True when npm has the current installed version flagged as deprecated. */
  currentVersionDeprecated: boolean;
  /** Maintainer-supplied deprecation message, or null when not deprecated. */
  deprecationMessage: string | null;
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
  // "lastSuccessfulCheckAt" tracks the last time the version lookup
  // answered (which is what every consumer needs to render
  // "Update available" / "up to date" lines). Partial deprecation
  // failures are surfaced separately through `lastError`; they
  // don't suppress freshness, since callers who key off
  // freshness === 'unavailable' would otherwise hide an actionable
  // latestVersion just because npm couldn't answer the deprecation
  // sub-call.
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
  // Both the deprecation flag AND the lastError field are
  // version-scoped: they describe the cached `stored.currentVersion`,
  // not necessarily the version currently installed. If the user
  // upgraded outside `memesh update` (e.g. ran `npm install -g`
  // manually) the cache lags by one version. Carrying the prior
  // version's lastError forward would surface a stale "deprecation
  // status unknown" warning on a freshly-upgraded install that
  // hasn't even tried a lookup yet. Drop both on mismatch and let
  // the next online check repopulate cleanly.
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
  if ('currentVersionDeprecation' in candidate && candidate.currentVersionDeprecation !== null && typeof candidate.currentVersionDeprecation !== 'string') return null;

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
    // Latest version (canonical) and current version's deprecation
    // status are independent registry queries. Fetch both in parallel.
    // The deprecation lookup is allowed to fail independently — we
    // tag the outcome ('ok' vs 'failed') rather than collapsing both
    // into null, so the success-branch below can preserve a
    // previously-cached deprecation flag instead of silently wiping
    // it on a transient deprecation-only network hiccup.
    type DeprecationOutcome =
      | { outcome: 'ok'; message: string | null }
      | { outcome: 'failed' };

    const [latest, deprecationOutcome] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        execFileImpl(
          'npm',
          ['show', '@pcircle/memesh', 'version'],
          { timeout: timeoutMs },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
          },
        );
      }),
      new Promise<DeprecationOutcome>((resolve) => {
        execFileImpl(
          'npm',
          ['view', `@pcircle/memesh@${currentVersion}`, 'deprecated'],
          { timeout: timeoutMs },
          (err, stdout, stderr) => {
            if (err) {
              // npm responded "404 Not Found" / "E404" when the
              // installed version is not published on the registry
              // (source checkouts, pre-publish builds). That's a
              // *successful* answer of "this version doesn't exist
              // on npm, so it can't be deprecated" — distinct from a
              // real network/registry failure where the deprecation
              // status is unknown. We pattern-match across stderr,
              // err.stderr (some Node versions duplicate it onto
              // err), AND err.message (npm versions that swallow
              // stderr leave the 404 only on the message).
              const errText = [
                stderr,
                (err as { stderr?: string }).stderr,
                (err as { message?: string }).message,
              ].filter((v): v is string => typeof v === 'string').join(' ');
              if (/E404|404 Not Found/i.test(errText)) {
                resolve({ outcome: 'ok', message: null });
                return;
              }
              resolve({ outcome: 'failed' });
              return;
            }
            const trimmed = (stdout || '').trim();
            resolve({ outcome: 'ok', message: trimmed.length > 0 ? trimmed : null });
          },
        );
      }),
    ]);

    // If the deprecation lookup failed but the version lookup
    // succeeded, hold on to the previous deprecation flag *only when
    // it was for the same installed version*. Otherwise we'd persist
    // a flag belonging to an older install.
    const hasInheritablePrior =
      previous?.currentVersion === currentVersion
      && (previous?.currentVersionDeprecation ?? null) !== null;
    const resolvedDeprecation: string | null =
      deprecationOutcome.outcome === 'ok'
        ? deprecationOutcome.message
        : hasInheritablePrior
          ? previous!.currentVersionDeprecation ?? null
          : null;

    // When the deprecation lookup failed AND we have no prior flag
    // to inherit, the deprecation status is genuinely UNKNOWN — not
    // "healthy". We surface that through `lastError` so the status
    // and doctor surfaces can warn the operator. We do NOT demote
    // `checkSucceeded` to false here: the version lookup succeeded,
    // and `memesh update` legitimately depends on `checkSucceeded`
    // to know which version to install. A transient deprecation-
    // lookup failure must not block the updater when we already
    // have a target version.
    const partialDeprecationFailure =
      deprecationOutcome.outcome === 'failed' && !hasInheritablePrior;

    // Freshness tracks the version lookup. The deprecation
    // sub-call's outcome is surfaced via lastError (and via the
    // version-aware staleness gate in decideAutoUpdateHook), so
    // partial failure doesn't have to suppress the version-fresh
    // signal. Hiding latestVersion just because deprecation timed
    // out would tell the user "update unavailable" while in fact
    // memesh update could still apply the upgrade.
    const stored: StoredUpdateCheck = {
      currentVersion,
      latestVersion: latest,
      lastAttemptAt: attemptedAt,
      lastSuccessfulCheckAt: attemptedAt,
      lastError: partialDeprecationFailure
        ? 'deprecation lookup failed (status unknown)'
        : null,
      // Version lookup succeeded → checkSucceeded stays true, even
      // if the deprecation sub-call failed. lastError surfaces the
      // partial-failure detail to operators.
      checkSucceeded: true,
      currentVersionDeprecation: resolvedDeprecation,
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
      // Preserve the prior deprecation flag if it was for *this* same
      // installed version — losing a known-deprecated flag on a
      // transient network failure would silently dim the warning.
      currentVersionDeprecation:
        previous?.currentVersion === currentVersion
          ? previous?.currentVersionDeprecation ?? null
          : null,
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

  // Deprecation warning leads — it's the highest-severity signal
  // (maintainer flagged the installed version, often for a security
  // advisory) and shouldn't be lost below an "up to date" / "update
  // available" line that comes from the same data.
  if (update.currentVersionDeprecated && update.deprecationMessage) {
    lines.push(`⚠️  Installed version ${update.currentVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`);
  }

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
  } else if (update.checkSucceeded && update.lastError) {
    // Partial-failure case: the version lookup answered but the
    // deprecation sub-call did not. Surface the partial failure so
    // operators see the unknown-deprecation signal rather than an
    // unconditional "all clear" line.
    lines.push(`⚠️  Update check partial: ${update.lastError}`);
  }

  return lines;
}

export function getUpdateCheckPathForTests(): string {
  return UPDATE_CHECK_PATH;
}
