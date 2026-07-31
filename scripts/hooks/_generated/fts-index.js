// ============================================================================
// AUTO-GENERATED from src/storage/fts-index.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const UNSPACED_SCRIPT_CLASS = '㐀-䶿一-鿿豈-﫿぀-ヿ가-힯';
const UNSPACED_SCRIPT = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]+`, 'gu');
export function segmentUnspacedScripts(text) {
    return text.replace(UNSPACED_SCRIPT, (run) => {
        if (run.length === 1)
            return run;
        const grams = [];
        for (let i = 0; i < run.length - 1; i++)
            grams.push(run.slice(i, i + 2));
        return ` ${grams.join(' ')} `;
    });
}
export function toIndexForm(text) {
    return segmentUnspacedScripts(text.normalize('NFC'));
}
export function tokenizeQuery(text) {
    return toIndexForm(String(text ?? '')).match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
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
export function removeFromFts(db, entityId, name, prevObsText) {
    try {
        db.prepare("INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)").run(entityId, toIndexForm(name), toIndexForm(prevObsText));
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
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(entityId, toIndexForm(name), toIndexForm(observationsText));
}
