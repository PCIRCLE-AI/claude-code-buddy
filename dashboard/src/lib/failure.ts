import { t } from './i18n';
import { NetworkError } from './api';

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
 *
 * Collapsing both into one "could not load" message sends half the users
 * chasing a server that is running fine.
 */
export type LoadFailure = 'unreachable' | 'unreadable';

/**
 * Which kind a caught load error is. Only a transport-level failure — no
 * response at all — reads as `unreachable`; EVERYTHING the server answered
 * with, error statuses included, is `unreadable`: a 500 comes from a server
 * that is demonstrably running, and "go check `memesh serve`" would send the
 * user to a process that is fine. The first version of this labelled every
 * catch `unreachable`, which mislabelled the most common real failure.
 */
export function classifyLoadError(err: unknown): LoadFailure {
  return err instanceof NetworkError ? 'unreachable' : 'unreadable';
}

/** The full user-facing sentence for a failure kind: what happened + what to do. */
export function failureMessage(kind: LoadFailure): string {
  return kind === 'unreachable'
    ? `${t('common.serverUnreachable')} ${t('common.serverUnreachableAction')}`
    : `${t('common.responseUnreadable')} ${t('common.responseUnreadableAction')}`;
}
