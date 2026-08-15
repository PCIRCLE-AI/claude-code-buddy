// =============================================================================
// time-utils — parsing the timestamps SQLite itself writes
// =============================================================================

/**
 * Parse a SQLite `datetime('now')` / `CURRENT_TIMESTAMP` value as UTC
 * epoch-milliseconds, or null if it cannot be trusted.
 *
 * SQLite writes `YYYY-MM-DD HH:MM:SS` in **UTC**, which is not an ISO-8601
 * string: handing it to `new Date(...)` is implementation-defined, and the
 * engines that do accept it read it as LOCAL time — the same row measures as
 * "3 hours ago" in London and "11 hours ago" in Taipei.
 *
 * Anchored at BOTH ends: a trailing suffix means the value was not written by
 * us — and the worst suffixes are timezone offsets, which a prefix parser
 * would silently ignore while reading the prefix as UTC (measured:
 * '…10:00:00+08:00' parsed 8 hours wrong instead of returning unknown).
 *
 * Round-tripped: `Date.UTC` never rejects out-of-range components — it rolls
 * them over, so a corrupt `2026-99-99 00:00:00` silently becomes a real date
 * years away (usually in the future, where a negative age can pass a recency
 * check). Re-reading the components catches exactly the values that rolled.
 *
 * Single owner on purpose: this parse used to exist as two hand-synced copies
 * (doctor's `hoursSince`, db's `ensureHookRunsSince`) that had already begun
 * to differ cosmetically. (A third copy lives in `scripts/hooks/_shared.js`
 * behind the F5 hook boundary, which cannot import from dist/.)
 */
export function parseSqliteUtcMs(sqliteTimestamp: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(sqliteTimestamp ?? '');
  if (!m) return null;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(then)) return null;
  const d = new Date(then);
  if (
    d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]
    || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6]
  ) return null;
  return then;
}
