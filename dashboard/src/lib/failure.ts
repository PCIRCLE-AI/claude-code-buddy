import { t } from './i18n';
import { AuthRequiredError, HttpError, NetworkError, RateLimitError } from './api';

/**
 * The two ways a data load fails, kept apart because they carry different
 * next steps for the user:
 *
 *   - `unreachable` — the request itself failed. The server is down, the
 *     port is wrong, the network dropped. Next step: check `memesh serve`.
 *   - `unreadable` — the request SUCCEEDED and the payload failed a shape
 *     guard. The server is fine; this bundle cannot read what it said —
 *     stale cached bundle or version skew. Next step: reload, then
 *     `memesh doctor`.
 *   - `ratelimited` — the server answered 429: it is fine and the bundle is
 *     fine, the client is simply asking too often. Next step: wait, then retry.
 *     Distinct because "reload / run doctor" is the wrong instruction — there is
 *     nothing to fix, only to slow down. (Only an exposed/--allow-remote server
 *     rate-limits; loopback is skipped.)
 *
 * Collapsing these into one "could not load" message sends half the users
 * chasing a server that is running fine.
 */
export type LoadFailure = 'unreachable' | 'unreadable' | 'ratelimited';

/**
 * Which kind a caught load error is. A transport-level failure — no response at
 * all — is `unreachable`; a 429 is `ratelimited`; EVERYTHING else the server
 * answered with, error statuses included, is `unreadable`: a 500 comes from a
 * server that is demonstrably running, and "go check `memesh serve`" would send
 * the user to a process that is fine. The first version of this labelled every
 * catch `unreachable`, which mislabelled the most common real failure.
 */
export function classifyLoadError(err: unknown): LoadFailure {
  if (err instanceof RateLimitError) return 'ratelimited';
  return err instanceof NetworkError ? 'unreachable' : 'unreadable';
}

/** The full user-facing sentence for a failure kind: what happened + what to do. */
export function failureMessage(kind: LoadFailure): string {
  if (kind === 'unreachable') return `${t('common.serverUnreachable')} ${t('handoff.terminal')}: ${t('common.serverUnreachableAction')}`;
  if (kind === 'ratelimited') return t('httpError.rate.limited');
  return `${t('common.responseUnreadable')} ${t('handoff.terminal')}: ${t('common.responseUnreadableAction')}`;
}

/**
 * The user-facing sentence for a failed ACTION (save, seed, accept, run…), as
 * opposed to a failed data load. Loads route through failureMessage() because
 * "reload" is a sane next step there; for an action the errors split four ways:
 *
 *   - NetworkError      → the browser's "Failed to fetch" / "NetworkError when
 *                         attempting…" prose, which names neither the process
 *                         nor the fix. Replaced with the unreachable sentence.
 *   - AuthRequiredError → api() already announced the 401 and the app is
 *                         swapping in the auth prompt; the inline text only
 *                         flashes, so name the state rather than the exception.
 *   - HttpError         → the server answered non-2xx with a body api() could
 *                         not read as an envelope. Status + "try again /
 *                         memesh doctor" is everything that is known.
 *   - other Error       → api()'s envelope path: already the httpError.<code>
 *                         translation for a KNOWN code, the server's own prose
 *                         otherwise. Both are sentences meant for humans.
 */
export function actionFailureMessage(err: unknown): string {
  if (err instanceof NetworkError) return failureMessage('unreachable');
  if (err instanceof AuthRequiredError) return t('auth.title');
  if (err instanceof HttpError) return `${t('handoff.terminal')}: ${t('common.serverError', { status: err.status })}`;
  if (err instanceof Error && err.message) return err.message;
  return t('errors.unknown');
}
