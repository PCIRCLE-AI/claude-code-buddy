export function findConflicts(db, entityNames) {
    if (entityNames.length < 2)
        return [];
    const conflicts = [];
    const placeholders = entityNames.map(() => '?').join(',');
    const rows = db.prepare(`
    SELECT e_from.name AS from_name, e_to.name AS to_name
    FROM relations r
    JOIN entities e_from ON r.from_entity_id = e_from.id
    JOIN entities e_to ON r.to_entity_id = e_to.id
    WHERE r.relation_type = 'contradicts'
      AND e_from.name IN (${placeholders})
      AND e_to.name IN (${placeholders})
  `).all(...entityNames, ...entityNames);
    for (const row of rows) {
        conflicts.push(`"${row.from_name}" contradicts "${row.to_name}"`);
    }
    return conflicts;
}
export function trackAccess(db, entityIds) {
    if (entityIds.length === 0)
        return;
    const now = new Date().toISOString();
    const placeholders = entityIds.map(() => '?').join(',');
    try {
        db.prepare(`UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`).run(now, ...entityIds);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/readonly database|SQLITE_READONLY/i.test(message))
            throw error;
    }
}
//# sourceMappingURL=conflicts.js.map