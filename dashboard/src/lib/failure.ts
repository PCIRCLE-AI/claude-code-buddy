import { t } from './i18n';

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

/** The full user-facing sentence for a failure kind: what happened + what to do. */
export function failureMessage(kind: LoadFailure): string {
  return kind === 'unreachable'
    ? `${t('common.serverUnreachable')} ${t('common.serverUnreachableAction')}`
    : `${t('common.responseUnreadable')} ${t('common.responseUnreadableAction')}`;
}
