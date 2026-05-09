import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { memeshDir } from './paths.js';

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

function getUpdateCheckPath(
  updateCheckPath?: string,
  currentVersion?: string,
): string {
  // Test/integration overrides win — both unblock specific path
  // injection without changing the per-version semantics below.
  if (updateCheckPath) return updateCheckPath;
  if (process.env.MEMESH_UPDATE_CHECK_PATH) return process.env.MEMESH_UPDATE_CHECK_PATH;
  // Codex round 38: scope cache by installed version so multi-install
  // setups (e.g. global 4.1.3 + project-local 4.1.1) don't fight
  // over a single cache slot. Without this, install A's refresh
  // overwrites install B's deprecation flag and B's session sees no
  // banner. Per-version files give each install its own slot.
  // Filename is sanitized: only semver-safe chars + version length
  // bound. Falls back to 'unknown' if version is missing/malformed.
  const versionTag = currentVersion && /^[0-9A-Za-z.+-]+$/.test(currentVersion)
    ? currentVersion
    : 'unknown';
  return path.join(memeshDir(), `update-check.${versionTag}.json`);
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

function readStoredUpdateCheck(
  updateCheckPath?: string,
  currentVersion?: string,
): StoredUpdateCheck | null {
  try {
    const targetPath = getUpdateCheckPath(updateCheckPath, currentVersion);
    if (!fs.existsSync(targetPath)) return null;
    return parseStoredUpdateCheck(JSON.parse(fs.readFileSync(targetPath, 'utf8')));
  } catch {
    return null;
  }
}

function writeStoredUpdateCheck(
  stored: StoredUpdateCheck,
  updateCheckPath?: string,
  currentVersion?: string,
): void {
  try {
    const targetPath = getUpdateCheckPath(updateCheckPath, currentVersion);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    // Atomic write: write to a per-process temp file, then rename
    // into place. A direct fs.writeFileSync(targetPath, ...) would
    // truncate then write, leaving a window where a concurrent
    // reader (or a second writer started by a parallel session-
    // start) sees an empty / torn file. With temp+rename the
    // visible state is always "old contents" or "new contents",
    // never partial.
    //
    // Two-step replace: try renameSync first (POSIX always
    // succeeds, Windows usually does). If it fails (Windows AV/FS
    // exclusive-lock on the destination), fall back to unlink-
    // then-rename. The previous version unlinked unconditionally,
    // which left the user with NO cache if the rename then failed
    // — losing every prior update / deprecation signal until the
    // next online refresh. Now we only unlink when rename
    // demonstrably can't replace, and we restore the temp file's
    // intended target by retrying the rename. If both attempts
    // fail, clean up the temp file and bail (caller's catch
    // swallows since cache writes are best-effort).
    const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(stored, null, 2));
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (renameErr: any) {
      // Codex round 36: only fall through to the destructive
      // unlink-then-rename path on error codes that actually mean
      // "destination cannot be replaced" (Windows AV / antivirus
      // briefly holds the file open, or another process owns the
      // handle). For unrelated rename failures (disk full,
      // permission errors on the temp file, EROFS), DON'T touch
      // the existing cache — losing every prior update /
      // deprecation signal because of a transient disk-full event
      // would silently demote the security path. Bail and let the
      // caller's catch swallow.
      const REPLACEABLE_ERRS = new Set(['EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY']);
      if (!REPLACEABLE_ERRS.has(renameErr?.code)) {
        try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
        throw renameErr;
      }
      try { fs.unlinkSync(targetPath); } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
          throw renameErr;
        }
      }
      try {
        fs.renameSync(tempPath, targetPath);
      } catch (secondErr) {
        try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
        throw secondErr;
      }
    }
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

  const previous = readStoredUpdateCheck(updateCheckPath, currentVersion);
  const attemptedAt = now.toISOString();

  // Latest version (canonical) and current version's deprecation
  // status are independent registry queries. Both Promises always
  // RESOLVE to a tagged outcome (ok / failed) — never reject — so a
  // failure on one branch can't short-circuit the other and discard
  // an already-resolved good result. Codex round 31 caught the prior
  // `Promise.all` flow: when `npm show ... version` rejected, the
  // catch path ran without seeing the deprecation Promise's
  // already-successful result, dropping a real maintainer
  // deprecation/security signal.
  type LatestOutcome =
    | { outcome: 'ok'; latest: string }
    | { outcome: 'failed'; error: unknown };
  type DeprecationOutcome =
    | { outcome: 'ok'; message: string | null }
    | { outcome: 'failed' };

  try {
    const [latestOutcome, deprecationOutcome] = await Promise.all([
      new Promise<LatestOutcome>((resolve) => {
        execFileImpl(
          'npm',
          ['show', '@pcircle/memesh', 'version'],
          { timeout: timeoutMs },
          (err, stdout) => {
            if (err) resolve({ outcome: 'failed', error: err });
            else resolve({ outcome: 'ok', latest: stdout.trim() });
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

    // Re-read the cache only if at least one branch needs to inherit
    // a prior value. We re-read here (not just the `previous`
    // snapshot taken at function entry) because a concurrent refresh
    // in another process may have written a successful deprecation
    // between our entry snapshot and now — without the re-read, a
    // partial-failure write here would overwrite the peer's good
    // result with null.
    const needsInherited =
      deprecationOutcome.outcome === 'failed' || latestOutcome.outcome === 'failed';
    const refreshed = needsInherited ? readStoredUpdateCheck(updateCheckPath, currentVersion) : null;
    const inheritedDeprecation = refreshed?.currentVersion === currentVersion
      ? refreshed?.currentVersionDeprecation ?? null
      : previous?.currentVersion === currentVersion
        ? previous?.currentVersionDeprecation ?? null
        : null;
    const hasInheritablePrior = inheritedDeprecation !== null;
    const resolvedDeprecation: string | null =
      deprecationOutcome.outcome === 'ok'
        ? deprecationOutcome.message
        : inheritedDeprecation;

    if (latestOutcome.outcome === 'ok') {
      // Version lookup succeeded. The deprecation sub-call's outcome
      // is surfaced via lastError (and via the version-aware
      // staleness gate in decideAutoUpdateHook), so partial failure
      // doesn't have to suppress the version-fresh signal. Hiding
      // latestVersion just because deprecation timed out would tell
      // the user "update unavailable" while in fact `memesh update`
      // could still apply the upgrade.
      //
      // When the deprecation lookup failed AND we have no prior flag
      // to inherit, the deprecation status is genuinely UNKNOWN — we
      // surface that through `lastError`. We do NOT demote
      // `checkSucceeded` to false here: the version lookup succeeded
      // and `memesh update` legitimately depends on `checkSucceeded`
      // to know which version to install.
      const partialDeprecationFailure =
        deprecationOutcome.outcome === 'failed' && !hasInheritablePrior;
      const stored: StoredUpdateCheck = {
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

    // Version lookup failed but the deprecation sub-call may still
    // have answered. Use the fresh deprecation result if we got one
    // — that's the codex round 31 fix: never throw away a real
    // maintainer-deprecation/security signal because the version
    // sub-call timed out.
    const stored: StoredUpdateCheck = {
      currentVersion,
      latestVersion: previous?.latestVersion ?? null,
      lastAttemptAt: attemptedAt,
      lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? null,
      lastError: summarizeError(latestOutcome.error),
      checkSucceeded: false,
      currentVersionDeprecation: resolvedDeprecation,
    };
    writeStoredUpdateCheck(stored, updateCheckPath, currentVersion);
    const source: UpdateCheckSource = stored.lastSuccessfulCheckAt ? 'cache' : 'fresh';
    return buildResult(currentVersion, stored, source, now);
  } catch (err) {
    // Genuinely-unexpected error (filesystem, JSON, etc.). The two
    // npm sub-calls never reject under normal conditions — if we get
    // here, both are dead and we should preserve prior cache.
    const stored: StoredUpdateCheck = {
      currentVersion,
      latestVersion: previous?.latestVersion ?? null,
      lastAttemptAt: attemptedAt,
      lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? null,
      lastError: summarizeError(err),
      checkSucceeded: false,
      currentVersionDeprecation:
        previous?.currentVersion === currentVersion
          ? previous?.currentVersionDeprecation ?? null
          : null,
    };
    writeStoredUpdateCheck(stored, updateCheckPath, currentVersion);
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
  const stored = readStoredUpdateCheck(options.updateCheckPath, currentVersion);
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

  // Codex rounds 33/34: when round 31 preserves a deprecation flag
  // even though the version lookup failed, freshness can be
  // 'unavailable'. Routing through the unavailable branch first
  // would suppress the security-relevant status line. Deprecated
  // installs deserve a status line that reflects the cache, not a
  // generic "unavailable" — the leading DEPRECATED warning is
  // already on `lines[0]`.
  if (update.currentVersionDeprecated) {
    if (update.updateAvailable && update.latestVersion) {
      lines.push(`🔄 Update available: ${update.latestVersion} (${formatFreshness(update)}; run: memesh update)`);
    } else if (
      update.latestVersion
      && update.latestVersion === update.currentVersion
      && update.freshness === 'fresh'
    ) {
      // CONFIRMED no upgrade target — registry advertised this same
      // version as latest in THIS run's successful lookup. Common
      // when maintainers deprecate the current release before
      // publishing the next one. Codex round 35: cached/stale data
      // doesn't qualify here — the registry could have published a
      // replacement since the last successful check.
      lines.push(`Update check: deprecated, no upgrade target yet (${formatFreshness(update)})`);
    } else {
      // UNKNOWN target — either latestVersion is null (round 31's
      // version-fail/deprecation-success path), or the equality
      // came from cache/stale data we can't fully trust. Direct the
      // user at `memesh update`, which resolves @latest at install
      // time and will succeed if a replacement exists.
      lines.push(`Update check: deprecated, upgrade target unknown — try \`memesh update\` (${formatFreshness(update)})`);
    }
  } else if (update.freshness === 'unavailable') {
    lines.push('Update check: unavailable');
  } else if (update.updateAvailable && update.latestVersion) {
    lines.push(`🔄 Update available: ${update.latestVersion} (${formatFreshness(update)}; run: memesh update)`);
  } else if (update.checkSucceeded && update.lastError) {
    // Partial-failure case (codex round 28): the version lookup
    // answered but the deprecation sub-call did not. We don't know
    // whether the installed version is flagged for security
    // disclosure. Refuse to print "up to date" here — that's a
    // false-green that hides a security-relevant unknown. The
    // detail line below ("Last update check partial: ...")
    // explains the partial failure.
    lines.push(`Update check: partial — deprecation status unknown (${formatFreshness(update)})`);
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

