export function hasVectorIndex(db) {
    try {
        db.prepare('SELECT 1 FROM entities_vec LIMIT 1').get();
        return true;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no such module: vec0|no such table/i.test(message))
            return false;
        throw err;
    }
}
//# sourceMappingURL=vector-index.js.map