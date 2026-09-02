import { hasVectorIndex } from './vector-index.js';
import { indexedObservationText, removeFromFts } from './fts-index.js';
export function removeVectorRow(db, entityId) {
    if (!hasVectorIndex(db))
        return;
    db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(entityId));
}
export function dropEntityFromIndexes(db, entityId, name) {
    const titleRow = db
        .prepare('SELECT title FROM entities WHERE id = ?')
        .get(entityId);
    removeFromFts(db, entityId, name, indexedObservationText(db, entityId), titleRow?.title ?? null);
    removeVectorRow(db, entityId);
}
//# sourceMappingURL=entity-index.js.map