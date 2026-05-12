export function computeStats(db) {
    const entities = db.prepare('SELECT COUNT(*) as c FROM entities').get();
    const observations = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    const relations = db.prepare('SELECT COUNT(*) as c FROM relations').get();
    const tags = db.prepare('SELECT COUNT(DISTINCT tag) as c FROM tags').get();
    const typeDistribution = db.prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC LIMIT 50').all();
    const tagDistribution = db.prepare('SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC LIMIT 30').all();
    const statusDistribution = db.prepare("SELECT status, COUNT(*) as count FROM entities GROUP BY status").all();
    return {
        totalEntities: entities.c,
        totalObservations: observations.c,
        totalRelations: relations.c,
        totalTags: tags.c,
        typeDistribution,
        tagDistribution,
        statusDistribution,
    };
}
//# sourceMappingURL=stats.js.map