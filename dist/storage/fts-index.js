export function removeFromFts(db, entityId, name, prevObsText) {
    try {
        db.prepare("INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)").run(entityId, name, prevObsText);
    }
    catch (err) {
        if (isBenignFtsDeleteError(err))
            return;
        process.stderr.write(`[memesh fts-index] removeFromFts(rowid=${entityId}) failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
function isBenignFtsDeleteError(err) {
    const msg = err?.message ?? '';
    return /no such rowid|values do not match|no such row\b/i.test(msg);
}
export function insertFtsRow(db, entityId, name, observationsText) {
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(entityId, name, observationsText);
}
//# sourceMappingURL=fts-index.js.map