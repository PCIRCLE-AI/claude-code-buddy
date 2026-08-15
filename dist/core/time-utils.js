export function parseSqliteUtcMs(sqliteTimestamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(sqliteTimestamp ?? '');
    if (!m)
        return null;
    const then = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (!Number.isFinite(then))
        return null;
    const d = new Date(then);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]
        || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6])
        return null;
    return then;
}
//# sourceMappingURL=time-utils.js.map