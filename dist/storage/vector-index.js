export function hasVectorIndex(db) {
    const row = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entities_vec'")
        .get();
    return row !== undefined;
}
//# sourceMappingURL=vector-index.js.map