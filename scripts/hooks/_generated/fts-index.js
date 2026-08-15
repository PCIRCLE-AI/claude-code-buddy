// ============================================================================
// AUTO-GENERATED from src/storage/fts-index.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const UNSPACED_SCRIPT_RANGES = [
    [0x0e01, 0x0e5b],
    [0x0e81, 0x0edf],
    [0x1780, 0x17ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xf900, 0xfaff],
    [0x3040, 0x30ff],
    [0xac00, 0xd7af],
    [0xff66, 0xff9d],
    [0x20000, 0x3ffff],
];
export const UNSPACED_SCRIPT_CLASS = UNSPACED_SCRIPT_RANGES.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join('');
export const UNSPACED_SCRIPT_GLOB_RUN3 = `*[${UNSPACED_SCRIPT_CLASS}][${UNSPACED_SCRIPT_CLASS}][${UNSPACED_SCRIPT_CLASS}]*`;
const UNSPACED_SCRIPT = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]+`, 'gu');
export function segmentUnspacedScripts(text) {
    return text.replace(UNSPACED_SCRIPT, (run) => {
        const chars = [...run];
        if (chars.length === 1)
            return run;
        const grams = [];
        for (let i = 0; i < chars.length - 1; i++)
            grams.push(chars[i] + chars[i + 1]);
        return ` ${grams.join(' ')} `;
    });
}
export function toIndexForm(text) {
    return segmentUnspacedScripts(text.normalize('NFC'));
}
export function tokenizeQuery(text) {
    return toIndexForm(String(text ?? '')).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
}
export const SQL_NFC_FUNCTION = 'memesh_nfc';
const nfcRegistered = new WeakSet();
export function registerNfcFunction(db) {
    if (nfcRegistered.has(db))
        return;
    db.function(SQL_NFC_FUNCTION, { deterministic: true }, (value) => typeof value === 'string' ? value.normalize('NFC') : value);
    nfcRegistered.add(db);
}
export function hasSearchableTerms(text) {
    return tokenizeQuery(text).length > 0;
}
export function renderMatchExpression(terms) {
    if (terms.length === 0)
        return null;
    return terms
        .map((term) => isLoneUnspacedChar(term)
        ? `"${term.replace(/"/g, '""')}"*`
        : `"${term.replace(/"/g, '""')}"`)
        .join(' OR ');
}
const LONE_UNSPACED_CHAR = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]`, 'u');
export function isLoneUnspacedChar(term) {
    return [...term].length === 1 && LONE_UNSPACED_CHAR.test(term);
}
function foldTitleIntoObservations(title, observationsText) {
    return title ? `${title} ${observationsText}` : observationsText;
}
export function removeFromFts(db, entityId, name, prevObsText, prevTitle) {
    try {
        db.prepare("INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)").run(entityId, toIndexForm(name), toIndexForm(foldTitleIntoObservations(prevTitle, prevObsText)));
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
export function insertFtsRow(db, entityId, name, observationsText, title) {
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(entityId, toIndexForm(name), toIndexForm(foldTitleIntoObservations(title, observationsText)));
}
